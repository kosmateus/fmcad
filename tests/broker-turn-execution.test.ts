import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createBrokerTurnExecution,
  type BrokerTurnServices,
} from "../src/broker-turn-execution";
import type * as P from "../src/queue-broker-ports";
import type { BrokerModules } from "../src/queue-broker-modules";
import {
  openBrokerRuntimeAuthority,
  type BrokerRuntimeIdentityReaders,
} from "../src/queue-runtime-authority";
import * as execution from "../packages/core/src/application/broker-execution";
import * as completion from "../packages/core/src/application/execution";
import { createBrokerSession } from "../packages/core/src/application/broker-session";
import {
  createBrokerRecovery,
  type RecoveryFence,
} from "../packages/core/src/application/broker-recovery";
import { QueueDomain, canonical } from "../packages/core/src/domain/queue";
import { quarantineTarget } from "../packages/core/src/domain/queue-quarantine";
import { QueueGate } from "../packages/node-adapters/src/execution/gate";
import { PauseBudget } from "../packages/node-adapters/src/execution/pause-budget";
import * as preparation from "../packages/node-adapters/src/execution/broker-preparation";
import * as brokerPhysical from "../packages/node-adapters/src/execution/broker-physical";
import { createBrokerRecords } from "../packages/node-adapters/src/persistence/broker-records";
import { durable } from "../packages/node-adapters/src/persistence/records";
import { responsePath as ownedResponsePath } from "../packages/node-adapters/src/persistence/owned-results";
import * as workerProcess from "../packages/node-adapters/src/execution/local-worker-process";
import { createBrokerRecoveryEvidence } from "../packages/node-adapters/src/execution/broker-recovery-evidence";
import * as publicResults from "../src/composition/queue-public-python-result";
import * as telemetry from "../packages/node-adapters/src/telemetry/broker-observer";
import * as normalAdmission from "../packages/node-adapters/src/broker-ipc/normal-admission";
import * as normalRestart from "../packages/node-adapters/src/broker-ipc/normal-restart";
import { decodeAdmissionJson } from "../packages/node-adapters/src/execution/admission-json";

const runtime = process.env["FMCAD_TEST_RUNTIME"] || process.cwd();
const load = createRequire(path.join(runtime, "src/queue-broker.js"));
const instance = load("./queue-instance") as BrokerModules["./queue-instance"];
const readJson = instance.readJson;
const responsePath = (
  directory: string,
  job: P.Job,
  name: string,
  write: boolean,
) =>
  ownedResponsePath(
    directory,
    {
      id: job.id,
      request: job.request.cwd === undefined ? {} : { cwd: job.request.cwd },
    },
    name,
    write,
  );
const helpers = load(
  "./queue-broker-modules",
) as typeof import("../src/queue-broker-modules");
const atomic = load(
  "./atomic-workflow-observation",
) as BrokerModules["./atomic-workflow-observation"];
const build = "a".repeat(64);

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(
      Date.now() < end,
      "Expected observable state before bounded test deadline",
    );
    await delay(2);
  }
}
function rpc(value: unknown): P.Rpc {
  assert.ok(
    value &&
      typeof value === "object" &&
      "method" in value &&
      typeof value.method === "string" &&
      "jsonrpc" in value &&
      value.jsonrpc === "2.0",
  );
  return value as P.Rpc;
}
function matching(
  client: Pick<P.Client, "_parse">,
  response: P.Response | undefined,
  outgoing: P.Rpc,
): P.Reply | null {
  assert.ok(response);
  if (response.status < 200 || response.status >= 300)
    throw Object.assign(new Error("Invalid HTTP response"), {
      code: "UNKNOWN_RPC",
    });
  if (!Object.hasOwn(outgoing, "id")) return null;
  const reply = client._parse(response.raw) as P.Reply;
  if (reply?.id !== outgoing.id || reply?.jsonrpc !== "2.0")
    throw Object.assign(new Error("Mismatched JSON-RPC reply"), {
      code: "UNKNOWN_RPC",
    });
  return reply;
}
const privateDirectory = (directory: string) => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
};

async function fixture(
  t: import("node:test").TestContext,
  initiallyReady = true,
) {
  const directory = fs.mkdtempSync("/tmp/opencode/product-turn-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  privateDirectory(path.join(directory, "jobs"));
  const owner: P.Owner = {
    pid: process.pid,
    birth: instance.processBirth(),
    nonce: randomUUID(),
    protocol: 2,
  };
  const observed: P.Instance = {
    pid: process.pid,
    birth: instance.processBirth(),
    version: "fixture",
    activeCommand: "SelectCommand",
    documents: [],
    documentState: {
      status: "complete",
      fingerprint: "fixture-fingerprint",
      state: { identity: { creationId: "fixture-document" } },
    },
  };
  durable(path.join(directory, "broker.lock"), owner, true);
  const backend: P.Config = {
    backend: "addin",
    url: "http://127.0.0.1:1/never-called",
    tool: "execute_python",
    timeoutMs: 2000,
    headers: {},
  };
  const events: string[] = [];
  const controls: {
    ready: boolean;
    build: string;
    beforeProbe?: (options: P.ProbeOptions) => void | Promise<void>;
    afterSend?: () => void;
    send?: (outgoing: P.Rpc) => Promise<P.Response>;
    resolverError?: unknown;
    launch?: typeof workerProcess.launchLocalWorker;
    receipt: "none" | "terminal" | "missing";
    receiptOutcome?: "succeeded" | "failed";
    native: boolean;
    nativeEnded: boolean;
    failIntent?: unknown;
    beforePrepare?: (jobId: string) => void | Promise<void>;
  } = {
    ready: initiallyReady,
    build,
    receipt: "none",
    native: false,
    nativeEnded: false,
  };
  const state = new QueueDomain({
    recover: false,
    now: Date.now,
    newId: randomUUID,
    hash: instance.hash,
    commit(snapshot) {
      durable(path.join(directory, "queue-state.json"), snapshot);
    },
  });
  const queue: BrokerTurnServices["queue"] = {
    get data() {
      return state.data as P.Snapshot;
    },
    epoch: null,
    status: (id) => state.status(id) as P.PublicJob,
    lookup: (id) => required(state.data.jobs[id]) as P.Job,
    summary: () => state.summary(),
    finish(id, details) {
      events.push("finish");
      return state.finish(id, details);
    },
    block: (id, reason) => state.block(id, reason),
    releaseTurn: (id, left) => state.releaseTurn(id, left),
    markDispatch(id, details, physical) {
      events.push(
        details?.["rpcState"] === "terminal"
          ? "terminal-accounting"
          : "dispatch-accounting",
      );
      return state.markDispatch(id, details, physical);
    },
    recordPhysicalDispatch: (id, physical) =>
      state.recordPhysicalDispatch(id, physical),
    assertDocumentMetadataRead: (...args) =>
      state.assertDocumentMetadataRead(...args),
  };
  const session = createBrokerSession<P.LaneContext>();
  const lane = helpers.createBrokerLane(session, {
    durableHoldReason: () => state.data.blocked?.reason,
    wakeup() {
      events.push("wakeup");
    },
  });
  const gate = new QueueGate(state, owner.nonce);
  const actualRecords = createBrokerRecords(directory);
  const records: BrokerTurnServices["records"] = {
    ...actualRecords,
    createRpcIntent(id, record) {
      events.push("rpc-intent");
      if (controls.failIntent) throw controls.failIntent;
      return actualRecords.createRpcIntent(id, record);
    },
    recordReceivedResponse(...args) {
      events.push("received-response");
      actualRecords.recordReceivedResponse(...args);
    },
    recordRpcTerminal(...args) {
      events.push("rpc-terminal");
      actualRecords.recordRpcTerminal(...args);
    },
  };
  const readers: BrokerRuntimeIdentityReaders = {
    instance: { ...instance, buildHash: () => controls.build },
    backend: load("./queue-backend-transition"),
    epochs: load("./queue-isolated-epoch"),
    lineage: load("./queue-epoch-lineage"),
    normalAdmission,
    normalRestart,
    atomicObservation: atomic,
    hasRuntimeRootEvidence: (
      load(
        "./dist/node-adapters/execution/physical-generation-profile",
      ) as typeof import("../packages/node-adapters/src/execution/physical-generation-profile")
    ).hasRuntimeRootEvidence,
  };
  const authority = await openBrokerRuntimeAuthority(
    {
      directory,
      buildHash: build,
      configHash: instance.brokerConfigHash(backend),
      observationScope: atomic.fastenersScope,
    },
    readers,
  );
  authority.bindQueue(
    {
      epoch: () => null,
      admissionMode: () => "isolated-one-anchor",
      current: () => state.data as P.Snapshot,
      writerStatus: () => state.writerStatus(),
      assertEpoch() {
        assert.fail("No legacy epoch in fixture");
      },
      advanceInstanceEpoch: (id) => state.advanceInstanceEpoch(id),
    },
    { owner },
  );
  const budgets = new Set<PauseBudget>();
  class Budget extends PauseBudget {
    constructor(ms: number, expired: () => void) {
      super(ms, expired);
      budgets.add(this);
    }
  }
  const budgetFacade: BrokerModules["./pause-budget"]["PauseBudget"] = Budget;
  t.after(() => {
    for (const budget of budgets) budget.close();
  });
  let pendingMessage: P.WorkerMessage | null = null;
  const phaseToken = randomUUID();
  const adapted: unknown[] = [];
  const rejected: unknown[] = [];
  let entrypoint = path.join(directory, "worker.cjs");
  let resolverCalls = 0,
    launches = 0,
    sends = 0;
  const client: P.Client = {
    server: backend,
    _parse: JSON.parse,
    _post: (...args) => executor.post(...args),
    _openSession: async () => "fixture-session",
    async callTool(args, name = "execute_python") {
      await executor.post({
        jsonrpc: "2.0",
        method: "tools/call",
        id: randomUUID(),
        params: { name, arguments: args },
      });
      return { text: "adapted-result", failed: false };
    },
    async listTools() {
      await executor.post({
        jsonrpc: "2.0",
        method: "tools/list",
        id: randomUUID(),
      });
      return [{ name: "fixture-tool" }];
    },
    async executeUiGuardedScript() {
      return { text: "fixture", failed: false };
    },
  };
  const nativeProof = (record: { binding: P.Binding }): P.NativeProof => ({
    ...record.binding,
    outcome: "succeeded",
    native: {
      kind: "fixture-native",
      identity: {
        commandId: "fmcad_atomic_" + "c".repeat(32),
        runId: "fixture-run",
        requestHash: "h",
        backend: "addin",
        sessionNonce: "nonce",
        documentIdentity: {
          expected: { creationId: "fixture-document" },
          resolved: { creationId: "fixture-document" },
        },
        resolvedIdentity: { creationId: "fixture-document" },
      },
      state: { status: controls.nativeEnded ? "completed" : "pending" },
    },
  });
  const nativeReceipts: BrokerTurnServices["nativeReceipts"] = {
    start: (record) => (controls.native ? nativeProof(record) : null),
    completion: (record) =>
      controls.native && controls.nativeEnded ? nativeProof(record) : null,
  };
  const readFence = (id: string): RecoveryFence | null => {
    const job = state.data.jobs[id];
    if (!job) return null;
    return {
      jobId: id,
      clientId: job.clientId,
      requestId: job.requestId,
      jobHash: job.hash,
      state: job.state,
      rpcCount: job.dispatch?.rpcCount || 0,
      brokerInstanceId: owner.nonce,
      instance: observed,
      buildHash: build,
      executableBuildHash: controls.build,
      epochId: null,
      receiptEpoch: undefined,
      revision: state.data.revision,
      generation: state.data.controlGeneration || 0,
      contextEpoch: state.data.contextEpoch || 0,
      activeJobId: state.data.active,
      blockedJobId: state.data.blocked?.id ?? null,
    };
  };
  const evaluator = createBrokerRecovery(
    createBrokerRecoveryEvidence(actualRecords.evidence, {
      readFence,
      workerContext() {
        const snapshot = executor?.snapshot();
        return snapshot?.pendingCount ||
          (snapshot?.hasWorkerProcess && !snapshot.workerClosed)
          ? "pending"
          : snapshot
            ? "closed"
            : "absent";
      },
      processBirth: instance.processBirth,
      workflowNonterminal: instance.workflowNonterminal,
      nativeReceipts,
      validateTerminalResponse(record) {
        const typed = record as P.RecordEvidence;
        matching(
          client,
          typed.response,
          required(typed.wireRequest ?? typed.request),
        );
      },
    }),
  );
  function late<Service>(value: Service): Service {
    if (!controls.ready)
      throw new Error("Late bootstrap service was dereferenced");
    return value;
  }
  const phased: BrokerTurnServices["worker"]["phased"] = {
    token: () => phaseToken,
    pending: () => (pendingMessage ? { message: pendingMessage } : null),
    resolve(_id, value) {
      adapted.push(value);
    },
    reject(_id, error) {
      rejected.push(error);
    },
  };
  const services: BrokerTurnServices = {
    configuration: {
      directory,
      buildHash: build,
      brokerNonce: owner.nonce,
      backend,
      maxIpcBytes: 1024 * 1024,
    },
    execution,
    completion,
    queue,
    lane,
    gate,
    authority,
    records,
    async prepareOwnedPost(payload, job) {
      await controls.beforePrepare?.(job.id);
      const outgoing = structuredClone(payload);
      const rpcId = randomUUID();
      if (Object.hasOwn(outgoing, "id")) outgoing.id = `fmcad:${rpcId}`;
      const exact = JSON.stringify(outgoing);
      const record: P.RecordEvidence = {
        binding: {
          jobId: job.id,
          rpcId,
          requestHash: instance.hash(JSON.stringify(payload)),
          buildHash: build,
        },
        request: {
          jsonrpc: "2.0",
          method: payload.method,
          ...(payload.id === undefined ? {} : { id: payload.id }),
        },
        wireRequest: {
          jsonrpc: "2.0",
          method: outgoing.method,
          ...(outgoing.id === undefined ? {} : { id: outgoing.id }),
        },
        instance: observed,
        method: payload.method,
        terminal: false,
      };
      if (controls.receipt !== "none")
        record.receipt = path.join(
          directory,
          "jobs",
          job.id,
          `remote-${rpcId}.json`,
        );
      return {
        outgoing,
        record,
        rpcId,
        contextEpoch: state.data.contextEpoch || 0,
        metadataOnly: payload.method !== "tools/call",
        pythonCertificate: {
          kind: "fixture-certificate",
          fence(wire) {
            if (JSON.stringify(wire) !== exact)
              throw Object.assign(new Error("Prepared bytes changed"), {
                code: "INPUT_CHANGED",
              });
          },
        },
      };
    },
    files: {
      ...instance,
      durable,
      readJson,
      privateDirectory,
      responsePath,
      buildHash: () => controls.build,
    },
    protocol: {
      ...publicResults,
      matching,
      rpcPayload: rpc,
      canonical,
      commandEntry: () => ({ kind: "product", target: "fixture" }),
    },
    transport: {
      client,
      physicalIsolation: false,
      pinPhysicalTurn: helpers.pinPhysicalTurn,
      brokerPhysical,
      metadata: helpers,
      decodeAdmissionJson,
      async originalPost(outgoing) {
        sends++;
        events.push("send");
        const jobId = required(executor.snapshot()).jobId;
        const records = actualRecords.evidence.readRpcRecords(jobId);
        assert.equal(
          state.data.jobs[jobId]?.dispatch?.rpcCount,
          records.length,
        );
        assert.ok(
          records.some((record) => record.wireRequest?.id === outgoing.id),
        );
        const record = records.find(
          (record) => record.wireRequest?.id === outgoing.id,
        );
        if (record?.receipt && controls.receipt === "terminal")
          durable(
            record.receipt,
            {
              ...record.binding,
              terminal: true,
              outcome: controls.receiptOutcome ?? "succeeded",
              instance: observed,
            },
            true,
          );
        const result = controls.send
          ? await controls.send(outgoing)
          : {
              status: 200,
              raw: JSON.stringify({
                jsonrpc: "2.0",
                id: outgoing.id,
                result:
                  outgoing.method === "tools/list"
                    ? { tools: [] }
                    : { content: [{ type: "text", text: "done" }] },
              }),
            };
        controls.afterSend?.();
        return result;
      },
      observe: async (options) =>
        gate.run(() =>
          executor.sendProbe(async () => {
            const stage = path
              .basename(options.diagnosticPath ?? "")
              .startsWith("postflight")
              ? "postflight"
              : "preflight";
            events.push(stage);
            await controls.beforeProbe?.(options);
            await options.onObservation?.(observed);
            return observed;
          }),
        ),
    },
    guards: {
      resetSubmissionOpen() {},
      admitEpochRequest() {},
      assertPhysicalIsolationAuthority() {},
      assertFrozenMetadataObservation() {},
    },
    documents: {
      ...(load("./queue-document") as BrokerModules["./queue-document"]),
      quarantineTarget,
      currentCheckpointGeneration: () => "fixture-generation",
      checkpointGeneration: () => "fixture-generation",
      requiresPhysicalStageOwner: () => false,
      constrainedCadProgram: () => ({ operation: "fixture", script: "pass" }),
      get continuation() {
        return late({
          expectedProduct: () => ({ operation: "fixture", script: "pass" }),
          forget() {},
        });
      },
    },
    worker: {
      get phased() {
        return late(phased);
      },
      Budget: budgetFacade,
      resolveEntrypoint() {
        resolverCalls++;
        if (controls.resolverError) throw controls.resolverError;
        return entrypoint;
      },
      launch(...args) {
        launches++;
        return controls.launch
          ? controls.launch(...args)
          : workerProcess.launchLocalWorker(...args);
      },
    },
    nativeReceipts,
    recovery: {
      readFence,
      get evaluator() {
        return late(evaluator);
      },
    },
    preparation,
    telemetry: {
      ...telemetry,
      get observer() {
        return late({ accept() {} });
      },
      changed() {},
    },
  };
  const executor = createBrokerTurnExecution(services);
  // This is the pre-initialize staged bootstrap: no continuation/phased/IPC/recovery yet.
  await authority.identifyStartup(
    {
      binding: {
        brokerNonce: owner.nonce,
        ownerPid: owner.pid,
        ownerBirth: owner.birth,
        buildHash: build,
        stage: "startup",
      },
      receiptPath: path.join(
        directory,
        `broker-startup-${owner.nonce}.receipt.json`,
      ),
      diagnosticPath: path.join(
        directory,
        `broker-startup-${owner.nonce}.result.json`,
      ),
    },
    () => executor.sendProbe(async () => observed),
  );
  function submit(request: Partial<P.Request> = {}) {
    const value = state.submit({
      kind: "rpc",
      clientId: "fixture-client",
      requestId: randomUUID(),
      timeoutMs: 2000,
      cwd: directory,
      backend: "addin",
      buildHash: build,
      payload: { jsonrpc: "2.0", method: "tools/list", id: "caller-id" },
      ...request,
    });
    const id = value["id"];
    assert.ok(typeof id === "string");
    return id;
  }
  async function raw(id = submit()) {
    const job = required(queue.lookup(id));
    const turn = execution.createTurnIdentity(id);
    executor.retainPlan(id, {
      kind: "raw",
      turn: await executor.prepare(rpc(job.request.payload), job, turn),
      callerPayloadHash: instance.hash(canonical(job.request.payload)),
      flights: null,
    });
    const picked = state.next() as P.Job | null;
    assert.ok(picked);
    const grant = lane.begin(picked, turn, false);
    return { id, job: picked, grant };
  }
  async function phase(
    id = submit({ kind: "command", phased: true, argv: ["cad"] }),
  ) {
    const job = required(queue.lookup(id));
    const turn = execution.createTurnIdentity(id);
    const payload: P.Rpc = {
      jsonrpc: "2.0",
      method: "tools/call",
      id: randomUUID(),
      params: {
        name: "execute_python",
        arguments: { code: "pass", persistent: false },
      },
    };
    const prepared = await executor.prepare(payload, job, turn);
    const message: P.WorkerMessage = {
      jobId: id,
      workerToken: phaseToken,
      method: "callTool",
      args: [{ code: "pass", persistent: false }],
      rpcTimeoutMs: 1000,
    };
    pendingMessage = message;
    const send = Object.assign(
      async () => {
        await executor.post(payload, undefined, undefined, {
          kind: "owned",
          turn: prepared,
        });
        return { text: "adapted-result", failed: false };
      },
      {
        fence() {
          prepared.inspect((ready) =>
            (ready.metadataProof ?? ready.pythonCertificate).fence(
              ready.outgoing,
            ),
          );
        },
      },
    );
    executor.retainPlan(id, {
      kind: "worker",
      turn,
      message,
      send,
      flights: null,
    });
    state.readyTurn(id);
    const picked = state.next() as P.Job | null;
    assert.ok(picked);
    return {
      id,
      job: picked,
      grant: lane.begin(picked, turn, false),
      message,
      prepared,
    };
  }
  return {
    directory,
    observed,
    owner,
    state,
    queue,
    lane,
    gate,
    executor,
    services,
    controls,
    events,
    records: actualRecords,
    raw,
    phase,
    submit,
    adapted,
    rejected,
    counts: () => ({ resolverCalls, launches, sends }),
    entrypoint: (file: string) => {
      entrypoint = file;
    },
  };
}
function required<Value>(value: Value | null | undefined): Value {
  assert.ok(value !== undefined && value !== null);
  return value;
}

test("raw product owns intent/accounting/send/retained reply/postflight and restores caller id", async (t) => {
  const f = await fixture(t);
  const turn = await f.raw();
  await f.executor.run(turn.job, turn.grant);
  assert.equal(f.state.data.jobs[turn.id]?.state, "succeeded");
  assert.equal(f.counts().sends, 1);
  for (const [left, right] of [
    ["rpc-intent", "dispatch-accounting"],
    ["dispatch-accounting", "send"],
    ["send", "received-response"],
    ["received-response", "rpc-terminal"],
    ["rpc-terminal", "postflight"],
    ["postflight", "finish"],
  ])
    assert.ok(
      f.events.indexOf(required(left)) < f.events.indexOf(required(right)),
      `${left} before ${right}`,
    );
  const returned = readJson<P.Response>(
    responsePath(f.directory, turn.job, "rpc-result.json", false),
  );
  assert.equal((JSON.parse(returned.raw) as P.Reply).id, "caller-id");
  assert.equal(f.executor.snapshot(turn.grant), null);
  await assert.rejects(f.executor.run(turn.job, turn.grant), {
    code: "RECONCILIATION_REQUIRED",
  });
});

test("construction and broker probes defer late services; raw calls never resolve a worker entrypoint", async (t) => {
  const f = await fixture(t, false);
  await f.executor.checkInstance({ requireIdle: true });
  assert.equal(f.counts().resolverCalls, 0);
  f.controls.ready = true;
  const turn = await f.raw();
  await f.executor.run(turn.job, turn.grant);
  assert.equal(f.counts().resolverCalls, 0);
  assert.equal(f.counts().launches, 0);
});

test("a scoped broker read is not a product capability", async (t) => {
  const f = await fixture(t, false);
  await f.executor.runProbeScope(
    { assertCurrent() {}, start() {} },
    async () => {
      await assert.rejects(
        f.executor.post({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        { code: "PREPARED_RPC_UNAVAILABLE" },
      );
    },
  );
  assert.equal(f.counts().sends, 0);
});

test("missing worker entrypoint and local intent/open/close failure reject at the original worker boundary", async (t) => {
  for (const code of [
    "ENTRYPOINT_MISSING",
    "INTENT_FAILED",
    "OPEN_FAILED",
    "CLOSE_FAILED",
  ]) {
    const f = await fixture(t);
    const error = Object.assign(new Error(code), { code });
    if (code === "ENTRYPOINT_MISSING") f.controls.resolverError = error;
    else
      f.controls.launch = () => ({
        terminateOwnProcess() {},
        snapshot: () => ({ pid: null, birth: null, running: false }),
        completion: Promise.reject(error),
      });
    const id = f.submit({ kind: "command", argv: ["cad"] });
    const job = f.state.next() as P.Job | null;
    assert.ok(job);
    const grant = f.lane.begin(job, execution.createTurnIdentity(id), false);
    await assert.rejects(
      f.executor.run(job, grant),
      (actual) => actual === error,
    );
    assert.equal(f.counts().resolverCalls, 1);
    assert.equal(f.counts().launches, code === "ENTRYPOINT_MISSING" ? 0 : 1);
    assert.equal(f.events.includes("postflight"), false);
    assert.equal(f.state.data.jobs[id]?.state, "running");
    f.lane.hold(grant, "scheduler observes the original rejection", () => {
      f.state.block(id, "scheduler observes the original rejection");
    });
    const held = required(f.executor.heldSnapshot());
    assert.equal(held.jobId, id);
    assert.equal(held.hasWorkerProcess, code !== "ENTRYPOINT_MISSING");
    assert.equal(held.workerClosed, code !== "ENTRYPOINT_MISSING");
  }
});

test("returned HTTP without the original receipt is retained UNKNOWN, never postflight or replay", async (t) => {
  const f = await fixture(t);
  f.controls.receipt = "missing";
  const turn = await f.raw(
    f.submit({
      payload: {
        jsonrpc: "2.0",
        id: "original",
        method: "tools/call",
        params: {
          name: "execute_python",
          arguments: { code: "pass", persistent: false },
        },
      },
    }),
  );
  await f.executor.run(turn.job, turn.grant);
  assert.equal(f.state.data.jobs[turn.id]?.state, "needs_reconciliation");
  assert.equal(f.counts().sends, 1);
  assert.equal(f.events.includes("postflight"), false);
  const record = required(f.records.evidence.readRpcRecords(turn.id)[0]);
  assert.equal(record.terminal, false);
  assert.ok(
    f.records.evidence.readReceivedResponse(turn.id, record.binding.rpcId),
  );
  assert.equal(f.state.data.jobs[turn.id]?.dispatch?.completedCount, 0);
  await assert.rejects(f.executor.run(turn.job, turn.grant));
  assert.equal(f.counts().sends, 1);
});

test("a mismatched wire reply is preserved before matching fails and holds the exact grant", async (t) => {
  const f = await fixture(t);
  f.controls.send = async () => ({
    status: 200,
    raw: JSON.stringify({
      jsonrpc: "2.0",
      id: "foreign",
      result: { tools: [] },
    }),
  });
  const turn = await f.raw();
  await f.executor.run(turn.job, turn.grant);
  assert.equal(f.state.data.jobs[turn.id]?.state, "needs_reconciliation");
  const record = required(f.records.evidence.readRpcRecords(turn.id)[0]);
  const retained = f.records.evidence.readReceivedResponse(
    turn.id,
    record.binding.rpcId,
  );
  assert.ok(retained);
  assert.match(retained.response.raw, /foreign/);
  assert.equal(f.events.includes("postflight"), false);
});

test("a durable intent refusal occurs before SDK send and retains the original error code", async (t) => {
  const f = await fixture(t);
  f.controls.failIntent = Object.assign(new Error("No intent store"), {
    code: "EIO",
    causeCode: "EPERM",
  });
  const turn = await f.raw();
  await f.executor.run(turn.job, turn.grant);
  assert.equal(f.counts().sends, 0);
  const failures = fs
    .readdirSync(path.join(f.directory, "jobs", turn.id))
    .filter((name) => name.startsWith("dispatch-failure-"));
  assert.equal(failures.length, 1);
  const failure = readJson<Record<string, unknown>>(
    path.join(f.directory, "jobs", turn.id, required(failures[0])),
  );
  assert.equal(failure["submitted"], false);
  assert.equal(failure["phase"], "fence");
  assert.equal(failure["code"], "EIO");
  assert.equal(failure["causeCode"], "EPERM");
});

test("the actual local worker publishes its own result; process exit alone is not a product dispatch", async (t) => {
  const f = await fixture(t);
  const entrypoint = path.join(f.directory, "owned-worker.cjs");
  fs.writeFileSync(
    entrypoint,
    [
      "const fs = require('node:fs'), path = require('node:path');",
      "const intent = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));",
      "const file = path.join(process.env.FMCAD_QUEUE_DIR, 'jobs', intent.id, 'worker-result.json');",
      "fs.writeFileSync(file, JSON.stringify({jobId:intent.id,terminal:true,code:0}));",
    ].join("\n"),
  );
  f.entrypoint(entrypoint);
  const id = f.submit({ kind: "command", argv: ["cad"] });
  const job = f.state.next() as P.Job | null;
  assert.ok(job);
  const grant = f.lane.begin(job, execution.createTurnIdentity(id), false);
  await f.executor.run(job, grant);
  assert.equal(f.counts().resolverCalls, 1);
  assert.equal(f.counts().launches, 1);
  assert.equal(f.counts().sends, 0);
  assert.equal(f.state.data.jobs[id]?.state, "succeeded");
  assert.equal(f.state.data.jobs[id]?.details?.["mayHaveMutated"], false);
  assert.equal(f.records.evidence.readWorkerResult(id)?.terminal, true);
  assert.equal(f.events.includes("postflight"), true);
});

test("worker capability and pending RPC remain private; concurrent and foreign worker calls are refused", async (t) => {
  const f = await fixture(t);
  const local = deferred<workerProcess.LocalWorkerCompletion>();
  const arrived = deferred<P.Rpc>();
  const response = deferred<P.Response>();
  let capability: { jobId: string; token: string } | undefined;
  f.controls.launch = (input) => {
    capability = input.capability;
    return {
      completion: local.promise,
      terminateOwnProcess() {},
      snapshot: () => ({
        pid: process.pid,
        birth: instance.processBirth(),
        running: true,
      }),
    };
  };
  f.controls.send = (payload) => {
    arrived.resolve(payload);
    return response.promise;
  };
  const id = f.submit({ kind: "command", argv: ["cad"] });
  const job = f.state.next() as P.Job | null;
  assert.ok(job);
  const grant = f.lane.begin(job, execution.createTurnIdentity(id), false);
  const running = f.executor.run(job, grant);
  await until(() => capability !== undefined);
  const message: P.WorkerMessage = {
    jobId: id,
    workerToken: required(capability).token,
    method: "listTools",
    args: [],
    rpcTimeoutMs: 1000,
  };
  const operation = f.executor.backend(message);
  const payload = await arrived.promise;
  const snapshot = required(f.executor.snapshot());
  assert.equal(snapshot.hasWorkerProcess, true);
  assert.equal(snapshot.workerClosed, false);
  assert.equal(snapshot.pendingCount, 1);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.job), true);
  assert.equal("token" in snapshot, false);
  assert.equal("pending" in snapshot, false);
  assert.equal("workerProcess" in snapshot, false);
  assert.ok(f.executor.workerStatus(message));
  assert.equal(
    f.executor.workerStatus({ ...message, workerToken: "foreign" }),
    null,
  );
  await assert.rejects(f.executor.backend(message), { code: "WORKER_BUSY" });
  await assert.rejects(
    f.executor.backend({ ...message, workerToken: "foreign" }),
    { code: "INVALID_CAPABILITY" },
  );
  response.resolve({
    status: 200,
    raw: JSON.stringify({
      jsonrpc: "2.0",
      id: payload.id,
      result: { tools: [] },
    }),
  });
  await operation;
  durable(path.join(f.directory, "jobs", id, "worker-result.json"), {
    jobId: id,
    terminal: true,
    code: 0,
  });
  local.resolve({ exitCode: 0, publicationFailed: false });
  await running;
  assert.equal(f.state.data.jobs[id]?.state, "succeeded");
  assert.equal(f.counts().sends, 1);
});

test("pause freezes the active budget and resume still rejects the stale prepared context", async (t) => {
  const f = await fixture(t);
  let paused = false;
  f.controls.beforeProbe = () => {
    if (!paused) {
      paused = true;
      f.state.pause(true, "fixture-pause");
    }
  };
  const turn = await f.raw(f.submit({ timeoutMs: 80 }));
  const running = f.executor.run(turn.job, turn.grant);
  await until(() => f.executor.snapshot()?.waitingForPause === true);
  await delay(140);
  assert.equal(f.executor.snapshot()?.timedOut, false);
  assert.equal(f.counts().sends, 0);
  await f.gate.control(false, { requestId: "fixture-resume" });
  await running;
  assert.equal(f.counts().sends, 0);
  assert.equal(f.state.data.jobs[turn.id]?.state, "failed");
  const name = required(
    fs
      .readdirSync(path.join(f.directory, "jobs", turn.id))
      .find((file) => file.startsWith("dispatch-failure-")),
  );
  const failure = readJson<Record<string, unknown>>(
    path.join(f.directory, "jobs", turn.id, name),
  );
  assert.equal(failure["code"], "DOCUMENT_CHANGED");
  assert.equal(failure["submitted"], false);
});

test("final input fence catches changes after preflight without sending a prepared product", async (t) => {
  const f = await fixture(t);
  const input = path.join(f.directory, "input.txt");
  fs.writeFileSync(input, "original");
  const turn = await f.raw(
    f.submit({
      inputFiles: [{ path: input, sha256: instance.hash("original") }],
    }),
  );
  f.controls.beforeProbe = () => fs.writeFileSync(input, "changed");
  await f.executor.run(turn.job, turn.grant);
  assert.equal(f.counts().sends, 0);
  const name = required(
    fs
      .readdirSync(path.join(f.directory, "jobs", turn.id))
      .find((file) => file.startsWith("dispatch-failure-")),
  );
  assert.equal(
    readJson<Record<string, unknown>>(
      path.join(f.directory, "jobs", turn.id, name),
    )["code"],
    "INPUT_CHANGED",
  );
});

test("a known completed original response survives a local build change before postflight", async (t) => {
  const f = await fixture(t);
  f.controls.afterSend = () => {
    f.controls.build = "b".repeat(64);
  };
  const turn = await f.raw();
  await f.executor.run(turn.job, turn.grant);
  assert.equal(f.counts().sends, 1);
  assert.equal(f.events.includes("postflight"), false);
  const details = f.state.data.jobs[turn.id]?.details;
  assert.equal(f.state.data.jobs[turn.id]?.state, "failed");
  assert.equal(details?.["code"], "SDK_COMPLETE_BUILD_CHANGED");
  assert.equal(details?.["sdkSettled"], true);
  assert.equal(details?.["postflightSubmitted"], false);
  assert.equal(details?.["modelValidated"], false);
  assert.ok(f.records.evidence.readRpcRecords(turn.id)[0]?.terminal);
});

test("timeout holds pending original work; a late HTTP response does not release it or cause replay", async (t) => {
  const f = await fixture(t);
  const started = deferred<P.Rpc>();
  const response = deferred<P.Response>();
  f.controls.send = (payload) => {
    started.resolve(payload);
    return response.promise;
  };
  const turn = await f.raw(f.submit({ timeoutMs: 60 }));
  const running = f.executor.run(turn.job, turn.grant);
  const payload = await started.promise;
  await running;
  assert.equal(f.state.data.jobs[turn.id]?.state, "needs_reconciliation");
  assert.equal(f.executor.snapshot()?.pendingCount, 1);
  assert.equal(f.executor.snapshot()?.timedOut, true);
  assert.equal(f.events.includes("postflight"), false);
  response.resolve({
    status: 200,
    raw: JSON.stringify({
      jsonrpc: "2.0",
      id: payload.id,
      result: { tools: [] },
    }),
  });
  await until(() => f.executor.snapshot()?.pendingCount === 0);
  assert.equal(f.state.data.jobs[turn.id]?.state, "needs_reconciliation");
  assert.equal(f.counts().sends, 1);
  assert.equal(f.executor.snapshot()?.unknown, true);
  await assert.rejects(f.executor.run(turn.job, turn.grant));
  assert.equal(f.counts().sends, 1);
});

test("RPC deadline is bounded independently of the phased job budget and never proves SDK termination", async (t) => {
  const f = await fixture(t);
  const started = deferred<P.Rpc>();
  const response = deferred<P.Response>();
  f.controls.send = (payload) => {
    started.resolve(payload);
    return response.promise;
  };
  const turn = await f.phase();
  turn.message.rpcTimeoutMs = 40;
  const running = f.executor.run(turn.job, turn.grant);
  const payload = await started.promise;
  await running;
  assert.equal(f.state.data.jobs[turn.id]?.state, "needs_reconciliation");
  assert.equal(f.executor.snapshot()?.pendingCount, 1);
  assert.equal(f.executor.snapshot()?.timedOut, true);
  assert.equal(f.events.includes("postflight"), false);
  response.resolve({
    status: 200,
    raw: JSON.stringify({
      jsonrpc: "2.0",
      id: payload.id,
      result: { content: [{ type: "text", text: "late" }] },
    }),
  });
  await until(() => f.executor.snapshot()?.pendingCount === 0);
  assert.equal(f.state.data.jobs[turn.id]?.state, "needs_reconciliation");
  assert.equal(f.counts().sends, 1);
});

test("physical catalog intent and domain accounting precede the one bound physical send", async (t) => {
  const f = await fixture(t);
  f.services.transport.physicalIsolation = true;
  f.services.transport.bindPhysicalTurn = (request) => ({
    version: 1,
    grantDigest: "c".repeat(64),
    turnId: request.physicalRequestId,
    generation: { instance: "fixture-instance", epoch: "fixture-epoch" },
    physicalRuntime: {
      pid: f.observed.pid,
      birth: f.observed.birth,
      version: f.observed.version,
      source: "fixture-source",
      build,
    },
    target: JSON.stringify(request.documentSelector ?? null),
  });
  let boundCalls = 0;
  f.services.transport.withPhysicalTurn = async (binding, send) => {
    boundCalls++;
    const snapshot = required(f.executor.snapshot());
    const dispatch = required(
      f.state.data.jobs[snapshot.jobId]?.physicalDispatches?.[0],
    );
    assert.equal(dispatch.physical.turnId, binding.turnId);
    assert.ok(
      fs.existsSync(
        path.join(
          f.directory,
          "jobs",
          snapshot.jobId,
          dispatch.intentReference,
        ),
      ),
    );
    return send();
  };
  const turn = await f.raw();
  await f.executor.run(turn.job, turn.grant);
  assert.equal(boundCalls, 1);
  assert.equal(f.counts().sends, 1);
  assert.equal(f.state.data.jobs[turn.id]?.state, "succeeded");
});

test("late native cleanup cannot close a new exact grant's activity for the same phased job", async (t) => {
  const f = await fixture(t);
  f.controls.receipt = "terminal";
  f.controls.native = true;
  const first = await f.phase();
  const firstRun = f.executor.run(first.job, first.grant);
  await until(() => !!f.executor.snapshot()?.nativeActivityId);
  const originalActivityId = required(f.executor.snapshot()?.nativeActivityId);
  const before = required(f.executor.snapshot(first.grant));
  f.controls.nativeEnded = true;
  await firstRun;
  assert.equal(f.state.data.jobs[first.id]?.state, "processing");
  assert.equal(f.gate.activeCount, 0);
  f.controls.nativeEnded = false;
  const second = await f.phase(first.id);
  const secondRun = f.executor.run(second.job, second.grant);
  await until(() => !!f.executor.snapshot()?.nativeActivityId);
  const nextActivityId = required(f.executor.snapshot()?.nativeActivityId);
  assert.notEqual(nextActivityId, originalActivityId);
  assert.equal(
    f.executor.endNativeActivity(first.id, originalActivityId),
    false,
  );
  assert.equal(f.executor.snapshot()?.nativeActivityId, nextActivityId);
  assert.equal(
    before.nativeActivityId,
    originalActivityId,
    "Diagnostic snapshot stays detached",
  );
  f.controls.nativeEnded = true;
  await secondRun;
  assert.equal(f.gate.activeCount, 0);
  assert.equal(f.state.data.jobs[first.id]?.state, "processing");
  assert.equal(f.counts().sends, 2);
});

test("stale plan cleanup and a second run cannot steal another logical turn", async (t) => {
  const f = await fixture(t);
  const turn = await f.raw();
  const original = execution.createTurnIdentity(turn.id);
  assert.equal(f.executor.discardUnsubmitted(turn.id, original), false);
  const blocked = deferred<void>();
  f.controls.beforeProbe = () => blocked.promise;
  const running = f.executor.run(turn.job, turn.grant);
  await until(() => f.events.includes("preflight"));
  await assert.rejects(f.executor.run(turn.job, turn.grant), {
    code: "PREPARED_RPC_CONSUMED",
  });
  blocked.resolve();
  await running;
  assert.equal(f.counts().sends, 1);
  assert.equal(f.state.data.jobs[turn.id]?.state, "succeeded");
});

test("independent preparations overlap while the actual session permits only one physical turn", async (t) => {
  const f = await fixture(t);
  const preparationGate = deferred<void>();
  let preparing = 0,
    maxPreparing = 0;
  f.controls.beforePrepare = async () => {
    preparing++;
    maxPreparing = Math.max(maxPreparing, preparing);
    await preparationGate.promise;
    preparing--;
  };
  const firstId = f.submit(),
    secondId = f.submit();
  const firstTurn = execution.createTurnIdentity(firstId),
    secondTurn = execution.createTurnIdentity(secondId);
  const prepare = async (id: string, turn: execution.TurnIdentity) => {
    const job = f.queue.lookup(id);
    const payload = rpc(job.request.payload);
    const prepared = await f.executor.prepare(payload, job, turn);
    f.executor.retainPlan(id, {
      kind: "raw",
      turn: prepared,
      flights: null,
      callerPayloadHash: instance.hash(canonical(payload)),
    });
  };
  const preparingFirst = prepare(firstId, firstTurn);
  const preparingSecond = prepare(secondId, secondTurn);
  await until(() => preparing === 2);
  assert.equal(f.counts().sends, 0);
  preparationGate.resolve();
  await Promise.all([preparingFirst, preparingSecond]);
  assert.equal(maxPreparing, 2);
  const sendGate = deferred<void>(),
    sent = deferred<void>();
  let active = 0,
    maxActive = 0;
  f.controls.send = async (payload) => {
    active++;
    maxActive = Math.max(maxActive, active);
    if (f.counts().sends === 1) {
      sent.resolve();
      await sendGate.promise;
    }
    active--;
    return {
      status: 200,
      raw: JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: { tools: [] },
      }),
    };
  };
  const first = f.state.next() as P.Job | null;
  assert.equal(first?.id, firstId);
  assert.ok(first);
  const firstGrant = f.lane.begin(first, firstTurn, false);
  const running = f.executor.run(first, firstGrant);
  await sent.promise;
  assert.equal(f.state.next(), null);
  assert.throws(
    () => f.lane.begin(f.queue.lookup(secondId), secondTurn, false),
    { code: "BROKER_SESSION_BUSY" },
  );
  sendGate.resolve();
  await running;
  const second = f.state.next() as P.Job | null;
  assert.equal(second?.id, secondId);
  assert.ok(second);
  await f.executor.run(second, f.lane.begin(second, secondTurn, false));
  assert.equal(maxActive, 1);
  assert.equal(f.counts().sends, 2);
});

test("caller-result publication failure does not turn a bound completed RPC into SDK UNKNOWN", async (t) => {
  const f = await fixture(t);
  f.services.files.durable = (file, value, fresh) => {
    if (path.basename(file) === "rpc-result.json")
      throw Object.assign(new Error("Result store unavailable"), {
        code: "EIO",
      });
    return durable(file, value, fresh);
  };
  const turn = await f.raw();
  await f.executor.run(turn.job, turn.grant);
  const job = required(f.state.data.jobs[turn.id]);
  assert.equal(job.state, "failed");
  assert.equal(job.details?.["code"], "OUTPUT_PUBLICATION_FAILED");
  assert.equal(job.details?.["sdkSettled"], true);
  assert.equal(job.details?.["publicationOutcome"], "failed");
  assert.equal(f.state.data.blocked, null);
  assert.equal(f.counts().sends, 1);
  assert.ok(f.records.evidence.readRpcRecords(turn.id)[0]?.terminal);
});

test("worker exit after dispatch without its durable result retains the turn despite terminal HTTP", async (t) => {
  const f = await fixture(t);
  const local = deferred<workerProcess.LocalWorkerCompletion>();
  let capability: { jobId: string; token: string } | undefined;
  f.controls.launch = (input) => {
    capability = input.capability;
    return {
      completion: local.promise,
      terminateOwnProcess() {},
      snapshot: () => ({ pid: null, birth: null, running: true }),
    };
  };
  const id = f.submit({ kind: "command", argv: ["cad"] });
  const job = f.state.next() as P.Job | null;
  assert.ok(job);
  const grant = f.lane.begin(job, execution.createTurnIdentity(id), false);
  const running = f.executor.run(job, grant);
  await until(() => capability !== undefined);
  await f.executor.backend({
    jobId: id,
    workerToken: required(capability).token,
    method: "listTools",
    args: [],
    rpcTimeoutMs: 1000,
  });
  local.resolve({ exitCode: 0, publicationFailed: false });
  await running;
  assert.equal(f.state.data.jobs[id]?.state, "needs_reconciliation");
  assert.equal(f.executor.snapshot()?.hasWorkerProcess, true);
  assert.equal(f.executor.snapshot()?.workerClosed, true);
  assert.equal(f.events.includes("postflight"), false);
  assert.equal(f.state.data.jobs[id]?.dispatch?.completedCount, 1);
  assert.equal(f.records.evidence.readWorkerResult(id), null);
});

test("an invalid adapted result after dispatch holds original work instead of trusting a synchronous reply", async (t) => {
  const f = await fixture(t);
  const local = deferred<workerProcess.LocalWorkerCompletion>();
  let capability: { jobId: string; token: string } | undefined;
  f.controls.launch = (input) => {
    capability = input.capability;
    return {
      completion: local.promise,
      terminateOwnProcess() {},
      snapshot: () => ({ pid: null, birth: null, running: true }),
    };
  };
  Reflect.set(f.services.transport.client, "listTools", async () => {
    await f.executor.post({
      jsonrpc: "2.0",
      id: "adapter",
      method: "tools/list",
    });
    return { malformed: true }; // An adversarial adapter's runtime value, not a typed contract cast.
  });
  const id = f.submit({ kind: "command", argv: ["cad"] });
  const job = f.state.next() as P.Job | null;
  assert.ok(job);
  const grant = f.lane.begin(job, execution.createTurnIdentity(id), false);
  const running = f.executor.run(job, grant);
  await until(() => capability !== undefined);
  await assert.rejects(
    f.executor.backend({
      jobId: id,
      workerToken: required(capability).token,
      method: "listTools",
      args: [],
      rpcTimeoutMs: 1000,
    }),
    { code: "MALFORMED_BACKEND_RESULT" },
  );
  local.resolve({ exitCode: 1, publicationFailed: false });
  await running;
  assert.equal(f.state.data.jobs[id]?.state, "needs_reconciliation");
  assert.equal(f.executor.snapshot()?.unknown, true);
  assert.equal(f.counts().sends, 1);
  assert.equal(f.events.includes("postflight"), false);
  assert.equal(f.records.evidence.readAdapterOutcome(id)?.unknown, true);
});

test("a bound failed remote receipt is a known failed execution, not HTTP success or UNKNOWN", async (t) => {
  const f = await fixture(t);
  f.controls.receipt = "terminal";
  f.controls.receiptOutcome = "failed";
  const turn = await f.raw(
    f.submit({
      payload: {
        jsonrpc: "2.0",
        id: "failed-script",
        method: "tools/call",
        params: {
          name: "execute_python",
          arguments: { code: "pass", persistent: false },
        },
      },
    }),
  );
  await f.executor.run(turn.job, turn.grant);
  const job = required(f.state.data.jobs[turn.id]);
  assert.equal(job.state, "failed");
  assert.equal(job.details?.["sdkSettled"], true);
  assert.equal(f.state.data.blocked, null);
  const record = required(f.records.evidence.readRpcRecords(turn.id)[0]);
  assert.equal(record.terminal, true);
  assert.equal(record.failed, true);
  assert.equal(record.remoteReceipt?.outcome, "failed");
  assert.equal(f.counts().sends, 1);
});

test("terminal record storage failure retains received bytes but cannot settle the original SDK turn", async (t) => {
  const f = await fixture(t);
  f.services.records.recordRpcTerminal = () => {
    throw Object.assign(new Error("Terminal storage fault"), { code: "EIO" });
  };
  const turn = await f.raw();
  await f.executor.run(turn.job, turn.grant);
  assert.equal(f.state.data.jobs[turn.id]?.state, "needs_reconciliation");
  const record = required(f.records.evidence.readRpcRecords(turn.id)[0]);
  assert.equal(record.terminal, false);
  assert.ok(
    f.records.evidence.readReceivedResponse(turn.id, record.binding.rpcId),
  );
  assert.equal(f.state.data.jobs[turn.id]?.dispatch?.completedCount, 0);
  assert.equal(f.counts().sends, 1);
  assert.equal(f.events.includes("postflight"), false);
});

test("a lost transport reply quarantines the original submitted turn without replay", async (t) => {
  const f = await fixture(t);
  f.controls.send = async () => {
    throw Object.assign(
      new Error("Connection closed after request submission"),
      {
        code: "ECONNRESET",
      },
    );
  };
  const turn = await f.raw();
  await f.executor.run(turn.job, turn.grant);
  assert.equal(f.state.data.jobs[turn.id]?.state, "needs_reconciliation");
  assert.equal(f.counts().sends, 1);
  assert.equal(f.events.includes("postflight"), false);
  const record = required(f.records.evidence.readRpcRecords(turn.id)[0]);
  assert.equal(record.terminal, false);
  assert.equal(
    f.records.evidence.readReceivedResponse(turn.id, record.binding.rpcId),
    null,
  );
  await assert.rejects(f.executor.run(turn.job, turn.grant));
  assert.equal(f.counts().sends, 1);
});
