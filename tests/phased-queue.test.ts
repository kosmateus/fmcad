"use strict";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import * as net from "node:net";
import { spawn, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import Module, { createRequire } from "node:module";
import { isolateRuntimeTestEnvironment } from "./runtime-test-environment.js";

type ClientAuth = { clientId: string; clientToken: string };
type QueueJob = {
  id: string;
  requestId: string;
  state: string;
  code?: string;
  kind?: string;
  clientId?: string;
  description?: string;
  mayHaveMutated?: boolean;
  physicalTurns?: number;
  sequenceId?: string | null;
  sequenceState?: string | null;
  contextRefreshRequired?: boolean;
  queueDeadline?: number | null;
  [key: string]: unknown;
};
type QueueResult = {
  id?: string;
  job: QueueJob;
  stdout: string;
  stderr: string;
  execution: {
    state?: string;
    code?: string;
    mayHaveMutated: boolean;
    sdkSettled: boolean;
  };
  rpc?: { raw: string };
};
type QueueReply = {
  id?: string;
  state?: string;
  job?: QueueJob;
  active?: string | null;
  blocked?: { id: string } | null;
  lease?: { clientId: string } | null;
  jobs?: Record<string, QueueJob>;
  buildHash?: string;
  revision?: number;
  generation?: number;
  instanceId?: string;
  features?: { conditionalIdleStop: boolean };
  control?: { activeOperations: number };
  [key: string]: unknown;
};
type SubmittedJob = { id: string; state: string; requestId?: string };
type ControlStatus = { instanceId: string; generation: number };
type BrokerStatus = {
  active: string | null;
  blocked: { id: string } | null;
  lease: { clientId: string } | null;
  jobs: Record<string, QueueJob>;
  stopping: boolean;
};
type ClientStatus = BrokerStatus & {
  buildHash: string;
  revision: number;
  features: { conditionalIdleStop: boolean };
  control: { activeOperations: number };
};
type QueueBroker = { close(): Promise<void>; status(): BrokerStatus };
type BrokerOptions = {
  preparationConcurrency?: number;
  autoReconcile?: boolean;
  typedPort?: boolean;
  checkPrepared?: (
    payload: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<void>;
};
type PhysicalRequest = {
  id: string | number | null;
  jsonrpc?: string;
  method?: string;
  params?: { name?: string; arguments?: ToolValue };
};
type PhysicalResult = { status: number; raw: string };
type ToolValue = {
  object?: { script?: string; [key: string]: unknown };
  [key: string]: unknown;
};
type ToolResult = { failed: boolean; text: string };
type NativeBinding = { binding: Record<string, unknown>; receipt: string };
type QueueStateFixture = {
  submit(job: Record<string, unknown>): QueueJob;
  next(): QueueJob | null;
  readyTurn(id: string): unknown;
  block(id: string, reason: string): void;
  releaseTurn(id: string, timeoutMs: number): void;
  status(id: string): QueueJob;
  cancel(id: string, clientId: string): void;
  release(sequenceId: string, clientId: string): void;
  finishLocal(id: string, details: Record<string, unknown>): void;
  pause(paused: boolean): void;
  blockLocal(id: string, reason: string): void;
  finish(id: string): void;
  summary(): {
    active: string | null;
    blocked: { id: string } | null;
    lease: { clientId: string } | null;
  };
};
type ReadyValue<T> = T | false | null | undefined;
type MutableModuleLoader = {
  _load(
    request: string,
    parent: { filename?: string } | null,
    ...args: unknown[]
  ): unknown;
};

const projectRoot = path.resolve(__dirname, "..", "..");
const runtimeRequire = createRequire(__filename);
const mutableModule = Module as unknown as MutableModuleLoader;
const loadModule = mutableModule._load;
mutableModule._load = function (request, parent, ...args) {
  const loaded = loadModule.call(this, request, parent, ...args);
  if (
    request === "./dist/config-platform" &&
    parent?.filename?.endsWith("/src/queue-instance.js")
  ) {
    return {
      ...(loaded as Record<string, unknown>),
      toWindowsPath: (file: string) => file,
    };
  }
  return loaded;
};
const { inputFiles } = runtimeRequire(
  path.join(projectRoot, "src/queue-client.js"),
);
const queueAdmission = runtimeRequire(
  path.join(projectRoot, "src/queue-admission.js"),
) as {
  createProductionQueueAdmission(runtime?: string): {
    admission: {
      check(
        payload: unknown,
        artifact?: unknown,
        options?: { signal?: AbortSignal },
      ): Promise<{ kind: string; fence(outgoing: unknown): void }>;
    };
    checkPrepared(prepared: unknown): Promise<unknown>;
    fencePrepared(prepared: unknown, buildHash: string): void;
    checkerFingerprint(): unknown;
  };
};
let fakeAdmissionCheck: BrokerOptions["checkPrepared"];
queueAdmission.createProductionQueueAdmission = () => ({
  admission: {
    async check(payload, _artifact, options) {
      const script = (
        payload as { params?: { arguments?: { object?: { script?: string } } } }
      ).params?.arguments?.object?.script;
      if (script && !script.includes("FMCAD_QUEUE_INSTANCE"))
        await fakeAdmissionCheck?.(payload, options);
      return { kind: "python", fence() {} };
    },
  },
  async checkPrepared(prepared) {
    await fakeAdmissionCheck?.(prepared);
    return {};
  },
  fencePrepared() {},
  checkerFingerprint() {
    return "explicit fake checker for phased scheduler tests";
  },
});
const { serve } = runtimeRequire(
  path.join(projectRoot, "src/queue-broker.js"),
) as {
  serve(
    config: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<QueueBroker>;
};
const { request, queueSocket } = runtimeRequire(
  path.join(projectRoot, "src/queue-connection.js"),
);
const queueRequest = request as <T extends object = QueueReply>(
  directory: string,
  message: Record<string, unknown>,
) => Promise<T>;
const QueueState = runtimeRequire(path.join(projectRoot, "src/queue-state.js"))
  .QueueState as new (
  directory: string,
  options?: { now: () => number },
) => QueueStateFixture;
const { durable, workflowOutputNonterminal } = runtimeRequire(
  path.join(projectRoot, "src/queue-instance.js"),
);
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Scheduler tests use a named fake Python admission port; they exercise the
// production broker/worker phases, while the catalog-worker suite retains the
// separate real-checker admission path.
async function until<T>(
  fn: () => Promise<ReadyValue<T>> | ReadyValue<T>,
  message = "condition",
  ms = 10000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value as T;
    await sleep(10);
  }
  assert.fail("Timed out: " + message);
}

async function fixture(t: TestContext, brokerOptions: BrokerOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qphase-"));
  const isolatedEnvironment = isolateRuntimeTestEnvironment(dir);
  const instance = {
    pid: 999,
    birth: "mock:999",
    version: "mock",
    activeCommand: "SelectCommand",
    documents: [],
    documentState: { status: "unscoped" },
  };
  let fingerprint = "one";
  let losePostflight = false,
    finishPostflight: (() => void) | null = null,
    probes = 0,
    preflightDelay = 0,
    postflightDelay = 0;
  let postflightStarted = false;
  let count = 0,
    maximum = 0,
    rpcId = 1;
  const trace: string[] = [],
    wireIds: Array<string | number | null> = [];
  const sdkGates = new Map<
    string,
    { promise: Promise<void>; resolve: () => void }
  >();
  let nativeRequested = false,
    nativeBinding: NativeBinding | null = null,
    nativeImmediateFailure = false,
    lateNative = false,
    malformedNative = false,
    acceptedCloudSave = false;
  const nativeIdentity = {
    commandId: "fmcad_atomic_" + "a".repeat(32),
    runId: "native-fixture",
    requestHash: "b".repeat(64),
    sessionNonce: "c".repeat(32),
    backend: "mcp",
    resolvedIdentity: { creationId: "native-document" },
  };
  function receipt(script: string): NativeBinding | undefined {
    const binding = script.match(
      /_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/,
    );
    const file = script.match(/_qr_path = ("(?:\\.|[^"\\])*")/);
    if (!binding || !file || !binding[1] || !file[1]) return;
    const record = JSON.parse(JSON.parse(binding[1]));
    const target = JSON.parse(file[1])
      .replace(/^\\\\wsl\$\\[^\\]+/, "")
      .replaceAll("\\", "/");
    durable(target, {
      ...record,
      terminal: true,
      outcome: "succeeded",
      instance,
    });
    return { binding: record, receipt: target };
  }
  const physical: {
    server: { timeoutMs: number };
    _parse: typeof JSON.parse;
    _post(payload: PhysicalRequest): Promise<PhysicalResult>;
    callTool(value: ToolValue, toolName?: string): Promise<ToolResult>;
  } = {
    server: { timeoutMs: 5000 },
    _parse: JSON.parse,
    async _post(payload) {
      wireIds.push(payload.id);
      const script = payload.params?.arguments?.object?.script || "";
      const tag = script.includes("SDK_A") ? "A" : "B";
      count++;
      maximum = Math.max(maximum, count);
      trace.push("sdk-start-" + tag);
      try {
        await sleep(20);
        const gate = sdkGates.get(tag);
        if (gate) await gate.promise;
        const emitted = receipt(script);
        if (nativeRequested && tag === "A" && !nativeBinding && emitted) {
          nativeBinding = emitted;
          durable(emitted.receipt + ".native-start.json", {
            ...emitted.binding,
            terminal: false,
            stage: "native-start",
            instance,
            native: { kind: "atomic-batch", identity: nativeIdentity },
          });
          if (nativeImmediateFailure)
            durable(emitted.receipt + ".native-end.json", {
              ...emitted.binding,
              terminal: true,
              stage: "native-completion",
              outcome: "failed",
              instance,
              native: {
                kind: "atomic-batch",
                identity: nativeIdentity,
                state: {
                  destroyed: true,
                  completed: false,
                  notStarted: false,
                  outcome: "aborted",
                  accepted: true,
                  createdCount: 1,
                  executeCount: 1,
                },
              },
            });
        }
        if (lateNative && tag === "A" && !nativeBinding && emitted)
          nativeBinding = emitted;
        trace.push("sdk-end-" + tag);
        return {
          status: 200,
          raw: JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              content: [{ type: "text", text: JSON.stringify({ tag }) }],
            },
          }),
        };
      } finally {
        count--;
      }
    },
    async callTool(value, toolName) {
      const script = value.object?.script || "";
      if (script.includes("FMCAD_QUEUE_INSTANCE")) {
        probes++;
        if (script.includes("preflight-") && preflightDelay)
          await sleep(preflightDelay);
        if (script.includes("postflight-") && postflightDelay) {
          postflightStarted = true;
          await sleep(postflightDelay);
        }
        if (losePostflight && script.includes("postflight-")) {
          losePostflight = false;
          finishPostflight = () => receipt(script);
          throw Object.assign(
            new Error("Lost postflight reply; remote probe has not finished"),
            { code: "ECONNRESET" },
          );
        }
        receipt(script);
        return {
          failed: false,
          text:
            "FMCAD_QUEUE_INSTANCE " +
            JSON.stringify({
              ...instance,
              documentState: {
                status: "complete",
                fingerprint,
                state: { identity: { creationId: "A" }, references: [] },
              },
            }),
        };
      }
      const response = await this._post({
        jsonrpc: "2.0",
        id: rpcId++,
        method: "tools/call",
        params: { name: toolName || "fusion_mcp_execute", arguments: value },
      });
      if (acceptedCloudSave && script.includes("SDK_A")) {
        acceptedCloudSave = false;
        return {
          failed: false,
          text:
            "FMCAD_RESULT " +
            JSON.stringify({
              success: true,
              operation: "document.save_as",
              result: {
                accepted: true,
                pending: true,
                status: "pending",
                targetObserved: true,
                current: {
                  creationId: "saved-document",
                  saved: true,
                  modified: false,
                  isComplete: false,
                  fileId: "transitional-file",
                  fileName: "owned-name",
                  projectId: "project",
                  folderId: "folder",
                },
                target: {
                  name: "owned-name",
                  projectId: "project",
                  folderId: "folder",
                },
              },
            }),
        };
      }
      if (malformedNative && script.includes("SDK_A")) {
        malformedNative = false;
        return {
          text: "malformed adapted native reply",
        } as unknown as ToolResult; // Deliberately missing failed:boolean.
      }
      if (lateNative && script.includes("SDK_A")) {
        lateNative = false;
        return {
          failed: false,
          text:
            "FMCAD_RESULT " +
            JSON.stringify({
              identity: nativeIdentity,
              status: "submitted",
              destroyed: false,
              completed: false,
              outcome: "unknown",
            }),
        };
      }
      return {
        failed: false,
        text: JSON.parse(response.raw).result.content[0].text,
      };
    },
  };
  const prepareGate = path.join(dir, "prepare-go"),
    prepareMarker = path.join(dir, "preparing");
  const publishGate = path.join(dir, "publish-go"),
    publishMarker = path.join(dir, "publishing");
  const betweenGate = path.join(dir, "between-go"),
    betweenMarker = path.join(dir, "between-turns");
  const preload = path.join(dir, "preload.cjs");
  const typedWorker = path.join(dir, "typed-worker.cjs");
  // An explicit fake application service, not a second implementation of CAD
  // parsing/validation. Production process/capability/broker phases remain real.
  fs.writeFileSync(
    typedWorker,
    `const Module=require('node:module');const load=Module._load;
Module._load=function(name,parent,...rest){if((name==='./cli'||name.endsWith('/cli'))&&parent?.filename.includes('/src/'))throw new Error('Typed worker may not import the CLI');return load.call(this,name,parent,...rest);};
const fs=require('node:fs');const {run}=require(${JSON.stringify(require.resolve(path.join(projectRoot, "src/queue-worker.js")))});
run(process.argv[2],{async execute(request,backend,onOutcome){
 const script=fs.readFileSync(request.argv[1],'utf8');
 const result=await backend.callTool({featureType:'script',object:{script}});
 onOutcome({settled:true});process.stdout.write(result.text+'\\n');return result.failed?1:0;
}}).then(code=>{process.exitCode=code},error=>{process.stderr.write(error.stack+'\\n');process.exitCode=1});
`,
  );
  fs.writeFileSync(
    preload,
    `const fs=require('node:fs');const io=require('node:fs/promises');
const original=fs.readFileSync;let waited=false;
fs.readFileSync=function(file,...args){
 if(!waited&&String(file).endsWith('/slow-prepare.py')){waited=true;fs.writeFileSync(${JSON.stringify(prepareMarker)},'ready');while(!fs.existsSync(${JSON.stringify(prepareGate)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
 return original.call(this,file,...args);
};
const link=io.link;io.link=async function(from,to){if(String(to).endsWith('/slow-output.json')){fs.writeFileSync(${JSON.stringify(publishMarker)},'ready');while(!fs.existsSync(${JSON.stringify(publishGate)}))await new Promise(r=>setTimeout(r,10));}return link.call(this,from,to);};
const Module=require('node:module');const load=Module._load;Module._load=function(name,parent,...rest){const result=load.call(this,name,parent,...rest);if(name==='../composition/execution-worker.js'&&parent?.filename.endsWith('/entrypoints/worker.js')&&!result.__phaseFixture){const execute=result.execute;result.__phaseFixture=true;result.execute=async function(request,client,onOutcome){if(!request.argv.some(x=>x.endsWith('/multi.py')))return execute(request,client,onOutcome);await client.callTool({featureType:'script',object:{script:'# SDK_A first\\ndef run(context: str) -> None: pass'}});fs.writeFileSync(${JSON.stringify(betweenMarker)},'ready');while(!fs.existsSync(${JSON.stringify(betweenGate)}))await new Promise(r=>setTimeout(r,10));await client.callTool({featureType:'script',object:{script:'# SDK_A second\\ndef run(context: str) -> None: pass'}});return 0;};}return result;};
`,
  );
  fs.appendFileSync(
    preload,
    `const phaseLoad=Module._load;Module._load=function(name,parent,...rest){if((name==='./cli'||name.endsWith('/cli'))&&parent?.filename.includes('/src/'))throw new Error('Production worker must not import CLI');return phaseLoad.call(this,name,parent,...rest);};\n`,
  );
  const fixtureFiles: Array<[string, "A" | "B"]> = [
    ["slow-prepare.py", "A"],
    ["fast.py", "B"],
    ["publish.py", "A"],
    ["multi.py", "A"],
  ];
  for (const [name, tag] of fixtureFiles)
    fs.writeFileSync(
      path.join(dir, name),
      "# SDK_" + tag + "\ndef run(context: str) -> None:\n    pass\n",
    );
  fakeAdmissionCheck = brokerOptions.checkPrepared ?? (async () => {});
  const broker = await serve(
    {
      backend: "mcp",
      timeoutMs: 5000,
      queue: {
        preparationConcurrency: brokerOptions.preparationConcurrency ?? 2,
      },
    },
    {
      dir,
      confirmOwnership: true,
      createBackend: () => physical,
      nativePath: (file: string) => file,
      pollMs: 5,
      ...brokerOptions,
      spawnWorker(exe: string, args: string[], options: SpawnOptions) {
        const env = { ...options.env, NODE_OPTIONS: "--require " + preload };
        if (brokerOptions.typedPort) {
          const requestFile = args[1];
          assert.ok(requestFile);
          return spawn(exe, [typedWorker, requestFile], { ...options, env });
        }
        return spawn(exe, args, { ...options, env });
      },
    },
  );
  const a: ClientAuth = { clientId: "a", clientToken: "token-a" },
    b: ClientAuth = { clientId: "b", clientToken: "token-b" };
  for (const auth of [a, b])
    await queueRequest(dir, { action: "register", ...auth });
  const submit = (
    auth: ClientAuth,
    file: string,
    extra: string[] = [],
    options: Record<string, unknown> = {},
  ): Promise<SubmittedJob> => {
    const argv = ["run", path.join(dir, file), ...extra];
    return queueRequest(dir, {
      action: "submit",
      auth,
      request: {
        kind: "command",
        requestId: randomUUID(),
        argv,
        inputFiles: inputFiles(argv, dir),
        cwd: dir,
        timeoutMs: 5000,
        backend: "mcp",
        ...options,
      },
    }) as Promise<SubmittedJob>;
  };
  const result = (auth: ClientAuth, id: string): Promise<QueueResult> =>
    queueRequest<QueueResult>(dir, { action: "result", auth, jobId: id });
  const complete = (auth: ClientAuth, id: string): Promise<QueueResult> =>
    until(async () => {
      const value = await result(auth, id);
      if (
        ["failed", "needs_reconciliation", "expired"].includes(value.job.state)
      )
        assert.fail(JSON.stringify(value));
      return value.job.state === "succeeded" && value;
    }, "command completion");
  t.after(async () => {
    fs.writeFileSync(prepareGate, "go");
    fs.writeFileSync(publishGate, "go");
    fs.writeFileSync(betweenGate, "go");
    for (const gate of sdkGates.values()) gate.resolve();
    finishPostflight?.();
    try {
      await broker.close();
    } finally {
      fakeAdmissionCheck = undefined;
      isolatedEnvironment.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  function call(
    auth: ClientAuth,
    action: "submit",
    values: Record<string, unknown>,
  ): Promise<SubmittedJob>;
  function call(
    auth: ClientAuth,
    action: "control-status",
    values?: Record<string, unknown>,
  ): Promise<ControlStatus>;
  function call(
    auth: ClientAuth,
    action: "status",
    values?: Record<string, unknown>,
  ): Promise<ClientStatus>;
  function call(
    auth: ClientAuth,
    action: string,
    values?: Record<string, unknown>,
  ): Promise<QueueReply>;
  function call(
    auth: ClientAuth,
    action: string,
    values: Record<string, unknown> = {},
  ): Promise<QueueReply | SubmittedJob | ControlStatus | ClientStatus> {
    return queueRequest(dir, { auth, action, ...values });
  }
  return {
    dir,
    broker,
    submit,
    result,
    complete,
    a,
    b,
    trace,
    maximum: () => maximum,
    wireIds,
    delayPreflight(ms: number) {
      preflightDelay = ms;
    },
    delayPostflight(ms: number) {
      postflightDelay = ms;
    },
    postflightStarted: () => postflightStarted,
    prepareGate,
    prepareMarker,
    publishGate,
    publishMarker,
    betweenGate,
    betweenMarker,
    changeDocument: () => {
      fingerprint = "two";
    },
    declareNative() {
      nativeRequested = true;
    },
    declareFailedNative() {
      nativeRequested = true;
      nativeImmediateFailure = true;
    },
    acceptedCloudSaveReply() {
      acceptedCloudSave = true;
    },
    malformedNativeReply() {
      nativeRequested = true;
      malformedNative = true;
    },
    declareLateNative() {
      lateNative = true;
    },
    finishNative(failed = false) {
      assert.ok(nativeBinding);
      if (!fs.existsSync(nativeBinding.receipt + ".native-start.json"))
        durable(nativeBinding.receipt + ".native-start.json", {
          ...nativeBinding.binding,
          terminal: false,
          stage: "native-start",
          instance,
          native: { kind: "atomic-batch", identity: nativeIdentity },
        });
      durable(nativeBinding.receipt + ".native-end.json", {
        ...nativeBinding.binding,
        terminal: true,
        stage: "native-completion",
        outcome: failed ? "failed" : "succeeded",
        instance,
        native: {
          kind: "atomic-batch",
          identity: nativeIdentity,
          state: {
            destroyed: true,
            completed: !failed,
            notStarted: false,
            outcome: failed ? "aborted" : "committed",
            accepted: true,
            createdCount: 1,
            executeCount: 1,
          },
        },
      });
    },
    holdSdk(tag: string) {
      let resolve: () => void = () => {};
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      sdkGates.set(tag, { promise, resolve });
      return resolve;
    },
    losePostflight() {
      losePostflight = true;
    },
    finishPostflight() {
      assert.ok(finishPostflight);
      finishPostflight();
    },
    probeCount: () => probes,
    call,
  };
}

test("cad-v1 helper admission keeps physical preflight before authenticated stage preparation", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dir, "stage-helper.py");
  fs.writeFileSync(
    file,
    "ARGS = {}\nDOC_NAME = None\ndef run(context: str) -> None:\n    pass\n",
  );
  const submitted = await f.submit(
    f.a,
    "stage-helper.py",
    ["--helpers", "cad-v1", "--doc", "Owned", "--doc-id", "owned-doc"],
    {
      payload: {
        version: 1,
        kind: "run",
        request: {
          name: file,
          hasArgs: false,
          args: null,
          helperVersion: "cad-v1",
          readOnlyOperations: [],
          doc: "Owned",
          identity: { docId: "owned-doc" },
        },
      },
    },
  );
  await until(async () => {
    const value = await f.result(f.a, submitted.id);
    return (
      ["failed", "needs_reconciliation"].includes(value.job.state) && value
    );
  }, "helper refused missing physical document");
  const queue = JSON.parse(
    fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8"),
  );
  assert.equal(queue.jobs[submitted.id].request.phased, undefined);
  const directory = path.join(f.dir, "jobs", submitted.id);
  assert.equal(
    fs.existsSync(path.join(directory, "preflight-start.json")),
    true,
    "A helper may not attempt stage ownership in a preflight-free offline worker",
  );
  assert.equal(
    f.trace.some((row) => row.startsWith("sdk-start-")),
    false,
    "Missing owned document refuses the body, rather than bypassing stage authorization",
  );
});

test("a slow local preparation is not admitted to Fusion; a ready competing command finishes first", async (t) => {
  const f = await fixture(t);
  const a = await f.submit(f.a, "slow-prepare.py");
  await until(() => fs.existsSync(f.prepareMarker), "offline preparation");
  assert.equal((await f.result(f.a, a.id)).job.state, "preparing");
  assert.equal(f.broker.status().active, null);
  const b = await f.submit(f.b, "fast.py");
  await f.complete(f.b, b.id);
  assert.deepEqual(f.trace, ["sdk-start-B", "sdk-end-B"]);
  fs.writeFileSync(f.prepareGate, "go");
  await f.complete(f.a, a.id);
  assert.equal(f.maximum(), 1);
});

test("two projects prepare concurrently, own separate outputs and share exactly one physical executor", async (t) => {
  const f = await fixture(t, { typedPort: true });
  const projectA = path.join(f.dir, "project-a"),
    projectB = path.join(f.dir, "project-b");
  for (const project of [projectA, projectB])
    fs.mkdirSync(path.join(project, ".cad"), { recursive: true });
  const a = await f.submit(f.a, "slow-prepare.py", [], { cwd: projectA });
  await until(
    () => fs.existsSync(f.prepareMarker),
    "project A local preparation",
  );
  const b = await f.submit(f.b, "fast.py", [], { cwd: projectB });
  const resultB = await f.complete(f.b, b.id);
  assert.equal((await f.result(f.a, a.id)).job.state, "preparing");
  assert.deepEqual(f.trace, ["sdk-start-B", "sdk-end-B"]);
  fs.writeFileSync(f.prepareGate, "go");
  const resultA = await f.complete(f.a, a.id);
  assert.match(resultA.stdout, /SDK_A|"tag":"A"/);
  assert.match(resultB.stdout, /SDK_B|"tag":"B"/);
  assert.ok(
    fs.existsSync(path.join(projectA, ".cad/results", a.id, "stdout.txt")),
  );
  assert.ok(
    fs.existsSync(path.join(projectB, ".cad/results", b.id, "stdout.txt")),
  );
  assert.equal(f.maximum(), 1);
});

test("run args-file pins survive typed guard projection and idempotent retry does not re-read edited inputs", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.dir, "args.py"),
    argumentFile = path.join(f.dir, "accepted-args.json");
  fs.writeFileSync(
    source,
    "ARGS = []\n# SDK_A\ndef run(context: str) -> None: pass\n",
  );
  fs.writeFileSync(argumentFile, "[1]");
  const a = await f.submit(f.a, "args.py", ["--args-file", argumentFile]);
  await f.complete(f.a, a.id);
  const envelope = JSON.parse(
    fs.readFileSync(path.join(f.dir, "jobs", a.id, "request.json"), "utf8"),
  );
  const accepted = JSON.parse(
    fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8"),
  ).jobs[a.id].request;
  assert.equal(envelope.request.payload.kind, "run");
  assert.deepEqual(envelope.request.payload.request.args, [1]);
  assert.equal(envelope.request.argv.includes("--args-file"), false);
  assert.ok(
    envelope.request.inputFiles.some(
      (input: { path: string }) => input.path === argumentFile,
    ),
  );
  assert.ok(accepted.argv.includes("--args-file"));
  assert.deepEqual(envelope.request.inputFiles, accepted.inputFiles);
  fs.writeFileSync(argumentFile, "[999]");
  const retried = await f.call(f.a, "submit", { request: accepted });
  assert.equal(retried.id, a.id);
  assert.equal(retried.state, "succeeded");
  assert.equal(f.trace.filter((item) => item === "sdk-start-A").length, 1);
});

test("killing a preparing process fails only local work and does not consume the SDK slot", async (t) => {
  const f = await fixture(t);
  const a = await f.submit(f.a, "slow-prepare.py");
  await until(() => fs.existsSync(f.prepareMarker), "preparing child");
  const identity = JSON.parse(
    fs.readFileSync(
      path.join(f.dir, "jobs", a.id, "worker-identity.json"),
      "utf8",
    ),
  );
  process.kill(identity.pid, "SIGKILL");
  await until(
    async () => (await f.result(f.a, a.id)).job.state === "failed",
    "killed local worker",
  );
  const b = await f.submit(f.b, "fast.py");
  await f.complete(f.b, b.id);
  assert.deepEqual(f.trace, ["sdk-start-B", "sdk-end-B"]);
});

test("killing the observing worker does not release an active SDK call or replay it", async (t) => {
  const f = await fixture(t, { autoReconcile: true });
  const finish = f.holdSdk("A");
  const a = await f.submit(f.a, "publish.py");
  await until(
    () => f.trace.includes("sdk-start-A"),
    "physical request started",
  );
  const identity = JSON.parse(
    fs.readFileSync(
      path.join(f.dir, "jobs", a.id, "worker-identity.json"),
      "utf8",
    ),
  );
  process.kill(identity.pid, "SIGKILL");
  await until(
    async () =>
      (await f.result(f.a, a.id)).job.state === "needs_reconciliation",
    "dead worker hold",
  );
  const b = await f.submit(f.b, "fast.py");
  await sleep(100);
  assert.deepEqual(f.trace, ["sdk-start-A"]);
  finish();
  await f.complete(f.b, b.id);
  assert.equal(
    (await f.result(f.a, a.id)).job.state,
    "failed",
    "missing local result is not successful publication",
  );
  assert.equal(f.trace.filter((value) => value === "sdk-start-A").length, 1);
  assert.equal(f.maximum(), 1);
});

test("preparation capacity defaults to available CPU and rejects unbounded configuration", () => {
  const { resolvePreparationConcurrency } = runtimeRequire(
    path.join(projectRoot, "src/queue-phased.js"),
  ) as typeof import("../src/queue-phased");
  assert.equal(resolvePreparationConcurrency(undefined, 2), 1);
  assert.equal(resolvePreparationConcurrency(undefined, 4), 1);
  assert.equal(resolvePreparationConcurrency(undefined, 8), 2);
  assert.equal(resolvePreparationConcurrency(undefined, 32), 4);
  assert.equal(resolvePreparationConcurrency(10, 2), 10);
  for (const value of [0, 11, 1.5, "2", null, NaN, Infinity])
    assert.throws(() => resolvePreparationConcurrency(value, 4), {
      code: "INVALID_PREPARATION_CONCURRENCY",
    });
});
for (const concurrency of [1, 2])
  test(
    "configured preparation workers preserve the single SDK queue: " +
      concurrency,
    async (t) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let checks = 0;
      t.after(() => release());
      const f = await fixture(t, {
        preparationConcurrency: concurrency,
        async checkPrepared() {
          checks++;
          await gate;
        },
      });
      const first = await f.submit(f.a, "publish.py"),
        second = await f.submit(f.b, "fast.py");
      await until(
        () => checks === concurrency,
        "configured offline preparation slots",
      );
      assert.equal(
        fs.existsSync(
          path.join(f.dir, "jobs", second.id, "worker-identity.json"),
        ),
        concurrency === 2,
        "A backlogged worker has no running process or local deadline until its configured slot opens",
      );
      assert.deepEqual(
        f.trace,
        [],
        "Offline preparation has no physical SDK authority",
      );
      release();
      await f.complete(f.a, first.id);
      await f.complete(f.b, second.id);
      assert.equal(
        f.maximum(),
        1,
        "Both configured preparation levels retain one physical SDK lane",
      );
    },
  );

test("input bytes changed during the offline checker are refused at the actual physical boundary", async (t) => {
  let checked: () => void = () => {};
  let release: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    checked = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    async checkPrepared() {
      checked();
      await proceed;
    },
  });
  const a = await f.submit(f.a, "publish.py");
  await reached;
  fs.appendFileSync(
    path.join(f.dir, "publish.py"),
    "# changed after preparation\n",
  );
  release();
  const result = await until(async () => {
    const value = await f.result(f.a, a.id);
    return value.job.state === "failed" && value;
  }, "input fence failure");
  assert.equal(result.execution.mayHaveMutated, false);
  assert.deepEqual(f.trace, []);
});

test(
  "fallback admission is aborted with its local worker and never dispatches or replays",
  {},
  async (t) => {
    let checked!: () => void;
    const reached = new Promise<void>((resolve) => {
      checked = resolve;
    });
    let rejectPending: ((reason: Error) => void) | undefined;
    let capturedSignal: AbortSignal | undefined;
    let observedAbort = false,
      checks = 0;
    // Even the failing historical implementation can clean up its fake gate.
    t.after(() => rejectPending?.(new Error("fixture cleanup")));
    const f = await fixture(t, {
      async checkPrepared(_payload, options) {
        checks++;
        capturedSignal = options?.signal;
        checked();
        await new Promise<void>((_resolve, reject) => {
          rejectPending = reject;
          capturedSignal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(
                Object.assign(new Error("aborted fixture admission"), {
                  code: "FIXTURE_ADMISSION_ABORTED",
                }),
              );
            },
            { once: true },
          );
        });
      },
    });
    const requestId = "owned-aborted-preparation";
    const submitted = await f.submit(f.a, "publish.py", [], { requestId });
    await reached;
    const identity = JSON.parse(
      fs.readFileSync(
        path.join(f.dir, "jobs", submitted.id, "worker-identity.json"),
        "utf8",
      ),
    ) as { pid: number; birth: string };
    const instance = runtimeRequire(
      path.join(projectRoot, "src/queue-instance.js"),
    ) as { processBirth(pid: number): string };
    assert.equal(instance.processBirth(identity.pid), identity.birth);
    assert.equal(
      fs.realpathSync("/proc/" + identity.pid + "/cwd"),
      fs.realpathSync(f.dir),
    );
    process.kill(identity.pid, "SIGKILL");
    const result = await until(async () => {
      const value = await f.result(f.a, submitted.id);
      return value.job.state === "failed" && value;
    }, "local worker exit without SDK");
    assert.ok(
      capturedSignal,
      "Fallback admission must receive the owning local AbortSignal",
    );
    assert.equal(capturedSignal.aborted, true);
    assert.equal(
      observedAbort,
      true,
      "The checker wait is released by actual worker closure",
    );
    assert.equal(result.execution.sdkSettled, true);
    assert.equal(result.execution.mayHaveMutated, false);
    assert.equal(result.job.physicalTurns || 0, 0);
    assert.deepEqual(f.trace, []);
    const duplicate = await f.submit(f.a, "publish.py", [], { requestId });
    assert.equal(duplicate.id, submitted.id);
    assert.equal(
      checks,
      1,
      "Receipt lookup does not repeat even the aborted preparation",
    );
    assert.deepEqual(f.trace, []);
  },
);

test("pause between checker and grant invalidates the original context without SDK submission", async (t) => {
  let checked: () => void = () => {};
  let release: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    checked = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    async checkPrepared() {
      checked();
      await proceed;
    },
  });
  const a = await f.submit(f.a, "publish.py");
  await reached;
  const before = await f.call(f.a, "control-status");
  try {
    await f.call(f.a, "pause", {
      control: {
        requestId: randomUUID(),
        instanceId: before.instanceId,
        expectedGeneration: before.generation,
      },
    });
  } finally {
    release();
  }
  await sleep(50);
  assert.deepEqual(f.trace, []);
  const paused = await f.call(f.a, "control-status");
  await f.call(f.a, "resume", {
    control: {
      requestId: randomUUID(),
      instanceId: paused.instanceId,
      expectedGeneration: paused.generation,
    },
  });
  await until(
    async () => (await f.result(f.a, a.id)).job.state === "failed",
    "stale context rejection",
  );
  assert.deepEqual(f.trace, []);
});

test("literal batch $ref syntax inside queued Python is code, not a persistent API object reference", async (t) => {
  const f = await fixture(t);
  const source =
    '# SDK_A\ndef run(context: str) -> None:\n    local_step = {"$ref": "seed.result.bodies.0"}\n';
  fs.writeFileSync(path.join(f.dir, "literal-ref.py"), source);
  const command = await f.submit(f.a, "literal-ref.py");
  await f.complete(f.a, command.id);
  const raw = await f.call(f.b, "submit", {
    request: {
      kind: "rpc",
      requestId: randomUUID(),
      backend: "mcp",
      timeoutMs: 5000,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "fusion_mcp_execute",
          arguments: {
            featureType: "script",
            object: { readOnly: true, script: source },
          },
        },
      },
    },
  });
  await f.complete(f.b, raw.id);
  assert.equal(f.trace.filter((item) => item === "sdk-start-A").length, 2);
});

test("code-field exemption does not permit remembered objects, persistent Python or structured global references", async (t) => {
  const f = await fixture(t);
  const submit = (name: string, args: Record<string, unknown>) =>
    f.call(f.a, "submit", {
      request: {
        kind: "rpc",
        requestId: randomUUID(),
        backend: "mcp",
        timeoutMs: 5000,
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        },
      },
    });
  await assert.rejects(
    submit("execute_python", {
      code: 'print("$ref")',
      persistent: false,
      remember_as: "shared",
    }),
    { code: "unsupported_queue_route" },
  );
  await assert.rejects(
    submit("execute_python", { code: "print(1)", persistent: true }),
    { code: "unsupported_queue_route" },
  );
  await assert.rejects(
    submit("fusion_mcp_execute", {
      featureType: "script",
      object: { script: "def run(c): pass", target: "$shared" },
    }),
    { code: "unsupported_queue_route" },
  );
  assert.deepEqual(f.trace, []);
});

test("a short caller timeout does not strand other clients after the original SDK call settles", async (t) => {
  const f = await fixture(t, { autoReconcile: true });
  const finish = f.holdSdk("A");
  const a = await f.submit(f.a, "publish.py", [], { timeoutMs: 300 });
  await until(() => f.trace.includes("sdk-start-A"), "original SDK started");
  await until(
    async () =>
      (await f.result(f.a, a.id)).job.state === "needs_reconciliation",
    "short caller timeout",
  );
  const probesBefore = f.probeCount();
  const b = await f.submit(f.b, "fast.py");
  await sleep(1100);
  assert.deepEqual(
    f.trace,
    ["sdk-start-A"],
    "an active/unknown SDK call must not overlap another call",
  );
  assert.equal(
    f.probeCount(),
    probesBefore,
    "no recovery probe while the original RPC is pending",
  );
  const settledAt = Date.now();
  finish();
  try {
    await until(
      async () => (await f.result(f.b, b.id)).job.state === "succeeded",
      "competing client resumed automatically",
      5000,
    );
  } catch (error) {
    // Settle this fake backend fixture before propagating a regression failure.
    await f.call(f.a, "reconcile", { jobId: a.id });
    await f.complete(f.b, b.id);
    throw error;
  }
  assert.ok(
    Date.now() - settledAt < 5000,
    "known completion must not wait for the old 30-second recovery interval",
  );
  assert.equal((await f.result(f.a, a.id)).job.code, "RECONCILED");
  assert.equal(f.broker.status().blocked, null);
  assert.equal(f.broker.status().lease, null);
  assert.equal(
    f.trace.filter((item) => item === "sdk-start-A").length,
    1,
    "never replay the timed-out operation",
  );
  assert.equal(f.maximum(), 1);
});

test("native command lifetime keeps its SDK turn until the matching destroy receipt, without extra probes", async (t) => {
  const f = await fixture(t, { autoReconcile: true });
  f.declareNative();
  const a = await f.submit(f.a, "publish.py");
  await until(
    () => f.trace.includes("sdk-end-A"),
    "synchronous script returned",
  );
  const probes = f.probeCount();
  const b = await f.submit(f.b, "fast.py");
  await until(
    async () => (await f.result(f.b, b.id)).job.state === "queued",
    "other client queued behind native command",
  );
  try {
    await sleep(100);
    assert.deepEqual(f.trace, ["sdk-start-A", "sdk-end-A"]);
    assert.equal(
      f.probeCount(),
      probes,
      "no idle probe before native destroy proof",
    );
    assert.ok(
      (await f.call(f.a, "status")).control.activeOperations >= 1,
      "console must still see admitted native work",
    );
  } finally {
    f.finishNative();
  }
  await f.complete(f.a, a.id);
  await f.complete(f.b, b.id);
  assert.equal(f.maximum(), 1);
  assert.equal((await f.call(f.a, "status")).control.activeOperations, 0);
});

test("physical raw RPC settlement fails immediately from native failure despite a positive transport receipt", async (t) => {
  const f = await fixture(t);
  f.declareFailedNative();
  const a = await f.call(f.a, "submit", {
    request: {
      kind: "rpc",
      requestId: randomUUID(),
      backend: "mcp",
      timeoutMs: 5000,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "fusion_mcp_execute",
          arguments: {
            featureType: "script",
            object: { script: "# SDK_A\ndef run(context: str) -> None: pass" },
          },
        },
      },
    },
  });
  const result = await until(async () => {
    const value = await f.result(f.a, a.id);
    return value.job.state === "failed" && value;
  }, "physical native failure");
  assert.equal(result.execution.mayHaveMutated, true);
  assert.equal(result.execution.sdkSettled, true);
  assert.equal(f.broker.status().blocked, null);
  assert.equal(f.trace.filter((item) => item === "sdk-start-A").length, 1);
});

test("positive transport receipt plus failed native termination fails the settled SDK turn", async (t) => {
  const f = await fixture(t);
  f.declareNative();
  const a = await f.submit(f.a, "publish.py");
  await until(
    () => f.trace.includes("sdk-end-A"),
    "positive transport completion",
  );
  f.finishNative(true);
  const result = await until(async () => {
    const value = await f.result(f.a, a.id);
    return value.job.state === "failed" && value;
  }, "native failed execution");
  assert.equal(result.execution.mayHaveMutated, true);
  const b = await f.submit(f.b, "fast.py");
  await f.complete(f.b, b.id);
  assert.equal(f.trace.filter((item) => item === "sdk-start-A").length, 1);
  assert.equal(f.maximum(), 1);
});

test("raw RPC reconciliation never upgrades positive transport plus failed native end to succeeded", async (t) => {
  const f = await fixture(t, { autoReconcile: true });
  f.declareNative();
  // Raw RPC has a durable transport reply independent of a child worker's exit.
  // The previous command fixture raced its 300 ms timeout against publication
  // of worker-result.json, which legitimately changes the diagnostic code.
  const a = await f.call(f.a, "submit", {
    request: {
      kind: "rpc",
      requestId: randomUUID(),
      backend: "mcp",
      timeoutMs: 300,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "fusion_mcp_execute",
          arguments: {
            featureType: "script",
            object: { script: "# SDK_A\ndef run(context: str) -> None: pass" },
          },
        },
      },
    },
  });
  await until(
    async () =>
      (await f.result(f.a, a.id)).job.state === "needs_reconciliation",
    "native timeout",
  );
  const b = await f.submit(f.b, "fast.py");
  f.finishNative(true);
  await f.complete(f.b, b.id);
  const result = await f.result(f.a, a.id);
  assert.equal(result.job.code, "RECONCILED");
  assert.equal(result.job.state, "failed");
  assert.equal(result.execution.sdkSettled, true);
  assert.equal(result.execution.mayHaveMutated, true);
  assert.equal(f.trace.filter((item) => item === "sdk-start-A").length, 1);
  assert.equal((await f.call(f.a, "status")).control.activeOperations, 0);
});

test("failed native reconciliation preserves unavailable output after the observing worker is killed", async (t) => {
  const f = await fixture(t, { autoReconcile: true });
  f.declareNative();
  const finishSdk = f.holdSdk("A");
  const a = await f.submit(f.a, "publish.py");
  await until(
    () => f.trace.includes("sdk-start-A"),
    "physical request started",
  );
  const identity = JSON.parse(
    fs.readFileSync(
      path.join(f.dir, "jobs", a.id, "worker-identity.json"),
      "utf8",
    ),
  ) as { pid: number };
  // Kill before the transport reply, so missing worker output is deliberate,
  // independent of process startup speed or the test runner's scheduling.
  process.kill(identity.pid, "SIGKILL");
  await until(
    async () =>
      (await f.result(f.a, a.id)).job.state === "needs_reconciliation",
    "dead observing worker",
  );
  assert.equal(
    fs.existsSync(path.join(f.dir, "jobs", a.id, "worker-result.json")),
    false,
  );
  const b = await f.submit(f.b, "fast.py");
  finishSdk();
  await until(
    () => f.trace.includes("sdk-end-A"),
    "positive transport completion",
  );
  f.finishNative(true);
  await f.complete(f.b, b.id);
  const result = await f.result(f.a, a.id);
  assert.equal(result.job.code, "RESULT_UNAVAILABLE");
  assert.equal(result.job.state, "failed");
  assert.equal(result.execution.sdkSettled, true);
  assert.equal(result.execution.mayHaveMutated, true);
  assert.equal(f.trace.filter((item) => item === "sdk-start-A").length, 1);
  assert.equal(f.maximum(), 1);
  assert.equal((await f.call(f.a, "status")).control.activeOperations, 0);
});

test("completed saveAs SDK turn yields while its observed target is still processing in the cloud", async (t) => {
  const f = await fixture(t, { autoReconcile: true });
  f.acceptedCloudSaveReply();
  const a = await f.submit(f.a, "publish.py");
  const result = await f.complete(f.a, a.id);
  assert.match(result.stdout, /"pending":true/);
  const b = await f.submit(f.b, "fast.py");
  await f.complete(f.b, b.id);
  const status = await f.call(f.a, "status");
  assert.equal(status.blocked, null);
  assert.equal(status.control.activeOperations, 0);
  assert.equal(
    f.trace.filter((item) => item === "sdk-start-A").length,
    1,
    "accepted save must never be replayed",
  );
  assert.equal(f.maximum(), 1);
});

test("a timed-out native command cannot auto-release from its script receipt; late destroy proof resumes other clients", async (t) => {
  const f = await fixture(t, { autoReconcile: true });
  f.declareNative();
  const a = await f.submit(f.a, "publish.py", [], { timeoutMs: 300 });
  let last: QueueResult | undefined;
  try {
    await until(async () => {
      last = await f.result(f.a, a.id);
      return last.job.state === "needs_reconciliation";
    }, "native caller timeout");
  } catch (error) {
    // Keep the evidence that distinguishes a pre-dispatch deadline from an
    // unsettled native turn. Fixture cleanup otherwise removes these records.
    t.diagnostic(
      JSON.stringify({
        checkpoint: "native caller timeout",
        job: last?.job,
        execution: last?.execution,
        trace: f.trace,
        probes: f.probeCount(),
      }),
    );
    throw error;
  }
  const probes = f.probeCount();
  const b = await f.submit(f.b, "fast.py");
  try {
    await sleep(1200); // Cross automatic recovery: script end alone is not native end.
    assert.equal((await f.result(f.a, a.id)).job.state, "needs_reconciliation");
    assert.deepEqual(f.trace, ["sdk-start-A", "sdk-end-A"]);
    assert.equal(f.probeCount(), probes);
  } finally {
    f.finishNative();
  }
  await f.complete(f.b, b.id);
  assert.equal((await f.result(f.a, a.id)).job.code, "RECONCILED");
  assert.equal(f.trace.filter((item) => item === "sdk-start-A").length, 1);
  assert.equal((await f.call(f.a, "status")).control.activeOperations, 0);
});

test("adapted nonterminal output remains fenced across automatic recovery until workflow-specific evidence arrives", async (t) => {
  const f = await fixture(t, { autoReconcile: true });
  f.declareLateNative();
  const a = await f.submit(f.a, "publish.py");
  await until(
    async () =>
      (await f.result(f.a, a.id)).job.state === "needs_reconciliation",
    "adapted native pending result",
  );
  const probes = f.probeCount();
  const b = await f.submit(f.b, "fast.py");
  try {
    await sleep(1200);
    assert.equal(
      (await f.result(f.a, a.id)).job.state,
      "needs_reconciliation",
      "generic script receipt must not erase adapted pending metadata",
    );
    assert.equal(
      f.probeCount(),
      probes,
      "no new probe before matching native evidence",
    );
    assert.deepEqual(f.trace, ["sdk-start-A", "sdk-end-A"]);
  } finally {
    f.finishNative();
  }
  await f.complete(f.b, b.id);
  assert.equal((await f.result(f.a, a.id)).job.code, "RECONCILED");
  assert.equal(f.trace.filter((item) => item === "sdk-start-A").length, 1);
});

test("a malformed adapted native reply stays failed but does not strand other clients after command termination proof", async (t) => {
  const f = await fixture(t, { autoReconcile: true });
  f.malformedNativeReply();
  const a = await f.submit(f.a, "publish.py");
  await until(
    async () =>
      (await f.result(f.a, a.id)).job.state === "needs_reconciliation",
    "unvalidated adapted native response",
  );
  const probes = f.probeCount();
  const b = await f.submit(f.b, "fast.py");
  try {
    await sleep(1100);
    assert.equal(f.probeCount(), probes);
    assert.deepEqual(f.trace, ["sdk-start-A", "sdk-end-A"]);
  } finally {
    f.finishNative();
  }
  await f.complete(f.b, b.id);
  assert.equal(
    (await f.result(f.a, a.id)).job.state,
    "failed",
    "unvalidated result must not become success",
  );
  assert.equal(f.trace.filter((item) => item === "sdk-start-A").length, 1);
  assert.equal((await f.call(f.a, "status")).control.activeOperations, 0);
});

test("a caller disconnect after submission does not cancel/replay its RPC or prevent other clients from being served", async (t) => {
  const f = await fixture(t);
  const finish = f.holdSdk("A");
  const requestId = randomUUID();
  const argv = ["run", path.join(f.dir, "publish.py")];
  const message = {
    action: "submit",
    auth: f.a,
    request: {
      kind: "command",
      requestId,
      argv,
      cwd: f.dir,
      inputFiles: inputFiles(argv, f.dir),
      timeoutMs: 5000,
      backend: "mcp",
    },
  };
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(queueSocket(f.dir));
    socket.once("error", reject);
    socket.once("connect", () =>
      socket.write(JSON.stringify(message) + "\n", () => {
        socket.destroy(); // Deliberately lose the admission reply; do not resubmit.
        resolve();
      }),
    );
  });
  const a = await until(
    () =>
      Object.values(f.broker.status().jobs).find(
        (job) => job.requestId === requestId,
      ),
    "durable job after lost acknowledgement",
  );
  await until(() => f.trace.includes("sdk-start-A"), "original RPC started");
  const b = await f.submit(f.b, "fast.py");
  await until(
    async () => (await f.result(f.b, b.id)).job.state === "queued",
    "other client admitted while original RPC is active",
  );
  const responsive = await f.call(f.b, "status");
  assert.equal(responsive.active, a.id);
  assert.deepEqual(f.trace, ["sdk-start-A"]);
  finish();
  await f.complete(f.a, a.id);
  await f.complete(f.b, b.id);
  assert.deepEqual(f.trace, [
    "sdk-start-A",
    "sdk-end-A",
    "sdk-start-B",
    "sdk-end-B",
  ]);
  assert.equal(f.maximum(), 1);
});

test("a broken RPC reply resumes competing clients automatically only after its matching completion receipt arrives", async (t) => {
  const f = await fixture(t, { autoReconcile: true });
  f.losePostflight();
  const a = await f.submit(f.a, "publish.py");
  await until(
    async () =>
      (await f.result(f.a, a.id)).job.state === "needs_reconciliation",
    "lost postflight response",
  );
  const probes = f.probeCount();
  const b = await f.submit(f.b, "fast.py");
  await sleep(1100);
  assert.equal(
    f.probeCount(),
    probes,
    "missing completion evidence must not trigger another physical probe",
  );
  assert.deepEqual(f.trace, ["sdk-start-A", "sdk-end-A"]);
  f.finishPostflight();
  await until(
    async () => (await f.result(f.b, b.id)).job.state === "succeeded",
    "queue resumed after late receipt",
    5000,
  );
  assert.equal((await f.result(f.a, a.id)).job.code, "RECONCILED");
  assert.equal(f.trace.filter((item) => item === "sdk-start-A").length, 1);
  assert.equal(f.broker.status().blocked, null);
  assert.equal(f.maximum(), 1);
});

test("worker heartbeat remains valid while an admitted turn waits for its preflight probe", async (t) => {
  const f = await fixture(t);
  f.delayPreflight(1300);
  const a = await f.submit(f.a, "fast.py");
  await f.complete(f.a, a.id);
  assert.deepEqual(f.trace, ["sdk-start-B", "sdk-end-B"]);
  assert.equal(f.broker.status().blocked, null);
});

test("worker heartbeat survives a long postflight in sending state without releasing the SDK slot early", async (t) => {
  const f = await fixture(t);
  f.delayPostflight(1500);
  const a = await f.submit(f.a, "publish.py");
  await until(f.postflightStarted, "postflight started");
  assert.equal((await f.result(f.a, a.id)).job.state, "sending");
  const b = await f.submit(f.b, "fast.py");
  await sleep(1100); // Cross the real worker's one-second heartbeat interval.
  assert.deepEqual(f.trace, ["sdk-start-A", "sdk-end-A"]);
  const waiting = await f.result(f.a, a.id);
  assert.equal(waiting.job.state, "sending");
  assert.doesNotMatch(
    waiting.stderr || "",
    /SDK turn is not available for local work/,
  );
  await f.complete(f.a, a.id);
  await f.complete(f.b, b.id);
  assert.equal(f.broker.status().blocked, null);
  assert.equal(f.maximum(), 1);
});

test("local publication after the SDK result does not block the next Fusion operation", async (t) => {
  const f = await fixture(t);
  const a = await f.submit(f.a, "publish.py", [
    "--out",
    path.join(f.dir, "slow-output.json"),
    "--out-format",
    "json",
  ]);
  await until(
    () => fs.existsSync(f.publishMarker),
    "offline output publication",
  );
  assert.equal((await f.result(f.a, a.id)).job.state, "processing");
  assert.equal(f.broker.status().active, null);
  assert.equal(f.broker.status().lease, null);
  const b = await f.submit(f.b, "fast.py");
  await f.complete(f.b, b.id);
  assert.equal((await f.result(f.a, a.id)).job.state, "processing");
  assert.deepEqual(f.trace, [
    "sdk-start-A",
    "sdk-end-A",
    "sdk-start-B",
    "sdk-end-B",
  ]);
  fs.writeFileSync(f.publishGate, "go");
  await f.complete(f.a, a.id);
  assert.equal(f.maximum(), 1);
});

test("two submitting agents receive only their own Fusion result and cannot fetch each other's output", async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([
    f.submit(f.a, "publish.py"),
    f.submit(f.b, "fast.py"),
  ]);
  const [one, two] = await Promise.all([
    f.complete(f.a, a.id),
    f.complete(f.b, b.id),
  ]);
  assert.equal(one.job.id, a.id);
  assert.equal(one.job.clientId, "a");
  assert.equal(JSON.parse(one.stdout).tag, "A");
  assert.equal(two.job.id, b.id);
  assert.equal(two.job.clientId, "b");
  assert.equal(JSON.parse(two.stdout).tag, "B");
  await assert.rejects(f.result(f.b, a.id), { code: "NOT_OWNER" });
  await assert.rejects(f.result(f.a, b.id), { code: "NOT_OWNER" });
  await assert.rejects(
    f.call({ clientId: "a", clientToken: "wrong-token" }, "result", {
      jobId: a.id,
    }),
    { code: "UNAUTHORIZED" },
  );
  assert.equal(new Set(f.wireIds).size, f.wireIds.length);
  assert.ok(
    f.wireIds.every(
      (id) => typeof id === "string" && /^fmcad:[a-f0-9-]{36}$/.test(id),
    ),
  );
});

test("a mismatched or stale wire response is rejected rather than delivered to the current caller", () => {
  const { matching } = runtimeRequire(
    path.join(projectRoot, "src/queue-broker.js"),
  );
  const client = { _parse: JSON.parse };
  const request = {
    jsonrpc: "2.0",
    method: "tools/call",
    id: "current-client-rpc",
  };
  for (const id of ["previous-client-rpc", "other-client-rpc", 2, null]) {
    assert.throws(
      () =>
        matching(
          client,
          {
            status: 200,
            raw: JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { text: "wrong recipient" },
            }),
          },
          request,
        ),
      { code: "UNKNOWN_RPC" },
    );
  }
  assert.deepEqual(
    matching(
      client,
      {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { text: "correct recipient" },
        }),
      },
      request,
    ).result,
    { text: "correct recipient" },
  );
});

test("raw MCP callers keep their original RPC IDs even when both clients submit the same ID", async (t) => {
  const f = await fixture(t);
  const submit = (auth: ClientAuth, tag: "A" | "B") =>
    f.call(auth, "submit", {
      request: {
        kind: "rpc",
        requestId: randomUUID(),
        timeoutMs: 5000,
        payload: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "fusion_mcp_execute",
            arguments: {
              featureType: "script",
              object: {
                script:
                  "# SDK_" + tag + "\ndef run(context: str) -> None: pass",
              },
            },
          },
        },
      },
    });
  const [a, b] = await Promise.all([submit(f.a, "A"), submit(f.b, "B")]);
  const [one, two] = await Promise.all([
    f.complete(f.a, a.id),
    f.complete(f.b, b.id),
  ]);
  assert.ok(one.rpc);
  assert.ok(two.rpc);
  const first = JSON.parse(one.rpc.raw),
    second = JSON.parse(two.rpc.raw);
  assert.equal(first.id, 2);
  assert.equal(second.id, 2);
  assert.equal(JSON.parse(first.result.content[0].text).tag, "A");
  assert.equal(JSON.parse(second.result.content[0].text).tag, "B");
  assert.equal(new Set(f.wireIds).size, 2);
  assert.equal(f.maximum(), 1);
});

test("receipt reconciliation restores the caller ID when recovering a missing raw-result copy", async (t) => {
  const f = await fixture(t);
  f.losePostflight();
  const a = await f.call(f.a, "submit", {
    request: {
      kind: "rpc",
      requestId: randomUUID(),
      timeoutMs: 5000,
      payload: {
        jsonrpc: "2.0",
        id: "agent-a-original",
        method: "tools/call",
        params: {
          name: "fusion_mcp_execute",
          arguments: {
            featureType: "script",
            object: { script: "# SDK_A\ndef run(context: str) -> None: pass" },
          },
        },
      },
    },
  });
  await until(
    async () =>
      (await f.result(f.a, a.id)).job.state === "needs_reconciliation",
  );
  fs.unlinkSync(path.join(f.dir, "jobs", a.id, "rpc-result.json")); // Optional duplicate; original terminal journal remains.
  f.finishPostflight();
  await f.call(f.a, "reconcile", { jobId: a.id });
  const result = await f.result(f.a, a.id);
  assert.equal(result.job.state, "succeeded");
  assert.ok(result.rpc);
  const reply = JSON.parse(result.rpc.raw);
  assert.equal(reply.id, "agent-a-original");
  assert.equal(JSON.parse(reply.result.content[0].text).tag, "A");
  assert.equal(f.trace.filter((x) => x === "sdk-start-A").length, 1);
});

test("SDK turns retain unknown holds; only settled turns can release into local processing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qstate-"));
  try {
    const state = new QueueState(dir);
    const job = state.submit({
      kind: "command",
      phased: true,
      requestId: randomUUID(),
      clientId: "a",
      argv: ["run", "x.py"],
      cwd: dir,
      timeoutMs: 1000,
    });
    assert.equal(state.next(), null);
    state.readyTurn(job.id);
    const running = state.next();
    assert.ok(running);
    assert.equal(running.id, job.id);
    state.block(job.id, "unknown");
    assert.throws(() => state.releaseTurn(job.id, 900), {
      code: "RECONCILIATION_REQUIRED",
    });
    const b = state.submit({
      kind: "rpc",
      requestId: randomUUID(),
      clientId: "b",
      payload: {},
      timeoutMs: 1000,
    });
    assert.equal(state.next(), null);
    assert.equal(state.status(b.id).state, "queued");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a queued follow-up turn cannot be cancelled as though the command never started", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qcancel-"));
  try {
    const state = new QueueState(dir);
    const job = state.submit({
      kind: "command",
      phased: true,
      requestId: randomUUID(),
      clientId: "a",
      argv: ["run", "x.py"],
      cwd: dir,
      timeoutMs: 1000,
    });
    state.readyTurn(job.id);
    state.next();
    state.releaseTurn(job.id, 900);
    state.readyTurn(job.id);
    assert.throws(() => state.cancel(job.id, "a"), { code: "ALREADY_STARTED" });
    assert.equal(state.status(job.id).state, "queued");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an owner can end a settled context during local work, but no further SDK turn may reuse it", () => {
  for (const mode of ["automatic", "exclusive"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qend-"));
    try {
      const state = new QueueState(dir);
      const job = state.submit({
        kind: "command",
        phased: true,
        requestId: randomUUID(),
        clientId: "a",
        argv: ["run", "x.py"],
        cwd: dir,
        timeoutMs: 1000,
        sequence: { action: "begin", mode },
      });
      state.readyTurn(job.id);
      const running = state.next();
      assert.ok(running);
      const sequenceId = running.sequenceId;
      if (typeof sequenceId !== "string")
        assert.fail("A sequenced job must have a sequence ID");
      assert.throws(() => state.release(sequenceId, "a"), {
        code: "QUEUE_BUSY",
      });
      state.releaseTurn(job.id, 900);
      state.release(sequenceId, "a");
      assert.equal(state.summary().lease, null);
      assert.equal(state.summary().active, null);
      assert.throws(() => state.readyTurn(job.id), {
        code: "SEQUENCE_EXPIRED",
      });
      state.finishLocal(job.id, { state: "succeeded" });
      assert.equal(state.status(job.id).sequenceState, "ended");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("multiple SDK turns of one command interleave only while that command is doing local work", async (t) => {
  const f = await fixture(t);
  const a = await f.submit(f.a, "multi.py", ["--doc", "A", "--doc-id", "A"]);
  await until(() => fs.existsSync(f.betweenMarker), "between SDK turns");
  assert.equal((await f.result(f.a, a.id)).job.state, "processing");
  const b = await f.submit(f.b, "fast.py");
  await f.complete(f.b, b.id);
  fs.writeFileSync(f.betweenGate, "go");
  const value = await f.complete(f.a, a.id);
  assert.equal(value.job.physicalTurns, 2);
  assert.deepEqual(f.trace, [
    "sdk-start-A",
    "sdk-end-A",
    "sdk-start-B",
    "sdk-end-B",
    "sdk-start-A",
    "sdk-end-A",
  ]);
  assert.equal(f.maximum(), 1);
});

test("an intervening document change rejects the next SDK turn with refreshed context and no stale execution", async (t) => {
  const f = await fixture(t);
  const a = await f.submit(f.a, "multi.py", ["--doc", "A", "--doc-id", "A"]);
  await until(() => fs.existsSync(f.betweenMarker), "between SDK turns");
  f.changeDocument();
  fs.writeFileSync(f.betweenGate, "go");
  const value = await until(async () => {
    const result = await f.result(f.a, a.id);
    return result.job.state === "failed" && result;
  }, "changed document rejection");
  assert.equal(value.job.code, "DOCUMENT_CHANGED");
  assert.equal(
    value.job.mayHaveMutated,
    true,
    "The earlier SDK turn is not misreported as never submitted",
  );
  assert.match(value.stdout, /"operationSubmitted":false/);
  assert.deepEqual(f.trace, ["sdk-start-A", "sdk-end-A"]);
  assert.equal(f.broker.status().blocked, null);
  const b = await f.submit(f.b, "fast.py");
  await f.complete(f.b, b.id);
});

test("publication failure is a local command failure, not an unresolved SDK hold", async (t) => {
  const f = await fixture(t);
  const output = path.join(f.dir, "slow-output.json");
  const a = await f.submit(f.a, "publish.py", [
    "--out",
    output,
    "--out-format",
    "json",
  ]);
  await until(() => fs.existsSync(f.publishMarker), "offline publication");
  fs.writeFileSync(output, "external output must not be replaced");
  fs.writeFileSync(f.publishGate, "go");
  const failed = await until(async () => {
    const value = await f.result(f.a, a.id);
    return value.job.state === "failed" && value;
  });
  assert.equal(failed.execution.sdkSettled, true);
  assert.equal(failed.job.code, "LOCAL_EXECUTION_FAILED");
  assert.equal(f.broker.status().blocked, null);
  assert.equal(
    fs.readFileSync(output, "utf8"),
    "external output must not be replaced",
  );
  const b = await f.submit(f.b, "fast.py");
  await f.complete(f.b, b.id);
});

test("an SDK timeout keeps the instance blocked until the original receipt is reconciled, without replay", async (t) => {
  const f = await fixture(t);
  const release = f.holdSdk("A");
  const a = await f.submit(f.a, "publish.py", [], { timeoutMs: 500 });
  await until(() => f.trace.includes("sdk-start-A"), "SDK started");
  await until(
    async () =>
      (await f.result(f.a, a.id)).job.state === "needs_reconciliation",
    "unknown timeout",
  );
  const b = await f.submit(f.b, "fast.py");
  await until(
    async () => (await f.result(f.b, b.id)).job.state === "queued",
    "competing SDK turn queued behind unknown",
  );
  assert.deepEqual(f.trace, ["sdk-start-A"]);
  const blocked = f.broker.status().blocked;
  assert.ok(blocked);
  assert.equal(blocked.id, a.id);
  await assert.rejects(f.call(f.a, "reconcile", { jobId: a.id }), {
    code: "WORKER_PENDING",
  });
  release();
  await until(() => f.trace.includes("sdk-end-A"), "original SDK completion");
  await until(
    () => fs.existsSync(path.join(f.dir, "jobs", a.id, "worker-result.json")),
    "local worker result",
  );
  await until(async () => {
    try {
      return await f.call(f.a, "reconcile", { jobId: a.id });
    } catch (error) {
      const code =
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : undefined;
      if (code && ["WORKER_PENDING", "BROKER_BUSY"].includes(code))
        return false;
      throw error;
    }
  }, "receipt-bound reconciliation");
  await f.complete(f.b, b.id);
  assert.equal(f.trace.filter((x) => x === "sdk-start-A").length, 1);
  assert.equal(f.maximum(), 1);
});

test("restart never replays preparing or settled-offline workers and preserves an in-flight unknown", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qrestore-"));
  try {
    let state = new QueueState(dir);
    const submit = () =>
      state.submit({
        kind: "command",
        phased: true,
        requestId: randomUUID(),
        clientId: "a",
        argv: ["run", "x.py"],
        cwd: dir,
        timeoutMs: 1000,
      });
    const preparing = submit(),
      offline = submit();
    state.readyTurn(offline.id);
    state.next();
    state.releaseTurn(offline.id, 900);
    const inFlight = submit();
    state.readyTurn(inFlight.id);
    state.next();
    state = new QueueState(dir);
    assert.equal(state.status(preparing.id).code, "LOCAL_WORKER_INTERRUPTED");
    assert.equal(state.status(offline.id).code, "LOCAL_WORKER_INTERRUPTED");
    assert.equal(state.status(inFlight.id).state, "needs_reconciliation");
    assert.equal(state.next(), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unfinished postflight probe is reconciled from its own receipt before any new Fusion probe", async (t) => {
  const f = await fixture(t);
  f.losePostflight();
  const a = await f.submit(f.a, "publish.py");
  await until(
    async () =>
      (await f.result(f.a, a.id)).job.state === "needs_reconciliation",
    "postflight unknown",
  );
  const count = f.probeCount();
  await assert.rejects(f.call(f.a, "reconcile", { jobId: a.id }), {
    code: "RECEIPT_UNAVAILABLE",
  });
  assert.equal(
    f.probeCount(),
    count,
    "No second read is stacked on the unfinished postflight",
  );
  const b = await f.submit(f.b, "fast.py");
  await until(async () => (await f.result(f.b, b.id)).job.state === "queued");
  assert.deepEqual(f.trace, ["sdk-start-A", "sdk-end-A"]);
  f.finishPostflight();
  await until(() =>
    fs.existsSync(path.join(f.dir, "jobs", a.id, "worker-result.json")),
  );
  await f.call(f.a, "reconcile", { jobId: a.id });
  await f.complete(f.b, b.id);
  assert.equal(f.trace.filter((x) => x === "sdk-start-A").length, 1);
});

test("queue wait budgets start at SDK readiness, and manual pause invalidates a preparing command", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qready-"));
  try {
    let time = 1000;
    const state = new QueueState(dir, { now: () => time });
    const job = state.submit({
      kind: "command",
      phased: true,
      requestId: randomUUID(),
      clientId: "a",
      argv: ["run", "x.py"],
      cwd: dir,
      timeoutMs: 1000,
      queueTimeoutMs: 100,
    });
    time += 1000;
    assert.equal(state.next(), null);
    assert.equal(state.status(job.id).state, "preparing");
    state.pause(true);
    time += 1000;
    state.pause(false);
    assert.equal(state.status(job.id).contextRefreshRequired, true);
    state.readyTurn(job.id);
    assert.equal(state.status(job.id).queueDeadline, time + 100);
    time += 99;
    const running = state.next();
    assert.ok(running);
    assert.equal(running.id, job.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit exclusive mode remains deliberate; automatic mode does not retain a lease for local work", async (t) => {
  const f = await fixture(t);
  const a = await f.submit(f.a, "multi.py", ["--doc", "A", "--doc-id", "A"], {
    sequence: { action: "begin", mode: "exclusive" },
  });
  await until(() => fs.existsSync(f.betweenMarker));
  const b = await f.submit(f.b, "fast.py");
  await until(async () => (await f.result(f.b, b.id)).job.state === "queued");
  const lease = f.broker.status().lease;
  assert.ok(lease);
  assert.equal(lease.clientId, "a");
  assert.equal(f.broker.status().active, null);
  fs.writeFileSync(f.betweenGate, "go");
  const complete = await f.complete(f.a, a.id);
  await f.call(f.a, "release", { sequenceId: complete.job.sequenceId });
  await f.complete(f.b, b.id);
  assert.deepEqual(f.trace, [
    "sdk-start-A",
    "sdk-end-A",
    "sdk-start-A",
    "sdk-end-A",
    "sdk-start-B",
    "sdk-end-B",
  ]);
});

test("a late typed unknown from local processing fences admissions without preempting another active SDK turn", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qfence-"));
  try {
    const state = new QueueState(dir);
    const a = state.submit({
      kind: "command",
      phased: true,
      requestId: randomUUID(),
      clientId: "a",
      argv: ["run", "x.py"],
      cwd: dir,
      timeoutMs: 1000,
    });
    state.readyTurn(a.id);
    state.next();
    state.releaseTurn(a.id, 900);
    const b = state.submit({
      kind: "rpc",
      requestId: randomUUID(),
      clientId: "b",
      payload: {},
      timeoutMs: 1000,
    });
    state.next();
    state.blockLocal(a.id, "typed workflow pending");
    assert.equal(state.summary().active, b.id);
    assert.equal(state.next(), null);
    state.finish(b.id);
    const blocked = state.summary().blocked;
    assert.ok(blocked);
    assert.equal(blocked.id, a.id);
    assert.equal(state.status(a.id).state, "needs_reconciliation");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("typed asynchronous and nested workflow outcomes are recognized before releasing the SDK slot", () => {
  assert.equal(
    workflowOutputNonterminal({
      text:
        "FMCAD_RESULT " +
        JSON.stringify({
          success: true,
          result: { status: "submitted", completed: false, outcome: "unknown" },
        }),
    }),
    true,
  );
  assert.equal(
    workflowOutputNonterminal({
      text:
        "FMCAD_RESULT " +
        JSON.stringify({
          success: true,
          result: { status: "completed", completed: true, outcome: "complete" },
        }),
    }),
    false,
  );
  assert.equal(
    workflowOutputNonterminal({
      text:
        "FMCAD_RESULT " +
        JSON.stringify({
          operation: "document.save_as",
          result: { status: "pending" },
        }),
    }),
    true,
  );
  assert.equal(
    workflowOutputNonterminal({
      data: { operation: "batch.run", outcome: "unknown" },
    }),
    true,
  );
  assert.equal(
    workflowOutputNonterminal({
      text: JSON.stringify({ operation: "batch.run", status: "complete" }),
    }),
    false,
  );
});

test("conditional idle stop atomically refuses a busy or leased snapshot", async (t) => {
  const f = await fixture(t);
  const release = f.holdSdk("A");
  const a = await f.submit(f.a, "publish.py");
  await until(() => f.trace.includes("sdk-start-A"));
  const status = await f.call(f.a, "status");
  assert.equal(status.features.conditionalIdleStop, true);
  await assert.rejects(
    f.call(f.a, "stop", {
      onlyIfQuiescent: true,
      expectedBuildHash: status.buildHash,
      expectedRevision: status.revision,
    }),
    { code: "QUEUE_BUSY" },
  );
  assert.equal(f.broker.status().stopping, false);
  release();
  await f.complete(f.a, a.id);
});

test("local preparation/processing labels do not misrepresent an agent as disconnected", () => {
  const { t } = runtimeRequire(path.join(projectRoot, "src/i18n.js"));
  assert.equal(t("state_preparing", {}, "pl"), "przygotowanie lokalne");
  assert.equal(t("state_processing", {}, "en"), "processing locally");
  assert.equal(t("state_offline", {}, "pl"), "rozłączona");
});
