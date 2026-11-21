import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { inventory } from "./saved-programs";

const fakeSdk = `import sys, types, json
class File:
    def __init__(self, identity, name, version, complete):
        self.id, self.name, self.versionNumber, self.isComplete = identity, name, version, complete
class Files:
    count = 2
    array_calls = 0
    def item(self, index):
        raise RuntimeError('2 : InternalValidationError : item')
    def __iter__(self):
        return iter([self.item(0)])
    def asArray(self):
        self.array_calls += 1
        assert self.array_calls == 1, 'Array snapshot must not be retried'
        return [File('persistent-a', 'Alpha', 3, True), File('persistent-b', 'Beta', 1, False)]
folder = types.SimpleNamespace(id='folder', dataFiles=Files(), dataFolders=[])
project = types.SimpleNamespace(id='project', rootFolder=folder)
folder.parentProject = project
app = types.SimpleNamespace(data=types.SimpleNamespace(dataProjects=types.SimpleNamespace(itemById=lambda identity: project if identity == 'project' else None)))
core = types.ModuleType('adsk.core')
core.Application = types.SimpleNamespace(get=lambda: app)
adsk = types.ModuleType('adsk')
adsk.core = core
sys.modules['adsk'] = adsk
sys.modules['adsk.core'] = core
`;

function execute(setup = "") {
  return spawnSync(
    "python3",
    [
      "-c",
      fakeSdk +
        setup +
        inventory({ projectId: "project", folderId: "folder" }) +
        '\nrun("")\n',
    ],
    { encoding: "utf8" },
  );
}

test("cloud snapshot uses the complete array without the failing SDK indexed iterator", () => {
  const result = execute();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout.trim().slice("FMCAD_SCENARIO ".length)),
    {
      projectId: "project",
      folderId: "folder",
      files: [
        { fileId: "persistent-a", name: "Alpha", version: 3, complete: true },
        { fileId: "persistent-b", name: "Beta", version: 1, complete: false },
      ],
    },
  );
});

for (const [name, setup, error] of [
  [
    "array API failure",
    "def broken(self):\n    raise RuntimeError('array unavailable')\nFiles.asArray = broken\n",
    /array unavailable/u,
  ],
  [
    "partial array",
    "Files.asArray = lambda self: [File('persistent-a', 'Alpha', 3, True)]\n",
    /incomplete or changed/u,
  ],
  [
    "duplicate file identity",
    "Files.asArray = lambda self: [File('same', 'Alpha', 3, True), File('same', 'Beta', 1, False)]\n",
    /Duplicate file identity/u,
  ],
  [
    "count drift during snapshot",
    "original_array = Files.asArray\ndef changed(self):\n    result = original_array(self)\n    self.count = 3\n    return result\nFiles.asArray = changed\n",
    /incomplete or changed/u,
  ],
  [
    "element metadata failure",
    "def broken_metadata(self, name):\n    if name == 'versionNumber':\n        raise RuntimeError('file metadata unavailable')\n    return object.__getattribute__(self, name)\nFile.__getattribute__ = broken_metadata\n",
    /file metadata unavailable/u,
  ],
  [
    "missing persistent ID",
    "Files.asArray = lambda self: [File('', 'Alpha', 3, True), File('persistent-b', 'Beta', 1, False)]\n",
    /missing persistent ID/u,
  ],
  [
    "file field read failure",
    "def broken(self):\n    return [types.SimpleNamespace(id='persistent-a', name='Alpha'), File('persistent-b', 'Beta', 1, False)]\nFiles.asArray = broken\n",
    /versionNumber/u,
  ],
] as const) {
  test("cloud snapshot refuses " + name + " without a partial baseline", () => {
    const result = execute(setup);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.doesNotMatch(result.stdout, /FMCAD_SCENARIO/u);
  });
}

test("empty folder produces a complete empty snapshot", () => {
  const result = execute("Files.count = 0\nFiles.asArray = lambda self: []\n");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout.trim().slice("FMCAD_SCENARIO ".length)),
    {
      projectId: "project",
      folderId: "folder",
      files: [],
    },
  );
});

test("cloud array snapshot passes pinned production Python admission", async () => {
  const root = path.resolve(__dirname, "../../.."),
    load = createRequire(path.join(root, "package.json")),
    { createPythonChecker } = load(
      "./packages/node-adapters/dist/python/checker",
    ) as typeof import("../../packages/node-adapters/src/python/checker"),
    { preparePythonArtifact } = load(
      "./packages/node-adapters/dist/python/artifact",
    ) as typeof import("../../packages/node-adapters/src/python/artifact"),
    typingRoot = path.join(root, "dist/runtime/python/typing"),
    checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      pythonPlatform: "Windows",
    }),
    artifact = preparePythonArtifact([
      {
        id: "inventory",
        filename: "inventory.py",
        role: "user",
        source:
          inventory({ projectId: "project", folderId: "folder" }) +
          '\nrun("")\n',
      },
    ]),
    result = await checker.check({ artifact, context: { kind: "run" } });
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(result.provenance.checkerVersion, "1.40.2");
  assert.equal(
    result.provenance.definitionsHash,
    "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179",
  );
});
