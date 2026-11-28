const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { QueueDomain } = require("@fmcad/core");
const { QueueState } = require("../src/queue-state.js");
const {
  createApprovedRuntimeRetirement,
} = require("../src/queue-runtime-retirement.js");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

for (const mode of ["approved", "denied", "no-profile", "changed-under-lock", "alive"]) {
  test(`public reclaim authenticates native current root without legacy recovery: ${mode}`, (t) => {
    const f = fixture(t);
    const rootFile = path.join(f.directory, "test-approved-root.json");
    fs.writeFileSync(rootFile, JSON.stringify(f.root), { mode: 0o600 });
    fs.writeFileSync(path.join(f.directory, "isolated-admission-epoch.json"),
      "invalid historical pointer must not be the current restore selector", { mode: 0o600 });
    const result = spawnSync(process.execPath, ["-e", `
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const directory = ${JSON.stringify(f.directory)}, mode = ${JSON.stringify(mode)};
require("./src/queue-connection.js").queueDirectory = () => directory;
const root = JSON.parse(fs.readFileSync(${JSON.stringify(rootFile)}, "utf8"));
for (const key of Object.keys(root.currentFiles))
  if (root.currentFiles[key]) root.currentFiles[key] = Buffer.from(root.currentFiles[key].data);
const instance = require("./src/queue-instance.js");
const lock = { pid: mode === "alive" ? process.pid : 2147483645,
  birth: mode === "alive" ? instance.processBirth() : "dead:fixture", nonce: "owned-dead-broker" };
instance.durable(path.join(directory, "broker.lock"), lock);
const original = fs.readFileSync(path.join(directory, "queue-state.json"));
let verified = 0, assertions = 0;
const wiring = {
  async verifyRuntimeRootBeforeRestore(context) {
    assert.equal(context.directory, directory);
    assert.equal(fs.existsSync(path.join(directory, "broker.lock")), true);
    verified++;
    if (mode === "denied") throw Object.assign(new Error("native verification denied"), {code:"ROOT_NATIVE_VERIFY_DENIED"});
    return root;
  },
  assertVerifiedRoot(actual) {
    assert.equal(actual, directory); assert.equal(verified, 1); assertions++;
    if (mode === "changed-under-lock" && assertions === 2)
      fs.writeFileSync(path.join(directory, "queue-state.json"), Buffer.concat([original, Buffer.from(" ")]), {mode:0o600});
  },
};
require("./src/queue-runtime-physical-wiring.js").createRuntimeRootPhysicalWiring = () => wiring;
require("./src/dist/node-adapters/execution/physical-generation-profile.js").physicalBrokerPortsFromEnvironment =
  (_env, dependencies) => { if (mode !== "no-profile") dependencies.runtimeRootFactory({}); return {}; };
process.env.FMCAD_PHYSICAL_OPERATOR_PROFILE = "explicit-test-native-verifier-not-live";
const broker = require("./src/queue-broker.js");
(async () => {
  const run = () => broker.reclaim(directory, {backend:"addin", routing:"queue"});
  if (mode === "approved") {
    const output = [];
    const {queueCommand} = require("./src/dist/entrypoints/queue-cli.js");
    const status = await queueCommand(["reclaim"], {
      loadConfig: () => ({cfg:{backend:"addin", routing:"queue"}}),
      stdout:{write(text) {output.push(text);}}, stderr:{write() {assert.fail("unexpected stderr");}},
    });
    assert.equal(status, 0);
    const result = JSON.parse(output.join(""));
    assert.equal(result.reclaimed, true);
    assert.equal(fs.existsSync(path.join(directory, "broker.lock")), false);
    assert.ok(assertions >= 3, "verified files fenced again under recovery.lock");
    assert.deepEqual(fs.readFileSync(path.join(directory, "queue-state.json")), original);
  } else {
    await assert.rejects(async () => run(), {code: mode === "denied"
      ? "ROOT_NATIVE_VERIFY_DENIED" : mode === "alive" ? "BROKER_ALIVE" : "RUNTIME_ROOT_AUTHORITY_REQUIRED"});
    assert.deepEqual(instance.readJson(path.join(directory, "broker.lock")), lock);
    if (mode !== "changed-under-lock")
      assert.deepEqual(fs.readFileSync(path.join(directory, "queue-state.json")), original);
  }
  assert.equal(verified, mode === "no-profile" ? 0 : 1);
  assert.equal(fs.existsSync(path.join(directory, "recovery.lock")), false);
})().catch(error => { console.error(error); process.exitCode = 1; });
`], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

// The native-root and ownership assertions are explicit test ports. This suite
// exercises the real byte adapter, snapshot store and staged QueueDomain; it is
// not evidence that a native grant was issued or that Fusion ran.
function fixture(t, historyCount = 0) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-retirement-")),
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = new QueueDomain({
    now: () => 100,
    newId: () => "original-job",
    hash: sha,
  });
  const submitted = state.submit({
    kind: "rpc",
    clientId: "vanished-author",
    requestId: "original-request",
    timeoutMs: 1000,
    payload: { method: "tools/call", params: { measurement: 1e20 } },
  });
  state.next();
  state.markDispatch(submitted.id);
  state.block(submitted.id, { code: "OLD_UNKNOWN" });
  state.pause(true);
  const frozen = structuredClone(state.data);
  const history = new QueueDomain({ now: () => 100, newId: () => "completed", hash: sha });
  const completed = history.submit({
    kind: "rpc", clientId: "history-author", requestId: "history-request",
    timeoutMs: 1000, payload: { method: "tools/call", params: {} },
  });
  history.next();
  history.finish(completed.id, { state: "succeeded" });
  for (let index = 0; index < historyCount; index++) {
    const id = `history-${index}`;
    frozen.jobs[id] = {
      ...structuredClone(history.data.jobs[completed.id]),
      id, requestId: `request-${id}`,
      request: { ...history.data.jobs[completed.id].request, requestId: `request-${id}` },
    };
  }
  const bytes = Buffer.from(JSON.stringify(frozen));
  const file = path.join(directory, "queue-state.json");
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  const stat = fs.statSync(directory);
  const archive = path.join(
    directory,
    "runtime-rebaselines",
    "owned-test-root",
  );
  fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
  const frozenFile = path.join(archive, "frozen-queue-state.json");
  fs.writeFileSync(frozenFile, bytes, { mode: 0o600 });
  let owned = true;
  let rootValid = true;
  let ownerAsync = false;
  let rootAsync = false;
  let assertions = 0;
  const root = {
    record: {
      request: { requestId: "owned-test-root" },
      store: directory,
      storeDevice: stat.dev,
      storeInode: stat.ino,
      receipt: {
        newHead: "native-approved-head",
        handoffId: "native-approved-handoff",
      },
      layers: {
        root: { dispositions: { [submitted.id]: { outcome: "unknown" } } },
      },
      frozen: { "queue-state.json": { path: frozenFile, sha256: sha(bytes) } },
    },
    frozenBaseline: { snapshot: frozen, snapshots: { root: frozen } },
    currentFiles: { "queue-state.json": bytes },
  };
  const recordFile = path.join(archive, "record.json");
  fs.writeFileSync(recordFile, JSON.stringify(root.record), { mode: 0o600 });
  fs.writeFileSync(
    path.join(directory, "runtime-rebaseline-head.json"),
    JSON.stringify({
      version: 1,
      newHead: root.record.receipt.newHead,
      record: { path: recordFile, sha256: sha(JSON.stringify(root.record)) },
    }),
    { mode: 0o600 },
  );
  const factory = () =>
    createApprovedRuntimeRetirement({
      root,
      assertBrokerOwner() {
        assertions++;
        if (ownerAsync === "reject")
          return Promise.reject(new Error("private-owner-rejection"));
        if (ownerAsync) return new Promise(() => {});
        if (!owned)
          throw Object.assign(new Error("writer lost"), { code: "OWNER_LOST" });
      },
      assertVerifiedRoot(actual) {
        assert.equal(actual, directory);
        if (rootAsync === "reject")
          return Promise.reject(new Error("private-root-rejection"));
        if (rootAsync) return new Promise(() => {});
        if (!rootValid)
          throw Object.assign(new Error("root changed"), {
            code: "ROOT_CHANGED",
          });
      },
    });
  return {
    directory,
    file,
    frozen,
    bytes,
    root,
    factory,
    submitted,
    loseOwner() {
      owned = false;
    },
    invalidateRoot() {
      rootValid = false;
    },
    asyncOwner(rejected = false) {
      ownerAsync = rejected ? "reject" : true;
    },
    asyncRoot(rejected = false) {
      rootAsync = rejected ? "reject" : true;
    },
    get assertions() {
      return assertions;
    },
  };
}

test("real QueueState consumes a fresh root over the preceding retirement marker exactly once", (t) => {
  const f = fixture(t);
  new QueueState(f.directory, { runtimeRetirement: f.factory().forDirectory(f.directory), now: () => 200 });
  const prior = JSON.parse(fs.readFileSync(f.file, "utf8"));
  const bytes = fs.readFileSync(f.file);
  const archive = path.join(f.directory, "runtime-rebaselines", "successor-owned-root");
  fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
  const frozenFile = path.join(archive, "frozen-queue-state.json");
  fs.writeFileSync(frozenFile, bytes, { mode: 0o600 });
  const root = {
    ...f.root,
    record: {
      ...f.root.record,
      request: { requestId: "successor-owned-root" },
      receipt: { newHead: "successor-native-head", handoffId: "successor-native-handoff" },
      frozen: { "queue-state.json": { path: frozenFile, sha256: sha(bytes) } },
    },
    frozenBaseline: { snapshot: prior, snapshots: { root: prior } },
    currentFiles: { "queue-state.json": bytes },
  };
  const recordFile = path.join(archive, "record.json");
  fs.writeFileSync(recordFile, JSON.stringify(root.record), { mode: 0o600 });
  fs.writeFileSync(path.join(f.directory, "runtime-rebaseline-head.json"), JSON.stringify({
    version: 1, newHead: root.record.receipt.newHead,
    record: { path: recordFile, sha256: sha(JSON.stringify(root.record)) },
  }), { mode: 0o600 });
  const authority = createApprovedRuntimeRetirement({
    root,
    assertBrokerOwner() {},
    assertVerifiedRoot(directory) { assert.equal(directory, f.directory); },
  }).forDirectory(f.directory);
  const restored = new QueueState(f.directory, { runtimeRetirement: authority, now: () => 300 });
  assert.equal(restored.data.appliedRuntimeRetirement.rootHead, root.record.receipt.newHead);
  assert.deepEqual(restored.data.jobs, prior.jobs, "historical UNKNOWN is not settled or rewritten");
  assert.equal(restored.data.jobs[f.submitted.id].state, "needs_reconciliation");
  assert.equal(restored.data.revision, prior.revision + 1);
  assert.deepEqual(fs.readFileSync(frozenFile), bytes, "the new authenticated frozen input is immutable");
  const committed = fs.readFileSync(f.file);
  new QueueState(f.directory, { runtimeRetirement: authority, now: () => 400 });
  assert.deepEqual(fs.readFileSync(f.file), committed, "same-root restart does not project or replay again");
});

test("real QueueState atomically projects UNKNOWN before ordinary recovery", (t) => {
  const f = fixture(t);
  const authority = f.factory().forDirectory(f.directory);
  const restored = new QueueState(f.directory, {
    runtimeRetirement: authority,
    now: () => 200,
  });
  assert.equal(restored.data.active, null);
  assert.equal(restored.data.blocked, null);
  assert.equal(restored.data.paused, true);
  assert.deepEqual(
    restored.data.jobs[f.submitted.id],
    f.frozen.jobs[f.submitted.id],
  );
  const persisted = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.equal(
    persisted.appliedRuntimeRetirement.rootHead,
    "native-approved-head",
  );
  assert.equal(persisted.jobs[f.submitted.id].state, "needs_reconciliation");
  assert.equal(persisted.active, null);
  assert.ok(f.assertions > 3);
  // Same staged WeakMap authority survives the actual QueueState constructor.
  restored.assertDocumentProbeAllowed();
  assert.equal(restored.documentConflicts({ creationId: "doc-A" }).length, 1);
});

test("runtime root admission is explicit and does not derive modeling rights from a missing epoch", (t) => {
  const f = fixture(t);
  const {
    openRuntimeRootState,
    admitRuntimeRootRequest,
  } = require("../src/queue-runtime-root-state.js");
  let allowed = false;
  let grants = 0;
  const state = openRuntimeRootState({
    root: f.root,
    assertBrokerOwner() {},
    assertVerifiedRoot(directory) {
      assert.equal(directory, f.directory);
    },
    assertNativeModelGrant(clientId, tokenHash) {
      grants++;
      assert.equal(clientId, "successor");
      assert.equal(tokenHash, "token-hash");
      if (!allowed)
        throw Object.assign(new Error("no current native grant"), {
          code: "NOT_AUTHORIZED",
        });
    },
    stateOptions: { now: () => 200 },
  });
  assert.equal(state.epoch, null);
  assert.equal(state.admissionMode, "runtime-rebaseline");
  assert.deepEqual(state.lookup(f.submitted.id), f.frozen.jobs[f.submitted.id]);
  assert.throws(
    () =>
      admitRuntimeRootRequest(
        state,
        { clientId: "successor" },
        { successor: "token-hash" },
      ),
    { code: "NOT_AUTHORIZED" },
  );
  const { epochAdmission } = require("../src/queue-isolated-epoch.js");
  assert.throws(
    () =>
      epochAdmission(
        state,
        { clientId: "successor" },
        { successor: "token-hash" },
      ),
    { code: "NOT_AUTHORIZED" },
  );
  assert.equal(grants, 2);
  allowed = true;
  assert.equal(
    admitRuntimeRootRequest(
      state,
      { clientId: "successor" },
      { successor: "token-hash" },
    ),
    true,
  );
  assert.throws(
    () =>
      admitRuntimeRootRequest(
        state,
        { clientId: "stranger" },
        { successor: "token-hash" },
      ),
    { code: "NOT_AUTHORIZED" },
  );
  assert.equal(
    admitRuntimeRootRequest(
      { epoch: null },
      { clientId: "successor" },
      { successor: "token-hash" },
    ),
    false,
  );
});

function historicalFixture(t, completed = false) {
  const f = fixture(t);
  const previous = new QueueDomain({
    now: () => 100,
    newId: () => "epoch-job",
    hash: sha,
  });
  const request = {
    ...f.frozen.jobs[f.submitted.id].request,
    requestId: "epoch-request",
    clientId: "previous-owner",
  };
  previous.submit(request);
  previous.next();
  previous.markDispatch("epoch-job");
  if (completed) previous.finish("epoch-job", { state: "succeeded" });
  else previous.block("epoch-job", { code: "EPOCH_UNKNOWN" });
  const layer = "admission-epochs/previous-epoch";
  const snapshot = structuredClone(previous.data);
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const layerDirectory = path.join(f.directory, layer);
  fs.mkdirSync(layerDirectory, { recursive: true, mode: 0o700 });
  const layerFile = path.join(layerDirectory, "queue-state.json");
  fs.writeFileSync(layerFile, bytes, { mode: 0o600 });
  const archive = path.join(f.directory, "runtime-rebaselines/owned-test-root");
  const frozenFile = path.join(archive, "epoch-snapshot.json");
  fs.writeFileSync(frozenFile, bytes, { mode: 0o600 });
  f.root.record.layers[layer] = {
    dispositions: completed ? {} : { "epoch-job": { outcome: "unknown" } },
  };
  f.root.record.frozen[layer + "/queue-state.json"] = {
    path: frozenFile,
    sha256: sha(bytes),
  };
  f.root.frozenBaseline.snapshots[layer] = snapshot;
  f.root.currentFiles[layer + "/queue-state.json"] = bytes;
  const recordFile = path.join(archive, "record.json");
  fs.writeFileSync(recordFile, JSON.stringify(f.root.record));
  fs.writeFileSync(
    path.join(f.directory, "runtime-rebaseline-head.json"),
    JSON.stringify({
      version: 1,
      newHead: f.root.record.receipt.newHead,
      record: { path: recordFile, sha256: sha(JSON.stringify(f.root.record)) },
    }),
  );
  return { ...f, request, snapshot, bytes, layer, layerFile };
}
test("runtime root keeps other layers read-only and fences every submission entry against historical IDs", (t) => {
  const f = historicalFixture(t);
  const { request, snapshot, bytes, layer, layerFile } = f;
  const {
    openRuntimeRootState,
  } = require("../src/queue-runtime-root-state.js");
  const open = () =>
    openRuntimeRootState({
      root: f.root,
      assertBrokerOwner() {},
      assertVerifiedRoot() {},
      assertNativeModelGrant() {},
      stateOptions: { now: () => 200 },
    });
  const state = open();
  assert.equal(state.lookup("epoch-job").state, "needs_reconciliation");
  assert.equal(state.isHistorical("epoch-job"), true);
  assert.equal(state.findAnyRequest("stranger", "epoch-request"), null);
  assert.equal(
    state.findAnyRequest("previous-owner", "epoch-request").id,
    "epoch-job",
  );
  for (const method of [
    "submit",
    "submitDocumentInspection",
    "submitDocumentContinuation",
    "submitDocumentMetadataRead",
    "refuseDocumentContinuation",
  ])
    assert.throws(() => state[method](request, {}), {
      code: "HISTORICAL_REQUEST_QUARANTINED",
    });
  assert.deepEqual(fs.readFileSync(layerFile), bytes);
  assert.equal(state.data.jobs["epoch-job"], undefined);
  assert.equal(
    state.documentConflicts({ creationId: "unrelated-doc" }).length,
    2,
  );
  const tampered = structuredClone(snapshot);
  const job = tampered.jobs["epoch-job"];
  job.clientId = job.request.clientId = "different-owner";
  job.requestId = job.request.requestId = "different-request";
  job.hash = sha(require("@fmcad/core").canonical(job.request));
  const changed = Buffer.from(JSON.stringify(tampered));
  fs.writeFileSync(layerFile, changed);
  f.root.currentFiles[layer + "/queue-state.json"] = changed;
  f.root.currentFiles["queue-state.json"] = fs.readFileSync(f.file);
  const currentRoot = fs.readFileSync(f.file);
  assert.throws(open, {
    code: "RUNTIME_RETIREMENT_CHANGED",
    message:
      "Read-only historical jobs differ from their immutable original identities",
  });
  assert.deepEqual(fs.readFileSync(f.file), currentRoot);
  assert.deepEqual(fs.readFileSync(layerFile), changed);
});
test("successful immutable historical jobs retain their actual outcome instead of becoming UNKNOWN", (t) => {
  const f = historicalFixture(t, true);
  const {
    openRuntimeRootState,
  } = require("../src/queue-runtime-root-state.js");
  const state = openRuntimeRootState({
    root: f.root,
    assertBrokerOwner() {},
    assertVerifiedRoot() {},
    assertNativeModelGrant() {},
    stateOptions: { now: () => 200 },
  });
  const job = state.status("epoch-job");
  assert.equal(job.state, "succeeded");
  assert.equal(job.historicalOutcome, "succeeded");
  assert.equal(job.quarantined, false);
  assert.equal(job.historicalModelValidation, "not_performed");
  assert.equal(state.isHistorical("epoch-job"), true);
  assert.throws(() => state.submit(f.request), {
    code: "HISTORICAL_REQUEST_QUARANTINED",
  });
  assert.deepEqual(fs.readFileSync(f.layerFile), f.bytes);
});

for (const mode of [
  "before-grant",
  "verification-denied",
  "missing-head",
  "unknown-grant",
  "backend-failure",
  "history-ipc",
  "kill-provision",
  "empty-archive",
]) {
  const denyVerification = ["verification-denied", "missing-head"].includes(
    mode,
  );
  const uncertainGrant = ["unknown-grant", "backend-failure"].includes(mode);
  test(`actual serve runtime-root boundary: ${mode}`, (t) => {
    const f = mode === "history-ipc" ? historicalFixture(t) : fixture(t);
    const rootFile = path.join(f.directory, "test-approved-root.json");
    fs.writeFileSync(rootFile, JSON.stringify(f.root), { mode: 0o600 });
    if (mode === "empty-archive") {
      fs.unlinkSync(path.join(f.directory, "runtime-rebaseline-head.json"));
      fs.rmSync(path.join(f.directory, "runtime-rebaselines"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(f.directory, "runtime-rebaselines"), {
        mode: 0o700,
      });
    }
    if (mode === "missing-head") {
      fs.writeFileSync(
        path.join(
          f.directory,
          "runtime-rebaselines/owned-test-root/completion.json",
        ),
        JSON.stringify({ fixture: "retained native completion evidence" }),
        { mode: 0o600 },
      );
      fs.unlinkSync(path.join(f.directory, "runtime-rebaseline-head.json"));
    }
    const legacyFile = path.join(f.directory, "isolated-admission-epoch.json");
    fs.writeFileSync(legacyFile, "deliberately-invalid-legacy-pointer", {
      mode: 0o600,
    });
    const code = `
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const directory = ${JSON.stringify(f.directory)};
const root = JSON.parse(fs.readFileSync(${JSON.stringify(rootFile)}, "utf8"));
for (const key of Object.keys(root.currentFiles))
  if (root.currentFiles[key]) root.currentFiles[key] = Buffer.from(root.currentFiles[key].data);
let verified = 0, grants = 0, sdk = 0;
const neverSDK = () => { sdk++; throw new Error("SDK must not run"); };
const wiring = {
  nativeProvision: {},
  assertVerifiedRoot(actual) { assert.equal(actual, directory); assert.equal(verified, 1); },
  async verifyRuntimeRootBeforeRestore(context) {
    assert.equal(context.directory, directory);
    assert.equal(fs.existsSync(path.join(directory, "broker.lock")), false);
    verified++;
    if (${denyVerification})
      throw Object.assign(new Error("native verification denied"), { code: "ROOT_NATIVE_VERIFY_DENIED" });
    return root;
  },
};
require("./src/queue-runtime-physical-wiring.js").createRuntimeRootPhysicalWiring = () => wiring;
require("./src/dist/node-adapters/execution/physical-generation-profile.js")
  .physicalBrokerPortsFromEnvironment = (_environment, dependencies) => {
    const rootAuthority = dependencies.runtimeRootFactory?.({});
    if (rootAuthority) assert.equal(rootAuthority, wiring);
    return {
      verifyRuntimeRootBeforeRestore: rootAuthority
        ? wiring.verifyRuntimeRootBeforeRestore : async () => undefined,
      authorizePhysicalRequest: neverSDK, bindPhysicalTurn: neverSDK,
      withPhysicalTurn: neverSDK, physicalTurnQuiescence: neverSDK,
      async preparePhysicalGeneration(context) {
        context.assertBrokerOwner();
        assert.equal(verified, 1);
        const owner = JSON.parse(fs.readFileSync(path.join(directory, "broker.lock"), "utf8"));
        assert.equal(owner.nonce, context.owner.nonce);
        const state = JSON.parse(fs.readFileSync(path.join(directory, "queue-state.json"), "utf8"));
        assert.equal(state.appliedRuntimeRetirement.rootHead, root.record.receipt.newHead);
        assert.equal(state.active, null);
        assert.equal(state.jobs["original-job"].state, "needs_reconciliation");
        grants++;
        if (${mode === "kill-provision"}) {
          console.log("ISSUER_ENTERED_BEFORE_SIGKILL");
          process.kill(process.pid, "SIGKILL");
          await new Promise(() => {});
        }
        if (${mode === "backend-failure" || mode === "history-ipc"}) return;
        if (${mode === "unknown-grant"})
          throw Object.assign(new Error("uncertain grant fixture"), {
            code: "PHYSICAL_GENERATION_REJECTED", grantIssuance: "unknown" });
        throw Object.assign(new Error("deliberate stop before any native grant"), {
          code: "ROOT_STARTUP_TEST_STOP", notStarted: true });
      },
    };
  };
process.env.FMCAD_PHYSICAL_OPERATOR_PROFILE = "test-only-stub-not-a-production-profile";
process.env.XDG_DATA_HOME = path.join(directory, "test-xdg-data");
if (${mode === "history-ipc"}) {
  // Only the unrelated physical startup probe is replaced. The writer,
  // lifecycle, listener, credential checks and public IPC handler are real.
  const lifetimeModule = require("./src/dist/node-adapters/execution/broker-lifetime.js");
  const claim = lifetimeModule.claimBrokerLifetime;
  lifetimeModule.claimBrokerLifetime = (options) => {
    const lifetime = claim(options);
    const initialize = lifetime.initialize;
    lifetime.initialize = (settings) => initialize(settings, async () => undefined);
    return lifetime;
  };
  const hash = (text) => require("node:crypto").createHash("sha256").update(text).digest("hex");
  fs.writeFileSync(path.join(directory, "clients.json"), JSON.stringify({
    "previous-owner": hash("owner-token"), stranger: hash("stranger-token"),
  }), { mode: 0o600 });
}
const { serve } = require("./src/queue-broker.js");
(async () => {
  const start = () => serve({ backend: "addin", routing: "queue", transport: "node",
    url: "http://127.0.0.1:8765/mcp" }, {
    confirmOwnership: true, dir: directory, createBackend() {
      if (${mode === "history-ipc"}) return {
        server: { backend: "addin", routing: "queue" }, _post: neverSDK, _parse: (value) => value,
      };
      throw Object.assign(new Error("backend constructor failed"), { code: "BACKEND_FACTORY_FAILED" });
    },
  });
  if (${mode === "history-ipc"}) {
    const broker = await start();
    try {
      const { request } = require("./src/queue-connection.js");
      const owned = { clientId: "previous-owner", clientToken: "owner-token" };
      const foreign = { clientId: "stranger", clientToken: "stranger-token" };
      const expected = root.frozenBaseline.snapshots["admission-epochs/previous-epoch"].jobs["epoch-job"].request;
      for (const auth of [owned, foreign]) {
        await request(directory, { action: "register", ...auth });
        for (const exact of [false, true]) {
          const found = await request(directory, { action: "find-request", auth,
            requestId: "epoch-request", ...(exact ? { expectedRequest: expected } : {}) });
          assert.equal(found.job?.id ?? null, auth === owned ? "epoch-job" : null);
          if (auth === owned) {
            assert.equal(found.job.state, "needs_reconciliation");
            assert.equal(found.job.quarantined, true);
          }
        }
      }
      await assert.rejects(request(directory, { action: "find-request", auth: owned,
        requestId: "epoch-request", expectedRequest: { ...expected, timeoutMs: 999 } }),
        { code: "REQUEST_CONFLICT" });
      console.log("REAL_IPC_HISTORY_OWNER_EXPECTED_AND_FOREIGN_CHECKED");
    } finally { await broker.close(); }
  } else await assert.rejects(start(), ${mode === "empty-archive" ? '{ name: "SyntaxError" }' : `{ code: ${JSON.stringify(denyVerification ? "ROOT_NATIVE_VERIFY_DENIED" : mode === "unknown-grant" ? "PHYSICAL_GENERATION_REJECTED" : mode === "backend-failure" ? "BACKEND_FACTORY_FAILED" : "ROOT_STARTUP_TEST_STOP")} }`});
  assert.equal(verified, ${mode === "empty-archive" ? 0 : 1});
  assert.equal(grants, ${denyVerification || mode === "empty-archive" ? 0 : 1});
  assert.equal(sdk, 0);
  assert.equal(fs.existsSync(path.join(directory, "broker.lock")), ${uncertainGrant});
  if (${uncertainGrant}) {
    const owner = JSON.parse(fs.readFileSync(path.join(directory, "broker.lock"), "utf8"));
    const lifecycle = JSON.parse(fs.readFileSync(path.join(directory,
      "broker-lifecycle-" + owner.nonce + ".json"), "utf8"));
    assert.equal(lifecycle.stage, "failed");
    assert.equal(lifecycle.safeToRecover, false);
    assert.deepEqual(lifecycle.owner, owner);
    assert.equal(lifecycle.grantIssuance, ${JSON.stringify(mode === "backend-failure" ? "issued" : "unknown")});
  }
  console.log("ROOT_STARTUP_BOUNDARY_CHECKED");
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["-e", code], {
      cwd: path.join(__dirname, ".."),
      env,
      encoding: "utf8",
      timeout: 20000,
    });
    if (mode === "kill-provision") {
      assert.equal(result.signal, "SIGKILL", result.stderr);
      assert.match(result.stdout, /ISSUER_ENTERED_BEFORE_SIGKILL/);
      const owner = JSON.parse(
        fs.readFileSync(path.join(f.directory, "broker.lock"), "utf8"),
      );
      const lifecycle = JSON.parse(
        fs.readFileSync(
          path.join(f.directory, `broker-lifecycle-${owner.nonce}.json`),
          "utf8",
        ),
      );
      assert.deepEqual(lifecycle.owner, owner);
      assert.equal(lifecycle.stage, "provisioning");
      assert.equal(lifecycle.grantIssuance, "unknown");
      assert.equal(lifecycle.safeToRecover, false);
      const verify = spawnSync(
        process.execPath,
        [
          "-e",
          `
const assert = require("node:assert/strict");
const directory = ${JSON.stringify(f.directory)};
require("./src/queue-connection.js").queueDirectory = () => directory;
let reclaims = 0;
require("./src/queue-instance.js").reclaim = () => {
  reclaims++;
  throw new Error("Uncertain physical provisioning must not be reclaimed");
};
const { ensureBroker } = require("./src/queue-autostart.js");
(async () => {
  await assert.rejects(ensureBroker({
    routing: "queue", backend: "addin",
    queue: { autoStart: true, startupTimeoutMs: 150 },
  }, { clientId: "fixture-successor", clientToken: "private-test-token" }),
    { code: "BROKER_START_TIMEOUT" });
  assert.equal(reclaims, 0);
  console.log("REAL_AUTOSTART_PRESERVES_UNCERTAIN_PROVISIONING");
})().catch((error) => { console.error(error); process.exitCode = 1; });
`,
        ],
        {
          cwd: path.join(__dirname, ".."),
          env,
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(verify.status, 0, verify.stderr);
      assert.match(
        verify.stdout,
        /REAL_AUTOSTART_PRESERVES_UNCERTAIN_PROVISIONING/,
      );
      assert.deepEqual(
        JSON.parse(
          fs.readFileSync(path.join(f.directory, "broker.lock"), "utf8"),
        ),
        owner,
      );
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /ROOT_STARTUP_BOUNDARY_CHECKED/);
    if (mode === "history-ipc")
      assert.match(
        result.stdout,
        /REAL_IPC_HISTORY_OWNER_EXPECTED_AND_FOREIGN_CHECKED/,
      );
    assert.equal(
      fs.readFileSync(legacyFile, "utf8"),
      "deliberately-invalid-legacy-pointer",
    );
    if (denyVerification) assert.deepEqual(fs.readFileSync(f.file), f.bytes);
  });
}

test("changed current bytes between native view and claim refuse before projection", (t) => {
  const f = fixture(t);
  const factory = f.factory();
  fs.appendFileSync(f.file, "\n");
  const changed = fs.readFileSync(f.file);
  assert.throws(() => factory.forDirectory(f.directory), {
    code: "RUNTIME_RETIREMENT_CHANGED",
  });
  assert.deepEqual(fs.readFileSync(f.file), changed);
});

test("lost owner or changed root refuses without changing the original queue", (t) => {
  for (const reason of ["owner", "root"]) {
    const f = fixture(t);
    const authority = f.factory().forDirectory(f.directory);
    if (reason === "owner") f.loseOwner();
    else f.invalidateRoot();
    assert.throws(
      () =>
        new QueueState(f.directory, {
          runtimeRetirement: authority,
          now: () => 200,
        }),
      { code: reason === "owner" ? "OWNER_LOST" : "ROOT_CHANGED" },
    );
    assert.deepEqual(fs.readFileSync(f.file), f.bytes);
  }
});

test("new private verification preserves evolved jobs instead of restoring the frozen baseline", (t) => {
  const f = fixture(t);
  const first = new QueueState(f.directory, {
    runtimeRetirement: f.factory().forDirectory(f.directory),
    now: () => 200,
  });
  first.pause(false);
  const evolved = fs.readFileSync(f.file);
  f.root.currentFiles["queue-state.json"] = evolved;
  const reopened = new QueueState(f.directory, {
    runtimeRetirement: f.factory().forDirectory(f.directory),
    now: () => 300,
  });
  assert.equal(reopened.data.paused, false);
  assert.equal(reopened.data.active, null);
  assert.deepEqual(fs.readFileSync(f.file), evolved);
});

test("repeated retirement probes revalidate changed bytes even with identical file metadata", (t) => {
  const f = fixture(t);
  const authority = f.factory().forDirectory(f.directory);
  const state = new QueueState(f.directory, { runtimeRetirement: authority, now: () => 200 });
  const probe = () => state.documentConflicts({ creationId: "doc-A" });
  assert.equal(probe().length, 1);
  assert.equal(probe().length, 1);
  const original = fs.readFileSync(f.file);
  const stat = fs.statSync(f.file);
  const changed = Buffer.from(original.toString().replace("native-approved-head", "native-rejected-head"));
  assert.equal(changed.length, original.length);
  fs.writeFileSync(f.file, changed);
  fs.utimesSync(f.file, stat.atime, stat.mtime);
  assert.throws(probe, { code: "RUNTIME_RETIREMENT_CHANGED" });
  fs.writeFileSync(f.file, original);
  assert.equal(probe().length, 1);
  // A valid marker cannot make invalid JSON inheritable. A failed validation
  // must not replace the last verified image or poison a subsequent good read.
  fs.writeFileSync(f.file, Buffer.concat([original, Buffer.from("{}")]));
  assert.throws(probe);
  fs.writeFileSync(f.file, original);
  assert.equal(probe().length, 1);
  assert.deepEqual(state.data.jobs[f.submitted.id], f.frozen.jobs[f.submitted.id]);
});

test("warm retirement probes still fence current ownership and root revocation", (t) => {
  for (const reason of ["owner", "root"]) {
    const f = fixture(t);
    const state = new QueueState(f.directory, {
      runtimeRetirement: f.factory().forDirectory(f.directory), now: () => 200,
    });
    assert.equal(state.documentConflicts({ creationId: "doc-A" }).length, 1);
    const original = fs.readFileSync(f.file);
    if (reason === "owner") f.loseOwner();
    else f.invalidateRoot();
    assert.throws(() => state.documentConflicts({ creationId: "doc-A" }), {
      code: reason === "owner" ? "OWNER_LOST" : "ROOT_CHANGED",
    });
    assert.deepEqual(fs.readFileSync(f.file), original);
  }
});

test("retired document probes with 17000 completed jobs stay within the existing heartbeat budget", { timeout: 60000 }, (t) => {
  const f = fixture(t, 17000);
  const state = new QueueState(f.directory, {
    runtimeRetirement: f.factory().forDirectory(f.directory), now: () => 200,
  });
  const before = performance.now();
  for (let index = 0; index < 10; index++)
    assert.equal(state.documentConflicts({ creationId: "doc-A" }).length, 1);
  const elapsed = performance.now() - before;
  t.diagnostic(`10 document probes, 17000 completed jobs + 1 retained UNKNOWN: ${elapsed.toFixed(2)} ms`);
  assert.ok(elapsed < 30000, "do not extend the production 30-second heartbeat budget");
  assert.equal(Object.keys(state.data.jobs).length, 17001);
  assert.deepEqual(state.data.jobs[f.submitted.id], f.frozen.jobs[f.submitted.id]);
});

test("a sustained retirement conflict-check burst does not starve the existing heartbeat", { timeout: 60000 }, (t) => {
  const f = fixture(t, 17000);
  const state = new QueueState(f.directory, {
    runtimeRetirement: f.factory().forDirectory(f.directory), now: () => 200,
  });
  const before = performance.now();
  for (let index = 0; index < 1000; index++)
    assert.equal(state.documentConflicts({ creationId: "doc-A" }).length, 1);
  const elapsed = performance.now() - before;
  t.diagnostic(`1000 document probes, 17000 completed jobs + 1 retained UNKNOWN: ${elapsed.toFixed(2)} ms`);
  assert.ok(elapsed < 30000, "the synchronous burst must not starve the production 30-second heartbeat");
  assert.deepEqual(state.data.jobs[f.submitted.id], f.frozen.jobs[f.submitted.id]);
  f.loseOwner();
  assert.throws(() => state.documentConflicts({ creationId: "doc-A" }), { code: "OWNER_LOST" });
});

test("an approved-root assertion cannot authenticate a different supplied record or frozen snapshot", (t) => {
  for (const changed of ["record", "snapshot"]) {
    const f = fixture(t);
    if (changed === "record")
      f.root.record.layers.root.dispositions[f.submitted.id].outcome =
        "not_started";
    else
      f.root.frozenBaseline.snapshots.root.jobs[f.submitted.id].requestId =
        "forged-original";
    assert.throws(() => f.factory(), { code: "RUNTIME_RETIREMENT_CHANGED" });
    assert.deepEqual(fs.readFileSync(f.file), f.bytes);
  }
});
test("a failed atomic projection write never publishes a classified queue", (t) => {
  const f = fixture(t);
  const authority = f.factory().forDirectory(f.directory);
  const rename = fs.renameSync;
  try {
    fs.renameSync = (source, target) => {
      if (target === f.file)
        throw Object.assign(new Error("owned projection I/O failure"), {
          code: "EIO",
        });
      return rename(source, target);
    };
    assert.throws(
      () =>
        new QueueState(f.directory, {
          runtimeRetirement: authority,
          now: () => 200,
        }),
      { code: "STORAGE_UNAVAILABLE" },
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(fs.readFileSync(f.file), f.bytes);
  assert.equal(
    JSON.parse(fs.readFileSync(f.file, "utf8")).appliedRuntimeRetirement,
    undefined,
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(f.directory, "queue-state.pending.json"),
        "utf8",
      ),
    ).recoveryRequired,
    true,
  );
  assert.throws(
    () =>
      new QueueState(f.directory, {
        runtimeRetirement: authority,
        now: () => 300,
      }),
    { code: "STORAGE_UNAVAILABLE" },
  );
});
test("serialized authority cannot authorize the actual staged QueueState", (t) => {
  const f = fixture(t);
  const serialized = JSON.parse(
    JSON.stringify(f.factory().forDirectory(f.directory)),
  );
  assert.throws(
    () =>
      new QueueState(f.directory, {
        runtimeRetirement: serialized,
        now: () => 200,
      }),
    { code: "RUNTIME_RETIREMENT_AUTHORITY_REQUIRED" },
  );
  assert.deepEqual(fs.readFileSync(f.file), f.bytes);
});
test("the approved current byteview is captured privately rather than borrowed from mutable input", (t) => {
  const f = fixture(t);
  const factory = f.factory();
  const changed = Buffer.concat([f.bytes, Buffer.from("\n")]);
  f.root.currentFiles["queue-state.json"] = changed;
  fs.writeFileSync(f.file, changed);
  assert.throws(() => factory.forDirectory(f.directory), {
    code: "RUNTIME_RETIREMENT_CHANGED",
  });
  assert.deepEqual(fs.readFileSync(f.file), changed);
});
test("a capability for directory A cannot publish in directory B with identical bytes", (t) => {
  const f = fixture(t);
  const authority = f.factory().forDirectory(f.directory);
  const other = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-unrelated-")),
  );
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.chmodSync(other, 0o750);
  const file = path.join(other, "queue-state.json");
  fs.writeFileSync(file, f.bytes, { mode: 0o600 });
  assert.throws(
    () =>
      new QueueState(other, {
        runtimeRetirement: authority,
        now: () => 200,
      }),
    { code: "RUNTIME_RETIREMENT_CHANGED" },
  );
  assert.equal(fs.statSync(other).mode & 0o777, 0o750);
  assert.deepEqual(fs.readFileSync(file), f.bytes);
  assert.deepEqual(fs.readFileSync(f.file), f.bytes);
});
test("missing approved snapshot cannot become a new empty queue", (t) => {
  const f = fixture(t);
  const authority = f.factory().forDirectory(f.directory);
  fs.unlinkSync(f.file);
  assert.throws(
    () =>
      new QueueState(f.directory, {
        runtimeRetirement: authority,
        now: () => 200,
      }),
  );
  assert.equal(fs.existsSync(f.file), false);
});
test("pending async ownership or root assertions cannot authorize publication", (t) => {
  for (const kind of ["owner", "root"]) {
    const f = fixture(t);
    const authority = f.factory().forDirectory(f.directory);
    if (kind === "owner") f.asyncOwner();
    else f.asyncRoot();
    assert.throws(
      () =>
        new QueueState(f.directory, {
          runtimeRetirement: authority,
          now: () => 200,
        }),
      { code: "RUNTIME_RETIREMENT_CHANGED" },
    );
    assert.deepEqual(fs.readFileSync(f.file), f.bytes);
  }
});
test("domain validation refusal precedes every byte of projection publication", (t) => {
  const f = fixture(t);
  f.frozen.documentUnlockIntents = {
    bad: {
      actorClientId: "owner",
      requestId: "request",
      requestHash: "invalid-hash",
    },
  };
  const bytes = Buffer.from(JSON.stringify(f.frozen));
  const reference = f.root.record.frozen["queue-state.json"];
  reference.sha256 = sha(bytes);
  f.root.currentFiles["queue-state.json"] = bytes;
  fs.writeFileSync(f.file, bytes);
  fs.writeFileSync(reference.path, bytes);
  const archive = path.join(
    f.directory,
    "runtime-rebaselines",
    "owned-test-root",
  );
  const recordFile = path.join(archive, "record.json");
  fs.writeFileSync(recordFile, JSON.stringify(f.root.record));
  fs.writeFileSync(
    path.join(f.directory, "runtime-rebaseline-head.json"),
    JSON.stringify({
      version: 1,
      newHead: f.root.record.receipt.newHead,
      record: { path: recordFile, sha256: sha(JSON.stringify(f.root.record)) },
    }),
  );
  const authority = f.factory().forDirectory(f.directory);
  assert.throws(
    () =>
      new QueueState(f.directory, {
        runtimeRetirement: authority,
        now: () => 200,
      }),
    { code: "CORRUPT_STATE" },
  );
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  assert.equal(
    JSON.parse(fs.readFileSync(f.file, "utf8")).active,
    f.submitted.id,
  );
  assert.equal(
    fs.existsSync(path.join(f.directory, "queue-state.pending.json")),
    false,
  );
});
for (const kind of ["owner", "root"]) {
  test(`rejected asynchronous ${kind} assertion is refused without terminating the process`, () => {
    const code = `
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { QueueDomain } = require("@fmcad/core");
const { QueueState } = require(${JSON.stringify(path.join(__dirname, "../src/queue-state.js"))});
const { createApprovedRuntimeRetirement } = require(${JSON.stringify(path.join(__dirname, "../src/queue-runtime-retirement.js"))});
const sha = (bytes) => require("node:crypto").createHash("sha256").update(bytes).digest("hex");
const fixture = ${fixture.toString()};
const cleanup = [];
const f = fixture({ after(fn) { cleanup.push(fn); } });
const authority = f.factory().forDirectory(f.directory);
f[${JSON.stringify(kind === "owner" ? "asyncOwner" : "asyncRoot")}](true);
assert.throws(() => new QueueState(f.directory, {
  runtimeRetirement: authority, now: () => 200,
}), { code: "RUNTIME_RETIREMENT_CHANGED" });
assert.deepEqual(fs.readFileSync(f.file), f.bytes);
setImmediate(() => {
  assert.deepEqual(fs.readFileSync(f.file), f.bytes);
  for (const fn of cleanup) fn();
  console.log("REFUSED_NO_WRITE");
});`;
    const result = spawnSync(process.execPath, ["-e", code], {
      encoding: "utf8",
      cwd: path.join(__dirname, ".."),
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /REFUSED_NO_WRITE/);
  });
}
