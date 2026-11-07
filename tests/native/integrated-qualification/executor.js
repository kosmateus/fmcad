"use strict";

// Opt-in queue executor for existing trusted fmcad run scripts. Import is inert.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { executeFirstSmoke } = require("./first_smoke");

const ROOT = path.resolve(__dirname, "../../..");
const TEMP_ROOT = "/tmp/opencode";

function marker(text, prefix) {
  const lines = String(text || "").split(/\r?\n/).filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) return null;
  try { return JSON.parse(lines[0].slice(prefix.length)); } catch { return null; }
}

function parseJsonOutput(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function queueJob(stdout, stderr, requestId) {
  const request = marker(stderr, "FMCAD_QUEUE_REQUEST ");
  const accepted = marker(stderr, "FMCAD_QUEUE_JOB ");
  const result = marker(stderr, "FMCAD_QUEUE_RESULT ");
  if (!request || !accepted || !result || request.requestId !== requestId ||
      accepted.requestId !== requestId || (result.requestId && result.requestId !== requestId) ||
      accepted.jobId !== (result.jobId || result.id)) {
    return { status: "unknown", requestId, reason: "Missing or inconsistent durable queue receipts" };
  }
  const resultLines = String(stdout || "").split(/\r?\n/).filter((line) => line.startsWith("FMCAD_RESULT "));
  let fmcadResult = null;
  if (resultLines.length === 1) {
    try { fmcadResult = JSON.parse(resultLines[0].slice("FMCAD_RESULT ".length)); } catch { /* retained as missing */ }
  }
  const terminal = ["succeeded", "failed", "cancelled", "expired"].includes(result.state);
  return {
    status: terminal ? result.state : "unknown",
    jobId: accepted.jobId,
    requestId,
    sequenceId: result.sequenceId || null,
    fmcadResult,
    stdout: String(stdout || ""),
    stderr: String(stderr || ""),
  };
}

function parseDocumentList(text) {
  const documents = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.startsWith("DOC ")) continue;
    const row = {};
    const rest = line.slice(4);
    const keys = [...rest.matchAll(/(?:^|\s)(id|creationId|isActive|isModified|isSaved)=/g)];
    if (!keys.length || !rest.startsWith("name=")) continue;
    row.name = rest.slice(5, keys[0].index).trim();
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index][1];
      const start = keys[index].index + keys[index][0].length;
      const end = index + 1 < keys.length ? keys[index + 1].index : rest.length;
      let value = rest.slice(start, end).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      row[key] = ["isActive", "isModified", "isSaved"].includes(key)
        ? value === "true" : value;
    }
    if (!row.name || typeof row.creationId !== "string") {
      throw new Error("Open-document inventory omitted name or exact creationId");
    }
    documents.push(row);
  }
  const ids = documents.map((row) => row.creationId);
  if (new Set(ids).size !== ids.length) throw new Error("Open-document inventory has duplicate creationIds");
  if (documents.filter((row) => row.isActive === true).length > 1) {
    throw new Error("Open-document inventory reports multiple active documents");
  }
  return documents;
}

function readJsonFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular JSON file: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function createPrivateWorkspace(evidenceDir) {
  const root = path.join(evidenceDir, "runtime");
  fs.mkdirSync(root, { mode: 0o700 });
  const paths = {
    root,
    home: path.join(root, "home"),
    config: path.join(root, "xdg", "config"),
    data: path.join(root, "xdg", "data"),
    cache: path.join(root, "xdg", "cache"),
    tmp: path.join(root, "tmp"),
    project: path.join(root, "project"),
  };
  for (const directory of Object.values(paths)) {
    if (directory === root) continue;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.mkdirSync(path.join(paths.project, ".cad"), { mode: 0o700 });
  fs.mkdirSync(path.join(paths.project, ".cad", "native-qualification"), { mode: 0o700 });
  return paths;
}

function validateExplicitConfig(configPath) {
  const absolute = path.resolve(configPath);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) {
    throw new Error("Explicit fmcad config must be a regular, non-symlink file");
  }
  const config = JSON.parse(fs.readFileSync(absolute, "utf8"));
  if (config.backend !== "addin" || config.routing !== "queue" || config.queue?.autoStart !== false) {
    throw new Error("Native executor requires backend=addin, routing=queue, and queue.autoStart=false");
  }
  return absolute;
}

function validateBrokerStateHome(stateHome) {
  if (typeof stateHome !== "string" || !path.isAbsolute(stateHome)) {
    throw new Error("--broker-state-home must be an explicit absolute path to the shared fmcad state home");
  }
  const absolute = path.resolve(stateHome);
  const stateStat = fs.lstatSync(absolute);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) {
    throw new Error("--broker-state-home must be a real, non-symlink directory");
  }
  for (const directory of [path.join(absolute, "fmcad"), path.join(absolute, "fmcad", "queue")]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("--broker-state-home must identify an existing fmcad queue directory; no broker is started");
    }
  }
  return absolute;
}

function createFmcadCliPort({ cliPath, installationRoot, configPath, brokerStateHome, clientId, workspace,
  expectedBuildHash, timeoutMs = 300000 }) {
  const cli = path.resolve(cliPath);
  const installation = path.resolve(installationRoot || "");
  if (!path.isAbsolute(installationRoot || "")) throw new Error("--installation-root must be an absolute installed candidate path");
  const realInstallation = fs.realpathSync(installation);
  const cliStat = fs.lstatSync(cli);
  const realCli = fs.realpathSync(cli);
  if (!cliStat.isFile() || cliStat.isSymbolicLink() || realCli !== cli || !cli.endsWith(".js") ||
      !realCli.startsWith(`${realInstallation}${path.sep}`)) {
    throw new Error("--cli must be the exact non-symlink installed JavaScript CLI path");
  }
  const config = validateExplicitConfig(configPath);
  const sharedStateHome = validateBrokerStateHome(brokerStateHome);
  if (typeof clientId !== "string" || !clientId || clientId.length > 200) {
    throw new Error("--client-id must be an explicit stable owner identity");
  }
  const env = {
    PATH: process.env.PATH,
    HOME: workspace.home,
    XDG_CONFIG_HOME: workspace.config,
    XDG_DATA_HOME: workspace.data,
    XDG_CACHE_HOME: workspace.cache,
    // fmcad IPC is addressed through XDG_STATE_HOME/fmcad/queue. This is the
    // one explicit shared-state exception; HOME, config/data/cache, tmp and
    // the project .cad tree remain private to this run.
    XDG_STATE_HOME: sharedStateHome,
    TMPDIR: workspace.tmp,
    FMCAD_CLIENT: clientId,
    LANG: process.env.LANG || "C.UTF-8",
  };
  const buildModule = path.join(realInstallation, "src", "queue-instance.js");
  const buildCheck = spawnSync(process.execPath, ["-e",
    "const m=require(process.argv[1]); process.stdout.write(m.buildHash())", buildModule], {
    cwd: realInstallation,
    env,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  const localBuildHash = buildCheck.status === 0 ? buildCheck.stdout.trim() : null;
  if (!localBuildHash || localBuildHash !== expectedBuildHash) {
    throw new Error("Installed CLI build hash does not match the coordinator-qualified runtime; no queue request sent");
  }

  function invoke(argv, { requestId, queueControl = false, timeout = timeoutMs, sequence } = {}) {
    const args = [...argv, "--config", config, "--client", clientId];
    if (!queueControl) args.push("--backend", "addin", "--routing", "queue");
    if (requestId) args.push("--request-id", requestId);
    if (sequence?.action) {
      args.push("--sequence-action", sequence.action);
      if (sequence.id) args.push("--sequence-id", sequence.id);
      if (sequence.mode) args.push("--sequence-mode", sequence.mode);
    }
    const child = spawnSync(process.execPath, [cli, ...args], {
      cwd: workspace.project,
      env,
      encoding: "utf8",
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (queueControl) {
      if (child.error || child.signal || child.status !== 0) {
        return { status: "failed", stdout: child.stdout || "", stderr: child.stderr || "",
          error: child.error?.message || child.signal || `CLI exit ${child.status}` };
      }
      try { return { status: "succeeded", value: JSON.parse(child.stdout || "null"), stdout: child.stdout || "" }; }
      catch { return { status: "failed", stdout: child.stdout || "", stderr: child.stderr || "", error: "Malformed control result" }; }
    }
    const result = queueJob(child.stdout, child.stderr, requestId);
    if (child.error || child.signal || child.status === null) {
      return { ...result, status: "unknown", error: child.error?.message || child.signal || "CLI response lost" };
    }
    return result;
  }

  function listDocuments(options = {}) {
    const requestId = options.requestId || `native-list-${crypto.randomUUID()}`;
    const result = invoke(["doc", "list"], { requestId, sequence: options.sequence });
    if (result.status !== "succeeded") return { ...result, documents: null };
    try { return { ...result, documents: parseDocumentList(result.stdout) }; }
    catch (error) { return { ...result, status: "unknown", documents: null, reason: error.message }; }
  }

  function stableRequestId(runId, phase) {
    return `native-${crypto.createHash("sha256").update(`${runId}:${phase}`).digest("hex").slice(0, 40)}`;
  }

  return {
    clientId,
    workspace,
    async status() {
      const result = invoke(["queue", "status"], { queueControl: true });
      return result.status === "succeeded" ? result.value : { status: result.status, error: result.error };
    },
    async listDocuments(options = {}) { return listDocuments(options); },
    async createScratch({ name, runId, baselineDocuments, baselineRequestId, baselineJobId,
      requestId: suppliedRequestId, afterListRequestId }) {
      if (!Array.isArray(baselineDocuments) || baselineDocuments.some((row) => row.name === name)) {
        return { status: "failed", createRequestId: suppliedRequestId,
          reason: "Fresh baseline inventory is missing or scratch name already exists; no document was created" };
      }
      const requestId = suppliedRequestId || stableRequestId(runId, `doc-new:${name}`);
      const created = invoke(["doc", "new", "--name", name], { requestId });
      if (created.status !== "succeeded") return { ...created, requestId, createRequestId: requestId,
        createStatus: created.status, createJobId: created.jobId,
        baselineRequestId, baselineJobId, baselineDocuments };
      const inventory = await listDocuments({ requestId: afterListRequestId });
      if (inventory.status !== "succeeded") return { ...inventory, status: "unknown",
        createRequestId: requestId, createJobId: created.jobId,
        createStatus: created.status, listStatus: inventory.status,
        listRequestId: inventory.requestId, listJobId: inventory.jobId,
        baselineRequestId, baselineJobId, baselineDocuments,
        reason: "Document creation succeeded but fresh exact inventory is unresolved" };
      const matches = inventory.documents.filter((row) => row.name === name);
      if (matches.length !== 1) return { status: "unknown", createRequestId: requestId,
        createJobId: created.jobId, listRequestId: inventory.requestId, listJobId: inventory.jobId,
        createStatus: created.status, listStatus: inventory.status,
        baselineRequestId, baselineJobId, baselineDocuments,
        reason: "Document creation succeeded but fresh inventory did not identify exactly one new scratch" };
      const document = matches[0];
      if (baselineDocuments.some((row) => row.creationId === document.creationId) ||
          !document.isActive || document.isSaved || document.isModified) {
        return { status: "failed", createRequestId: requestId, createStatus: created.status,
          listStatus: inventory.status, createJobId: created.jobId,
          listRequestId: inventory.requestId, listJobId: inventory.jobId,
          baselineRequestId, baselineJobId, baselineDocuments, document,
          reason: "New scratch did not read back active, unsaved and unmodified" };
      }
      return { status: "succeeded", createRequestId: requestId, createStatus: created.status,
        listStatus: inventory.status, createJobId: created.jobId,
        baselineRequestId, baselineJobId, baselineDocuments,
        listJobId: inventory.jobId,
        listRequestId: inventory.requestId, document };
    },
    async capabilityProbe({ document, capabilityId, runId, requestId: suppliedRequestId }) {
      const requestId = suppliedRequestId || stableRequestId(runId, `probe:${capabilityId}`);
      const result = invoke(["capabilities", "probe", "--doc", document.name, "--doc-id", document.creationId,
        "--data", JSON.stringify({ capabilityId })], { requestId });
      const nativeResult = result.fmcadResult || parseJsonOutput(result.stdout);
      const operation = nativeResult?.result || nativeResult;
      return { ...result, requestId, probe: operation?.result || operation,
        operationStatus: operation?.status || null };
    },
    async runScript({ script, document, args, runId, suiteId, requestId: suppliedRequestId, timeout = timeoutMs }) {
      const scriptPath = path.resolve(ROOT, script);
      if (!scriptPath.startsWith(`${ROOT}${path.sep}`) || !fs.lstatSync(scriptPath).isFile()) {
        throw new Error(`Native runner script is outside the candidate or missing: ${script}`);
      }
      const requestId = suppliedRequestId || stableRequestId(runId, `run:${suiteId}`);
      const argsPath = path.join(workspace.project, ".cad", "native-qualification", `${suiteId}.args.json`);
      fs.writeFileSync(argsPath, JSON.stringify(args, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      const result = invoke([scriptPath, "--doc", document.name, "--doc-id", document.creationId,
        "--helpers", "cad-v1", "--args-file", argsPath, "--timeout", String(timeout)], { requestId, timeout: timeout + 15000 });
      return { ...result, requestId, docId: document.creationId, script, argsPath };
    },
    async cleanupScratch({ document, beforeDocuments, runId, runnerClosedScratch = false,
      expectedActiveCreationId, requestIds = {} }) {
      const beginRequestId = requestIds.begin || stableRequestId(runId, `cleanup-list-begin:${document.creationId}`);
      const closeRequestId = requestIds.close || stableRequestId(runId, `cleanup-close:${document.creationId}`);
      const postRequestId = requestIds.post || stableRequestId(runId, `cleanup-list-after:${document.creationId}`);
      const releaseRequestId = requestIds.release || stableRequestId(runId, `cleanup-release:${document.creationId}`);
      const finish = (value) => ({ ...value, requestIds: {
        begin: beginRequestId, close: closeRequestId, post: postRequestId, release: releaseRequestId,
      } });
      const initial = await listDocuments({ requestId: beginRequestId,
        sequence: { action: "begin", mode: "exclusive" } });
      if (initial.status !== "succeeded" || !initial.sequenceId) {
        return finish({ status: initial.status === "unknown" || initial.status === "succeeded" ? "unknown" : "fail",
          reason: "Exclusive cleanup sequence did not return a terminal sequenceId",
          jobId: initial.jobId || null, requestId: initial.requestId || beginRequestId,
          jobs: initial.jobId ? [{ jobId: initial.jobId, requestId: initial.requestId || beginRequestId,
            status: initial.status }] : [], releaseStatus: "not-run" });
      }
      const sequenceId = initial.sequenceId;
      const target = initial.documents.find((row) => row.creationId === document.creationId);
      const protectedAtStart = beforeDocuments.filter((row) => row.creationId !== document.creationId);
      const initialStable = preservedDocuments(protectedAtStart, initial.documents);
      if (!initialStable) {
        const released = invoke(["queue", "release", "--sequence-id", sequenceId], {
          queueControl: true,
          requestId: releaseRequestId,
        });
        return finish({ status: released.status === "succeeded" ? "failed" : "unknown", sequenceId,
          jobId: initial.jobId, requestId: initial.requestId,
          jobs: [{ jobId: initial.jobId, requestId: initial.requestId, status: initial.status }],
          releaseStatus: released.status, reason: "Protected document inventory changed before cleanup" });
      }
      const existedInBaseline = beforeDocuments.some((row) =>
        row.creationId === document.creationId && row.name === document.name);
      if (expectedActiveCreationId !== null &&
          (typeof expectedActiveCreationId !== "string" || expectedActiveCreationId === document.creationId ||
           !beforeDocuments.some((row) => row.creationId === expectedActiveCreationId))) {
        const released = invoke(["queue", "release", "--sequence-id", sequenceId], {
          queueControl: true,
          requestId: releaseRequestId,
        });
        return finish({ status: released.status === "succeeded" ? "not-run" : "unknown", sequenceId,
          jobId: initial.jobId, requestId: initial.requestId,
          jobs: [{ jobId: initial.jobId, requestId: initial.requestId, status: initial.status }],
          releaseStatus: released.status, reason: "Expected post-cleanup active-document identity is missing or invalid" });
      }
      if (!target && (!runnerClosedScratch || !existedInBaseline)) {
        const released = invoke(["queue", "release", "--sequence-id", sequenceId], {
          queueControl: true,
          requestId: releaseRequestId,
        });
        return finish({ status: released.status === "succeeded" ? "failed" : "unknown", sequenceId,
          jobId: initial.jobId, requestId: initial.requestId,
          jobs: [{ jobId: initial.jobId, requestId: initial.requestId, status: initial.status }],
          releaseStatus: released.status, reason: "Exact owned scratch is absent before cleanup without an authorized runner-close receipt" });
      }
      if (runnerClosedScratch && target) {
        const released = invoke(["queue", "release", "--sequence-id", sequenceId], {
          queueControl: true,
          requestId: releaseRequestId,
        });
        return finish({ status: released.status === "succeeded" ? "failed" : "unknown", sequenceId,
          jobId: initial.jobId, requestId: initial.requestId,
          jobs: [{ jobId: initial.jobId, requestId: initial.requestId, status: initial.status }],
          releaseStatus: released.status, reason: "Runner-owned close was reported, but the exact scratch remains open; host refuses a second close" });
      }
      let closeJob = null;
      let post = initial;
      if (target) {
        if (target.name !== document.name || target.isActive !== true) {
          const released = invoke(["queue", "release", "--sequence-id", sequenceId], {
            queueControl: true,
          requestId: releaseRequestId,
          });
          return finish({ status: released.status === "succeeded" ? "not-run" : "unknown", sequenceId,
            jobId: initial.jobId, requestId: initial.requestId,
            jobs: [{ jobId: initial.jobId, requestId: initial.requestId, status: initial.status }],
            releaseStatus: released.status, reason: "Exact owned scratch is not the active document; refusing blind activation/close" });
        }
        if (document.isSaved === true && target.isModified !== false) {
          const released = invoke(["queue", "release", "--sequence-id", sequenceId], {
            queueControl: true,
            requestId: releaseRequestId,
          });
          return finish({ status: released.status === "succeeded" ? "failed" : "unknown", sequenceId,
            jobId: initial.jobId, requestId: initial.requestId,
            jobs: [{ jobId: initial.jobId, requestId: initial.requestId, status: initial.status }],
            releaseStatus: released.status, reason: "Saved owned scratch is modified; discard-close is refused" });
        }
        closeJob = invoke(["doc", "close", "--discard"], { requestId: closeRequestId,
          sequence: { action: "continue", id: sequenceId } });
        if (closeJob.status === "unknown") return finish({ status: "unknown", sequenceId, jobId: closeJob.jobId || null,
          requestId: closeJob.requestId || null,
          jobs: [{ jobId: initial.jobId, requestId: initial.requestId, status: initial.status },
            { jobId: closeJob.jobId || null, requestId: closeJob.requestId || null, status: "unknown" }],
          releaseStatus: "not-run", reason: "Discard-close outcome is unknown; do not retry or release blindly" });
        post = await listDocuments({ requestId: postRequestId,
          sequence: { action: "continue", id: sequenceId } });
        if (post.status !== "succeeded") return finish({ status: "unknown", sequenceId, jobId: post.jobId || null,
          requestId: post.requestId || null,
          jobs: [{ jobId: initial.jobId, requestId: initial.requestId, status: initial.status },
            ...(closeJob ? [{ jobId: closeJob.jobId, requestId: closeJob.requestId, status: closeJob.status }] : []),
            { jobId: post.jobId || null, requestId: post.requestId || null, status: "unknown" }],
          releaseStatus: "not-run", reason: "Post-close inventory is unknown" });
      }
      const absent = !post.documents.some((row) => row.creationId === document.creationId);
      const protectedBefore = beforeDocuments.filter((row) => row.creationId !== document.creationId);
      const protectedUnchanged = preservedDocuments(protectedBefore, post.documents);
      const activeAfter = post.documents.find((row) => row.isActive === true)?.creationId || null;
      const activeRestored = expectedActiveCreationId === activeAfter;
      const release = invoke(["queue", "release", "--sequence-id", sequenceId], {
        queueControl: true,
        requestId: releaseRequestId,
      });
      if (release.status !== "succeeded") return finish({ status: "unknown", sequenceId,
        jobId: post.jobId || closeJob?.jobId || initial.jobId,
        requestId: post.requestId || closeJob?.requestId || initial.requestId,
        jobs: [{ jobId: initial.jobId, requestId: initial.requestId, status: initial.status },
          ...(closeJob ? [{ jobId: closeJob.jobId, requestId: closeJob.requestId, status: closeJob.status }] : []),
          ...(post !== initial ? [{ jobId: post.jobId, requestId: post.requestId, status: post.status }] : [])],
        releaseStatus: release.status, reason: "Exclusive cleanup sequence release did not verify" });
      return finish({
        status: absent && protectedUnchanged && activeRestored && (!closeJob || closeJob.status === "succeeded") ? "pass" : "fail",
        sequenceId, jobId: post.jobId || closeJob?.jobId || initial.jobId,
        requestId: post.requestId || closeJob?.requestId || initial.requestId,
        jobs: [{ jobId: initial.jobId, requestId: initial.requestId, status: initial.status },
          ...(closeJob ? [{ jobId: closeJob.jobId, requestId: closeJob.requestId, status: closeJob.status }] : []),
          ...(post !== initial ? [{ jobId: post.jobId, requestId: post.requestId, status: post.status }] : [])],
        documentCreationId: document.creationId,
        ownScratchAbsent: absent,
        protectedDocumentsUnchanged: protectedUnchanged,
        activeDocumentRestored: activeRestored,
        releaseStatus: release.status,
        expectedActiveCreationId, activeAfter,
        before: initial.documents, after: post.documents,
      });
    },
  };
}

function preservedDocuments(before, after) {
  const current = new Map((after || []).map((row) => [row.creationId, row]));
  return (before || []).every((row) => {
    const actual = current.get(row.creationId);
    return actual && actual.name === row.name && actual.isSaved === row.isSaved && actual.isModified === row.isModified;
  });
}

function queueIsClear(status, buildHash) {
  if (!status || status.status || status.error) return false;
  const control = status.control || {};
  const phase = control.phase || status.phase || status.state;
  const unresolved = control.unresolved ?? status.unresolved;
  const activeOperations = control.activeOperations ?? status.activeOperations;
  return status.buildHash === buildHash && phase === "RUNNING" && status.paused === false &&
    status.active == null && status.blocked == null && status.lease == null &&
    unresolved === false && activeOperations === 0 && status.nonterminalJobCount === 0 &&
    status.held === false && status.stopping === false;
}

function releasedGateMatches(receipt, manifest, candidateCommit) {
  const gate = receipt?.gate;
  const queue = gate?.queue || {};
  const runtime = gate?.runtime || {};
  const resolved = gate?.recovery?.resolvedJobIds;
  const ageMs = Date.now() - Date.parse(gate?.observedAt);
  return receipt?.ready === true && /^[a-f0-9]{64}$/.test(receipt.gateSha256 || "") &&
    gate.status === "released" && gate.recovery?.ownerConfirmed === true &&
    Array.isArray(resolved) && (manifest.hold?.jobs || []).every((id) => resolved.includes(id)) &&
    Number.isFinite(ageMs) && ageMs >= -30000 && ageMs <= 5 * 60 * 1000 &&
    queue.fresh === true && queue.paused === false && queue.held === false && queue.stopping === false &&
    queue.state === "RUNNING" && queue.active == null &&
    queue.blocked == null && queue.lease == null && queue.unresolved === false &&
    queue.activeOperations === 0 && queue.nonterminalJobCount === 0 &&
    runtime.contractQualified === true && runtime.sourceCommit === candidateCommit &&
    typeof runtime.buildHash === "string" && runtime.buildHash.length > 0 &&
    typeof runtime.fusionBuild === "string" && runtime.fusionBuild.length > 0 &&
    typeof gate.integrationRunId === "string" && gate.integrationRunId.length > 0 &&
    typeof gate.fusionSessionId === "string" && gate.fusionSessionId.length > 0;
}

function validatePrivateEvidenceDirectory(directory) {
  const absolute = path.resolve(directory);
  const stat = fs.lstatSync(absolute);
  if (!absolute.startsWith(`${TEMP_ROOT}${path.sep}`) || !stat.isDirectory() || stat.isSymbolicLink() ||
      fs.realpathSync(absolute) !== absolute || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("Native evidence directory must be an owned mode-0700 real subdirectory of /tmp/opencode");
  }
  return absolute;
}

function summarizeQueue(status) {
  const control = status?.control || {};
  return {
    phase: control.phase || status?.phase || status?.state || null,
    buildHash: status?.buildHash || null,
    active: status?.active ?? null,
    blocked: status?.blocked ? { id: status.blocked.id || null, code: status.blocked.code || null } : null,
    lease: status?.lease ? { id: status.lease.id || null } : null,
    unresolved: control.unresolved ?? status?.unresolved ?? null,
    activeOperations: control.activeOperations ?? status?.activeOperations ?? null,
    nonterminalJobCount: status?.nonterminalJobCount ?? null,
    paused: status?.paused ?? null,
  };
}

function nativeRequestId(runId, phase) {
  return `native-${crypto.createHash("sha256").update(`${runId}:${phase}`).digest("hex").slice(0, 40)}`;
}

function writePrivateJson(file, value) {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  return { path: path.basename(file), sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function cleanupEvidence(cleanup) {
  const digestDocuments = (documents) => crypto.createHash("sha256").update(JSON.stringify(
    (documents || []).map(({ creationId, name, isSaved, isModified }) =>
      ({ creationId, name, isSaved, isModified })).sort((a, b) => a.creationId.localeCompare(b.creationId)))).digest("hex");
  return {
    status: cleanup.status,
    sequenceId: cleanup.sequenceId || null,
    requestId: cleanup.requestId || null,
    jobId: cleanup.jobId || null,
    jobs: cleanup.jobs || [],
    requestIds: cleanup.requestIds || null,
    releaseStatus: cleanup.releaseStatus || "not-run",
    documentCreationId: cleanup.documentCreationId || null,
    ownScratchAbsent: cleanup.ownScratchAbsent === true,
    protectedDocumentsUnchanged: cleanup.protectedDocumentsUnchanged === true,
    activeDocumentRestored: cleanup.activeDocumentRestored === true,
    expectedActiveCreationId: cleanup.expectedActiveCreationId ?? null,
    activeAfter: cleanup.activeAfter || null,
    protectedBeforeCount: (cleanup.before || []).filter((row) => row.creationId !== cleanup.documentCreationId).length,
    protectedAfterCount: (cleanup.after || []).filter((row) => row.creationId !== cleanup.documentCreationId).length,
    protectedBeforeSha256: digestDocuments((cleanup.before || []).filter((row) => row.creationId !== cleanup.documentCreationId)),
    protectedAfterSha256: digestDocuments((cleanup.after || []).filter((row) => row.creationId !== cleanup.documentCreationId)),
    reason: cleanup.reason || null,
  };
}

function updateLedger(file, ledger) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(ledger, null, 2) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function buildFeatureArgs(feature, document, gate, bindings, runId) {
  const prefix = `NQ${crypto.createHash("sha256").update(`${runId}:${feature.id}`).digest("hex").slice(0, 10).toUpperCase()}`;
  switch (feature.execution.argsProfile) {
    case "section-witness-shapes-v1": {
      const fixture = readJsonFile(path.join(ROOT, "tests/fixtures/section_witness_shapes.json"));
      return { ...fixture, approved: true, creationId: document.creationId,
        expectedFusionVersion: gate.runtime.fusionBuild, fixturePrefix: prefix };
    }
    case "native-body-containment-v1":
      return { approved: true, creationId: document.creationId,
        expectedFusionVersion: gate.runtime.fusionBuild, fixturePrefix: prefix };
    case "drive-motion-link-v1":
      return { approved: true, creationId: document.creationId,
        expectedFusionVersion: gate.runtime.fusionBuild, fixturePrefix: prefix,
        expectedRatio: 1, expectedPhase: 0,
        expectationSource: "integrated-fixture-contract: one-to-one, zero-phase" };
    case "semantic-model-state-v1": {
      const binding = bindings.features?.[feature.id];
      if (!binding?.args || binding.ownedByRun !== true || !binding.document?.name ||
          binding.document.creationId !== document.creationId || !binding.document.projectId ||
          !binding.document.folderId || !binding.document.fileId || !binding.document.version ||
          !binding.document.fileName || !Object.hasOwn(binding, "expectedActiveAfterClose")) {
        throw new Error("Semantic qualification requires an exact owned saved-scratch binding and expectedActiveAfterClose");
      }
      const probe = binding.capabilityProbe;
      if (!probe || probe.status !== "partial" || probe.identity !== "verified" ||
          probe.build !== gate.runtime.fusionBuild || !probe.jobId || !probe.requestId) {
        throw new Error("Semantic qualification requires a fresh pinned capability-probe receipt");
      }
      return { ...binding.args, confirmNativeQualification: true, runId,
        fixturePrefix: prefix, documentName: document.name,
        documentFileName: binding.document.fileName,
        projectId: binding.document.projectId, folderId: binding.document.folderId,
        fileId: binding.document.fileId, creationId: binding.document.creationId,
        version: binding.document.version, expectedFusionBuild: gate.runtime.fusionBuild,
        capabilityProbeRequestId: probe.requestId, capabilityProbeJobId: probe.jobId,
        capabilityProbeBuild: probe.build, capabilityProbeStatus: probe.status,
        capabilityProbeIdentity: probe.identity };
    }
    default:
      throw new Error(`No argument adapter for native profile ${feature.execution.argsProfile}`);
  }
}

function reportCases(feature, report, cleanup) {
  const statusField = feature.execution.resultStatusField;
  const overall = report?.[statusField];
  const passFail = (check, expected) => {
    if (!check || typeof check.status !== "string") return null;
    if (check.status === expected) return true;
    return ["unknown", "incomplete", "notEvaluated"].includes(check.status) ? null : false;
  };
  const same = (actual, expected) => actual === undefined ? null : actual === expected;
  const all = (...values) => values.some((value) => value === false) ? false :
    values.every((value) => value === true) ? true : null;
  const cleanupPass = cleanup?.status === "pass" ? all(cleanup.ownScratchAbsent === true,
    cleanup.protectedDocumentsUnchanged === true, cleanup.activeDocumentRestored === true) :
    cleanup?.status === "fail" ? false : null;
  const semanticChecks = report?.checks || [];
  const semanticPass = (...names) => {
    const checks = names.map((name) => semanticChecks.find((check) => check.name === name));
    return all(...checks.map((check) => check ? check.passed === true : null));
  };
  const sectionCases = report?.cases || {};
  const regionalCases = report?.cases || {};
  const driveCases = report?.cases || {};
  const fastenerCases = report?.cases || {};
  const source = {
    "section-witnesses": {
      "material-and-void-positive-negative": all(passFail(sectionCases["material-pass"], "pass"),
        passFail(sectionCases["void-pass"], "pass"), passFail(sectionCases["void-fail"], "fail")),
      "missing-sector-and-axial-gap-negative": all(passFail(sectionCases["missing-sector-fail"], "fail"),
        passFail(sectionCases["gap-between-stations-fail"], "fail")),
      "closed-loops-and-discrete-coverage": all(
        same(sectionCases["closed-ring-sections"]?.status, "complete"),
        same(sectionCases["closed-ring-sections"]?.coverage, "partial"),
        same(sectionCases["closed-c-section-missing-sector"]?.status, "complete"),
        same(sectionCases["closed-c-section-missing-sector"]?.coverage, "partial")),
      "open-wire-kernel-error-and-frame-rejection": all(
        passFail(sectionCases["native-open-wire-kernel-error"], "rejected"),
        passFail(sectionCases["frame-mismatch"], "rejected")),
      "unknown-intersection-and-tangent-remain-unknown": all(
        passFail(sectionCases["empty-intersection"], "unknown"),
        passFail(sectionCases["tangent-degenerate-kernel-result"], "unknown")),
      "owned-scratch-restore-and-cleanup": cleanupPass,
    },
    "regional-geometry": {
      "inside-mask-positive": passFail(regionalCases["inside-mask-positive"], "pass"),
      "outside-mask-negative": passFail(regionalCases["outside-mask-negative"], "fail"),
      "equal-volume-outside-mask-negative": passFail(regionalCases["equal-volume-outside-mask-negative"], "fail"),
      "mask-union-exclusion-and-overlap": all(passFail(regionalCases["mask-union-exclusion-positive"], "pass"),
        passFail(regionalCases["overlapping-mask-union-positive"], "pass"),
        passFail(regionalCases["protected-region-precedence-negative"], "fail")),
      "mask-hole-negative": passFail(regionalCases["excluded-mask-hole-negative"], "fail"),
      "temporary-copy-does-not-modify-source": all(passFail(regionalCases["temporary-copies-leave-document-unchanged"], "pass"),
        same(report?.modelUnchangedDuringEvidence, true)),
      "owned-scratch-restore-and-cleanup": cleanupPass,
    },
    containment: {
      "native-body-inside-outside-boundary": passFail(report?.cases?.["native-body-inside-outside-boundary"], "pass"),
      "temporary-copy-leaves-document-unchanged": all(passFail(report?.cases?.["temporary-copy-leaves-document-unchanged"], "pass"),
        same(report?.modelUnchangedDuringEvidence, true)),
      "owned-scratch-restore-and-cleanup": cleanupPass,
    },
    "native-drive-test": {
      "disconnected-or-wrong-follower-detected": passFail(driveCases["disconnected-follower-detected"], "pass"),
      "native-driver-and-follower-readback": all(passFail(driveCases["native-joint-readback"], "pass"),
        passFail(driveCases["linked-driver-positive"], "pass")),
      "joint-and-transform-restore-readback": passFail(driveCases["driver-restore-readback"], "pass"),
      "owned-scratch-restore-and-cleanup": cleanupPass,
    },
    "measured-fasteners": {
      "declared-stack-versus-real-engagement-bottoming-negative": all(passFail(fastenerCases["bottoming-negative-even-with-legacy-pass"], "pass"),
        passFail(fastenerCases["short-bolt-minimum-engagement-negative"], "pass")),
      "measurement-source-frame-and-coverage": all(passFail(fastenerCases["measurement-source-frame-and-coverage"], "pass"),
        passFail(fastenerCases["baseline-native-engagement"], "pass"),
        passFail(fastenerCases["misaligned-native-axes-negative"], "pass")),
      "missing-native-measurement-remains-unknown": passFail(fastenerCases["missing-native-measurement-remains-unknown"], "pass"),
      "legacy-stack-compatibility": passFail(fastenerCases["declared-stack-is-separate"], "pass"),
      "owned-scratch-restore-and-cleanup": all(cleanupPass,
        passFail(fastenerCases["model-and-save-state-unchanged"], "pass")),
    },
    "motion-link": {
      "native-motion-link-created-from-pinned-joints": passFail(driveCases["native-motion-link-readback"], "pass"),
      "link-and-joint-native-readback": all(passFail(driveCases["native-motion-link-readback"], "pass"),
        passFail(driveCases["native-joint-readback"], "pass")),
      "wrong-ratio-and-phase-negative": all(passFail(driveCases["wrong-ratio-negative"], "pass"),
        passFail(driveCases["wrong-phase-negative"], "pass")),
      "joint-state-restored": passFail(driveCases["driver-restore-readback"], "pass"),
      "owned-scratch-restore-and-cleanup": cleanupPass,
    },
    "semantic-model-state": {
      "reorder-does-not-create-false-change": semanticPass("reorder stable"),
      "moved-instance-change-is-detected": semanticPass("repeated instance move detected"),
      "independent-frame-audit-and-transform2": all(
        semanticChecks.some((check) => /independent native\/proxy\/BRep/.test(check.name)) ?
          semanticPass(semanticChecks.find((check) => /independent native\/proxy\/BRep/.test(check.name)).name) : null,
        semanticPass("native pose restored")),
      "owned-scratch-restore-and-cleanup": all(same(report?.restored, true),
        same(report?.restoration?.pose, "verified-by-independent-capture"),
        same(report?.restoration?.visibility, "readback-confirmed"), cleanupPass),
    },
  }[feature.id];
  if (!source) return feature.requiredCases.map((id) => ({ id, status: "NOTRUN", observation: "No case-level adapter", source: null }));
  return feature.requiredCases.map((id) => {
    const matched = source[id];
    if (matched === undefined) return { id, status: "NOTRUN", observation: "No verified case mapping" };
    const passed = matched;
    const status = passed === true ? "PASS" : passed === false ? "FAIL" : "NOTRUN";
    return { id, status, observation: passed ? "Runner-specific native assertion matched" : `Runner=${overall || "missing"}; case assertion did not match` };
  });
}

function featureGroups(manifest) {
  const groups = new Map();
  for (const feature of manifest.features) {
    if (feature.execution?.kind !== "fmcad-run") continue;
    const id = feature.execution.suiteId || feature.id;
    const current = groups.get(id);
    if (current && (current.execution.script !== feature.execution.script ||
        current.execution.argsProfile !== feature.execution.argsProfile || current.execution.scratchMode !== feature.execution.scratchMode ||
        current.execution.documentPrefix !== feature.execution.documentPrefix)) {
      throw new Error(`Incompatible execution descriptors share suite ${id}`);
    }
    if (current) current.features.push(feature);
    else groups.set(id, { id, execution: feature.execution, features: [feature] });
  }
  return [...groups.values()];
}

function resultWrapper(nativeResult) {
  if (!nativeResult || nativeResult.success !== true || !nativeResult.result || typeof nativeResult.result !== "object") return null;
  return nativeResult.result;
}

async function runNativeSweep({ manifest, candidateCommit, workingTreeClean, evidenceDir,
  gateReceipt, bindings, port, optIn }) {
  if (optIn !== true) return { status: "blocked", reason: "Explicit --run-native opt-in is required", features: [] };
  try { validatePrivateEvidenceDirectory(evidenceDir); }
  catch (error) { return { status: "blocked", reason: error.message, features: [] }; }
  if (!releasedGateMatches(gateReceipt, manifest, candidateCommit)) {
    return { status: "blocked", reason: gateReceipt?.reason || "Fresh hash-identified coordinator receipt does not match candidate/session/recovery contract", features: [] };
  }
  if (!workingTreeClean) return { status: "blocked", reason: "Candidate source tree must be clean before native dispatch", features: [] };
  if (bindings?.integrationRunId !== gateReceipt.gate.integrationRunId ||
      bindings?.fusionSessionId !== gateReceipt.gate.fusionSessionId) {
    return { status: "blocked", reason: "Bindings do not match the coordinator run/session", features: [] };
  }
  const groups = featureGroups(manifest);
  if (!groups.length) {
    return { status: "NOTRUN", reason: "No feature has a safe runnable adapter under the declared scope",
      features: manifest.features.map((feature) => ({ id: feature.id, ticket: feature.ticket,
        status: "NOTRUN", reason: feature.deferredAdapter?.unsupportedReason || feature.entrypointNote ||
          "No integrated broker-safe native entrypoint",
        ...(feature.deferredAdapter ? { unsupportedCapability: feature.deferredAdapter.capability } : {}) })) };
  }
  const ledgerPath = path.join(evidenceDir, "dispatch-ledger.json");
  if (fs.existsSync(ledgerPath)) return { status: "blocked", requiresReconciliation: true,
    reason: "Dispatch ledger already exists; no replay or resume is allowed", features: [] };
  const runId = gateReceipt.gate.integrationRunId;
  const sessionId = gateReceipt.gate.fusionSessionId;
  const ledger = { schemaVersion: 1, candidateCommit, integrationRunId: runId, fusionSessionId: sessionId,
    state: "preflight", steps: [], createdDocuments: [], stoppedForUnknown: false };
  writePrivateJson(ledgerPath, ledger);
  let status;
  try { status = await port.status(); }
  catch (error) { status = { error: error.message }; }
  const initialQueueClear = queueIsClear(status, gateReceipt.gate.runtime.buildHash);
  const initialQueueState = initialQueueClear ? "succeeded" : status?.error || status?.status ? "unknown" : "blocked";
  ledger.steps.push({ kind: "queue-status", state: initialQueueState,
    buildHash: status.buildHash || null, revision: status.revision ?? null });
  updateLedger(ledgerPath, ledger);
  if (!initialQueueClear) {
    ledger.state = initialQueueState === "unknown" ? "unknown" : "blocked";
    ledger.stoppedForUnknown = initialQueueState === "unknown";
    ledger.reason = "Fresh queue status does not match the released build/clear-state receipt";
    updateLedger(ledgerPath, ledger);
    return { status: initialQueueState === "unknown" ? "NOTRUN" : "blocked",
      requiresReconciliation: ledger.stoppedForUnknown, reason: ledger.reason,
      observedQueue: summarizeQueue(status), features: [],
      ledger: path.basename(ledgerPath) };
  }
  const initialInventoryRequestId = nativeRequestId(runId, "document-inventory");
  const initialInventoryStep = ledger.steps.length;
  ledger.steps.push({ kind: "document-inventory", requestId: initialInventoryRequestId, state: "submitting" });
  updateLedger(ledgerPath, ledger);
  let before;
  try { before = await port.listDocuments({ requestId: initialInventoryRequestId }); }
  catch (error) { before = { status: "unknown", requestId: initialInventoryRequestId, reason: error.message }; }
  ledger.steps[initialInventoryStep] = { kind: "document-inventory", requestId: initialInventoryRequestId,
    jobId: before.jobId || null, state: before.status || "unknown", ...(before.reason ? { reason: before.reason } : {}) };
  updateLedger(ledgerPath, ledger);
  if (before.status !== "succeeded") {
    ledger.state = before.status === "unknown" ? "unknown" : "failed";
    ledger.stoppedForUnknown = before.status === "unknown";
    ledger.reason = "Fresh open-document inventory failed before setup";
    updateLedger(ledgerPath, ledger);
    return { status: before.status === "unknown" ? "NOTRUN" : "FAIL", reason: ledger.reason,
      requiresReconciliation: ledger.stoppedForUnknown, ledger: path.basename(ledgerPath), features: [] };
  }
  ledger.state = "running";
  updateLedger(ledgerPath, ledger);
  const features = manifest.features.map((feature) => ({ id: feature.id, ticket: feature.ticket,
    status: "NOTRUN", reason: feature.execution ? "Not dispatched" :
      (feature.deferredAdapter?.unsupportedReason || feature.entrypointNote || "No integrated broker-safe native entrypoint"),
    ...(feature.deferredAdapter ? { unsupportedCapability: feature.deferredAdapter.capability,
      requiredPins: feature.deferredAdapter.requiredPins } : {}) }));
  const featureStatus = new Map(features.map((row) => [row.id, row]));
  const requestIds = new Set([initialInventoryRequestId]);
  const createdBySlot = new Map();
  const baselineBySlot = new Map();
  const expectedActiveBySlot = new Map();
  async function recordStep(kind, requestId, outcome) {
    if (typeof requestId !== "string" || !requestId) throw new Error(`Missing requestId for ${kind}`);
    if (requestIds.has(requestId)) throw new Error(`Duplicate requestId prevented: ${requestId}`);
    requestIds.add(requestId);
    ledger.steps.push({ kind, requestId, state: outcome.status,
      ...(outcome.jobId ? { jobId: outcome.jobId } : {}), ...(outcome.reason ? { reason: outcome.reason } : {}) });
    updateLedger(ledgerPath, ledger);
  }

  function planStep(kind, requestId, details = {}) {
    if (typeof requestId !== "string" || !requestId || requestIds.has(requestId)) {
      throw new Error(`Missing or duplicate requestId prevented for ${kind}`);
    }
    requestIds.add(requestId);
    const index = ledger.steps.length;
    ledger.steps.push({ kind, requestId, state: "submitting", ...details });
    updateLedger(ledgerPath, ledger);
    return index;
  }

  function finishStep(index, kind, requestId, outcome, details = {}) {
    ledger.steps[index] = { kind, requestId, state: outcome.status,
      ...(outcome.jobId ? { jobId: outcome.jobId } : {}), ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...details };
    updateLedger(ledgerPath, ledger);
  }

  async function checkQueueAtBoundary(stage, featureRows) {
    let observed;
    try { observed = await port.status(); }
    catch (error) { observed = { error: error.message }; }
    const clear = queueIsClear(observed, gateReceipt.gate.runtime.buildHash);
    const state = clear ? "succeeded" : observed?.error || observed?.status ? "unknown" : "blocked";
    ledger.steps.push({ kind: "queue-boundary", stage, state, queue: summarizeQueue(observed) });
    updateLedger(ledgerPath, ledger);
    if (clear) return true;
    for (const feature of featureRows) Object.assign(featureStatus.get(feature.id), {
      status: "NOTRUN", reason: `Queue was not freshly clear at ${stage}; no further native work was submitted`,
      ...(state === "unknown" ? { requiresReconciliation: true } : {}),
    });
    ledger.state = state === "unknown" ? "unknown" : "blocked";
    ledger.stoppedForUnknown = state === "unknown";
    ledger.reason = `Queue state was not clear at ${stage}`;
    updateLedger(ledgerPath, ledger);
    return false;
  }

  for (const group of groups) {
    const { execution, features: groupFeatures } = group;
    if (!await checkQueueAtBoundary(`before ${group.id} setup`, groupFeatures)) break;
    if (execution.requiredBuild && execution.requiredBuild !== gateReceipt.gate.runtime.fusionBuild) {
      for (const feature of groupFeatures) featureStatus.get(feature.id).reason =
        `Entrypoint is pinned to Fusion ${execution.requiredBuild}, coordinator released ${gateReceipt.gate.runtime.fusionBuild}`;
      continue;
    }
    let document;
    if (execution.scratchMode === "fresh-unsaved") {
      document = createdBySlot.get(groupFeatures[0].scratchSlot);
      if (!document) {
        const suffix = crypto.createHash("sha256").update(`${runId}:${groupFeatures[0].scratchSlot}`).digest("hex").slice(0, 8).toUpperCase();
        const name = `${execution.documentPrefix}${suffix}`;
        const baselineRequestId = nativeRequestId(runId, `doc-list-before-new:${group.id}`);
        const baselineStepIndex = planStep("doc-list-before-new", baselineRequestId, { suiteId: group.id });
        let baseline;
        try { baseline = await port.listDocuments({ requestId: baselineRequestId }); }
        catch (error) { baseline = { status: "unknown", requestId: baselineRequestId, reason: error.message }; }
        finishStep(baselineStepIndex, "doc-list-before-new", baselineRequestId, {
          status: baseline.status, jobId: baseline.jobId, reason: baseline.reason,
        }, { suiteId: group.id });
        if (baseline.status !== "succeeded") {
          for (const feature of groupFeatures) Object.assign(featureStatus.get(feature.id), {
            status: "NOTRUN", reason: "Fresh pre-creation inventory did not complete; no scratch was created",
            requiresReconciliation: baseline.status === "unknown" });
          ledger.state = baseline.status === "unknown" ? "unknown" : "failed";
          ledger.stoppedForUnknown = baseline.status === "unknown";
          ledger.reason = "Pre-creation inventory failed; no create/cleanup retry was attempted";
          updateLedger(ledgerPath, ledger);
          break;
        }
        const baselineStable = baseline.documents.length === before.documents.length &&
          preservedDocuments(before.documents, baseline.documents);
        if (!baselineStable) {
          for (const feature of groupFeatures) featureStatus.get(feature.id).reason =
            "Open-document inventory changed since the run baseline; no scratch was created";
          ledger.state = "blocked"; ledger.reason = "Protected document inventory drifted before scratch creation";
          updateLedger(ledgerPath, ledger);
          break;
        }
        if (baseline.documents.some((row) => row.name === name)) {
          for (const feature of groupFeatures) featureStatus.get(feature.id).reason =
            `Generated scratch name already exists; no document was created: ${name}`;
          continue;
        }
        baselineBySlot.set(groupFeatures[0].scratchSlot, baseline.documents);
        expectedActiveBySlot.set(groupFeatures[0].scratchSlot,
          baseline.documents.find((row) => row.isActive === true)?.creationId || null);
        const createRequestId = nativeRequestId(runId, `doc-new:${groupFeatures[0].scratchSlot}`);
        const afterListRequestId = nativeRequestId(runId, `doc-list-after-new:${name}`);
        const createStepIndex = planStep("doc-new", createRequestId, { suiteId: group.id });
        const afterListStepIndex = planStep("doc-list-after-new", afterListRequestId, { suiteId: group.id });
        let created;
        try { created = await port.createScratch({ name, runId, baselineDocuments: baseline.documents,
          baselineRequestId, baselineJobId: baseline.jobId,
          requestId: createRequestId, afterListRequestId }); }
        catch (error) { created = { status: "unknown", reason: error.message, requestId: createRequestId }; }
        finishStep(createStepIndex, "doc-new", createRequestId, {
          status: created.createStatus || created.status,
          jobId: created.createJobId || created.jobId, reason: created.reason,
        }, { suiteId: group.id });
        finishStep(afterListStepIndex, "doc-list-after-new", afterListRequestId, {
          status: created.listStatus || (created.status === "failed" ? "not-run" : created.status),
          jobId: created.listJobId, reason: created.reason,
        }, { suiteId: group.id });
        if (created.status !== "succeeded" || !created.document) {
          for (const feature of groupFeatures) {
            Object.assign(featureStatus.get(feature.id), {
              status: "NOTRUN",
              reason: "Scratch creation did not produce a terminal exact identity",
              requiresReconciliation: created.status === "unknown" });
            if (created.status === "unknown") writePrivateJson(path.join(evidenceDir, `${feature.id}.json`), {
              featureId: feature.id, candidateCommit, integrationRunId: runId, fusionSessionId: sessionId,
              requiresReconciliation: true, requestId: created.requestId || createRequestId,
              reason: "Scratch creation has no exact terminal document pin; do not retry or search for a partial document.",
            });
          }
          ledger.stoppedForUnknown = created.status === "unknown";
          ledger.state = created.status === "unknown" ? "unknown" : "failed";
          ledger.stoppedForUnknown = created.status === "unknown";
          ledger.reason = created.reason || "Scratch creation failed; no retry or cleanup was attempted";
          updateLedger(ledgerPath, ledger);
          break;
        }
        document = created.document;
        createdBySlot.set(groupFeatures[0].scratchSlot, document);
        baselineBySlot.set(groupFeatures[0].scratchSlot, created.baselineDocuments || []);
        expectedActiveBySlot.set(groupFeatures[0].scratchSlot,
          (created.baselineDocuments || []).find((row) => row.isActive === true)?.creationId || null);
        ledger.createdDocuments.push({ name: document.name, creationId: document.creationId });
        updateLedger(ledgerPath, ledger);
      }
    } else if (execution.scratchMode === "prebound-saved-empty") {
      const binding = bindings.features?.[groupFeatures[0].id];
      document = binding?.document;
      if (!binding?.ownedByRun || !document?.name || !document.creationId || document.isSaved !== true ||
          document.isModified !== false || !Object.hasOwn(binding, "expectedActiveAfterClose")) {
        for (const feature of groupFeatures) featureStatus.get(feature.id).reason =
          "An exact owned saved-scratch binding with expectedActiveAfterClose is required";
        continue;
      }
      const baselineRequestId = nativeRequestId(runId, `doc-list-before-run:${group.id}`);
      const preboundStepIndex = planStep("doc-list-before-run", baselineRequestId, { suiteId: group.id });
      let currentInventory;
      try { currentInventory = await port.listDocuments({ requestId: baselineRequestId }); }
      catch (error) { currentInventory = { status: "unknown", requestId: baselineRequestId, reason: error.message }; }
      finishStep(preboundStepIndex, "doc-list-before-run", baselineRequestId, {
        status: currentInventory.status, jobId: currentInventory.jobId, reason: currentInventory.reason,
      }, { suiteId: group.id });
      if (currentInventory.status !== "succeeded") {
        for (const feature of groupFeatures) Object.assign(featureStatus.get(feature.id), {
          status: "NOTRUN", reason: "Prebound document inventory is unresolved; semantic run was not submitted",
          requiresReconciliation: currentInventory.status === "unknown" });
        if (currentInventory.status === "unknown") {
          ledger.stoppedForUnknown = true; ledger.state = "unknown"; updateLedger(ledgerPath, ledger); break;
        }
        continue;
      }
      const matched = currentInventory.documents.find((row) => row.creationId === document.creationId && row.name === document.name);
      if (!matched || matched.isSaved !== true || matched.isModified !== false) {
        for (const feature of groupFeatures) featureStatus.get(feature.id).reason =
          "Prebound saved scratch is absent or not blank in the fresh inventory";
        continue;
      }
      document = { ...document, ...matched };
      baselineBySlot.set(groupFeatures[0].scratchSlot, currentInventory.documents);
      expectedActiveBySlot.set(groupFeatures[0].scratchSlot, binding.expectedActiveAfterClose);
      if (binding.expectedActiveAfterClose !== null &&
          !currentInventory.documents.some((row) => row.creationId === binding.expectedActiveAfterClose &&
            row.creationId !== document.creationId)) {
        for (const feature of groupFeatures) featureStatus.get(feature.id).reason =
          "expectedActiveAfterClose does not identify another open document";
        continue;
      }
      ledger.createdDocuments.push({ name: document.name, creationId: document.creationId, prebound: true });
    } else {
      for (const feature of groupFeatures) featureStatus.get(feature.id).reason =
        `Unsupported scratch mode ${execution.scratchMode}`;
      continue;
    }

    let probeReceipt = null;
    if (execution.argsProfile === "semantic-model-state-v1") {
      if (!await checkQueueAtBoundary("before semantic capability probe", groupFeatures)) break;
      const probeRequestId = nativeRequestId(runId, `probe:${group.id}`);
      ledger.steps.push({ kind: "capabilities.probe", requestId: probeRequestId, state: "submitting",
        suiteId: group.id, docId: document.creationId });
      updateLedger(ledgerPath, ledger);
      let probe;
      try { probe = await port.capabilityProbe({ document, capabilityId: execution.probeCapabilityId,
        runId, requestId: probeRequestId }); }
      catch (error) { probe = { status: "unknown", requestId: probeRequestId, reason: error.message }; }
      ledger.steps[ledger.steps.length - 1] = { kind: "capabilities.probe", requestId: probeRequestId,
        state: probe.status, jobId: probe.jobId || null, suiteId: group.id, docId: document.creationId };
      updateLedger(ledgerPath, ledger);
      if (probe.status === "unknown") {
        for (const feature of groupFeatures) {
          Object.assign(featureStatus.get(feature.id), {
            status: "NOTRUN", reason: "Pinned capability probe outcome is unknown; no native run or replay",
            requiresReconciliation: true });
          writePrivateJson(path.join(evidenceDir, `${feature.id}.json`), {
            featureId: feature.id, candidateCommit, integrationRunId: runId, fusionSessionId: sessionId,
            document: { name: document.name, creationId: document.creationId },
            requiresReconciliation: true, requestId: probe.requestId || probeRequestId,
            reason: "Pinned capability-probe request has no terminal receipt; do not rerun it.",
          });
        }
        ledger.stoppedForUnknown = true; ledger.state = "unknown"; updateLedger(ledgerPath, ledger); break;
      }
      if (probe.status !== "succeeded" || probe.operationStatus !== "partial" ||
          probe.probe?.identity !== "verified" || probe.probe?.build !== gateReceipt.gate.runtime.fusionBuild) {
        for (const feature of groupFeatures) Object.assign(featureStatus.get(feature.id), {
          status: "NOTRUN", reason: probe.reason || "Fresh pinned capability probe did not verify the released runtime/document" });
        continue;
      }
      const semanticBinding = bindings.features?.[groupFeatures[0].id];
      if (!semanticBinding) {
        for (const feature of groupFeatures) featureStatus.get(feature.id).reason =
          "Owned semantic scratch metadata is missing from the one-run bindings file";
        continue;
      }
      semanticBinding.capabilityProbe = { status: probe.operationStatus, identity: probe.probe.identity,
        build: probe.probe.build, jobId: probe.jobId, requestId: probe.requestId };
      probeReceipt = { requestId: probe.requestId, jobId: probe.jobId,
        docId: document.creationId, status: "succeeded" };
    }

    let args;
    try { args = buildFeatureArgs(groupFeatures[0], document, gateReceipt.gate, bindings, runId); }
    catch (error) {
      for (const feature of groupFeatures) featureStatus.get(feature.id).reason = error.message;
      continue;
    }
    const suiteId = group.id;
    if (!await checkQueueAtBoundary(`before ${suiteId} native dispatch`, groupFeatures)) break;
    const requestId = nativeRequestId(runId, `run:${suiteId}`);
    ledger.steps.push({ kind: "fmcad-run", requestId, state: "submitting", suiteId, docId: document.creationId });
    updateLedger(ledgerPath, ledger);
    let queued;
    try { queued = await port.runScript({ script: execution.script, document, args,
      runId, suiteId, requestId, timeout: execution.timeoutMs }); }
    catch (error) { queued = { status: "unknown", requestId, docId: document.creationId, reason: error.message }; }
    await recordStep("fmcad-run", requestId, queued);
    if (queued.status === "unknown") {
      for (const feature of groupFeatures) {
        Object.assign(featureStatus.get(feature.id), {
          status: "NOTRUN", reason: "Native job outcome is unknown; no replay, cleanup, or later dispatch",
          requiresReconciliation: true });
        writePrivateJson(path.join(evidenceDir, `${feature.id}.json`), {
          featureId: feature.id, candidateCommit, integrationRunId: runId, fusionSessionId: sessionId,
          requiresReconciliation: true, requestId: queued.requestId || requestId,
          reason: "The exact native job has no terminal receipt; do not replay or clean up.",
        });
      }
      ledger.stoppedForUnknown = true; ledger.state = "unknown"; updateLedger(ledgerPath, ledger); break;
    }
    if (queued.status !== "succeeded") {
      for (const feature of groupFeatures) writePrivateJson(path.join(evidenceDir, `${feature.id}.json`), {
          featureId: feature.id, candidateCommit, integrationRunId: runId,
          fusionSessionId: sessionId, fusionBuild: gateReceipt.gate.runtime.fusionBuild,
        document: { name: document.name, creationId: document.creationId },
        jobs: [...(probeReceipt ? [probeReceipt] : []),
          { requestId: queued.requestId, jobId: queued.jobId, docId: document.creationId, status: queued.status }],
      });
      for (const feature of groupFeatures) Object.assign(featureStatus.get(feature.id), {
        status: "FAIL", reason: "Native script job terminated unsuccessfully; owned scratch remains open for inspection" });
      const afterFailure = await port.status();
      if (!queueIsClear(afterFailure, gateReceipt.gate.runtime.buildHash)) {
        ledger.state = "blocked"; updateLedger(ledgerPath, ledger); break;
      }
      continue;
    }
    const report = resultWrapper(queued.fmcadResult);
    const reportDocumentId = report?.document?.creationId ?? report?.documentIdentity?.creationId;
    if (!report || reportDocumentId !== document.creationId) {
      const missingArtifact = writePrivateJson(path.join(evidenceDir, `${suiteId}-missing-report.json`), {
        requestId: queued.requestId, jobId: queued.jobId, jobStatus: queued.status,
        docId: document.creationId, result: queued.fmcadResult || null,
      });
      for (const feature of groupFeatures) {
        Object.assign(featureStatus.get(feature.id), {
          status: "NOTRUN", reason: "Terminal run returned no verified feature report for its pinned document; scratch retained for inspection",
          requiresInspection: true });
        writePrivateJson(path.join(evidenceDir, `${feature.id}.json`), {
          featureId: feature.id, candidateCommit, integrationRunId: runId,
          fusionSessionId: sessionId, fusionBuild: gateReceipt.gate.runtime.fusionBuild,
          document: { name: document.name, creationId: document.creationId },
          jobs: [...(probeReceipt ? [probeReceipt] : []),
            { requestId: queued.requestId, jobId: queued.jobId, docId: document.creationId, status: "succeeded" }],
          cases: feature.requiredCases.map((id) => ({ id, status: "NOTRUN",
            observation: "Missing or misbound native report", jobId: queued.jobId,
            evidence: [missingArtifact.path] })),
          artifacts: [missingArtifact],
        });
      }
      ledger.stoppedForUnknown = true; ledger.state = "unknown";
      ledger.reason = "Terminal native job lacks a report bound to the exact pinned document";
      updateLedger(ledgerPath, ledger);
      break;
    }
    const nativeStatus = report[execution.resultStatusField];
    const runCases = groupFeatures.map((feature) => reportCases(feature, report));
    const runStatuses = runCases.map((rows) => {
      const behavior = rows.filter((row) => row.id !== "owned-scratch-restore-and-cleanup");
      if (behavior.some((row) => row.status === "FAIL")) return "FAIL";
      if (nativeStatus === "fail") return "FAIL";
      return nativeStatus === "pass" && behavior.length && behavior.every((row) => row.status === "PASS")
        ? "PASS" : "NOTRUN";
    });
    const nativePass = nativeStatus === "pass" && runStatuses.every((status) => status === "PASS");
    if (!nativePass) {
      const rawArtifact = writePrivateJson(path.join(evidenceDir, `${suiteId}-native-result.json`), {
        requestId: queued.requestId, jobId: queued.jobId, jobStatus: queued.status,
        docId: document.creationId, capabilityProbe: probeReceipt, result: queued.fmcadResult,
      });
      for (const [index, feature] of groupFeatures.entries()) {
        const status = nativeStatus === "fail" ? "FAIL" :
          ["unknown", "incomplete", "fail-or-unknown"].includes(nativeStatus) ? "NOTRUN" : runStatuses[index];
        Object.assign(featureStatus.get(feature.id), { status,
          reason: `Native runner reported ${nativeStatus || "no qualified status"}; scratch left open for inspection` });
        writePrivateJson(path.join(evidenceDir, `${feature.id}.json`), {
          featureId: feature.id, candidateCommit, integrationRunId: runId,
          fusionSessionId: sessionId, fusionBuild: gateReceipt.gate.runtime.fusionBuild,
          document: { name: document.name, creationId: document.creationId },
          jobs: [...(probeReceipt ? [probeReceipt] : []),
            { requestId: queued.requestId, jobId: queued.jobId, docId: document.creationId, status: "succeeded" }],
          nativeRunnerStatus: nativeStatus || "unknown",
          reason: `Native runner aggregate: ${nativeStatus || "missing"}; scratch retained without cleanup.`,
          cases: runCases[index].map((row) => ({ ...row,
            observation: row.observation || nativeStatus || "runner did not report a native qualification status",
            jobId: queued.jobId, evidence: [rawArtifact.path] })),
          artifacts: [rawArtifact],
        });
      }
      const unresolvedNativeEvidence = ["unknown", "incomplete", "fail-or-unknown", undefined].includes(nativeStatus) ||
        runCases.some((rows) => rows.some((row) => row.id !== "owned-scratch-restore-and-cleanup" && row.status === "NOTRUN"));
      if (unresolvedNativeEvidence) {
        ledger.stoppedForUnknown = true;
        ledger.state = "unknown";
        ledger.reason = "At least one native case remained unknown/unrun; scratch is retained and later features are not dispatched";
        updateLedger(ledgerPath, ledger);
        for (const feature of groupFeatures) {
          const row = featureStatus.get(feature.id);
          row.requiresInspection = true;
        }
        break;
      }
      const afterFailure = await port.status();
      if (!queueIsClear(afterFailure, gateReceipt.gate.runtime.buildHash)) {
        ledger.state = "blocked"; updateLedger(ledgerPath, ledger); break;
      }
      continue;
    }
    const rawArtifact = writePrivateJson(path.join(evidenceDir, `${suiteId}-native-result.json`), {
      requestId: queued.requestId, jobId: queued.jobId, jobStatus: queued.status,
      docId: document.creationId, capabilityProbe: probeReceipt, result: queued.fmcadResult,
    });
    const cleanupRequestIds = {
      begin: nativeRequestId(runId, `cleanup-list-begin:${document.creationId}`),
      close: nativeRequestId(runId, `cleanup-close:${document.creationId}`),
      post: nativeRequestId(runId, `cleanup-list-after:${document.creationId}`),
      release: nativeRequestId(runId, `cleanup-release:${document.creationId}`),
    };
    for (const requestId of Object.values(cleanupRequestIds)) {
      if (requestIds.has(requestId)) throw new Error(`Duplicate cleanup requestId prevented: ${requestId}`);
      requestIds.add(requestId);
    }
    const cleanupStepIndex = ledger.steps.length;
    ledger.steps.push({ kind: "scratch-cleanup", requestId: cleanupRequestIds.begin,
      plannedRequestIds: cleanupRequestIds, state: "submitting", suiteId, docId: document.creationId });
    updateLedger(ledgerPath, ledger);
    let cleanup;
    try { cleanup = await port.cleanupScratch({ document,
      beforeDocuments: baselineBySlot.get(groupFeatures[0].scratchSlot) || [],
      runId,
      runnerClosedScratch: execution.scratchCleanup === "runner-closes-scratch",
      expectedActiveCreationId: expectedActiveBySlot.get(groupFeatures[0].scratchSlot),
      requestIds: cleanupRequestIds,
    }); }
    catch (error) { cleanup = { status: "unknown", reason: error.message }; }
    ledger.steps[cleanupStepIndex] = { kind: "scratch-cleanup", requestId: cleanupRequestIds.begin,
      plannedRequestIds: cleanup.requestIds || cleanupRequestIds,
      state: cleanup.status, releaseStatus: cleanup.releaseStatus || "not-run",
      suiteId, docId: document.creationId, jobs: cleanup.jobs || [],
      ...(cleanup.reason ? { reason: cleanup.reason } : {}) };
    updateLedger(ledgerPath, ledger);
    if (cleanup.status === "unknown") {
      const unresolvedArtifact = writePrivateJson(path.join(evidenceDir, `${suiteId}-cleanup-unknown.json`), cleanupEvidence(cleanup));
      for (let index = 0; index < groupFeatures.length; index += 1) {
        const feature = groupFeatures[index];
        Object.assign(featureStatus.get(feature.id), {
          status: "NOTRUN", reason: "Scratch cleanup outcome is unknown; no retry or later dispatch",
          requiresReconciliation: true });
        const caseRows = runCases[index].map((row) => ({ ...row,
          observation: row.observation || nativeStatus, jobId: queued.jobId, evidence: [rawArtifact.path] }));
        writePrivateJson(path.join(evidenceDir, `${feature.id}.json`), {
          featureId: feature.id, candidateCommit, integrationRunId: runId, fusionSessionId: sessionId,
          fusionBuild: gateReceipt.gate.runtime.fusionBuild,
          document: { name: document.name, creationId: document.creationId },
          jobs: [...(probeReceipt ? [probeReceipt] : []),
            { requestId: queued.requestId, jobId: queued.jobId, docId: document.creationId, status: "succeeded" }],
          cases: caseRows, requiresReconciliation: true,
          reason: "Owned-scratch cleanup has no terminal scoped receipt; do not replay or discard.",
          artifacts: [rawArtifact, unresolvedArtifact],
        });
      }
      ledger.stoppedForUnknown = true; ledger.state = "unknown"; updateLedger(ledgerPath, ledger); break;
    }
    if (cleanup.status !== "pass") {
      for (let index = 0; index < groupFeatures.length; index += 1) {
        const feature = groupFeatures[index];
        const caseRows = reportCases(feature, report, cleanup).map((row) => ({ ...row,
          observation: row.observation || nativeStatus, jobId: queued.jobId, evidence: [rawArtifact.path] }));
        const failed = cleanup.status === "fail" || caseRows.some((row) => row.status === "FAIL");
        Object.assign(featureStatus.get(feature.id), {
          status: failed ? "FAIL" : "NOTRUN",
          reason: cleanup.reason || "Exact owned-scratch cleanup/readback was not proven" });
        writePrivateJson(path.join(evidenceDir, `${feature.id}.json`), {
          featureId: feature.id, candidateCommit, integrationRunId: runId, fusionSessionId: sessionId,
          fusionBuild: gateReceipt.gate.runtime.fusionBuild,
          document: { name: document.name, creationId: document.creationId },
          jobs: [...(probeReceipt ? [probeReceipt] : []),
            { requestId: queued.requestId, jobId: queued.jobId, docId: document.creationId, status: "succeeded" }],
          cases: caseRows,
          artifacts: [rawArtifact],
        });
      }
      continue;
    }
    const cleanupArtifact = writePrivateJson(path.join(evidenceDir, `${suiteId}-restore.json`), cleanupEvidence(cleanup));
    for (let index = 0; index < groupFeatures.length; index += 1) {
      const feature = groupFeatures[index];
      const caseRows = reportCases(feature, report, cleanup);
      const featureStatusAfterCleanup = caseRows.some((row) => row.status === "FAIL") ? "FAIL" :
        caseRows.every((row) => row.status === "PASS") ? "PASS" : "NOTRUN";
      const proof = {
        featureId: feature.id,
        candidateCommit,
        integrationRunId: runId,
        fusionSessionId: sessionId,
        fusionBuild: gateReceipt.gate.runtime.fusionBuild,
        document: { name: document.name, creationId: document.creationId, ...(document.id ? { fileId: document.id } : {}) },
        jobs: [...(probeReceipt ? [probeReceipt] : []),
          { requestId: queued.requestId, jobId: queued.jobId, docId: document.creationId, status: "succeeded" }],
        cases: caseRows.map((row) => ({ ...row, observation: row.observation || nativeStatus,
          jobId: queued.jobId, evidence: [rawArtifact.path] })),
        restore: { status: "PASS", jobId: cleanup.jobId, requestId: cleanup.requestId,
          sequenceId: cleanup.sequenceId, jobStatus: "succeeded",
          ownScratchAbsent: cleanup.ownScratchAbsent === true,
          protectedDocumentsUnchanged: cleanup.protectedDocumentsUnchanged === true,
          activeDocumentRestored: cleanup.activeDocumentRestored === true,
          evidence: [cleanupArtifact.path] },
        artifacts: [rawArtifact, cleanupArtifact],
      };
      writePrivateJson(path.join(evidenceDir, `${feature.id}.json`), proof);
      Object.assign(featureStatus.get(feature.id), { status: featureStatusAfterCleanup,
        reason: featureStatusAfterCleanup === "PASS" ? null : "At least one required native assertion or cleanup check remains unresolved",
        document: proof.document, jobId: queued.jobId, cleanup: proof.restore });
    }
    const afterGroup = await port.status();
    if (!queueIsClear(afterGroup, gateReceipt.gate.runtime.buildHash)) {
      ledger.state = "blocked"; updateLedger(ledgerPath, ledger); break;
    }
  }
  const unresolved = ledger.stoppedForUnknown;
  if (!unresolved && ledger.state === "running") ledger.state = "complete";
  updateLedger(ledgerPath, ledger);
  const finalFeatures = [...featureStatus.values()];
  return {
    schemaVersion: 1,
    status: finalFeatures.some((row) => row.status === "FAIL") ? "FAIL" :
      finalFeatures.every((row) => row.status === "PASS") ? "PASS" : "NOTRUN",
    candidateCommit, integrationRunId: runId, fusionSessionId: sessionId,
    usedOneFusionSession: true, gate: "released-and-refreshed-before-dispatch",
    ledger: path.basename(ledgerPath), stoppedForUnknown: unresolved,
    features: finalFeatures,
    cleanupPolicy: "Only PASS reports are discarded after exact active creationId inventory in a short exclusive sequence; failures stay open, unknown outcomes halt all dispatch.",
  };
}

module.exports = { createFmcadCliPort, createPrivateWorkspace, nativeRequestId, parseDocumentList,
  executeFirstSmoke, queueIsClear, queueJob, releasedGateMatches, reportCases, runNativeSweep, validateBrokerStateHome, validateExplicitConfig,
  validatePrivateEvidenceDirectory };
