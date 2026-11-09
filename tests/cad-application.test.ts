import path from "node:path";
import type {
  CadServices,
  CadExecutionRequest,
  CadExecutionPort,
  BatchServices,
  BatchReport,
  AtomicServices,
  AtomicReport,
} from "../packages/core/src/application/cad/index.js";
import type { PreparedPythonArtifact } from "../packages/core/src/domain/python-artifact.js";
import type { InvocationStore } from "../packages/node-adapters/src/execution/invocation.js";
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { CadData, CadContext } from "@fmcad/core";
import {
  object,
  array,
  field,
  string,
  present,
} from "./modeling-unit-test-support.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const fixtureDirectory = path.join(process.cwd(), "tests");
const load = createRequire(
  path.join(fixtureDirectory, "cad-application.test.ts"),
);
const core = load(
  "../src/dist/core/application/cad",
) as typeof import("../packages/core/src/application/cad/index.js");
const { clone } = load(
  "../src/dist/core/application/cad/json",
) as typeof import("../packages/core/src/application/cad/json.js");
const { catalog, validateCad } = load(
  "../src/catalog",
) as typeof import("../src/composition/library-catalog-registry.js");
const { pythonLiteral, pythonValue, preparePythonArtifact } = load(
  "../src/python",
) as typeof import("../packages/node-adapters/src/python/artifact.js");

const context = { doc: "Model Ż", docId: "creation-1", docFileId: "file-1" };
function artifact(operation: string, data: CadData, ctx: CadContext) {
  const plan = core.planCadScript(
    operation,
    data,
    ctx,
    present(catalog[operation]),
    pythonLiteral,
  );
  return preparePythonArtifact(
    [
      {
        id: "wrapper",
        filename: "<test-wrapper>",
        source: plan.wrapper,
        role: "wrapper",
      },
    ],
    { request: plan.request, context: ctx },
  );
}
function services(overrides: Partial<CadServices> = {}): CadServices {
  return {
    validate: validateCad,
    prepare: artifact,
    dispatch: () => undefined,
    sketchValidates: () => false,
    failed: (value) => core.record(value) && value["success"] === false,
    execution: { execute: async () => assert.fail("unexpected SDK turn") },
    ...overrides,
  };
}

test("strict CAD use case passes a pinned immutable artifact through one execution port for real read/mutation wrappers", async () => {
  const calls: CadExecutionRequest[] = [];
  const port: CadExecutionPort = {
    execute: async (request) => {
      calls.push(request);
      assert.ok(Object.isFrozen(request.artifact.bytes));
      assert.deepEqual(
        field(request.artifact.request, "data"),
        present(catalog[request.operation]).example,
      );
      // Execute the actual prepared wrapper against a deliberately small fake SDK
      // context, rather than returning an unrelated canned transport result.
      const result = spawnSync(
        "python3",
        [
          "-B",
          "-c",
          `import json,sys,types,contextlib,io
events=[]
CAD_HANDLERS={}
def _cad_json(value): return value
class CadContext:
    def __init__(self,doc,component,project_id,doc_id,file_id):
        self.doc=types.SimpleNamespace(name=doc)
        self.created=[]
        events.append(['context',doc,doc_id,file_id])
    def activate_target(self): events.append(['activate'])
    def assert_identity(self): events.append(['identity'])
    def call(self,operation,data):
        events.append(['call',operation,data])
        return {'schemaVersion':1,'status':'pass','affected':[{'token':'actual-fake-token'}]}
exec(compile(sys.stdin.read(),'<prepared>','exec'))
output=io.StringIO()
with contextlib.redirect_stdout(output): run('context')
print(json.dumps({'text':output.getvalue(),'events':events}))
`,
        ],
        { input: request.artifact.script, encoding: "utf8" },
      );
      assert.equal(field(result, "status"), 0, result.stderr);
      const executed = object(JSON.parse(result.stdout));
      assert.deepEqual(field(executed, "events", 0), [
        "context",
        context.doc,
        context.docId,
        context.docFileId,
      ]);
      assert.equal(
        array(executed["events"]).some(
          (event) => field(event, 0) === "activate",
        ),
        !request.readOnly,
      );
      assert.deepEqual(array(executed["events"]).at(-1), [
        "call",
        request.operation,
        present(catalog[request.operation]).example,
      ]);
      return { text: string(executed["text"]) };
    },
  };
  for (const operation of ["document.status", "sketch.create"]) {
    const output = await core.executeCad(
      operation,
      present(catalog[operation]).example,
      context,
      services({ execution: port }),
    );
    assert.equal(output["success"], true);
    if (operation === "sketch.create")
      assert.deepEqual(output["affected"], [{ token: "actual-fake-token" }]);
  }
  assert.deepEqual(
    calls.map((call) => call.readOnly),
    [true, false],
  );
});

test("invalid and preview CAD never prepare or execute, and unknown SDK outcomes are never retried", async () => {
  let calls = 0;
  const noPreparation = services({
    prepare: () => assert.fail("preview must not bundle"),
  });
  await assert.rejects(
    core.executeCad("document.status", { typo: 1 }, context, noPreparation),
    /Unknown CAD inputs/,
  );
  const preview = await core.executeCad(
    "document.status",
    {},
    { ...context, preview: true },
    noPreparation,
  );
  assert.equal(preview["mutation"], false);
  assert.equal(preview["state"], "input-validated-only");
  await assert.rejects(
    core.executeCad(
      "sketch.create",
      present(catalog["sketch.create"]).example,
      context,
      services({
        execution: {
          execute: async () => {
            calls++;
            throw new Error("lost ack");
          },
        },
      }),
    ),
    /lost ack/,
  );
  assert.equal(calls, 1);
});

test("SDK route binds caller input to its artifact before the first asynchronous boundary", async () => {
  const data = clone(present(catalog["sketch.create"]).example);
  const original = clone(data);
  let accepted: PreparedPythonArtifact | undefined;
  const pending = core.executeCad(
    "sketch.create",
    data,
    context,
    services({
      execution: {
        execute: async (request) => {
          accepted = request.artifact;
          return { text: 'FMCAD_RESULT {"success":true}' };
        },
      },
    }),
  );
  data["name"] = "changed after calling";
  await pending;
  assert.deepEqual(field(present(accepted).request, "data"), original);
});

function memoryServices(
  overrides: Omit<Partial<BatchServices>, "execute"> & {
    execute?: NonNullable<BatchServices["execute"]>;
  } = {},
) {
  const snapshots: BatchReport[] = [],
    calls: { operation: string; data: CadData; context: CadContext }[] = [];
  let opened = 0,
    closed = 0,
    preserve = false;
  const services: BatchServices & {
    execute: NonNullable<BatchServices["execute"]>;
  } = {
    catalog: {
      "test.read": { readOnly: true, inputs: {}, required: [] },
      "test.mutate": { readOnly: false, inputs: { source: "" }, required: [] },
    },
    isLocal: () => false,
    local: () => assert.fail("not local"),
    execute: async (operation, data, ctx) => {
      assert.equal(
        field(snapshots.at(-1), "steps", calls.length, "status"),
        "running",
      );
      calls.push({ operation, data, context: ctx });
      return {
        success: true,
        result: { token: "fake-" + calls.length },
        created: [{ token: "fake-" + calls.length }],
      };
    },
    atomic: () => assert.fail("not atomic"),
    reportPath: () => "opaque-report-id",
    now: () => 0,
    timestamp: () => "2026-10-25T00:00:00.000Z",
    redact: String,
    failed: (value) => core.record(value) && value["success"] === false,
    open: async () => {
      opened++;
      return {
        latest: async () => snapshots.at(-1),
        assertEmpty: async () => {},
        publish: async (report) => {
          snapshots.push(clone(report));
        },
        close: async (flag) => {
          closed++;
          preserve = flag === true;
        },
      };
    },
    ...overrides,
  };
  return {
    services,
    snapshots,
    calls,
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
    get preserve() {
      return preserve;
    },
  };
}
const batch = {
  runId: "typed",
  atomic: false,
  operations: [
    { id: "read", operation: "test.read", data: {}, onExisting: "reuse" },
    {
      id: "mutate",
      operation: "test.mutate",
      data: { source: { $ref: "read.result.token" } },
      onExisting: "reuse",
    },
    {
      id: "last",
      operation: "test.mutate",
      data: { source: { $ref: "mutate.result.token" } },
      onExisting: "reuse",
    },
  ],
};
test("memory-only multi-turn batch retains pre-RPC intent, references, exact replay and stops on unknown", async () => {
  const memory = memoryServices();
  const result = await core.runBatchEntry(batch, context, memory.services);
  assert.equal(field(result, "success"), true);
  assert.equal(memory.calls.length, 3);
  assert.deepEqual(
    memory.calls.map((call) => call.data),
    [{}, { source: "fake-1" }, { source: "fake-2" }],
  );
  const replay = await core.runBatchEntry(batch, context, memory.services);
  assert.equal(field(replay, "replayed"), true);
  assert.equal(memory.calls.length, 3);
  assert.equal(memory.closed, 2);
  const uncertain = memoryServices();
  const execute = uncertain.services.execute;
  uncertain.services.execute = async (...args) => {
    if (uncertain.calls.length === 1) throw new Error("RPC timed out");
    return execute(...args);
  };
  const unknown = await core.runBatchEntry(batch, context, uncertain.services);
  assert.deepEqual(
    array(field(unknown, "steps")).map((step) => field(step, "status")),
    ["success", "unknown", "skipped"],
  );
  assert.equal(field(unknown, "steps", 1, "mutationStatus"), "unknown");
  await assert.rejects(
    core.runBatchEntry(batch, context, uncertain.services),
    /no automatic retry/,
  );
});
test("batch validation and scoped expansion use no file/store/SDK service", async () => {
  const memory = memoryServices({
    open: () => assert.fail("offline must not open store"),
  });
  const result = await core.runBatchEntry(
    { ...batch, mode: "preview" },
    context,
    memory.services,
  );
  assert.equal(field(result, "success"), true);
  assert.equal(field(result, "atomic", "effective"), false);
  const expanded = core.expandDefinition({
    formatVersion: 1,
    runId: "scoped",
    operations: [
      {
        id: "loop",
        repeat: 2,
        operations: [
          {
            id: "leaf",
            operation: "test.mutate",
            data: { source: { $local: "index" } },
          },
        ],
      },
    ],
  });
  assert.deepEqual(
    array(field(expanded, "operations")).map((step) =>
      field(step, "data", "source"),
    ),
    [0, 1],
  );
  assert.throws(
    () =>
      core.expandDefinition({
        formatVersion: 1,
        operations: [{ id: "bad", use: "cycle" }],
        definitions: { cycle: { operations: [{ id: "again", use: "cycle" }] } },
      }),
    /cycle/,
  );
});
test("run service prepares embedded original-source unit and executes via the same artifact port", async () => {
  const request = {
    name: "trusted.py",
    args: { text: "$& Ż" },
    hasArgs: true,
    doc: context.doc,
    identity: { docId: context.docId, readOnly: true },
    helperVersion: "cad-v1",
    readOnlyOperations: ["document.status"],
  };
  let seen: CadExecutionRequest | undefined;
  const reply = await core.executeRun(
    request,
    {
      filename: "trusted.py",
      source: 'ARGS = {}\nDOC_NAME = ""\ndef run(ctx): return ARGS\n',
    },
    {
      pythonValue,
      prepare: preparePythonArtifact,
      runtime: () => [
        {
          id: "runtime",
          filename: "<fake-runtime>",
          source: "# Fake runtime",
          role: "runtime",
        },
      ],
    },
    {
      execute: async (turn) => {
        seen = turn;
        return { text: "retained stdout" };
      },
    },
  );
  assert.equal(reply.text, "retained stdout");
  assert.equal(present(seen).operation, "run");
  assert.equal(present(seen).readOnly, true);
  assert.equal(present(seen).context.docId, context.docId);
  assert.ok(
    present(seen).artifact.units.some(
      (unit) => unit.role === "user" && unit.filename === "trusted.py",
    ),
  );
  assert.match(present(seen).artifact.script, /facade\.terminal\(\)/);
  assert.match(present(seen).artifact.script, /facade\.has_emitted/);
  assert.match(present(seen).artifact.script, /dont_inherit=True/);
  assert.ok(Object.isFrozen(present(seen).artifact.bytes));
});

test("CAD input planning separates file selection from verified byte decoding", () => {
  const plan = core.planCadInput(
    [
      "--doc",
      context.doc,
      "--doc-id",
      context.docId,
      "--file",
      "unopened.json",
      "--solid",
      "false",
    ],
    { solid: "" },
  );
  assert.deepEqual(plan.payload, { kind: "file", value: "unopened.json" });
  assert.throws(() => core.decodeCadInput(plan), /snapshot required/);
  assert.deepEqual(core.decodeCadInput(plan, '{"name":"Ż"}').data, {
    name: "Ż",
    solid: false,
  });
  assert.throws(
    () => core.decodeCadInput(plan, '{"solid":true}'),
    /Duplicate CAD input/,
  );
});

function atomicMemory(overrides: Partial<AtomicServices> = {}) {
  const snapshots: BatchReport[] = [],
    operations: unknown[] = [];
  let preserved = false;
  const services: AtomicServices = {
    catalog: { "test.mutate": { readOnly: false } },
    backend: "addin",
    supported: true,
    isLocal: () => false,
    reportPath: () => "atomic-report",
    now: () => 0,
    timestamp: () => "2026-10-25T00:00:00.000Z",
    nonce: () => "a".repeat(32),
    redact: String,
    wait: async () => {},
    faultSteps: (steps) => steps,
    prepare: (args) =>
      preparePythonArtifact(
        [
          {
            id: "wrapper",
            filename: "<atomic>",
            source: "# fake wire",
            role: "wrapper",
          },
        ],
        { request: args },
      ),
    execution: {
      execute: async (request) => {
        const args = object(request.artifact.request);
        operations.push(args["operation"]);
        assert.equal(request.operation, args["operation"]);
        assert.ok(Object.isFrozen(request.artifact.bytes));
        if (args["operation"] === "atomic_resolve") {
          assert.equal(
            field(snapshots.at(-1), "journal", "event"),
            "identity_resolution_uncertain",
          );
          return {
            text:
              "FMCAD_RESULT " +
              JSON.stringify({
                status: "resolved",
                resolvedIdentity: {
                  creationId: context.docId,
                  fileId: context.docFileId,
                },
              }),
          };
        }
        if (args["operation"] === "atomic_start") {
          assert.equal(
            field(snapshots.at(-1), "journal", "event"),
            "submit_uncertain",
          );
          return { text: "FMCAD_RESULT {}" };
        }
        if (args["operation"] === "atomic_status")
          return { text: 'FMCAD_RESULT {"destroyed":true}' };
        assert.equal(args["operation"], "atomic_finalize");
        return {
          text:
            "FMCAD_RESULT " +
            JSON.stringify({
              outcome: "committed",
              created: [{ token: "committed" }],
              results: {
                leaf: { success: true, result: { token: "committed" } },
              },
            }),
        };
      },
    },
    open: async () => ({
      latest: async () => undefined,
      assertEmpty: async () => {},
      publish: async (report) => {
        snapshots.push(clone(report));
      },
      close: async (preserve) => {
        preserved = preserve === true;
      },
    }),
    ...overrides,
  };
  return {
    services,
    snapshots,
    operations,
    get preserved() {
      return preserved;
    },
  };
}
const atomicBatch = {
  runId: "atomic",
  operations: [{ id: "leaf", operation: "test.mutate", data: {} }],
};
test("typed atomic use case never degrades to per-step and commit survives publication failure", async () => {
  const memory = atomicMemory();
  const validation = core.validateBatch(
    atomicBatch,
    memory.services.catalog,
    () => false,
  );
  const open = memory.services.open;
  memory.services.open = async (...args) => {
    const port = await open(...args);
    return {
      ...port,
      publish: async (report) => {
        if (report["outcome"] === "committed") throw new Error("disk full");
        return port.publish(report);
      },
    };
  };
  const result = await core.runAtomicBatch(
    atomicBatch,
    context,
    validation,
    memory.services,
  );
  assert.equal(field(result, "outcome"), "committed");
  assert.equal(field(result, "success"), true);
  assert.equal(field(result, "publication", "status"), "failed");
  assert.equal(memory.preserved, true);
  assert.deepEqual(memory.operations, [
    "atomic_resolve",
    "atomic_start",
    "atomic_status",
    "atomic_finalize",
  ]);
  assert.deepEqual(field(result, "steps", 0, "output", "result"), {
    token: "committed",
  });
});
test("atomic unknown submit stays unknown without poll/finalize/replay; unsupported rejects before store", async () => {
  const memory = atomicMemory();
  const execute = memory.services.execution.execute;
  memory.services.execution.execute = async (request) => {
    if (request.operation === "atomic_start") {
      memory.operations.push("atomic_start");
      throw new Error("lost ack");
    }
    return execute(request);
  };
  const validation = core.validateBatch(
    atomicBatch,
    memory.services.catalog,
    () => false,
  );
  const result = await core.runAtomicBatch(
    atomicBatch,
    context,
    validation,
    memory.services,
  );
  assert.equal(field(result, "outcome"), "unknown");
  assert.equal(
    field(memory.snapshots.at(-1), "journal", "event"),
    "submit_unknown",
  );
  assert.deepEqual(memory.operations, ["atomic_resolve", "atomic_start"]);
  const rejected = await core.runAtomicBatch(atomicBatch, context, validation, {
    ...memory.services,
    supported: false,
    open: () => assert.fail("preflight must not open journal"),
  });
  assert.equal(field(rejected, "outcome"), "rejected");
  assert.equal(field(rejected, "mutated"), false);
});
test("finalize of acknowledged commit is idempotent and never prepares or executes a script", async () => {
  const report: AtomicReport = {
    version: 2,
    success: true,
    operation: "batch.run",
    runId: "already-finalized",
    requestHash: "fixture-hash",
    request: {},
    context,
    status: "success",
    reportPath: "unused",
    steps: [],
    commandId: "fixture-command",
    sessionNonce: "fixture-session",
    atomic: { effective: true, supported: true, backend: "addin" },
    documentIdentity: {
      expected: {},
      assertionsOnly: false,
      resolved: { creationId: context.docId },
    },
    outcome: "committed",
    journal: { event: "finalize_ack" },
    cleanupCompleted: true,
  };
  const result = await core.finalizeAtomicBatch(
    report,
    {
      supported: true,
      timestamp: () => assert.fail("no publication"),
      redact: () => assert.fail("no diagnostics"),
      prepare: () => assert.fail("no replay"),
      execution: { execute: () => assert.fail("no replay") },
    },
    () => assert.fail("no lock theft"),
  );
  assert.equal(field(result, "status"), "already_finalized");
  assert.equal(field(result, "outcome"), "committed");
});

test("run adapter pins accepted raw bytes before UTF-8 decoding and argument injection", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-source-bytes-"));
  const file = path.join(dir, "trusted.py");
  const bytes = Buffer.concat([
    Buffer.from("# "),
    Buffer.from([0xff]),
    Buffer.from('\nARGS = {}\nDOC_NAME = ""\ndef run(ctx): return ARGS\n'),
  ]);
  fs.writeFileSync(file, bytes);
  t.after(() => {
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
  });
  const previous = process.env["FMCAD_QUEUE_WORKER_JOB"];
  process.env["FMCAD_QUEUE_WORKER_JOB"] = "test-accepted-bytes";
  t.after(() => {
    if (previous === undefined) delete process.env["FMCAD_QUEUE_WORKER_JOB"];
    else process.env["FMCAD_QUEUE_WORKER_JOB"] = previous;
  });
  let verified = 0;
  t.mock.method(
    load("../src/queue-client"),
    "verifyInputBytes",
    (sourcePath: string, acceptedBytes: Buffer) => {
      verified++;
      assert.equal(sourcePath, file);
      assert.deepEqual(acceptedBytes, bytes);
    },
  );
  const invocation: InvocationStore = {};
  (
    load(
      "../src/invocation",
    ) as typeof import("../packages/node-adapters/src/execution/invocation.js")
  ).context.run(invocation, () => {
    const prepared = (
      load("../src/run") as typeof import("../src/composition/run.js")
    ).prepareRunScript(file, { injected: "Ż $&" }, true, "Model");
    assert.equal(invocation.sourcePath, file);
    assert.equal(
      invocation.sourceHash,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.match(prepared.script, /injected/);
    assert.notEqual(prepared.sha256, invocation.sourceHash);
  });
  assert.equal(verified, 1);
});

test("host-independent canonical provenance matches the retained Node SHA-256 bytes", () => {
  const value = {
    nested: { z: [null, true, -0, "Żółć 🧪 \ud800"], a: "first" },
    other: 1.25,
  };
  assert.equal(
    core.hashCadJson(value),
    createHash("sha256").update(core.canonicalCadJson(value)).digest("hex"),
  );
});
