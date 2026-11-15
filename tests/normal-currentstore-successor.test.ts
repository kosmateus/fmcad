import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import Module from "node:module";
const load = createRequire(__filename);
const normal = load(
  "../src/dist/composition/queue-normal-cold-successor",
) as typeof import("../src/composition/queue-normal-cold-successor");
const p = {
  ...normal.normalColdProfile,
  epochId: randomUUID(),
  epochClientId: `epoch-owner:${randomUUID()}`,
  jobId: randomUUID(),
  jobClientId: `job-owner:${randomUUID()}`,
  jobRequestId: `original-write:${randomUUID()}`,
  rpcId: randomUUID(),
  creationId: randomUUID(),
  documentName: `FMCAD_MULTI_${randomUUID()}`,
  jobHash: "a".repeat(64),
  requestHash: "b".repeat(64),
  sourceHash: "c".repeat(64),
  configHash: "d".repeat(64),
  sdk: { pid: 123456, birth: "134391913505880644", version: "2706.1.17" },
  metadata: { pid: 123457, birth: "synthetic-linux-boot:7239886" },
};
const currentIdentity = {
  kind: normal.normalColdProfile.kind,
  resolvedIdentity: { creationId: p.creationId, name: p.documentName },
};
const hash = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
const write = (file: string, v: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(v));
};
const ref = (file: string) => ({
  path: file,
  sha256: hash(fs.readFileSync(file)),
});
const absentError =
  "NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand";

function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync("/tmp/opencode/normal-currentstore-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const epoch = path.join(dir, "admission-epochs", p.epochId);
  const jobDir = path.join(dir, "jobs", p.jobId);
  const jobClient = {
    dir,
    auth: {
      clientId: p.jobClientId,
      clientToken: "synthetic sealed job-owner token",
    },
  };
  const epochClient = {
    dir,
    auth: {
      clientId: p.epochClientId,
      clientToken: "synthetic different epoch-owner token",
    },
  };
  const pointer = {
    epochId: p.epochId,
    root: epoch,
    ownerClientId: p.epochClientId,
    ownerTokenHash: hash(epochClient.auth.clientToken),
    currentInstance: p.sdk,
    document: { creationId: randomUUID(), fileId: null },
  };
  const owner = { ...p.metadata, nonce: "normal-synthetic-owner", protocol: 2 };
  write(path.join(dir, "clients.json"), {
    [p.jobClientId]: hash(jobClient.auth.clientToken),
    [p.epochClientId]: hash(epochClient.auth.clientToken),
  });
  write(path.join(dir, "isolated-admission-epoch.json"), pointer);
  write(path.join(dir, "broker.lock"), owner);
  write(path.join(dir, `broker-lifecycle-${owner.nonce}.json`), {
    owner,
    buildHash: p.buildHash,
    configHash: p.configHash,
    stage: "recovery",
  });
  const identity = {
    sourceCommit: p.sourceCommit,
    buildHash: p.buildHash,
    configHash: p.configHash,
    instance: p.sdk,
  };
  write(path.join(dir, "instance.json"), identity);
  write(path.join(epoch, "instance.json"), identity);
  write(path.join(epoch, "closed.json"), {
    epochId: p.epochId,
    document: pointer.document,
    admissionMode: "normal-multidocument",
    historicalOutcome: "unknown",
  });
  const { QueueState } = load(
    "../src/queue-state",
  ) as typeof import("../src/queue-state");
  const history = new QueueState(dir);
  const historical = history.submit({
    kind: "rpc",
    clientId: p.epochClientId,
    requestId: `historical:${randomUUID()}`,
    timeoutMs: 30000,
    payload: { method: "ping" },
  });
  history.next();
  history.markDispatch(String(historical["id"]));
  history.finish(String(historical["id"]), {
    state: "needs_reconciliation",
    code: "SYNTHETIC_OLD_UNKNOWN",
  });
  const job = {
    id: p.jobId,
    clientId: p.jobClientId,
    requestId: p.jobRequestId,
    hash: p.jobHash,
    state: "needs_reconciliation",
    request: {
      kind: "command",
      phased: true,
      backend: "mcp",
      buildHash: p.buildHash,
      ownerToken: hash(jobClient.auth.clientToken),
      argv: [
        "run",
        "/synthetic/private-writer.py",
        "--doc-id",
        p.creationId,
        "--doc",
        p.documentName,
        "--helpers",
        "cad-v1",
      ],
    },
  };
  const current = new QueueState(epoch);
  current.submit(
    {
      ...job.request,
      requestId: p.jobRequestId,
      clientId: p.jobClientId,
      timeoutMs: 30000,
      cwd: dir,
    },
    p.jobId,
  );
  current.readyTurn(p.jobId);
  current.next();
  current.markDispatch(p.jobId, { rpcCount: 3, completedCount: 2 });
  current.finish(p.jobId, {
    state: "needs_reconciliation",
    code: "SYNTHETIC_ORIGINAL_UNKNOWN",
  });
  job.hash = current.data.jobs[p.jobId]!.hash;
  write(path.join(jobDir, "worker-identity.json"), {
    pid: 429882,
    birth: "synthetic-linux-boot:7973485",
  });
  write(path.join(jobDir, "worker-result.json"), {
    code: 1,
    terminal: true,
    workflowOutcome: null,
  });
  write(path.join(jobDir, "request.json"), {
    credential: "NEVER READ OR HASH THIS SEALED FIXTURE",
  });
  const rpcFile = path.join(jobDir, `rpc-${p.rpcId}.json`);
  write(rpcFile, {
    terminal: false,
    instance: p.sdk,
    binding: {
      jobId: p.jobId,
      rpcId: p.rpcId,
      requestHash: p.requestHash,
      sourceHash: p.sourceHash,
      buildHash: p.buildHash,
    },
  });
  const requestId = `normal-cold:${randomUUID()}`;
  const target = Object.fromEntries(
    Object.entries(p).filter(
      ([key]) => !["sourceCommit", "buildHash"].includes(key),
    ),
  );
  const targetFile = path.join(dir, "normal-target.json");
  write(targetFile, {
    ...target,
    jobHash: job.hash,
    kind: "normal-currentstore-target-v1",
  });
  const targetReference = ref(targetFile);
  const ports: import("../src/composition/queue-normal-cold-successor").NormalColdPorts =
    {
      sdkProcess: (process) =>
        process.pid === p.sdk.pid
          ? {
              state: "absent",
              pid: process.pid,
              errorId: absentError,
              observedAtUtc: new Date().toISOString(),
            }
          : {
              state: "present",
              pid: process.pid,
              birth: process.birth,
              observedAtUtc: new Date().toISOString(),
            },
      producerAbsent: () => true,
    };
  const authorization = normal.authorizeNormalCurrentStore(
    jobClient,
    requestId,
    targetReference,
  );
  const retirement = normal.recordNormalProducerRetirement(
    epochClient,
    requestId,
    authorization,
    ports,
  );
  // Birth of this purely synthetic selected SDK follows the producer receipt.
  const expectedProcess = {
    pid: 900001,
    birth: String(BigInt(Date.now() + 10) * 10000n + 116444736000000000n),
  };
  const deathFile = path.join(dir, "sdk-death-proof.json");
  const now = new Date(Date.now() - 1000).toISOString();
  write(deathFile, {
    version: 1,
    kind: "sdk-process-death-proof-v1",
    expectedProcess: p.sdk,
    before: {
      state: "present",
      ...p.sdk,
      exe: "C:\\Fusion\\Fusion360.exe",
      windowHandle: "123",
      observedAtUtc: now,
    },
    handleBoundExit: {
      pid: p.sdk.pid,
      birth: p.sdk.birth,
      hasExited: true,
      observedAtUtc: now,
    },
    after: {
      state: "absent",
      pid: p.sdk.pid,
      observedAtUtc: now,
      errorId: absentError,
    },
    bindings: {
      jobAuthorization: authorization,
      producerRetirement: retirement,
      originalRpc: ref(rpcFile),
    },
  });
  const approval = {
    requestId,
    clientId: p.epochClientId,
    previousBuildHash: p.buildHash,
    expectedProcess,
    normalCurrentStore: {
      kind: p.kind,
      jobAuthorization: authorization,
      deathProof: ref(deathFile),
      producerRetirement: retirement,
    },
  } as import("../src/composition/queue-epoch-successor-types").Approval;
  return {
    dir,
    epoch,
    jobDir,
    jobClient,
    epochClient,
    pointer:
      pointer as import("../src/composition/queue-epoch-successor-types").Pointer,
    owner,
    requestId,
    ports,
    authorization,
    retirement,
    approval,
    targetReference,
  };
}

test("public normal metadata CLI requires sealed existing clients, exact input refs and no SDK/broker calls", async (t) => {
  const f = fixture(t),
    calls: string[] = [];
  const clientFile = load.resolve("../src/queue-client"),
    previousClient = load.cache[clientFile];
  const replacement = new Module(clientFile);
  replacement.filename = clientFile;
  replacement.loaded = true;
  class SealedClient {
    constructor(_id: unknown, options: { existingCredentialsOnly: boolean }) {
      assert.equal(options.existingCredentialsOnly, true);
    }
    call() {
      assert.fail(
        "No SDK/broker action is needed for sealed local authorization",
      );
    }
    register() {
      assert.fail(
        "Never create another credential or register a replacement owner",
      );
    }
    dispose() {
      calls.push("dispose");
    }
  }
  replacement.exports = {
    ...previousClient?.exports,
    QueueClient: SealedClient,
  };
  load.cache[clientFile] = replacement;
  const entry = load.resolve("../src/dist/entrypoints/queue-cli"),
    previousEntry = load.cache[entry];
  delete load.cache[entry];
  const authorize = normal.authorizeNormalCurrentStore,
    retire = normal.recordNormalProducerRetirement;
  normal.authorizeNormalCurrentStore = (client, requestId, target) => {
    assert.ok(client instanceof SealedClient);
    assert.equal(requestId, f.requestId);
    assert.deepEqual(target, f.targetReference);
    calls.push("authorize");
    return f.authorization;
  };
  normal.recordNormalProducerRetirement = (client, requestId, auth) => {
    assert.ok(client instanceof SealedClient);
    assert.equal(requestId, f.requestId);
    assert.deepEqual(auth, f.authorization);
    calls.push("retire");
    return f.retirement;
  };
  t.after(() => {
    normal.authorizeNormalCurrentStore = authorize;
    normal.recordNormalProducerRetirement = retire;
    if (previousClient) load.cache[clientFile] = previousClient;
    else delete load.cache[clientFile];
    if (previousEntry) load.cache[entry] = previousEntry;
    else delete load.cache[entry];
  });
  const { queueCommand } = load(
    entry,
  ) as typeof import("../src/entrypoints/queue-cli");
  const { resolveFmcadConfiguration } = load(
    "../src/dist/core",
  ) as typeof import("../packages/core/src");
  const deps = {
    loadConfig: () => ({
      cfg: resolveFmcadConfiguration({
        adapter: {
          backend: "mcp",
          routing: "queue",
          url: "http://synthetic.invalid",
        },
        environment: {},
        file: {},
        platformDefaults: {},
        acceptedService: undefined,
      }),
    }),
    stdout: { write() {} },
    stderr: { write() {} },
  };
  await queueCommand(
    [
      "authorize-normal-successor",
      "--request-id",
      f.requestId,
      "--normal-target",
      f.targetReference.path,
      "--confirm-ownership",
      "true",
    ],
    deps,
  );
  await queueCommand(
    [
      "record-normal-producers-retired",
      "--request-id",
      f.requestId,
      "--job-authorization",
      f.authorization.path,
      "--confirm-ownership",
      "true",
    ],
    deps,
  );
  await assert.rejects(
    queueCommand(
      [
        "authorize-normal-successor",
        "--request-id",
        f.requestId,
        "--normal-target",
        f.targetReference.path,
        "--confirm-ownership",
        "true",
        "--job",
        "retarget",
      ],
      deps,
    ),
  );
  assert.deepEqual(calls, ["authorize", "dispose", "retire", "dispose"]);
});

test("normal-currentstore: distinct authentic owners and immutable unknown survive SDK0 qualification", (t) => {
  const f = fixture(t);
  const original = fs.readFileSync(path.join(f.epoch, "queue-state.json"));
  normal.inspectNormalCurrentStore(f.dir, f.approval, f.pointer, f.ports);
  assert.deepEqual(
    fs.readFileSync(path.join(f.epoch, "queue-state.json")),
    original,
  );
  const receipt = JSON.parse(fs.readFileSync(f.authorization.path, "utf8"));
  assert.equal(
    receipt.snapshot.jobOwnerTokenHash,
    hash(f.jobClient.auth.clientToken),
  );
  assert.notEqual(
    receipt.snapshot.jobOwnerTokenHash,
    receipt.snapshot.epochOwnerTokenHash,
  );
  assert.equal(
    receipt.snapshot.files.some(
      (r: { path: string }) =>
        r.path.endsWith("request.json") || r.path.endsWith("clients.json"),
    ),
    false,
  );
  assert.ok(!JSON.stringify(receipt).includes(f.jobClient.auth.clientToken));
  assert.equal(receipt.snapshot.sealedRequests.length, 1);
});

test("owner authorizer and recovery qualification never read or hash credential-bearing request files", (t) => {
  const f = fixture(t),
    read = fs.readFileSync;
  const history = read(path.join(f.dir, "queue-state.json"));
  const sealed = path.join(f.jobDir, "request.json");
  fs.readFileSync = ((
    file: Parameters<typeof fs.readFileSync>[0],
    ...args: unknown[]
  ) => {
    assert.notEqual(
      String(file),
      sealed,
      "Credential request bytes must never be read, hashed or backed up",
    );
    return Reflect.apply(read, fs, [file, ...args]);
  }) as typeof fs.readFileSync;
  try {
    normal.authorizeNormalCurrentStore(
      f.jobClient,
      f.requestId + ":new-sealed",
      f.targetReference,
    );
    normal.inspectNormalCurrentStore(f.dir, f.approval, f.pointer, f.ports);
    assert.deepEqual(
      fs.readFileSync(path.join(f.dir, "queue-state.json")),
      history,
    );
  } finally {
    fs.readFileSync = read;
  }
});

for (const mode of [
  "job-owner",
  "epoch-owner",
  "live-sdk",
  "reused-sdk-pid",
  "producer",
  "source",
  "tamper",
  "retarget",
  "missing-death",
  "old-new-birth",
  "symlink",
  "sealed-request-change",
]) {
  test(`normal-currentstore refuses ${mode} without SDK requests or ledger mutation`, (t) => {
    const f = fixture(t);
    const stateFile = path.join(f.epoch, "queue-state.json");
    const original = fs.readFileSync(stateFile);
    let action = () =>
      normal.inspectNormalCurrentStore(f.dir, f.approval, f.pointer, f.ports);
    if (mode === "job-owner")
      action = () =>
        normal.authorizeNormalCurrentStore(
          f.epochClient,
          `${f.requestId}:wrong-owner`,
          f.targetReference,
        ) as never;
    if (mode === "epoch-owner")
      action = () =>
        normal.recordNormalProducerRetirement(
          f.jobClient,
          f.requestId,
          f.authorization,
          f.ports,
        ) as never;
    if (mode === "live-sdk" || mode === "reused-sdk-pid")
      f.ports.sdkProcess = (process) => ({
        state: "present",
        pid: process.pid,
        birth: mode === "reused-sdk-pid" ? "different-birth" : process.birth,
        observedAtUtc: new Date().toISOString(),
      });
    if (mode === "producer") f.ports.producerAbsent = () => false;
    if (mode === "source") {
      const file = path.join(f.epoch, "instance.json");
      const v = JSON.parse(fs.readFileSync(file, "utf8"));
      v.sourceCommit = "f".repeat(40);
      write(file, v);
    }
    if (mode === "tamper")
      fs.appendFileSync(path.join(f.jobDir, "worker-result.json"), " ");
    if (mode === "retarget")
      f.approval.normalCurrentStore!.jobAuthorization = f.retirement;
    if (mode === "missing-death")
      fs.unlinkSync(f.approval.normalCurrentStore!.deathProof.path);
    if (mode === "old-new-birth") f.approval.expectedProcess = { ...p.sdk };
    if (mode === "symlink") {
      const file = path.join(f.jobDir, "worker-result.json"),
        moved = path.join(f.dir, "escaped.json");
      fs.renameSync(file, moved);
      fs.symlinkSync(moved, file);
    }
    if (mode === "sealed-request-change")
      fs.appendFileSync(path.join(f.jobDir, "request.json"), " ");
    assert.throws(action);
    assert.deepEqual(fs.readFileSync(stateFile), original);
  });
}

test("normal current-facts parser uses native success/message and never adopts recovered original document", () => {
  const facts = {
    kind: "normal-currentstore-current-facts-v1",
    originalDocumentCreationId: p.creationId,
    originalDocumentName: p.documentName,
    originalDocumentPresent: false,
    activeCommand: "SelectCommand",
    documents: [],
    historicalOutcome: "unknown",
    modelValidation: "not_performed",
  };
  const reply = (value: unknown) => ({
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            message: "FMCAD_RESULT " + JSON.stringify(value),
          }),
        },
      ],
    },
  });
  assert.deepEqual(
    normal.parseNormalCurrentFacts(reply(facts), currentIdentity),
    facts,
  );
  assert.throws(() =>
    normal.parseNormalCurrentFacts(
      reply({
        ...facts,
        documents: [{ creationId: "new-id", name: p.documentName }],
      }),
      currentIdentity,
    ),
  );
  assert.throws(() =>
    normal.parseNormalCurrentFacts(
      reply({ ...facts, originalDocumentPresent: true }),
      currentIdentity,
    ),
  );
});

test("normal current-facts final receipt artifact passes the real pinned checker without SDK or platform impersonation", async () => {
  const { createPythonChecker, createPythonRpcAdmission } = load(
    "../src/python",
  ) as typeof import("../packages/node-adapters/src/python/checker") &
    typeof import("../packages/node-adapters/src/python/admission");
  const { prepareRecoveryAuditWire } = load(
    "../src/queue-atomic-recovery-audit",
  ) as typeof import("../src/queue-atomic-recovery-audit");
  const root = path.resolve(".");
  const identity = currentIdentity;
  const binding = {
    purpose: "normal-currentstore-current-facts-v1",
    expectedProcess: { pid: 900001, birth: "134391999999999999" },
  };
  const reader = normal.prepareNormalCurrentFacts(root, identity, binding);
  const payload = {
    jsonrpc: "2.0",
    id: "synthetic-normal",
    method: "tools/call",
    params: {
      name: "fusion_mcp_execute",
      arguments: {
        featureType: "script",
        object: { script: reader.artifact.script, readOnly: true },
      },
    },
  };
  const wire = prepareRecoveryAuditWire({
    payload,
    reader,
    receipt: "/tmp/opencode/normal-synthetic-never-written.receipt.json",
    instance: binding.expectedProcess,
    buildHash: "a".repeat(64),
    jobId: p.jobId,
    auditBinding: binding,
  });
  const runtime = path.join(root, "dist/runtime/python");
  const admission = createPythonRpcAdmission({
    runtime,
    checker: createPythonChecker({
      typingRoot: path.join(runtime, "typing"),
      definitionsRoot: path.join(runtime, "typing"),
      pythonPlatform: "Windows",
    }),
  });
  const certificate = await admission.check(wire.outgoing, wire.artifact);
  assert.equal(certificate.kind, "python");
  certificate.fence(wire.outgoing);
  assert.ok(!wire.artifact.script.includes("fmcad_atomic_"));
  assert.deepEqual(
    wire.record.binding["auditExpectedProcess"],
    binding.expectedProcess,
  );
  assert.equal(
    wire.outgoing.params?.arguments?.["object"] &&
      (wire.outgoing.params.arguments["object"] as { readOnly: boolean })
        .readOnly,
    true,
  );
});

for (const observationMode of ["complete", "missing-remote"]) {
  test(`normal successor uses existing once-only engine and real checker: ${observationMode}; no write or ledger settlement`, async (t) => {
    const f = fixture(t);
    const successor = load(
      "../src/queue-epoch-successor",
    ) as typeof import("../src/composition/queue-epoch-successor");
    const lineage = load(
      "../src/queue-epoch-lineage",
    ) as typeof import("../src/queue-epoch-lineage");
    const savedPredecessor = successor.assertCurrentPredecessor,
      savedLineage = lineage.epochLineage;
    // The common historical lineage engine has its own integration tests. This
    // test injects OS/predecessor discovery only; all normal owner/snapshot/death
    // checks and the actual once-only controller/admission/publication run here.
    const pointer = {
      ...f.pointer,
      originalInstance: { pid: 123450, birth: "terminated:historical" },
      quarantinedJobIds: [randomUUID(), randomUUID()],
    };
    const audit = path.join(f.dir, "epoch-successions", hash(f.requestId));
    const authorityFile = path.join(audit, "authority.json");
    const authority = {
      requestId: f.requestId,
      clientId: p.epochClientId,
      ownerTokenHash: hash(f.epochClient.auth.clientToken),
      expectedProcess: f.approval.expectedProcess,
      previousOwner: f.owner,
      normalCurrentStore: f.approval.normalCurrentStore,
      predecessor: {},
      sourceCommit: "f".repeat(40),
      kind: "owner-authenticated-dead-epoch-successor",
    };
    write(authorityFile, authority);
    successor.assertCurrentPredecessor = () => {
      normal.inspectNormalCurrentStore(f.dir, f.approval, f.pointer, f.ports);
      return {
        authority,
        audit,
        pointer,
        state: {},
        identity: {},
      } as unknown as ReturnType<typeof successor.assertCurrentPredecessor>;
    };
    lineage.epochLineage = () => [];
    const controlModule = load.resolve(
      "../src/dist/composition/queue-epoch-successor-control",
    );
    delete load.cache[controlModule];
    t.after(() => {
      successor.assertCurrentPredecessor = savedPredecessor;
      lineage.epochLineage = savedLineage;
      delete load.cache[controlModule];
    });
    const { createSuccessorControl } = load(
      controlModule,
    ) as typeof import("../src/composition/queue-epoch-successor-control");
    const { createPythonChecker, createPythonRpcAdmission } = load(
      "../src/python",
    ) as typeof import("../packages/node-adapters/src/python/checker") &
      typeof import("../packages/node-adapters/src/python/admission");
    const runtime = path.resolve("dist/runtime/python");
    const admission = createPythonRpcAdmission({
      runtime,
      checker: createPythonChecker({
        typingRoot: path.join(runtime, "typing"),
        definitionsRoot: path.join(runtime, "typing"),
        pythonPlatform: "Windows",
      }),
    });
    const original = fs.readFileSync(path.join(f.epoch, "queue-state.json"));
    let calls = 0;
    const facts = {
      kind: "normal-currentstore-current-facts-v1",
      originalDocumentCreationId: p.creationId,
      originalDocumentName: p.documentName,
      originalDocumentPresent: false,
      activeCommand: "SelectCommand",
      documents: [],
      historicalOutcome: "unknown",
      modelValidation: "not_performed",
    };
    const send: import("../packages/node-adapters/src/execution/recovery-audit").RecoveryAuditPorts["sendScript"] =
      (scope, script) =>
        scope.post({
          jsonrpc: "2.0",
          id: "normal-observe",
          method: "tools/call",
          params: {
            name: "fusion_mcp_execute",
            arguments: {
              featureType: "script",
              object: { script, readOnly: true },
            },
          },
        });
    const control = createSuccessorControl({
      dir: f.dir,
      state: { epoch: pointer, data: {}, historical: {} },
      configHash: p.configHash,
      buildHash: "f".repeat(64),
      clients: () => ({
        [p.epochClientId]: hash(f.epochClient.auth.clientToken),
        [p.jobClientId]: hash(f.jobClient.auth.clientToken),
      }),
      authority: ref(authorityFile),
      assertControl() {},
      fenceRuntime() {},
      sendAuditScript: send,
      sendScratchScript: send,
      activate() {
        assert.fail(
          "No scratch or original fixture may be created by observation",
        );
      },
      ports: {
        scriptFormat: "fusion-mcp",
        installation: path.resolve("."),
        buildHash: "f".repeat(64),
        begin() {},
        end() {},
        admit: async <T>(sendOperation: () => Promise<T>) => sendOperation(),
        check: (
          payload: import("../packages/node-adapters/src/execution/recovery-audit").AuditRpc,
          artifact: import("@fmcad/core").PreparedPythonArtifact,
        ) => admission.check(payload, artifact),
        match: (response: Record<string, unknown>) =>
          JSON.parse(String(response["raw"])) as Record<string, unknown>,
        async post(
          payload: import("../packages/node-adapters/src/execution/recovery-audit").AuditRpc,
        ) {
          calls++;
          assert.equal(payload.params?.name, "fusion_mcp_execute");
          assert.equal(
            (payload.params?.arguments?.["object"] as { readOnly: boolean })
              .readOnly,
            true,
          );
          const start = JSON.parse(
            fs.readFileSync(
              path.join(audit, "dead-epoch-current-observation", "start.json"),
              "utf8",
            ),
          );
          if (observationMode === "complete")
            write(start.receipt, {
              ...start.binding,
              terminal: true,
              outcome: "succeeded",
              instance: {
                ...f.approval.expectedProcess,
                version: "synthetic-new-sdk",
                activeCommand: "SelectCommand",
              },
            });
          return {
            status: 200,
            raw: JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      success: true,
                      message: "FMCAD_RESULT " + JSON.stringify(facts),
                    }),
                  },
                ],
              },
            }),
          };
        },
      },
    } as unknown as Parameters<typeof createSuccessorControl>[0]);
    const message = {
      jobId: p.jobId,
      observationJobId: p.rpcId,
      requestId: f.requestId + ":observe",
      control: {},
    };
    let firstObservation = await control.observe(message, p.epochClientId);
    const deadline = Date.now() + 15000;
    while (
      (firstObservation as Record<string, unknown>)["status"] === "pending" &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      firstObservation = await control.observe(message, p.epochClientId);
    }
    await control.observe(message, p.epochClientId);
    assert.equal(
      calls,
      1,
      "Publication-only recovery returns the original observation, never replays it: " +
        JSON.stringify(firstObservation),
    );
    await assert.rejects(
      control.observe(
        { ...message, requestId: f.requestId + ":retarget" },
        p.epochClientId,
      ),
    );
    await assert.rejects(control.observe(message, p.jobClientId), {
      code: "NOT_OWNER",
    });
    assert.deepEqual(
      fs.readFileSync(path.join(f.epoch, "queue-state.json")),
      original,
    );
    assert.equal(control.metadata().historicalOutcome, "unknown");
    assert.equal(
      control.metadata().currentFactsAvailable,
      observationMode === "complete",
    );
    assert.ok(
      fs.existsSync(
        path.join(
          audit,
          "dead-epoch-current-observation",
          "received-response.json",
        ),
      ),
    );
  });
}
