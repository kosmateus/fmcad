type FixtureRequest = {
  kind: "command" | "rpc";
  clientId: string;
  requestId: string;
  timeoutMs: number;
  cwd: string;
  argv: string[];
  isolatedEpoch?: string;
  payload: {
    version: 1;
    kind: string;
    operation: string;
    doc: string;
    docId?: string;
    docFileId?: string;
    data: Record<string, unknown>;
  };
};
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import {
  object,
  field,
  array,
  string,
  present,
} from "./modeling-unit-test-support";
const sourceDirectory = path.join(process.cwd(), "tests");
const sourceFile = path.join(sourceDirectory, "isolated-epoch.test.ts");
const loadModule = createRequire(sourceFile);

const { QueueState } = loadModule(
  "../src/queue-state",
) as typeof import("../src/queue-state");
const { openIsolatedEpoch, epochAdmission } = loadModule(
  "../src/queue-isolated-epoch",
) as typeof import("../src/queue-isolated-epoch");
const { durable, hash, processBirth } = loadModule(
  "../src/queue-instance",
) as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { fileHash } = loadModule(
  "../src/queue-atomic-migration-files",
) as typeof import("../src/queue-atomic-migration-files");

function fixture(t: TestContext) {
  const root = fs.mkdtempSync("/tmp/opencode/isolated-epoch-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = new QueueState(root);
  const request = (requestId: string, operation: string) => ({
    clientId: "owner",
    requestId,
    kind: "command",
    timeoutMs: 1000,
    backend: "addin",
    buildHash: "original",
    cwd: root,
    argv: ["cad", operation.replace(".", " ")],
    payload: {
      version: 1 as const,
      kind: "cad" as const,
      operation,
      doc: "Historical",
      docId: "historical-doc",
      data: {},
    },
  });
  const target = original.submit(request("original-request", "batch.run"));
  original.next();
  original.markDispatch(string(target["id"]), {
    rpcCount: 1,
    completedCount: 0,
  });
  original.block(string(target["id"]), { code: "WORKFLOW_NONTERMINAL" });
  const observation = request("observer-request", "batch.reconcile");
  observation.payload.data = {
    reportPath: path.join(root, "report"),
    blockedJobId: string(target["id"]),
    commandId: "fmcad_atomic_" + "b".repeat(32),
    sessionNonce: "c".repeat(32),
  };
  const observer = original.submit(observation);
  original.armWorkflowObservation(string(observer["id"]), {
    version: 1,
    kind: "atomic-holder-status",
    targetJobId: string(target["id"]),
    targetRequestId: string(target["requestId"]),
    targetClientId: "owner",
    targetJobHash: present(original.data.jobs[string(target["id"])]).hash,
    targetBuildHash: "original",
    observerBuildHash: "original",
    projectDirectory: root,
    paused: false,
    controlGeneration: 0,
    contextEpoch: 0,
    reportPath: path.join(root, "report"),
    reportFingerprint: "a".repeat(64),
    commandId: "fmcad_atomic_" + "b".repeat(32),
    sessionNonce: "c".repeat(32),
    docId: "historical-doc",
    observerJobHash: present(original.data.jobs[string(observer["id"])]).hash,
  });
  original.next();
  original.markDispatch(string(observer["id"]), {
    rpcCount: 1,
    completedCount: 1,
  });
  original._commit((d) => {
    present(d.jobs[string(observer["id"])]).state = "needs_reconciliation";
    d.paused = true;
    return null;
  });
  const originalInstance = {
    pid: 2147483646,
    birth: "terminated:fixture",
    version: "2706",
  };
  const currentInstance = {
    pid: process.pid,
    birth: processBirth(),
    version: "2706",
  };
  durable(
    path.join(root, "instance.json"),
    { buildHash: "original", instance: originalInstance },
    true,
  );
  const bytes = fs.readFileSync(path.join(root, "queue-state.json"));
  const epochId = randomUUID(),
    document = {
      name: "FMCAD_ISOLATED_" + epochId,
      creationId: "new-sdk-creation-id",
      fileId: null,
    };
  const receipt = path.join(
    root,
    "isolated-scratch-qualification",
    "result.json",
  );
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  durable(
    receipt,
    {
      kind: "isolated-scratch-qualification",
      clientId: "owner",
      status: "complete",
      summary: { purpose: "isolated-scratch-epoch-v1", epochId, document },
      currentInstance,
      nativeOutcome: "unknown",
    },
    true,
  );
  const qualificationEvidence = [
    "intent.json",
    "start.json",
    "wire.json",
    "sdk-qualified.json",
    "remote-" + randomUUID() + ".json",
  ].map((name) => {
    const file = path.join(path.dirname(receipt), name);
    durable(file, { syntheticUnitFixture: name }, true);
    return { path: file, sha256: fileHash(file).sha256 };
  });
  const pointer = {
    version: 1,
    kind: "isolated-fresh-scratch-epoch",
    epochId,
    root: path.join(root, "admission-epochs", epochId),
    document,
    ownerClientId: "owner",
    ownerTokenHash: hash("owner-private-token"),
    originalInstance,
    currentInstance,
    historicalSnapshotHash: hash(bytes.toString()),
    historicalIdentityHash: fileHash(path.join(root, "instance.json")).sha256,
    qualificationReceipt: { path: receipt, sha256: fileHash(receipt).sha256 },
    quarantinedJobIds: [string(target["id"]), string(observer["id"])],
    qualificationEvidence,
    historicalOutcome: "unknown",
    originalModelValidation: "not_performed",
    originalRollbackVerification: "not_performed",
  };
  const state = openIsolatedEpoch(root, {
    recover: false,
    expectedSnapshotHash: hash(bytes),
  });
  const identity = {
    buildHash: "new-qualified-build",
    instance: currentInstance,
  };
  const initialization = {
    createdAtMs: Date.now(),
    bindingHash: "original-creation-binding",
  };
  const install = () => state.installEpoch(pointer, identity, initialization);
  const clients = {
    owner: pointer.ownerTokenHash,
    mcp: hash("mcp-private-token"),
  };
  const typed = (): FixtureRequest => {
    const payload = {
      version: 1 as const,
      kind: "cad" as const,
      operation: "sketch.create",
      doc: document.name,
      docId: document.creationId,
      data: {},
    };
    return {
      kind: "command",
      clientId: "owner",
      requestId: "new-request",
      timeoutMs: 1000,
      cwd: root,
      payload,
      argv: (
        loadModule(
          "../src/cad-service",
        ) as typeof import("../src/composition/cad-service")
      ).policyArguments(payload),
    };
  };
  return {
    root,
    state,
    pointer,
    bytes,
    target,
    observer,
    install,
    initialization,
    identity,
    clients,
    typed,
  };
}

test("fresh epoch retains exact unknown historical bytes and uses a separate queue/identity", (t) => {
  const f = fixture(t);
  f.install();
  assert.deepEqual(
    fs.readFileSync(path.join(f.root, "queue-state.json")),
    f.bytes,
  );
  assert.equal(f.state.summary().historicalUnknownJobCount, 2);
  assert.equal(f.state.data.paused, false);
  assert.equal(f.state.data.active, null);
  assert.equal(
    f.state.status(string(f.target["id"]))["state"],
    "needs_reconciliation",
  );
  assert.equal(f.state.status(string(f.target["id"]))["quarantined"], true);
  assert.equal(
    field(present(f.state.findAnyRequest("owner", "original-request")), "id"),
    string(f.target["id"]),
  );
  assert.doesNotThrow(() => epochAdmission(f.state, f.typed(), f.clients));
  f.state.submit(f.typed());
  assert.deepEqual(
    fs.readFileSync(path.join(f.root, "queue-state.json")),
    f.bytes,
  );
  assert.ok(fs.existsSync(path.join(f.pointer.root, "queue-state.json")));
  const reopened = openIsolatedEpoch(f.root, { recover: false });
  assert.equal(present(reopened.epoch).epochId, f.pointer.epochId);
  assert.equal(
    reopened.status(string(f.observer["id"]))["historicalOutcome"],
    "unknown",
  );
});

const mutations: [string, (r: FixtureRequest) => void][] = [
  [
    "old document",
    (r) => {
      r.payload.docId = "historical-doc";
    },
  ],
  [
    "forged new document",
    (r) => {
      r.payload.docId = "forged-new";
    },
  ],
  [
    "active-document fallback",
    (r) => {
      delete r.payload.docId;
    },
  ],
  [
    "saved-file pin",
    (r) => {
      r.payload.docFileId = "saved-file";
    },
  ],
  [
    "foreign epoch",
    (r) => {
      r.isolatedEpoch = "foreign";
    },
  ],
  [
    "raw RPC",
    (r) => {
      r.kind = "rpc";
    },
  ],
  [
    "raw Python",
    (r) => {
      r.payload.kind = "run";
    },
  ],
  [
    "argv fallback",
    (r) => {
      r.argv = ["run", "--code", "unsafe"];
    },
  ],
  [
    "unknown typed operation",
    (r) => {
      r.payload.operation = "unrecognized";
    },
  ],
  [
    "old workflow replay",
    (r) => {
      r.payload.operation = "batch.run";
    },
  ],
  [
    "save",
    (r) => {
      r.payload.operation = "document.save_native";
    },
  ],
  [
    "external references",
    (r) => {
      r.payload.operation = "references.audit";
    },
  ],
  [
    "export",
    (r) => {
      r.payload.operation = "export.step";
    },
  ],
  [
    "broad cleanup",
    (r) => {
      r.payload.operation = "document.clear";
    },
  ],
];
for (const [name, mutate] of mutations)
  test("epoch policy rejects " + name, (t) => {
    const f = fixture(t);
    f.install();
    const r = f.typed();
    mutate(r);
    assert.throws(() => epochAdmission(f.state, r, f.clients), {
      code: "EPOCH_SCOPE_REQUIRED",
    });
  });

test("cross-owner access requires exact client credential/epoch/doc grant and revocation remains effective", (t) => {
  const f = fixture(t);
  f.install();
  const r = f.typed();
  r.clientId = "mcp";
  assert.throws(() => epochAdmission(f.state, r, f.clients), {
    code: "EPOCH_CLIENT_NOT_GRANTED",
  });
  durable(
    path.join(
      f.pointer.root,
      "access-" + hash("mcp\0" + f.clients.mcp) + ".json",
    ),
    {
      epochId: f.pointer.epochId,
      clientId: "mcp",
      clientTokenHash: f.clients.mcp,
      document: f.pointer.document,
    },
    true,
  );
  assert.doesNotThrow(() => epochAdmission(f.state, r, f.clients));
  assert.throws(
    () =>
      epochAdmission(f.state, r, { ...f.clients, mcp: hash("rotated-token") }),
    { code: "EPOCH_CLIENT_NOT_GRANTED" },
  );
  assert.throws(
    () => epochAdmission(f.state, f.typed(), { owner: "foreign-token" }),
    { code: "EPOCH_CLIENT_NOT_GRANTED" },
  );
});

test("old request IDs and historical mutations never cross into the new queue", (t) => {
  const f = fixture(t);
  f.install();
  const r = f.typed();
  r.requestId = "original-request";
  assert.throws(() => f.state.submit(r), {
    code: "HISTORICAL_REQUEST_QUARANTINED",
  });
  for (const op of ["cancel", "resolve", "block"] as const)
    assert.throws(() => f.state[op](string(f.target["id"]), "owner"), {
      code: "INSTANCE_HISTORY_QUARANTINED",
    });
  assert.deepEqual(
    fs.readFileSync(path.join(f.root, "queue-state.json")),
    f.bytes,
  );
});

test("minimal sketch to solid to geometry-read vocabulary is typed and pinned; current unknown work closes admission", (t) => {
  const f = fixture(t);
  f.install();
  for (const operation of [
    "sketch.create",
    "sketch.geometry",
    "model.extrude",
    "entity.inspect",
    "measure.volume",
  ]) {
    const r = f.typed();
    r.payload.operation = operation;
    r.argv = policyArgumentsFor(r.payload);
    assert.doesNotThrow(() => epochAdmission(f.state, r, f.clients));
  }
  const job = f.state.submit(f.typed());
  f.state.next();
  f.state.markDispatch(string(job["id"]), { rpcCount: 1, completedCount: 0 });
  f.state.block(string(job["id"]), { code: "UNKNOWN_RPC" });
  assert.throws(() => epochAdmission(f.state, f.typed(), f.clients), {
    code: "EPOCH_RECONCILIATION_REQUIRED",
  });
  assert.equal(
    f.state.status(string(job["id"]))["state"],
    "needs_reconciliation",
  );
  assert.deepEqual(
    fs.readFileSync(path.join(f.root, "queue-state.json")),
    f.bytes,
  );
});

test("ordinary typed worker stage lookup selects the epoch store, never the historical queue", async (t) => {
  const f = fixture(t);
  f.install();
  const job = f.state.submit(f.typed());
  const stage = await (
    loadModule(
      "../src/composition/stage-dependencies",
    ) as typeof import("../src/composition/stage-dependencies")
  ).createAuthenticatedStageDependencies({
    brokerDirectory: f.root,
    jobId: string(job["id"]),
    clientId: "owner",
    projectDirectory: f.root,
  });
  assert.equal(
    stage,
    null,
    "simple typed modeling has no durable helper/native stage workflow",
  );
});

for (const suffix of [
  "initialization.json",
  "instance.json",
  "isolated-admission-epoch.json",
])
  test(
    "publication crash before " +
      suffix +
      " keeps history closed and resumes local publication only",
    (t) => {
      const f = fixture(t),
        originalLink = fs.linkSync;
      let injected = false;
      fs.linkSync = (from, to) => {
        if (!injected && String(to).endsWith(suffix)) {
          injected = true;
          throw Object.assign(new Error("fixture crash"), { code: "EIO" });
        }
        return originalLink(from, to);
      };
      try {
        assert.throws(f.install, /fixture crash/);
      } finally {
        fs.linkSync = originalLink;
      }
      assert.equal(f.state.epoch, null);
      assert.deepEqual(
        fs.readFileSync(path.join(f.root, "queue-state.json")),
        f.bytes,
      );
      f.install();
      assert.equal(installedEpoch(f.state).epochId, f.pointer.epochId);
    },
  );

test("pointer, prerequisite receipt and process drift all fail closed; closed scratch cannot reopen", (t) => {
  const f = fixture(t);
  f.install();
  durable(
    path.join(f.pointer.root, "closed.json"),
    { epochId: f.pointer.epochId },
    true,
  );
  assert.throws(() => epochAdmission(f.state, f.typed(), f.clients), {
    code: "EPOCH_CLOSED",
  });
  const g = fixture(t);
  g.install();
  durable(path.join(g.root, "isolated-admission-epoch.json"), {
    ...g.pointer,
    epochId: randomUUID(),
  });
  assert.throws(() => epochAdmission(g.state, g.typed(), g.clients), {
    code: "EPOCH_PROOF_INVALID",
  });
  const h = fixture(t);
  h.install();
  durable(h.pointer.qualificationReceipt.path, { status: "forged" });
  assert.throws(() => epochAdmission(h.state, h.typed(), h.clients), {
    code: "EPOCH_PROOF_INVALID",
  });
});

test("tampered SDK evidence, a changed process and an unresolved cleanup intent never grant modeling", (t) => {
  const f = fixture(t);
  f.install();
  durable(
    present(
      f.pointer.qualificationEvidence.find((entry) =>
        entry.path.endsWith("sdk-qualified.json"),
      ),
    ).path,
    { forgedId: "other" },
  );
  assert.throws(() => epochAdmission(f.state, f.typed(), f.clients), {
    code: "EPOCH_PROOF_INVALID",
  });
  const g = fixture(t);
  g.pointer.currentInstance.birth = "terminated:other-process";
  const result = object(
    JSON.parse(fs.readFileSync(g.pointer.qualificationReceipt.path, "utf8")),
  );
  result["currentInstance"] = g.pointer.currentInstance;
  durable(g.pointer.qualificationReceipt.path, result);
  g.pointer.qualificationReceipt.sha256 = fileHash(
    g.pointer.qualificationReceipt.path,
  ).sha256;
  g.install();
  assert.throws(() => epochAdmission(g.state, g.typed(), g.clients), {
    code: "INSTANCE_CHANGED",
  });
  const h = fixture(t);
  h.install();
  fs.mkdirSync(path.join(h.root, "isolated-scratch-close"));
  durable(
    path.join(h.root, "isolated-scratch-close", "intent.json"),
    { uncertain: true },
    true,
  );
  assert.throws(() => epochAdmission(h.state, h.typed(), h.clients), {
    code: "EPOCH_CLEANUP_PENDING",
  });
});

test("epoch publication rejects a symlink before writing initialization or identity into another directory", (t) => {
  const f = fixture(t),
    foreign = fs.mkdtempSync("/tmp/opencode/epoch-foreign-dir-");
  t.after(() => fs.rmSync(foreign, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(f.pointer.root), { recursive: true });
  fs.symlinkSync(foreign, f.pointer.root);
  assert.throws(f.install);
  assert.deepEqual(fs.readdirSync(foreign), []);
  assert.deepEqual(
    fs.readFileSync(path.join(f.root, "queue-state.json")),
    f.bytes,
  );
});
test("epoch facade preserves the checked prepared job ID before and after epoch activation", (t) => {
  const base = fs.mkdtempSync("/tmp/opencode/epoch-prepared-id-");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const rootState = (
    loadModule(
      "../src/queue-isolated-epoch",
    ) as typeof import("../src/queue-isolated-epoch")
  ).openIsolatedEpoch(path.join(base, "root"));
  const request = {
    kind: "rpc",
    requestId: "prepared-root-request",
    clientId: "synthetic-owner",
    timeoutMs: 1000,
    payload: { jsonrpc: "2.0", id: "ping", method: "ping" },
  };
  const rootJob = rootState.submit(request, "prepared-root-job");
  assert.equal(string(rootJob["id"]), "prepared-root-job");
  assert.equal(
    rootState.submit(request)["id"],
    string(rootJob["id"]),
    "Existing request is still a receipt lookup",
  );
  const f = (
    loadModule("./fixtures/current-epoch-upgrade.cjs") as (
      base: string,
      root: string,
    ) => { dir: string; clientId: string }
  )(base, path.resolve(sourceDirectory, ".."));
  const epochState = (
    loadModule(
      "../src/queue-isolated-epoch",
    ) as typeof import("../src/queue-isolated-epoch")
  ).openIsolatedEpoch(f.dir, { recover: false });
  const epochJob = epochState.submit(
    { ...request, requestId: "prepared-epoch-request", clientId: f.clientId },
    "prepared-epoch-job",
  );
  assert.equal(string(epochJob["id"]), "prepared-epoch-job");
  assert.throws(
    () =>
      epochState.submit(
        { ...request, requestId: "another-request" },
        string(epochJob["id"]),
      ),
    { code: "INVALID_PREPARED_ID" },
  );
});

function policyArgumentsFor(payload: unknown): string[] {
  const policy = (
    loadModule(
      "../src/cad-service",
    ) as typeof import("../src/composition/cad-service")
  ).policyArguments;
  return array(Reflect.apply(policy, undefined, [payload])).map(string);
}

function installedEpoch(state: ReturnType<typeof openIsolatedEpoch>) {
  return present(state.epoch);
}
