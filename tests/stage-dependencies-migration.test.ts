import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { StageReceiptEvidence } from "../src/dist/core/application/stage-journal";
import type { SaveEvidence } from "../src/dist/core/application/documents/save";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const { hash, canonical } = load(
  "./src/dist/core/application/cad/json.js",
) as typeof import("../src/dist/core/application/cad/json");
const { bindingFor } = load(
  "./src/dist/core/application/documents/save.js",
) as typeof import("../src/dist/core/application/documents/save");
const { validateBatchReport } = load(
  "./src/dist/core/application/cad/batch-summary.js",
) as typeof import("../src/dist/core/application/cad/batch-summary");
const { stageReceiptReference } = load(
  "./src/dist/node-adapters/persistence/stage-journal.js",
) as typeof import("../src/dist/node-adapters/persistence/stage-journal");
const fixtureName = "stage-dependencies-9386.js.txt";
const manifest = load("./tests/fixtures/history/manifest.json") as Array<{
  file: string;
  sha256: string;
  revision: string;
  sourcePath: string;
}>;
const reference = manifest.find((item) => item.file === fixtureName)!;
assert.equal(reference.revision, "938643314c76fd6503fd4e44720eca13edc7bfd0");
assert.equal(reference.sourcePath, "src/composition/stage-dependencies.js");
const historical = fs.readFileSync(
  path.join(root, "tests/fixtures/history", fixtureName),
  "utf8",
);
assert.equal(
  createHash("sha256").update(historical).digest("hex"),
  reference.sha256,
);
const introducedReference = manifest.find(
  (item) => item.file === "stage-dependencies-42fe.js.txt",
)!;
const introduced = fs.readFileSync(
  path.join(root, "tests/fixtures/history", introducedReference.file),
  "utf8",
);
assert.equal(digestSource(introduced), introducedReference.sha256);
function digestSource(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}
const sources = {
  introduced: {
    source: introduced,
    filename: path.join(root, reference.sourcePath),
  },
  historical: {
    source: historical,
    filename: path.join(root, reference.sourcePath),
  },
  typed: {
    source: fs.readFileSync(
      path.join(root, "src/dist/composition/stage-dependencies.js"),
      "utf8",
    ),
    filename: path.join(root, "src/dist/composition/stage-dependencies.js"),
  },
};
const reportRoot = path.join(root, "owned-stage-fixture");
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const receiptReference = (operation: string, requestHash: string) =>
  stageReceiptReference(Buffer.from(canonical({ operation, requestHash })));

interface Reader {
  documentSaveReceipt(input: unknown): StageReceiptEvidence;
  batchReceipt(input: unknown): StageReceiptEvidence;
  helperReceipt(input: unknown): StageReceiptEvidence;
  resolvePinnedDocument(input: unknown): Record<string, unknown>;
  requiresPhysicalStageOwner(payload: unknown): boolean;
  createAuthenticatedStageDependencies(input?: unknown): Promise<unknown>;
  createBatchStages(owner: unknown): {
    beforeRun(input: unknown): Promise<void>;
  };
  createHelperStages(
    owner: unknown,
    hash: string,
  ): { plan(): Promise<void>; started(): Promise<void>; context(): unknown };
}
interface Storage {
  directory?: string;
  records?: unknown[];
  batch?: unknown;
  names?: string[];
  noncanonical?: boolean;
  missing?: boolean;
}

// The actual readers run against immutable lifecycle inputs and supplied reads.
// OS descriptor checks and authenticated broker snapshots remain integration tests.
function reader(version: keyof typeof sources, storage: Storage = {}): Reader {
  const { source, filename } = sources[version];
  const original = createRequire(filename);
  const read = (name: string): unknown => {
    if (name === "node:module") return { createRequire: () => read };
    if (name === "node:fs")
      return {
        realpathSync(directory: string) {
          assert.equal(
            directory,
            storage.directory,
            "unexpected filesystem access",
          );
          if (storage.missing)
            throw Object.assign(Error("missing original receipt"), {
              code: "ENOENT",
            });
          return storage.noncanonical ? directory + "-other" : directory;
        },
        readdirSync(directory: string) {
          assert.equal(directory, storage.directory);
          return (
            storage.names ??
            storage.records?.map(
              (_, i) => String(i).padStart(8, "0") + ".json",
            ) ??
            []
          );
        },
      };
    if (/\/persistence\/records(?:\.js)?$/.test(name))
      return {
        readBytes(file: string) {
          assert.equal(path.dirname(file), storage.directory);
          const record =
            storage.records?.[Number(path.basename(file, ".json"))];
          assert.notEqual(record, undefined, "unexpected receipt read");
          return Buffer.from(JSON.stringify(record));
        },
      };
    if (/^(\.\.\/batch|\.\/batch\.js)$/.test(name))
      return {
        readBatchReportSync(directory: string) {
          assert.equal(directory, reportRoot);
          const report = validateBatchReport(
            storage.batch,
            1,
            "Invalid batch report",
          );
          return { report, bytes: Buffer.from(JSON.stringify(report)) };
        },
      };
    return original(name) as unknown;
  };
  const module: { exports: unknown } = { exports: {} };
  const evaluate = vm.runInThisContext(
    "(function(require,module,exports,__filename){\n" +
      source +
      "\nmodule.exports={...module.exports,documentSaveReceipt,batchReceipt,helperReceipt,resolvePinnedDocument,createBatchStages,createHelperStages};\n})",
    { filename },
  ) as (
    loader: typeof read,
    module: { exports: unknown },
    exports: unknown,
    filename: string,
  ) => void;
  evaluate(read, module, module.exports, filename);
  return module.exports as Reader;
}

function lifecycle(payload: unknown) {
  return {
    job: { request: { cwd: root, payload }, hash: "accepted-job-A" },
    accepted: [
      {
        reference: {
          kind: "payload",
          originalPath: null as string | null,
          sha256: digest(JSON.stringify(payload)),
        },
        bytes: Buffer.from(JSON.stringify(payload)),
      },
    ],
    rpcReceipts: [
      {
        binding: { sourceHash: "a".repeat(64) },
        sha256: "b".repeat(64),
        nativeSha256: "c".repeat(64),
      },
    ],
    postflightEvidenceSha256: "d".repeat(64),
    stdout: "",
    stdoutSha256: digest(""),
  };
}

function saveFixture() {
  const data = {
    requestId: "save-A",
    operationId: "operation-A",
    projectId: "project-A",
    fileId: "file-A",
    creationId: "creation-A",
    expectedVersion: 3,
    reportPath: reportRoot,
    confirm: true,
  };
  const binding = bindingFor(data);
  const payload = {
    version: 1,
    kind: "cad",
    operation: "document.save.once",
    data,
  };
  const input = {
    scope: { project: root, document: canonical(binding.target) },
    stage: { id: "document.save.once", requestHash: binding.requestHash },
    reference: stageReceiptReference(Buffer.from(canonical(binding))),
    lifecycle: lifecycle(payload),
  };
  const evidence: SaveEvidence[] = [
    { status: "submit_uncertain", accepted: false, changed: null },
    { status: "accepted", accepted: true, changed: true },
    {
      status: "complete",
      accepted: true,
      changed: true,
      baselineVersion: 3,
      resultingVersion: 4,
      cloudComplete: true,
    },
  ];
  const records = evidence.map((result, sequence) => ({
    sequence,
    operation: "document.save.once",
    binding,
    state: result.status,
    result,
  }));
  const storage: Storage = {
    directory: path.join(
      reportRoot,
      "document-save",
      hash([data.requestId, data.operationId]),
    ),
    records,
  };
  return { input, records, storage };
}
type SaveFixture = ReturnType<typeof saveFixture>;
const saveCases: Array<
  [string, (fixture: SaveFixture) => void, StageReceiptEvidence["status"]]
> = [
  ["complete saved version", () => {}, "completed"],
  [
    "no numbered receipt",
    (f) => {
      f.storage.records = [];
    },
    "missing",
  ],
  [
    "missing receipt directory",
    (f) => {
      f.storage.missing = true;
    },
    "missing",
  ],
  [
    "foreign document scope",
    (f) => {
      f.input.scope.document = canonical({ creationId: "B", fileId: "file-B" });
    },
    "corrupt",
  ],
  [
    "foreign stage reference",
    (f) => {
      f.input.reference = "foreign";
    },
    "corrupt",
  ],
  [
    "changed request hash",
    (f) => {
      f.input.stage.requestHash = "foreign";
    },
    "corrupt",
  ],
  [
    "foreign history binding",
    (f) => {
      f.records[1]!.binding = { ...f.records[1]!.binding, requestId: "save-B" };
    },
    "corrupt",
  ],
  [
    "wrong recorded sequence",
    (f) => {
      f.records[1]!.sequence = 9;
    },
    "corrupt",
  ],
  [
    "contradictory receipt state",
    (f) => {
      f.records[2]!.state = "pending";
    },
    "corrupt",
  ],
  [
    "unadvanced version",
    (f) => {
      f.records[2]!.result.resultingVersion = 3;
    },
    "unknown",
  ],
  [
    "changed baseline version",
    (f) => {
      f.records[2]!.result.baselineVersion = 2;
    },
    "unknown",
  ],
  [
    "cloud completion pending",
    (f) => {
      f.records[2]!.result.cloudComplete = false;
    },
    "unknown",
  ],
  [
    "no physical receipt",
    (f) => {
      f.input.lifecycle.rpcReceipts = [];
    },
    "unknown",
  ],
];
for (const [label, change, expected] of saveCases)
  test(`saved stage preserves ${label}`, () => {
    const f = saveFixture();
    change(f);
    const before = JSON.stringify(f);
    const old = reader("historical", f.storage).documentSaveReceipt(f.input);
    const current = reader("typed", f.storage).documentSaveReceipt(f.input);
    assert.deepEqual(current, old);
    assert.equal(current.status, expected);
    assert.equal(
      JSON.stringify(f),
      before,
      "inspection must not rewrite owner evidence",
    );
    if (expected === "completed") {
      assert.equal(current.sha256, digest(JSON.stringify(f.records[2])));
      // The terminal record itself includes accepted=true and the advanced version.
      assert.equal(
        current.nativeTerminalSha256,
        digest(JSON.stringify(f.records[2])),
      );
    }
  });
for (const [label, change, pattern] of [
  [
    "noncanonical directory",
    (f: SaveFixture) => {
      f.storage.noncanonical = true;
    },
    /not canonical/,
  ],
  [
    "sequence gap",
    (f: SaveFixture) => {
      f.storage.names = ["00000001.json"];
    },
    /sequence gap/,
  ],
  [
    "missing accepted payload",
    (f: SaveFixture) => {
      f.input.lifecycle.accepted = [];
    },
    /no retained typed payload/,
  ],
  [
    "different accepted bytes",
    (f: SaveFixture) => {
      f.input.lifecycle.accepted[0]!.bytes = Buffer.from("{}");
    },
    /differs/,
  ],
] as const)
  test(`saved stage refuses ${label}`, () => {
    const f = saveFixture();
    change(f);
    for (const version of ["historical", "typed"] as const)
      assert.throws(
        () => reader(version, f.storage).documentSaveReceipt(f.input),
        pattern,
      );
  });

function helperFixture(
  result: unknown = {
    success: true,
    helperCallsOnly: [{ status: "completed", effects: "observed" }],
  },
) {
  const payload = {
    version: 1,
    kind: "run",
    request: {
      name: "owned.py",
      helperVersion: "cad-v1",
      doc: "Owned",
      identity: { docId: "creation-A", docFileId: "file-A" },
    },
  };
  const life = lifecycle(payload);
  const sourceHash = digest("original source");
  life.accepted.push({
    reference: {
      kind: "source",
      originalPath: path.join(root, "owned.py") as string | null,
      sha256: sourceHash,
    },
    bytes: Buffer.from("original source"),
  });
  life.stdout = "progress\nFMCAD_RESULT " + JSON.stringify(result) + "\n";
  life.stdoutSha256 = digest(life.stdout);
  const requestHash = hash({
    jobHash: life.job.hash,
    sourceHash,
    helperVersion: "cad-v1",
    docId: "creation-A",
    docFileId: "file-A",
  });
  return {
    scope: {
      project: root,
      document: canonical({ creationId: "creation-A", fileId: "file-A" }),
    },
    stage: { id: "python.helpers.run", requestHash },
    reference: receiptReference("python.helpers.run", requestHash),
    lifecycle: life,
  };
}
type HelperFixture = ReturnType<typeof helperFixture>;
for (const [label, result, expected] of [
  [
    "observed helper calls",
    {
      success: true,
      helperCallsOnly: [{ status: "completed", effects: "observed" }],
    },
    "completed",
  ],
  [
    "empty successful helper program",
    { success: true, helperCallsOnly: [] },
    "completed",
  ],
  ["unsuccessful program", { success: false, helperCallsOnly: [] }, "unknown"],
  [
    "reported error",
    { success: true, helperCallsOnly: [], error: "failed" },
    "unknown",
  ],
  [
    "pending helper call",
    {
      success: true,
      helperCallsOnly: [{ status: "pending", effects: "observed" }],
    },
    "unknown",
  ],
  [
    "unobserved effect",
    {
      success: true,
      helperCallsOnly: [{ status: "completed", effects: "unknown" }],
    },
    "unknown",
  ],
] as const)
  test(`helper stage preserves ${label}`, () => {
    const input = helperFixture(result),
      before = JSON.stringify(input);
    const old = reader("historical").helperReceipt(input),
      current = reader("typed").helperReceipt(input);
    assert.deepEqual(current, old);
    assert.equal(current.status, expected);
    assert.equal(JSON.stringify(input), before);
    if (expected === "completed")
      assert.equal(current.sha256, input.lifecycle.stdoutSha256);
  });
const helperCases: Array<
  [string, (f: HelperFixture) => void, StageReceiptEvidence["status"]]
> = [
  [
    "missing terminal marker",
    (f) => {
      f.lifecycle.stdout = "progress";
    },
    "unknown",
  ],
  [
    "duplicate terminal marker",
    (f) => {
      f.lifecycle.stdout += f.lifecycle.stdout;
    },
    "unknown",
  ],
  [
    "malformed terminal JSON",
    (f) => {
      f.lifecycle.stdout = "FMCAD_RESULT {";
    },
    "unknown",
  ],
  [
    "foreign document",
    (f) => {
      f.scope.document = canonical({
        creationId: "creation-B",
        fileId: "file-A",
      });
    },
    "corrupt",
  ],
  [
    "foreign file",
    (f) => {
      f.scope.document = canonical({
        creationId: "creation-A",
        fileId: "file-B",
      });
    },
    "corrupt",
  ],
  [
    "foreign receipt reference",
    (f) => {
      f.reference = "foreign";
    },
    "corrupt",
  ],
  [
    "changed retained source",
    (f) => {
      f.lifecycle.accepted[1]!.reference.sha256 = digest("different source");
    },
    "corrupt",
  ],
  [
    "missing physical call",
    (f) => {
      f.lifecycle.rpcReceipts = [];
    },
    "corrupt",
  ],
  [
    "two physical script calls",
    (f) => {
      f.lifecycle.rpcReceipts.push({ ...f.lifecycle.rpcReceipts[0]! });
    },
    "corrupt",
  ],
];
for (const [label, change, expected] of helperCases)
  test(`helper stage preserves ${label}`, () => {
    const input = helperFixture();
    change(input);
    const old = reader("historical").helperReceipt(input),
      current = reader("typed").helperReceipt(input);
    assert.deepEqual(current, old);
    assert.equal(current.status, expected);
  });

function batchFixture(expectFail = false) {
  const context = {
    doc: "Owned",
    docId: "creation-A",
    docFileId: "file-A",
    preview: false,
  };
  const request = {
    runId: "batch-A",
    atomic: false,
    operations: [
      {
        id: "check-A",
        operation: "check.test",
        data: {},
        ...(expectFail ? { expectFail: true } : {}),
      },
    ],
  };
  const payload = {
    version: 1,
    kind: "cad",
    operation: "batch.run",
    data: { ...request, reportPath: reportRoot },
    ...context,
  };
  const life = lifecycle(payload);
  const requestHash = hash({ request, context });
  const stageHash = hash({
    jobRequestHash: life.job.hash,
    reportRequestHash: requestHash,
  });
  const report = {
    version: 1,
    operation: "batch.run",
    success: true,
    status: "success",
    runId: request.runId,
    request,
    context,
    requestHash,
    sequence: 0,
    steps: [
      {
        id: "check-A",
        operation: "check.test",
        status: "success",
        expectFail,
        output: {
          success: !expectFail,
          ...(expectFail ? { status: "fail" } : {}),
        } as Record<string, unknown>,
      },
    ],
  };
  const input = {
    scope: {
      project: root,
      document: canonical({ creationId: "creation-A", fileId: "file-A" }),
    },
    stage: { id: "batch.run", requestHash: stageHash },
    reference: receiptReference("batch.run", stageHash),
    lifecycle: life,
  };
  return { input, report };
}
for (const negative of [false, true])
  test(`ordinary batch preserves ${negative ? "declared expected failure" : "successful step"}`, () => {
    const f = batchFixture(negative),
      before = JSON.stringify(f);
    const old = reader("historical", { batch: f.report }).batchReceipt(f.input),
      current = reader("typed", { batch: f.report }).batchReceipt(f.input);
    assert.deepEqual(current, old);
    assert.equal(current.status, "completed");
    assert.equal(current.sha256, digest(JSON.stringify(f.report)));
    assert.equal(JSON.stringify(f), before);
  });
for (const kind of ["cad-command", "definition.instantiate"] as const)
  test(`ordinary batch preserves ${kind} ownership`, () => {
    const f = batchFixture();
    const payload = f.input.lifecycle.job.request.payload as Record<
      string,
      unknown
    >;
    const accepted =
      kind === "cad-command"
        ? { version: 1, kind, invocation: payload }
        : { ...payload, operation: kind };
    f.input.lifecycle.job.request.payload = accepted;
    f.input.lifecycle.accepted[0]!.bytes = Buffer.from(
      JSON.stringify(accepted),
    );
    const old = reader("historical", { batch: f.report }).batchReceipt(f.input);
    const current = reader("typed", { batch: f.report }).batchReceipt(f.input);
    assert.deepEqual(current, old);
    assert.equal(current.status, "completed");
  });
for (const defect of [
  "undeclared-negative",
  "blocked-negative",
  "rollback-unverified",
  "foreign-run",
] as const)
  test(`ordinary batch refuses contradictory ${defect} completion evidence`, () => {
    const f = batchFixture(defect !== "undeclared-negative");
    if (defect === "foreign-run") f.report.runId = "batch-B";
    else {
      f.report.steps[0]!.expectFail = true;
      f.report.steps[0]!.output = {
        success: false,
        status: defect === "blocked-negative" ? "blocked" : "fail",
        ...(defect === "rollback-unverified"
          ? { rollbackVerified: false }
          : {}),
      };
    }
    const before = JSON.stringify(f);
    for (const version of ["introduced", "historical"] as const)
      assert.equal(
        reader(version, { batch: f.report }).batchReceipt(f.input).status,
        "completed",
        `reproduce ${version} defect`,
      );
    assert.equal(
      reader("typed", { batch: f.report }).batchReceipt(f.input).status,
      defect === "foreign-run" ? "corrupt" : "unknown",
    );
    assert.equal(
      JSON.stringify(f),
      before,
      "refusal must preserve evidence and cannot replay the mutation",
    );
  });

function pinFixture(selectors = true) {
  const payload = {
    kind: "cad",
    operation: "batch.run",
    doc: "Owned",
    ...(selectors ? { docId: "creation-A", docFileId: "file-A" } : {}),
  };
  const life = lifecycle(payload);
  return {
    job: life.job,
    accepted: life.accepted,
    preflight: {
      instance: {
        documents: [
          { id: "creation-A", fileId: "file-A", name: "Owned", isSaved: true },
          { id: "creation-B", fileId: "file-B", name: "Owned", isSaved: true },
        ],
        documentState: {
          status: "complete",
          state: {
            identity: {
              creationId: "creation-A",
              fileId: "file-A",
              name: "Owned",
              version: 3,
            },
          },
        },
      },
    },
  };
}
test("preflight pins the exact owner among duplicate document names", () => {
  const input = pinFixture(),
    expected = {
      creationId: "creation-A",
      fileId: "file-A",
      selectorName: "Owned",
      version: 3,
    };
  for (const version of ["historical", "typed"] as const)
    assert.deepEqual(reader(version).resolvePinnedDocument(input), expected);
});
for (const label of [
  "ambiguous-name",
  "foreign-document",
  "changed-file",
  "wrong-name",
] as const)
  test(`preflight refuses ${label} routing`, () => {
    const input = pinFixture(label !== "ambiguous-name");
    if (label === "foreign-document")
      input.preflight.instance.documents.shift();
    if (label === "changed-file")
      input.preflight.instance.documents[0]!.fileId = "file-B";
    if (label === "wrong-name")
      input.preflight.instance.documents[0]!.name = "Foreign";
    for (const version of ["historical", "typed"] as const)
      assert.throws(
        () => reader(version).resolvePinnedDocument(input),
        /does not identify exactly one/,
      );
  });
test("a foreign active snapshot cannot contribute the owned document version", () => {
  const input = pinFixture();
  input.preflight.instance.documentState.state.identity.creationId =
    "creation-B";
  const expected = {
    creationId: "creation-A",
    fileId: "file-A",
    selectorName: "Owned",
  };
  for (const version of ["historical", "typed"] as const)
    assert.deepEqual(reader(version).resolvePinnedDocument(input), expected);
});
for (const [helper, saved, permitted] of [
  [true, false, true],
  [false, false, false],
  [true, true, false],
] as const)
  test(`unsaved pin requires cad-v1 and explicit unsaved evidence (${helper}/${saved})`, () => {
    const payload = {
      kind: "run",
      request: {
        doc: "Owned",
        identity: { docId: "creation-A" },
        ...(helper ? { helperVersion: "cad-v1" } : {}),
      },
    };
    const life = lifecycle(payload);
    const input = {
      job: life.job,
      accepted: life.accepted,
      preflight: {
        instance: {
          documents: [
            { id: "creation-A", fileId: null, name: "Owned", isSaved: saved },
          ],
        },
      },
    };
    for (const version of ["historical", "typed"] as const) {
      if (permitted)
        assert.deepEqual(reader(version).resolvePinnedDocument(input), {
          creationId: "creation-A",
          fileId: null,
          selectorName: "Owned",
        });
      else
        assert.throws(
          () => reader(version).resolvePinnedDocument(input),
          /does not identify exactly one/,
        );
    }
  });
test("save stage keeps the accepted file/version target", () => {
  const f = saveFixture();
  const input = {
    job: f.input.lifecycle.job,
    accepted: f.input.lifecycle.accepted,
    preflight: {},
  };
  for (const version of ["historical", "typed"] as const)
    assert.deepEqual(reader(version).resolvePinnedDocument(input), {
      creationId: "creation-A",
      fileId: "file-A",
      projectId: "project-A",
      version: 3,
    });
});

for (const [label, payload, expected] of [
  ["absent", undefined, false],
  ["null", null, false],
  ["empty", {}, false],
  ["legacy", { kind: "legacy-command" }, false],
  ["ordinary CAD", { kind: "cad", operation: "entity.list" }, false],
  ["save", { kind: "cad", operation: "document.save.once" }, true],
  ["observe", { kind: "cad", operation: "document.save.observe" }, false],
  ["batch", { kind: "cad", operation: "batch.run" }, true],
  [
    "definition",
    {
      kind: "cad-command",
      invocation: { operation: "definition.instantiate" },
    },
    true,
  ],
  ["helper", { kind: "run", request: { helperVersion: "cad-v1" } }, true],
  ["plain run", { kind: "run", request: {} }, false],
] as const)
  test(`physical ownership policy preserves ${label}`, () => {
    for (const version of ["historical", "typed"] as const)
      assert.equal(
        reader(version).requiresPhysicalStageOwner(payload),
        expected,
      );
  });

function ownerFor(input: ReturnType<typeof batchFixture>["input"]) {
  const events: unknown[] = [];
  return {
    events,
    owner: {
      job: input.lifecycle.job,
      accepted: input.lifecycle.accepted,
      stages: {
        plan: (value: unknown) => events.push(["plan", value]),
        started: (id: string, reference: string) =>
          events.push(["started", id, reference]),
      },
      inspect: () => ({ status: "unknown", replayAllowed: false }),
      resumePlan: () => ({ nextStage: null }),
    },
  };
}
for (const atomic of [false, true])
  test(`batch stage writes owner-bound intent before execution (atomic=${atomic})`, async () => {
    const f = batchFixture();
    const expectedId = atomic ? "batch.atomic" : "batch.run";
    const expectedHash = f.input.stage.requestHash;
    const expected = [
      ["plan", [{ id: expectedId, requestHash: expectedHash, mutates: true }]],
      ["started", expectedId, receiptReference(expectedId, expectedHash)],
    ];
    for (const version of ["historical", "typed"] as const) {
      const { owner, events } = ownerFor(f.input);
      const stages = reader(version).createBatchStages(owner);
      await assert.rejects(
        stages.beforeRun({ requestHash: "foreign", atomic }),
        /differs from retained owner input/,
      );
      assert.deepEqual(
        events,
        [],
        "a foreign batch must not persist an execution intent",
      );
      await stages.beforeRun({ requestHash: f.report.requestHash, atomic });
      assert.deepEqual(events, expected);
    }
  });
test("helper stage requires a plan and preserves owner-bound stage context", async () => {
  const f = batchFixture();
  for (const version of ["historical", "typed"] as const) {
    const { owner, events } = ownerFor(f.input);
    const stages = reader(version).createHelperStages(
      owner,
      "accepted-source-hash",
    );
    await assert.rejects(stages.started(), /requires its durable plan/);
    assert.deepEqual(events, []);
    await stages.plan();
    await stages.started();
    assert.deepEqual(events, [
      [
        "plan",
        [
          {
            id: "python.helpers.run",
            requestHash: "accepted-source-hash",
            mutates: true,
          },
        ],
      ],
      [
        "started",
        "python.helpers.run",
        receiptReference("python.helpers.run", "accepted-source-hash"),
      ],
    ]);
    assert.deepEqual(stages.context(), {
      stage: {
        id: "python.helpers.run",
        requestBaseHash: "accepted-source-hash",
      },
      inspection: { status: "unknown", replayAllowed: false },
      resumePlan: { nextStage: null },
    });
  }
});

test("packaged stage facade resolves without test compiler overwrites", async () => {
  const staged = load("./dist/src/composition/stage-dependencies.js") as Reader;
  assert.equal(
    staged.requiresPhysicalStageOwner({
      kind: "run",
      request: { helperVersion: "cad-v1" },
    }),
    true,
  );
  assert.equal(
    staged.requiresPhysicalStageOwner({
      kind: "cad",
      operation: "entity.list",
    }),
    false,
  );
  assert.equal(await staged.createAuthenticatedStageDependencies(), null);
});
