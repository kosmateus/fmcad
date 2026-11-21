import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const subject = load(
  "./src/dist/composition/queue-frozen-inline-observer",
) as typeof import("../src/composition/queue-frozen-inline-observer");
const api = load("./src/queue-instance") as {
  priorProcessAlive(process: { pid: number; birth: string }): boolean | null;
};
const p = subject.inlineObserverPolicy;
const refusal = { code: "FROZEN_METADATA_FENCE_CHANGED" };
function proofFixture(t: { after(fn: () => void): void }): string {
  const source = fs.readFileSync(
    path.join(root, "tests/fixtures/frozen-inline-observer-evidence.json"),
  );
  // The operator's original JSON has no trailing LF. Production never normalizes
  // bytes; only this test reconstructs the original from a text-friendly copy.
  assert.equal(source.at(-1), 10);
  const original = source.subarray(0, source.length - 1);
  assert.equal(
    createHash("sha256").update(original).digest("hex"),
    p.proofHash,
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-proof-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "evidence.json");
  fs.writeFileSync(file, original);
  return file;
}
type Data = Record<string, unknown>;
function object(value: unknown): Data {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as Data;
}

// Synthetic public binding fields, not copies of the credential-bearing ledger.
// These cases qualify domain checks only. The full wrapper has separate
// negative tests below and real, read-only original-proof qualification.
function recordsFixture() {
  const owner = {
    pid: 1470648,
    birth: "54299d3b-5d9a-4589-90e1-a53287c516c9:64702243",
    nonce: "e8956024-9420-4616-8724-e02ada9dd476",
    protocol: 2,
  };
  const instance = {
    pid: 50352,
    birth: "134375220106992528",
    version: "2706.1.14",
  };
  const binding = {
    jobId: p.jobId,
    rpcId: p.rpcId,
    requestHash: p.rpcRequestHash,
    buildHash: p.observerBuild,
    sourceHash: p.sourceHash,
    observationKind: "atomic_holder_status",
    observationTargetJobId: p.targetId,
    observationIdentityHash: p.identityHash,
    atomicRuntimeAbiHash: p.abiHash,
    pythonOriginHash: p.originHash,
  };
  const marker = {
    version: 1,
    kind: "atomic-holder-status",
    targetJobId: p.targetId,
    targetRequestId: p.targetRequestId,
    targetClientId: p.clientId,
    targetJobHash: p.targetHash,
    observerJobHash: p.jobHash,
    targetBuildHash: p.targetBuild,
    observerBuildHash: p.observerBuild,
    projectDirectory: p.projectDirectory,
    paused: true,
    controlGeneration: 25,
    contextEpoch: 12,
    reportPath: p.reportPath,
    reportFingerprint: p.reportFingerprint,
    commandId: p.commandId,
    sessionNonce: p.sessionNonce,
    docId: p.docId,
  };
  const job: Data = {
    id: p.jobId,
    requestId: p.requestId,
    clientId: p.clientId,
    hash: p.jobHash,
    kind: "command",
    state: "needs_reconciliation",
    workflowObservation: marker,
    request: {
      kind: "command",
      backend: "addin",
      buildHash: p.observerBuild,
      payload: {
        invocation: {
          kind: "cad",
          operation: "batch.reconcile",
          preview: false,
          docId: p.docId,
          data: {
            blockedJobId: p.targetId,
            operations: [],
            commandId: p.commandId,
            sessionNonce: p.sessionNonce,
          },
        },
      },
    },
    dispatch: {
      rpcState: "terminal",
      dispatchCount: 2,
      rpcCount: 1,
      completedCount: 1,
      details: { rpcId: p.rpcId },
    },
  };
  const common = {
    version: 1,
    kind: "atomic_holder_status",
    observerJobId: p.jobId,
    observerRequestId: p.requestId,
    targetJobId: p.targetId,
    targetRequestId: p.targetRequestId,
    clientId: p.clientId,
    observerBuildHash: p.observerBuild,
    originalBuildHash: p.targetBuild,
    projectDirectory: p.projectDirectory,
    reportPath: p.reportPath,
    reportFingerprint: p.reportFingerprint,
    binding,
  };
  const receipt: Data = {
    ...binding,
    terminal: true,
    outcome: "succeeded",
    instance,
  };
  const records: {
    start: Data;
    proof: Data;
    rpc: Data;
    receipt: Data;
    lifecycle: Data;
    sdkDeath: Data;
  } = {
    start: { ...common, owner, instance },
    proof: {
      ...common,
      rpcId: p.rpcId,
      readOnlyOperation: "atomic_status",
      remoteOutcome: "succeeded",
      toolFailed: false,
      observerInstance: instance,
      summary: { outcome: "unknown" },
    },
    rpc: {
      binding,
      remoteReceipt: receipt,
      terminal: true,
      method: "tools/call",
      request: { id: 2 },
      wireRequest: { id: `fmcad:${p.rpcId}` },
      instance,
      pythonCheck: { status: "passed" },
      pythonArtifact: {
        request: binding,
        context: {
          origin: {
            artifactHash: p.originHash,
            request: { operation: "atomic_status" },
          },
        },
      },
    },
    receipt,
    lifecycle: {
      owner,
      buildHash: p.observerBuild,
      stage: "ready",
      binding: {
        brokerNonce: owner.nonce,
        ownerPid: owner.pid,
        ownerBirth: owner.birth,
        buildHash: p.observerBuild,
        stage: "startup",
      },
    },
    sdkDeath: {
      oldSdkPid: instance.pid,
      expectedBirth: instance.birth,
      present: false,
      actualBirth: null,
    },
  };
  return structuredClone({ job, records, owner, instance });
}

test("record checker binds the exact inline observer, not target settlement or a worker identity", (t) => {
  const f = recordsFixture();
  const seen: { pid: number; birth: string }[] = [];
  t.mock.method(
    api,
    "priorProcessAlive",
    (process: { pid: number; birth: string }) => {
      seen.push(process);
      return false;
    },
  );
  const before = structuredClone(f);
  for (let fence = 0; fence < 2; fence++)
    assert.deepEqual(subject.checkInlineObserverBindings(f.job, f.records), {
      pid: f.owner.pid,
      birth: f.owner.birth,
    });
  assert.equal(
    seen.length,
    4,
    "both namespace-aware process checks run at each fence",
  );
  assert.deepEqual(
    f,
    before,
    "UNKNOWN and historical evidence are never settled",
  );
});

const tamper: [string, (f: ReturnType<typeof recordsFixture>) => void][] = [
  [
    "job scope",
    (f) => {
      f.job["id"] = p.targetId;
    },
  ],
  [
    "request scope",
    (f) => {
      f.job["requestId"] = "foreign";
    },
  ],
  [
    "immutable job hash",
    (f) => {
      f.job["hash"] = "f".repeat(64);
    },
  ],
  [
    "observer build is not target build",
    (f) => {
      object(f.job["request"])["buildHash"] = p.targetBuild;
    },
  ],
  [
    "route",
    (f) => {
      object(f.job["workflowObservation"])["kind"] = "export";
    },
  ],
  [
    "target binding",
    (f) => {
      object(f.job["workflowObservation"])["targetJobHash"] = "f".repeat(64);
    },
  ],
  [
    "late dispatch",
    (f) => {
      object(f.job["dispatch"])["rpcCount"] = 2;
    },
  ],
  [
    "source hash",
    (f) => {
      object(f.records.start["binding"])["sourceHash"] = "f".repeat(64);
    },
  ],
  [
    "foreign RPC",
    (f) => {
      object(f.records.rpc["binding"])["rpcId"] = "foreign";
    },
  ],
  [
    "broker nonce",
    (f) => {
      object(f.records.lifecycle["owner"])["nonce"] = "foreign";
    },
  ],
  [
    "broker PID",
    (f) => {
      object(f.records.start["owner"])["pid"] = 123;
    },
  ],
  [
    "SDK identity",
    (f) => {
      object(f.records.receipt["instance"])["birth"] = "foreign";
    },
  ],
  [
    "missing terminal",
    (f) => {
      f.records.rpc["terminal"] = false;
    },
  ],
  [
    "missing close-bound receipt",
    (f) => {
      f.records.receipt["terminal"] = false;
    },
  ],
  [
    "altered origin",
    (f) => {
      object(object(f.records.rpc["pythonArtifact"])["context"])["origin"] = {};
    },
  ],
  [
    "snapshot is not death",
    (f) => {
      f.records.sdkDeath["present"] = true;
    },
  ],
];
for (const [name, change] of tamper) {
  test(`record checker refuses ${name} before a claim`, (t) => {
    const f = recordsFixture();
    t.mock.method(api, "priorProcessAlive", () => false);
    change(f);
    let claims = 0;
    assert.throws(() => {
      subject.checkInlineObserverBindings(f.job, f.records);
      claims++;
    }, refusal);
    assert.equal(claims, 0);
  });
}

for (const alive of [true, null]) {
  test(`record checker refuses live/unknown processes (${alive}) in either namespace`, (t) => {
    const f = recordsFixture();
    for (const pid of [f.owner.pid, f.instance.pid]) {
      t.mock.method(
        api,
        "priorProcessAlive",
        (process: { pid: number; birth: string }) =>
          process.pid === pid ? alive : false,
      );
      assert.throws(
        () => subject.checkInlineObserverBindings(f.job, f.records),
        refusal,
      );
    }
  });
}

test("full wrapper refuses bad references and a changed proof before accepting any inspector facts", (t) => {
  const file = proofFixture(t);
  const bytes = fs.readFileSync(file);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), p.proofHash);
  assert.throws(
    () =>
      subject.verifyFrozenInlineObserver(
        root,
        {},
        { path: file, sha256: "f".repeat(64) },
      ),
    refusal,
  );
  assert.throws(
    () =>
      subject.verifyFrozenInlineObserver(
        root,
        {},
        { path: file + ".missing", sha256: p.proofHash },
      ),
    refusal,
  );
  assert.equal(
    subject.isInlineObserverProofRef({
      path: file,
      sha256: p.proofHash,
      accepted: true,
    }),
    false,
  );
});

test("each parsed record uses one verified buffer even when later reads alternate A/B/A", (t) => {
  const file = proofFixture(t);
  const a = Buffer.from('{"timeoutMs":30}');
  const b = Buffer.from('{"timeoutMs":999}');
  fs.writeFileSync(file, a);
  const pin = createHash("sha256").update(a).digest("hex");
  const originalRead = fs.readFileSync;
  const originalParse = JSON.parse;
  let reads = 0;
  let parsedA = 0;
  let parsedB = 0;
  t.mock.method(fs, "readFileSync", ((
    name: fs.PathOrFileDescriptor,
    ...options: unknown[]
  ) => {
    if (String(name) === file) {
      reads++;
      return reads === 2 ? b : a;
    }
    return Reflect.apply(originalRead, fs, [name, ...options]);
  }) as typeof fs.readFileSync);
  t.mock.method(JSON, "parse", (text: string, ...options: unknown[]) => {
    if (text === a.toString("utf8")) parsedA++;
    if (text === b.toString("utf8")) parsedB++;
    return Reflect.apply(originalParse, JSON, [text, ...options]);
  });
  assert.deepEqual(subject.readPinnedInlineRecord(file, pin), {
    timeoutMs: 30,
  });
  assert.equal(
    reads,
    1,
    "a record parse must not take a second unverified read",
  );
  assert.throws(() => subject.readPinnedInlineRecord(file, pin), refusal);
  assert.equal(reads, 2);
  assert.equal(parsedB, 0, "mismatching bytes must never reach JSON.parse");
  assert.deepEqual(subject.readPinnedInlineRecord(file, pin), {
    timeoutMs: 30,
  });
  assert.equal(parsedA, 2);
  // These counts concern three record reads, not a global one-read restriction:
  // independent final fences are required to re-read the underlying files.
});

for (const mode of ["tampered-source", "missing-archive"] as const) {
  test(`full wrapper refuses ${mode} at the actual source-file boundary`, (t) => {
    const proof = proofFixture(t);
    const manifest = object(JSON.parse(fs.readFileSync(proof, "utf8")));
    const source = String(
      object((manifest["sourceRefs"] as unknown[])[0])["path"],
    );
    const stat = fs.lstatSync(proof);
    const originalStat = fs.lstatSync,
      originalReal = fs.realpathSync,
      originalRead = fs.readFileSync;
    let checkedSource = 0;
    t.mock.method(fs, "lstatSync", ((file, ...options) => {
      if (String(file) === source) {
        checkedSource++;
        if (mode === "missing-archive")
          throw Object.assign(new Error("fixture missing"), { code: "ENOENT" });
        return stat;
      }
      return Reflect.apply(originalStat, fs, [file, ...options]);
    }) as typeof fs.lstatSync);
    t.mock.method(fs, "realpathSync", ((file, ...options) =>
      String(file) === source
        ? source
        : Reflect.apply(originalReal, fs, [
            file,
            ...options,
          ])) as typeof fs.realpathSync);
    t.mock.method(fs, "readFileSync", ((
      file: fs.PathOrFileDescriptor,
      ...options: unknown[]
    ) =>
      String(file) === source
        ? Buffer.from("tampered source bytes")
        : Reflect.apply(originalRead, fs, [
            file,
            ...options,
          ])) as typeof fs.readFileSync);
    assert.throws(
      () =>
        subject.verifyFrozenInlineObserver(
          root,
          {},
          { path: proof, sha256: p.proofHash },
        ),
      refusal,
    );
    assert.equal(
      checkedSource,
      1,
      "the real proof pin passed; source verification rejected it",
    );
  });
}
