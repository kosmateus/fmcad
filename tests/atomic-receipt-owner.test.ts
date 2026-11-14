import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import vm from "node:vm";
import type { StageReceiptEvidence } from "../packages/core/src/application/stage-journal";

const root = path.resolve(__dirname, "../..");
const sourcePath = "src/composition/stage-dependencies.js";
const load = createRequire(path.join(root, sourcePath));
const { hash, canonical } = load(
  "../dist/core/application/cad/json",
) as typeof import("../packages/core/src/application/cad/json");
const { stageReceiptReference } = load(
  "../dist/node-adapters/persistence/stage-journal",
) as typeof import("../packages/node-adapters/src/persistence/stage-journal");
const { validateAtomicHistory } = load(
  "../dist/core/application/cad/atomic",
) as typeof import("../packages/core/src/application/cad/atomic");
const reportDirectory = path.join(root, "owned-receipts");
const historicalDirectory = path.join(root, "tests/fixtures/history");
interface HistoricalFixture {
  revision: string;
  sourcePath: string;
  file: string;
  sha256: string;
}
const manifest = JSON.parse(
  fs.readFileSync(path.join(historicalDirectory, "manifest.json"), "utf8"),
) as HistoricalFixture[];
function historical(file: string): string {
  const entry = manifest.find((item) => item.file === file);
  assert.ok(entry);
  assert.equal(entry.sourcePath, sourcePath);
  const bytes = fs.readFileSync(path.join(historicalDirectory, file));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
  return bytes.toString("utf8");
}
const sources = {
  introduced: historical("stage-dependencies-42fe.js.txt"),
  previous: historical("stage-dependencies-b50f.js.txt"),
  current: fs.readFileSync(
    path.join(root, "src/dist/composition/stage-dependencies.js"),
    "utf8",
  ),
};

function fixture(atomic: boolean | "default" = true) {
  const context = {
    doc: "Model A",
    docId: "creation-A",
    docFileId: "file-A",
    projectId: "project-A",
    preview: false,
  };
  const request = {
    runId: "run-A",
    ...(atomic === "default" ? {} : { atomic }),
    operations: [
      {
        id: "step-A",
        operation: "sketch.create",
        data: { name: "Owned", plane: "XY" },
      },
    ],
  };
  const payload = {
    version: 1,
    kind: "cad",
    operation: "batch.run",
    data: { ...request, reportPath: reportDirectory },
    ...context,
  };
  const requestHash = hash({ request: { ...request, atomic: true }, context });
  const reportHash = hash({ request, context });
  const stageHash = hash({
    jobRequestHash: "job-A",
    reportRequestHash: reportHash,
  });
  const document = {
    creationId: context.docId,
    fileId: context.docFileId,
    name: context.doc,
  };
  const report = {
    version: 2,
    operation: "batch.run",
    runId: request.runId,
    request: { ...request, atomic: true },
    context,
    requestHash,
    sequence: 0,
    commandId: "fmcad_atomic_" + "a".repeat(32),
    sessionNonce: "b".repeat(32),
    documentIdentity: {
      expected: document,
      resolved: document,
      assertionsOnly: true,
    },
    atomic: { effective: true, supported: true, backend: "addin" },
    success: true,
    status: "success",
    outcome: "committed",
    journal: { event: "finalized", nativeOutcome: "committed" },
    steps: [
      {
        id: "step-A",
        operation: "sketch.create",
        status: "success",
        output: { success: true },
      },
    ],
  };
  const input = {
    scope: { project: root, document: canonical(document) },
    stage: { id: "batch.atomic", requestHash: stageHash, mutates: true },
    reference: stageReceiptReference(
      Buffer.from(
        canonical({ operation: "batch.atomic", requestHash: stageHash }),
      ),
    ),
    lifecycle: {
      job: { request: { cwd: root, payload }, hash: "job-A" },
      accepted: [
        {
          reference: { kind: "payload" },
          bytes: Buffer.from(JSON.stringify(payload)),
        },
      ],
      rpcReceipts: [
        {
          binding: { requestHash },
          sha256: "c".repeat(64),
          nativeSha256: "d".repeat(64),
        },
      ],
      postflightEvidenceSha256: "e".repeat(64),
    },
  };
  return { input, report: structuredClone(report) };
}
type Fixture = ReturnType<typeof fixture>;

// Execute the actual receipt reader before/after the fix. Only filesystem reads
// are supplied here; authenticated lifecycle and OS descriptor guards are covered
// by stage-owner integration tests. No alternate production path is installed.
function inspect(
  source: string,
  input: Fixture["input"],
  reports: unknown[],
): StageReceiptEvidence {
  const before = JSON.stringify({ input, reports });
  const names = reports.map(
    (_, index) => String(index).padStart(8, "0") + ".json",
  );
  const buffers = new Map(
    names.map((name, index) => [
      path.join(reportDirectory, name),
      Buffer.from(JSON.stringify(reports[index])),
    ]),
  );
  const module: { exports: unknown } = { exports: {} };
  const filename =
    source === sources.current
      ? path.join(root, "src/dist/composition/stage-dependencies.js")
      : path.join(root, sourcePath);
  const sourceLoad = createRequire(filename);
  const requireSource = (name: string): unknown => {
    if (name === "node:module") return { createRequire: () => requireSource };
    if (name === "node:fs")
      return {
        existsSync: (file: string) => fs.existsSync(file),
        realpathSync(directory: string) {
          assert.equal(directory, reportDirectory);
          return directory;
        },
        readdirSync(directory: string) {
          assert.equal(directory, reportDirectory);
          return names;
        },
      };
    if (/\/persistence\/records(?:\.js)?$/.test(name))
      return {
        readBytes(file: string) {
          const bytes = buffers.get(file);
          assert.ok(bytes, "unexpected receipt path");
          return bytes;
        },
      };
    return sourceLoad(name) as unknown;
  };
  const evaluate = vm.runInThisContext(
    "(function(require, module, exports, __filename, __dirname) {\n" +
      source +
      "\nmodule.exports = { batchReceipt };\n})",
    { filename },
  ) as (
    require: typeof requireSource,
    module: { exports: unknown },
    exports: unknown,
    filename: string,
    dirname: string,
  ) => void;
  evaluate(
    requireSource,
    module,
    module.exports,
    filename,
    path.dirname(filename),
  );
  const api = module.exports as {
    batchReceipt(input: unknown): StageReceiptEvidence;
  };
  const result = api.batchReceipt(input);
  assert.equal(
    JSON.stringify({ input, reports }),
    before,
    "receipt inspection must not mutate its input",
  );
  return JSON.parse(JSON.stringify(result)) as StageReceiptEvidence;
}

for (const [name, source] of Object.entries(sources)) {
  test(`${name} reader accepts its own completed receipt`, () => {
    const { input, report } = fixture();
    const result = inspect(source, input, [report]);
    assert.equal(result.status, "completed");
    assert.equal(
      result.postflightSha256,
      input.lifecycle.postflightEvidenceSha256,
    );
    assert.equal(
      result.sha256,
      createHash("sha256").update(JSON.stringify(report)).digest("hex"),
    );
  });
}

const swaps: Array<[string, (report: Fixture["report"]) => void]> = [
  [
    "run ID",
    (report) => {
      report.runId = "run-B";
      report.request.runId = "run-B";
    },
  ],
  [
    "operation payload",
    (report) => {
      report.request.operations[0]!.data.name = "Foreign";
    },
  ],
  [
    "creation ID",
    (report) => {
      report.context.docId = "creation-B";
    },
  ],
  [
    "file ID",
    (report) => {
      report.context.docFileId = "file-B";
    },
  ],
  [
    "document name",
    (report) => {
      report.context.doc = "Model B";
    },
  ],
  [
    "project",
    (report) => {
      report.context.projectId = "project-B";
    },
  ],
  [
    "component",
    (report) => {
      Object.assign(report.context, { component: "Other" });
    },
  ],
  [
    "resolved document",
    (report) => {
      report.documentIdentity.resolved = {
        ...report.documentIdentity.resolved,
        creationId: "creation-B",
        fileId: "file-B",
      };
    },
  ],
  [
    "resolved name",
    (report) => {
      report.documentIdentity.resolved = {
        ...report.documentIdentity.resolved,
        name: "Model B",
      };
    },
  ],
  [
    "expected document",
    (report) => {
      report.documentIdentity.expected = {
        ...report.documentIdentity.expected,
        creationId: "creation-B",
      };
    },
  ],
  [
    "expected file",
    (report) => {
      report.documentIdentity.expected = {
        ...report.documentIdentity.expected,
        fileId: "file-B",
      };
    },
  ],
  [
    "expected name",
    (report) => {
      report.documentIdentity.expected = {
        ...report.documentIdentity.expected,
        name: "Model B",
      };
    },
  ],
];
for (const [name, swap] of swaps) {
  test(`reject foreign ${name}, previously accepted by both archived readers`, () => {
    const { input, report } = fixture();
    swap(report);
    report.requestHash = hash({
      request: report.request,
      context: report.context,
    });
    assert.doesNotThrow(
      () => validateAtomicHistory([report]),
      "history is internally consistent",
    );
    assert.equal(
      inspect(sources.introduced, input, [report]).status,
      "completed",
    );
    assert.equal(
      inspect(sources.previous, input, [report]).status,
      "completed",
    );
    assert.equal(inspect(sources.current, input, [report]).status, "corrupt");
  });
}

test("default atomic mode matches the runner's effective stored mode", () => {
  const { input, report } = fixture("default");
  assert.equal(
    Object.hasOwn(input.lifecycle.job.request.payload.data, "atomic"),
    false,
  );
  assert.equal(inspect(sources.current, input, [report]).status, "completed");
});

test("an explicitly non-atomic request cannot claim an atomic receipt", () => {
  const { input, report } = fixture(false);
  assert.equal(inspect(sources.current, input, [report]).status, "corrupt");
});

test("two owners cannot exchange completed journals even with the same operation data", () => {
  const a = fixture();
  const b = fixture();
  b.report.context.doc = "Model B";
  b.report.context.docId = "creation-B";
  b.report.context.docFileId = "file-B";
  b.report.documentIdentity.expected = {
    name: "Model B",
    creationId: "creation-B",
    fileId: "file-B",
  };
  b.report.documentIdentity.resolved = b.report.documentIdentity.expected;
  b.report.requestHash = hash({
    request: b.report.request,
    context: b.report.context,
  });
  const payload = b.input.lifecycle.job.request.payload;
  Object.assign(payload, b.report.context);
  b.input.lifecycle.accepted[0]!.bytes = Buffer.from(JSON.stringify(payload));
  b.input.scope.document = canonical(b.report.documentIdentity.resolved);
  b.input.stage.requestHash = hash({
    jobRequestHash: "job-A",
    reportRequestHash: b.report.requestHash,
  });
  b.input.reference = stageReceiptReference(
    Buffer.from(
      canonical({
        operation: "batch.atomic",
        requestHash: b.input.stage.requestHash,
      }),
    ),
  );
  for (const [owner, foreign] of [
    [a, b],
    [b, a],
  ]) {
    assert.ok(owner && foreign);
    assert.equal(
      inspect(sources.current, owner.input, [owner.report]).status,
      "completed",
    );
    assert.equal(
      inspect(sources.previous, owner.input, [foreign.report]).status,
      "completed",
    );
    assert.equal(
      inspect(sources.current, owner.input, [foreign.report]).status,
      "corrupt",
    );
  }
});

for (const status of ["running", "failed", "unknown"]) {
  test(`own ${status} receipt remains unknown`, () => {
    const { input, report } = fixture();
    report.status = status;
    report.outcome = "unknown";
    for (const source of Object.values(sources))
      assert.equal(inspect(source, input, [report]).status, "unknown");
  });
}

test("missing native receipt cannot certify completion", () => {
  const { input, report } = fixture();
  input.lifecycle.rpcReceipts = [];
  assert.equal(inspect(sources.current, input, [report]).status, "unknown");
});
test("retained payload mismatch is still rejected before reading a receipt", () => {
  const { input, report } = fixture();
  input.lifecycle.accepted[0]!.bytes = Buffer.from("{}");
  assert.throws(
    () => inspect(sources.current, input, [report]),
    /Retained typed payload differs/,
  );
});
test("inconsistent journal sequence is still corrupt", () => {
  const { input, report } = fixture();
  report.sequence = 1;
  assert.equal(inspect(sources.current, input, [report]).status, "corrupt");
});

test("a committed report without a resolved document cannot certify completion", () => {
  const { input, report } = fixture();
  Object.assign(report.documentIdentity, { resolved: null });
  assert.equal(inspect(sources.previous, input, [report]).status, "completed");
  assert.equal(inspect(sources.current, input, [report]).status, "corrupt");
});

test("unknown submission without a resolved document remains unknown", () => {
  const { input, report } = fixture();
  Object.assign(report.documentIdentity, { resolved: null });
  report.status = "unknown";
  report.outcome = "unknown";
  assert.equal(inspect(sources.current, input, [report]).status, "unknown");
});

test("a correct terminal record cannot hide an earlier foreign document", () => {
  const { input, report } = fixture();
  const first = structuredClone(report);
  first.status = "running";
  first.outcome = "pending";
  first.documentIdentity.resolved = {
    ...first.documentIdentity.resolved,
    creationId: "creation-B",
  };
  report.sequence = 1;
  assert.equal(
    inspect(sources.current, input, [first, report]).status,
    "corrupt",
  );
});

test("an unrelated stage reference still cannot read a completed receipt", () => {
  const { input, report } = fixture();
  input.reference = "foreign-reference";
  assert.equal(inspect(sources.current, input, [report]).status, "corrupt");
});
