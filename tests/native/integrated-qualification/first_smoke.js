"use strict";

// Inject an already-started public f708 FmcadServices client. Importing this
// module is inert: it never constructs a client, starts a broker, or connects.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TEMP_ROOT = "/tmp/opencode";
const F708_RUNTIME = Object.freeze({
  sourceCommit: "f7082569f9ac8c321e704175cccc6781275a0d0e",
  buildHash: "0abaea48090ed901ca842604b66d1bf79978f8939c77a1250899da37417b08d0",
});
const CHECKER_SUCCESSOR_PIN = Object.freeze({
  sourceCommit: "bf8302c47ac85ce58b043c27280b11476ebbca80",
  buildHash: "1f2251b8efb6a789199b2d62e5f4f8a9be0701c2ff2099e1c68f32bcdc2fb7e5",
});
const F708_REJECTED_JOB_IDS = Object.freeze([
  "25544931-282f-45ac-b519-807180e1a8f9",
  "12fd5289-5233-48b4-93d1-a194b92d2c19",
]);
const CONTRACT_VERSIONS = Object.freeze({
  api: 1, dto: 1, broker: 2, persistedState: 1, pythonEnvelope: 1, controlApi: 1,
});
const OPERATIONS = Object.freeze([
  "sketch.create", "sketch.geometry", "sketch.inspect", "model.extrude",
  "entity.inspect", "measure.volume",
]);
const SEQUENCE_PHASES = Object.freeze([
  "sketchCreate", "sketchGeometry", "sketchInspect", "extrude", "bodyInspect", "volume",
]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);
const SEQUENCE_PENDING = new Set(["preparing", "queued", "running"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, label) {
  object(value, label);
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new TypeError(`${label} has unsupported field ${extra[0]}`);
}

function token(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new TypeError(`${label} must contain 1..256 characters`);
  }
  return value;
}

function validToken(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function sameDocument(left, right, label) {
  object(left, `${label} document`);
  if (left.name !== right.name || left.creationId !== right.creationId || left.fileId !== null ||
      right.fileId !== null) {
    throw new TypeError(`${label} does not match the exact unsaved scratch identity`);
  }
}

function validateRuntimeUpgradeReceipt(receipt, runtime, ownerClientId, clientId, epochId, document) {
  exactKeys(receipt, ["kind", "epochId", "document", "previousBuildHash", "sourceCommit", "buildHash",
    "rejectedJobIds", "ownerClientId", "clientId", "ownerTokenBound", "sdkRequestsSent",
    "historicalOutcome", "grantScopeChanged", "gateClosed"], "Quiescent epoch runtime-upgrade receipt");
  if (receipt.kind !== "quiescent-isolated-epoch-runtime-upgrade" || receipt.epochId !== epochId ||
      receipt.previousBuildHash !== F708_RUNTIME.buildHash || receipt.sourceCommit !== runtime.sourceCommit ||
      receipt.buildHash !== runtime.buildHash || !/^[a-f0-9]{40}$/.test(receipt.sourceCommit || "") ||
      !/^[a-f0-9]{64}$/.test(receipt.buildHash || "") ||
      receipt.sourceCommit !== CHECKER_SUCCESSOR_PIN.sourceCommit ||
      receipt.buildHash !== CHECKER_SUCCESSOR_PIN.buildHash ||
      receipt.ownerClientId !== ownerClientId || receipt.clientId !== clientId || receipt.ownerTokenBound !== true ||
      receipt.sdkRequestsSent !== 0 || receipt.historicalOutcome !== "unknown" ||
      receipt.grantScopeChanged !== false || receipt.gateClosed !== true) {
    throw new TypeError("Runtime-upgrade receipt does not prove the exact owner-bound, closed, SDK-zero epoch transition");
  }
  exactKeys(receipt.document, ["name", "creationId", "fileId"], "Runtime-upgrade scratch document");
  sameDocument(receipt.document, document, "Runtime upgrade");
  if (!Array.isArray(receipt.rejectedJobIds) || receipt.rejectedJobIds.length !== F708_REJECTED_JOB_IDS.length ||
      new Set(receipt.rejectedJobIds).size !== F708_REJECTED_JOB_IDS.length ||
      F708_REJECTED_JOB_IDS.some((jobId) => !receipt.rejectedJobIds.includes(jobId))) {
    throw new TypeError("Runtime-upgrade receipt must bind both known terminal pre-SDK rejected jobs");
  }
  return Object.freeze({ ...receipt, document: Object.freeze({ ...receipt.document }),
    rejectedJobIds: Object.freeze([...receipt.rejectedJobIds]) });
}

function validateAuthority(authority) {
  exactKeys(authority, ["runtime", "runtimeUpgrade", "ownerJobs", "facts", "approval", "creation", "grant"],
    "First-smoke authority");
  exactKeys(authority.runtime, ["sourceCommit", "buildHash"], "Qualified runtime");
  if (authority.runtimeUpgrade === undefined &&
      (authority.runtime.sourceCommit !== F708_RUNTIME.sourceCommit ||
       authority.runtime.buildHash !== F708_RUNTIME.buildHash)) {
    throw new TypeError("First-smoke authority does not pin the qualified f708 source and build");
  }

  exactKeys(authority.ownerJobs, ["targetJobId", "observationJobId"], "Original owner jobs");
  const targetJobId = token(authority.ownerJobs.targetJobId, "Original target jobId");
  const observationJobId = token(authority.ownerJobs.observationJobId, "Original observation jobId");
  if (targetJobId === observationJobId) throw new TypeError("Original target and observer job IDs must differ");

  const facts = object(authority.facts, "Derived current facts");
  if (facts.kind !== "derived-current-audit-facts-v1" || facts.status !== "complete" ||
      facts.epochEligible !== true || facts.factsComplete !== true || facts.transportStatus !== "complete" ||
      facts.endpointVerified !== true || facts.sdkRequestsSent !== 1 ||
      facts.originalAuditFactsRecovered !== false || facts.historicalOutcome !== "unknown" ||
      facts.modelValidation !== "not_performed" || facts.rollbackVerification !== "not_performed" ||
      facts.currentModelingAdmission !== "blocked-pending-separate-facts-approval") {
    throw new TypeError("Actual current audit facts are incomplete or do not authorize one new scratch");
  }
  exactKeys(facts.key, ["jobId", "observationJobId", "requestId", "clientId"], "Facts audit key");
  if (facts.key.jobId !== targetJobId || facts.key.observationJobId !== observationJobId) {
    throw new TypeError("Derived facts are not bound to the exact original target and observer jobs");
  }
  token(facts.key.requestId, "Original audit requestId");
  const ownerClientId = token(facts.key.clientId, "Original owner clientId");
  if (!facts.originalRpcId || facts.originalAuditStatus?.status !== "failed" ||
      facts.originalAuditStatus?.code !== "EPROTO" || facts.originalAuditStatus?.endpointVerified !== false) {
    throw new TypeError("Facts do not preserve the exact failed original audit and RPC identity");
  }
  const evidence = facts.files;
  for (const key of ["captureIntent", "captureStart", "captureWire", "captureResult", "captureSdkFacts", "captureRemote"]) {
    if (!evidence?.[key] || typeof evidence[key].path !== "string" || !path.isAbsolute(evidence[key].path) ||
        !/^[a-f0-9]{64}$/.test(evidence[key].sha256 || "")) {
      throw new TypeError(`Derived facts omit hash-pinned ${key} evidence`);
    }
  }

  exactKeys(authority.approval, ["permission", "globalModelingAdmission", "historicalOutcome"], "Facts approval receipt");
  if (authority.approval.permission !== "one-proven-new-document-only" ||
      authority.approval.globalModelingAdmission !== "blocked" ||
      authority.approval.historicalOutcome !== "unknown") {
    throw new TypeError("Facts approval is not limited to one new scratch while preserving global HOLD");
  }

  const creation = object(authority.creation, "Scratch creation receipt");
  if (creation.kind !== "isolated-scratch-qualification" || creation.status !== "complete" ||
      creation.clientId !== ownerClientId || creation.jobId !== targetJobId ||
      creation.observationJobId !== observationJobId || !token(creation.requestId, "Scratch creation requestId")) {
    throw new TypeError("Scratch creation receipt is not a completed original-owner operation on the approved jobs");
  }
  if (creation.sdkRequestsSent !== 1) {
    throw new TypeError("Scratch creation receipt does not prove exactly one completed SDK creation request");
  }
  const activation = object(creation.activation, "Scratch activation receipt");
  if (activation.admission !== "qualified-fresh-scratch-only" || !token(activation.epochId, "Scratch epochId")) {
    throw new TypeError("Scratch creation did not produce a qualified fresh-scratch epoch");
  }
  exactKeys(activation.document, ["name", "creationId", "fileId"], "Created scratch document");
  const document = activation.document;
  token(document.name, "Scratch name");
  token(document.creationId, "Scratch creationId");
  if (document.fileId !== null) throw new TypeError("First-smoke scratch must remain unsaved and have no DataFile ID");

  exactKeys(authority.grant, ["epochId", "clientId", "document", "scope"], "Client grant receipt");
  const grant = authority.grant;
  if (grant.epochId !== activation.epochId || grant.scope !== "qualified-fresh-scratch-only") {
    throw new TypeError("Registered-client grant does not match the newly qualified epoch");
  }
  const clientId = token(grant.clientId, "Granted clientId");
  exactKeys(grant.document, ["name", "creationId", "fileId"], "Granted document");
  sameDocument(grant.document, document, "Client grant");
  const runtimeUpgrade = authority.runtimeUpgrade === undefined ? null
    : validateRuntimeUpgradeReceipt(authority.runtimeUpgrade, authority.runtime, ownerClientId,
      clientId, activation.epochId, document);
  return Object.freeze({
    sourceCommit: authority.runtime.sourceCommit,
    buildHash: authority.runtime.buildHash,
    ...(runtimeUpgrade ? { runtimeUpgrade } : {}),
    ownerJobs: Object.freeze({ targetJobId, observationJobId }),
    ownerClientId,
    factsRequestId: facts.key.requestId,
    epochId: activation.epochId,
    document: Object.freeze({ name: document.name, creationId: document.creationId, fileId: null }),
    clientId,
  });
}

function validateServices(services) {
  object(services, "Public fmcad services");
  exactKeys(services.versions, Object.keys(CONTRACT_VERSIONS), "fmcad contract versions");
  for (const [key, value] of Object.entries(CONTRACT_VERSIONS)) {
    if (services.versions[key] !== value) throw new TypeError(`Unsupported fmcad ${key} contract version`);
  }
  if (typeof services.execute !== "function" || typeof services.query?.validate !== "function" ||
      typeof services.query?.status !== "function" || typeof services.query?.result !== "function" ||
      typeof services.query?.request !== "function" || typeof services.query?.catalog !== "function" ||
      typeof services.control !== "function") {
    throw new TypeError("Expected the public f708 FmcadServices execute/query/control API");
  }
}

function privateEvidenceDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw new TypeError("evidenceDir must be an existing private absolute directory under /tmp/opencode");
  }
  const absolute = path.resolve(directory);
  const stat = fs.lstatSync(absolute);
  if (absolute === TEMP_ROOT || !absolute.startsWith(`${TEMP_ROOT}${path.sep}`) ||
      !stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute ||
      (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new TypeError("evidenceDir must be an owned, mode-0700, non-symlink directory under /tmp/opencode");
  }
  return absolute;
}

function ledgerPath(evidenceDir, runId, epochId) {
  const id = crypto.createHash("sha256").update(`${runId}\0${epochId}`).digest("hex");
  return path.join(evidenceDir, `first-smoke-${id}.json`);
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeNewLedger(file, ledger) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(ledger, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncDirectory(path.dirname(file));
}

function updateLedger(file, ledger) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(ledger, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  syncDirectory(directory);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readHashedEvidence(file, expectedSha256, label, parseJson = false) {
  if (typeof file !== "string" || !path.isAbsolute(file) ||
      !file.startsWith(`${TEMP_ROOT}${path.sep}`) || !/^[a-f0-9]{64}$/.test(expectedSha256 || "")) {
    throw new TypeError(`${label} must be hash-pinned evidence under /tmp/opencode`);
  }
  const absolute = path.resolve(file);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute || stat.size > 16 * 1024 * 1024) {
    throw new TypeError(`${label} must be a bounded regular evidence file`);
  }
  const bytes = fs.readFileSync(absolute);
  if (sha256(bytes) !== expectedSha256) throw new TypeError(`${label} SHA256 mismatch`);
  return parseJson ? JSON.parse(bytes.toString("utf8")) : bytes;
}

function validateInitialStatus(status, authority) {
  object(status, "fmcad status receipt");
  const scope = object(status.isolatedScratch, "isolated scratch status");
  if (status.version !== 1 || status.build !== authority.buildHash || status.blocked !== false ||
      status.active !== false || status.clientId !== authority.clientId ||
      scope.epochId !== authority.epochId || scope.admission !== "qualified-fresh-scratch-only") {
    throw new TypeError("Current public fmcad status does not prove the exact granted client, build and scratch epoch");
  }
  exactKeys(scope.document, ["name", "creationId", "fileId"], "Status scratch document");
  if (canonical(scope.document) !== canonical(authority.document)) {
    throw new TypeError("Current public fmcad status is not bound to the exact created scratch");
  }
  if (authority.runtimeUpgrade && status.sourceCommit !== authority.sourceCommit) {
    throw new TypeError("Current public fmcad status does not confirm the source pinned by the runtime-upgrade receipt");
  }
}

function validatedInvocation(services, authority, operation, data, purpose) {
  const invocation = {
    version: 1,
    kind: "cad",
    operation,
    data,
    doc: authority.document.name,
    docId: authority.document.creationId,
    purpose,
  };
  const validated = services.query.validate(invocation);
  exactKeys(validated, ["version", "kind", "operation", "data", "doc", "docId", "purpose"],
    `Validated ${operation} invocation`);
  if (validated.version !== 1 || validated.kind !== "cad" || validated.operation !== operation ||
      validated.doc !== authority.document.name || validated.docId !== authority.document.creationId ||
      validated.docFileId !== undefined || validated.projectId !== undefined ||
      canonical(validated.data) !== canonical(data)) {
    throw new TypeError(`Public catalog validation changed or widened the pinned ${operation} invocation`);
  }
  return validated;
}

function payloadFromReceipt(receipt, operation, authority) {
  object(receipt, `${operation} execution receipt`);
  if (receipt.version !== 1 || typeof receipt.requestId !== "string" ||
      receipt.state !== "succeeded" || receipt.jobId === null || typeof receipt.jobId !== "string" ||
      !receipt.jobId || !receipt.result || typeof receipt.result !== "object" || Array.isArray(receipt.result)) {
    throw new Error(`${operation} did not return a successful terminal typed execution receipt`);
  }
  const envelope = receipt.result;
  if (envelope.success !== true || envelope.operation !== operation || envelope.document !== authority.document.name ||
      !envelope.result || typeof envelope.result !== "object" || Array.isArray(envelope.result)) {
    throw new Error(`${operation} result envelope does not match the exact f708 operation/document contract`);
  }
  return envelope.result;
}

function validateReceiptIdentity(receipt, requestId, jobId, sequenceId) {
  object(receipt, "Queue result receipt");
  if (receipt.version !== 1 || receipt.requestId !== requestId || receipt.jobId !== jobId ||
      typeof receipt.state !== "string" ||
      (sequenceId !== null && receipt.sequenceId !== sequenceId)) {
    throw new Error("Public queue result receipt changed request, job or sequence identity");
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function sameJobReadHistory() {
  return { attempts: 0, firstError: null, lastError: null };
}

function sameJobReadDeadlineError(history) {
  const error = new Error("Same-job query.result did not stabilize before the bounded deadline");
  error.code = "SAME_JOB_RESULT_UNAVAILABLE";
  error.readErrorProof = { ...history };
  return error;
}

async function readSameJobResult(services, jobId, deadline, pollIntervalMs, history) {
  for (;;) {
    if (history.attempts > 0 && Date.now() >= deadline) {
      throw sameJobReadDeadlineError(history);
    }
    try {
      const receipt = await services.query.result(jobId);
      if (!receipt) {
        const error = new Error("Public query.result returned no receipt for the owned job");
        error.code = "SAME_JOB_RESULT_NOT_FOUND";
        throw error;
      }
      return receipt;
    } catch (error) {
      const proof = exceptionProof(error);
      history.attempts += 1;
      history.firstError ??= proof;
      history.lastError = proof;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw sameJobReadDeadlineError(history);
      await sleep(Math.max(1, Math.min(pollIntervalMs, remaining)));
    }
  }
}

function exceptionProof(error) {
  const message = typeof error?.message === "string" ? error.message : String(error);
  return {
    name: typeof error?.name === "string" ? error.name : "Error",
    code: typeof error?.code === "string" ? error.code : null,
    messageSha256: crypto.createHash("sha256").update(message).digest("hex"),
  };
}

async function terminalReceipt(services, initial, requestId, sequenceId, options,
  readHistory = sameJobReadHistory()) {
  let receipt = initial;
  if (receipt.requestId !== requestId || receipt.version !== 1 || !receipt.jobId ||
      typeof receipt.jobId !== "string") {
    throw new Error("Execute acknowledgement omitted the exact owned job/request receipt");
  }
  const jobId = receipt.jobId;
  const deadline = Date.now() + options.operationTimeoutMs;
  for (;;) {
    validateReceiptIdentity(receipt, requestId, jobId, sequenceId);
    if (TERMINAL.has(receipt.state)) {
      if (receipt.state === "succeeded" && receipt.result == null) {
        receipt = await readSameJobResult(services, jobId, deadline, options.pollIntervalMs, readHistory);
      }
      validateReceiptIdentity(receipt, requestId, jobId, sequenceId);
      if (receipt.state === "succeeded" && receipt.result == null) {
        throw new Error("Terminal execute receipt omitted its owned result payload");
      }
      return receipt;
    }
    if (receipt.state === "needs_reconciliation") throw new Error("Queue outcome needs owner reconciliation; no retry or cleanup is permitted");
    if (Date.now() >= deadline) throw new Error("Typed operation did not reach a terminal result before the bounded wait expired");
    await sleep(options.pollIntervalMs);
    receipt = await readSameJobResult(services, jobId, deadline, options.pollIntervalMs, readHistory);
  }
}

async function waitForSequenceReceipt(services, initial, requestId, jobId, options, recordReceipt) {
  let receipt = initial;
  let resultReads = 0;
  const deadline = Date.now() + options.operationTimeoutMs;
  const readHistory = sameJobReadHistory();
  for (;;) {
    try { validateReceiptIdentity(receipt, requestId, jobId, null); }
    catch (error) {
      return { status: "unknown", receipt, reason: String(error?.message || error) };
    }
    if (validToken(receipt.sequenceId)) {
      return { status: "ready", receipt, sequenceId: receipt.sequenceId,
        ...(readHistory.attempts ? { readErrorProof: { ...readHistory } } : {}) };
    }
    if (resultReads > 0) {
      if (TERMINAL.has(receipt.state)) {
        return receipt.state === "succeeded"
          ? { status: "unknown", receipt, reason: "Terminal success omitted the exclusive sequenceId",
            ...(readHistory.attempts ? { readErrorProof: { ...readHistory } } : {}) }
          : { status: "failed", receipt, reason: `Typed operation reached terminal ${receipt.state} without a sequenceId`,
            ...(readHistory.attempts ? { readErrorProof: { ...readHistory } } : {}) };
      }
      if (receipt.state === "needs_reconciliation" || !SEQUENCE_PENDING.has(receipt.state)) {
        return { status: "unknown", receipt, reason: `Sequence ID is unavailable in queue state ${receipt.state}`,
          ...(readHistory.attempts ? { readErrorProof: { ...readHistory } } : {}) };
      }
      if (Date.now() >= deadline) {
        return { status: "unknown", receipt, reason: "Sequence ID was not assigned before the bounded same-job wait expired",
          ...(readHistory.attempts ? { readErrorProof: { ...readHistory } } : {}) };
      }
      await sleep(options.pollIntervalMs);
      if (Date.now() >= deadline) {
        return { status: "unknown", receipt, reason: "Sequence ID was not assigned before the bounded same-job wait expired",
          ...(readHistory.attempts ? { readErrorProof: { ...readHistory } } : {}) };
      }
    } else if (Date.now() >= deadline) {
      return { status: "unknown", receipt, reason: "Sequence ID was not assigned before the bounded same-job wait expired" };
    }
    try {
      receipt = await readSameJobResult(services, jobId, deadline, options.pollIntervalMs, readHistory);
      resultReads += 1;
      recordReceipt(receipt);
    } catch (error) {
      return { status: "unknown", receipt,
        reason: "Same-job sequence receipt did not stabilize before the bounded deadline",
        readErrorProof: error.readErrorProof || { ...readHistory } };
    }
  }
}

async function dispatch(services, authority, ledger, file, phase, operation, data, options, sequence) {
  const requestId = options.requestIds[phase];
  const invocation = validatedInvocation(services, authority, operation, data,
    `qualified first-smoke epoch ${authority.epochId}: ${phase}`);
  const executeOptions = {
    requestId,
    sessionId: options.sessionId,
    sequence,
    queueTimeoutMs: options.queueTimeoutMs,
    ...(phase === SEQUENCE_PHASES[0] && options.expectedRevision !== undefined
      ? { expectedRevision: options.expectedRevision } : {}),
  };
  ledger.currentPhase = phase;
  ledger.state = "dispatching";
  ledger.steps.push({ phase, operation, requestId, jobId: null, state: "dispatching" });
  updateLedger(file, ledger);

  let accepted;
  let executeError = null;
  try {
    accepted = await services.execute(invocation, executeOptions);
  } catch (error) {
    executeError = exceptionProof(error);
    ledger.state = "recovering-acknowledgement";
    ledger.lastExecuteError = executeError;
    ledger.lastError = "Execute acknowledgement failed; checking only the same request";
    updateLedger(file, ledger);
    try {
      accepted = await services.query.request(requestId);
    } catch (readError) {
      const requestLookupError = exceptionProof(readError);
      ledger.state = "unknown";
      ledger.lastRequestLookupError = requestLookupError;
      ledger.lastError = "Execute acknowledgement and same-request lookup failed; no replay was sent";
      updateLedger(file, ledger);
      return { status: "unknown", phase, requestId, executeError,
        requestLookupError, reason: ledger.lastError };
    }
    if (!accepted) {
      ledger.state = "unknown";
      ledger.lastRequestLookup = { requestId, result: "not_found" };
      ledger.lastError = "No owned request receipt is visible; the operation was not resubmitted";
      updateLedger(file, ledger);
      return { status: "unknown", phase, requestId, executeError,
        requestLookup: ledger.lastRequestLookup, reason: ledger.lastError };
    }
  }

  if (accepted?.requestId !== requestId || accepted?.version !== 1 || !accepted.jobId) {
    ledger.state = "unknown";
    ledger.lastError = "Execute/recovered receipt omitted exact version, requestId or jobId";
    updateLedger(file, ledger);
    return { status: "unknown", phase, requestId, reason: ledger.lastError };
  }
  const jobId = accepted.jobId;
  let actualSequenceId = accepted.sequenceId ?? null;
  const step = ledger.steps.at(-1);
  step.jobId = jobId;
  step.sequenceId = actualSequenceId;
  step.receipt = accepted;
  if (executeError) {
    step.executeError = executeError;
    step.acknowledgementRecoveredBy = "same-request";
  }
  updateLedger(file, ledger);
  if (sequence.action === "begin" && !validToken(actualSequenceId)) {
    ledger.state = "waiting-for-sequence-id";
    updateLedger(file, ledger);
  }
  if (!validToken(actualSequenceId)) {
    const sequenceRead = await waitForSequenceReceipt(services, accepted, requestId, jobId, options, (receipt) => {
      step.sequenceId = receipt?.sequenceId ?? null;
      step.receipt = receipt;
      updateLedger(file, ledger);
    });
    accepted = sequenceRead.receipt;
    actualSequenceId = sequenceRead.sequenceId ?? null;
    if (sequenceRead.status !== "ready") {
      step.state = sequenceRead.status === "failed" ? sequenceRead.receipt.state : "unknown";
      ledger.state = sequenceRead.status === "failed" ? "failed" : "unknown";
      if (sequenceRead.status === "failed") ledger.currentPhase = null;
      ledger.lastError = sequenceRead.reason;
      if (sequenceRead.readErrorProof) {
        step.sameJobReadErrorProof = sequenceRead.readErrorProof;
        ledger.lastSameJobReadErrorProof = sequenceRead.readErrorProof;
      }
      updateLedger(file, ledger);
      return { status: sequenceRead.status, phase, requestId, jobId, receipt: accepted, reason: ledger.lastError };
    }
    if (sequenceRead.readErrorProof) {
      step.sameJobReadErrorProof = sequenceRead.readErrorProof;
      ledger.lastSameJobReadErrorProof = sequenceRead.readErrorProof;
      updateLedger(file, ledger);
    }
  }
  if (sequence.action === "begin") {
    if (ledger.sequenceId !== null && ledger.sequenceId !== undefined && ledger.sequenceId !== actualSequenceId) {
      ledger.state = "unknown";
      ledger.lastError = "Exclusive sequenceId changed after being bound to the first-smoke ledger";
      updateLedger(file, ledger);
      return { status: "unknown", phase, requestId, jobId, receipt: accepted, reason: ledger.lastError };
    }
    ledger.sequenceId = actualSequenceId;
  } else if (actualSequenceId !== sequence.id || ledger.sequenceId !== sequence.id) {
    ledger.state = "unknown";
    ledger.lastError = "Queue receipt does not match the existing exclusive sequenceId";
    updateLedger(file, ledger);
    return { status: "unknown", phase, requestId, jobId, reason: ledger.lastError };
  }
  step.jobId = jobId;
  step.sequenceId = actualSequenceId;
  updateLedger(file, ledger);

  let terminal;
  const terminalReadHistory = sameJobReadHistory();
  try {
    terminal = await terminalReceipt(services, accepted, requestId,
      sequence.action === "begin" ? actualSequenceId : sequence.id, options, terminalReadHistory);
  } catch (error) {
    ledger.state = "unknown";
    step.state = "unknown";
    step.receipt = accepted;
    ledger.lastError = "Terminal result did not stabilize within its bounded read window; no later operations or cleanup were sent";
    const readErrorProof = error.readErrorProof || (terminalReadHistory.attempts
      ? { ...terminalReadHistory } : null);
    if (readErrorProof) {
      step.sameJobReadErrorProof = readErrorProof;
      ledger.lastSameJobReadErrorProof = readErrorProof;
    } else {
      ledger.lastTerminalErrorProof = exceptionProof(error);
    }
    updateLedger(file, ledger);
    return { status: "unknown", phase, requestId, jobId,
      ...(readErrorProof ? { readErrorProof } : { terminalErrorProof: ledger.lastTerminalErrorProof }),
      reason: ledger.lastError };
  }
  ledger.steps.at(-1).state = terminal.state;
  ledger.steps.at(-1).receipt = terminal;
  if (terminalReadHistory.attempts) {
    ledger.steps.at(-1).sameJobReadErrorProof = { ...terminalReadHistory };
    ledger.lastSameJobReadErrorProof = { ...terminalReadHistory };
  }
  ledger.currentPhase = null;
  updateLedger(file, ledger);
  if (terminal.state !== "succeeded") {
    ledger.state = "failed";
    updateLedger(file, ledger);
    return { status: "failed", phase, requestId, jobId, receipt: terminal,
      reason: `Typed operation reached terminal state ${terminal.state}; later operations and cleanup were not sent` };
  }
  try {
    return { status: "succeeded", phase, requestId, jobId,
      receipt: terminal, payload: payloadFromReceipt(terminal, operation, authority),
      sequenceId: actualSequenceId };
  } catch (error) {
    ledger.state = "failed";
    ledger.lastError = String(error?.message || error);
    updateLedger(file, ledger);
    return { status: "failed", phase, requestId, jobId, receipt: terminal, reason: ledger.lastError };
  }
}

function finiteVector(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error(`${label} must be a finite three-coordinate vector`);
  }
  return value;
}

function requireBodyBounds(body) {
  if (body.isSolid !== true || !body.boundingBox || body.boundingBox.units !== "cm") {
    throw new Error("Entity inspection did not prove a solid body with native centimeter bounds");
  }
  const minimum = finiteVector(body.boundingBox.min, "Body bounds minimum");
  const maximum = finiteVector(body.boundingBox.max, "Body bounds maximum");
  const spans = maximum.map((value, index) => value - minimum[index]);
  const expected = [1, 0.6, 0.4];
  if (spans.some((value, index) => Math.abs(value - expected[index]) > 0.0001)) {
    throw new Error("Native body bounds do not match the expected 10 x 6 x 4 mm prism");
  }
  return { minimum, maximum, spans, units: "cm" };
}

function successfulClose(receipt, authority, requestId) {
  if (!receipt || receipt.status !== "complete" || receipt.requestId !== requestId ||
      receipt.clientId !== authority.ownerClientId || receipt.jobId !== authority.ownerJobs.targetJobId ||
      receipt.observationJobId !== authority.ownerJobs.observationJobId ||
      receipt.kind !== "isolated-scratch-close" ||
      receipt.sdkRequestsSent !== 1 ||
      receipt.activation?.epochId !== authority.epochId || receipt.activation?.admission !== "closed" ||
      receipt.activation?.historicalOutcome !== "unknown") return false;
  try { exactKeys(receipt.activation.document, ["name", "creationId", "fileId"], "Closed scratch document"); }
  catch { return false; }
  return canonical(receipt.activation.document) === canonical(authority.document);
}

function stoppedDispatch(result, file) {
  return { ...result, status: result.status === "unknown" ? "NOTRUN" : "FAIL",
    executionStatus: result.status, ledger: file };
}

function recoverFirstSketch(ledger, input, authority, requestIds, recovery) {
  exactKeys(recovery, ["requestReceipt", "resultReceipt"], "Same-job first-sketch recovery");
  const requestId = requestIds.sketchCreate;
  const requestReceipt = recovery.requestReceipt;
  const resultReceipt = recovery.resultReceipt;
  const jobId = resultReceipt?.jobId;
  const sequenceId = resultReceipt?.sequenceId;
  if (!validToken(jobId) || !validToken(sequenceId)) {
    throw new TypeError("Same-job recovery omitted the accepted job or exclusive sequence ID");
  }
  for (const receipt of [requestReceipt, resultReceipt]) {
    validateReceiptIdentity(receipt, requestId, jobId, sequenceId);
    if (receipt.state !== "succeeded" || receipt.sequenceState !== "held" ||
        receipt.outcome?.requestId !== requestId || receipt.outcome?.jobId !== jobId ||
        receipt.outcome?.acceptance !== "accepted" || receipt.outcome?.executionOutcome !== "succeeded" ||
        receipt.outcome?.mayHaveMutated !== true) {
      throw new TypeError("Same-job recovery must contain matching terminal successful receipts with a held sequence");
    }
    payloadFromReceipt(receipt, "sketch.create", authority);
  }
  if (canonical(requestReceipt.result) !== canonical(resultReceipt.result) ||
      canonical(requestReceipt.outcome) !== canonical(resultReceipt.outcome)) {
    throw new TypeError("Same-request and same-job readbacks disagree on the terminal sketch result");
  }

  const expectedAuthority = {
    sourceCommit: authority.sourceCommit,
    buildHash: authority.buildHash,
    factsRequestId: authority.factsRequestId,
    ownerJobs: authority.ownerJobs,
    creationReceipt: { requestId: input.authority.creation.requestId,
      epochId: authority.epochId, jobId: input.authority.creation.jobId },
    grant: { clientId: authority.clientId, epochId: authority.epochId },
    ...(authority.runtimeUpgrade ? { runtimeUpgrade: authority.runtimeUpgrade } : {}),
  };
  const step = ledger.steps?.[0];
  if (ledger.schemaVersion !== 1 || ledger.kind !== "f708-isolated-first-smoke" ||
      ledger.runId !== input.runId || ledger.clientId !== authority.clientId || ledger.epochId !== authority.epochId ||
      canonical(ledger.document) !== canonical(authority.document) ||
      canonical(ledger.authority) !== canonical(expectedAuthority) || canonical(ledger.operations) !== canonical(OPERATIONS) ||
      ledger.state !== "unknown" || ledger.currentPhase !== "sketchCreate" || ledger.sequenceId !== sequenceId ||
      ledger.steps.length !== 1 || step?.phase !== "sketchCreate" || step.operation !== "sketch.create" ||
      step.requestId !== requestId || step.jobId !== jobId || step.sequenceId !== sequenceId || step.state !== "dispatching") {
    throw new TypeError("Existing ledger is not the exact interrupted first sketch for this run and authority");
  }
  if (step.receipt?.requestId !== requestId || step.receipt?.jobId !== jobId ||
      step.receipt?.sequenceId !== sequenceId || TERMINAL.has(step.receipt?.state)) {
    throw new TypeError("Existing ledger receipt does not match the same still-unresolved first sketch job");
  }
  const sketch = payloadFromReceipt(resultReceipt, "sketch.create", authority).sketch;
  if (!sketch || typeof sketch !== "object" || Array.isArray(sketch) ||
      !validToken(sketch.token) || sketch.kind !== "sketch") {
    throw new TypeError("Terminal same-job receipt does not contain the exact native sketch reference");
  }

  step.state = "succeeded";
  step.receipt = resultReceipt;
  ledger.sequenceId = sequenceId;
  ledger.currentPhase = null;
  ledger.recovery = {
    kind: "terminal-same-job-readback-before-continuation",
    requestId,
    jobId,
    sequenceId,
    requestReceipt,
    resultReceipt,
  };
  ledger.state = "recovered-first-operation-awaiting-continuation";
  return { sequenceId, sketch };
}

function validateGeometryContinuation(input, authority, requestIds, cleanupRequestId, continuation) {
  exactKeys(continuation, ["decisionPath", "decisionSha256", "priorSketchReadback",
    "oldGeometryReadback", "priorFailureEvidence"], "Existing-sketch geometry continuation");
  exactKeys(continuation.priorFailureEvidence, ["report", "sameRequestReadback",
    "sameRequestFollowup", "publicStatusReadback"], "Prior failure evidence");
  for (const evidence of Object.values(continuation.priorFailureEvidence)) {
    exactKeys(evidence, ["path", "sha256"], "Prior failure evidence file");
    readHashedEvidence(evidence.path, evidence.sha256, "Prior failure evidence");
  }
  exactKeys(continuation.priorSketchReadback, ["clientId", "sessionId", "requestWasNull",
    "evidencePath", "evidenceSha256", "requestReceipt", "resultReceipt"],
    "Fresh owned predecessor sketch readback");
  exactKeys(continuation.oldGeometryReadback, ["clientId", "sessionId", "requestId", "receipt",
    "evidencePath", "evidenceSha256"],
    "Fresh consumed geometry request readback");
  const priorSketchReadbackEvidence = JSON.parse(readHashedEvidence(continuation.priorSketchReadback.evidencePath,
    continuation.priorSketchReadback.evidenceSha256, "Fresh predecessor sketch readback").toString("utf8"));
  const oldGeometryReadbackEvidence = JSON.parse(readHashedEvidence(continuation.oldGeometryReadback.evidencePath,
    continuation.oldGeometryReadback.evidenceSha256, "Fresh consumed geometry request readback").toString("utf8"));
  if (!/^[a-f0-9]{64}$/.test(continuation.decisionSha256 || "")) {
    throw new TypeError("Continuation decision must have an exact SHA256 pin");
  }
  const decision = readHashedEvidence(continuation.decisionPath, continuation.decisionSha256,
    "Sol continuation decision", true);
  const decisionContinuation = decision.continuation;
  const genesisPlan = readHashedEvidence(decision.genesisPlan?.path, decision.genesisPlan?.sha256,
    "Original first-smoke plan", true);
  const parityQualification = readHashedEvidence(decision.parityQualification?.path,
    decision.parityQualification?.sha256, "Installed public API parity qualification", true);
  const proof = readHashedEvidence(decision.preAcceptanceProof?.path,
    decision.preAcceptanceProof?.sha256, "Pre-acceptance SDK-zero proof", true);
  const priorBytes = readHashedEvidence(decision.predecessorLedger?.path,
    decision.predecessorLedger?.sha256, "Predecessor ledger");
  const priorLedger = JSON.parse(priorBytes.toString("utf8"));
  const requestId = requestIds.sketchCreate;
  const geometryRequestId = requestIds.sketchGeometry;
  const oldGeometryRequestId = decision.consumedGeometryRequestId;
  const priorCreate = priorLedger.steps?.[0];
  const priorGeometry = priorLedger.steps?.[1];
  const continuationIds = decisionContinuation?.requestIds;
  if (decision.version !== 1 || decision.kind !== "explicit-existing-sketch-geometry-continuation" ||
      decision.clientId !== authority.clientId || decision.operatorSessionId !== input.sessionId ||
      decision.runtime?.sourceCommit !== authority.sourceCommit ||
      decision.runtime?.buildHash !== authority.buildHash || decision.epochId !== authority.epochId ||
      canonical(decision.document) !== canonical(authority.document) ||
      genesisPlan.attempt?.runId !== priorLedger.runId ||
      genesisPlan.attempt?.requestIds?.sketchCreate !== priorCreate?.requestId ||
      genesisPlan.attempt?.requestIds?.sketchGeometry !== oldGeometryRequestId ||
      genesisPlan.attempt?.evidenceDir === decisionContinuation?.evidenceDir ||
      decisionContinuation?.runId !== input.runId || decisionContinuation?.evidenceDir !== input.evidenceDir ||
      input.runId !== `${genesisPlan.attempt?.runId}-after-idle-v1` ||
      geometryRequestId !== `${oldGeometryRequestId}-after-idle-v1` ||
      decisionContinuation?.firstOperation !== "sketch.geometry" ||
      decisionContinuation?.firstSequence?.action !== "begin" ||
      decisionContinuation?.firstSequence?.mode !== "exclusive" ||
      decisionContinuation?.createSketchPermitted !== false ||
      decision.cleanup?.ownerOnly !== true || decision.cleanup?.requestId !== cleanupRequestId ||
      decision.runtimeDeploymentRequired !== false || decision.additionalGrantRequired !== false ||
      decision.actualGeometryPass !== false || decision.predecessorLedger?.mustRemainUnchanged !== true ||
      decision.predecessorSketchJobId !== priorCreate?.jobId || decision.expiredSequenceId !== priorLedger.sequenceId ||
      decisionContinuation?.requestIds?.sketchGeometry !== geometryRequestId ||
      geometryRequestId === oldGeometryRequestId || !validToken(oldGeometryRequestId)) {
    throw new TypeError("Sol decision does not authorize this exact same-client, same-document geometry re-begin");
  }
  exactKeys(continuationIds, ["sketchGeometry", "sketchInspect", "extrude", "bodyInspect", "volume"],
    "Continuation request IDs");
  for (const phase of ["sketchGeometry", "sketchInspect", "extrude", "bodyInspect", "volume"]) {
    if (continuationIds[phase] !== requestIds[phase]) {
      throw new TypeError(`Continuation ${phase} requestId differs from the hash-bound Sol decision`);
    }
  }
  for (const phase of ["sketchInspect", "extrude", "bodyInspect", "volume"]) {
    if (continuationIds[phase] !== genesisPlan.attempt.requestIds[phase]) {
      throw new TypeError(`Continuation ${phase} must retain its unused original prepared requestId`);
    }
  }
  if (requestId !== priorCreate?.requestId || continuationIds.sketchGeometry !== geometryRequestId) {
    throw new TypeError("Continuation must retain the successful sketch ID and use the explicitly authorized new geometry ID");
  }
  if (parityQualification.kind !== "sequence-admission-parity-qualification" ||
      parityQualification.tests?.passed !== 3 || parityQualification.tests?.failed !== 0 ||
      parityQualification.tests?.physicalSendCalls !== 0 ||
      parityQualification.tests?.installedPublicApiThroughIsolatedIpc !== true ||
      parityQualification.runtimeChanged !== false || parityQualification.deploymentRequired !== false) {
    throw new TypeError("Installed public API continuation qualification is not the exact SDK-zero 3/3 record");
  }
  const retainedPayload = proof.existingEvidence?.find(row => row?.path?.includes("/queue/accepted/") &&
    row.path.endsWith(`/${row.sha256}`));
  const admissionMarker = proof.existingEvidence?.find(row => row?.path?.includes("/queue/admissions/") &&
    row.path.endsWith(`/${row.sha256}`));
  if (decision.classification?.geometryAccepted !== false || decision.classification?.geometrySdkDispatch !== false ||
      decision.classification?.noSyntheticTerminalJobReceipt !== true ||
      decision.classification?.lostOriginalExceptionBytesRecovered !== false ||
      proof.kind !== "read-only-step2-admission-diagnosis" || proof.requestId !== oldGeometryRequestId ||
      proof.clientId !== authority.clientId || proof.sourceCommit !== authority.sourceCommit ||
      proof.buildHash !== authority.buildHash || proof.epochId !== authority.epochId ||
      canonical(proof.document) !== canonical(authority.document) ||
      proof.originalSketch?.jobId !== decision.predecessorSketchJobId ||
      proof.originalSketch?.sequenceId !== decision.expiredSequenceId || proof.originalSketch?.state !== "succeeded" ||
      proof.reproduction?.jobAllocated !== false || proof.current?.jobCount !== 3 ||
      proof.current?.lease !== null || proof.current?.active !== null || proof.current?.blocked !== null ||
      !(proof.admissionDelayAfterSketchMs > proof.idleMs) || !retainedPayload || !admissionMarker ||
      !/^[a-f0-9]{64}$/.test(continuation.decisionSha256) ||
      !/^[a-f0-9]{64}$/.test(decision.predecessorLedger.sha256) ||
      !/^[a-f0-9]{64}$/.test(continuation.oldGeometryReadback.evidenceSha256) ||
      Object.values(continuation.priorFailureEvidence).some(item => !/^[a-f0-9]{64}$/.test(item.sha256 || ""))) {
    throw new TypeError("Continuation decision/proof does not prove the exact pre-acceptance SDK-zero rejection");
  }
  if (continuation.priorSketchReadback.clientId !== authority.clientId ||
      continuation.priorSketchReadback.sessionId !== input.sessionId ||
      priorSketchReadbackEvidence.kind !== "fresh-owned-predecessor-sketch-readback" ||
      priorSketchReadbackEvidence.identity?.clientId !== authority.clientId ||
      priorSketchReadbackEvidence.identity?.sessionId !== input.sessionId ||
      priorSketchReadbackEvidence.requestWasNull !== continuation.priorSketchReadback.requestWasNull ||
      (continuation.priorSketchReadback.requestWasNull
        ? continuation.priorSketchReadback.requestReceipt !== null
        : !["preparing", "queued", "running", "sending", "succeeded"]
          .includes(continuation.priorSketchReadback.requestReceipt?.state)) ||
      priorSketchReadbackEvidence.result?.state !== "succeeded" ||
      continuation.oldGeometryReadback.clientId !== authority.clientId ||
      continuation.oldGeometryReadback.sessionId !== input.sessionId ||
      continuation.oldGeometryReadback.requestId !== oldGeometryRequestId ||
      continuation.oldGeometryReadback.receipt !== null ||
      oldGeometryReadbackEvidence.kind !== "allowlisted-same-client-sketchGeometry-status-and-request-readback" ||
      oldGeometryReadbackEvidence.identity?.clientId !== authority.clientId ||
      oldGeometryReadbackEvidence.identity?.sessionId !== input.sessionId ||
      oldGeometryReadbackEvidence.requestId !== oldGeometryRequestId ||
      oldGeometryReadbackEvidence.requestWasNull !== true ||
      oldGeometryReadbackEvidence.resultQueryPerformed !== false) {
    throw new TypeError("Fresh preflight reads do not prove the same owned sketch and absent consumed geometry receipt");
  }

  if (priorLedger.kind !== "f708-isolated-first-smoke" ||
      priorLedger.clientId !== authority.clientId || priorLedger.epochId !== authority.epochId ||
      canonical(priorLedger.document) !== canonical(authority.document) ||
      priorLedger.authority?.sourceCommit !== authority.sourceCommit ||
      priorLedger.authority?.buildHash !== authority.buildHash || priorLedger.state !== "unknown" ||
      priorLedger.currentPhase !== "sketchGeometry" || priorLedger.sequenceId !== decision.expiredSequenceId ||
      priorCreate?.phase !== "sketchCreate" || priorCreate.jobId !== decision.predecessorSketchJobId ||
      priorCreate.state !== "succeeded" || priorCreate.sequenceId !== decision.expiredSequenceId ||
      priorGeometry?.phase !== "sketchGeometry" || priorGeometry.requestId !== oldGeometryRequestId ||
      priorGeometry.jobId !== null || priorGeometry.state !== "dispatching") {
    throw new TypeError("Predecessor ledger is not the exact successful-sketch/pre-acceptance-geometry state");
  }
  const priorSketchReceipt = priorCreate.receipt;
  if (!priorSketchReceipt || priorSketchReceipt.result == null || priorSketchReceipt.state !== "succeeded" ||
      priorSketchReceipt.sequenceState !== "held" ||
      priorSketchReceipt.outcome?.executionOutcome !== "succeeded") {
    throw new TypeError("Predecessor ledger does not preserve the terminal successful sketch result");
  }

  const requestReceipt = continuation.priorSketchReadback.requestReceipt;
  const resultReceipt = continuation.priorSketchReadback.resultReceipt;
  validateReceiptIdentity(resultReceipt, priorCreate.requestId, priorCreate.jobId, decision.expiredSequenceId);
  if (resultReceipt.state !== "succeeded" || resultReceipt.sequenceState !== "held" ||
      resultReceipt.outcome?.executionOutcome !== "succeeded" || resultReceipt.outcome?.mayHaveMutated !== true) {
    throw new TypeError("Fresh predecessor job read is not the exact terminal successful sketch result");
  }
  payloadFromReceipt(resultReceipt, "sketch.create", authority);
  if (requestReceipt) {
    validateReceiptIdentity(requestReceipt, priorCreate.requestId, priorCreate.jobId, decision.expiredSequenceId);
    if (!["preparing", "queued", "running", "sending", "succeeded"].includes(requestReceipt.state) ||
        requestReceipt.outcome?.requestId !== priorCreate.requestId ||
        requestReceipt.outcome?.jobId !== priorCreate.jobId || requestReceipt.outcome?.acceptance !== "accepted" ||
        (requestReceipt.result != null && canonical(requestReceipt.result) !== canonical(resultReceipt.result))) {
      throw new TypeError("Fresh predecessor request receipt conflicts with the successful same-job result");
    }
  }
  if (canonical(resultReceipt.result) !== canonical(priorSketchReceipt.result)) {
    throw new TypeError("Fresh predecessor sketch readback differs from the immutable successful predecessor ledger");
  }
  const sketch = payloadFromReceipt(resultReceipt, "sketch.create", authority).sketch;
  if (!sketch || sketch.kind !== "sketch" || !validToken(sketch.token) ||
      canonical(sketch) !== canonical(priorSketchReceipt.result.result.sketch)) {
    throw new TypeError("Fresh existing sketch differs from the immutable successful predecessor receipt");
  }
  const tokenSha256 = sha256(Buffer.from(sketch.token));
  const retainedPayloadSha256 = retainedPayload.sha256;
  const admissionSha256 = admissionMarker.sha256;
  return {
    sketch,
    priorSequenceId: decision.expiredSequenceId,
    ledgerContinuation: {
      kind: "expired-sequence-geometry-rebegin-v1",
      decisionSha256: continuation.decisionSha256,
      proofSha256: decision.preAcceptanceProof.sha256,
      retainedPayloadSha256,
      admissionSha256,
      priorRunId: priorLedger.runId,
      priorLedgerPath: decision.predecessorLedger.path,
      priorLedgerSha256: decision.predecessorLedger.sha256,
      priorSketchRequestId: priorCreate.requestId,
      priorSketchJobId: priorCreate.jobId,
      priorSketchSequenceId: decision.expiredSequenceId,
      priorSketchTokenSha256: tokenSha256,
      consumedGeometryRequestId: oldGeometryRequestId,
      newGeometryRequestId: geometryRequestId,
      oldGeometryReadbackSha256: continuation.oldGeometryReadback.evidenceSha256,
      previousFailureEvidence: Object.fromEntries(Object.entries(continuation.priorFailureEvidence)
        .map(([key, value]) => [key, value.sha256])),
      originalExceptionBytesRecovered: decision.classification?.lostOriginalExceptionBytesRecovered === true,
      sequenceAction: "begin",
      sequenceMode: "exclusive",
      newSketchCreated: false,
    },
    priorSketchStep: {
      phase: "sketchCreate", operation: "sketch.create", requestId: priorCreate.requestId,
      jobId: priorCreate.jobId, state: "succeeded", sequenceId: decision.expiredSequenceId,
      sequenceState: "held", receiptSha256: sha256(Buffer.from(canonical(resultReceipt))),
      resultSha256: sha256(Buffer.from(canonical(resultReceipt.result))), tokenSha256,
    },
  };
}

/**
 * Run the narrow f708 scratch smoke through an injected, already-started public
 * FmcadServices client. This function never starts/disposes that client. The
 * original CLI owner is separately injected for the supported one-shot close.
 */
async function executeFirstSmoke(input) {
  exactKeys(input, ["confirmFirstSmoke", "services", "authority", "ownerCleanup", "evidenceDir", "runId",
    "fixturePrefix", "requestIds", "cleanupRequestId", "queueTimeoutMs", "expectedRevision",
    "sessionId", "operationTimeoutMs", "pollIntervalMs", "recovery", "continuation"], "First-smoke input");
  if (input.confirmFirstSmoke !== true) throw new TypeError("confirmFirstSmoke: true is required for this exact scratch-only run");
  const authority = validateAuthority(input.authority);
  validateServices(input.services);
  if (typeof input.ownerCleanup?.closeIsolatedScratch !== "function" ||
      input.ownerCleanup.clientId !== authority.ownerClientId) {
    throw new TypeError("Scratch cleanup requires the original authenticated owner CLI port, not the granted modeling client");
  }
  const evidenceDir = privateEvidenceDirectory(input.evidenceDir);
  const runId = token(input.runId, "First-smoke runId");
  if (typeof input.fixturePrefix !== "string" || !/^[A-Z0-9]{8,24}$/.test(input.fixturePrefix)) {
    throw new TypeError("fixturePrefix must be unique uppercase alphanumeric text");
  }
  exactKeys(input.requestIds, SEQUENCE_PHASES, "First-smoke requestIds");
  const requestIds = Object.fromEntries(SEQUENCE_PHASES.map((phase) =>
    [phase, token(input.requestIds[phase], `${phase} requestId`)]));
  const cleanupRequestId = token(input.cleanupRequestId, "Owner cleanup requestId");
  const allRequestIds = [...Object.values(requestIds), cleanupRequestId];
  if (new Set(allRequestIds).size !== allRequestIds.length) throw new TypeError("All first-smoke request IDs must be distinct");
  if (input.recovery !== undefined && input.continuation !== undefined) {
    throw new TypeError("Only one bounded continuation mode may be supplied");
  }
  const geometryContinuation = input.continuation === undefined ? null
    : validateGeometryContinuation(input, authority, requestIds, cleanupRequestId, input.continuation);
  const queueTimeoutMs = input.queueTimeoutMs ?? 30000;
  const operationTimeoutMs = input.operationTimeoutMs ?? 300000;
  const pollIntervalMs = input.pollIntervalMs ?? 200;
  if (!Number.isSafeInteger(queueTimeoutMs) || queueTimeoutMs < 1 || queueTimeoutMs > 2147483647 ||
      !Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 300000 ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 50 || pollIntervalMs > 5000) {
    throw new TypeError("Invalid bounded queue timeout or result polling interval");
  }
  if (input.expectedRevision !== undefined &&
      (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision > 2147483647)) {
    throw new TypeError("expectedRevision must be a nonnegative 32-bit safe integer");
  }
  const sessionId = token(input.sessionId, "MCP sessionId");
  const options = { requestIds, queueTimeoutMs, operationTimeoutMs, pollIntervalMs,
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}), sessionId };
  const file = ledgerPath(evidenceDir, runId, authority.epochId);
  if (fs.existsSync(file) && input.recovery === undefined) {
    return { status: "NOTRUN", reason: "First-smoke ledger already exists; no resume or replay is allowed",
      reconciliationRequired: true, ledger: file };
  }
  if (!fs.existsSync(file) && input.recovery !== undefined) {
    return { status: "NOTRUN", reason: "Same-job recovery requires the existing first-smoke ledger; no new ledger or execute was sent" };
  }

  let before;
  try {
    before = await input.services.query.status();
    validateInitialStatus(before, authority);
    const catalog = input.services.query.catalog?.();
    if (!Array.isArray(catalog) || OPERATIONS.some((operation) => !catalog.some((row) => row.operation === operation))) {
      throw new TypeError("Qualified public catalog is missing a required first-smoke operation");
    }
  } catch (error) {
    return { status: "NOTRUN", reason: `Public client/epoch preflight failed: ${String(error?.message || error)}` };
  }

  let ledger;
  let recovered = null;
  if (input.recovery !== undefined) {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file ||
          (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
        throw new Error("Existing ledger must be an owned private regular file");
      }
      ledger = JSON.parse(fs.readFileSync(file, "utf8"));
      recovered = recoverFirstSketch(ledger, input, authority, requestIds, input.recovery);
      updateLedger(file, ledger);
    } catch (error) {
      return { status: "NOTRUN", reason: `Same-job recovery was not accepted; no later execute was sent: ${String(error?.message || error)}`,
        reconciliationRequired: true, ledger: file };
    }
  } else if (geometryContinuation) {
    ledger = {
      schemaVersion: 1,
      kind: "f708-isolated-first-smoke-continuation",
      runId,
      clientId: authority.clientId,
      epochId: authority.epochId,
      document: authority.document,
      authority: {
        sourceCommit: authority.sourceCommit,
        buildHash: authority.buildHash,
        factsRequestId: authority.factsRequestId,
        ownerJobs: authority.ownerJobs,
        creationReceipt: { requestId: input.authority.creation.requestId,
          epochId: authority.epochId, jobId: input.authority.creation.jobId },
        grant: { clientId: authority.clientId, epochId: authority.epochId },
        ...(authority.runtimeUpgrade ? { runtimeUpgrade: authority.runtimeUpgrade } : {}),
      },
      state: "preflight-passed",
      sequenceId: null,
      operations: OPERATIONS,
      steps: [geometryContinuation.priorSketchStep],
      continuation: geometryContinuation.ledgerContinuation,
    };
    recovered = { sequenceId: null, sketch: geometryContinuation.sketch };
    try {
      writeNewLedger(file, ledger);
    } catch (error) {
      return { status: "NOTRUN", reason: `Could not exclusively create the continuation ledger: ${String(error?.message || error)}` };
    }
  } else {
    ledger = {
      schemaVersion: 1,
      kind: "f708-isolated-first-smoke",
      runId,
      clientId: authority.clientId,
      epochId: authority.epochId,
      document: authority.document,
      authority: {
        sourceCommit: authority.sourceCommit,
        buildHash: authority.buildHash,
        factsRequestId: authority.factsRequestId,
        ownerJobs: authority.ownerJobs,
        creationReceipt: { requestId: input.authority.creation.requestId,
          epochId: authority.epochId, jobId: input.authority.creation.jobId },
        grant: { clientId: authority.clientId, epochId: authority.epochId },
        ...(authority.runtimeUpgrade ? { runtimeUpgrade: authority.runtimeUpgrade } : {}),
      },
      state: "preflight-passed",
      sequenceId: null,
      operations: OPERATIONS,
      steps: [],
    };
    try {
      writeNewLedger(file, ledger);
    } catch (error) {
      return { status: "NOTRUN", reason: `Could not exclusively create the private no-replay ledger: ${String(error?.message || error)}` };
    }
  }

  const prefix = input.fixturePrefix;
  const name = `${prefix}_Section`;
  const featureName = `${prefix}_Prism`;
  let sequenceId = recovered?.sequenceId || null;
  let profileRef;
  let bodyRef;
  const summaries = recovered ? { sketch: recovered.sketch } : {};

  if (!recovered) {
    const createdSketch = await dispatch(input.services, authority, ledger, file, "sketchCreate", "sketch.create",
      { name, plane: "XY" }, options, { action: "begin", mode: "exclusive" });
    if (createdSketch.status !== "succeeded") return stoppedDispatch(createdSketch, file);
    sequenceId = createdSketch.sequenceId;
    const sketch = createdSketch.payload.sketch;
    if (!sketch || typeof sketch !== "object" || Array.isArray(sketch) || !sketch.token || sketch.kind !== "sketch") {
      ledger.state = "failed";
      ledger.lastError = "sketch.create did not return the exact native sketch reference";
      updateLedger(file, ledger);
      return { status: "FAIL", phase: "sketchCreate", reason: ledger.lastError, ledger: file };
    }
    summaries.sketch = sketch;
  }

  const remaining = [
    ["sketchGeometry", "sketch.geometry", {
      sketch: summaries.sketch,
      inferencePolicy: "explicit",
      geometry: [{ type: "rectangle", name: `${prefix}_Rectangle`,
        start: ["0 mm", "0 mm", "0 mm"], end: ["10 mm", "6 mm", "0 mm"] }],
    }],
    ["sketchInspect", "sketch.inspect", { sketch: summaries.sketch }],
  ];
  for (const [phase, operation, data] of remaining) {
    const sequence = phase === "sketchGeometry" && geometryContinuation
      ? { action: "begin", mode: "exclusive" }
      : { action: "continue", id: sequenceId };
    const result = await dispatch(input.services, authority, ledger, file, phase, operation, data, options,
      sequence);
    if (result.status !== "succeeded") return stoppedDispatch(result, file);
    if (phase === "sketchGeometry") {
      sequenceId = result.sequenceId;
      const created = result.payload.refs?.[`${prefix}_Rectangle`];
      if (!Array.isArray(created) || created.length !== 4 ||
          created.some((reference) => !reference || reference.kind !== "SketchLine" || !reference.token)) {
        ledger.state = "failed";
        ledger.lastError = "sketch.geometry did not return the four exact native rectangle edge refs (SketchLine)";
        updateLedger(file, ledger);
        return { status: "FAIL", phase, reason: ledger.lastError, ledger: file };
      }
      summaries.rectangleEdges = created.length;
    } else if (phase === "sketchInspect") {
      const profiles = result.payload.profiles;
      if (!Array.isArray(profiles) || profiles.length !== 1 || profiles[0]?.loops !== 1 ||
          profiles[0]?.ref?.kind !== "profile" || profiles[0]?.ref?.index !== 0 ||
          canonical(profiles[0].ref.sketch) !== canonical(summaries.sketch)) {
        ledger.state = "failed";
        ledger.lastError = "Exact sketch inspection did not read back exactly one one-loop native profile";
        updateLedger(file, ledger);
        return { status: "FAIL", phase, reason: ledger.lastError, ledger: file };
      }
      profileRef = profiles[0].ref;
      summaries.profile = profileRef;
    }
  }

  const extruded = await dispatch(input.services, authority, ledger, file, "extrude", "model.extrude", {
    name: featureName,
    profile: profileRef,
    extent: "distance",
    distance: "4 mm",
    operation: "newBody",
  }, options, { action: "continue", id: sequenceId });
  if (extruded.status !== "succeeded") return stoppedDispatch(extruded, file);
  if (extruded.payload.healthState !== 0 || !Array.isArray(extruded.payload.bodies) || extruded.payload.bodies.length !== 1 ||
      !extruded.payload.bodies[0] || extruded.payload.bodies[0].kind !== "body" || !extruded.payload.bodies[0].token) {
    ledger.state = "failed";
    ledger.lastError = "Extrusion did not read back one healthy native solid body";
    updateLedger(file, ledger);
    return { status: "FAIL", phase: "extrude", reason: ledger.lastError, ledger: file };
  }
  bodyRef = extruded.payload.bodies[0];

  const bodyInspection = await dispatch(input.services, authority, ledger, file, "bodyInspect", "entity.inspect",
    { ref: bodyRef }, options, { action: "continue", id: sequenceId });
  if (bodyInspection.status !== "succeeded") return stoppedDispatch(bodyInspection, file);
  let bounds;
  try { bounds = requireBodyBounds(bodyInspection.payload); }
  catch (error) {
    ledger.state = "failed";
    ledger.lastError = String(error?.message || error);
    updateLedger(file, ledger);
    return { status: "FAIL", phase: "bodyInspect", reason: ledger.lastError, ledger: file };
  }

  const measured = await dispatch(input.services, authority, ledger, file, "volume", "measure.volume",
    { ref: bodyRef, units: "mm3" }, options, { action: "end", id: sequenceId });
  if (measured.status !== "succeeded") return stoppedDispatch(measured, file);
  const volume = measured.payload;
  if (measured.receipt.sequenceState !== "ended" || volume.dimension !== "volume" || volume.units !== "mm3" || !Number.isFinite(volume.value) ||
      Math.abs(volume.value - 240) > 0.01) {
    ledger.state = "failed";
    ledger.lastError = "Native body volume does not match the expected 240 mm3 prism";
    updateLedger(file, ledger);
    return { status: "FAIL", phase: "volume", reason: ledger.lastError, ledger: file };
  }

  ledger.state = "native-smoke-passed-awaiting-owner-cleanup";
  ledger.geometry = { bounds, volume: { value: volume.value, units: volume.units },
    sketchProfileCount: 1, bodyCount: extruded.payload.bodies.length, bodyHealthState: extruded.payload.healthState };
  updateLedger(file, ledger);

  ledger.state = "owner-cleanup-dispatching";
  ledger.cleanup = { requestId: cleanupRequestId, state: "dispatching" };
  updateLedger(file, ledger);
  let cleanup;
  try {
    cleanup = await input.ownerCleanup.closeIsolatedScratch({
      targetJobId: authority.ownerJobs.targetJobId,
      observationJobId: authority.ownerJobs.observationJobId,
      requestId: cleanupRequestId,
      epochId: authority.epochId,
      document: authority.document,
    });
  } catch (error) {
    ledger.state = "unknown";
    ledger.cleanup.state = "unknown";
    ledger.lastError = `Owner close acknowledgement is unknown; no second close was sent: ${String(error?.message || error)}`;
    updateLedger(file, ledger);
    return { status: "NOTRUN", reason: ledger.lastError, ledger: file };
  }
  if (!successfulClose(cleanup, authority, cleanupRequestId)) {
    ledger.state = cleanup?.status === "failed" ? "failed" : "unknown";
    ledger.cleanup.state = ledger.state;
    ledger.cleanup.receipt = cleanup || null;
    ledger.lastError = "Owner close did not return an exact terminal closed-epoch receipt; no second close was sent";
    updateLedger(file, ledger);
    return { status: "NOTRUN", reason: ledger.lastError, ledger: file };
  }
  ledger.cleanup.state = "succeeded";
  ledger.cleanup.receipt = cleanup;
  ledger.state = "verifying-closed-epoch";
  updateLedger(file, ledger);

  let after;
  try {
    after = await input.services.query.status();
    const closedAuthority = { ...authority, document: authority.document };
    object(after, "Post-cleanup fmcad status");
    if (after.version !== 1 || after.build !== authority.buildHash || after.clientId !== authority.clientId ||
        after.blocked !== true ||
        (authority.runtimeUpgrade && after.sourceCommit !== authority.sourceCommit) ||
        after.isolatedScratch?.epochId !== authority.epochId ||
        after.isolatedScratch?.admission !== "closed" ||
        canonical(after.isolatedScratch?.document) !== canonical(closedAuthority.document)) {
      throw new Error("Post-cleanup status does not show the exact epoch closed");
    }
  } catch (error) {
    ledger.state = "unknown";
    ledger.lastError = `Close receipt succeeded but closed-state readback is unavailable: ${String(error?.message || error)}`;
    updateLedger(file, ledger);
    return { status: "NOTRUN", reason: ledger.lastError, ledger: file };
  }
  ledger.state = "complete";
  ledger.status = "PASS";
  ledger.closedReadback = { epochId: after.isolatedScratch.epochId,
    admission: after.isolatedScratch.admission, document: after.isolatedScratch.document };
  updateLedger(file, ledger);
  return { status: "PASS", kind: "f708-isolated-first-smoke", runId, clientId: authority.clientId,
    epochId: authority.epochId, document: authority.document, geometry: ledger.geometry,
    operations: ledger.steps.map(({ phase, operation, requestId, jobId, state }) =>
      ({ phase, operation, requestId, jobId, state })),
    cleanup: { requestId: cleanupRequestId, state: "succeeded", admission: "closed" }, ledger: file,
    limitations: ["Evidence qualifies only the new isolated scratch; historical audit remains unknown and unvalidated.",
      "This is not physical manufacturing validation or a qualification of the other eleven feature suites."] };
}

module.exports = { CONTRACT_VERSIONS, F708_RUNTIME, OPERATIONS, SEQUENCE_PHASES,
  executeFirstSmoke, validateAuthority };
