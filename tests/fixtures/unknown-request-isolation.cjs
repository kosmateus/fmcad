"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createHash } = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const fixture = require("./python-admission-broker.cjs");
const root = path.resolve(__dirname, "../..");
const { inputFiles } = require(path.join(root, "dist/src/queue-client"));
const evidenceRoot = fs.mkdtempSync("/tmp/opencode/unknown-isolation-");
require(
  path.join(root, "dist/tests/runtime-test-environment"),
).isolateRuntimeTestEnvironment(evidenceRoot);
let quarantinedSnapshot;
const bindPhysicalTurn = (request) => ({
  version: 1,
  grantDigest: "a".repeat(64),
  generation: { instance: "fixture", epoch: "one" },
  physicalRuntime: {
    pid: 991,
    birth: "synthetic:991",
    version: "fixture",
    source: "fixture",
    build: "fixture",
  },
  turnId: request.physicalRequestId,
  target: JSON.stringify(
    request.documentSelector ?? null,
    Object.keys(request.documentSelector ?? {}).sort(),
  ),
});
function releasedProof(binding) {
  const evidenceDigest = createHash("sha256")
    .update(JSON.stringify(binding))
    .digest("hex");
  return {
    state: "released",
    binding,
    evidenceDigest,
    physicalEvidenceReference: "fmcad-physical-turn:sha256:" + evidenceDigest,
  };
}

test("a released UNKNOWN turn quarantines its document without blocking another process and document", async (t) => {
  let proofState = "active";
  const observedProofs = new Set();
  const physicalScope = new AsyncLocalStorage();
  const sentTurns = new Set();
  const f = await fixture(t, {
    typedService: true,
    bindPhysicalTurn,
    withPhysicalTurn: async (binding, send) => physicalScope.run(binding, send),
    observeProtocol: async (payload) => {
      if (payload.method !== "tools/call") return;
      const binding = physicalScope.getStore();
      assert(
        binding,
        "every SDK POST, including startup/preflight, requires explicit physical scope",
      );
      assert(
        !sentTurns.has(binding.turnId),
        "one ID per physical SDK dispatch",
      );
      sentTurns.add(binding.turnId);
    },
    physicalTurnQuiescence: async (binding) => {
      observedProofs.add(proofState);
      if (["active", "unknown"].includes(proofState))
        return { state: proofState, binding };
      const evidenceDigest = createHash("sha256")
        .update(JSON.stringify(binding))
        .digest("hex");
      return {
        state: "released",
        binding:
          proofState === "foreign-grant"
            ? { ...binding, grantDigest: "b".repeat(64) }
            : proofState === "foreign-target"
              ? { ...binding, target: '{"creationId":"OTHER"}' }
              : proofState === "foreign-turn"
                ? { ...binding, turnId: "other-original-request" }
                : proofState === "foreign-generation"
                  ? {
                      ...binding,
                      generation: { ...binding.generation, epoch: "other" },
                    }
                  : binding,
        physicalEvidenceReference:
          proofState === "bad-reference"
            ? "not-physical-evidence"
            : "fmcad-physical-turn:sha256:" + evidenceDigest,
        evidenceDigest:
          proofState === "bad-digest" ? "invalid" : evidenceDigest,
      };
    },
  });
  const a = await f.client("unknown-owner-a");
  const source = f.script(
    "isolation.py",
    'def run(context: str) -> None:\n    print("ISOLATION")\n',
  );
  f.observeProduct(async () => {
    throw Object.assign(
      new Error("Synthetic lost reply after physical handler returned"),
      { code: "ECONNRESET" },
    );
  });
  const argv = ["run", source, "--doc", "A", "--doc-id", "A"];
  const originalRequest = {
    kind: "command",
    requestId: "unknown-original-a",
    argv,
    cwd: f.home,
    backend: "addin",
    timeoutMs: 120000,
    inputFiles: inputFiles(argv, f.home),
  };
  const accepted = await a.submit(originalRequest);
  const unknown = await a.wait(accepted.id);
  assert.equal(
    unknown.job.state,
    "needs_reconciliation",
    JSON.stringify(unknown),
  );
  assert.equal(unknown.job.operationResult.executionOutcome, "unknown");
  const before = JSON.parse(
    fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8"),
  ).jobs[accepted.id];
  const jobDirectory = path.join(f.dir, "jobs", accepted.id);
  const originalIntents = Object.fromEntries(
    fs
      .readdirSync(jobDirectory)
      .filter((name) => /^rpc-.*\.json$/.test(name))
      .map((name) => {
        const bytes = fs.readFileSync(path.join(jobDirectory, name));
        const intent = JSON.parse(bytes);
        assert.equal(intent.binding.physicalTurn.turnId, intent.binding.rpcId);
        assert.equal(intent.binding.physicalTurn.version, 1);
        assert.equal(
          intent.binding.physicalTurn.target,
          '{"creationId":"A","name":"A"}',
        );
        assert.deepEqual(
          Object.keys(intent.binding.physicalTurn).sort(),
          [
            "version",
            "grantDigest",
            "generation",
            "physicalRuntime",
            "turnId",
            "target",
          ].sort(),
        );
        return [name, createHash("sha256").update(bytes).digest("hex")];
      }),
  );
  assert.equal(Object.keys(originalIntents).length, 1);
  assert.equal(f.products(), 1);
  f.observeProduct(async () => {});
  f.documentIdentity("B");
  const child = `
    const assert=require('node:assert/strict');
    const {QueueClient,inputFiles}=require(${JSON.stringify(path.join(root, "dist/src/queue-client"))});
    (async()=>{
      const client=new QueueClient('independent-owner-b',{cfg:JSON.parse(process.env.ISOLATION_CFG)});
      try {
        await client.register();
        const argv=['run',${JSON.stringify(source)},'--doc','B','--doc-id','B'];
        const job=await client.submit({kind:'command',requestId:'independent-b',argv,cwd:${JSON.stringify(f.home)},
          backend:'addin',timeoutMs:120000,inputFiles:inputFiles(argv,${JSON.stringify(f.home)})});
        const result=await client.wait(job.id);
        assert.equal(result.job.state,'succeeded',JSON.stringify(result));
        console.log('INDEPENDENT_B_PASS');
      }finally{client.dispose();}
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  const independent = promisify(execFile)(process.execPath, ["-e", child], {
    env: { ...process.env, ISOLATION_CFG: JSON.stringify(f.cfg) },
    cwd: f.home,
    timeout: 30000,
  });
  async function until(check, message) {
    const deadline = Date.now() + 5000;
    while (!check()) {
      assert(Date.now() < deadline, message);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  for (const state of [
    "active",
    "unknown",
    "foreign-grant",
    "foreign-target",
    "foreign-turn",
    "foreign-generation",
    "bad-reference",
    "bad-digest",
  ]) {
    proofState = state;
    await until(
      () => observedProofs.has(state),
      "broker must inspect " + state,
    );
    assert.equal(f.products(), 1, state + " cannot release another mutation");
  }
  proofState = "released";
  const result = await independent;
  assert.match(result.stdout, /INDEPENDENT_B_PASS/);
  const after = await a.wait(accepted.id);
  assert.equal(after.job.state, "needs_reconciliation");
  assert.equal(after.job.operationResult.executionOutcome, "unknown");
  const retained = JSON.parse(
    fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8"),
  ).jobs[accepted.id];
  assert.equal(retained.hash, before.hash);
  assert.equal(retained.requestId, before.requestId);
  for (const [name, digest] of Object.entries(originalIntents))
    assert.equal(
      createHash("sha256")
        .update(fs.readFileSync(path.join(jobDirectory, name)))
        .digest("hex"),
      digest,
      "quarantine must not rewrite original physical intent or receipt bindings",
    );
  assert.equal(
    (await a.submit(originalRequest)).id,
    accepted.id,
    "request ID reuse observes the original without replay",
  );
  const conflict = await a.submit({
    ...originalRequest,
    requestId: "conflicting-a",
    queueTimeoutMs: 250,
  });
  assert.equal(
    (await a.wait(conflict.id)).job.state,
    "expired",
    "same exact resource stays quarantined",
  );
  assert.equal(f.products(), 2, "original UNKNOWN is never replayed");
  assert.equal(f.maximum(), 1);
  quarantinedSnapshot = JSON.parse(
    fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8"),
  );
  fs.writeFileSync(
    path.join(evidenceRoot, "quarantined-snapshot.json"),
    JSON.stringify(quarantinedSnapshot),
    { mode: 0o600 },
  );
  const retainedDirectory = path.join(evidenceRoot, "original-a");
  fs.mkdirSync(retainedDirectory);
  for (const name of Object.keys(originalIntents))
    fs.copyFileSync(
      path.join(jobDirectory, name),
      path.join(retainedDirectory, name),
    );
  t.diagnostic(
    "UNKNOWN snapshot and unchanged original intents retained: " + evidenceRoot,
  );
});

test("an UNKNOWN with a still-running physical handler cannot admit another mutation", async (t) => {
  let handlerActive = false,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const physicalScope = new AsyncLocalStorage();
  const f = await fixture(t, {
    typedService: true,
    bindPhysicalTurn,
    withPhysicalTurn: async (binding, send) => physicalScope.run(binding, send),
    observeProtocol: async (payload) => {
      if (payload.method === "tools/call")
        assert(physicalScope.getStore(), "read-only SDK calls also need scope");
    },
    physicalTurnQuiescence: async (binding) =>
      handlerActive ? { state: "active", binding } : releasedProof(binding),
  });
  const a = await f.client("active-owner-a");
  const b = await f.client("active-independent-b");
  const source = f.script(
    "active.py",
    'def run(context: str) -> None:\n    print("ACTIVE")\n',
  );
  f.observeProduct(async () => {
    handlerActive = true;
    try {
      await gate;
    } finally {
      handlerActive = false;
    }
    throw Object.assign(new Error("Synthetic late reply lost"), {
      code: "ECONNRESET",
    });
  });
  const argv = ["run", source, "--doc", "A", "--doc-id", "A"];
  try {
    const accepted = await a.submit({
      kind: "command",
      requestId: "active-original-a",
      argv,
      cwd: f.home,
      backend: "addin",
      timeoutMs: 15000,
      inputFiles: inputFiles(argv, f.home),
    });
    const unknown = await a.wait(accepted.id);
    assert.equal(unknown.job.state, "needs_reconciliation");
    assert.equal(
      handlerActive,
      true,
      "the physical handler is actually still running",
    );
    const otherArgv = ["run", source, "--doc", "B", "--doc-id", "B"];
    const other = await b.submit({
      kind: "command",
      requestId: "must-not-overlap",
      argv: otherArgv,
      cwd: f.home,
      backend: "addin",
      timeoutMs: 120000,
      queueTimeoutMs: 250,
      inputFiles: inputFiles(otherArgv, f.home),
    });
    assert.equal((await b.wait(other.id)).job.state, "expired");
    assert.equal(f.products(), 1);
    assert.equal(f.maximum(), 1);
    release();
    const deadline = Date.now() + 5000;
    while (
      !JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8"))
        .quarantined?.[accepted.id]
    ) {
      assert(
        Date.now() < deadline,
        "release evidence must eventually quarantine, not settle, the original",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await a.wait(accepted.id)).job.state, "needs_reconciliation");
  } finally {
    release();
  }
});

test("restoration preserves UNKNOWN quarantine and permits only independently pinned documents", () => {
  assert(
    quarantinedSnapshot,
    "public broker scenario must publish durable quarantine",
  );
  const { QueueDomain } = require(
    path.join(root, "dist/packages/core/src/domain/queue"),
  );
  const restore = (snapshot) =>
    new QueueDomain({
      snapshot,
      now: Date.now,
      newId: require("node:crypto").randomUUID,
      hash: (text) => createHash("sha256").update(text).digest("hex"),
    });
  const restored = restore(quarantinedSnapshot);
  const original = Object.values(quarantinedSnapshot.jobs).find(
    (job) => job.requestId === "unknown-original-a",
  );
  assert.equal(restored.status(original.id).state, "needs_reconciliation");
  const submit = (id, doc) =>
    restored.submit({
      kind: "command",
      clientId: "restored-owner",
      requestId: id,
      timeoutMs: 1000,
      cwd: root,
      argv: ["run", "fixture.py", "--doc", doc, "--doc-id", doc],
    });
  const conflict = submit("restored-conflict", "A");
  const independent = submit("restored-independent", "C");
  assert.equal(restored.next().id, independent.id);
  assert.equal(restored.status(conflict.id).state, "queued");
  assert.equal(restored.status(original.id).state, "needs_reconciliation");
  const altered = structuredClone(quarantinedSnapshot);
  altered.quarantined[original.id].jobHash = "wrong-original-request";
  assert.throws(() => restore(altered), { code: "CORRUPT_STATE" });
  const fileQueue = new QueueDomain({
    now: Date.now, newId: require("node:crypto").randomUUID,
    hash: text => createHash("sha256").update(text).digest("hex"),
  });
  const metadata = (id, fileId, version = 1) => fileQueue.submit({
    kind: "rpc", clientId: "file-owner", requestId: id, timeoutMs: 1000,
    payload: {jsonrpc: "2.0", id, method: "tools/call",
      params: {name: "get_open_document_metadata", arguments: {fileId, version}}},
  });
  const fileA = metadata("file-a", "DataFile-A");
  fileQueue.next();
  fileQueue.block(fileA.id, "synthetic UNKNOWN for domain policy");
  const job = fileQueue.data.jobs[fileA.id];
  fileQueue.quarantineUnknown(job.id, {
    jobId: job.id, requestId: job.requestId, clientId: job.clientId, jobHash: job.hash,
    target: {fileId: "DataFile-A"},
    evidenceDigest: "c".repeat(64), evidenceReference: "fmcad-physical-turn:sha256:" + "c".repeat(64),
    binding: {jobId: job.id, requestId: job.requestId, clientId: job.clientId, requestHash: job.hash},
  });
  const alias = metadata("same-file-new-version", "DataFile-A", 2);
  const otherFile = metadata("other-file", "DataFile-B");
  assert.equal(fileQueue.next().id, otherFile.id);
  assert.equal(fileQueue.status(alias.id).state, "queued", "a version change does not evade the DataFile conflict");
});

test("physical generation provisioning failure releases only its uninitialized owner and sends zero SDK", async (t) => {
  const dir = fs.mkdtempSync("/tmp/opencode/unknown-isolation-provision-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { serve } = require(path.join(root, "dist/src/queue-broker"));
  let constructed = 0;
  await assert.rejects(
    serve(
      { backend: "addin", timeoutMs: 1000 },
      {
        dir,
        confirmOwnership: true,
        preparePhysicalGeneration: async (claim) => {
          assert.equal(claim.directory, dir);
          assert.equal(claim.owner.pid, process.pid);
          assert.equal(typeof claim.owner.nonce, "string");
          throw Object.assign(
            new Error("Synthetic generation provisioning refused"),
            { code: "TEST_PROVISION_REFUSED" },
          );
        },
        createBackend: () => {
          constructed++;
          assert.fail("no physical client before provisioning");
        },
      },
    ),
    { code: "TEST_PROVISION_REFUSED" },
  );
  assert.equal(constructed, 0);
  assert.equal(fs.existsSync(path.join(dir, "broker.lock")), false);
});

test("an UNKNOWN local workflow after a settled SDK turn does not become a global control hold", async (t) => {
  const physicalScope = new AsyncLocalStorage();
  const f = await fixture(t, {
    typedService: true,
    unknownLocalOutcome: true,
    bindPhysicalTurn,
    withPhysicalTurn: async (binding, send) => physicalScope.run(binding, send),
    physicalTurnQuiescence: async (binding) => releasedProof(binding),
    observeProtocol: async (payload) => {
      if (payload.method === "tools/call") assert(physicalScope.getStore());
    },
  });
  const a = await f.client("local-unknown-a");
  const b = await f.client("local-independent-b");
  const sourceA = f.script(
    "local-a.py",
    '# LOCAL_UNKNOWN\ndef run(context: str) -> None:\n    print("LOCAL_UNKNOWN")\n',
  );
  const sourceB = f.script(
    "local-b.py",
    'def run(context: str) -> None:\n    print("INDEPENDENT")\n',
  );
  const submit = (client, id, source, doc) => {
    const argv = ["run", source, "--doc", doc, "--doc-id", doc];
    return client.submit({
      kind: "command",
      requestId: id,
      argv,
      cwd: f.home,
      backend: "addin",
      timeoutMs: 120000,
      inputFiles: inputFiles(argv, f.home),
    });
  };
  const original = await submit(a, "local-workflow-a", sourceA, "A");
  const unknown = await a.wait(original.id);
  assert.equal(
    unknown.job.state,
    "needs_reconciliation",
    JSON.stringify(unknown),
  );
  assert.equal(unknown.job.operationResult.executionOutcome, "unknown");
  f.documentIdentity("B");
  const independent = await submit(
    b,
    "local-workflow-independent-b",
    sourceB,
    "B",
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    assert.equal(
      (await b.wait(independent.id, { signal: controller.signal })).job.state,
      "succeeded",
    );
  } finally {
    clearTimeout(timeout);
  }
  assert.equal((await a.wait(original.id)).job.state, "needs_reconciliation");
  assert.equal(f.products(), 2);
  assert.equal(f.maximum(), 1);
});
