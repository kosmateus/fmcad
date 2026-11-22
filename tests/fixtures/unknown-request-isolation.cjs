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
const root =
  process.env.FMCAD_ADMISSION_CONSUMER_PACKAGE ||
  path.resolve(__dirname, "../..");
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
const releasedProof = require("./physical-turn-fixture.cjs");
function typedMutation(doc) {
  return require(path.join(root,"dist/src/dist/composition/cad-service")).fromParsedCommand({
    kind:"cad",operation:"param.apply",data:{
      parameters:[{name:"isolation_width",expression:"12 mm",unit:"mm"}],
    },context:{doc,docId:doc},json:true,
  });
}

test("a released UNKNOWN compiled document mutation permits another process and document without replay", async (t) => {
  let proofState = "active";
  const observedProofs = new Set();
  const physicalScope = new AsyncLocalStorage();
  const sentTurns = new Set();
  const f = await fixture(t, {
    typedService: true,
    scopedService: true,
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
      const { evidenceDigest } = releasedProof(binding);
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
  const bounded = typedMutation("A");
  const argv = bounded.argv;
  const originalRequest = {
    ...bounded,
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
        assert.equal(JSON.parse(intent.binding.physicalTurn.target).creationId, "A");
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
        const bounded=require(${JSON.stringify(path.join(root,"dist/src/dist/composition/cad-service"))}).fromParsedCommand({
          kind:'cad',operation:'param.apply',data:{parameters:[{name:'isolation_width',expression:'12 mm',unit:'mm'}]},
          context:{doc:'B',docId:'B'},json:true});
        const argv=bounded.argv;
        const job=await client.submit({...bounded,kind:'command',requestId:'independent-b',argv,cwd:${JSON.stringify(f.home)},
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
    timeout: 120000,
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
  fs.cpSync(jobDirectory,retainedDirectory,{recursive:true});
  const retainedQueue = path.join(evidenceRoot,"queue");
  fs.mkdirSync(retainedQueue);
  fs.writeFileSync(path.join(retainedQueue,"queue-state.json"),JSON.stringify(quarantinedSnapshot));
  for(const name of ["jobs","physical-reads"])
    fs.cpSync(path.join(f.dir,name),path.join(retainedQueue,name),{recursive:true});
  t.diagnostic(
    "UNKNOWN snapshot and unchanged original intents retained: " + evidenceRoot,
  );
  // Physical release alone never settled A. Only its original backend receipt
  // and the existing reconciliation/audit path may now publish a terminal result.
  await assert.rejects(a.call("reconcile",{jobId:accepted.id}),{code:"RECEIPT_UNAVAILABLE"});
  assert.equal((await a.wait(accepted.id)).job.state,"needs_reconciliation",
    "quiescence cannot be inferred into a terminal job result");
  f.publishProductReceipts();
  f.documentIdentity("A");
  const settled = await a.call("reconcile", { jobId: accepted.id });
  assert.equal(settled.state, "failed", JSON.stringify(settled));
  assert.equal(
    settled.code,
    "RESULT_UNAVAILABLE",
    "the original receipt proves completion, not a missing worker result",
  );
  const terminalSnapshot = JSON.parse(
    fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8"),
  );
  assert.equal(terminalSnapshot.quarantined?.[accepted.id], undefined);
  assert.equal(
    f.products(),
    2,
    "receipt recovery must not replay original product",
  );
  const reuse = await a.submit({
    ...originalRequest,
    requestId: "resource-after-authentic-settlement",
  });
  assert.equal((await a.wait(reuse.id)).job.state, "succeeded");
  assert.equal(f.products(),3,"only the explicitly submitted fresh request may reuse A's resource");
  for(const [name,digest] of Object.entries(originalIntents))
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(jobDirectory,name))).digest("hex"),digest,
      "authentic terminal settlement must not rewrite the original RPC intent");
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
    scopedService: true,
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
  const argv = ["param", "inspect", "--doc", "A", "--doc-id", "A"];
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
    const otherArgv = ["param", "inspect", "--doc", "B", "--doc-id", "B"];
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
      argv: ["cad", "param", "inspect", "--doc", doc, "--doc-id", doc],
      payload: {
        version: 1,
        kind: "cad-command",
        invocation: {
          version: 1,
          kind: "cad",
          operation: "param.inspect",
          data: {},
          doc,
          docId: doc,
        },
      },
    });
  const conflict = submit("restored-conflict", "A");
  const independent = submit("restored-independent", "C");
  assert.equal(restored.next().id, independent.id);
  assert.equal(restored.status(conflict.id).state, "queued");
  assert.equal(restored.status(original.id).state, "needs_reconciliation");
  const altered = structuredClone(quarantinedSnapshot);
  altered.quarantined[original.id].jobHash = "wrong-original-request";
  assert.throws(() => restore(altered), { code: "CORRUPT_STATE" });
  for (const corrupt of [
    (snapshot) => {
      delete snapshot.quarantined[original.id].binding.physicalTurns;
    },
    (snapshot) => {
      snapshot.quarantined[original.id].binding.physicalTurns.pop();
    },
    (snapshot) => {
      snapshot.quarantined[
        original.id
      ].binding.physicalTurns[0].binding.target = '{"creationId":"FOREIGN"}';
    },
    (snapshot) => {
      snapshot.quarantined[
        original.id
      ].binding.physicalTurns[0].evidenceDigest = "f".repeat(64);
    },
    (snapshot) => {
      snapshot.jobs[original.id].physicalDispatches.pop();
    },
  ]) {
    const snapshot = structuredClone(quarantinedSnapshot);
    corrupt(snapshot);
    assert.throws(() => restore(snapshot), { code: "CORRUPT_STATE" });
  }
  // Domain settlement of A must not clear an independent active B's lease.
  const activeBefore = restored.data.active;
  restored.resolve(original.id, {
    state: "succeeded",
    source: "explicit-evidence-test",
  });
  assert.equal(restored.data.active, activeBefore);
  assert.equal(restored.data.quarantined?.[original.id], undefined);
  const fileQueue = new QueueDomain({
    now: Date.now,
    newId: require("node:crypto").randomUUID,
    hash: (text) => createHash("sha256").update(text).digest("hex"),
  });
  const metadata = (id, fileId, version = 1) =>
    fileQueue.submit({
      kind: "rpc",
      clientId: "file-owner",
      requestId: id,
      timeoutMs: 1000,
      payload: {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "get_open_document_metadata",
          arguments: { fileId, version },
        },
      },
    });
  const fileA = metadata("file-a", "DataFile-A");
  fileQueue.next();
  const job = fileQueue.data.jobs[fileA.id];
  const request = {
    kind: "product",
    jobId: job.id,
    requestId: job.requestId,
    clientId: job.clientId,
    requestHash: job.hash,
    grantGeneration: 1,
    physicalRequestId: "file-a-physical",
    documentSelector: { fileId: "DataFile-A" },
  };
  const physical = bindPhysicalTurn(request);
  fileQueue.recordPhysicalDispatch(job.id, {
    request,
    physical,
    target: { fileId: "DataFile-A" },
    intentReference: "physical-turn-" + "d".repeat(64) + ".json",
    intentDigest: "e".repeat(64),
  });
  fileQueue.block(fileA.id, "synthetic UNKNOWN for domain policy");
  const proof = releasedProof(physical);
  fileQueue.quarantineUnknown(job.id, {
    jobId: job.id,
    requestId: job.requestId,
    clientId: job.clientId,
    jobHash: job.hash,
    target: { fileId: "DataFile-A" },
    evidenceDigest: proof.evidenceDigest,
    evidenceReference: proof.physicalEvidenceReference,
    catalogDigest: createHash("sha256")
      .update(JSON.stringify(fileQueue.data.jobs[job.id].physicalDispatches))
      .digest("hex"),
    binding: {
      jobId: job.id,
      requestId: job.requestId,
      clientId: job.clientId,
      requestHash: job.hash,
      physicalTurns: [proof],
    },
  });
  const alias = metadata("same-file-new-version", "DataFile-A", 2);
  const otherFile = metadata("other-file", "DataFile-B");
  assert.equal(fileQueue.next().id, otherFile.id);
  assert.equal(
    fileQueue.status(alias.id).state,
    "queued",
    "a version change does not evade the DataFile conflict",
  );
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
          claim.assertBrokerOwner();
          throw Object.assign(
            new Error("Synthetic generation provisioning refused"),
            { code: "TEST_PROVISION_REFUSED" },
          );
        },
        bindPhysicalTurn,
        withPhysicalTurn: async (_binding, send) => send(),
        physicalTurnQuiescence: async (binding) => releasedProof(binding),
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
  const changed = fs.mkdtempSync("/tmp/opencode/unknown-isolation-owner-");
  t.after(()=>fs.rmSync(changed,{recursive:true,force:true}));
  let replacement;
  await assert.rejects(serve({backend:"addin",timeoutMs:1000},{
    dir:changed,confirmOwnership:true,
    bindPhysicalTurn,withPhysicalTurn:async(_binding,send)=>send(),
    physicalTurnQuiescence:async binding=>releasedProof(binding),
    preparePhysicalGeneration:async claim=>{
      claim.assertBrokerOwner();
      replacement={...claim.owner,nonce:"foreign-owner-created-by-this-test"};
      fs.writeFileSync(path.join(changed,"broker.lock"),JSON.stringify(replacement));
      await Promise.resolve();
    },
    createBackend(){constructed++;assert.fail("no SDK construction after owner fence changes");},
  }),{code:"LOCK_CHANGED"});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(changed,"broker.lock"))),replacement);
  assert.equal(constructed,0);
});

test("an UNKNOWN local workflow after a settled SDK turn does not become a global control hold", async (t) => {
  const physicalScope = new AsyncLocalStorage();
  const f = await fixture(t, {
    typedService: true,
    scopedService: true,
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
    const argv = ["param", "inspect", "--doc", doc, "--doc-id", doc];
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
  const timeout = setTimeout(() => controller.abort(), 120000);
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
