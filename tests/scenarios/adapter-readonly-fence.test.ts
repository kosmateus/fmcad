import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import {
  adapterReadonlyFence,
  assertAdapterActive,
  assertAdapterBridge,
} from "./adapter-readonly-fence";
import type { OwnedUnsavedFixtureProof } from "./fixture-provenance";

test("adapter SDK fence passes production Python admission", async () => {
  const root = path.resolve(__dirname, "../../..");
  const load = createRequire(path.join(root, "package.json"));
  const { createPythonChecker } = load(
    "./packages/node-adapters/dist/python/checker",
  ) as typeof import("../../packages/node-adapters/src/python/checker");
  const { preparePythonArtifact } = load(
    "./packages/node-adapters/dist/python/artifact",
  ) as typeof import("../../packages/node-adapters/src/python/artifact");
  const typingRoot = path.join(root, "dist/runtime/python/typing");
  const checker = createPythonChecker({
    typingRoot,
    definitionsRoot: typingRoot,
    pythonPlatform: "Windows",
  });
  const artifact = preparePythonArtifact([
    {
      id: "adapter",
      filename: "adapter.py",
      role: "user",
      source:
        adapterReadonlyFence('def run(_context: str):\n    print("MARKER")\n') +
        '\nrun("")\n',
    },
  ]);
  const report = await checker.check({ artifact, context: { kind: "run" } });
  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.deepEqual(report.diagnostics, []);
});

test("bridge admits only receipt-bound peer additions and closures", () => {
  const baseline = {
    creationId: "baseline",
    name: "baseline",
    isSaved: false,
    isModified: false,
  };
  const peer = {
    creationId: "peer",
    name: "peer",
    isSaved: false,
    isModified: true,
  };
  const open = new Map<string, OwnedUnsavedFixtureProof>([
    ["peer", { document: { creationId: "peer", name: "peer" }, state: "open" }],
  ]);
  assertAdapterBridge([baseline], [baseline, peer], open);
  assert.throws(
    () => assertAdapterBridge([baseline], [baseline, peer], new Map()),
    /provenance/u,
  );
  assert.throws(
    () => assertAdapterBridge([baseline], [baseline, peer, peer], open),
    /Duplicate/u,
  );
  assert.throws(
    () => assertAdapterBridge([baseline, peer], [baseline], open),
    /close receipt/u,
  );
  const closed = new Map<string, OwnedUnsavedFixtureProof>([
    [
      "peer",
      { document: { creationId: "peer", name: "peer" }, state: "closed" },
    ],
  ]);
  assertAdapterBridge([baseline, peer], [baseline], closed);
  assert.throws(
    () => assertAdapterBridge([baseline], [], closed),
    /close receipt/u,
  );
  assert.throws(
    () =>
      assertAdapterBridge(
        [baseline],
        [{ ...baseline, isModified: true }],
        open,
      ),
    /Unowned document changed/u,
  );
  assert.throws(
    () =>
      assertAdapterBridge(
        [baseline],
        [baseline, { ...peer, name: "foreign" }],
        open,
      ),
    /renamed/u,
  );
  assert.throws(
    () =>
      assertAdapterBridge(
        [baseline],
        [baseline, { ...peer, isSaved: true }],
        open,
      ),
    /save state/u,
  );
  assertAdapterActive("baseline", "peer", open);
  assertAdapterActive("peer", "baseline", closed);
  assert.throws(
    () => assertAdapterActive("baseline", "unrelated", open),
    /Active document changed/u,
  );
});

const fakeFusion = `
import sys, types
doc = types.SimpleNamespace(creationId="owned", name="fixture",
    isSaved=False, isModified=False, dataFile=None)
app = types.SimpleNamespace(documents=[doc], activeDocument=doc)
adsk = types.ModuleType("adsk")
core = types.ModuleType("adsk.core")
core.Application = types.SimpleNamespace(get=lambda: app)
adsk.core = core
sys.modules["adsk"] = adsk
sys.modules["adsk.core"] = core
`;

for (const [name, action] of [
  ["modification", "doc.isModified = True"],
  ["rename", 'doc.name = "foreign"'],
  ["closure", "app.documents.clear()"],
  ["activation", "app.activeDocument = None"],
  ["save", "doc.isSaved = True"],
  ["file identity", 'doc.dataFile = types.SimpleNamespace(id="new-file")'],
] as const) {
  test(`adapter SDK fence rejects its own ${name}`, () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        fakeFusion +
          adapterReadonlyFence(`def run(_context: str):\n    ${action}\n`) +
          '\nrun("")\n',
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /Adapter changed documents during its SDK turn/u,
    );
  });
}

test("adapter SDK fence permits peer changes between turns and preserves output", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      fakeFusion +
        adapterReadonlyFence('def run(_context: str):\n    print("MARKER")\n') +
        '\nrun("")\ndoc.isModified = True\nrun("")\n',
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "MARKER\nMARKER\n");
});

test("adapter SDK fence preserves the expected Python exception", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      fakeFusion +
        adapterReadonlyFence(
          'def run(_context: str):\n    raise ValueError("EXPECTED")\n',
        ) +
        '\nrun("")\n',
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ValueError: EXPECTED/u);
  assert.doesNotMatch(result.stderr, /Adapter changed documents/u);
});
