import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  PreparedPythonArtifact,
  PythonChecker,
  PythonCheckReport,
  PythonCheckStatus,
  PythonCheckAbortSignal,
  DispatchPorts,
} from "../packages/core/src";
import type { PythonRpcCertificate } from "../packages/node-adapters/src/python/admission";
import type { PhasedWorkerOptions } from "../packages/node-adapters/src/execution/phased-workers";
const load = createRequire(
  path.join(process.cwd(), "tests/python-admission.test.js"),
);
test.after((load("./fixtures/fake-wsl-platform.cjs") as () => () => void)());
const { assertDocumentStatusAdmission } = load(
  "../dist/tests/fixtures/document-status-admission",
) as typeof import("./fixtures/document-status-admission");
const { dispatchPrepared, initialQueueSnapshot } = load(
  "../packages/core/dist",
) as typeof import("../packages/core/src");
const {
  createPythonRpcAdmission,
  classifyPythonRpc,
  pythonAdmissionResources,
} = load(
  "../packages/node-adapters/dist/python/admission",
) as typeof import("../packages/node-adapters/src/python/admission");
const { createPythonChecker } = load(
  "../packages/node-adapters/dist/python/checker",
) as typeof import("../packages/node-adapters/src/python/checker");
const { preparePythonArtifact } = load(
  "../packages/node-adapters/dist/python/artifact",
) as typeof import("../packages/node-adapters/src/python/artifact");
const { validateInvocation } = load(
  "../src/catalog",
) as typeof import("../src/composition/library-catalog-registry");
const { prepareCadScript } = load(
  "../src/cad",
) as typeof import("../src/composition/cad");
const { createProductionQueueAdmission } = load(
  "../src/queue-admission",
) as typeof import("../src/queue-admission");
const documentStatusAdmission = load(
  "./fixtures/document-status-admission-6bb.json",
) as {
  checker: { engine: string; version: string; definitionsHash: string };
  fences: {
    dispatchPreparedSenderCallsPerValidArtifact: number;
    dispatchPreparedSenderCallsPerNegativeMode: number;
  };
};
type Admission = ReturnType<typeof createPythonRpcAdmission>;
type Phased =
  import("../packages/node-adapters/src/execution/phased-workers").PhasedWorkers;
type WorkerRecord = Phased["workers"] extends Map<string, infer R> ? R : never;
function required<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}
function coded(error: unknown): Error & { code: string } {
  assert.ok(error instanceof Error && "code" in error);
  assert.equal(typeof error.code, "string");
  return error as Error & { code: string };
}
function checkedError(
  error: unknown,
): ReturnType<typeof coded> & { pythonCheck: PythonCheckReport } {
  const value = coded(error);
  assert.ok(
    "pythonCheck" in value &&
      value.pythonCheck &&
      typeof value.pythonCheck === "object",
  );
  return value as ReturnType<typeof coded> & { pythonCheck: PythonCheckReport };
}
function workerJob(id: string, cwd = "/tmp"): WorkerRecord["job"] {
  return {
    id,
    requestId: id,
    clientId: "fixture",
    kind: "command",
    hash: "fixture",
    order: 1,
    state: "preparing",
    submittedAt: 1,
    queueDeadline: null,
    timeoutMs: 1000,
    sequenceId: null,
    sequenceState: null,
    request: {
      requestId: id,
      clientId: "fixture",
      kind: "command",
      timeoutMs: 1000,
      cwd,
      argv: [],
    },
  };
}
function phasedOptions(
  input: Partial<PhasedWorkerOptions>,
): PhasedWorkerOptions {
  return {
    state: {
      status: () => workerJob("job"),
      readyTurn: () => assert.fail("unexpected ready turn"),
      finishLocal: () => assert.fail("unexpected finish"),
    },
    dir: "/tmp",
    cfg: {},
    codeHash: "fixture",
    properties: () => ({}),
    prepareRequest: () => assert.fail("unexpected worker start"),
    onUnknown: () => assert.fail("unexpected unknown"),
    onFault: (error) => {
      throw error;
    },
    entrypoint: "unused",
    durable: () => assert.fail("unexpected durable write"),
    readResult: () => assert.fail("unexpected result read"),
    processBirth: () => assert.fail("unexpected process query"),
    workflowNonterminal: () => false,
    responsePath: () => assert.fail("unexpected response path"),
    ...input,
  };
}
const runtime = path.resolve("dist/runtime/python");
const raw = (code: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "execute_python", arguments: { code, persistent: false } },
});
const official = (script: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "fusion_mcp_execute",
    arguments: { featureType: "script", object: { script } },
  },
});
function report(
  artifact: PreparedPythonArtifact,
  status: PythonCheckStatus = "passed",
): PythonCheckReport {
  return {
    status,
    diagnostics: [],
    reasons: [],
    provenance: {
      artifactHash: artifact.artifactHash,
      wireHash: artifact.sha256,
      analysisHash: "analysis",
      checkerHash: "checker",
      configHash: "config",
      typingHash: "typing",
      checker: "fixture",
      checkerVersion: "fixture",
      pythonVersion: "3.10",
      pythonInterpreterVersion: null,
      definitionsHash: null,
      contextHash: "fixture",
      cache: "disabled",
    },
  };
}
function adapter(
  check: PythonChecker["check"] = async ({ artifact }) => report(artifact),
  resources = () => "resources",
) {
  return createPythonRpcAdmission({ runtime, checker: { check }, resources });
}
function dispatch<T extends Record<string, unknown>>(
  admission: Admission,
  outgoing: T,
  trace: string[] = [],
  more: Partial<DispatchPorts<T, T, T>> = {},
) {
  let certificate: PythonRpcCertificate | undefined;
  return dispatchPrepared({
    prepare: () => outgoing,
    async check(payload) {
      trace.push("check");
      certificate = await admission.check(payload);
    },
    admit(send) {
      trace.push("grant");
      return send();
    },
    fence(payload) {
      required(certificate).fence(payload);
      queueMicrotask(() => trace.push("microtask"));
    },
    async send(payload) {
      trace.push("send");
      return structuredClone(payload);
    },
    settle: (_, reply) => reply,
    unknown() {
      trace.push("unknown");
    },
    ...more,
  });
}

test("all rejecting checker statuses and mismatched identity produce zero admission and zero SDK calls", async () => {
  for (const status of ["failed", "incomplete", "tool_error"] as const) {
    for (const payload of [raw('x: int = "bad"'), official('x: int = "bad"')]) {
      const trace: string[] = [];
      await assert.rejects(
        dispatch(
          adapter(async ({ artifact }) => report(artifact, status)),
          payload,
          trace,
        ),
        { code: "PYTHON_CHECK_REJECTED" },
      );
      assert.deepEqual(trace, ["check"]);
    }
  }
  const trace: string[] = [];
  await assert.rejects(
    dispatch(
      adapter(async ({ artifact }) => ({
        ...report(artifact),
        provenance: { ...report(artifact).provenance, wireHash: "other" },
      })),
      raw("x: int = 1"),
      trace,
    ),
  );
  assert.deepEqual(trace, ["check"]);
  await assert.rejects(
    dispatch(
      adapter(async () => {
        throw new Error("missing checker");
      }),
      raw("x: int = 1"),
    ),
    { code: "PYTHON_CHECK_TOOL_ERROR" },
  );
});

test("checked exact final bytes send once, with no asynchronous turn after grant", async () => {
  for (const payload of [raw("x: int = 1"), official("x: int = 1")]) {
    const trace: string[] = [];
    const result = await dispatch(adapter(), payload, trace);
    assert.deepEqual(result, payload);
    assert.deepEqual(trace, ["check", "grant", "send", "microtask"]);
  }
});

test("Python admission forwards its local-phase cancellation signal to the checker", async () => {
  const controller = new AbortController();
  let received: PythonCheckAbortSignal | undefined;
  const admission = adapter(async ({ artifact }, options) => {
    received = options?.signal;
    return report(artifact);
  });
  const certificate = await admission.check(raw("x: int = 1"), undefined, {
    signal: controller.signal,
  });
  assert.equal(received, controller.signal);
  required(certificate).fence(raw("x: int = 1"));
});

test("TOCTOU source, RPC class, context, source units and resources are fenced without replay", async () => {
  for (const mutate of [
    (p: ReturnType<typeof raw>) => (p.params.arguments.code += "\nx: str = 2"),
    (p: ReturnType<typeof raw>) => (p.params.name = "capture_viewport"),
    (p: ReturnType<typeof raw>) => (p.id = 2),
  ]) {
    const payload = raw("x: int = 1"),
      trace: string[] = [];
    await assert.rejects(
      dispatch(adapter(), payload, trace, {
        admit(send) {
          mutate(payload);
          return send();
        },
      }),
      { code: "PYTHON_ADMISSION_CHANGED" },
    );
    assert.deepEqual(trace, ["check"]);
  }
  let resources = "one";
  const payload = raw("x: int = 1");
  const certificate = await adapter(undefined, () => resources).check(payload);
  resources = "two";
  assert.throws(() => required(certificate).fence(payload), {
    code: "PYTHON_ADMISSION_CHANGED",
  });
  const original = preparePythonArtifact([
    { id: "user", filename: "user.py", role: "user", source: "x: int = 1" },
  ]);
  for (const modified of [
    { ...original, context: { app: true } },
    { ...original, units: [] },
    { ...original, bytes: [0] },
  ])
    await assert.rejects(adapter().check(raw(original.script), modified));
});

test("explicit non-Python class does not invoke checker and cannot become Python later", async () => {
  const admission = adapter(async () =>
    assert.fail("non-Python must not invoke checker"),
  );
  for (const payload of [
    { method: "initialize" },
    { method: "tools/list" },
    { method: "ping" },
    { method: "notifications/initialized" },
    { method: "resources/list" },
    { method: "resources/templates/list" },
    {
      method: "tools/call",
      params: {
        name: "fusion_mcp_execute",
        arguments: { featureType: "document" },
      },
    },
    ...[
      "fusion_mcp_read",
      "capture_viewport",
      "get_viewport",
      "fetch_api_documentation",
      "fetch_design_guide",
    ].map((name) => ({ method: "tools/call", params: { name } })),
  ] as {
    method: string;
    params?: { name: string; arguments?: Record<string, unknown> };
  }[]) {
    assert.equal(classifyPythonRpc(payload).kind, "non-python");
    const certificate = await admission.check(payload);
    required(certificate).fence(payload);
    payload.method = "tools/call";
    payload.params = {
      name: "execute_python",
      arguments: { code: "print(1)" },
    };
    assert.throws(() => required(certificate).fence(payload));
  }
  assert.throws(() =>
    classifyPythonRpc({
      method: "tools/call",
      params: { name: "unknown_tool" },
    }),
  );
});

test("real checker rejects nested bad Python and preserves literal filenames (not an entrypoint coverage claim)", async () => {
  const admission = createPythonRpcAdmission({
    runtime,
    checker: createPythonChecker({ typingRoot: path.join(runtime, "typing") }),
    resources: () => "test-immutable",
  });
  for (const kind of ["user", "internal"]) {
    const source = `exec(compile(${JSON.stringify('x: int = "bad"')}, ${JSON.stringify(kind + ".py")}, 'exec'))`;
    const trace: string[] = [];
    await assert.rejects(
      dispatch(admission, official(source), trace),
      (error) => {
        assert.equal(coded(error).code, "PYTHON_CHECK_REJECTED");
        assert.ok(
          checkedError(error).pythonCheck.diagnostics.some(
            (d) =>
              d.filename === kind + ".py" && d.rule === "reportAssignmentType",
          ),
          JSON.stringify(checkedError(error).pythonCheck),
        );
        return true;
      },
    );
    assert.deepEqual(trace, ["check"]);
  }
  const trace: string[] = [];
  await dispatch(admission, raw("x: int = 1"), trace);
  assert.deepEqual(trace, ["check", "grant", "send", "microtask"]);
});

test("real internal receipt wrapper passes with verified SDK definitions and rejects nested errors", async () => {
  const { prepareReceiptScript } = load("../src/queue-instance") as ReturnType<
    typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
  >;
  const artifact = prepareReceiptScript(
    "def run(context: object) -> None:\n    pass",
    true,
    "/tmp/opencode/never-written.json",
    { jobId: "test" },
  );
  const admission = createPythonRpcAdmission({
    runtime,
    checker: createPythonChecker({
      typingRoot: path.join(runtime, "typing"),
      definitionsRoot: path.join(runtime, "typing"),
      pythonPlatform: "Windows",
    }),
  });
  const certificate = await admission.check(
    official(artifact.script),
    artifact,
  );
  assert.equal(required(certificate.report).status, "passed");
  required(certificate).fence(official(artifact.script));
  const bad = prepareReceiptScript(
    'def run(context: object) -> None:\n    value: int = "bad"',
    true,
    "/tmp/opencode/never-written.json",
    { jobId: "bad" },
  );
  await assert.rejects(
    admission.check(official(bad.script), bad),
    (error) =>
      coded(error).code === "PYTHON_CHECK_REJECTED" &&
      checkedError(error).pythonCheck.diagnostics.some(
        (d) =>
          d.rule === "reportAssignmentType" && d.filename === "<fmcad-queue>",
      ),
  );
  for (const source of [
    "def run(first: str, second: str) -> None:\n    pass",
    "def run(context: int) -> None:\n    pass",
  ]) {
    const mismatched = prepareReceiptScript(
      source,
      true,
      "/tmp/opencode/never-written.json",
      { jobId: "wrong-entrypoint" },
    );
    await assert.rejects(
      admission.check(official(mismatched.script), mismatched),
      (error) =>
        coded(error).code === "PYTHON_CHECK_REJECTED" &&
        checkedError(error).pythonCheck.diagnostics.some(
          (d) =>
            d.rule === "reportAssignmentType" && d.filename === "<fmcad-queue>",
        ),
    );
  }
  assert.equal(fs.existsSync("/tmp/opencode/never-written.json"), false);
});

test("public document.status checks the current six-unit artifact before exactly one send", async () => {
  const invocation = validateInvocation({
    version: 1,
    kind: "cad",
    operation: "document.status",
    data: {},
    doc: "Model",
    docId: "creation",
    docFileId: "file",
    purpose: "Inspect owned model",
  });
  const artifact = prepareCadScript(invocation.operation, invocation.data, {
    doc: required(invocation.doc),
    docId: required(invocation.docId),
    docFileId: required(invocation.docFileId),
    ...(invocation.component === undefined
      ? {}
      : { component: invocation.component }),
    ...(invocation.projectId === undefined
      ? {}
      : { projectId: invocation.projectId }),
    preview: invocation.preview === true,
  });
  const production = createProductionQueueAdmission(runtime);
  function outgoingFor(pythonArtifact: PreparedPythonArtifact) {
    return {
      jsonrpc: "2.0",
      id: "document-status-test",
      method: "tools/call",
      params: {
        name: "fusion_mcp_execute",
        arguments: {
          featureType: "script",
          object: { script: pythonArtifact.script, readOnly: true },
        },
      },
    };
  }
  function dispatchArtifact(
    admission: Admission,
    pythonArtifact: PreparedPythonArtifact,
  ) {
    const outgoing = outgoingFor(pythonArtifact);
    let certificate: PythonRpcCertificate | undefined;
    let senderCalls = 0;
    const promise = dispatchPrepared({
      prepare: () => outgoing,
      async check(payload) {
        certificate = await admission.check(payload, pythonArtifact);
      },
      admit(send) {
        return send();
      },
      fence(payload) {
        required(certificate).fence(payload);
      },
      async send(payload) {
        senderCalls++;
        return structuredClone(payload);
      },
      settle: (_, reply) => reply,
      unknown() {
        assert.fail("A checked document.status request became unknown");
      },
    });
    return {
      promise,
      outgoing,
      get certificate() {
        return required(certificate);
      },
      get senderCalls() {
        return senderCalls;
      },
    };
  }
  function rebuild(units: PreparedPythonArtifact["units"]) {
    return preparePythonArtifact(
      units.map(({ id, filename, source, role }) => ({
        id,
        filename,
        source,
        role,
      })),
      {
        context: artifact.context,
        request: artifact.request,
      },
    );
  }

  const valid = dispatchArtifact(production.admission, artifact);
  await valid.promise;
  assert.equal(required(valid.certificate.report).status, "passed");
  assert.equal(required(valid.certificate.report).diagnostics.length, 0);
  assertDocumentStatusAdmission(artifact);
  assert.equal(required(valid.certificate.artifact).sha256, artifact.sha256);
  assert.equal(
    required(valid.certificate.artifact).artifactHash,
    artifact.artifactHash,
  );
  assert.equal(
    required(valid.certificate.report).provenance.checker,
    documentStatusAdmission.checker.engine,
  );
  assert.equal(
    required(valid.certificate.report).provenance.checkerVersion,
    documentStatusAdmission.checker.version,
  );
  assert.equal(
    required(valid.certificate.report).provenance.definitionsHash,
    documentStatusAdmission.checker.definitionsHash,
  );
  assert.deepEqual(required(valid.certificate.artifact).units, artifact.units);
  assert.equal(
    valid.senderCalls,
    documentStatusAdmission.fences.dispatchPreparedSenderCallsPerValidArtifact,
  );
  assert.deepEqual(
    required(valid.certificate.artifact).units.map((unit) => unit.id),
    [
      "values",
      "fusion-values",
      "core",
      "identity",
      "document_snapshot",
      "wrapper",
    ],
  );

  const invalid = rebuild(
    artifact.units.map((unit) => ({
      ...unit,
      source:
        unit.id === "wrapper"
          ? unit.source + '\nstatus_bad: int = "bad"\n'
          : unit.source,
    })),
  );
  const rejectedType = dispatchArtifact(production.admission, invalid);
  await assert.rejects(rejectedType.promise, (error) => {
    assert.equal(coded(error).code, "PYTHON_CHECK_REJECTED");
    assert.equal(checkedError(error).pythonCheck.status, "failed");
    assert.ok(
      checkedError(error).pythonCheck.diagnostics.some(
        (item) => item.rule === "reportAssignmentType",
      ),
    );
    return true;
  });
  assert.equal(
    rejectedType.senderCalls,
    documentStatusAdmission.fences.dispatchPreparedSenderCallsPerNegativeMode,
  );

  const incomplete = rebuild(
    artifact.units.filter((unit) => unit.id !== "identity"),
  );
  const rejectedIncomplete = dispatchArtifact(production.admission, incomplete);
  await assert.rejects(rejectedIncomplete.promise, (error) => {
    assert.ok(
      ["PYTHON_CHECK_REJECTED", "PYTHON_ADMISSION_UNAVAILABLE"].includes(
        coded(error).code,
      ),
    );
    return true;
  });
  assert.equal(
    rejectedIncomplete.senderCalls,
    documentStatusAdmission.fences.dispatchPreparedSenderCallsPerNegativeMode,
  );

  let tamperSends = 0;
  const tampered = structuredClone(valid.outgoing);
  tampered.params.arguments.object.script +=
    "\n# changed after final-byte check\n";
  assert.throws(() => {
    valid.certificate.fence(tampered);
    tamperSends++;
  });
  assert.equal(
    tamperSends,
    documentStatusAdmission.fences.dispatchPreparedSenderCallsPerNegativeMode,
  );

  const missingChecker = adapter(async () => {
    throw new Error("basedpyright unavailable");
  });
  const rejectedMissingChecker = dispatchArtifact(missingChecker, artifact);
  await assert.rejects(rejectedMissingChecker.promise, {
    code: "PYTHON_CHECK_TOOL_ERROR",
  });
  assert.equal(
    rejectedMissingChecker.senderCalls,
    documentStatusAdmission.fences.dispatchPreparedSenderCallsPerNegativeMode,
  );
});

test("actual run, CAD document, legacy, review and internal probe sources are inventoried and checked", async (t) => {
  const root = fs.mkdtempSync("/tmp/opencode/admission-builders-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "user.py");
  fs.writeFileSync(
    file,
    'def run(context: object) -> None:\n    value: int = "bad"\n',
  );
  const { prepareRunScript } = load(
    "../src/run",
  ) as typeof import("../src/composition/run");
  const { prepareCadScript } = load(
    "../src/cad",
  ) as typeof import("../src/composition/cad");
  const { prepareOpScript } = load("../src/ops") as {
    prepareOpScript(operation: string, args: unknown[]): PreparedPythonArtifact;
  };
  const { buildReviewScript } = load(
    "../src/review",
  ) as typeof import("../src/composition/library-review-command");
  const { queueDocumentSnapshotSource } = load(
    "../src/dist/python/document-probe",
  ) as typeof import("../packages/node-adapters/src/python/document-probe");
  const sources = [
    prepareRunScript(file, [], false, undefined).script,
    prepareCadScript("document.status", {}, { doc: "fixture" }).script,
    prepareOpScript("stats", []).script,
    buildReviewScript({} as Parameters<typeof buildReviewScript>[0]),
    queueDocumentSnapshotSource(runtime),
  ];
  const checker = createPythonChecker({
    typingRoot: path.join(runtime, "typing"),
  });
  for (const source of sources) {
    const trace: string[] = [];
    const admission = createPythonRpcAdmission({
      runtime,
      checker,
      resources: () => "test-immutable",
    });
    await assert.rejects(
      dispatch(
        admission,
        official('bad_admission_value: int = "bad"\n' + source),
        trace,
      ),
      (error) => {
        assert.ok(
          ["PYTHON_CHECK_REJECTED", "PYTHON_CHECK_TOOL_ERROR"].includes(
            coded(error).code,
          ),
        );
        return true;
      },
    );
    assert.deepEqual(trace, ["check"]);
  }
});

test("resource content and inventory bind checker/stubs, not timestamps", (t) => {
  const dir = fs.mkdtempSync("/tmp/opencode/admission-resources-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "stub.pyi"), "one");
  const a = pythonAdmissionResources([dir]);
  fs.writeFileSync(path.join(dir, "stub.pyi"), "two");
  assert.notEqual(pythonAdmissionResources([dir]), a);
  fs.writeFileSync(path.join(dir, "extra.pyi"), "");
  const b = pythonAdmissionResources([dir]);
  fs.unlinkSync(path.join(dir, "extra.pyi"));
  assert.notEqual(pythonAdmissionResources([dir]), b);
});

test("two clients can prepare concurrently; a suspended checker never occupies the physical gate", async () => {
  const { QueueGate } = load(
    "../packages/node-adapters/dist/execution/gate",
  ) as typeof import("../packages/node-adapters/src/execution/gate");
  const gate = new QueueGate(
    {
      data: {
        ...initialQueueSnapshot(),
        paused: false,
        blocked: null,
        controlGeneration: 0,
        contextEpoch: 0,
      },
      pause() {
        assert.fail("unexpected pause");
      },
    },
    "instance",
  );
  let release!: () => void, reached!: () => void;
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admission = adapter(async ({ artifact }) => {
    reached();
    await waiting;
    return report(artifact);
  });
  let certificate: PythonRpcCertificate | undefined,
    sent = 0;
  const a = dispatchPrepared({
    prepare: () => raw("x: int = 1"),
    async check(p) {
      certificate = await admission.check(p);
    },
    admit: (send) => gate.run(send),
    fence: (p: ReturnType<typeof raw>) => required(certificate).fence(p),
    async send() {
      sent++;
    },
    settle: () => {},
    unknown: () => assert.fail("unknown"),
  });
  await ready;
  assert.equal(gate.active.size, 0);
  await gate.run(async () => {
    assert.equal(gate.active.size, 1);
    sent++;
  });
  assert.equal(sent, 1);
  release();
  await a;
  assert.equal(sent, 2);
  assert.equal(gate.active.size, 0);
});

test("typed phased-worker local checking precedes SDK-ready and rejects without scheduling a turn", async () => {
  const { PhasedWorkers } = load(
    "../packages/node-adapters/dist/execution/phased-workers",
  ) as typeof import("../packages/node-adapters/src/execution/phased-workers");
  let turns = 0,
    release!: () => void,
    reached!: () => void;
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const workers = new PhasedWorkers(
    phasedOptions({
      state: {
        status() {
          return workerJob("job");
        },
        readyTurn() {
          turns++;
        },
        finishLocal() {
          assert.fail("checking must not finish a worker");
        },
      },
      async checkSdkRequest() {
        reached();
        await wait;
        throw Object.assign(new Error("bad Python"), {
          code: "PYTHON_CHECK_REJECTED",
        });
      },
    }),
  );
  const record: WorkerRecord = {
    job: workerJob("job"),
    token: "token",
    pending: null,
    localRemaining: 10000,
    localStarted: performance.now(),
    timer: null,
    closed: Promise.resolve(),
    resolveClosed() {},
  };
  workers.workers.set("job", record);
  const pending = workers.enqueue({
    jobId: "job",
    workerToken: "token",
    method: "callTool",
    args: [],
  });
  await ready;
  assert.equal(turns, 0);
  release();
  await assert.rejects(pending, { code: "PYTHON_CHECK_REJECTED" });
  assert.equal(turns, 0);
  assert.equal(record.pending, null);
  clearTimeout(record.timer ?? undefined);
});

test("typed phased-worker local deadline aborts the pending admission check", async (t) => {
  const { PhasedWorkers } = load(
    "../packages/node-adapters/dist/execution/phased-workers",
  ) as typeof import("../packages/node-adapters/src/execution/phased-workers");
  const os = load("node:os") as typeof import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-check-abort-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let observedSignal: AbortSignal | undefined,
    aborted: boolean | undefined;
  let resolveAborted!: () => void;
  const abortSeen = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });
  const workers: Phased = new PhasedWorkers(
    phasedOptions({
      state: {
        status() {
          return workerJob("abort-job", dir);
        },
        readyTurn() {
          assert.fail("timed out work is not SDK-ready");
        },
        finishLocal() {},
      },
      dir,
      durable() {},
      readResult() {
        return null;
      },
      workflowNonterminal() {
        return false;
      },
      responsePath(_dir, _job, name) {
        return path.join(dir, name);
      },
      onUnknown() {
        assert.fail("local analysis timeout is not an SDK turn");
      },
      onFault(error) {
        throw error;
      },
      async checkSdkRequest(_message, signal) {
        observedSignal = signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolveAborted();
              resolve();
            },
            { once: true },
          ),
        );
      },
    }),
  );
  const record: WorkerRecord = {
    job: workerJob("abort-job", dir),
    closed: Promise.resolve(),
    resolveClosed() {},
    token: "token",
    pending: null,
    localRemaining: 20,
    localStarted: performance.now(),
    timer: null,
    child: {
      kill() {
        workers.finish(record, 1, path.join(dir, "jobs", "abort-job"));
        return true;
      },
    } as import("node:child_process").ChildProcess,
  };
  workers.workers.set("abort-job", record);
  const pending = workers.enqueue({
    jobId: "abort-job",
    workerToken: "token",
    method: "callTool",
    args: [],
  });
  workers.resumeLocal(record);
  required(record.timer).ref();
  await abortSeen;
  assert(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, true);
  assert.equal(aborted, true);
  await assert.rejects(pending, { code: "WORKER_CLOSED" });
});

test("SDK host platform is explicit and bound to checker configuration, not inferred from Linux process", async () => {
  const artifact = preparePythonArtifact([
    {
      id: "host",
      filename: "host.py",
      role: "user",
      source: 'import ctypes\nctypes.WinDLL("kernel32")',
    },
  ]);
  const check = (pythonPlatform: "Linux" | "Windows") =>
    createPythonChecker({
      typingRoot: path.join(runtime, "typing"),
      pythonPlatform,
    }).check({ artifact, context: { kind: "raw" } });
  const linux = await check("Linux"),
    windows = await check("Windows");
  assert.ok(
    linux.diagnostics.some(
      (d) =>
        d.rule === "reportAttributeAccessIssue" && d.message.includes("WinDLL"),
    ),
  );
  assert.ok(
    !windows.diagnostics.some(
      (d) =>
        d.rule === "reportAttributeAccessIssue" && d.message.includes("WinDLL"),
    ),
  );
  assert.notEqual(linux.provenance.configHash, windows.provenance.configHash);
});

test("canonical broker document probe with receipt is fully checked without submitting its prepared call", async () => {
  const { prepareProbe } = load("../src/queue-instance") as ReturnType<
    typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
  >;
  const admission = createPythonRpcAdmission({
    runtime,
    checker: createPythonChecker({
      typingRoot: path.join(runtime, "typing"),
      definitionsRoot: path.join(runtime, "typing"),
      pythonPlatform: "Windows",
    }),
  });
  let checked: PythonRpcCertificate | undefined;
  const prepared = await prepareProbe(
    {
      server: { timeoutMs: 5000 },
      async callTool() {
        assert.fail("prepared probe must not send");
      },
      async prepareCallTool(args) {
        checked = await admission.check(official(args.object.script));
        return Object.assign(
          async () =>
            assert.fail("offline preparation must not execute the probe"),
          {
            fence: () => required(checked).fence(official(args.object.script)),
          },
        );
      },
    },
    {
      receiptPath: "/tmp/opencode/never-probe.json",
      binding: { jobId: "probe" },
      documentSelector: { creationId: "fixture" },
    },
  );
  assert.equal(required(required(checked).report).status, "passed");
  prepared.fence();
  assert.equal(fs.existsSync("/tmp/opencode/never-probe.json"), false);
});

test("broker-reserved job identity binds a receipt before acceptance without changing client idempotency", () => {
  const { QueueDomain } = load(
    "../src/dist/core",
  ) as typeof import("../packages/core/src");
  const queue = new QueueDomain({
    now: () => 1000,
    newId: () => assert.fail("job identity was already reserved"),
    hash: (value) => value,
  });
  const request = {
    requestId: "request",
    clientId: "client",
    kind: "rpc" as const,
    payload: raw("x: int = 1"),
    timeoutMs: 1000,
  };
  assert.equal(queue.submit(request, "prepared-job")["id"], "prepared-job");
  assert.equal(
    queue.submit(request, "unused-competing-reservation")["id"],
    "prepared-job",
  );
  assert.equal(required(queue.next()).id, "prepared-job");
  const before = JSON.stringify(queue.data);
  assert.throws(
    () => queue.submit({ ...request, requestId: "other" }, "prepared-job"),
    { code: "INVALID_PREPARED_ID" },
  );
  assert.equal(JSON.stringify(queue.data), before);
});

test("admission report cannot be rewritten after it authorizes final bytes", async () => {
  const certificate = await adapter().check(raw("x: int = 1"));
  assert.ok(Object.isFrozen(required(certificate.report)));
  assert.ok(Object.isFrozen(required(certificate.report).provenance));
  assert.throws(() => {
    (
      required(certificate.report).provenance as {
        -readonly [
          K in keyof PythonCheckReport["provenance"]
        ]: PythonCheckReport["provenance"][K];
      }
    ).wireHash = "foreign";
  }, TypeError);
});

test("caller mutation during checker await cannot authorize different RPC bytes or mutable source units", async () => {
  const original = preparePythonArtifact([
    { id: "user", filename: "user.py", source: "x: int = 1", role: "user" },
  ]);
  const mutable = structuredClone(original),
    payload = raw(original.script);
  const checked = adapter(async ({ artifact }) => {
    assert.ok(Object.isFrozen(artifact.units));
    Object.assign(
      mutable,
      preparePythonArtifact([
        { id: "user", filename: "user.py", source: "x: str = 1", role: "user" },
      ]),
    );
    assert.equal(artifact.script, original.script);
    return report(artifact);
  });
  const certificate = await checked.check(payload, mutable);
  required(certificate).fence(payload);
  assert.equal(required(certificate.artifact).sha256, original.sha256);
  const trace: string[] = [];
  await assert.rejects(
    dispatch(
      adapter(async ({ artifact }) => {
        payload.params.arguments.code = "x: str = 1";
        return report(artifact);
      }),
      payload,
      trace,
    ),
    { code: "PYTHON_ADMISSION_CHANGED" },
  );
  assert.deepEqual(trace, ["check"]);
});
