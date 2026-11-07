"use strict";

// Import/preflight are offline. Native execution requires explicit --run-native and a qualified gate receipt.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../../..");
const MANIFEST = path.join(__dirname, "manifest.json");
const TEMP_ROOT = "/tmp/opencode";
const CASE_STATUSES = new Set(["PASS", "FAIL", "NOTRUN"]);
const RELEASE_MAX_AGE_MS = 5 * 60 * 1000;
const DEFERRED_ADAPTER_KINDS = new Set([
  "validate-brep-request", "validate-capture-request", "validate-selection-request", "validate-sketch-request",
]);
const DEFERRED_VALIDATORS = {
  "validate-brep-request": "validateBrepRequest",
  "validate-capture-request": "validateCaptureRequest",
  "validate-selection-request": "validateSelectionRequest",
  "validate-sketch-request": "validateSketchRequest",
};

function git(args) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.error}`);
  }
  return result.stdout.trim();
}

function existsFile(relativePath) {
  const absolute = path.resolve(ROOT, relativePath);
  if (!absolute.startsWith(`${ROOT}${path.sep}`)) return false;
  try {
    return fs.lstatSync(absolute).isFile();
  } catch {
    return false;
  }
}

function blobAt(revision, relativePath) {
  return git(["rev-parse", `${revision}:${relativePath}`]);
}

function candidateSourceIdentity(revision, relativePath) {
  const result = spawnSync("git", ["rev-parse", `${revision}:${relativePath}`], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  if (!result.error && result.status === 0) return { blob: result.stdout.trim(), source: "git-tree" };
  const absolute = path.resolve(ROOT, relativePath);
  if (!absolute.startsWith(`${ROOT}${path.sep}`) || !existsFile(relativePath)) {
    throw new Error(`Missing candidate source blob: ${relativePath}`);
  }
  return { blob: null, source: "working-tree-uncommitted",
    sha256: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") };
}

function validateManifest(manifest, candidateCommit) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.features)) {
    throw new Error("Unsupported integrated qualification manifest");
  }
  const baseCheck = spawnSync("git", ["merge-base", "--is-ancestor", manifest.candidateBase, candidateCommit], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (baseCheck.error || baseCheck.status !== 0) {
    throw new Error(`Candidate ${candidateCommit} does not contain ${manifest.candidateBase}`);
  }

  const ids = new Set();
  const source = [];
  if (!Array.isArray(manifest.runnerFiles) || manifest.runnerFiles.length === 0) {
    throw new Error("Integrated runner source list is missing");
  }
  for (const file of manifest.runnerFiles) {
    if (!existsFile(file)) throw new Error(`Missing integrated runner source: ${file}`);
    source.push({ feature: "integrated-runner", path: file, ...candidateSourceIdentity(candidateCommit, file) });
  }
  for (const feature of manifest.features) {
    if (!feature.id || ids.has(feature.id) || !feature.ticket) {
      throw new Error(`Invalid or duplicate feature identity: ${feature.id}`);
    }
    ids.add(feature.id);
    if (!Array.isArray(feature.acceptedCommits) || feature.acceptedCommits.length === 0 ||
        !Array.isArray(feature.files) || !Array.isArray(feature.requiredCases) ||
        feature.requiredCases.length === 0 ||
        feature.requiredCases.some((id) => typeof id !== "string" || !id) ||
        new Set(feature.requiredCases).size !== feature.requiredCases.length) {
      throw new Error(`Feature ${feature.id} is missing source or acceptance references`);
    }
    for (const commit of feature.acceptedCommits) {
      const check = spawnSync("git", ["merge-base", "--is-ancestor", commit, candidateCommit], {
        cwd: ROOT,
        encoding: "utf8",
      });
      if (check.error || check.status !== 0) {
        throw new Error(`Approved commit ${commit} for ${feature.id} is not in the candidate`);
      }
    }
    for (const file of feature.files) {
      if (!existsFile(file)) throw new Error(`Missing tracked source/evidence input: ${feature.id}:${file}`);
      source.push({ feature: feature.id, path: file, ...candidateSourceIdentity(candidateCommit, file) });
    }
    if (feature.entrypoint && !existsFile(feature.entrypoint)) {
      throw new Error(`Missing native entrypoint for ${feature.id}: ${feature.entrypoint}`);
    }
    if (feature.execution?.kind === "fmcad-run") {
      if (!existsFile(feature.execution.script) || !feature.files.includes(feature.execution.script) ||
          !feature.execution.scratchMode || !feature.execution.resultStatusField) {
        throw new Error(`Incomplete queue-run contract for ${feature.id}`);
      }
    } else if (feature.execution === null || feature.execution === undefined) {
      const deferred = feature.deferredAdapter;
      if (!deferred || !DEFERRED_ADAPTER_KINDS.has(deferred.kind) ||
          !feature.entrypoint || !feature.files.includes(feature.entrypoint) || !existsFile(feature.entrypoint) ||
          typeof deferred.capability !== "string" || !deferred.capability ||
          !Array.isArray(deferred.requiredPins) || deferred.requiredPins.length === 0 ||
          typeof deferred.unsupportedReason !== "string" || !deferred.unsupportedReason ||
          !manifest.runnerFiles.includes("tests/native/integrated-qualification/deferred_adapters.js")) {
        throw new Error(`Feature ${feature.id} has no executable entrypoint or validated safe unsupported-adapter contract`);
      }
      const validatorName = DEFERRED_VALIDATORS[deferred.kind];
      if (typeof require("./deferred_adapters")[validatorName] !== "function") {
        throw new Error(`Feature ${feature.id} declares a missing typed request validator`);
      }
    } else {
      throw new Error(`Feature ${feature.id} declares an unknown execution mode`);
    }
    for (const equivalence of feature.equivalentSourceCommits || []) {
      for (const [file, expectedBlob] of Object.entries(equivalence.files || {})) {
        const observedBlob = blobAt(candidateCommit, file);
        if (observedBlob !== expectedBlob || blobAt(equivalence.commit, file) !== expectedBlob) {
          throw new Error(`Approved equivalent source blob mismatch: ${feature.id}:${file}`);
        }
        source.push({ feature: feature.id, path: file, blob: observedBlob, source: "git-tree",
          equivalentCommit: equivalence.commit });
      }
    }
  }
  return source;
}

function tempPath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path under ${TEMP_ROOT}`);
  }
  const resolved = path.resolve(value);
  if (resolved !== TEMP_ROOT && !resolved.startsWith(`${TEMP_ROOT}${path.sep}`)) {
    throw new Error(`${label} must be under ${TEMP_ROOT}`);
  }
  return resolved;
}

function assertRealTempDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  const real = fs.realpathSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== directory ||
      (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      (real !== TEMP_ROOT && !real.startsWith(`${TEMP_ROOT}${path.sep}`))) {
    throw new Error(`${label} must be an owned private directory without symlinks under ${TEMP_ROOT}`);
  }
  return real;
}

function readJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular file: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function hasNoSymlinkPath(root, relative) {
  let current = root;
  const parts = relative.split(/[\\/]/);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return false;
      if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function gateReadiness(evidenceDir, manifest, candidateCommit) {
  if (!evidenceDir) return { ready: false, reason: "No coordinator release receipt supplied" };
  const gatePath = path.join(evidenceDir, "gate.json");
  if (!fs.existsSync(gatePath)) return { ready: false, reason: "Coordinator release receipt gate.json is missing" };
  const gate = readJson(gatePath);
  const queue = gate.queue || {};
  const observedAt = Date.parse(gate.observedAt);
  const ageMs = Date.now() - observedAt;
  const freshReceipt = Number.isFinite(observedAt) && ageMs >= -30000 && ageMs <= RELEASE_MAX_AGE_MS;
  const resolvedJobIds = gate.recovery?.resolvedJobIds;
  const expectedJobIds = manifest.hold?.jobs || [];
  const valid = gate.status === "released" &&
    gate.recovery?.ownerConfirmed === true &&
    Array.isArray(resolvedJobIds) && expectedJobIds.every((jobId) => resolvedJobIds.includes(jobId)) &&
    freshReceipt && queue.fresh === true && queue.paused === false &&
    queue.held === false && queue.stopping === false &&
    queue.state === "RUNNING" && queue.active == null && queue.blocked == null &&
    queue.lease == null && queue.unresolved === false &&
    queue.activeOperations === 0 && queue.nonterminalJobCount === 0 &&
    gate.runtime?.contractQualified === true &&
    typeof gate.runtime?.buildHash === "string" && gate.runtime.buildHash.length > 0 &&
    typeof gate.runtime?.fusionBuild === "string" && gate.runtime.fusionBuild.length > 0 &&
    typeof gate.runtime?.sourceCommit === "string" &&
    (!candidateCommit || gate.runtime.sourceCommit === candidateCommit) &&
    typeof gate.integrationRunId === "string" && gate.integrationRunId.length > 0 &&
    typeof gate.fusionSessionId === "string" && gate.fusionSessionId.length > 0;
  return valid
    ? { ready: true, gate, gateSha256: crypto.createHash("sha256").update(fs.readFileSync(gatePath)).digest("hex") }
    : { ready: false, reason: "Coordinator receipt is stale or does not prove reconciliation of both held jobs, a fresh clear queue, and a contract-qualified Fusion build" };
}

function verifiedArtifactPaths(evidenceDir, artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return null;
  const verified = new Set();
  const realEvidenceDir = fs.realpathSync(evidenceDir);
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact.path !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256 || "")) return null;
    const relative = artifact.path;
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) return null;
    if (!hasNoSymlinkPath(evidenceDir, relative)) return null;
    const absolute = path.join(evidenceDir, relative);
    try {
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const realArtifact = fs.realpathSync(absolute);
      if (!realArtifact.startsWith(`${realEvidenceDir}${path.sep}`)) return null;
      const hash = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
      if (hash !== artifact.sha256) return null;
      verified.add(relative);
    } catch {
      return null;
    }
  }
  return verified;
}

function verifiedRestoreArtifact(evidenceDir, proof, artifactPaths) {
  if (!Array.isArray(proof.restore?.evidence) || proof.restore.evidence.length !== 1 ||
      !artifactPaths.has(proof.restore.evidence[0])) return false;
  const cleanup = readJson(path.join(evidenceDir, proof.restore.evidence[0]));
  return cleanup.status === "pass" && cleanup.documentCreationId === proof.document.creationId &&
    cleanup.jobId === proof.restore.jobId && cleanup.requestId === proof.restore.requestId &&
    cleanup.sequenceId === proof.restore.sequenceId && cleanup.releaseStatus === "succeeded" &&
    typeof cleanup.requestIds?.begin === "string" && typeof cleanup.requestIds?.release === "string" &&
    Array.isArray(cleanup.jobs) && cleanup.jobs.some((job) => job.jobId === cleanup.jobId && job.status === "succeeded") &&
    cleanup.ownScratchAbsent === true && cleanup.protectedDocumentsUnchanged === true &&
    cleanup.activeDocumentRestored === true && cleanup.expectedActiveCreationId === cleanup.activeAfter &&
    Number.isSafeInteger(cleanup.protectedBeforeCount) && cleanup.protectedBeforeCount === cleanup.protectedAfterCount &&
    /^[a-f0-9]{64}$/.test(cleanup.protectedBeforeSha256 || "") &&
    cleanup.protectedBeforeSha256 === cleanup.protectedAfterSha256;
}

function classifyFeature(feature, proof, context) {
  const base = { id: feature.id, ticket: feature.ticket, status: "NOTRUN", cases: [], evidence: [],
    ...(feature.deferredAdapter ? { unsupportedAdapter: {
      capability: feature.deferredAdapter.capability,
      requiredPins: feature.deferredAdapter.requiredPins,
      reason: feature.deferredAdapter.unsupportedReason,
    } } : {}) };
  if (!context.gateReady) return { ...base, reason: context.gateReason };
  if (!context.workingTreeClean) return { ...base, reason: "Candidate worktree is not clean; proof cannot be bound to a stable source SHA" };
  if (!proof) return { ...base, reason: "No per-feature native proof supplied" };
  if (proof.featureId !== feature.id || proof.candidateCommit !== context.candidateCommit ||
      proof.integrationRunId !== context.integrationRunId || proof.fusionSessionId !== context.fusionSessionId) {
    return { ...base, reason: "Proof feature, source SHA, integrated run, or Fusion session does not match the candidate" };
  }
  if (proof.requiresReconciliation === true) {
    return { ...base, reason: proof.reason || "Native broker outcome is unknown; no replay or cleanup is allowed",
      requiresReconciliation: true, observedRequestId: proof.requestId || null };
  }
  if (proof.fusionBuild !== context.fusionBuild || !proof.document?.name ||
      typeof proof.document.creationId !== "string" || !proof.document.creationId) {
    return { ...base, reason: "Proof is missing the matching Fusion build or exact document pin" };
  }
  if (!Array.isArray(proof.jobs) || proof.jobs.length === 0) {
    return { ...base, reason: "Proof has no broker job receipts" };
  }
  if (proof.jobs.some((job) => !job || typeof job.status !== "string" ||
      typeof job.docId !== "string" || typeof job.jobId !== "string" || typeof job.requestId !== "string")) {
    return { ...base, reason: "Broker receipt is missing its job, request, document, or status field" };
  }
  const unresolved = proof.jobs.some((job) =>
    ["unknown", "needs_reconciliation", "queued", "preparing", "running"].includes(job.status));
  if (unresolved) {
    return { ...base, reason: "A job outcome is nonterminal/unknown; do not retry, restore, or clean up blindly",
      requiresReconciliation: true, observedJobs: proof.jobs };
  }
  if (proof.jobs.some((job) => job.status !== "succeeded" || job.docId !== proof.document.creationId)) {
    return { ...base, status: "FAIL", reason: "A terminal job failed or was not bound to the exact document pin",
      observedJobs: proof.jobs };
  }
  if (proof.jobs.some((job) => !job.jobId || !job.requestId)) {
    return { ...base, reason: "Broker receipt is missing its job/request identity" };
  }
  if (!Array.isArray(proof.cases)) {
    return { ...base, reason: "Proof cases are missing" };
  }
  const byId = new Map(proof.cases.map((item) => [item.id, item]));
  if (byId.size !== proof.cases.length) {
    return { ...base, reason: "Proof cases are missing or duplicated" };
  }
  const artifactPaths = verifiedArtifactPaths(context.evidenceDir, proof.artifacts);
  if (!artifactPaths) {
    return { ...base, status: "FAIL", reason: "Evidence artifact path/hash verification failed" };
  }
  const jobIds = new Set(proof.jobs.map((job) => job.jobId));
  if (proof.restore?.status === "FAIL") {
    return { ...base, status: "FAIL", reason: "Owned-scratch restore or cleanup explicitly failed" };
  }
  if (proof.restore?.requiresReconciliation === true || proof.restore?.jobStatus === "unknown") {
    return { ...base, reason: "Owned-scratch cleanup has an unknown broker outcome; do not retry or discard",
      requiresReconciliation: true };
  }
  const caseById = byId;
  for (const id of feature.requiredCases) {
    const result = caseById.get(id);
    base.cases.push(result ? {
      id,
      status: result.status,
      observation: result.observation ?? null,
      jobId: result.jobId ?? null,
      evidence: Array.isArray(result.evidence) ? result.evidence : [],
    } : { id, status: "NOTRUN", observation: null, jobId: null, evidence: [] });
  }
  const missing = feature.requiredCases.filter((id) => !caseById.has(id));
  if (base.cases.some((item) => !CASE_STATUSES.has(item.status) || !item.observation ||
      !jobIds.has(item.jobId) || item.evidence.length === 0 ||
      item.evidence.some((reference) => !artifactPaths.has(reference)))) {
    return { ...base, reason: "A case lacks a valid assertion, terminal job binding, or hashed evidence" };
  }
  if (base.cases.some((item) => item.status === "FAIL")) {
    return { ...base, status: "FAIL", reason: "At least one native acceptance assertion failed or remained unknown" };
  }
  if (proof.nativeRunnerStatus === "fail") {
    return { ...base, status: "FAIL", reason: proof.reason || "The pinned native runner aggregate reported fail" };
  }
  if (missing.length || base.cases.some((item) => item.status === "NOTRUN")) {
    return { ...base, reason: `Required cases not run: ${missing.join(", ") || "see case list"}` };
  }
  if (["unknown", "incomplete"].includes(proof.nativeRunnerStatus)) {
    return { ...base, reason: proof.reason || "The pinned native runner aggregate is unresolved" };
  }
  if (proof.restore?.status !== "PASS" || proof.restore?.jobStatus !== "succeeded" ||
      typeof proof.restore?.jobId !== "string" || typeof proof.restore?.requestId !== "string" ||
      typeof proof.restore?.sequenceId !== "string" || proof.restore?.ownScratchAbsent !== true ||
      proof.restore?.protectedDocumentsUnchanged !== true || proof.restore?.activeDocumentRestored !== true ||
      !Array.isArray(proof.restore?.evidence) || proof.restore.evidence.length === 0 ||
      proof.restore.evidence.some((reference) => !artifactPaths.has(reference))) {
    const failed = proof.restore?.status === "FAIL";
    return { ...base, status: failed ? "FAIL" : "NOTRUN",
      reason: "Owned scratch cleanup/readback and protected-document preservation are not both proven" };
  }
  if (!verifiedRestoreArtifact(context.evidenceDir, proof, artifactPaths)) {
    return { ...base, status: "FAIL", reason: "Restore artifact does not independently match the exact cleanup job and protected-document readback" };
  }
  return { ...base, status: "PASS", reason: null,
    document: proof.document, jobIds: proof.jobs.map((job) => job.jobId),
    restore: proof.restore, evidence: proof.artifacts };
}

function buildReport(options = {}) {
  const manifest = readJson(MANIFEST);
  const candidateCommit = git(["rev-parse", "HEAD"]);
  const sourceBlobs = validateManifest(manifest, candidateCommit);
  const dirty = git(["status", "--porcelain", "--untracked-files=normal"]).length > 0;
  const evidenceDir = options.evidenceDir ? tempPath(options.evidenceDir, "--evidence-dir") : null;
  if (evidenceDir) {
    assertRealTempDirectory(evidenceDir, "--evidence-dir");
  }
  const gate = gateReadiness(evidenceDir, manifest, candidateCommit);
  const reportContext = {
    candidateCommit,
    workingTreeClean: !dirty,
    evidenceDir,
    gateReady: gate.ready,
    gateReason: gate.reason,
    fusionBuild: gate.gate?.runtime?.fusionBuild || null,
    runtimeBuildHash: gate.gate?.runtime?.buildHash || null,
    integrationRunId: gate.gate?.integrationRunId || null,
    fusionSessionId: gate.gate?.fusionSessionId || null,
  };
  const features = manifest.features.map((feature) => {
    const proofPath = evidenceDir && path.join(evidenceDir, `${feature.id}.json`);
    const proof = proofPath && fs.existsSync(proofPath) ? readJson(proofPath) : null;
    return classifyFeature(feature, proof, reportContext);
  });
  const overallStatus = features.some((feature) => feature.status === "FAIL") ? "FAIL" :
    features.every((feature) => feature.status === "PASS") ? "PASS" : "NOTRUN";
  return {
    schemaVersion: 1,
    candidate: {
      base: manifest.candidateBase,
      commit: candidateCommit,
      workingTreeClean: !dirty,
      sourceBlobs,
    },
    gate: gate.ready ? {
      status: "released",
      observedAt: gate.gate.observedAt,
      fusionBuild: gate.gate.runtime.fusionBuild,
      runtimeBuildHash: gate.gate.runtime.buildHash,
      integrationRunId: gate.gate.integrationRunId,
      fusionSessionId: gate.gate.fusionSessionId,
      receiptSha256: gate.gateSha256,
    } : { status: "blocked", reason: gate.reason || "No evidence bundle supplied" },
    fusionSessions: manifest.fusionSessions,
    nativeQualification: overallStatus,
    features,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { help: true };
    if (arg === "--run-native") {
      if (options.runNative) throw new Error("--run-native may be supplied only once");
      options.runNative = true;
      continue;
    }
    if (!["--evidence-dir", "--out", "--bindings", "--cli", "--installation-root", "--config", "--broker-state-home", "--client-id"].includes(arg) || options[arg]) {
      throw new Error(`Unsupported or repeated argument: ${arg}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    options[arg] = value;
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      "Default mode is offline evidence assembly. Native dispatch is explicit and requires --run-native plus a fresh coordinator gate receipt.\n" +
      "Usage: node tests/native/integrated-qualification/runner.js --evidence-dir /tmp/opencode/... [--out /tmp/opencode/report.json]\n" +
      "Opt-in execution: add --run-native --cli /absolute/installed/fmcad.js --installation-root /absolute/candidate --config /absolute/fmcad-config.json --broker-state-home /absolute/shared/XDG_STATE_HOME --client-id STABLE_OWNER_ID [--bindings /tmp/opencode/.../bindings.json]\n" +
      "HOME, XDG config/data/cache, TMPDIR and project .cad are private under the evidence directory; only XDG_STATE_HOME is explicitly bound to the existing shared broker IPC path.\n" +
      "Evidence input uses gate.json plus one <featureId>.json per completed feature.\n" +
      "The gate receipt must bind one integrationRunId/Fusion session, resolve both held jobs, bind the installed source commit, and prove a fresh empty queue plus contract-qualified runtime.\n" +
      "Feature proof must bind the same run/session, candidateCommit, Fusion build, exact document creationId, terminal job/request IDs, all required cases, restore readback, and SHA-256 artifacts.\n",
    );
    return;
  }
  if (args.runNative && !args["--evidence-dir"]) throw new Error("--run-native requires --evidence-dir");
  const evidenceDir = args["--evidence-dir"] ? tempPath(args["--evidence-dir"], "--evidence-dir") : null;
  if (evidenceDir) {
    if (evidenceDir === TEMP_ROOT) throw new Error("--evidence-dir must be an owned subdirectory of /tmp/opencode");
    assertRealTempDirectory(evidenceDir, "--evidence-dir");
  }
  let report = buildReport(evidenceDir ? { evidenceDir } : {});
  let execution = null;
  if (args.runNative) {
    const manifest = readJson(MANIFEST);
    const candidateCommit = report.candidate.commit;
    const gateReceipt = gateReadiness(evidenceDir, manifest, candidateCommit);
    if (!gateReceipt.ready) {
      execution = { status: "blocked", reason: gateReceipt.reason, portCalls: 0 };
    } else {
      if (!report.candidate.workingTreeClean) throw new Error("--run-native requires a clean isolated candidate worktree");
      const dispatchLedger = path.join(evidenceDir, "dispatch-ledger.json");
      if (fs.existsSync(dispatchLedger)) {
        execution = { status: "blocked", requiresReconciliation: true,
          reason: "Dispatch ledger already exists; this invocation will not replay or resume it" };
      } else {
      for (const key of ["--cli", "--installation-root", "--config", "--broker-state-home", "--client-id"]) {
        if (!args[key]) throw new Error(`--run-native requires ${key}`);
      }
      const bindingPath = args["--bindings"] ? tempPath(args["--bindings"], "--bindings") : path.join(evidenceDir, "bindings.json");
      if (args["--bindings"] && !bindingPath.startsWith(`${evidenceDir}${path.sep}`)) {
        throw new Error("--bindings must be inside the private evidence directory");
      }
      if (fs.existsSync(bindingPath) && !hasNoSymlinkPath(evidenceDir, path.relative(evidenceDir, bindingPath))) {
        throw new Error("--bindings must be a regular file reached without symlinks inside the evidence directory");
      }
      let bindings = { integrationRunId: gateReceipt.gate.integrationRunId,
        fusionSessionId: gateReceipt.gate.fusionSessionId, features: {} };
      if (fs.existsSync(bindingPath)) {
        bindings = { ...bindings, ...readJson(bindingPath) };
        bindings.features ||= {};
      }
      const { createFmcadCliPort, createPrivateWorkspace, runNativeSweep } = require("./integrated-qualification/executor");
      const workspace = createPrivateWorkspace(evidenceDir);
      const port = createFmcadCliPort({ cliPath: args["--cli"], installationRoot: args["--installation-root"],
        configPath: args["--config"], brokerStateHome: args["--broker-state-home"], clientId: args["--client-id"],
        expectedBuildHash: gateReceipt.gate.runtime.buildHash, workspace });
      execution = await runNativeSweep({ manifest, candidateCommit, workingTreeClean: report.candidate.workingTreeClean,
        evidenceDir, gateReceipt, bindings, port, optIn: true });
      const executionPath = path.join(evidenceDir, "native-execution-summary.json");
      fs.writeFileSync(executionPath, `${JSON.stringify(execution, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      report = buildReport({ evidenceDir });
      }
    }
  }
  const output = `${JSON.stringify(execution ? { execution, qualification: report } : report, null, 2)}\n`;
  if (args["--out"]) {
    const target = tempPath(args["--out"], "--out");
    assertRealTempDirectory(path.dirname(target), "--out parent");
    fs.writeFileSync(target, output, { flag: "wx", mode: 0o600 });
  } else {
    process.stdout.write(output);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildReport, classifyFeature, gateReadiness, main, validateManifest };
