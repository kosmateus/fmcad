import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
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

/** Actual compiled broker, IPC, client preparation, checker and persistence.
 * Only the physical boundary/receipts are synthetic; no Fusion/native SDK runs. */
async function fixture(t: TestContext, foreignConflict: boolean | "raw-forged" = false,
  metadataFault?: "program" | "wire") {
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
  physical._post = async (payload) => {
    if (payload.method === "initialize")
      return { status: 200, raw: JSON.stringify({ jsonrpc: "2.0", id: payload.id,
        result: { protocolVersion: "2025-06-18" } }) };
    if (payload.method === "notifications/initialized") return { status: 202, raw: "" };
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
        }>;
      };
      const continuation = snapshot.jobs[snapshot.active]?.documentContinuation;
      const metadata = snapshot.jobs[snapshot.active]?.documentMetadataRead;
      if (metadata) {
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
        const compiler = load("./dist/composition/cad") as typeof import("../src/composition/cad");
        const guarded = compiler.prepareCadScript("param.apply",
          { parameters: [{ expression: "20 mm", name: "length" }] },
          { doc: "Owned A", docId: "doc-A", docFileId: "file-A", preview: false }, undefined, checkpoint());
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
    if (broker) fs.rmSync(home, { recursive: true, force: true });
  });
  try { broker = await serve(cfg, {
    dir, confirmOwnership: true, pollMs: 5, createBackend: () => physical,
    nativePath: (file) => file,
    testCheckPrepared(prepared) {
      const scope = prepared.record.binding["documentScope"];
      if (metadataFault !== "wire" ||
          !scope || typeof scope !== "object" || Array.isArray(scope) ||
          record(scope)["producer"] !== "compiled-document-metadata-v1")
        return;
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
        physicalRuntime: { ...instance, source: "fixture-source", build: "fixture-build" },
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
const target = { docFileId: "file-A" };

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

test("actual public IPC routes a fresh accepted continuation through the normal worker and guarded physical source",
  { timeout: 120000 }, async (t) => {
    const f = await fixture(t, true), client = await f.client("successor-writer");
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

function metadataInput(directory: string, clientId: string, requestId: string) {
    const { prepareRequest } = load("./dist/composition/execution-request") as
      typeof import("../src/composition/execution-request");
    const { buildHash } = load("./queue-instance") as { buildHash(): string };
    const request: import("../src/composition/execution-request").AcceptedCommandRequest & {
      kind: "command"; clientId: string; requestId: string; timeoutMs: number;
      backend: "addin"; buildHash: string;
    } = {
      kind: "command" as const, clientId, requestId,
      argv: ["doc", "list"], cwd: directory, timeoutMs: 45000,
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
for (const fault of ["program", "wire"] as const)
  test(`public metadata refuses changed ${fault} before a physical product RPC`,
    { timeout: 120000 }, async (t) => {
      const f = await fixture(t, true, fault), client = await f.client("metadata-fault");
      const admitted = await client.submit(metadataInput(f.dir, "metadata-fault", `metadata-${fault}`));
      const completed = await client.wait(admitted.id, { signal: AbortSignal.timeout(45000) });
      assert.equal(completed.job.state, "failed", JSON.stringify(completed));
      const outcome = record(record(completed.job)["operationResult"]);
      assert.equal(outcome["code"],
        fault === "program" ? "DOCUMENT_METADATA_READ_UNPROVEN" : "PYTHON_ADMISSION_CHANGED");
      assert.equal(outcome["executionOutcome"], "not_started");
      assert.equal(f.counts().products, 0);
      assert.equal(f.writes(), 0);
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
    f.beforeHistory(async () => {
      f.beforeHistory(undefined);
      await acceptFresh("during-await");
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
