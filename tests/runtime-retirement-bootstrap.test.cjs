const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const test = require("node:test");
const { QueueDomain } = require("@fmcad/core");
const { QueueState } = require("../src/queue-state.js");
const {
  createApprovedRuntimeRetirement,
} = require("../src/queue-runtime-retirement.js");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The native-root and ownership assertions are explicit test ports. This suite
// exercises the real byte adapter, snapshot store and staged QueueDomain; it is
// not evidence that a native grant was issued or that Fusion ran.
function fixture(t) {
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
        if (!owned)
          throw Object.assign(new Error("writer lost"), { code: "OWNER_LOST" });
      },
      assertVerifiedRoot(actual) {
        assert.equal(actual, directory);
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
    get assertions() {
      return assertions;
    },
  };
}

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
