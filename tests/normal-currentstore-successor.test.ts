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

function syntheticReceiptPaths(
  t: { after(fn: () => void): void },
  root: string,
) {
  const queue = load("../src/queue-instance") as ReturnType<
    typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
  >;
  const { createQueueInstance } = load(
    "../src/dist/node-adapters/execution/queue-instance",
  ) as typeof import("../packages/node-adapters/src/execution/queue-instance");
  const platform = load(
    "../src/dist/config-platform",
  ) as typeof import("../packages/node-adapters/src/config-platform");
  const plainLinux = createQueueInstance(
    load.resolve("../src/queue-instance"),
    {
      ...platform,
      detectPlatform: () => ({
        platform: "linux",
        architecture: "x64",
        nodeVersion: process.versions.node,
        osRelease: "6.8.0-generic",
        distribution: "ubuntu",
        distributionVersion: "24.04",
      }),
    },
  );
  // Keep the production refusal RED-capable on every host. Only this synthetic
  // physical endpoint uses local receipt files; it is not a Windows/WSL claim.
  assert.throws(
    () =>
      plainLinux.prepareReceiptScript(
        "def run(context: str) -> None:\n    pass\n",
        true,
        path.join(root, "never-sent.json"),
        {},
      ),
    { code: "FMCAD_UNSUPPORTED_PLATFORM" },
  );
  const original = queue.prepareReceiptScript;
  let mapped = 0;
  queue.prepareReceiptScript = (code, official, receipt, binding) =>
    plainLinux.prepareReceiptScript(code, official, receipt, binding, {
      mapPath(file) {
        assert.ok(
          file.startsWith(root + path.sep),
          "Synthetic receipts must remain in their owned namespace",
        );
        mapped++;
        return file;
      },
    });
  t.after(() => {
    queue.prepareReceiptScript = original;
    assert.ok(mapped > 0);
  });
}

const legacyProfile = p;
const laterRuntime = {
  sourceCommit: "129de8c03ddbf5513ddbbe2c320b24cee3e3d4bc",
  buildHash: "b78202e98bfc623649f4cfce2a97856232e88fc49a72c457811b46e83e058671",
};
function fixture(
  t: { after(fn: () => void): void },
  runtime?: { sourceCommit: string; buildHash: string },
  raw = false,
  documentName?: string,
) {
  const payload = {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "execute_python",
      arguments: { code: 'print("FUSION_ADDIN_STDIO_OK")', persistent: false },
    },
  };
  const p = {
    ...legacyProfile,
    ...runtime,
    ...(documentName ? { documentName } : {}),
    ...(raw
      ? {
          requestKind: "raw-rpc",
          sourceHash: hash(payload.params.arguments.code),
          requestHash: hash(JSON.stringify(payload)),
        }
      : {}),
  };
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
  const closeDirectory = path.join(
    dir,
    "epoch-successions",
    hash("synthetic-prior-close"),
    "isolated-scratch-close",
  );
  const closeFiles = [
    "result.json",
    "intent.json",
    "start.json",
    "wire.json",
    "sdk-closed.json",
    `remote-${randomUUID()}.json`,
  ].map((name) => {
    const file = path.join(closeDirectory, name);
    write(file, {
      fixture: "synthetic existing close evidence; not physical Fusion proof",
    });
    return ref(file);
  });
  write(path.join(epoch, "closed.json"), {
    epochId: p.epochId,
    document: pointer.document,
    admissionMode: "normal-multidocument",
    historicalOutcome: "unknown",
    receipt: closeFiles[0],
    qualificationEvidence: closeFiles.slice(1),
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
    request: raw
      ? {
          kind: "rpc",
          backend: "mcp",
          ownerToken: hash(jobClient.auth.clientToken),
          payload,
        }
      : {
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
  if (!raw) current.readyTurn(p.jobId);
  current.next();
  current.markDispatch(p.jobId, { rpcCount: 3, completedCount: 2 });
  current.finish(p.jobId, {
    state: "needs_reconciliation",
    code: "SYNTHETIC_ORIGINAL_UNKNOWN",
  });
  if (raw) {
    const file = path.join(epoch, "queue-state.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    const cancelled = randomUUID();
    stored.jobs[cancelled] = {
      id: cancelled,
      state: "cancelled",
      startedAt: null,
    };
    const completed = randomUUID();
    stored.jobs[completed] = { id: completed, state: "succeeded" };
    write(path.join(dir, "jobs", completed, "stages", "00000000.json"), {
      sequence: 0,
      status: "completed",
    });
    write(file, stored);
  }
  job.hash = current.data.jobs[p.jobId]!.hash;
  if (!raw)
    write(path.join(jobDir, "worker-identity.json"), {
      pid: 429882,
      birth: "synthetic-linux-boot:7973485",
    });
  if (!raw)
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
    ...(raw
      ? {
          method: "tools/call",
          request: { jsonrpc: "2.0", id: payload.id, method: payload.method },
          wireRequest: {
            jsonrpc: "2.0",
            id: "fmcad:" + p.rpcId,
            method: payload.method,
          },
        }
      : {}),
    instance: {
      ...p.sdk,
      ...(raw
        ? {
            documents: [
              {
                id: p.creationId,
                name: p.documentName,
                fileId: null,
                isSaved: false,
                isModified: false,
              },
            ],
          }
        : {}),
    },
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
      ([key]) => runtime || !["sourceCommit", "buildHash"].includes(key),
    ),
  );
  const targetFile = path.join(dir, "normal-target.json");
  const sourceFile = path.join(dir, "predecessor-physical-ready.json");
  if (raw) {
    write(sourceFile, {
      physicalREADY: true,
      sourceCommit: p.sourceCommit,
      buildHash: p.buildHash,
      sdk: p.sdk,
    });
    const reopenedIdentity = {
      buildHash: p.buildHash,
      configHash: p.configHash,
      instance: p.sdk,
    };
    write(path.join(epoch, "instance.json"), reopenedIdentity);
  }
  write(targetFile, {
    ...target,
    ...(raw ? { predecessorSource: ref(sourceFile) } : {}),
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
      originalRpc: ref(rpcFile),
      predecessorState: ref(path.join(epoch, "queue-state.json")),
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

test("normal raw RPC successor binds the original owner, payload and broker without inventing a worker", (t) => {
  const f = fixture(t, laterRuntime, true);
  const authorization = JSON.parse(
    fs.readFileSync(f.authorization.path, "utf8"),
  );
  assert.equal(authorization.profile.requestKind, "raw-rpc");
  const stage = authorization.snapshot.files.find((entry: { path: string }) =>
    entry.path.includes("/stages/"),
  );
  assert.ok(stage);
  const stageBefore = fs.readFileSync(stage.path);
  write(stage.path, { sequence: 0, status: "tampered" });
  assert.throws(() =>
    normal.recordNormalProducerRetirement(
      f.epochClient,
      f.requestId,
      f.authorization,
      f.ports,
    ),
  );
  fs.writeFileSync(stage.path, stageBefore);
  assert.equal(authorization.snapshot.producers.length, 1);
  assert.equal(
    fs.existsSync(path.join(f.jobDir, "worker-identity.json")),
    false,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.epoch, "queue-state.json"), "utf8"))
      .jobs[p.jobId].state,
    "needs_reconciliation",
  );
  assert.throws(() =>
    normal.authorizeNormalCurrentStore(
      f.epochClient,
      `foreign:${randomUUID()}`,
      f.targetReference,
    ),
  );
  const denyMutation = (
    file: string,
    mutate: (value: {
      binding: { requestHash: string };
      wireRequest: { id: string };
      buildHash: string;
      sourceCommit: string;
      jobs: Record<
        string,
        {
          state?: string;
          id?: string;
          request?: { payload: { params: { arguments: { code: string } } } };
        }
      >;
    }) => void,
  ) => {
    const before = fs.readFileSync(file);
    const value = JSON.parse(before.toString());
    mutate(value);
    write(file, value);
    assert.throws(() =>
      normal.authorizeNormalCurrentStore(
        f.jobClient,
        `negative:${randomUUID()}`,
        ref(f.targetReference.path),
      ),
    );
    fs.writeFileSync(file, before);
  };
  const rpcFile = path.join(f.jobDir, `rpc-${p.rpcId}.json`);
  denyMutation(rpcFile, (value) => {
    value.binding.requestHash = "e".repeat(64);
  });
  denyMutation(rpcFile, (value) => {
    value.wireRequest.id = "foreign-rpc";
  });
  denyMutation(f.targetReference.path, (value) => {
    value.buildHash = "f".repeat(64);
  });
  denyMutation(f.targetReference.path, (value) => {
    value.sourceCommit = "f".repeat(40);
  });
  denyMutation(path.join(f.epoch, "queue-state.json"), (value) => {
    value.jobs[p.jobId]!.request!.payload.params.arguments.code =
      "print('tampered')";
  });
  denyMutation(path.join(f.epoch, "queue-state.json"), (value) => {
    value.jobs[randomUUID()] = { state: "running", id: randomUUID() };
  });
  const worker = path.join(f.jobDir, "worker-identity.json");
  write(worker, { pid: 987654, birth: "foreign:1" });
  assert.throws(() =>
    normal.authorizeNormalCurrentStore(
      f.jobClient,
      `fake-worker:${randomUUID()}`,
      f.targetReference,
    ),
  );
  fs.unlinkSync(worker);
  const target = JSON.parse(fs.readFileSync(f.targetReference.path, "utf8"));
  delete target.requestKind;
  delete target.predecessorSource;
  write(f.targetReference.path, target);
  assert.throws(
    () =>
      normal.authorizeNormalCurrentStore(
        f.jobClient,
        `mixed:${randomUUID()}`,
        ref(f.targetReference.path),
      ),
    /profile|producer|worker/i,
  );
});

test("a phased command cannot opt into the broker-only raw RPC profile", (t) => {
  const f = fixture(t, laterRuntime);
  const target = JSON.parse(fs.readFileSync(f.targetReference.path, "utf8"));
  target.requestKind = "raw-rpc";
  write(f.targetReference.path, target);
  assert.throws(() =>
    normal.authorizeNormalCurrentStore(
      f.jobClient,
      `mixed:${randomUUID()}`,
      ref(f.targetReference.path),
    ),
  );
});

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
    retire = normal.recordNormalProducerRetirement,
    retireMetadata = normal.retireNormalMetadataProducer;
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
  normal.retireNormalMetadataProducer = (
    client,
    requestId,
    auth,
    death,
    runtime,
    apply,
  ) => {
    assert.ok(client instanceof SealedClient);
    assert.equal(requestId, f.requestId);
    assert.deepEqual(auth, f.authorization);
    assert.deepEqual(death, f.approval.normalCurrentStore!.deathProof);
    assert.equal(runtime, f.dir);
    calls.push(apply ? "metadata-apply" : "metadata-preview");
    return f.retirement;
  };
  t.after(() => {
    normal.authorizeNormalCurrentStore = authorize;
    normal.recordNormalProducerRetirement = retire;
    normal.retireNormalMetadataProducer = retireMetadata;
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
  const metadata = [
    "retire-normal-metadata-producer",
    "--request-id",
    f.requestId,
    "--job-authorization",
    f.authorization.path,
    "--sdk-death-proof",
    f.approval.normalCurrentStore!.deathProof.path,
    "--producer-runtime",
    f.dir,
    "--confirm-ownership",
    "true",
  ];
  await queueCommand(metadata, deps);
  await queueCommand([...metadata, "--apply", "true"], deps);
  await assert.rejects(queueCommand([...metadata, "--apply", "false"], deps));
  assert.deepEqual(calls, [
    "authorize",
    "dispose",
    "retire",
    "dispose",
    "metadata-preview",
    "dispose",
    "metadata-apply",
    "dispose",
  ]);
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

test("normal successor binds a later predecessor runtime without changing historical authority", (t) => {
  const runtime = laterRuntime;
  const f = fixture(t, runtime);
  const receipt = JSON.parse(fs.readFileSync(f.authorization.path, "utf8"));
  assert.equal(receipt.profile.sourceCommit, runtime.sourceCommit);
  assert.equal(receipt.profile.buildHash, runtime.buildHash);
  normal.inspectNormalCurrentStore(f.dir, f.approval, f.pointer, f.ports);
  for (const key of ["sourceCommit", "buildHash"]) {
    const target = JSON.parse(fs.readFileSync(f.targetReference.path, "utf8"));
    const incomplete = { ...target };
    delete incomplete[key];
    const incompleteFile = path.join(f.dir, `missing-${key}.json`);
    write(incompleteFile, incomplete);
    assert.throws(
      () =>
        normal.authorizeNormalCurrentStore(
          f.jobClient,
          `missing-${key}:${randomUUID()}`,
          ref(incompleteFile),
        ),
      /required together/,
    );
    target[key] = key === "sourceCommit" ? "0".repeat(40) : "0".repeat(64);
    const file = path.join(f.dir, `wrong-${key}.json`);
    write(file, target);
    assert.throws(
      () =>
        normal.authorizeNormalCurrentStore(
          f.jobClient,
          `wrong-${key}:${randomUUID()}`,
          ref(file),
        ),
      /Unsupported source/,
    );
  }
});

test("normal owner authorization preserves a retained historical queue snapshot above 16 MiB", (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "queue-state.json");
  // The real incident's historical queue snapshot is 34,367,179 bytes. The
  // existing queue/successor reader supports 256 MiB; retain its exact bytes.
  fs.appendFileSync(file, " ".repeat(17 * 1024 * 1024));
  const before = hash(fs.readFileSync(file));
  const authorization = normal.authorizeNormalCurrentStore(
    f.jobClient,
    f.requestId + ":large-history",
    f.targetReference,
  );
  const value = JSON.parse(fs.readFileSync(authorization.path, "utf8"));
  assert.deepEqual(
    value.snapshot.files.find((entry: { path: string }) => entry.path === file),
    { path: file, sha256: before },
  );
  assert.equal(hash(fs.readFileSync(file)), before);
});

test("owner authorizer and recovery qualification never read or hash credential-bearing request files", (t) => {
  const f = fixture(t),
    read = fs.readFileSync,
    open = fs.openSync;
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
  fs.openSync = ((
    file: Parameters<typeof fs.openSync>[0],
    ...args: unknown[]
  ) => {
    assert.notEqual(
      String(file),
      sealed,
      "Credential request bytes must never be opened",
    );
    return Reflect.apply(open, fs, [file, ...args]);
  }) as typeof fs.openSync;
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
    fs.openSync = open;
  }
});

for (const [outcome, runtime] of [
  ["retired", undefined],
  ["unknown", undefined],
  ["retired", laterRuntime],
  ["unknown", laterRuntime],
] as const) {
  test(`normal metadata composes existing pidfd kernel once after SDK death: ${outcome}, ${runtime ? "explicit" : "legacy"} runtime`, (t) => {
    const p = { ...legacyProfile, ...runtime };
    const f = fixture(t, runtime);
    fs.unlinkSync(f.retirement.path); // Simulate the real order: SDK death, metadata retirement, then producer receipt.
    const original = fs.readFileSync(path.join(f.epoch, "queue-state.json"));
    const processProof = {
      ...p.metadata,
      exe: "/synthetic/node",
      exeSha256: "a".repeat(64),
      cmdline: [
        "/synthetic/node",
        f.dir + "/src/queue-epoch-successor-worker.js",
      ],
      childrenByTask: { "1": [] },
      socketRows: [],
    };
    const interpreter = {
      path: "/synthetic/python3",
      sha256: "b".repeat(64),
      version: "synthetic interpreter",
    };
    let previews = 0,
      effects = 0,
      metadataAbsent = false;
    const ports: import("../src/composition/queue-normal-cold-successor").NormalMetadataRetirementPorts =
      {
        ...f.ports,
        buildHash: () => p.buildHash,
        producerAbsent: (process) =>
          process.pid === p.metadata.pid ? metadataAbsent : true,
        process(owner, runtime, refs, apply, root) {
          assert.equal(root, f.dir);
          assert.equal(runtime, f.dir);
          assert.equal(owner.pid, p.metadata.pid);
          assert.equal(owner.birth, p.metadata.birth);
          assert.ok(
            refs.every((entry) => !entry.path.endsWith("request.json")),
          );
          if (!apply) {
            previews++;
            return { process: processProof, retired: false, interpreter };
          }
          effects++;
          assert.deepEqual(owner.processProof, processProof);
          assert.deepEqual(owner.interpreterProof, interpreter);
          assert.ok(
            refs.some((entry) =>
              entry.path.endsWith("metadata-retirement-effect-start.json"),
            ),
          );
          if (outcome === "unknown")
            throw Object.assign(
              new Error("synthetic lost kernel acknowledgement"),
              { code: "SYNTHETIC_UNKNOWN" },
            );
          metadataAbsent = true;
          return { process: processProof, retired: true, interpreter };
        },
      };
    const death = f.approval.normalCurrentStore!.deathProof;
    if (runtime) {
      assert.throws(
        () =>
          normal.retireNormalMetadataProducer(
            f.epochClient,
            f.requestId,
            f.authorization,
            death,
            f.dir,
            false,
            { ...ports, buildHash: () => legacyProfile.buildHash },
          ),
        /exact qualified predecessor runtime/,
      );
      assert.equal(previews, 0);
      assert.equal(effects, 0);
    }
    normal.retireNormalMetadataProducer(
      f.epochClient,
      f.requestId,
      f.authorization,
      death,
      f.dir,
      false,
      ports,
    );
    const result = normal.retireNormalMetadataProducer(
      f.epochClient,
      f.requestId,
      f.authorization,
      death,
      f.dir,
      true,
      ports,
    );
    const repeated = normal.retireNormalMetadataProducer(
      f.epochClient,
      f.requestId,
      f.authorization,
      death,
      f.dir,
      true,
      ports,
    );
    assert.deepEqual(repeated, result);
    assert.equal(previews, 1);
    assert.equal(effects, 1);
    if (outcome === "unknown") {
      assert.deepEqual(result, {
        pending: true,
        noSignalReplay: true,
        sdkRequestsSent: 0,
      });
      const retarget = f.requestId + ":retarget";
      const anotherOwnerGrant = normal.authorizeNormalCurrentStore(
        f.jobClient,
        retarget,
        f.targetReference,
      );
      const anotherProofFile = path.join(f.dir, "retarget-death-proof.json");
      const oldProof = JSON.parse(fs.readFileSync(death.path, "utf8"));
      write(anotherProofFile, {
        ...oldProof,
        bindings: { ...oldProof.bindings, jobAuthorization: anotherOwnerGrant },
      });
      assert.throws(() =>
        normal.retireNormalMetadataProducer(
          f.epochClient,
          retarget,
          anotherOwnerGrant,
          ref(anotherProofFile),
          f.dir,
          true,
          ports,
        ),
      );
      metadataAbsent = true;
      assert.throws(() =>
        normal.recordNormalProducerRetirement(
          f.epochClient,
          retarget,
          anotherOwnerGrant,
          ports,
        ),
      );
      assert.equal(effects, 1);
    } else {
      assert.ok("path" in result);
      const receipt = JSON.parse(fs.readFileSync(result.path, "utf8"));
      assert.equal(receipt.retired, true);
      assert.equal(receipt.originalExecutionOutcome, "unknown");
      normal.recordNormalProducerRetirement(
        f.epochClient,
        f.requestId,
        f.authorization,
        ports,
      );
    }
    assert.deepEqual(
      fs.readFileSync(path.join(f.epoch, "queue-state.json")),
      original,
    );
  });
}

for (const bad of [
  "owner",
  "runtime",
  "live-sdk",
  "producer",
  "missing-death",
]) {
  test(`normal metadata refuses ${bad} before any kernel effect`, (t) => {
    const f = fixture(t);
    let kernel = 0;
    const ports: import("../src/composition/queue-normal-cold-successor").NormalMetadataRetirementPorts =
      {
        ...f.ports,
        buildHash: () => (bad === "runtime" ? "f".repeat(64) : p.buildHash),
        process() {
          kernel++;
          assert.fail("No kernel call after a refused normal proof");
        },
      };
    if (bad === "live-sdk")
      ports.sdkProcess = (process) => ({
        state: "present",
        pid: process.pid,
        birth: process.birth,
        observedAtUtc: new Date().toISOString(),
      });
    if (bad === "producer") ports.producerAbsent = () => false;
    const death =
      bad === "missing-death"
        ? {
            path: path.join(f.dir, "missing-proof.json"),
            sha256: "f".repeat(64),
          }
        : f.approval.normalCurrentStore!.deathProof;
    assert.throws(() =>
      normal.retireNormalMetadataProducer(
        bad === "owner" ? f.jobClient : f.epochClient,
        f.requestId,
        f.authorization,
        death,
        f.dir,
        true,
        ports,
      ),
    );
    assert.equal(kernel, 0);
  });
}

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
    identityPolicy: "creation-or-name-v1",
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
  assert.throws(() =>
    normal.validateNormalCurrentFacts(
      { ...facts, identityPolicy: "unrecognized-policy" },
      currentIdentity,
    ),
  );
});

test("normal current-facts final receipt artifact passes the real pinned checker without SDK or platform impersonation", async (t) => {
  syntheticReceiptPaths(t, "/tmp/opencode");
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

for (const observationMode of [
  "complete",
  "missing-remote",
  "validator-failed",
]) {
  test(`normal successor uses existing once-only engine and real checker: ${observationMode}; no write or ledger settlement`, async (t) => {
    const f =
      observationMode === "validator-failed"
        ? fixture(t, laterRuntime, true, "Untitled")
        : fixture(t);
    syntheticReceiptPaths(t, f.dir);
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
    const previousQualificationFile = path.join(audit, "qualification.json");
    write(previousQualificationFile, {
      passed: true,
      productionAdmission: true,
      liveSdkRequestsSent: 0,
      sourceCommit: "f".repeat(40),
      buildHash: "f".repeat(64),
      publicDirectAccessRefused: true,
      deadEpochSuccessorReadQualified: true,
      deadEpochSuccessorRestoreQualified: true,
      normalCurrentStoreSuccessorQualified: true,
    });
    const authority = {
      requestId: f.requestId,
      clientId: p.epochClientId,
      ownerTokenHash: hash(f.epochClient.auth.clientToken),
      expectedProcess: f.approval.expectedProcess,
      previousOwner: f.owner,
      normalCurrentStore: f.approval.normalCurrentStore,
      predecessor: {},
      sourceCommit: "f".repeat(40),
      candidateRoot: path.resolve("."),
      buildHash: "f".repeat(64),
      qualification: ref(previousQualificationFile),
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
      identityPolicy: "creation-or-name-v1",
      activeCommand: "SelectCommand",
      documents:
        observationMode === "validator-failed"
          ? [
              {
                creationId: randomUUID(),
                name: "Untitled",
                fileId: null,
                isSaved: false,
                isModified: false,
              },
            ]
          : [],
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
          if (
            observationMode === "complete" ||
            observationMode === "validator-failed"
          )
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
    if (observationMode === "validator-failed") {
      const observationDirectory = path.join(
        audit,
        "dead-epoch-current-observation",
      );
      const validationFailure = ref(
          path.join(observationDirectory, "result.json"),
        ),
        physicalResult = ref(
          JSON.parse(
            fs.readFileSync(
              path.join(observationDirectory, "start.json"),
              "utf8",
            ),
          ).receipt,
        ),
        previousAuthority = ref(authorityFile),
        oldFailureBytes = fs.readFileSync(validationFailure.path),
        oldPhysicalBytes = fs.readFileSync(physicalResult.path),
        oldStateBytes = fs.readFileSync(path.join(f.epoch, "queue-state.json"));
      assert.equal(JSON.parse(oldFailureBytes.toString()).status, "failed");
      assert.equal(
        JSON.parse(oldFailureBytes.toString()).code,
        "NORMAL_SUCCESSOR_UNPROVEN",
      );
      assert.equal(
        fs.existsSync(path.join(observationDirectory, "response.json")),
        false,
      );
      const currentOwner = {
        pid: 900002,
        birth: "synthetic-linux-boot:retry-current-owner",
        nonce: "normal-retry-current-owner",
        protocol: 2,
      };
      write(path.join(f.dir, "broker.lock"), currentOwner);
      write(path.join(f.dir, `broker-lifecycle-${currentOwner.nonce}.json`), {
        owner: currentOwner,
        buildHash: "f".repeat(64),
        configHash: p.configHash,
        stage: "recovery",
      });
      write(path.join(f.dir, "active-epoch-succession.json"), {
        version: 1,
        authority: previousAuthority,
      });
      const candidate = {
        requestId: `normal-currentfacts-retry:${randomUUID()}`,
        candidateRoot: path.resolve("."),
        sourceCommit: "e".repeat(40),
        buildHash: "d".repeat(64),
        expectedProcess: {
          pid: 900003,
          birth: String(
            BigInt(Date.now() + 60000) * 10000n + 116444736000000000n,
          ),
        },
        qualification: { path: "", sha256: "" },
      };
      const candidateQualificationFile = path.join(
        f.dir,
        "retry-qualification.json",
      );
      write(candidateQualificationFile, {
        passed: true,
        productionAdmission: true,
        liveSdkRequestsSent: 0,
        sourceCommit: candidate.sourceCommit,
        buildHash: candidate.buildHash,
        publicDirectAccessRefused: true,
        deadEpochSuccessorReadQualified: true,
        deadEpochSuccessorRestoreQualified: true,
        normalCurrentStoreSuccessorQualified: true,
      });
      candidate.qualification = ref(candidateQualificationFile);
      const queueSummary = {
        sourceCommit: authority.sourceCommit,
        buildHash: "f".repeat(64),
        paused: false,
        stopping: false,
        historicalOutcome: "unknown",
        historicalModelValidation: "not_performed",
        deadEpochSuccessor: {
          requestId: f.requestId,
          expectedProcess: f.approval.expectedProcess,
          predecessorEpochId: p.epochId,
          currentFactsAvailable: false,
          observationRequestId: f.requestId + ":observe",
          creationRequestId: f.requestId + ":create",
          historicalOutcome: "unknown",
        },
        control: {
          instanceId: currentOwner.nonce,
          buildHash: "f".repeat(64),
          activeOperations: 0,
          activeIds: [],
          phase: "RECOVERY_BLOCKED",
          unresolved: true,
        },
      };
      const retry = normal.authorizeNormalCurrentFactsRetry(
        f.epochClient,
        {
          previousRequestId: f.requestId,
          previousAuthority,
          physicalResult,
          validationFailure,
          queueSummary,
        },
        candidate,
      );
      assert.ok(fs.existsSync(retry.path));
      assert.deepEqual(
        fs.readFileSync(validationFailure.path),
        oldFailureBytes,
      );
      assert.deepEqual(fs.readFileSync(physicalResult.path), oldPhysicalBytes);
      assert.deepEqual(
        fs.readFileSync(path.join(f.epoch, "queue-state.json")),
        oldStateBytes,
      );
      let effects = 0,
        producerAbsent = false;
      const processProof = {
          ...currentOwner,
          exe: "/synthetic/node",
          exeSha256: "a".repeat(64),
          cmdline: ["/synthetic/node", "queue-epoch-successor-worker.js"],
          childrenByTask: { "1": [] },
          socketRows: [],
        },
        interpreter = {
          path: "/synthetic/python3",
          sha256: "b".repeat(64),
          version: "synthetic interpreter",
        },
        retirementPorts: import("../src/composition/queue-normal-cold-successor").NormalMetadataRetirementPorts =
          {
            ...f.ports,
            buildHash: () => "f".repeat(64),
            process(owner, runtime, refs, apply, root) {
              assert.equal(root, f.dir);
              assert.equal(runtime, path.resolve("."));
              assert.equal(owner.pid, currentOwner.pid);
              assert.equal(owner.birth, currentOwner.birth);
              assert.ok(
                refs.every((entry) => !entry.path.endsWith("request.json")),
              );
              if (apply) {
                effects++;
                assert.deepEqual(owner.processProof, processProof);
                assert.deepEqual(owner.interpreterProof, interpreter);
                producerAbsent = true;
                return { process: processProof, retired: true, interpreter };
              }
              return { process: processProof, retired: false, interpreter };
            },
            producerAbsent: () => producerAbsent,
          };
      const preview = normal.retireNormalCurrentFactsRetryProducer(
        f.epochClient,
        retry,
        false,
        retirementPorts,
      );
      assert.ok("path" in preview);
      assert.equal(effects, 0);
      const retired = normal.retireNormalCurrentFactsRetryProducer(
        f.epochClient,
        retry,
        true,
        retirementPorts,
      );
      assert.ok("path" in retired);
      assert.equal(effects, 1);
      assert.deepEqual(
        normal.retireNormalCurrentFactsRetryProducer(
          f.epochClient,
          retry,
          true,
          retirementPorts,
        ),
        retired,
      );
      const candidateBinding = {
        requestId: candidate.requestId,
        sourceCommit: candidate.sourceCommit,
        buildHash: candidate.buildHash,
        qualification: candidate.qualification,
        expectedProcess: candidate.expectedProcess,
      };
      const beforeBootstrap = normal.inspectNormalCurrentFactsRetry(
        f.dir,
        retry,
        candidateBinding,
        retirementPorts,
      );
      assert.deepEqual(beforeBootstrap.currentOwner, currentOwner);
      const nextAuthorityFile = path.join(
        f.dir,
        "epoch-successions",
        hash(candidate.requestId),
        "authority.json",
      );
      const nextAuthority = {
        kind: "owner-authenticated-dead-epoch-successor",
        requestId: candidate.requestId,
        sourceCommit: candidate.sourceCommit,
        buildHash: candidate.buildHash,
        candidateRoot: candidate.candidateRoot,
        qualification: candidate.qualification,
        expectedProcess: candidate.expectedProcess,
        previousOwner: currentOwner,
        normalCurrentStore: f.approval.normalCurrentStore,
        priorNormalCurrentFactsRetry: retry,
      };
      write(nextAuthorityFile, nextAuthority);
      const nextAuthorityRef = ref(nextAuthorityFile),
        nextOwner = {
          pid: 900004,
          birth: "synthetic-linux-boot:retry-next-owner",
          nonce: "normal-retry-next-owner",
          protocol: 2,
        };
      write(path.join(f.dir, "active-epoch-succession.json"), {
        version: 1,
        authority: nextAuthorityRef,
      });
      write(path.join(f.dir, "broker.lock"), nextOwner);
      const afterBootstrap = normal.inspectNormalCurrentFactsRetry(
        f.dir,
        retry,
        candidateBinding,
        retirementPorts,
      );
      assert.deepEqual(afterBootstrap.currentOwner, currentOwner);
      const retryBinding = {
        purpose: "normal-currentstore-current-facts-v1",
        clientId: p.epochClientId,
        expectedProcess: candidate.expectedProcess,
        successorAuthorityHash: nextAuthorityRef.sha256,
        normalCurrentStore: f.approval.normalCurrentStore,
        priorNormalCurrentFactsRetry: retry,
        normalCurrentFactsRetryCandidate: afterBootstrap.candidate,
      };
      const retryIdentity = {
        kind: currentIdentity.kind,
        resolvedIdentity: { creationId: p.creationId, name: "Untitled" },
      };
      const retryReader = normal.prepareNormalCurrentFacts(
        path.resolve("."),
        retryIdentity,
        retryBinding,
      );
      assert.match(
        retryReader.artifact.script,
        /_nc_json\.dumps\(normal_currentstore_facts\([^\r\n]*, True\)/,
      );
      const defaultFacts = {
        kind: "normal-currentstore-current-facts-v1",
        originalDocumentCreationId: p.creationId,
        originalDocumentName: "Untitled",
        originalDocumentPresent: false,
        identityPolicy: "new-unsaved-default-v1",
        activeCommand: "SelectCommand",
        documents: [
          {
            creationId: randomUUID(),
            name: "Untitled",
            fileId: null,
            isSaved: false,
            isModified: false,
          },
        ],
        historicalOutcome: "unknown",
        modelValidation: "not_performed",
      };
      assert.deepEqual(
        normal.validateNormalCurrentFacts(
          defaultFacts,
          retryIdentity,
          retryBinding,
        ),
        defaultFacts,
      );
      assert.throws(() =>
        normal.validateNormalCurrentFacts(defaultFacts, retryIdentity),
      );
      assert.throws(() =>
        normal.validateNormalCurrentFacts(
          {
            ...defaultFacts,
            documents: [{ ...defaultFacts.documents[0], isModified: true }],
          },
          retryIdentity,
          retryBinding,
        ),
      );
      assert.deepEqual(
        fs.readFileSync(validationFailure.path),
        oldFailureBytes,
      );
      assert.deepEqual(fs.readFileSync(physicalResult.path), oldPhysicalBytes);
      assert.deepEqual(
        fs.readFileSync(path.join(f.epoch, "queue-state.json")),
        oldStateBytes,
      );
    }
  });
}
