import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createPythonChecker } from "../packages/node-adapters/src/python/checker";
import { preparePythonArtifact } from "../packages/node-adapters/src/python/artifact";
import {
  prepareTrustedMetadataSnapshot,
  validateReadonlyMetadataSnapshot,
  type MetadataReceiptBinding,
  type MetadataInvocationBinding,
} from "../packages/node-adapters/src/python/trusted-metadata-snapshot";
import { trustedMetadataResource } from "../packages/node-adapters/src/python/trusted-metadata-resource";

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const base: MetadataInvocationBinding = {
  requestId: "owned-metadata-request",
  requestSha256: digest("original request"),
  sourceSha256: digest("original source"),
  nativeSessionId: "native-session-A",
  hostGeneration: "generation-A",
};
const prepared = prepareTrustedMetadataSnapshot(base);
// A TEST fixture for the eventual ROOT/native receipt, not live provenance.
const current: MetadataReceiptBinding = {
  ...base,
  resourceHash: prepared.resourceHash,
  wireHash: digest("final combined wire"),
};
const unsaved = {
  creationId: "unsaved-id",
  name: "żółć 日本語",
  isSaved: false,
  isModified: true,
  dataFile: null,
};
const saved = {
  creationId: "saved-id",
  name: "saved",
  isSaved: true,
  isModified: false,
  dataFile: { id: "cloud-file-id" },
};

const harness = String.raw`
import json, sys
request = json.loads(sys.stdin.read())
reads = []
class File:
    def __init__(self, data):
        self.id = data["id"]
class Document:
    def __init__(self, data):
        self.data = data
        self.identities = 0
    @property
    def creationId(self):
        reads.append("creationId")
        self.identities += 1
        if self.data.get("changedIdentity") and self.identities > 1:
            return "wrong-document"
        return self.data["creationId"]
    @property
    def name(self):
        reads.append("name")
        return self.data["name"]
    @property
    def isSaved(self):
        reads.append("isSaved")
        return self.data["isSaved"]
    @property
    def isModified(self):
        reads.append("isModified")
        return self.data["isModified"]
    @property
    def dataFile(self):
        reads.append("dataFile")
        if not self.data["isSaved"] or self.data.get("fileError"):
            raise RuntimeError("No file metadata available")
        return File(self.data["dataFile"]) if self.data["dataFile"] is not None else None
class Documents:
    def __init__(self, data):
        self.rows = [Document(row) for row in data]
    @property
    def count(self):
        reads.append("count")
        return len(self.rows)
    def item(self, index):
        reads.append("item")
        return self.rows[index]
class App:
    def __init__(self):
        self.active_reads = 0
        self.documents = Documents(request["documents"])
    @property
    def activeDocument(self):
        reads.append("activeDocument")
        self.active_reads += 1
        # A peer's later focus would differ. The resource must not re-read it.
        if self.active_reads > 1:
            return None
        row = request["active"]
        return Document(row) if row is not None else None
application = App()
environment = {"app": application, "_fmcad_metadata_host_binding": request["binding"]}
error = None
try:
    exec(compile(request["script"], "<owned-metadata-test>", "exec"), environment, environment)
except BaseException as failure:
    error = type(failure).__name__
print(json.dumps({"snapshot": environment.get("_fmcad_metadata_snapshot"),
                  "error": error, "reads": reads, "activeReads": application.active_reads}))
`;

function execute(
  options: { binding?: unknown; documents?: unknown[]; active?: unknown } = {},
) {
  const result = spawnSync("python3", ["-I", "-S", "-B", "-c", harness], {
    input: JSON.stringify({
      script: prepared.script,
      binding: options.binding ?? current,
      documents: options.documents ?? [unsaved, saved],
      active: options.active === undefined ? unsaved : options.active,
    }),
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    snapshot: unknown;
    error: string | null;
    reads: string[];
    activeReads: number;
  };
}

test("compiler resource and exact emitted artifact bind the original invocation without self-hash claims", () => {
  assert.equal(prepared.resourceHash, digest(trustedMetadataResource));
  assert.equal(prepared.programHash, digest(prepared.script));
  assert.equal(prepared.artifact.script, prepared.script);
  assert.equal(prepared.artifact.units[0]?.source, trustedMetadataResource);
  assert.equal(prepared.artifact.units[0]?.sha256, prepared.resourceHash);
  assert.equal(prepared.artifact.units.length, 2);
  assert.notEqual(current.wireHash, prepared.programHash);
  assert.deepEqual(prepareTrustedMetadataSnapshot(base), prepared);
  assert.notEqual(
    prepareTrustedMetadataSnapshot({ ...base, requestId: "other" }).programHash,
    prepared.programHash,
  );
  assert.throws(() =>
    prepareTrustedMetadataSnapshot({ ...base, sourceSha256: "not-a-digest" }),
  );
});

test("actual benign reader returns only approved plain fields and observes active focus once", () => {
  const result = execute();
  assert.equal(result.error, null);
  assert.equal(result.activeReads, 1);
  assert.equal(result.reads.filter((field) => field === "dataFile").length, 1);
  const snapshot = validateReadonlyMetadataSnapshot(
    prepared,
    current,
    result.snapshot,
  );
  assert.ok(snapshot);
  assert.deepEqual(snapshot.documents, [unsaved, saved]);
  assert.deepEqual(snapshot.activeDocument, unsaved);
  assert.deepEqual(snapshot.binding, current);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.documents[1]?.dataFile), true);
  const noDocuments = execute({ documents: [], active: null });
  assert.equal(noDocuments.error, null);
  assert.deepEqual(
    validateReadonlyMetadataSnapshot(prepared, current, noDocuments.snapshot)
      ?.documents,
    [],
  );
  // Separately observed active row need not belong to the later inventory.
  const changedFocus = execute({ documents: [saved], active: unsaved });
  assert.equal(changedFocus.error, null);
  assert.deepEqual(
    validateReadonlyMetadataSnapshot(prepared, current, changedFocus.snapshot)
      ?.activeDocument,
    unsaved,
  );
});

test("stale or wrong request/source/resource/session/generation refuses before any SDK-shaped fixture read", () => {
  for (const key of [
    "requestId",
    "requestSha256",
    "sourceSha256",
    "nativeSessionId",
    "hostGeneration",
    "resourceHash",
  ] as const) {
    const result = execute({ binding: { ...current, [key]: "wrong" } });
    assert.equal(result.error, "ValueError", key);
    assert.equal(result.snapshot, null);
    assert.deepEqual(result.reads, []);
  }
  for (const binding of [
    { ...current, wireHash: "invalid" },
    { ...current, extra: "not allowed" },
  ]) {
    const result = execute({ binding });
    assert.equal(result.error, "ValueError");
    assert.deepEqual(result.reads, []);
  }
});

test("identity or metadata failures never fabricate a successful snapshot", () => {
  for (const row of [
    { ...saved, changedIdentity: true },
    { ...saved, fileError: true },
    { ...saved, creationId: "" },
    { ...saved, isSaved: 1 },
  ]) {
    const result = execute({ documents: [row], active: null });
    assert.notEqual(result.error, null);
    assert.equal(result.snapshot, null);
  }
  assert.equal(
    execute({ documents: [saved, saved], active: null }).error,
    "ValueError",
  );
});

test("data validation denies stale evidence, changed resources/wire, malformed rows and handle-like extras", () => {
  const result = execute();
  assert.ok(
    validateReadonlyMetadataSnapshot(prepared, current, result.snapshot),
  );
  for (const key of Object.keys(current) as (keyof MetadataReceiptBinding)[]) {
    const wrong = {
      ...current,
      [key]:
        key.endsWith("Hash") || key.endsWith("Sha256")
          ? digest("wrong")
          : "wrong",
    };
    assert.equal(
      validateReadonlyMetadataSnapshot(prepared, wrong, result.snapshot),
      null,
      key,
    );
    assert.equal(
      validateReadonlyMetadataSnapshot(prepared, current, {
        schema: "readonly-metadata-snapshot-v1",
        binding: wrong,
        documents: [unsaved],
        activeDocument: null,
      }),
      null,
      `observed ${key}`,
    );
  }
  const wrongFinalWire = execute({
    binding: { ...current, wireHash: digest("different final invocation") },
  });
  assert.equal(wrongFinalWire.error, null);
  assert.equal(
    validateReadonlyMetadataSnapshot(
      prepared,
      current,
      wrongFinalWire.snapshot,
    ),
    null,
  );
  assert.equal(
    validateReadonlyMetadataSnapshot(
      { ...prepared, script: prepared.script + "# changed" },
      current,
      result.snapshot,
    ),
    null,
  );
  assert.equal(
    validateReadonlyMetadataSnapshot(
      { ...prepared, programHash: digest("wrong") },
      current,
      result.snapshot,
    ),
    null,
  );
  const shape = {
    schema: "readonly-metadata-snapshot-v1",
    binding: current,
    documents: [unsaved],
    activeDocument: null,
  };
  for (const value of [
    { ...shape, documents: [{ ...unsaved, app: {} }] },
    {
      ...shape,
      documents: [{ ...unsaved, dataFile: { id: "unexpected unsaved file" } }],
    },
    { ...shape, documents: [unsaved, unsaved] },
    { ...shape, documents: [{ ...unsaved, creationId: "" }] },
    {
      ...shape,
      activeDocument: { ...saved, dataFile: { id: "id", sdkHandle: {} } },
    },
    { ...shape, binding: { ...current, wireHash: digest("old final wire") } },
    { ...shape, sdkHandle: {} },
  ])
    assert.equal(
      validateReadonlyMetadataSnapshot(prepared, current, value),
      null,
    );
  let calls = 0;
  const getter = {
    ...shape,
    get documents() {
      calls++;
      return [unsaved];
    },
  };
  assert.equal(
    validateReadonlyMetadataSnapshot(prepared, current, getter),
    null,
  );
  assert.equal(calls, 0);
});

test("normal checker checks the exact SDK-typed compiler resource and actual wire", async () => {
  const report = await createPythonChecker({
    typingRoot: resolve("runtime/python/typing"),
    definitionsRoot: resolve("dist/runtime/python/typing"),
  }).check({ artifact: prepared.artifact, context: { kind: "raw" } });
  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.provenance.wireHash, prepared.programHash);
  assert.ok(report.provenance.definitionsHash);
  const invalid = preparePythonArtifact([
    {
      id: "typed-sdk-negative",
      filename: "<typed-sdk-negative>",
      role: "runtime",
      source: trustedMetadataResource.replace(
        "name = _fmcad_metadata_text(doc.name)",
        "name = _fmcad_metadata_text(doc.notAnApprovedSdkMember)",
      ),
    },
  ]);
  const rejected = await createPythonChecker({
    typingRoot: resolve("runtime/python/typing"),
    definitionsRoot: resolve("dist/runtime/python/typing"),
  }).check({ artifact: invalid, context: { kind: "raw" } });
  assert.equal(rejected.status, "failed");
  assert.ok(
    rejected.diagnostics.some(
      (diagnostic) => diagnostic.rule === "reportAttributeAccessIssue",
    ),
  );
});
