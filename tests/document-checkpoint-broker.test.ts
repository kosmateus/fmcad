import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import type * as P from "../src/queue-broker-ports";
import type { QueueClient } from "../src/queue-client";

const runtime = process.env["FMCAD_TEST_RUNTIME"] || path.resolve(__dirname, "../..");
const load = createRequire(path.join(runtime, "dist/src/queue-broker.js"));
const fixtures = createRequire(path.join(
  process.env["FMCAD_TEST_FIXTURE_ROOT"] || path.join(runtime, "tests"),
  "fixture-loader.cjs",
));
const { nativeReceipts } = fixtures("./fixtures/native-source-envelope.cjs") as {
  nativeReceipts(source: string, root: string, instance: unknown): { file: string; value: Record<string, unknown> }[];
};
const releasedProof = fixtures("./fixtures/physical-turn-fixture.cjs") as
  (binding: P.PhysicalTurnBinding) => P.PhysicalTurnQuiescence;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
// The filesystem fingerprint itself has exact-byte mutation tests. This host
// adapter seam proves its changed result is still consumed at the RPC boundary.
const runtimeIdentity = load("./queue-instance") as {
  buildHash(root?: string): string;
};
const originalBuildHash = runtimeIdentity.buildHash;
let changedRuntime = false, changedRuntimeChecks = 0;
runtimeIdentity.buildHash = (root?: string) => {
  if (!changedRuntime) return originalBuildHash(root);
  changedRuntimeChecks++;
  return hash("runtime bytes changed after offline preparation");
};

/** Actual compiled broker, IPC, client preparation, checker and persistence.
 * Only the physical boundary/receipts are synthetic; no Fusion/native SDK runs. */
async function fixture(t: TestContext, foreignConflict: boolean | "raw-forged" = false,
  metadataFault?: "program" | "wire" | "runtime", historyCount = 0,
  preparedHook?: (prepared: P.PreparedCall) => void | Promise<void>,
  controlledStdout?: P.Options["prepareControlledStdout"],
  captureIngress?: P.Options["captureControlledIngress"],
  beforeServe?: (directory: string) => Promise<Pick<P.Options, "fusionResetNonce">>) {
  changedRuntime = false; changedRuntimeChecks = 0;
  const home = fs.mkdtempSync("/tmp/opencode/checkpoint-broker-");
  const previous = process.env["XDG_STATE_HOME"], cwd = process.cwd();
  const previousData = process.env["XDG_DATA_HOME"];
  const previousConfig = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_STATE_HOME"] = home;
  process.env["XDG_DATA_HOME"] = path.join(home, "data");
  process.env["XDG_CONFIG_HOME"] = path.join(home, "config");
  process.chdir(home);
  const { resolveFmcadConfiguration } = load("./dist/core") as {
    resolveFmcadConfiguration(value: unknown): P.Config;
  };
  const cfg = resolveFmcadConfiguration({
    adapter: { backend: "addin", url: "http://127.0.0.1:8765/mcp", timeoutMs: 60000 },
    environment: {}, file: {}, platformDefaults: {}, acceptedService: null,
  });
  const { queueDirectory } = load("./queue-connection") as { queueDirectory(): string };
  const dir = queueDirectory();
  const lifecycleOptions = await beforeServe?.(dir);
  const instance = { pid: 991, birth: "synthetic-checkpoint-991", version: "fixture",
    activeCommand: "SelectCommand", documents: [] };
  let expression = "10 mm", identityCalls = 0, products = 0, queries = 0, writes = 0;
  let unknownHistory = false, revoked = false, wrongReply = false;
  let cancelledRead = false;
  let failOutcome = false;
  let differentProductGeneration = false;
  let windowsReceiptMode = false;
  const windowsReceipts: { file: string; ino: number; sha256: string }[] = [];
  let beforeHistory: (() => void | Promise<void>) | undefined;
  const released = new Set<string>();
  const productJobs: string[] = [];
  const clients: QueueClient[] = [];
  if (foreignConflict) {
    const { openIsolatedEpoch } = load("./queue-isolated-epoch") as typeof import("../src/queue-isolated-epoch");
    const state = openIsolatedEpoch(dir, { recover: false });
    const submitted = state.submit({
      kind: "command", clientId: "foreign-owner", requestId: "private-foreign-request",
      argv: foreignConflict === "raw-forged" ? ["run", "owned-raw-fixture"] :
        ["param", "apply", "--doc-id", "doc-A", "--doc-file-id", "file-A"],
      cwd: home, timeoutMs: 15000,
    });
    const jobId = String(submitted["id"]);
    state.next();
    const job = state.data.jobs[jobId]!;
    const request: P.PhysicalTurnRequest = {
      kind: "system-read", brokerNonce: "fixture-foreign-owner", jobId,
      requestId: job.requestId, clientId: job.clientId, requestHash: job.hash,
      grantGeneration: 1, physicalRequestId: "foreign-physical-read",
      documentSelector: foreignConflict === "raw-forged" ? undefined :
        { creationId: "doc-A", fileId: "file-A" },
    };
    const binding: P.PhysicalTurnBinding = {
      version: 1, generation: { epoch: "epoch-A", instance: "generation-A" },
      grantDigest: hash("isolated-private-fixture-grant"),
      physicalRuntime: { pid: instance.pid, birth: instance.birth, version: instance.version,
        source: "fixture-source", build: "fixture-build" },
      turnId: request.physicalRequestId, target: JSON.stringify(request.documentSelector ?? null),
    };
    const body = { request, physical: binding,
      target: foreignConflict === "raw-forged" ? null : { creationId: "doc-A", fileId: "file-A" },
      catalogIndex: 1 };
    const bytes = JSON.stringify(body), name = `physical-turn-${hash(binding.turnId)}.json`;
    fs.mkdirSync(path.join(dir, "jobs", jobId), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "jobs", jobId, name), bytes, { mode: 0o600 });
    fs.mkdirSync(path.join(dir, "physical-reads"), { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "physical-reads", `${hash(binding.turnId)}.json`),
      JSON.stringify({ version: 1, request, physicalTurn: binding, catalogIndex: 1 }), { mode: 0o600 });
    state.recordPhysicalDispatch(jobId, { ...body, intentReference: name, intentDigest: hash(bytes) });
    state.block(jobId, "Original fixture outcome remains unknown");
    const proof = releasedProof(binding);
    assert.equal(proof.state, "released");
    if (proof.state !== "released") throw Error("fixture release is unavailable");
    state.quarantineUnknown(jobId, {
      jobId, requestId: job.requestId, clientId: job.clientId, jobHash: job.hash,
      target: body.target, catalogDigest: hash(JSON.stringify(state.data.jobs[jobId]!.physicalDispatches)),
      evidenceDigest: proof.evidenceDigest!, evidenceReference: proof.physicalEvidenceReference!,
      binding: { jobId, requestId: job.requestId, clientId: job.clientId,
        requestHash: job.hash, physicalTurns: [proof] },
    });
    if (foreignConflict === "raw-forged") {
      const file = path.join(dir, "queue-state.json");
      const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
      snapshot.quarantined[jobId].fenceKind = "runtime_retired";
      fs.writeFileSync(file, JSON.stringify(snapshot), { mode: 0o600 });
    }
    if (historyCount) {
      const file = path.join(dir, "queue-state.json");
      const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
      const historical = { ...snapshot.jobs[jobId], state: "succeeded",
        finishedAt: Date.now(), description: "Historical metadata fixture ".repeat(60) };
      delete historical.physicalDispatches;
      delete historical.physicalDispatchCount;
      delete historical.dispatch;
      for (let i = 0; i < historyCount; i++) {
        const id = `completed-history-${i}`;
        snapshot.jobs[id] = { ...historical, id, requestId: id, order: i + 100,
          request: { ...historical.request, requestId: id } };
      }
      snapshot.order = Math.max(snapshot.order ?? 0, historyCount + 100);
      fs.writeFileSync(file, JSON.stringify(snapshot), { mode: 0o600 });
    }
  }
  function checkpoint(): import("../packages/node-adapters/src/python/cad-script").ParamCheckpointGuardV1 {
    return {
      schema: "fmcad.param-checkpoint-v1",
      document: {
        identity: { creationId: "doc-A", name: "Owned A", fileId: "file-A",
          version: 1, isSaved: true, isModified: false },
        fingerprint: hash(expression),
      },
      parameters: [{
        name: "length", expression, unit: "mm", value: expression === "10 mm" ? 1 : 2,
        valueType: "numeric", valueUnits: "Fusion internal units (cm, rad, kg, s)",
        comment: "authorized model data", metadata: { includesModel: true },
      }],
    };
  }
  if (captureIngress) {
    const { openIsolatedEpoch } = load("./queue-isolated-epoch") as typeof import("../src/queue-isolated-epoch");
    openIsolatedEpoch(dir, { recover: false }).pause(true, "owned-controlled-transfer");
  }
  const { createBrokerTransport } = load("./dist/fusion-transport/broker") as {
    createBrokerTransport(config: unknown, dependencies: unknown): P.Client;
  };
  const { addinBridgeSource } = load("./addin-bridge") as typeof import("../src/composition/library-addin-bridge");
  const physical = createBrokerTransport(cfg, {
    version: "test", requestTimeout: (server: { timeoutMs: number }) => server.timeoutMs,
    bridgeSource: addinBridgeSource,
  });
  if (metadataFault === "program") {
    const prepare = physical.prepareCallTool;
    assert.ok(prepare);
    physical.prepareCallTool = (...args) => prepare.apply(physical,
      args[1] === "fusion_mcp_read"
        ? [{ featureType: "script", object: { script: "changed_program = True", readOnly: false } }, "fusion_mcp_execute"]
        : args);
  }
  const compileProductOracle = () => {
    const compiler = load("./dist/composition/cad") as typeof import("../src/composition/cad");
    return compiler.prepareCadScript("param.apply",
      { parameters: [{ expression: "20 mm", name: "length" }] },
      { doc: "Owned A", docId: "doc-A", docFileId: "file-A", preview: false }, undefined, checkpoint());
  };
  let productOracle: { checkpoint: string; program: ReturnType<typeof compileProductOracle> } | undefined;
  physical._post = async (payload) => {
    if (payload.method === "initialize")
      return { status: 200, raw: JSON.stringify({ jsonrpc: "2.0", id: payload.id,
        result: { protocolVersion: "2025-06-18" } }) };
    if (payload.method === "notifications/initialized") return { status: 202, raw: "" };
    if (["tools/list", "ping"].includes(payload.method))
      return { status: 200, raw: JSON.stringify({ jsonrpc: "2.0", id: payload.id,
        result: payload.method === "tools/list" ? { tools: [] } : {} }) };
    const script = payload.params?.arguments?.code ?? payload.params?.arguments?.object?.script;
    assert.equal(typeof script, "string");
    const observed = { ...instance, documentState: {
      status: "complete", fingerprint: hash(expression),
      state: { identity: checkpoint().document.identity, references: [] },
    } };
    const receipts = nativeReceipts(script!, home, observed);
    const probe = receipts.some((entry) => entry.value["probeObservation"]);
    for (const entry of receipts) {
      fs.writeFileSync(entry.file, JSON.stringify(entry.value), { mode: 0o600 });
      if (windowsReceiptMode && !probe) {
        fs.chmodSync(entry.file, 0o644);
        windowsReceipts.push({ file: entry.file, ino: fs.statSync(entry.file).ino,
          sha256: hash(fs.readFileSync(entry.file, "utf8")) });
      }
    }
    let stdout: string;
    if (probe) {
      identityCalls++;
      stdout = "FMCAD_QUEUE_INSTANCE " + JSON.stringify(observed);
    } else {
      products++;
      productJobs.push((JSON.parse(fs.readFileSync(path.join(dir, "queue-state.json"), "utf8")) as { active: string }).active);
      const snapshot = JSON.parse(fs.readFileSync(path.join(dir, "queue-state.json"), "utf8")) as {
        active: string; jobs: Record<string, {
          documentContinuation?: { sourceHash: string };
           documentMetadataRead?: { programHash: string; rpcHash: string };
           pythonStdout?: { programHash: string; rpcHash: string; hostBindingHash: string };
        }>;
      };
      const continuation = snapshot.jobs[snapshot.active]?.documentContinuation;
      const metadata = snapshot.jobs[snapshot.active]?.documentMetadataRead;
      const stdoutMarker = snapshot.jobs[snapshot.active]?.pythonStdout;
      if (stdoutMarker) {
        const folder = path.join(dir, "jobs", snapshot.active);
        const rpc = fs.readdirSync(folder).filter((name) => /^rpc-.*\.json$/.test(name) && name !== "rpc-result.json")
          .map((name) => record(JSON.parse(fs.readFileSync(path.join(folder, name), "utf8"))))
          .find((value) => `fmcad:${record(value["binding"])["rpcId"]}` === payload.id);
        assert.ok(rpc, "stdout requires its original durable RPC record");
        const scope = record(record(rpc["binding"])["documentScope"]);
        assert.equal(scope["producer"], "compiled-python-stdout-v1");
        assert.equal(scope["programHash"], stdoutMarker.programHash);
        assert.equal(scope["rpcHash"], stdoutMarker.rpcHash);
        assert.equal(scope["hostBindingHash"], stdoutMarker.hostBindingHash);
        stdout = "CONTROLLED_STDOUT_MARKER\n";
      } else if (metadata) {
        const folder = path.join(dir, "jobs", snapshot.active);
        const rpc = fs.readdirSync(folder).filter((name) => /^rpc-.*\.json$/.test(name) && name !== "rpc-result.json")
          .map((name) => record(JSON.parse(fs.readFileSync(path.join(folder, name), "utf8"))))
          .find((value) => `fmcad:${record(value["binding"])["rpcId"]}` === payload.id);
        assert.ok(rpc, "metadata read must have an original durable RPC record");
        const binding = record(rpc["binding"]), scope = record(binding["documentScope"]);
        assert.equal(scope["producer"], "compiled-document-metadata-v1");
        assert.equal(scope["programHash"], metadata.programHash);
        assert.equal(scope["rpcHash"], metadata.rpcHash);
        assert.equal(binding["sourceHash"], metadata.programHash);
        stdout = "FMCAD_BRIDGE_RESULT " + JSON.stringify({ success: true, results: [{
          name: "Owned A", id: "file-A", creationId: "doc-A",
          isActive: true, isModified: false, isSaved: true,
        }] });
      } else if (continuation) {
        if (productOracle)
          assert.equal(productOracle.checkpoint, JSON.stringify(checkpoint()),
            "the independently prepared fixture oracle must still match the exact current checkpoint");
        const guarded = productOracle?.program ?? compileProductOracle();
        assert.equal(continuation.sourceHash, hash(guarded.script),
          "the actual accepted job must bind the default compiler's guarded source");
        const folder = path.join(dir, "jobs", snapshot.active);
        const rpc = fs.readdirSync(folder).filter((name) => /^rpc-.*\.json$/.test(name) && name !== "rpc-result.json")
          .map((name) => record(JSON.parse(fs.readFileSync(path.join(folder, name), "utf8"))))
          .find((value) => `fmcad:${record(value["binding"])["rpcId"]}` === payload.id);
        assert.ok(rpc, "the actual wire request must have its durable RPC record");
        const binding = record(rpc["binding"]), scope = record(binding["documentScope"]);
        assert.equal(scope["sourceHash"], hash(guarded.script));
        assert.equal(scope["wireSourceHash"], binding["sourceHash"]);
        writes++;
        expression = "20 mm";
        stdout = "FMCAD_RESULT " + JSON.stringify({
          success: true, operation: "param.apply", result: { parameters: checkpoint().parameters }, created: [],
        });
      } else if (script!.includes("app.documents.add(")) {
        const creationSnapshot = record(JSON.parse(fs.readFileSync(path.join(dir, "queue-state.json"), "utf8")));
        const creationId = String(creationSnapshot["active"]);
        const creationJob = record(record(creationSnapshot["jobs"])[creationId]);
        const marker = record(creationJob["documentCreation"]);
        assert.equal(creationJob["documentMetadataRead"], undefined, "creation is not a readonly metadata grant");
        const folder = path.join(dir, "jobs", creationId);
        const rpc = fs.readdirSync(folder).filter((name) => /^rpc-.*\.json$/.test(name) && name !== "rpc-result.json")
          .map((name) => record(JSON.parse(fs.readFileSync(path.join(folder, name), "utf8"))))
          .find((value) => `fmcad:${record(value["binding"])["rpcId"]}` === payload.id);
        assert.ok(rpc, "creation requires the original durable RPC record");
        const binding = record(rpc["binding"]), scope = record(binding["documentScope"]);
        assert.equal(scope["producer"], "compiled-document-creation-v1");
        assert.equal(scope["operation"], "document.new");
        assert.equal(scope["programHash"], marker["programHash"]);
        assert.equal(scope["rpcHash"], marker["rpcHash"]);
        assert.equal(scope["wireSourceHash"], binding["sourceHash"]);
        writes++;
        stdout = "CREATED_DOC name=New bounded document\n" + JSON.stringify({
          schema: "fmcad-created-document-v1", creationId: "fresh-created-doc",
          name: "New bounded document", fileId: null, isSaved: false, isModified: false,
        });
      } else {
        assert.ok(script!.includes("result = _cad_param_checkpoint(ctx)"),
          "owned unlock read must execute the actual private compiler callback");
        stdout = "FMCAD_RESULT " + JSON.stringify({
          success: true, operation: "param.inspect", result: failOutcome ? {} : checkpoint(), created: [],
        });
      }
      if (failOutcome) {
        const snapshot = JSON.parse(fs.readFileSync(path.join(dir, "queue-state.json"), "utf8")) as { active: string };
        // Real filesystem refusal, not a replacement of durable() or controller.
        fs.mkdirSync(path.join(dir, "jobs", snapshot.active, "outcome.json"));
      }
    }
    const id = !probe && wrongReply ? "foreign-reply" : payload.id;
    wrongReply = false;
    return { status: 200, raw: JSON.stringify({ jsonrpc: "2.0", id,
      result: { content: [{ type: "text", text: JSON.stringify({ success: true, stdout, stderr: "" }) }] },
    }) };
  };
  const { serve } = load("./queue-broker") as typeof import("../src/composition/queue-broker");
  let broker: Awaited<ReturnType<typeof serve>> | undefined;
  t.after(async () => {
    for (const client of clients) client.dispose();
    revoked = false; unknownHistory = false; beforeHistory = undefined;
    changedRuntime = false;
    try { await broker?.close(); }
    finally {
      process.chdir(cwd);
      if (previous === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = previous;
      if (previousData === undefined) delete process.env["XDG_DATA_HOME"];
      else process.env["XDG_DATA_HOME"] = previousData;
      if (previousConfig === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = previousConfig;
    }
    if (broker && process.env["FMCAD_TEST_PRESERVE_ARTIFACTS"] !== "1")
      fs.rmSync(home, { recursive: true, force: true });
    else if (broker) console.error("Preserved owned checkpoint fixture:", home);
  });
  try { broker = await serve(cfg, {
    dir, confirmOwnership: true, pollMs: 5, createBackend: () => physical,
    ...(controlledStdout ? { prepareControlledStdout: controlledStdout } : {}),
    ...(captureIngress ? { captureControlledIngress: captureIngress } : {}),
    ...lifecycleOptions,
    nativePath: (file) => file,
    async testCheckPrepared(prepared) {
      await preparedHook?.(prepared);
      const scope = prepared.record.binding["documentScope"];
      if (!["wire", "runtime"].includes(metadataFault ?? "") ||
          !scope || typeof scope !== "object" || Array.isArray(scope) ||
          record(scope)["producer"] !== "compiled-document-metadata-v1")
        return;
      if (metadataFault === "runtime") {
        changedRuntime = true;
        return;
      }
      const args = prepared.outgoing.params?.arguments;
      assert.ok(args && typeof args["code"] === "string");
      args["code"] += "\n# changed after certification in owned offline fixture\n";
    },
    bindPhysicalTurn(request) {
      if (revoked) throw Object.assign(new Error("native grant revoked"), { code: "PHYSICAL_GENERATION_REJECTED" });
      return {
        version: 1, generation: {
          epoch: differentProductGeneration && request.kind === "product" ? "epoch-B" : "epoch-A",
          instance: differentProductGeneration && request.kind === "product" ? "generation-B" : "generation-A",
        },
        grantDigest: hash("isolated-private-fixture-grant"),
        physicalRuntime: { ...instance,
          source: captureIngress ? "a".repeat(40) : "fixture-source",
          build: captureIngress ? hash("owned-native-build") : "fixture-build" },
        turnId: request.physicalRequestId,
        target: JSON.stringify(request.documentSelector ?? null),
      };
    },
    async withPhysicalTurn(binding, send) {
      if (revoked) throw new Error("native grant revoked");
      try { return await send(); }
      finally { released.add(binding.turnId); }
    },
    async physicalTurnQuiescence(binding) {
      queries++;
      await beforeHistory?.();
      if (revoked || unknownHistory || !released.has(binding.turnId))
        return { state: "unknown", binding };
      if (cancelledRead) {
        const { physicalReleaseInput } = load("./dist/core/domain/queue-quarantine") as
          typeof import("../packages/core/src/domain/queue-quarantine");
        const evidenceDigest = hash(physicalReleaseInput(binding, "cancelled-before-sdk"));
        return { state: "released", binding, evidenceDigest,
          physicalEvidenceReference: `fmcad-physical-turn:sha256:${evidenceDigest}` };
      }
      return releasedProof(binding);
    },
  }); } catch (error) {
    t.diagnostic(JSON.stringify((error as { pythonCheck?: unknown }).pythonCheck ?? {}));
    throw error;
  }
  return {
    dir, checkpoint, counts: () => ({ identityCalls, products, queries }), writes: () => writes,
    change() { expression = "20 mm"; },
    historyUnknown(value: boolean) { unknownHistory = value; },
    cancelledRead(value: boolean) { cancelledRead = value; },
    failOutcome(value = true) { failOutcome = value; },
    changeProductGeneration() { differentProductGeneration = true; },
    useWindowsReceipts() { windowsReceiptMode = true; },
    windowsReceipts: () => [...windowsReceipts],
    changedRuntimeChecks: () => changedRuntimeChecks,
    prepareProductOracle() {
      productOracle = { checkpoint: JSON.stringify(checkpoint()), program: compileProductOracle() };
    },
    removePreparation() { Object.defineProperty(physical, "prepareCallTool", { value: undefined }); },
    productJobs: () => [...productJobs],
    revoke(value: boolean) { revoked = value; },
    wrongReply() { wrongReply = true; },
    beforeHistory(value: (() => void | Promise<void>) | undefined) { beforeHistory = value; },
    async client(id = "reader-A") {
      const { QueueClient } = load("./queue-client") as typeof import("../src/queue-client");
      const client = new QueueClient(id, { cfg });
      clients.push(client);
      await client.register();
      return client;
    },
  };
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
test("real broker captures paused private ingress and activates only after supported resume",
  { timeout: 120000 }, async (t) => {
    let ready: Parameters<NonNullable<P.Options["captureControlledIngress"]>>[0] | undefined;
    const f = await fixture(t, false, undefined, 0, undefined, undefined,
      (original) => { ready = original; });
    assert.ok(ready);
    const ingress = load("./dist/node-adapters/execution/controlled-ingress-window") as
      typeof import("../packages/node-adapters/src/execution/controlled-ingress-window");
    ingress.assertControlledIngressTransition(ready.window, ready.identity);
    assert.throws(() => ingress.assertControlledIngressWindow(ready!.window, ready!.identity));
    assert.throws(() => ready!.activate(), /resume|ingress/i);
    // An early activation call is terminal, so a caller cannot regain a window
    // by later changing the public paused state.
    assert.throws(() => ingress.assertControlledIngressTransition(ready!.window, ready!.identity));
    const client = await f.client("owned-controlled-operator");
    const current = record(await client.call("control-status"));
    const resumed = record(await client.call("resume", { control: {
      requestId: "owned-supported-resume", instanceId: current["instanceId"],
      expectedGeneration: current["generation"],
    } }));
    assert.ok(["RUNNING", "RESUMING"].includes(String(resumed["phase"])));
    assert.throws(() => ready!.activate());
    assert.equal(f.writes(), 0);
  });

test("real broker supported resume preserves the original pending ingress witness",
  { timeout: 120000 }, async (t) => {
    let ready: Parameters<NonNullable<P.Options["captureControlledIngress"]>>[0] | undefined;
    const f = await fixture(t, false, undefined, 0, undefined, undefined,
      (original) => { ready = original; });
    assert.ok(ready);
    const ingress = load("./dist/node-adapters/execution/controlled-ingress-window") as
      typeof import("../packages/node-adapters/src/execution/controlled-ingress-window");
    const client = await f.client("owned-controlled-operator");
    const current = record(await client.call("control-status"));
    const resumed = record(await client.call("resume", { control: {
      requestId: "owned-valid-supported-resume", instanceId: current["instanceId"],
      expectedGeneration: current["generation"],
    } }));
    assert.equal(resumed["phase"], "RUNNING");
    ready.activate();
    ingress.assertControlledIngressWindow(ready.window, ready.identity);
    assert.throws(() => ingress.assertControlledIngressWindow(
      Object.freeze({}) as NonNullable<typeof ready>["window"], ready!.identity));
    f.revoke(true);
    assert.throws(() => ingress.assertControlledIngressWindow(ready!.window, ready!.identity));
    f.revoke(false);
    assert.throws(() => ingress.assertControlledIngressWindow(ready!.window, ready!.identity));
    assert.equal(f.writes(), 0);
  });
test("real broker accepts original reset barrier transfer before its supported resume",
  { timeout: 120000 }, async (t) => {
    type Lifecycle = ReturnType<typeof import("../packages/node-adapters/src/execution/controlled-lifecycle-lease").createControlledLifecycleLease>;
    let lifecycle: Lifecycle | undefined;
    let ready: Parameters<NonNullable<P.Options["captureControlledIngress"]>>[0] | undefined;
    let originalInode: bigint | undefined;
    let stops = 0, retirements = 0;
    const f = await fixture(t, false, undefined, 0, undefined, undefined,
      (original) => { ready = original; },
      async (directory) => {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const { createControlledLifecycleLease } = load(
          "./dist/node-adapters/execution/controlled-lifecycle-lease") as
          typeof import("../packages/node-adapters/src/execution/controlled-lifecycle-lease");
        const { processBirth, buildHash } = load("./queue-instance") as {
          processBirth(pid: number): string; buildHash(): string;
        };
        lifecycle = createControlledLifecycleLease({
          directory, operator: { pid: process.pid, birth: processBirth(process.pid) },
          old: { pid: 42, birth: "456" }, buildHash: buildHash(),
          fence() {},
          async assertQuiescent() {},
          async stopBrokerOnce() { stops++; },
          async assertIngressHeld() {
            assert.ok(fs.existsSync(path.join(directory, "fusion-reset.lock")));
          },
          async retireOldNormally() { retirements++; },
        });
        const lease = await lifecycle.acquireExclusiveLifecycleLease();
        await lease.retireOldNormally({ pid: 42, birth: "456" });
        const marker = record(JSON.parse(fs.readFileSync(path.join(directory, "fusion-reset.lock"), "utf8")));
        originalInode = fs.statSync(path.join(directory, "fusion-reset.lock"), { bigint: true }).ino;
        return { fusionResetNonce: String(marker["nonce"]) };
      });
    assert.ok(ready);
    assert.ok(lifecycle);
    assert.ok(fs.existsSync(path.join(f.dir, "fusion-reset.lock")));
    const transferred = lifecycle.transferToBroker(ready.window, ready.identity);
    assert.equal(fs.existsSync(path.join(f.dir, "fusion-reset.lock")), false);
    assert.equal(fs.statSync(transferred.originalBarrier, { bigint: true }).ino, originalInode);
    const client = await f.client("owned-transfer-operator");
    const status = record(await client.call("control-status"));
    const resumed = record(await client.call("resume", { control: {
      requestId: "owned-transfer-resume", instanceId: status["instanceId"],
      expectedGeneration: status["generation"],
    } }));
    assert.equal(resumed["phase"], "RUNNING");
    ready.activate();
    const ingress = load("./dist/node-adapters/execution/controlled-ingress-window") as
      typeof import("../packages/node-adapters/src/execution/controlled-ingress-window");
    ingress.assertControlledIngressWindow(ready.window, ready.identity);
    assert.equal(stops, 1);
    assert.equal(retirements, 1);
    assert.equal(f.writes(), 0);
  });
const target = { docFileId: "file-A" };

for (const fault of ["throw", "promise", "value"] as const)
test(`real broker capture failure ${fault} closes its listener and revokes the original window`,
  { timeout: 120000 }, async (t) => {
    let directory: string | undefined;
    let captured: Parameters<NonNullable<P.Options["captureControlledIngress"]>>[0] | undefined;
    await assert.rejects(fixture(t, false, undefined, 0, undefined, undefined,
      (ready) => {
        captured = ready;
        if (fault === "throw") throw new Error("Owned synchronous capture failure");
        if (fault === "promise") return Promise.resolve();
        return 1;
      },
      async (dir) => { directory = dir; return {}; }),
      fault === "throw" ? /Owned synchronous capture failure/ : /must be synchronous/);
    assert.ok(directory);
    assert.ok(captured);
    const { queueSocket } = load("./queue-connection") as { queueSocket(dir: string): string };
    assert.equal(fs.existsSync(queueSocket(directory)), false, "rejected serve must close its own listener");
    assert.equal(fs.existsSync(path.join(directory, "broker.lock")), false, "rejected serve must release its owner");
    const ingress = load("./dist/node-adapters/execution/controlled-ingress-window") as
      typeof import("../packages/node-adapters/src/execution/controlled-ingress-window");
    assert.throws(() => ingress.assertControlledIngressTransition(captured!.window, captured!.identity),
      /Original current/);
    assert.throws(() => captured!.activate(), /Original current/);
  });

test("public IPC stays responsive while preparing a guarded continuation",
  // Inspection and acceptance reconstruct the real Python source several times.
  // This is only the fixture budget; the peer IPC assertion stays at 1 second
  // and the actual product worker and wait stay at 45 seconds.
  { timeout: 240000 }, async (t) => {
    const f = await fixture(t, true), client = await f.client("compilation-writer");
    const inspected = record(await client.documentUnlock({
      action: "inspect", target, requestId: "inspect-before-compilation",
    }));
    const accepted = record(await client.documentUnlock({
      action: "accept", target, requestId: "accept-before-compilation",
      observationId: record(inspected["observation"])["observationId"],
    }));
    assert.equal(accepted["state"], "checkpoint_current");
    // Keep the independent exact-source assertion, but prepare the synthetic
    // backend's oracle before timing real broker/worker responsiveness. A real
    // physical backend does not compile a second Python program in its send().
    f.prepareProductOracle();
    const signal = path.join(f.dir, "compilation-start");
    const observer = spawn(process.execPath, ["-e", `
const fs = require("node:fs"), path = require("node:path");
const {request} = require(process.argv[1]), directory = process.argv[2];
const signal = process.argv[3], auth = JSON.parse(process.argv[4]);
const watchdog = setTimeout(() => { console.error("signal never arrived"); process.exit(2); }, 20000);
let started = false;
const watcher = fs.watch(path.dirname(signal), async () => {
  if (started || !fs.existsSync(signal)) return;
  started = true; watcher.close();
  try { await request(directory, {action:"status", auth}, {timeoutMs:1000}); }
  catch (error) { console.error(error.code, error.message); process.exitCode = 1; }
  finally { clearTimeout(watchdog); }
});
process.stdout.write("ready\\n");
`, load.resolve("./queue-connection"), f.dir, signal, JSON.stringify(client.auth)],
      { stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => {
      if (observer.exitCode === null && observer.signalCode === null) observer.kill();
    });
    let stderr = "";
    observer.stderr.on("data", chunk => { stderr += String(chunk); });
    const finished = new Promise<number | null>((resolve, reject) => {
      observer.once("error", reject);
      observer.once("close", resolve);
    });
    await new Promise<void>((resolve, reject) => {
      observer.stdout.once("data", () => resolve());
      observer.once("error", reject);
    });
    f.beforeHistory(() => {
      f.beforeHistory(undefined);
      fs.writeFileSync(signal, "preparing the real guarded source");
    });
    const commands = load("./dist/core/application/cad/worker-command") as
      typeof import("../packages/core/src/application/cad/worker-command");
    const payload = { version: 1, kind: "cad", operation: "param.apply",
      doc: "Owned A", docId: "doc-A", docFileId: "file-A",
      data: { parameters: [{ name: "length", expression: "20 mm" }] } };
    const admitted = await client.submit({
      kind: "command", requestId: "fresh-responsive-continuation", payload,
      cwd: f.dir, timeoutMs: 45000,
      argv: commands.cadWorkerPolicyArguments(commands.decodeCadWorkerInvocation(payload)),
    });
    const completed = await client.wait(admitted.id, { signal: AbortSignal.timeout(45000) });
    assert.equal(completed.job.state, "succeeded", JSON.stringify(completed));
    assert.equal(await finished, 0, stderr);
    assert.equal(f.writes(), 1);
  });

test("public inspection seals a fresh Windows-created receipt without changing its original identity",
  { timeout: 120000 }, async (t) => {
    const f = await fixture(t);
    f.useWindowsReceipts();
    const client = await f.client();
    const result = record(await client.documentUnlock({
      action: "inspect", target, requestId: "fresh-windows-receipt-inspect",
    }));
    assert.equal(result["state"], "inspection_required", JSON.stringify(result));
    assert.equal(typeof record(result["observation"])["observationId"], "string");
    const receipts = f.windowsReceipts();
    assert.equal(receipts.length, 1);
    for (const receipt of receipts) {
      const after = fs.statSync(receipt.file);
      assert.equal(after.mode & 0o7777, 0o600);
      assert.equal(after.ino, receipt.ino);
      assert.equal(hash(fs.readFileSync(receipt.file, "utf8")), receipt.sha256);
    }
    assert.equal(f.counts().products, 1, "No replay while securing original receipt");
  });

test("shared public blocker projection hides foreign and unresolvable jobs without dropping private conflicts", () => {
  const { checkpointDisclosableConflicts } = load("./document-checkpoint-broker") as
    typeof import("../src/document-checkpoint-broker");
  const conflicts = ["owned", "foreign", "unknown-owner"].map((jobId) => ({
    jobId, requestId: `${jobId}-request`, clientId: jobId,
    target: { creationId: "doc-A", fileId: "file-A" },
    jobHash: "a".repeat(64), catalogDigest: "b".repeat(64),
    evidenceReference: "physical:retained", evidenceDigest: "c".repeat(64), binding: {},
  }));
  const visible = checkpointDisclosableConflicts(conflicts, "owner-A", (id) =>
    id === "owned" ? { clientId: "owner-A" } :
      id === "foreign" ? { clientId: "owner-B" } : undefined);
  assert.deepEqual(visible.map((entry) => entry.jobId), ["owned"]);
  assert.equal(conflicts.length, 3, "private conflicts must remain available for the complete admission/CAS");
  assert.equal(JSON.stringify(visible).includes("foreign-request"), false);
});

test("actual status IPC hides a foreign actor's retained conflicting job identifiers",
  { timeout: 60000 }, async (t) => {
    const f = await fixture(t, true), client = await f.client("metadata-reader");
    const owner = await f.client("foreign-owner");
    const owned = record(await owner.documentUnlock({ action: "status", target }));
    assert.equal(JSON.stringify(owned).includes("private-foreign-request"), true,
      "the actual owner can see its retained conflicting request");
    const result = record(await client.documentUnlock({ action: "status", target }));
    assert.equal(result["state"], "inspection_required", JSON.stringify(result));
    assert.deepEqual(result["blockers"], [{ visibility: "operator_only" }]);
    assert.equal(JSON.stringify(result).includes("private-foreign-request"), false);
    const snapshot = JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")) as {
      quarantined: Record<string, unknown>;
    };
    assert.equal(Object.keys(snapshot.quarantined).length, 1,
      "the hidden conflict still exists and gates admission");
  });

test("actual status rejects a raw quarantine relabeled as runtime retirement in persisted data",
  { timeout: 30000 }, async (t) => {
    const f = await fixture(t, "raw-forged"), client = await f.client("foreign-owner");
    const result = record(await client.documentUnlock({ action: "status", target }));
    assert.equal(result["state"], "scope_unproven", JSON.stringify(result));
    assert.equal(result["executionFence"], undefined);
    assert.equal(record(result["next"])["kind"], "operator_action");
    assert.equal(f.writes(), 0);
  });

test("actual authenticated IPC shows the same full observed parameters, fresh accept and historical retry SDK0",
  { timeout: 60000 }, async (t) => {
    const f = await fixture(t), client = await f.client();
    const before = f.counts();
    const status = record(await client.documentUnlock({ action: "status", target }));
    assert.equal(status["state"], "clear");
    assert.deepEqual(f.counts(), before);
    const inspected = record(await client.documentUnlock({
      action: "inspect", target, requestId: "inspect-A",
    }));
    assert.equal(inspected["error"], undefined, JSON.stringify(inspected));
    assert.deepEqual(inspected["observed"], f.checkpoint());
    assert.ok(inspected["observation"], JSON.stringify(inspected));
    const observationId = record(inspected["observation"])["observationId"];
    const afterInspect = f.counts();
    assert.equal(afterInspect.products - before.products, 1);
    const accepted = record(await client.documentUnlock({
      action: "accept", target, requestId: "accept-A", observationId,
    }));
    assert.equal(accepted["state"], "checkpoint_current", JSON.stringify(accepted));
    assert.equal(f.counts().products - afterInspect.products, 1,
      "first accept must execute a fresh complete read, not trust the old digest");
    const beforeRetry = f.counts();
    const retry = record(await client.documentUnlock({
      action: "accept", target, requestId: "accept-A", observationId,
    }));
    assert.equal(record(retry["previousAcceptance"])["currentStateVerified"], false);
    assert.equal(retry["observed"], undefined);
    assert.equal(record(retry["next"])["kind"], "command");
    assert.equal(f.counts().identityCalls, beforeRetry.identityCalls);
    assert.equal(f.counts().products, beforeRetry.products);
    assert.ok(f.counts().queries > beforeRetry.queries,
      "history is authenticated against the original native turn without a CAD probe");
  });

for (const historyCount of [0, 17000]) {
test("actual public IPC routes a fresh accepted continuation through the normal worker and guarded physical source" +
  (historyCount ? ` with retained ${historyCount} completed history` : ""),
  { timeout: historyCount ? 240000 : 120000 }, async (t) => {
    const f = await fixture(t, true, undefined, historyCount), client = await f.client("successor-writer");
    const original = Object.values(record(JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")))["jobs"] as Record<string, unknown>)
      .map(record).find((job) => job["requestId"] === "private-foreign-request");
    assert.ok(original);
    const payload = {
      version: 1, kind: "cad", operation: "param.apply",
      doc: "Owned A", docId: "doc-A", docFileId: "file-A",
      data: { parameters: [{ name: "length", expression: "20 mm" }] },
    };
    const commands = load("./dist/core/application/cad/worker-command") as
      typeof import("../packages/core/src/application/cad/worker-command");
    const input = { kind: "command", payload, cwd: f.dir, timeoutMs: 45000,
      argv: commands.cadWorkerPolicyArguments(commands.decodeCadWorkerInvocation(payload)) };
    const refused = await client.submit({ ...input, requestId: "before-explicit-accept" });
    assert.equal(refused.state, "failed");
    assert.equal(f.writes(), 0);
    const inspected = record(await client.documentUnlock({
      action: "inspect", target, requestId: "inspect-for-worker",
    }));
    assert.equal(inspected["error"], undefined, JSON.stringify(inspected));
    assert.ok(inspected["observation"], JSON.stringify(inspected));
    const observationId = record(inspected["observation"])["observationId"];
    const accepted = record(await client.documentUnlock({
      action: "accept", target, requestId: "accept-for-worker", observationId,
    }));
    assert.equal(accepted["state"], "checkpoint_current", JSON.stringify(accepted));
    const admitted = await client.submit({ ...input, requestId: "fresh-guarded-worker" });
    const completed = await client.wait(admitted.id, { signal: AbortSignal.timeout(45000) });
    assert.equal(completed.job.state, "succeeded", JSON.stringify(completed));
    assert.equal(f.writes(), 1);
    const readback = record(await client.documentUnlock({
      action: "inspect", target, requestId: "readback-after-worker",
    }));
    assert.equal(readback["error"], undefined, JSON.stringify(readback));
    assert.equal(record(readback["observed"])["schema"], "fmcad.param-checkpoint-v1");
    const parameters = record(readback["observed"])["parameters"] as unknown[];
    assert.equal(record(parameters[0])["expression"], "20 mm");
    const after = record(JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")));
    assert.deepEqual(record(after["jobs"])[String(original["id"])], original);
    assert.equal(f.productJobs().includes(String(original["id"])), false, "the original UNKNOWN is never replayed");
  });
}

function metadataInput(directory: string, clientId: string, requestId: string, json = false) {
    const { prepareRequest } = load("./dist/composition/execution-request") as
      typeof import("../src/composition/execution-request");
    const { buildHash } = load("./queue-instance") as { buildHash(): string };
    const request: import("../src/composition/execution-request").AcceptedCommandRequest & {
      kind: "command"; clientId: string; requestId: string; timeoutMs: number;
      backend: "addin"; buildHash: string;
    } = {
      kind: "command" as const, clientId, requestId,
      argv: ["doc", "list", ...(json ? ["--json"] : [])], cwd: directory, timeoutMs: 45000,
      backend: "addin", buildHash: buildHash(), inputFiles: [],
    };
    return { ...request, payload: prepareRequest({ request }).payload };
}
test("public doc list uses one compiler-bound metadata RPC without accepting or replaying historical work",
  { timeout: 120000 }, async (t) => {
    const f = await fixture(t, true), client = await f.client("metadata-reader");
    const before = record(JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")));
    const original = Object.values(record(before["jobs"])).map(record)
      .find((job) => job["requestId"] === "private-foreign-request");
    assert.ok(original);
    const admitted = await client.submit(metadataInput(f.dir, "metadata-reader", "metadata-public-list"));
    assert.ok(["preparing", "queued", "processing"].includes(admitted.state), JSON.stringify(admitted));
    const completed = await client.wait(admitted.id, { signal: AbortSignal.timeout(45000) });
    assert.equal(completed.job.state, "succeeded", JSON.stringify(completed));
    assert.ok(typeof completed.stdout === "string", "the public worker must produce actual stdout");
    assert.match(completed.stdout, /DOC name=Owned A id=file-A creationId=doc-A/);
    assert.equal(f.counts().products, 1);
    assert.equal(f.writes(), 0);
    const after = record(JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")));
    assert.deepEqual(record(after["jobs"])[String(original["id"])], original);
    assert.equal(f.productJobs().includes(String(original["id"])), false);
  });
test("public raw stdout uses private compilation ports, exact scope and the original retired ledger",
  { timeout: 120000 }, async (t) => {
    let ready: Parameters<NonNullable<P.Options["captureControlledIngress"]>>[0] | undefined;
    const { prepareIsolatedStdout } = load("./dist/python/isolated-stdout") as
      typeof import("../packages/node-adapters/src/python/isolated-stdout");
    const f = await fixture(t, true, undefined, 0, undefined, async (_request, pins) => ({
      currentPins: () => ({ ...pins }),
      recheck() {},
      prepareKernel: prepareIsolatedStdout,
      // Physical boundary and host verification are explicit offline fixtures.
      // Real controller/native composition is tested separately, not inferred here.
      verifyHostBindings: () => ({
        proofHash: "a".repeat(64), profileVersion: "isolated-stdout-v1",
      }),
    }), (original) => { ready = original; });
    assert.ok(ready);
    const client = await f.client("controlled-stdout");
    const current = record(await client.call("control-status"));
    const resumed = record(await client.call("resume", { control: {
      requestId: "stdout-supported-resume", instanceId: current["instanceId"],
      expectedGeneration: current["generation"],
    } }));
    assert.equal(resumed["phase"], "RUNNING");
    ready.activate();
    const ingress = load("./dist/node-adapters/execution/controlled-ingress-window") as
      typeof import("../packages/node-adapters/src/execution/controlled-ingress-window");
    ingress.assertControlledIngressWindow(ready.window, ready.identity);
    const before = record(JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")));
    const original = Object.values(record(before["jobs"])).map(record)
      .find((job) => job["requestId"] === "private-foreign-request");
    assert.ok(original);
    const input = {
      kind: "rpc" as const, clientId: "controlled-stdout", requestId: "controlled-stdout-original",
      cwd: f.dir, timeoutMs: 45000, backend: "addin",
      buildHash: runtimeIdentity.buildHash(),
      payload: { jsonrpc: "2.0", id: "stdout-logical", method: "tools/call",
        params: { name: "execute_python",
          arguments: { code: "print('CONTROLLED_STDOUT_MARKER')", persistent: false } } },
    };
    const admitted = await client.submit(input);
    const completed = await client.wait(admitted.id, { signal: AbortSignal.timeout(45000) });
    assert.equal(completed.job.state, "succeeded", JSON.stringify(completed));
    const { responsePath } = load("./dist/node-adapters/persistence/owned-results") as
      typeof import("../packages/node-adapters/src/persistence/owned-results");
    const response = record(JSON.parse(fs.readFileSync(
      responsePath(f.dir, { id: admitted.id, request: { cwd: f.dir } }, "rpc-result.json"), "utf8",
    )));
    assert.equal(response["status"], 200);
    const reply = record(JSON.parse(String(response["raw"])));
    const content = record(reply["result"])["content"];
    assert.ok(Array.isArray(content));
    const result = record(JSON.parse(String(record(content[0])["text"])));
    assert.equal(result["stdout"], "CONTROLLED_STDOUT_MARKER\n",
      "raw RPC publishes stdout inside the original tool response, not the worker stdout channel");
    const duplicate = await client.submit(input);
    assert.equal(duplicate.id, admitted.id);
    assert.equal(f.counts().products, 1);
    ingress.assertControlledIngressWindow(ready.window, ready.identity);
    assert.equal(f.writes(), 0);
    const after = record(JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")));
    assert.deepEqual(record(after["jobs"])[String(original["id"])], original);
  });

test("public controlled stdout refuses a revoked host window before admission and never falls back to raw",
  { timeout: 120000 }, async (t) => {
    let held = true;
    const { prepareIsolatedStdout } = load("./dist/python/isolated-stdout") as
      typeof import("../packages/node-adapters/src/python/isolated-stdout");
    const f = await fixture(t, true, undefined, 0, async (prepared) => {
      const scope = prepared.record.binding["documentScope"];
      if (scope && record(scope)["producer"] === "compiled-python-stdout-v1")
        held = false;
    }, async (_request, pins) => ({
      currentPins: () => ({ ...pins }),
      recheck() {
        if (!held) throw Object.assign(new Error("Controlled host window revoked"), {
          code: "FRESH_HOST_REVOKED", notStarted: true,
        });
      },
      prepareKernel: prepareIsolatedStdout,
      verifyHostBindings: () => ({
        proofHash: "a".repeat(64), profileVersion: "isolated-stdout-v1",
      }),
    }));
    const client = await f.client("controlled-stdout-revoked");
    await assert.rejects(client.submit({
      kind: "rpc", clientId: "controlled-stdout-revoked", requestId: "revoked-stdout",
      cwd: f.dir, timeoutMs: 45000, backend: "addin",
      buildHash: runtimeIdentity.buildHash(),
      payload: { jsonrpc: "2.0", id: "revoked-logical", method: "tools/call",
        params: { name: "execute_python",
          arguments: { code: "print('never-sent')", persistent: false } } },
    }), { code: "FRESH_HOST_REVOKED" });
    assert.equal(f.counts().products, 0);
    assert.equal(f.writes(), 0);
    const after = record(JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")));
    assert.equal(Object.values(record(after["jobs"])).map(record)
      .some((job) => job["requestId"] === "revoked-stdout"), false);
  });

for (const fault of ["pins", "async"] as const)
test(`public controlled stdout rejects ${fault} in the private bootstrap port before admission`,
  { timeout: 120000 }, async (t) => {
    const { prepareIsolatedStdout } = load("./dist/python/isolated-stdout") as
      typeof import("../packages/node-adapters/src/python/isolated-stdout");
    const f = await fixture(t, true, undefined, 0, undefined, async (_request, pins) => ({
      currentPins: () => ({ ...pins, ...(fault === "pins" ? { configHash: "f".repeat(64) } : {}) }),
      // TypeScript void permits async implementations; the runtime must not.
      recheck: fault === "async" ? async () => {} : () => {},
      prepareKernel: prepareIsolatedStdout,
      verifyHostBindings: () => ({
        proofHash: "a".repeat(64), profileVersion: "isolated-stdout-v1",
      }),
    }));
    const clientId = `controlled-port-${fault}`;
    const client = await f.client(clientId);
    await assert.rejects(client.submit({
      kind: "rpc", clientId, requestId: `bad-private-port-${fault}`,
      cwd: f.dir, timeoutMs: 45000, backend: "addin",
      buildHash: runtimeIdentity.buildHash(),
      payload: { jsonrpc: "2.0", id: "unproven-port", method: "tools/call",
        params: { name: "execute_python",
          arguments: { code: "print('never-sent')", persistent: false } } },
    }), { code: fault === "pins" ? "PYTHON_STDOUT_UNPROVEN" : "PYTHON_DIAGNOSTIC_UNPROVEN" });
    assert.equal(f.counts().products, 0);
    assert.equal(f.writes(), 0);
  });

test("parallel identical public protocol submissions retain the original witness and raw turn",
  { timeout: 120000 }, async (t) => {
    let release!: () => void;
    const both = new Promise<void>((resolve) => { release = resolve; });
    let preparations = 0;
    const creation = load("./document-creation-broker") as typeof import("../src/document-creation-broker");
    const factory = creation.createDocumentCreationBroker;
    let releaseAdmissions!: () => void;
    const bothAdmissions = new Promise<void>((resolve) => { releaseAdmissions = resolve; });
    let admissions = 0;
    creation.createDocumentCreationBroker = () => {
      const broker = factory();
      return { ...broker, async prepare(...args) {
        const value = await broker.prepare(...args);
        if (args[0].requestId === "same-original-protocol") {
          admissions++;
          if (admissions === 2) releaseAdmissions();
          await bothAdmissions;
        }
        return value;
      } };
    };
    t.after(() => { creation.createDocumentCreationBroker = factory; });
    const f = await fixture(t, true, undefined, 0, async (prepared) => {
      if (prepared.outgoing.method !== "ping") return;
      preparations++;
      if (preparations === 2) release();
      await both;
    });
    const client = await f.client("protocol-concurrent");
    const input = {
      kind: "rpc" as const, clientId: "protocol-concurrent", requestId: "same-original-protocol",
      cwd: f.dir, timeoutMs: 45000, backend: "addin",
      buildHash: runtimeIdentity.buildHash(),
      payload: { jsonrpc: "2.0", id: "logical-ping", method: "ping" },
    };
    const [first, second] = await Promise.all([client.submit(input), client.submit(input)]);
    assert.equal(preparations, 2, "both independent raw RPCs are prepared before either admission");
    assert.equal(admissions, 2, "both raw flights completed before either domain commit");
    assert.equal(first.id, second.id);
    const completed = await client.wait(first.id, { signal: AbortSignal.timeout(45000) });
    assert.equal(completed.job.state, "succeeded", JSON.stringify(completed));
    const duplicate = await client.submit(input);
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.state, "succeeded");
    const after = record(JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")));
    const stored = record(record(after["jobs"])[first.id]);
    assert.equal(record(stored["dispatch"])["rpcCount"], 1);
    assert.equal(Object.values(record(after["jobs"])).map(record)
      .filter((job) => job["requestId"] === input.requestId).length, 1);
    assert.equal(f.writes(), 0);
  });
for (const method of ["initialize", "notifications/initialized", "tools/list", "ping"]) {
test(`public protocol ${method} crosses retired exposures with one original non-Python RPC`,
  { timeout: 120000 }, async (t) => {
    const { buildHash } = load("./queue-instance") as { buildHash(): string };
    const f = await fixture(t, true), client = await f.client("protocol-owner");
    const before = record(JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")));
    const original = Object.values(record(before["jobs"])).map(record)
      .find((job) => job["requestId"] === "private-foreign-request");
    assert.ok(original);
    const admitted = await client.submit({
      kind: "rpc", clientId: "protocol-owner", requestId: "protocol-initialize",
      cwd: f.dir, timeoutMs: 45000, backend: "addin", buildHash: buildHash(),
      payload: { jsonrpc: "2.0",
        ...(method === "notifications/initialized" ? {} : { id: "caller-protocol" }),
        method, ...(method === "initialize" ?
          { params: { protocolVersion: "2025-06-18", capabilities: {} } } : {}) },
    });
    const completed = await client.wait(admitted.id, { signal: AbortSignal.timeout(45000) });
    assert.equal(completed.job.state, "succeeded", JSON.stringify(completed));
    const after = record(JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")));
    const stored = record(record(after["jobs"])[admitted.id]);
    assert.equal(record(stored["protocolMetadata"])["kind"], "protocol-metadata");
    assert.equal(record(stored["dispatch"])["rpcCount"], 1);
    assert.deepEqual(record(after["jobs"])[String(original["id"])], original);
    assert.equal(f.writes(), 0);
  });
}
test("public metadata cannot authorize a raw quarantine relabeled as runtime retirement",
  { timeout: 120000 }, async (t) => {
    const f = await fixture(t, "raw-forged"), client = await f.client("metadata-unproven");
    const before = record(JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")));
    const original = Object.values(record(before["jobs"])).map(record)
      .find((job) => job["requestId"] === "private-foreign-request");
    assert.ok(original);
    const refused = await client.submit(metadataInput(f.dir, "metadata-unproven", "metadata-unproven-list"));
    assert.equal(refused.state, "failed", JSON.stringify(refused));
    assert.equal(record(record(refused)["operationResult"])["code"], "UNKNOWN_SCOPE_UNPROVEN");
    assert.equal(f.counts().products, 0);
    assert.equal(f.writes(), 0);
    const after = record(JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")));
    assert.deepEqual(record(after["jobs"])[String(original["id"])], original);
  });
test("parallel public metadata JSON reads retain each original compiler-bound RPC",
  { timeout: 180000 }, async (t) => {
    const f = await fixture(t, true);
    const clients = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      f.client(`parallel-metadata-${i}`)));
    const completed = await Promise.all(clients.map(async (client, i) => {
      const admitted = await client.submit(metadataInput(f.dir,
        `parallel-metadata-${i}`, `parallel-metadata-request-${i}`, true));
      return client.wait(admitted.id, { signal: AbortSignal.timeout(120000) });
    }));
    for (const result of completed) {
      assert.equal(result.job.state, "succeeded", JSON.stringify(result));
      assert.deepEqual(JSON.parse(result.stdout!), { success: true, results: [{
        name: "Owned A", id: "file-A", creationId: "doc-A",
        isActive: true, isModified: false, isSaved: true,
      }] });
    }
    assert.equal(f.counts().products, 10);
    assert.equal(f.writes(), 0);
  });
test("parallel public metadata reads survive a retained large completed history",
  { timeout: 240000 }, async (t) => {
    const f = await fixture(t, true, undefined, 17000);
    const clients = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      f.client(`history-metadata-${i}`)));
    const completed = await Promise.all(clients.map(async (client, i) => {
      const input = metadataInput(f.dir, `history-metadata-${i}`, `history-read-${i}`, true);
      input.timeoutMs = 180000;
      const admitted = await client.submit(input);
      return client.wait(admitted.id, { signal: AbortSignal.timeout(180000) });
    }));
    for (const result of completed)
      assert.equal(result.job.state, "succeeded", JSON.stringify(result));
    assert.equal(f.counts().products, 10);
    assert.equal(f.writes(), 0);
  });
test("public metadata JSON crosses the normal worker with native output and one bound read",
  { timeout: 120000 }, async (t) => {
    const f = await fixture(t, true), client = await f.client("metadata-json-reader");
    const admitted = await client.submit(metadataInput(f.dir, "metadata-json-reader", "metadata-public-json", true));
    const completed = await client.wait(admitted.id, { signal: AbortSignal.timeout(45000) });
    assert.equal(completed.job.state, "succeeded", JSON.stringify(completed));
    assert.equal(typeof completed.stdout, "string");
    assert.deepEqual(JSON.parse(completed.stdout!), { success: true, results: [{
      name: "Owned A", id: "file-A", creationId: "doc-A",
      isActive: true, isModified: false, isSaved: true,
    }] });
    assert.equal(f.counts().products, 1);
    assert.equal(f.writes(), 0);
  });
for (const fault of ["program", "wire", "runtime"] as const)
  test(`public metadata refuses changed ${fault} before a physical product RPC`,
    { timeout: 120000 }, async (t) => {
      const f = await fixture(t, true, fault), client = await f.client("metadata-fault");
      const admitted = await client.submit(metadataInput(f.dir, "metadata-fault", `metadata-${fault}`));
      const completed = await client.wait(admitted.id, { signal: AbortSignal.timeout(45000) });
      assert.equal(completed.job.state, "failed", JSON.stringify(completed));
      const outcome = record(record(completed.job)["operationResult"]);
      assert.equal(outcome["code"],
        fault === "program" ? "DOCUMENT_METADATA_READ_UNPROVEN" :
          fault === "wire" ? "PYTHON_ADMISSION_CHANGED" : "BUILD_CHANGED");
      assert.equal(outcome["executionOutcome"], "not_started");
      assert.equal(f.counts().products, 0);
      assert.equal(f.writes(), 0);
      if (fault === "runtime") assert.ok(f.changedRuntimeChecks() > 0);
    });
test("public metadata rejects a forged command entry and never authorizes a global write",
  { timeout: 120000 }, async (t) => {
    const f = await fixture(t, true), client = await f.client("metadata-forged");
    const input = metadataInput(f.dir, "metadata-forged", "metadata-forged-entry");
    const forged = structuredClone(input.payload);
    record(record(forged)["entry"])["target"] = "docCloseCmd";
    await assert.rejects(client.submit({ ...input, payload: forged }),
      { code: "INVALID_COMMAND_PAYLOAD", message: "Legacy worker payload differs from its canonical command" });
    const commands = load("./dist/core/application/cad/worker-command") as
      typeof import("../packages/core/src/application/cad/worker-command");
    const payload = { version: 1, kind: "cad", operation: "param.apply", doc: "Owned A",
      data: { parameters: [{ name: "length", expression: "20 mm" }] } };
    const write = {
      ...input, requestId: "metadata-not-a-global-write", payload, readOnly: true,
      argv: commands.cadWorkerPolicyArguments(commands.decodeCadWorkerInvocation(payload)),
    };
    const refused = await client.submit(write);
    assert.equal(refused.state, "failed");
    assert.equal(record(record(refused)["operationResult"])["code"], "UNKNOWN_SCOPE_UNPROVEN");
    assert.equal(f.counts().products, 0);
    assert.equal(f.writes(), 0);
});

function creationInput(directory: string, clientId: string, requestId: string) {
  const { prepareRequest } = load("./dist/composition/execution-request") as typeof import("../src/composition/execution-request");
  const { buildHash } = load("./queue-instance") as { buildHash(): string };
  const request: import("../src/composition/execution-request").AcceptedCommandRequest & {
    kind: "command"; clientId: string; requestId: string; timeoutMs: number; backend: "addin"; buildHash: string;
  } = {
    kind: "command" as const, clientId, requestId, cwd: directory, timeoutMs: 45000,
    argv: ["doc", "new", "--name", "New bounded document"],
    backend: "addin" as const, buildHash: buildHash(), inputFiles: [],
  };
  return { ...request, payload: prepareRequest({ request }).payload };
}
test("public doc new crosses the actual worker and final wire as one creation service, not metadata",
  { timeout: 120000 }, async (t) => {
    const f = await fixture(t), client = await f.client("creation-owner");
    const admitted = await client.submit(creationInput(f.dir, "creation-owner", "bounded-new"));
    assert.ok(["queued", "preparing", "processing"].includes(admitted.state), JSON.stringify(admitted));
    const completed = await client.wait(admitted.id, { signal: AbortSignal.timeout(45000) });
    assert.equal(completed.job.state, "succeeded", JSON.stringify(completed));
    assert.match(completed.stdout!, /CREATED_DOC name=New bounded document/);
    assert.match(completed.stdout!, /"creationId":"fresh-created-doc"/);
    assert.equal(f.counts().products, 1);
    assert.equal(f.writes(), 1, "one new resource write, not a read-only operation");
  });
test("public doc new refuses current raw UNKNOWN without touching or replaying its original resource",
  { timeout: 120000 }, async (t) => {
    const f = await fixture(t, "raw-forged"), client = await f.client("creation-refused");
    const before = record(JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")));
    const refused = await client.submit(creationInput(f.dir, "creation-refused", "blocked-new"));
    assert.equal(refused.state, "failed");
    assert.equal(record(record(refused)["operationResult"])["code"], "UNKNOWN_SCOPE_UNPROVEN");
    const after = record(JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")));
    for (const [id, job] of Object.entries(record(before["jobs"]))) assert.deepEqual(record(after["jobs"])[id], job);
    assert.equal(f.counts().products, 0);
    assert.equal(f.writes(), 0);
  });
test("public doc new rejects a changed physical generation before creating a document",
  { timeout: 120000 }, async (t) => {
    const f = await fixture(t), client = await f.client("creation-generation");
    f.changeProductGeneration();
    const admitted = await client.submit(creationInput(f.dir, "creation-generation", "wrong-generation-new"));
    const completed = await client.wait(admitted.id, { signal: AbortSignal.timeout(45000) });
    assert.equal(completed.job.state, "failed", JSON.stringify(completed));
    assert.equal(record(record(completed.job)["operationResult"])["code"], "DOCUMENT_STATE_CHANGED");
    assert.equal(f.counts().products, 0);
    assert.equal(f.writes(), 0);
  });
test("parallel identical public doc new submissions retain one original job, marker and physical dispatch",
  { timeout: 120000 }, async (t) => {
    const creation = load("./document-creation-broker") as typeof import("../src/document-creation-broker");
    const factory = creation.createDocumentCreationBroker;
    let release!: () => void;
    const bothPrepared = new Promise<void>((resolve) => { release = resolve; });
    let preparations = 0;
    creation.createDocumentCreationBroker = () => {
      const broker = factory();
      return {
        ...broker,
        async prepare(...args) {
          const program = await broker.prepare(...args);
          if (args[0].requestId === "same-original-new") {
            preparations++;
            if (preparations === 2) release();
            await bothPrepared;
          }
          return program;
        },
      };
    };
    t.after(() => { creation.createDocumentCreationBroker = factory; });
    const f = await fixture(t), client = await f.client("creation-concurrent");
    const input = creationInput(f.dir, "creation-concurrent", "same-original-new");
    const [first, second] = await Promise.all([client.submit(input), client.submit(input)]);
    assert.equal(preparations, 2, "both independent renderer nonces exist before either domain commit");
    assert.equal(first.id, second.id);
    const before = record(JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")));
    const marker = record(record(before["jobs"])[first.id])["documentCreation"];
    const completed = await client.wait(first.id, { signal: AbortSignal.timeout(45000) });
    assert.equal(completed.job.state, "succeeded", JSON.stringify(completed));
    const duplicate = await client.submit(input);
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.state, "succeeded", "terminal original work is never rearmed");
    await assert.rejects(client.submit({ ...input, argv: ["doc", "new", "--name", "Another immutable input"],
      payload: undefined }), { code: "REQUEST_CONFLICT" });
    const after = record(JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")));
    assert.deepEqual(record(record(after["jobs"])[first.id])["documentCreation"], marker);
    assert.equal(f.counts().products, 1);
    assert.equal(f.writes(), 1);
  });

for (const fault of ["generation", "preparation"] as const) {
  test(`accepted continuation refuses ${fault} mismatch before a physical write`,
    { timeout: 120000 }, async (t) => {
      const f = await fixture(t, true), client = await f.client("successor-writer");
      const inspected = record(await client.documentUnlock({
        action: "inspect", target, requestId: `inspect-${fault}`,
      }));
      const accepted = record(await client.documentUnlock({
        action: "accept", target, requestId: `accept-${fault}`,
        observationId: record(inspected["observation"])["observationId"],
      }));
      assert.equal(accepted["state"], "checkpoint_current", JSON.stringify(accepted));
      if (fault === "generation") f.changeProductGeneration();
      else f.removePreparation();
      const payload = {
        version: 1, kind: "cad", operation: "param.apply", doc: "Owned A",
        docId: "doc-A", docFileId: "file-A",
        data: { parameters: [{ name: "length", expression: "20 mm" }] },
      };
      const commands = load("./dist/core/application/cad/worker-command") as
        typeof import("../packages/core/src/application/cad/worker-command");
      const job = await client.submit({
        kind: "command", payload, cwd: f.dir, timeoutMs: 45000, requestId: `refuse-${fault}`,
        argv: commands.cadWorkerPolicyArguments(commands.decodeCadWorkerInvocation(payload)),
      });
      const done = await client.wait(job.id, { signal: AbortSignal.timeout(45000) });
      assert.equal(done.job.state, "failed", JSON.stringify(done));
      assert.equal(f.writes(), 0);
    });
}

test("a checkpoint replaced during submit verification durably binds the refused request ID",
  { timeout: 180000 }, async (t) => {
    const f = await fixture(t, true), client = await f.client("successor-writer");
    async function acceptFresh(suffix: string) {
      const inspected = record(await client.documentUnlock({
        action: "inspect", target, requestId: `inspect-race-${suffix}`,
      }));
      const accepted = record(await client.documentUnlock({
        action: "accept", target, requestId: `accept-race-${suffix}`,
        observationId: record(inspected["observation"])["observationId"],
      }));
      assert.equal(accepted["state"], "checkpoint_current", JSON.stringify(accepted));
    }
    await acceptFresh("before");
    const inspectedDuringAwait = record(await client.documentUnlock({
      action: "inspect", target, requestId: "inspect-race-during-await",
    }));
    assert.equal(inspectedDuringAwait["error"], undefined, JSON.stringify(inspectedDuringAwait));
    const duringAwaitObservationId = record(inspectedDuringAwait["observation"])["observationId"];
    let acceptedDuringSubmitVerification = false;
    f.beforeHistory(async () => {
      f.beforeHistory(undefined);
      const accepted = record(await client.documentUnlock({
        action: "accept", target, requestId: "accept-race-during-await",
        observationId: duringAwaitObservationId,
      }));
      assert.equal(accepted["state"], "checkpoint_current", JSON.stringify(accepted));
      acceptedDuringSubmitVerification = true;
    });
    const payload = {
      version: 1, kind: "cad", operation: "param.apply", doc: "Owned A",
      docId: "doc-A", docFileId: "file-A",
      data: { parameters: [{ name: "length", expression: "20 mm" }] },
    };
    const commands = load("./dist/core/application/cad/worker-command") as
      typeof import("../packages/core/src/application/cad/worker-command");
    const input = {
      kind: "command", payload, cwd: f.dir, timeoutMs: 45000, requestId: "stale-during-await",
      argv: commands.cadWorkerPolicyArguments(commands.decodeCadWorkerInvocation(payload)),
    };
    const refused = await client.submit(input);
    assert.equal(acceptedDuringSubmitVerification, true,
      "the fresh checkpoint must be accepted inside submit verification");
    assert.equal(refused.state, "failed");
    assert.equal(record(refused)["code"], "DOCUMENT_UNLOCK_REQUIRED");
    assert.equal(f.writes(), 0);
    const retry = await client.submit(input);
    assert.equal(retry.id, refused.id);
    assert.equal(retry.state, "failed");
    assert.equal(f.writes(), 0);
    const fresh = await client.submit({ ...input, requestId: "fresh-after-refused-race" });
    const done = await client.wait(fresh.id, { signal: AbortSignal.timeout(45000) });
    assert.equal(done.job.state, "succeeded", JSON.stringify(done));
    assert.equal(f.writes(), 1);
  });

test("fresh accept refuses a real changed readback and preserves the original observation",
  { timeout: 60000 }, async (t) => {
    const f = await fixture(t), client = await f.client();
    const inspected = record(await client.documentUnlock({
      action: "inspect", target, requestId: "inspect-before-change",
    }));
    assert.equal(inspected["error"], undefined, JSON.stringify(inspected));
    const observationId = record(inspected["observation"])["observationId"];
    f.change();
    const result = record(await client.documentUnlock({
      action: "accept", target, requestId: "accept-after-change", observationId,
    }));
    assert.equal(record(result["error"])["code"], "DOCUMENT_STATE_CHANGED");
    assert.equal(result["observed"], undefined);
    const snapshot = JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")) as {
      documentCheckpoints: { observations: Record<string, unknown>; acceptances: Record<string, unknown> };
    };
    assert.ok(snapshot.documentCheckpoints.observations[String(observationId)]);
    assert.deepEqual(snapshot.documentCheckpoints.acceptances, {});
  });

test("foreign actor cannot inspect or reveal a private observation through accept",
  { timeout: 60000 }, async (t) => {
    const f = await fixture(t), owner = await f.client("owner"), foreign = await f.client("foreign");
    const inspected = record(await owner.documentUnlock({
      action: "inspect", target, requestId: "owner-inspect",
    }));
    assert.equal(inspected["error"], undefined, JSON.stringify(inspected));
    const observationId = record(inspected["observation"])["observationId"];
    const before = f.counts();
    const refused = record(await foreign.documentUnlock({
      action: "accept", target, requestId: "foreign-accept", observationId,
    }));
    assert.equal(record(refused["error"])["code"], "NOT_AUTHORIZED");
    assert.equal(refused["observed"], undefined);
    assert.equal(JSON.stringify(refused).includes(String(observationId)), false);
    assert.deepEqual(f.counts(), before);
  });

test("historical acceptance fails closed on missing native history or revoked authorization without CAD SDK",
  { timeout: 60000 }, async (t) => {
    const f = await fixture(t), client = await f.client();
    const inspected = record(await client.documentUnlock({ action: "inspect", target, requestId: "history-inspect" }));
    assert.equal(inspected["error"], undefined, JSON.stringify(inspected));
    const observationId = record(inspected["observation"])["observationId"];
    const command = { action: "accept", target, requestId: "history-accept", observationId };
    assert.equal(record(await client.documentUnlock(command))["state"], "checkpoint_current");
    const before = f.counts();
    f.historyUnknown(true);
    const missing = record(await client.documentUnlock(command));
    assert.equal(record(missing["error"])["code"], "STORAGE_UNAVAILABLE");
    assert.equal(missing["previousAcceptance"], undefined);
    f.historyUnknown(false);
    f.cancelledRead(true);
    const cancelled = record(await client.documentUnlock(command));
    assert.equal(record(cancelled["error"])["code"], "STORAGE_UNAVAILABLE");
    assert.equal(cancelled["previousAcceptance"], undefined);
    assert.equal(cancelled["observed"], undefined);
    f.cancelledRead(false);
    f.revoke(true);
    const revoked = record(await client.documentUnlock(command));
    assert.ok(revoked["error"]);
    assert.equal(revoked["previousAcceptance"], undefined);
    assert.equal(revoked["observed"], undefined);
    assert.equal(f.counts().identityCalls, before.identityCalls);
    assert.equal(f.counts().products, before.products);
  });

test("changed original RPC evidence during native authentication cannot become a verified observation",
  { timeout: 60000 }, async (t) => {
    const f = await fixture(t), client = await f.client();
    const command = { action: "inspect", target, requestId: "original-rpc" };
    const first = record(await client.documentUnlock(command));
    assert.equal(first["error"], undefined, JSON.stringify(first));
    const before = f.counts();
    let changed = false;
    f.beforeHistory(() => {
      f.beforeHistory(undefined);
      const jobs = path.join(f.dir, "jobs");
      const files = fs.readdirSync(jobs).flatMap((job) =>
        fs.readdirSync(path.join(jobs, job)).filter((name) => /^rpc-.*\.json$/.test(name))
          .map((name) => path.join(jobs, job, name)));
      const file = files.find((file) => {
        const rpc = JSON.parse(fs.readFileSync(file, "utf8")) as { binding?: { documentScope?: { operation?: string } } };
        return rpc.binding?.documentScope?.operation === "param.inspect";
      });
      if (!file) return;
      const original = fs.readFileSync(file, "utf8");
      // Even semantically identical edits violate the immutable artifact bytes.
      fs.writeFileSync(file, original + "\n", { mode: 0o600 });
      changed = true;
    });
    const refused = record(await client.documentUnlock(command));
    assert.equal(changed, true, "test must alter the original param.inspect RPC");
    assert.equal(record(refused["error"])["code"], "STORAGE_UNAVAILABLE");
    assert.equal(refused["observed"], undefined);
    assert.equal(refused["observation"], undefined);
    assert.equal(f.counts().products, before.products,
      "an invalid retained producer must fail before a new SDK read");
  });

test("native authorization revoked during asynchronous source verification withholds all readback",
  { timeout: 60000 }, async (t) => {
    const f = await fixture(t), client = await f.client();
    const command = { action: "inspect", target, requestId: "revoked-async" };
    assert.equal(record(await client.documentUnlock(command))["error"], undefined);
    const before = f.counts();
    f.beforeHistory(() => { f.beforeHistory(undefined); f.revoke(true); });
    const refused = record(await client.documentUnlock(command));
    assert.ok(refused["error"]);
    assert.equal(refused["observed"], undefined);
    assert.equal(refused["observation"], undefined);
    assert.equal(f.counts().products, before.products);
  });

test("fresh acceptance revalidates the original RPC after the final asynchronous fresh read",
  { timeout: 60000 }, async (t) => {
    const f = await fixture(t), client = await f.client();
    const inspected = record(await client.documentUnlock({ action: "inspect", target, requestId: "tail-inspect" }));
    assert.equal(inspected["error"], undefined, JSON.stringify(inspected));
    const observationId = record(inspected["observation"])["observationId"];
    const original = fs.readdirSync(path.join(f.dir, "jobs")).flatMap((id) =>
      fs.readdirSync(path.join(f.dir, "jobs", id)).filter((name) => /^rpc-.*\.json$/.test(name))
        .map((name) => path.join(f.dir, "jobs", id, name)))
      .find((file) => fs.readFileSync(file, "utf8").includes('"operation":"param.inspect"'));
    assert.ok(original);
    let removed = false;
    f.beforeHistory(() => {
      if (f.counts().products < 2) return;
      f.beforeHistory(undefined);
      fs.unlinkSync(original);
      removed = true;
    });
    const refused = record(await client.documentUnlock({
      action: "accept", target, requestId: "tail-accept", observationId,
    }));
    assert.equal(removed, true, "the original RPC must disappear while the fresh read is awaiting native history");
    assert.equal(refused["state"] === "checkpoint_current", false);
    assert.ok(refused["error"], JSON.stringify(refused));
    assert.equal(refused["observed"], undefined);
    const state = JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")) as {
      documentCheckpoints: { acceptances: Record<string, unknown> };
    };
    assert.deepEqual(state.documentCheckpoints.acceptances, {});
  });

test("cancelled-before-sdk history cannot attest that the retained checkpoint read executed",
  { timeout: 60000 }, async (t) => {
    const f = await fixture(t), client = await f.client();
    const command = { action: "inspect", target, requestId: "cancelled-history" };
    assert.equal(record(await client.documentUnlock(command))["error"], undefined);
    f.cancelledRead(true);
    const refused = record(await client.documentUnlock(command));
    assert.equal(refused["observed"], undefined);
    assert.ok(refused["error"], JSON.stringify(refused));
  });

test("an older acceptance with identical parameters is not the current checkpoint head",
  { timeout: 120000 }, async (t) => {
    const f = await fixture(t), client = await f.client();
    const firstCommand = { action: "inspect", target, requestId: "old-head-inspect" };
    const first = record(await client.documentUnlock(firstCommand));
    assert.equal(first["error"], undefined, JSON.stringify(first));
    const firstObservation = record(first["observation"])["observationId"];
    assert.equal(record(await client.documentUnlock({
      action: "accept", target, requestId: "old-head-accept", observationId: firstObservation,
    }))["state"], "checkpoint_current");
    const second = record(await client.documentUnlock({
      action: "inspect", target, requestId: "new-head-inspect",
    }));
    assert.equal(second["error"], undefined, JSON.stringify(second));
    const secondObservation = record(second["observation"])["observationId"];
    assert.equal(record(await client.documentUnlock({
      action: "accept", target, requestId: "new-head-accept", observationId: secondObservation,
    }))["state"], "checkpoint_current");
    const old = record(await client.documentUnlock(firstCommand));
    assert.equal(old["error"], undefined, JSON.stringify(old));
    assert.equal(old["state"], "inspection_required");
    assert.notEqual(record(old["next"])["kind"], "continue");
  });

test("client resolves despite an outcome-record write failure after a dispatched private read",
  { timeout: 60000 }, async (t) => {
    if (process.env["FMCAD_CHECKPOINT_OUTCOME_FAULT_CHILD"] !== "1") {
      const env: NodeJS.ProcessEnv = { ...process.env, FMCAD_CHECKPOINT_OUTCOME_FAULT_CHILD: "1" };
      delete env["NODE_TEST_CONTEXT"];
      const child = spawnSync(process.execPath, [
        "--test", "--test-name-pattern=client resolves despite an outcome-record", __filename,
      ], {
        env,
        encoding: "utf8", timeout: 50000,
      });
      const owned = /CHECKPOINT_FAULT_HOME (\/tmp\/opencode\/checkpoint-broker-[A-Za-z0-9]+)/.exec(child.stdout);
      if (owned) fs.rmSync(owned[1]!, { recursive: true, force: true });
      assert.equal(child.error, undefined, child.stderr || child.stdout);
      assert.equal(child.status, 0, child.stderr || child.stdout);
      assert.ok(owned, "child must actually run the filesystem fault and disclose its owned fixture: " + child.stdout);
      assert.ok(child.stdout.includes("CHECKPOINT_FAULT_REFUSED"), child.stdout);
      return;
    }
    const f = await fixture(t), client = await f.client();
    process.stdout.write(`CHECKPOINT_FAULT_HOME ${path.dirname(path.dirname(f.dir))}\n`);
    try {
    f.failOutcome();
    const result = record(await client.documentUnlock({
      action: "inspect", target, requestId: "fault-outcome",
    }));
    assert.ok(result["error"], JSON.stringify(result));
    assert.equal(result["observed"], undefined);
    assert.equal(f.counts().products, 1);
    const jobs = path.join(f.dir, "jobs");
    assert.ok(fs.readdirSync(jobs).some((id) =>
      fs.statSync(path.join(jobs, id, "outcome.json")).isDirectory()));
    const deadline = Date.now() + 1000;
    let snapshot: { blocked?: { id: string }; quarantined?: Record<string, unknown>; jobs: Record<string, { state: string }> };
    do {
      snapshot = JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")) as typeof snapshot;
      if (snapshot.blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    } while (Date.now() < deadline);
    process.stdout.write(`CHECKPOINT_FAULT_HOLD ${JSON.stringify({
      blocked: snapshot.blocked ?? null, states: Object.values(snapshot.jobs).map((job) => job.state),
    })}\n`);
    assert.ok(snapshot.blocked, "the existing scheduler must durably hold the unresolved original read");
    const originalId = snapshot.blocked.id;
    assert.equal(snapshot.jobs[originalId]?.state, "needs_reconciliation");
    const recoveryDeadline = Date.now() + 3000;
    while (!snapshot.quarantined?.[originalId] && Date.now() < recoveryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      snapshot = JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")) as typeof snapshot;
    }
    assert.ok(snapshot.quarantined?.[originalId],
      "the existing recovery path must authenticate the original release and preserve its UNKNOWN exposure");
    assert.equal(snapshot.jobs[originalId]?.state, "needs_reconciliation");
    f.failOutcome(false);
    const following = record(await client.documentUnlock({
      action: "inspect", target, requestId: "fresh-after-outcome-failure",
    }));
    assert.equal(following["error"], undefined, JSON.stringify(following));
    assert.equal(following["state"], "inspection_required");
    assert.equal(f.counts().products, 2, "a fresh explicit inspection may run after the original SDK turn is fenced");
    assert.deepEqual(f.productJobs().filter((id) => id === originalId), [originalId],
      "the original unknown request must never be replayed");
    assert.equal(new Set(f.productJobs()).size, 2);
    process.stdout.write("CHECKPOINT_FAULT_REFUSED\n");
    // Simulate process loss with retained UNKNOWN state, not successful cleanup.
    // This child owns all its resources; the parent preserves the terminal result.
    process.exit(0);
    } catch (error) {
      process.stderr.write(String(error) + "\n");
      process.exit(1);
    }
  });
