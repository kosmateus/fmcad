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
const fixtures = createRequire(path.join(runtime, "tests/fixture-loader.cjs"));
const { nativeReceipts } = fixtures("./fixtures/native-source-envelope.cjs") as {
  nativeReceipts(source: string, root: string, instance: unknown): { file: string; value: Record<string, unknown> }[];
};
const releasedProof = fixtures("./fixtures/physical-turn-fixture.cjs") as
  (binding: P.PhysicalTurnBinding) => P.PhysicalTurnQuiescence;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Actual compiled broker, IPC, client preparation, checker and persistence.
 * Only the physical boundary/receipts are synthetic; no Fusion/native SDK runs. */
async function fixture(t: TestContext, foreignConflict = false) {
  const home = fs.mkdtempSync("/tmp/opencode/checkpoint-broker-");
  const previous = process.env["XDG_STATE_HOME"], cwd = process.cwd();
  process.env["XDG_STATE_HOME"] = home;
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
  let expression = "10 mm", identityCalls = 0, products = 0, queries = 0;
  let unknownHistory = false, revoked = false, wrongReply = false;
  let cancelledRead = false;
  let failOutcome = false;
  let beforeHistory: (() => void) | undefined;
  const released = new Set<string>();
  const clients: QueueClient[] = [];
  if (foreignConflict) {
    const { openIsolatedEpoch } = load("./queue-isolated-epoch") as typeof import("../src/queue-isolated-epoch");
    const state = openIsolatedEpoch(dir, { recover: false });
    const submitted = state.submit({
      kind: "command", clientId: "foreign-owner", requestId: "private-foreign-request",
      argv: ["param", "apply", "--doc-id", "doc-A", "--doc-file-id", "file-A"],
      cwd: home, timeoutMs: 15000,
    });
    const jobId = String(submitted["id"]);
    state.next();
    const job = state.data.jobs[jobId]!;
    const request: P.PhysicalTurnRequest = {
      kind: "system-read", brokerNonce: "fixture-foreign-owner", jobId,
      requestId: job.requestId, clientId: job.clientId, requestHash: job.hash,
      grantGeneration: 1, physicalRequestId: "foreign-physical-read",
      documentSelector: { creationId: "doc-A", fileId: "file-A" },
    };
    const binding: P.PhysicalTurnBinding = {
      version: 1, generation: { epoch: "epoch-A", instance: "generation-A" },
      grantDigest: hash("isolated-private-fixture-grant"),
      physicalRuntime: { pid: instance.pid, birth: instance.birth, version: instance.version,
        source: "fixture-source", build: "fixture-build" },
      turnId: request.physicalRequestId, target: JSON.stringify(request.documentSelector),
    };
    const body = { request, physical: binding, target: { creationId: "doc-A", fileId: "file-A" }, catalogIndex: 1 };
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
  }
  function checkpoint() {
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
  const physical = createBrokerTransport(cfg, {
    version: "test", requestTimeout: (server: { timeoutMs: number }) => server.timeoutMs,
    bridgeSource: () => { throw Error("No bridge in checkpoint fixture"); },
  });
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
    for (const entry of receipts)
      fs.writeFileSync(entry.file, JSON.stringify(entry.value), { mode: 0o600 });
    let stdout: string;
    if (probe) {
      identityCalls++;
      stdout = "FMCAD_QUEUE_INSTANCE " + JSON.stringify(observed);
    } else {
      products++;
      assert.ok(script!.includes("result = _cad_param_checkpoint(ctx)"),
        "owned unlock read must execute the actual private compiler callback");
      stdout = "FMCAD_RESULT " + JSON.stringify({
        success: true, operation: "param.inspect", result: failOutcome ? {} : checkpoint(), created: [],
      });
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
    }
    if (broker) fs.rmSync(home, { recursive: true, force: true });
  });
  try { broker = await serve(cfg, {
    dir, confirmOwnership: true, pollMs: 5, createBackend: () => physical,
    nativePath: (file) => file,
    bindPhysicalTurn(request) {
      if (revoked) throw Object.assign(new Error("native grant revoked"), { code: "PHYSICAL_GENERATION_REJECTED" });
      return {
        version: 1, generation: { epoch: "epoch-A", instance: "generation-A" },
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
      beforeHistory?.();
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
    dir, checkpoint, counts: () => ({ identityCalls, products, queries }),
    change() { expression = "20 mm"; },
    historyUnknown(value: boolean) { unknownHistory = value; },
    cancelledRead(value: boolean) { cancelledRead = value; },
    failOutcome() { failOutcome = true; },
    revoke(value: boolean) { revoked = value; },
    wrongReply() { wrongReply = true; },
    beforeHistory(value: (() => void) | undefined) { beforeHistory = value; },
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
    assert.equal(result["state"], "scope_unproven", JSON.stringify(result));
    assert.deepEqual(result["blockers"], [{ visibility: "operator_only" }]);
    assert.equal(JSON.stringify(result).includes("private-foreign-request"), false);
    const snapshot = JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")) as {
      quarantined: Record<string, unknown>;
    };
    assert.equal(Object.keys(snapshot.quarantined).length, 1,
      "the hidden conflict still exists and gates admission");
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
    process.stdout.write("CHECKPOINT_FAULT_REFUSED\n");
    // Simulate process loss with retained UNKNOWN state, not successful cleanup.
    // This child owns all its resources; the parent preserves the terminal result.
    process.exit(0);
  });
