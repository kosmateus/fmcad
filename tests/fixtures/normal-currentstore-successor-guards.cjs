"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
} = require("node:crypto");

const absentError =
  "NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand";
const filetimeEpoch = 116444736000000000n;

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function token() {
  return randomBytes(32).toString("base64url");
}

function pid(excluded = []) {
  let result;
  do {
    result = randomInt(10000, 2147483647);
  } while (excluded.includes(result));
  return result;
}

function filetime(milliseconds) {
  return (
    BigInt(milliseconds) * 10000n +
    filetimeEpoch +
    BigInt(randomInt(0, 10000))
  ).toString();
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function reference(file) {
  return { path: file, sha256: hash(fs.readFileSync(file)) };
}

function captureHistory(root, sealedRequest) {
  const records = [];
  const visit = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(directory, entry.name);
      if (file === sealedRequest) continue;
      if (entry.isDirectory()) visit(file);
      else if (entry.isSymbolicLink())
        records.push([
          path.relative(root, file),
          `symlink:${fs.readlinkSync(file)}`,
        ]);
      else records.push([path.relative(root, file), fs.readFileSync(file)]);
    }
  };
  visit(root);
  return records;
}

function requestMetadata(file) {
  const stat = fs.lstatSync(file);
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    isSymbolicLink: stat.isSymbolicLink(),
  };
}

function withRequestAccessGuard(requestFile, operation) {
  const target = path.resolve(requestFile);
  const attempts = [];
  const exact = (value) => {
    if (typeof value !== "string") return false;
    return path.resolve(value) === target;
  };
  const contains = (value) => {
    if (typeof value !== "string") return false;
    const source = path.resolve(value);
    const relative = path.relative(source, target);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== "..")
    );
  };
  const guards = {
    readFileSync: (args) => exact(args[0]),
    readFile: (args) => exact(args[0]),
    createReadStream: (args) => exact(args[0]),
    openSync: (args) => exact(args[0]),
    open: (args) => exact(args[0]),
    writeFileSync: (args) => exact(args[0]),
    writeFile: (args) => exact(args[0]),
    appendFileSync: (args) => exact(args[0]),
    appendFile: (args) => exact(args[0]),
    copyFileSync: (args) => exact(args[0]) || exact(args[1]),
    copyFile: (args) => exact(args[0]) || exact(args[1]),
    cpSync: (args) => contains(args[0]) || exact(args[1]),
    cp: (args) => contains(args[0]) || exact(args[1]),
    renameSync: (args) => exact(args[0]) || exact(args[1]),
    rename: (args) => exact(args[0]) || exact(args[1]),
    unlinkSync: (args) => exact(args[0]),
    unlink: (args) => exact(args[0]),
  };
  const originals = new Map();
  for (const [name, blocks] of Object.entries(guards)) {
    const original = fs[name];
    originals.set(name, original);
    fs[name] = function (...args) {
      if (blocks(args)) {
        attempts.push(name);
        throw new Error(`sealed synthetic request access blocked: ${name}`);
      }
      return original.apply(this, args);
    };
  }
  try {
    return { value: operation(), attempts };
  } finally {
    for (const [name, original] of originals) fs[name] = original;
  }
}

function createUnknownQueue(QueueState, directory, request, jobId) {
  let time = Date.now() - 10000;
  const state = new QueueState(directory, { now: () => ++time });
  state.submit(request, jobId);
  state.readyTurn(jobId);
  const ready = state.next();
  if (!ready || ready.id !== jobId)
    throw new Error("Synthetic queue job was not selected for its SDK turn");
  state.markDispatch(jobId, { rpcCount: 1, completedCount: 0 });
  state.finish(jobId, {
    state: "needs_reconciliation",
    reason: "Synthetic fixture retains the original unknown outcome",
  });
}

function createRootHistory(QueueState, directory, epochClientId) {
  const state = new QueueState(directory);
  const historical = state.submit({
    kind: "rpc",
    clientId: epochClientId,
    requestId: `normal-history:${randomUUID()}`,
    timeoutMs: 30000,
    payload: { method: "ping" },
  });
  state.next();
  state.markDispatch(historical.id);
  state.finish(historical.id, {
    state: "needs_reconciliation",
    code: "SYNTHETIC_OLD_UNKNOWN",
  });
}

function createFixture(
  normal,
  QueueState,
  canonical,
  testContext,
  options = {},
) {
  const id = () => randomUUID();
  const jobId = id();
  const epochId = id();
  const creationId = id();
  const jobClientId = `normal-job-owner:${id()}`;
  const epochClientId = `normal-epoch-owner:${id()}`;
  const sdk = {
    pid: pid(),
    birth: filetime(Date.now() - 60000),
    version: "2706.1.17",
  };
  const metadata = {
    pid: pid([sdk.pid]),
    birth: `synthetic-linux-boot:${id()}:${randomInt(1, 1000000)}`,
  };
  const worker = {
    pid: pid([sdk.pid, metadata.pid]),
    birth: `synthetic-linux-boot:${id()}:${randomInt(1, 1000000)}`,
  };
  const p = {
    ...normal.normalColdProfile,
    epochId,
    epochClientId,
    jobId,
    jobClientId,
    jobRequestId: id(),
    rpcId: id(),
    creationId,
    documentName: `FMCAD_MULTI_${id().replaceAll("-", "_")}`,
    requestHash: randomBytes(32).toString("hex"),
    sourceHash: randomBytes(32).toString("hex"),
    configHash: randomBytes(32).toString("hex"),
    sdk,
    metadata,
  };
  const dir = fs.mkdtempSync("/tmp/opencode/normal-currentstore-guards-");
  testContext.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const epoch = path.join(dir, "admission-epochs", epochId);
  const jobDir = path.join(dir, "jobs", jobId);
  const jobClient = {
    dir,
    auth: { clientId: jobClientId, clientToken: token() },
  };
  const epochClient = {
    dir,
    auth: { clientId: epochClientId, clientToken: token() },
  };
  const owner = { ...metadata, nonce: id(), protocol: 2 };
  const document = { fileId: null, creationId };
  const pointer = {
    epochId,
    root: epoch,
    ownerClientId: epochClientId,
    ownerTokenHash: hash(epochClient.auth.clientToken),
    originalInstance: sdk,
    currentInstance: sdk,
    document,
    quarantinedJobIds: [id(), id()],
    historicalSnapshotHash: randomBytes(32).toString("hex"),
    historicalIdentityHash: randomBytes(32).toString("hex"),
    qualificationReceipt: {
      path: path.join(epoch, "qualification.json"),
      sha256: randomBytes(32).toString("hex"),
    },
    qualificationEvidence: [],
  };
  const ownerPath = path.join(dir, "broker.lock");
  const jobRequest = {
    requestId: p.jobRequestId,
    clientId: jobClientId,
    kind: "command",
    phased: true,
    backend: "mcp",
    buildHash: p.buildHash,
    ownerToken: hash(jobClient.auth.clientToken),
    argv: [
      "run",
      `/synthetic/${id()}.py`,
      "--doc-id",
      creationId,
      "--doc",
      p.documentName,
      "--helpers",
      "cad-v1",
    ],
    cwd: dir,
    timeoutMs: 180000,
  };
  const rootState = path.join(dir, "queue-state.json");
  const epochState = path.join(epoch, "queue-state.json");
  const workerIdentity = path.join(jobDir, "worker-identity.json");
  const requestFile = path.join(jobDir, "request.json");
  const rpcFile = path.join(jobDir, `rpc-${p.rpcId}.json`);
  const targetFile = path.join(dir, "normal-target.json");
  const closedFile = path.join(epoch, "closed.json");
  const identity = {
    sourceCommit: p.sourceCommit,
    buildHash: p.buildHash,
    configHash: p.configHash,
    instance: sdk,
  };

  writeJson(path.join(dir, "clients.json"), {
    [jobClientId]: hash(jobClient.auth.clientToken),
    [epochClientId]: hash(epochClient.auth.clientToken),
  });
  writeJson(path.join(dir, "isolated-admission-epoch.json"), pointer);
  writeJson(ownerPath, owner);
  writeJson(path.join(dir, `broker-lifecycle-${owner.nonce}.json`), {
    owner,
    buildHash: p.buildHash,
    configHash: p.configHash,
    stage: "recovery",
  });
  writeJson(path.join(dir, "instance.json"), identity);
  writeJson(path.join(epoch, "instance.json"), identity);
  createRootHistory(QueueState, dir, epochClientId);
  createUnknownQueue(QueueState, epoch, jobRequest, jobId);
  const closeDirectory = path.join(
    dir,
    "epoch-successions",
    hash(`normal-close:${id()}`),
    "isolated-scratch-close",
  );
  const closeFiles = [
    "result.json",
    "intent.json",
    "start.json",
    "wire.json",
    "sdk-closed.json",
    `remote-${id()}.json`,
  ].map((name) => {
    const file = path.join(closeDirectory, name);
    writeJson(file, {
      fixture: "synthetic retained close evidence; not physical Fusion proof",
    });
    return reference(file);
  });
  writeJson(closedFile, {
    epochId,
    document,
    admissionMode: "normal-multidocument",
    historicalOutcome: "unknown",
    receipt: closeFiles[0],
    qualificationEvidence: closeFiles.slice(1),
  });
  writeJson(workerIdentity, worker);
  writeJson(path.join(jobDir, "worker-result.json"), {
    code: 1,
    terminal: true,
    workflowOutcome: null,
  });
  writeJson(requestFile, { credential: `synthetic-sealed-${token()}` });
  writeJson(rpcFile, {
    terminal: false,
    instance: sdk,
    binding: {
      jobId,
      rpcId: p.rpcId,
      requestHash: p.requestHash,
      sourceHash: p.sourceHash,
      buildHash: p.buildHash,
    },
  });
  const job = JSON.parse(fs.readFileSync(epochState, "utf8")).jobs[jobId];
  const target = { ...p };
  delete target.sourceCommit;
  delete target.buildHash;
  writeJson(targetFile, {
    ...target,
    jobHash: job.hash,
    kind: "normal-currentstore-target-v1",
  });

  const targetReference = reference(targetFile);
  const sdkCalls = [];
  const producerCalls = [];
  const ports = {
    sdkProcess(process) {
      sdkCalls.push({ pid: process.pid, birth: process.birth });
      const observedAtUtc = new Date().toISOString();
      if (process.pid === sdk.pid)
        return {
          state: "absent",
          pid: sdk.pid,
          errorId: absentError,
          observedAtUtc,
        };
      return {
        state: "present",
        pid: process.pid,
        birth: process.birth,
        observedAtUtc,
      };
    },
    producerAbsent(process) {
      producerCalls.push({ pid: process.pid, birth: process.birth });
      return (
        (process.pid === metadata.pid && process.birth === metadata.birth) ||
        (process.pid === worker.pid && process.birth === worker.birth)
      );
    },
  };
  const requestId = `normal-cold:${id()}`;
  const f = {
    p,
    dir,
    epoch,
    jobDir,
    jobClient,
    epochClient,
    owner,
    pointer,
    requestId,
    requestFile,
    workerIdentity,
    worker,
    rpcFile,
    targetFile,
    closedFile,
    rootState,
    epochState,
    ports,
    sdkCalls,
    producerCalls,
    targetReference,
  };
  f.captureHistory = () => captureHistory(dir, requestFile);
  f.requestMetadata = () => requestMetadata(requestFile);
  f.withRequestAccessGuard = (operation) =>
    withRequestAccessGuard(requestFile, operation);
  f.updateTarget = (changes) => {
    const current = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    Object.assign(current, changes);
    writeJson(targetFile, current);
    return reference(targetFile);
  };
  f.mutateJobRequest = (changes) => {
    const state = JSON.parse(fs.readFileSync(epochState, "utf8"));
    const currentJob = state.jobs[jobId];
    currentJob.request = { ...currentJob.request, ...changes };
    const immutableRequest = { ...currentJob.request };
    delete immutableRequest.description;
    currentJob.hash = hash(canonical(immutableRequest));
    writeJson(epochState, state);
    const target = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    target.jobHash = currentJob.hash;
    writeJson(targetFile, target);
    return reference(targetFile);
  };
  f.addUnresolvedJob = () => {
    const state = new QueueState(epoch, { now: () => Date.now() });
    const extraRequest = {
      requestId: id(),
      clientId: `normal-extra-owner:${id()}`,
      kind: "command",
      phased: true,
      backend: "mcp",
      buildHash: p.buildHash,
      ownerToken: hash(token()),
      argv: ["run", `/synthetic/${id()}.py`],
      cwd: dir,
      timeoutMs: 180000,
    };
    return state.submit(extraRequest, id());
  };
  if (options.omitWorkerIdentity) fs.unlinkSync(workerIdentity);
  if (options.workerStartWithoutIdentity)
    writeJson(path.join(jobDir, "worker-start.json"), worker);
  if (options.beforeAuthorize) options.beforeAuthorize(f);

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
  const retiredAt = Date.parse(
    JSON.parse(fs.readFileSync(retirement.path, "utf8")).observedAtUtc,
  );
  const expectedProcess = {
    pid: pid([sdk.pid, metadata.pid, worker.pid]),
    birth: filetime(retiredAt + 1000),
  };
  const now = new Date(Date.now() - 1000).toISOString();
  const deathFile = path.join(dir, "sdk-death-proof.json");
  writeJson(deathFile, {
    version: 1,
    kind: "sdk-process-death-proof-v1",
    expectedProcess: sdk,
    before: {
      state: "present",
      ...sdk,
      exe: "C:\\Synthetic\\Fusion360.exe",
      windowHandle: String(randomInt(1, 2147483647)),
      observedAtUtc: now,
    },
    handleBoundExit: {
      pid: sdk.pid,
      birth: sdk.birth,
      hasExited: true,
      observedAtUtc: now,
    },
    after: {
      state: "absent",
      pid: sdk.pid,
      observedAtUtc: now,
      errorId: absentError,
    },
    bindings: {
      jobAuthorization: authorization,
      originalRpc: reference(rpcFile),
      predecessorState: reference(epochState),
    },
  });
  const approval = {
    requestId,
    clientId: epochClientId,
    previousBuildHash: p.buildHash,
    expectedProcess,
    normalCurrentStore: {
      kind: "normal-currentstore-v1",
      jobAuthorization: authorization,
      deathProof: reference(deathFile),
      producerRetirement: retirement,
    },
  };
  Object.assign(f, {
    authorization,
    retirement,
    expectedProcess,
    deathFile,
    approval,
  });
  return f;
}

module.exports = { createFixture, hash, reference };
