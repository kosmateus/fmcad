import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pythonLiteral } from "../packages/node-adapters/src/python/artifact";
import { createPythonChecker } from "../packages/node-adapters/src/python/checker";
import { prepareWireArtifact } from "../packages/node-adapters/src/python/source-units";
import {
  prepareReadonlyMetadataContext,
  readonlyMetadataContextResource,
} from "../packages/node-adapters/src/python/readonly-metadata-context";
import type {
  ReadonlyMetadataContextManifestV1,
  ReadonlyMetadataContextSnapshotV1,
} from "../packages/node-adapters/src/python/readonly-metadata-context";
import { adapterReadonlyFence } from "./scenarios/adapter-readonly-fence";

const hash = (source: string) =>
  createHash("sha256").update(source).digest("hex");

const metadataSnapshot = (
  sourceSha256: string,
): ReadonlyMetadataContextSnapshotV1 => ({
  schema: "readonly-metadata-snapshot-v1",
  binding: {
    requestId: "request-1",
    requestSha256: "a".repeat(64),
    sourceSha256,
    nativeSessionId: "native-session-1",
    hostGeneration: "generation-1",
    resourceHash: "b".repeat(64),
    wireHash: "c".repeat(64),
  },
  documents: [
    {
      creationId: "z-unsaved",
      name: "Unsaved",
      isSaved: false,
      isModified: true,
      dataFile: null,
    },
    {
      creationId: "a-saved",
      name: "Saved",
      isSaved: true,
      isModified: false,
      dataFile: { id: "file-a" },
    },
  ],
  activeDocument: {
    creationId: "a-saved",
    name: "Saved",
    isSaved: true,
    isModified: false,
    dataFile: { id: "file-a" },
  },
});

const harness = String.raw`
import builtins, inspect, json, sys
request = json.loads(sys.stdin.read())
resource_globals = {"__builtins__": builtins.__dict__}
exec(compile(request["resource"], "<readonly-metadata-resource>", "exec"),
     resource_globals, resource_globals)
factory = resource_globals["_fmcad_readonly_metadata_environment"]

def invoke(snapshot, source, source_hash, context=""):
    try:
        namespace, stdout, stderr = factory(snapshot, source_hash)
    except BaseException as error:
        return {"stdout": "", "stderr": "", "value": None,
                "error": type(error).__name__}
    try:
        exec(compile(source, "<readonly-metadata-user>", "exec"), namespace, namespace)
        value = namespace["run"](context) if "run" in namespace else None
        return {"stdout": stdout.getvalue(), "stderr": stderr.getvalue(),
                "value": value, "error": None,
                "namespace": namespace, "stdoutBuffer": stdout, "stderrBuffer": stderr}
    except BaseException as error:
        return {"stdout": stdout.getvalue(), "stderr": stderr.getvalue(),
                "value": None, "error": type(error).__name__,
                "namespace": namespace, "stdoutBuffer": stdout, "stderrBuffer": stderr}

def direct_depth():
    namespace = {"__builtins__": builtins.__dict__, "inspect": inspect}
    exec(compile("def run(_context):\n return len(inspect.stack())\n",
                 "<direct-inspect>", "exec"), namespace, namespace)
    return namespace["run"]("")

before_adsk = sys.modules.get("adsk")
cases = []
for item in request.get("cases", []):
    snapshot = dict(request["snapshot"])
    snapshot["binding"] = dict(snapshot["binding"], sourceSha256=item["sourceSha256"])
    result = invoke(snapshot, item["source"], item["sourceSha256"])
    cases.append({"stdout": result["stdout"], "stderr": result["stderr"],
                  "error": result["error"]})
main_snapshot = request["snapshot"]
main_source = request["source"]
main_hash = request["sourceSha256"]
main = invoke(main_snapshot, main_source, main_hash)
baseline_depth = direct_depth()
surface = None
if main["error"] is None:
    namespace = main["namespace"]
    private_import = namespace["__builtins__"]["__import__"]
    private_adsk = private_import("adsk")
    private_core = private_import("adsk.core", fromlist=("Application",))
    private_inspect = private_import("inspect")
    private_json = private_import("json")
    private_sys = private_import("sys")
    app = private_core.Application.get()
    surface = {
        "appType": type(app).__name__,
        "documentType": type(app.documents[0]).__name__,
        "dataFileType": type(app.documents[1].dataFile).__name__,
        "activeIsInventoryDocument": app.activeDocument is app.documents[1],
        "documentKeys": [name for name in ("creationId", "name", "isSaved", "isModified", "dataFile")
                         if hasattr(app.documents[0], name)],
        "mutatorsAbsent": all(not hasattr(app.documents[0], name)
                              for name in ("save", "close", "deleteMe", "activate")),
        "privateModules": [private_adsk is not sys.modules.get("adsk"),
                           private_sys is not sys, private_inspect is not inspect,
                           private_json is not json],
        "privateModuleMembers": {
            "core": [name for name in ("Application", "Point3D", "DocumentTypes")
                     if hasattr(private_core, name)],
            "inspect": [name for name in ("stack", "getsource", "currentframe")
                        if hasattr(private_inspect, name)],
            "json": [name for name in ("dumps", "loads")
                     if hasattr(private_json, name)],
            "sys": [name for name in ("stdout", "stderr", "modules", "_getframe")
                    if hasattr(private_sys, name)],
        },
        "hostModuleUnchanged": sys.modules.get("adsk") is before_adsk,
        "standardModulesUnchanged": sys.modules.get("sys") is sys,
    }
print(json.dumps({"main": {key: value for key, value in main.items()
                           if key not in ("namespace", "stdoutBuffer", "stderrBuffer")},
                  "surface": surface, "baselineDepth": baseline_depth, "cases": cases}))
`;

function execute(
  source: string,
  snapshot: unknown = metadataSnapshot(hash(source)),
  cases: readonly { source: string; sourceSha256: string }[] = [],
) {
  const prepared = prepareReadonlyMetadataContext(source);
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  if (prepared.status !== "prepared")
    throw new Error("Readonly metadata context is unsupported");
  assert.equal(prepared.manifest.sourceSha256, hash(source));
  assert.equal(prepared.manifest.engineVersion, "python-source-effects-v2");
  assert.equal(
    prepared.manifest.snapshotSchema,
    "readonly-metadata-snapshot-v1",
  );
  assert.equal(prepared.manifest.grantsSdkAccess, false);
  assert.equal(prepared.manifest.grantsPythonExecution, false);
  assert.equal(prepared.artifact.script, readonlyMetadataContextResource);
  const runtime = prepared.artifact.units.find(
    (unit) => unit.id === "readonly-metadata-context",
  );
  const user = prepared.artifact.units.find(
    (unit) => unit.id === "readonly-metadata-user",
  );
  assert.equal(runtime?.role, "runtime");
  assert.equal(runtime?.source, readonlyMetadataContextResource);
  assert.equal(user?.role, "user");
  assert.equal(user?.source, source);
  assert.equal(user?.sha256, hash(source));
  const result = spawnSync("python3", ["-I", "-S", "-B", "-c", harness], {
    input: JSON.stringify({
      resource: prepared.artifact.script,
      source,
      sourceSha256: hash(source),
      snapshot,
      cases,
    }),
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env["PATH"] ?? "" },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    main: {
      stdout: string;
      stderr: string;
      value: unknown;
      error: string | null;
    };
    surface: {
      appType: string;
      documentType: string;
      dataFileType: string;
      activeIsInventoryDocument: boolean;
      documentKeys: string[];
      mutatorsAbsent: boolean;
      privateModules: boolean[];
      privateModuleMembers: Record<string, string[]>;
      hostModuleUnchanged: boolean;
      standardModulesUnchanged: boolean;
    } | null;
    baselineDepth: number;
    cases: { stdout: string; stderr: string; error: string | null }[];
  };
}

function readonlyContextWireSource(source: string): string {
  return `import builtins as _fmcad_builtins
from typing import Callable as _fmcad_Callable, cast as _fmcad_cast

def _fmcad_readonly_metadata_entry(snapshot: object, source_sha256: str, context: str) -> object:
    _resource_namespace: dict[str, object] = {"__builtins__": _fmcad_builtins.__dict__}
    exec(compile(${pythonLiteral(readonlyMetadataContextResource)}, "<readonly-metadata-context>", "exec"), _resource_namespace, _resource_namespace)
    _factory = _fmcad_cast(_fmcad_Callable[[object, str], tuple[dict[str, object], object, object]], _resource_namespace["_fmcad_readonly_metadata_environment"])
    _namespace, _stdout, _stderr = _factory(snapshot, source_sha256)
    exec(compile(${pythonLiteral(source)}, "<readonly-metadata-user>", "exec"), _namespace, _namespace)
    if "run" not in _namespace:
        return None
    _run = _fmcad_cast(_fmcad_Callable[[str], object], _namespace["run"])
    return _run(context)
`;
}

function prepareReadonlyContextWire(
  source: string,
  manifest: ReadonlyMetadataContextManifestV1,
) {
  const wire = prepareWireArtifact(
    resolve("runtime/python"),
    readonlyContextWireSource(source),
    { context: manifest },
  );
  assert.equal(
    wire.units.find((unit) => unit.filename === "<readonly-metadata-context>")
      ?.source,
    readonlyMetadataContextResource,
  );
  assert.equal(
    wire.units.find((unit) => unit.filename === "<readonly-metadata-user>")
      ?.source,
    source,
  );
  return wire;
}

test("readonly adapter snapshot and fence run through a private metadata context", () => {
  const retained = readFileSync(
    "tests/scenarios/native-backend-adapter-cases.ts",
    "utf8",
  );
  const source = retained
    .split("export const snapshotScript = `")[1]
    ?.split("`;")[0];
  assert.ok(source);
  const prepared = prepareReadonlyMetadataContext(source);
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  const original = execute(source);
  assert.equal(original.main.error, null);
  assert.equal(original.main.stderr, "");
  const originalOutput = JSON.parse(original.main.stdout) as Record<
    string,
    unknown
  >;
  assert.equal(originalOutput["frameDepth"], original.baselineDepth);
  assert.equal(
    original.main.stdout,
    `{"documents": [{"creationId": "a-saved", "name": "Saved", "isSaved": true, "isModified": false, "fileId": "file-a"}, {"creationId": "z-unsaved", "name": "Unsaved", "isSaved": false, "isModified": true, "fileId": null}], "activeCreationId": "a-saved", "stdoutType": "StringIO", "frameDepth": ${original.baselineDepth}}\n`,
  );
  const fencedSource = adapterReadonlyFence(source);
  const result = execute(fencedSource);
  assert.equal(result.main.error, null);
  assert.equal(result.main.stderr, "");
  assert.ok(result.surface);
  const surface = result.surface;
  assert.equal(surface.appType, "_FmcadApplication");
  assert.equal(surface.documentType, "_FmcadDocument");
  assert.equal(surface.dataFileType, "_FmcadDataFile");
  assert.equal(surface.activeIsInventoryDocument, true);
  assert.deepEqual(surface.documentKeys, [
    "creationId",
    "name",
    "isSaved",
    "isModified",
    "dataFile",
  ]);
  assert.equal(surface.mutatorsAbsent, true);
  assert.deepEqual(surface.privateModules, [true, true, true, true]);
  assert.deepEqual(surface.privateModuleMembers, {
    core: ["Application"],
    inspect: ["stack"],
    json: ["dumps"],
    sys: ["stdout", "stderr"],
  });
  assert.equal(surface.hostModuleUnchanged, true);
  assert.equal(surface.standardModulesUnchanged, true);
  const output = JSON.parse(result.main.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(output).sort(), [
    "activeCreationId",
    "documents",
    "frameDepth",
    "stdoutType",
  ]);
  assert.equal(output["activeCreationId"], "a-saved");
  assert.equal(output["stdoutType"], "StringIO");
  assert.equal(output["frameDepth"], result.baselineDepth + 1);
  assert.equal(
    result.main.stdout,
    `{"documents": [{"creationId": "a-saved", "name": "Saved", "isSaved": true, "isModified": false, "fileId": "file-a"}, {"creationId": "z-unsaved", "name": "Unsaved", "isSaved": false, "isModified": true, "fileId": null}], "activeCreationId": "a-saved", "stdoutType": "StringIO", "frameDepth": ${result.baselineDepth + 1}}\n`,
  );
  assert.deepEqual(
    { ...output, frameDepth: originalOutput["frameDepth"] },
    originalOutput,
  );
  assert.deepEqual(output["documents"], [
    {
      creationId: "a-saved",
      name: "Saved",
      isSaved: true,
      isModified: false,
      fileId: "file-a",
    },
    {
      creationId: "z-unsaved",
      name: "Unsaved",
      isSaved: false,
      isModified: true,
      fileId: null,
    },
  ]);
});

test(
  "original readonly marker corpus keeps every source and exact stdout",
  { timeout: 60_000 },
  () => {
    const retained = readFileSync(
      "tests/scenarios/native-backend-adapter-cases.ts",
      "utf8",
    );
    const snapshotSource = retained
      .split("export const snapshotScript = `")[1]
      ?.split("`;")[0];
    assert.ok(snapshotSource);
    const markers = Array.from(
      { length: 450 },
      (_, index) =>
        `def run(_context: str):\n print("ADAPTER_PROBE_${index + 1}")`,
    );
    const cases = markers
      .flatMap((source) => {
        const fenced = adapterReadonlyFence(source);
        assert.equal(
          prepareReadonlyMetadataContext(source).status,
          "prepared",
          `readonly context rejected retained marker: ${source}`,
        );
        assert.equal(
          prepareReadonlyMetadataContext(fenced).status,
          "prepared",
          `readonly fence rejected retained marker: ${source}`,
        );
        return [source, adapterReadonlyFence(source)];
      })
      .map((source) => ({ source, sourceSha256: hash(source) }));
    const result = execute(
      snapshotSource,
      metadataSnapshot(hash(snapshotSource)),
      cases,
    );
    assert.equal(result.cases.length, 900);
    for (const [index, row] of result.cases.entries()) {
      const marker = `ADAPTER_PROBE_${Math.floor(index / 2) + 1}\n`;
      assert.equal(row.stdout, marker, `marker case ${index}`);
      assert.equal(row.stderr, "");
      assert.equal(row.error, null);
    }
  },
);

test("stdout and stderr stay private and partial output survives source exceptions", () => {
  const source = [
    "import sys",
    "def run(_context: str):",
    '    print("one", end="")',
    '    sys.stdout.write(" two\\n")',
    '    print("diagnostic", file=sys.stderr)',
    '    print("partial")',
    '    raise ValueError("expected")',
  ].join("\n");
  const result = execute(source);
  assert.deepEqual(result.main, {
    stdout: "one two\npartial\n",
    stderr: "diagnostic\n",
    value: null,
    error: "ValueError",
  });
});

test("unsupported fields and SDK effects are explicit refusals", () => {
  for (const source of [
    "import adsk.core\ndef run(ctx):\n print(adsk.core.Application.get().version)",
    "import adsk.core\ndef run(ctx):\n app=adsk.core.Application.get()\n app.activeDocument.close(False)",
    "import adsk.core, sys\ndef run(ctx):\n print(sys.modules)",
    "import adsk.fusion\ndef run(ctx):\n print('not-in-this-profile')",
    "import os\ndef run(ctx):\n print(os.getcwd())",
  ]) {
    const prepared = prepareReadonlyMetadataContext(source);
    assert.equal(prepared.status, "unsupported", source);
    if (prepared.status === "unsupported") {
      assert.equal(prepared.sourceSha256, hash(source));
      assert.ok(prepared.reasons.length > 0);
    }
  }
});

test("normal checker reports zero diagnostics for the resource and exact user unit", async () => {
  const retained = readFileSync(
    "tests/scenarios/native-backend-adapter-cases.ts",
    "utf8",
  );
  const source = retained
    .split("export const snapshotScript = `")[1]
    ?.split("`;")[0];
  assert.ok(source);
  const prepared = prepareReadonlyMetadataContext(source);
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared")
    throw new Error("Readonly metadata context is unsupported");
  const checker = createPythonChecker({
    typingRoot: resolve("runtime/python/typing"),
    definitionsRoot: resolve("dist/runtime/python/typing"),
  });
  const report = await checker.check({
    artifact: prepared.artifact,
    context: { kind: "raw" },
    unitContexts: {
      "readonly-metadata-user": { kind: "raw", entrypoint: "run" },
    },
  });
  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.deepEqual(report.diagnostics, []);

  for (const exactSource of [source, adapterReadonlyFence(source)]) {
    const wirePreparation = prepareReadonlyMetadataContext(exactSource);
    assert.equal(wirePreparation.status, "prepared");
    if (wirePreparation.status !== "prepared")
      throw new Error("Readonly metadata context is unsupported");
    const wire = prepareReadonlyContextWire(
      exactSource,
      wirePreparation.manifest,
    );
    const wireReport = await checker.check({
      artifact: wire,
      context: { kind: "raw" },
      unitContexts: {
        "embedded:0": { kind: "raw" },
        "embedded:1": { kind: "raw", entrypoint: "run" },
      },
    });
    assert.equal(wireReport.status, "passed", JSON.stringify(wireReport));
    assert.deepEqual(wireReport.diagnostics, []);
    assert.equal(wireReport.provenance.wireHash, wire.sha256);
  }
});

test("resource rejects malformed, stale, and unsupported snapshot rows", () => {
  const source = 'print("MUST_NOT_RUN")';
  const valid = metadataSnapshot(hash(source));
  const malformed = [
    { ...valid, extra: true },
    { ...valid, binding: { ...valid.binding, sourceSha256: "d".repeat(64) } },
    {
      ...valid,
      documents: [
        valid.documents[0]!,
        {
          ...valid.documents[1]!,
          creationId: valid.documents[0]!.creationId,
        },
      ],
    },
    {
      ...valid,
      documents: [
        { ...valid.documents[0], dataFile: { id: "not-unsaved" } },
        valid.documents[1],
      ],
    },
  ];
  for (const snapshot of malformed) {
    const result = execute(source, snapshot);
    assert.equal(result.main.stdout, "");
    assert.equal(result.main.error, "ValueError");
  }
});
