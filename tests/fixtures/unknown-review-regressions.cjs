"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const root =
  process.env.FMCAD_ADMISSION_CONSUMER_PACKAGE ||
  path.resolve(__dirname, "../..");
const { QueueDomain } = require(
  path.join(root, "dist/packages/core/src/domain/queue"),
);
const { quarantineTarget } = require(
  path.join(root, "dist/packages/core/src/domain/queue-quarantine"),
);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const bindingFor = (request) => ({
  version: 1,
  grantDigest: "a".repeat(64),
  generation: { instance: "fixture", epoch: "original" },
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
const release = require("./physical-turn-fixture.cjs");
const options = { now: Date.now, newId: randomUUID, hash };
function metadata(id, fileId) {
  return {
    kind: "rpc",
    clientId: "original-owner",
    requestId: id,
    timeoutMs: 1000,
    payload: {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "get_open_document_metadata",
        arguments: { fileId, version: 1 },
      },
    },
  };
}
function bareQuarantine() {
  const queue = new QueueDomain(options);
  const accepted = queue.submit(metadata("a", "A"));
  queue.next();
  queue.block(accepted.id, "synthetic lost reply");
  const snapshot = structuredClone(queue.data),
    job = snapshot.jobs[accepted.id];
  snapshot.active = snapshot.blocked = snapshot.lease = null;
  snapshot.quarantined = {
    [job.id]: {
      jobId: job.id,
      requestId: job.requestId,
      clientId: job.clientId,
      jobHash: job.hash,
      target: { fileId: "A" },
      evidenceDigest: "c".repeat(64),
      evidenceReference: "fmcad-physical-turn:sha256:" + "c".repeat(64),
      binding: {
        jobId: job.id,
        requestId: job.requestId,
        clientId: job.clientId,
        requestHash: job.hash,
      },
    },
  };
  return { snapshot, job };
}
test("CR2 restoration refuses quarantine without the complete physical release catalog", () => {
  const { snapshot } = bareQuarantine();
  assert.throws(() => new QueueDomain({ ...options, snapshot }), {
    code: "CORRUPT_STATE",
  });
});
test("CR4 flags on arbitrary or global commands do not establish document scope", () => {
  for (const argv of [
    ["run", "arbitrary.py", "--doc", "A", "--doc-id", "A"],
    ["document", "open", "other-file", "--doc-id", "A"],
  ])
    assert.equal(quarantineTarget({ kind: "command", argv, cwd: root }), null);
});
test("CR1 incomplete physical capabilities fail before constructing a backend", async () => {
  let constructed = 0;
  const { serve } = require(path.join(root, "dist/src/queue-broker"));
  for (const ports of [
    { physicalTurnQuiescence: async (binding) => release(binding) },
    {
      bindPhysicalTurn: bindingFor,
      physicalTurnQuiescence: async (binding) => release(binding),
    },
  ])
    await assert.rejects(
      serve(
        { backend: "addin", timeoutMs: 1000 },
        {
          ...ports,
          createBackend() {
            constructed++;
            throw Error("must not construct");
          },
        },
      ),
      { code: "PHYSICAL_CAPABILITY_INCOMPLETE" },
    );
  assert.equal(constructed, 0);
});
test("CR1 an unbound product cannot borrow a released preflight binding", async (t) => {
  const home = fs.mkdtempSync("/tmp/opencode/unknown-partial-");
  require(
    path.join(root, "dist/tests/runtime-test-environment"),
  ).isolateRuntimeTestEnvironment(home);
  const fixture = require("./python-admission-broker.cjs");
  const f = await fixture(t, {
    typedService: true,
    bindPhysicalTurn: (request) =>
      request.kind === "product"
        ? undefined
        : {
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
            target: JSON.stringify(request.documentSelector ?? null),
          },
    withPhysicalTurn: async (_binding, send) => send(),
    physicalTurnQuiescence: async (binding) => ({
      state: "released",
      binding,
      evidenceDigest: "c".repeat(64),
      physicalEvidenceReference: "fmcad-physical-turn:sha256:" + "c".repeat(64),
    }),
  });
  f.observeProduct(async () => {
    throw Object.assign(new Error("lost unbound product reply"), {
      code: "ECONNRESET",
    });
  });
  const a = await f.client("partial-owner");
  const source = f.script(
    "partial.py",
    'def run(context: str) -> None:\n    print("PARTIAL")\n',
  );
  const argv = ["run", source, "--doc", "A", "--doc-id", "A"];
  const { inputFiles } = require(path.join(root, "dist/src/queue-client"));
  const accepted = await a.submit({
    kind: "command",
    requestId: "partial-product",
    argv,
    cwd: f.home,
    backend: "addin",
    timeoutMs: 120000,
    inputFiles: inputFiles(argv, f.home),
  });
  const result = await a.wait(accepted.id);
  assert.equal(
    f.products(),
    0,
    "no SDK product may be sent without its own bound intent",
  );
  assert.equal(result.job.state, "failed");
  assert.equal(result.job.dispatch?.rpcCount ?? 0, 0);
});
test("CR3 a crashed broker recovers only original durable bindings, not a new grant", async (t) => {
  const home = fs.mkdtempSync("/tmp/opencode/unknown-crash-");
  const { promisify } = require("node:util");
  const { execFile } = require("node:child_process");
  const child = `
    const fs=require('node:fs'),path=require('node:path');
    const root=${JSON.stringify(root)},home=${JSON.stringify(home)};
    require(path.join(root,'dist/tests/runtime-test-environment')).isolateRuntimeTestEnvironment(home);
    const bind=${bindingFor.toString()};
    (async()=>{
      const f=await require(${JSON.stringify(path.join(__dirname, "python-admission-broker.cjs"))})({after(){}},{
        typedService:true,scopedService:true,fixtureHome:home,bindPhysicalTurn:bind,
        withPhysicalTurn:async(_binding,send)=>send(),
        physicalTurnQuiescence:async binding=>({state:'unknown',binding}),
      });
      f.observeProduct(async()=>{throw Object.assign(new Error('lost before quarantine publication'),{code:'ECONNRESET'})});
      const a=await f.client('crashed-owner');
      const argv=['param','inspect','--doc','A','--doc-id','A'];
      const accepted=await a.submit({kind:'command',requestId:'crash-original-a',argv,cwd:home,backend:'addin',timeoutMs:120000});
      await a.wait(accepted.id);
      fs.writeFileSync(path.join(home,'crash-marker.json'),JSON.stringify({dir:f.dir,id:accepted.id}));
      process.exit(0);
    })().catch(error=>{console.error(error);process.exit(1)});
  `;
  await promisify(execFile)(process.execPath, ["-e", child], {
    cwd: root,
    timeout: 120000,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  const { dir, id } = JSON.parse(
    fs.readFileSync(path.join(home, "crash-marker.json")),
  );
  const before = JSON.parse(
    fs.readFileSync(path.join(dir, "queue-state.json")),
  );
  assert.equal(before.quarantined?.[id], undefined);
  const original = before.jobs[id];
  // This is also a completeness assertion on the pre-crash persisted catalog.
  assert(
    original.physicalDispatches?.length > 1,
    "preflight and product intents must both be durable before the crash",
  );
  const { QueueState } = require(path.join(root, "dist/src/queue-state"));
  const snapshotPath = path.join(dir, "queue-state.json"),
    snapshotBytes = fs.readFileSync(snapshotPath);
  for (const corrupt of [
    (snapshot) => {
      snapshot.jobs[id].physicalDispatches.pop();
    },
    (snapshot) => {
      snapshot.jobs[id].physicalDispatches[0].physical.grantDigest = "f".repeat(
        64,
      );
    },
    (snapshot) => {
      snapshot.jobs[id].physicalDispatches[0].intentDigest = "f".repeat(64);
    },
  ]) {
    const changed = structuredClone(before);
    corrupt(changed);
    fs.writeFileSync(snapshotPath, JSON.stringify(changed));
    try {
      assert.throws(() => new QueueState(dir, { recover: false }), {
        code: "CORRUPT_STATE",
      });
    } finally {
      fs.writeFileSync(snapshotPath, snapshotBytes);
    }
  }
  const originals = original.physicalDispatches.map((entry) => entry.physical);
  require(path.join(root, "dist/src/queue-broker")).reclaim(dir);
  let historyAvailable = false;
  const observed = [];
  const f = await require("./python-admission-broker.cjs")(t, {
    typedService: true,
    scopedService: true,
    fixtureHome: home,
    initialDocumentIdentity: "B",
    bindPhysicalTurn: (request) => ({
      ...bindingFor(request),
      grantDigest: "b".repeat(64),
      generation: { instance: "fixture", epoch: "successor" },
    }),
    withPhysicalTurn: async (_binding, send) => send(),
    physicalTurnQuiescence: async (binding) => {
      observed.push(binding);
      assert(
        originals.some(
          (original) => JSON.stringify(original) === JSON.stringify(binding),
        ),
        "history is queried with the exact original, never the successor grant",
      );
      return historyAvailable
        ? release(binding)
        : { state: "unknown", binding };
    },
  });
  const b = await f.client("successor-independent");
  const argv = ["param", "inspect", "--doc", "B", "--doc-id", "B"];
  const accepted = await b.submit({
    kind: "command",
    requestId: "crash-independent-b",
    argv,
    cwd: home,
    backend: "addin",
    timeoutMs: 120000,
  });
  const deadline = Date.now() + 5000;
  while (!observed.length) {
    assert(
      Date.now() < deadline,
      "restored original catalog must be queried even though no live map exists",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(f.products(), 0, "no history capability is fail-closed");
  historyAvailable = true;
  const abort = new AbortController(),
    timeout = setTimeout(() => abort.abort(), 120000);
  try {
    assert.equal(
      (await b.wait(accepted.id, { signal: abort.signal })).job.state,
      "succeeded",
    );
  } finally {
    clearTimeout(timeout);
  }
  const after = JSON.parse(fs.readFileSync(path.join(dir, "queue-state.json")));
  assert.equal(after.jobs[id].state, "needs_reconciliation");
  assert.equal(after.jobs[id].hash, original.hash);
  assert.deepEqual(
    after.jobs[id].physicalDispatches,
    original.physicalDispatches,
  );
  assert.equal(f.products(), 1, "only independent B runs after restart");
  const retained = fs.mkdtempSync("/tmp/opencode/unknown-crash-evidence-");
  fs.writeFileSync(
    path.join(retained, "queue-state.json"),
    JSON.stringify(after),
  );
  for (const name of ["jobs", "physical-reads"])
    fs.cpSync(path.join(dir, name), path.join(retained, name), {
      recursive: true,
    });
  t.diagnostic(
    "Original UNKNOWN evidence retained outside fixture cleanup: " + retained,
  );
});

test("CR4 bounded CAD scope is fenced against altered source, manifest, parameters and context", async (t) => {
  const f = await require("./python-admission-broker.cjs")(t, {
    typedService: true,
    scopedService: true,
    scopedVariants: true,
    bindPhysicalTurn: bindingFor,
    withPhysicalTurn: async (_binding, send) => send(),
    physicalTurnQuiescence: async (binding) => release(binding),
  });
  const client = await f.client("scope-negative-owner");
  const service = require(
    path.join(root, "dist/src/dist/composition/cad-service"),
  );
  for (const variant of [
    "scope-suffix",
    "scope-params",
    "scope-context",
    "scope-creation",
    "scope-producer",
    "scope-manifest",
  ]) {
    const bounded = service.fromParsedCommand({
      kind: "cad",
      operation: "param.apply",
      data: {
        parameters: [{ name: "scope_width", expression: "12 mm", unit: "mm" }],
      },
      context: { doc: "A", docId: "A" },
      json: true,
    });
    const accepted = await client.submit({
      ...bounded,
      kind: "command",
      requestId: variant,
      cwd: f.home,
      backend: "addin",
      timeoutMs: 120000,
    });
    const result = await client.wait(accepted.id);
    assert.equal(result.job.state, "failed", variant + JSON.stringify(result));
    assert.match(
      result.stderr,
      variant === "scope-manifest"
        ? /inventory|artifact|source/i
        : /Actual pre-wrapper source differs from the broker-compiled constrained program/,
      variant + " must fail at the actual source/inventory fence",
    );
    assert.equal(
      result.job.dispatch?.rpcCount ?? 0,
      0,
      variant + " must be refused before SDK dispatch",
    );
    assert.equal(
      f.products(),
      0,
      variant + " must not borrow scope from its public DTO or manifest",
    );
  }
});
