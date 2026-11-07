"use strict";

// Live Fusion runner: deliberately outside test discovery and authorization-gated.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const AUTHORIZATION = "I authorize native capture-integrity qualification";
const CLIENT_ID = "luna-max-capture:ses_e8cb16d2effenGi1025FllJcOT";
const root = path.resolve(__dirname, "../..");
const argv = process.argv.slice(2);

if (
  !argv.includes("--run") ||
  argv[argv.indexOf("--authorize") + 1] !== AUTHORIZATION
) {
  process.stderr.write(
    "Native Fusion work NOT run. Separate authorization is required.\n",
  );
  process.exitCode = 2;
} else {
  run().catch((error) => {
    process.stderr.write(
      "Capture-integrity native qualification failed: " + error.stack + "\n",
    );
    process.exitCode = 1;
  });
}

async function run() {
  const { formatRunOutput } = require(
    path.join(root, "src/run"),
  );
  const { loadConfig } = require(path.join(root, "src/config"));
  const platform = require(path.join(root, "src/dist/config-platform"));
  const application = require(
    path.join(root, "src/dist/core/application/review"),
  );
  const adapters = require(path.join(root, "src/dist/review"));
  const resumeIndex = argv.indexOf("--resume-report");
  let resume;
  if (resumeIndex !== -1) {
    const reportPath = argv[resumeIndex + 1];
    if (!reportPath || reportPath.startsWith("--"))
      throw new Error("--resume-report requires the exact prior qualification report path");
    const sourceBytes = fs.readFileSync(reportPath);
    const source = JSON.parse(sourceBytes.toString("utf8"));
    const sourceBuild = source.fusionBuild || source.preflight?.fusion?.build;
    if (source.status !== "failed" || sourceBuild !== "2706.1.14" ||
        source.cases?.length !== 0 || source.preflight?.fixtureCreationReceipt?.state !== "succeeded" ||
        source.cleanup?.status !== "failed" ||
        source.cleanup?.message !== "No owned asymmetric scratch pin is available for cleanup" ||
        !Array.isArray(source.documents) || source.documents.length !== 3)
      throw new Error("Prior report is not the known terminal fixture-create-only attempt");
    const documents = source.documents.map((row) => {
      const match = /^FMCAD_CAPTURE_([a-f0-9]{12})_(BLANK|ASYMMETRIC|SYMMETRIC)$/.exec(row.name || "");
      if (!match || !/^[0-9a-f-]{36}$/i.test(row.creationId || ""))
        throw new Error("Prior report has an invalid generated fixture identity");
      return { ...row, token: match[1], role: match[2] };
    });
    const tokens = new Set(documents.map((row) => row.token));
    const roles = new Set(documents.map((row) => row.role));
    if (tokens.size !== 1 || roles.size !== 3)
      throw new Error("Prior fixture report does not contain one complete named scratch set");
    resume = {
      reportPath: path.resolve(reportPath),
      reportSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      creationReceipt: source.preflight.fixtureCreationReceipt,
      token: documents[0].token,
      documents,
    };
  }
  const installedCli = process.env.PATH.split(path.delimiter)
    .map((directory) => path.join(directory, "fmcad"))
    .find((candidate) => {
      try { return fs.statSync(candidate).isFile(); } catch { return false; }
    });
  if (!installedCli) throw new Error("Installed public fmcad CLI was not found on PATH");
  const installedCliScript = fs.realpathSync(installedCli);
  const sharedConfig = loadConfig({}).cfg;
  if (sharedConfig.backend !== "addin" || sharedConfig.routing !== "queue")
    throw new Error("Native qualification requires the existing addin/queue route");
  const evidenceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-capture-integrity-native-"),
  );
  const configFile = {
    backend: sharedConfig.backend,
    url: sharedConfig.url,
    headers: sharedConfig.headers,
    timeoutMs: sharedConfig.timeoutMs,
    tool: sharedConfig.tool,
    transport: sharedConfig.transport,
    ...(sharedConfig.curlPath ? { curlPath: sharedConfig.curlPath } : {}),
    protocolVersion: sharedConfig.protocolVersion,
    routing: sharedConfig.routing,
    queue: { ...sharedConfig.queue, autoStart: false },
    controlCenter: sharedConfig.controlCenter,
  };
  const privateConfigPath = path.join(evidenceRoot, "queue-config.json");
  fs.writeFileSync(
    privateConfigPath,
    JSON.stringify(configFile, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  const summary = {
    status: "running",
    startedAt: new Date().toISOString(),
    fusionBuild: null,
    evidenceRoot,
    ...(resume ? { resumedFixtureAttempt: {
      reportPath: resume.reportPath,
      reportSha256: resume.reportSha256,
      creationReceipt: resume.creationReceipt,
    } } : {}),
    cases: [],
    saved: false,
    push: false,
  };
  let fixtureState;
  let fixtureAttempted = false;
  let uncertain = false;
  let preflightDocumentNames = null;
  let preflightDocuments = null;

  function runCli(args, options = {}) {
    const configArgs = options.queueAdmin
      ? ["--config", privateConfigPath, "--client", CLIENT_ID]
      : [
          "--config", privateConfigPath,
          "--client", CLIENT_ID,
          "--backend", "addin",
          "--routing", "queue",
          "--timeout", "180000",
        ];
    const sequenceArgs = options.sequence
      ? [
          "--sequence-action", options.sequence.action,
          ...(options.sequence.id ? ["--sequence-id", options.sequence.id] : []),
          ...(options.sequence.mode ? ["--sequence-mode", options.sequence.mode] : []),
        ]
      : [];
    const result = require("node:child_process").spawnSync(
      process.execPath,
      [installedCliScript, ...args, ...configArgs, ...sequenceArgs],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 210000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (
      result.error ||
      result.signal ||
      result.status === null ||
      (!result.stdout?.trim() && options.allowEmpty !== true)
    ) {
      uncertain = true;
      throw new Error(
        "Queued Fusion result is unknown; inspect, do not replay: " +
          (result.error?.message ||
            result.stderr ||
            result.signal ||
          "no response"),
      );
    }
    return result;
  }

  function parseQueueReceipt(stderr, label) {
    const line = stderr.split(/\r?\n/).find((entry) =>
      entry.startsWith("FMCAD_QUEUE_RESULT "),
    );
    if (!line) return null;
    try {
      return JSON.parse(line.slice("FMCAD_QUEUE_RESULT ".length));
    } catch (error) {
      throw new Error(`${label} queue receipt is malformed: ${error.message}`);
    }
  }

  function recordBlockedPreflight(status, message) {
    summary.status = status;
    summary.preflight = {
      ...(summary.preflight || {}),
      status,
      message,
      fusionBuild: summary.fusionBuild,
      documents: summary.preflight?.documents ?? null,
    };
    summary.finishedAt = new Date().toISOString();
    summary.saved = false;
    summary.push = false;
    try {
      fs.unlinkSync(privateConfigPath);
    } catch {}
    fs.writeFileSync(
      path.join(evidenceRoot, "qualification-report.json"),
      JSON.stringify(summary, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  }

  async function executeScript(filename, args, doc, docId, helpers, options = {}) {
    const command = ["run", filename];
    if (args !== undefined) command.push("--args", JSON.stringify(args));
    if (doc !== undefined) command.push("--doc", doc);
    if (docId !== undefined) command.push("--doc-id", docId);
    if (helpers !== undefined) command.push("--helpers", helpers);
    if (options.readOnly) command.push("--readonly");
    const response = runCli(command, options);
    let receipt;
    try {
      receipt = parseQueueReceipt(response.stderr, filename);
    } catch (error) {
      uncertain = true;
      throw error;
    }
    if (options.receiptSink) options.receiptSink.value = receipt;
    if (options.requireReceipt && !receipt) {
      uncertain = true;
      throw new Error(`${filename} returned no durable broker receipt`);
    }
    if (response.status !== 0) {
      uncertain = true;
      throw new Error(response.stderr || "Pinned Fusion script did not settle successfully");
    }
    try {
      const parsed = JSON.parse(formatRunOutput(response.stdout, "json"));
      if (parsed && typeof parsed === "object" &&
          Object.hasOwn(parsed, "helperCallsOnly")) {
        if (parsed.success !== true) {
          uncertain = true;
          throw new Error(parsed.error || "Fusion helper script did not complete");
        }
        return parsed.result;
      }
      return parsed;
    } catch (error) {
      uncertain = true;
      throw error;
    }
  }

  async function runScript(filename, args, doc, docId, helpers, options = {}) {
    return executeScript(
      path.relative(root, path.join(__dirname, filename)),
      args,
      doc,
      docId,
      helpers,
      options,
    );
  }

  async function runSequencedScript(filename, args, doc, docId, helpers, settled) {
    const receipt = {};
    const result = await runScript(filename, args, doc, docId, helpers, {
      sequence: { action: "begin", mode: "exclusive" },
      requireReceipt: true,
      receiptSink: receipt,
    });
    const sequenceId = receipt.value?.sequenceId;
    if (typeof sequenceId !== "string" || !sequenceId) {
      uncertain = true;
      throw new Error(`${filename} terminal receipt has no exclusive sequence id`);
    }
    if (receipt.value.state !== "succeeded") {
      uncertain = true;
      throw new Error(`${filename} did not settle as a successful broker turn`);
    }
    if (receipt.value.sequenceState !== "held") {
      uncertain = true;
      throw new Error(`${filename} did not retain the owned exclusive sequence after its terminal turn`);
    }
    if (!settled(result)) {
      uncertain = true;
      throw new Error(`${filename} did not prove a settled restoration outcome; keep the sequence held`);
    }
    const release = runCli(["queue", "release", "--sequence-id", sequenceId], {
      queueAdmin: true,
    });
    if (release.status !== 0) {
      uncertain = true;
      throw new Error(release.stderr || `Could not release the settled ${filename} sequence`);
    }
    return {
      result,
      queueReceipt: receipt.value,
      release: JSON.parse(release.stdout),
    };
  }

  function fusionPath(localPath) {
    return ["win32", "darwin"].includes(process.platform)
      ? localPath
      : platform.toWindowsPath(localPath, platform.detectPlatform());
  }

  function verifyPngFiles(directory, rows, width = 640, height = 480) {
    if (!Array.isArray(rows)) throw new Error("Native report omitted image artifact rows");
    return rows.map((row) => {
      if (!row || typeof row.name !== "string")
        throw new Error("Native image artifact has no relative name");
      const relative = row.name.replaceAll("\\", "/");
      const file = path.resolve(directory, relative);
      const contained = path.relative(directory, file);
      if (!contained || contained.startsWith("..") || path.isAbsolute(contained))
        throw new Error("Native image path escaped its owned evidence directory");
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Native image artifact is not a regular file: " + relative);
      const bytes = fs.readFileSync(file);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== row.bytes || sha256 !== row.sha256)
        throw new Error("Native image bytes/hash do not match Fusion readback: " + relative);
      const pixels = adapters.decodeReviewPng(
        bytes,
        width,
        height,
        application.CAPTURE_PIXEL_THRESHOLDS,
      );
      return {
        name: relative,
        bytes: bytes.length,
        sha256,
        pixels: {
          width: pixels.width,
          height: pixels.height,
          pixelDigest: pixels.pixelDigest,
          edgePixelRatio: pixels.edgePixelRatio,
          lumaStandardDeviation: pixels.lumaStandardDeviation,
          distinctColorBins: pixels.distinctColorBins,
        },
      };
    });
  }

  function verifyFusionBuild(report, label) {
    if (report?.fusionBuild !== summary.fusionBuild) {
      uncertain = true;
      throw new Error(`${label} was not executed on the preflight Fusion build ${summary.fusionBuild}`);
    }
  }

  async function reviewCase(name, doc, docId) {
    const out = path.join(evidenceRoot, name);
    const activation = runCli([
      "run",
      "tests/native/capture-integrity-activate.py",
      "--args",
      JSON.stringify({ authorization: AUTHORIZATION, action: "activate", creationId: docId }),
      "--doc", doc,
      "--doc-id", docId,
      "--helpers", "cad-v1",
    ], { sequence: { action: "begin", mode: "exclusive" } });
    if (activation.status !== 0) {
      uncertain = true;
      throw new Error(activation.stderr || "Could not establish pinned review activation");
    }
    const activationReceipt = parseQueueReceipt(activation.stderr, "review activation");
    const sequenceId = activationReceipt?.sequenceId;
    if (typeof sequenceId !== "string" || !sequenceId ||
        activationReceipt.state !== "succeeded" || activationReceipt.sequenceState !== "held") {
      uncertain = true;
      throw new Error("Pinned review activation has no durable sequence id");
    }
    const response = runCli([
      "review",
      "--doc", doc,
      "--doc-id", docId,
      "--out", out,
      "--width", "640",
      "--height", "480",
    ], { sequence: { action: "continue", id: sequenceId, mode: "exclusive" } });
    let report;
    try {
      report = JSON.parse(formatRunOutput(response.stdout, "json"));
    } catch (error) {
      uncertain = true;
      throw new Error("Pinned review returned no parseable terminal report: " + error.message);
    }
    const queueReceipt = parseQueueReceipt(response.stderr, "pinned review");
    if (!queueReceipt || queueReceipt.sequenceId !== sequenceId) {
      uncertain = true;
      throw new Error("Pinned review has no matching durable queue terminal receipt");
    }
    const identityMatches = report.documentIdentity?.name === doc &&
      report.documentIdentity?.creationId === docId;
    const rejectedBeforeCapture = ["rejected", "not-submitted"].includes(report.transportStatus) &&
      report.restoration?.status === "not-needed";
    if ((report.documentIdentity && !identityMatches) ||
        (!rejectedBeforeCapture && (["unknown", "failed"].includes(report.transportStatus) ||
          report.restoration?.status !== "restored")))
      uncertain = true;
    if (response.status === 0 &&
        (!identityMatches || !report.sourceArtifact?.sha256 ||
         typeof report.fusionBuild !== "string" || !Array.isArray(report.views)))
      uncertain = true;
    if (!rejectedBeforeCapture) verifyFusionBuild(report, "Pinned review");
    const terminal = ["succeeded", "failed"].includes(queueReceipt.state);
    if (!terminal) uncertain = true;
    if (!(queueReceipt.sequenceState === "held" ||
          (queueReceipt.state === "failed" && queueReceipt.sequenceState === "ended")))
      uncertain = true;
    if (!uncertain && queueReceipt.sequenceState === "held") {
      const release = runCli(["queue", "release", "--sequence-id", sequenceId], {
        queueAdmin: true,
      });
      if (release.status !== 0) {
        uncertain = true;
        throw new Error(release.stderr || "Could not release settled review sequence");
      }
      report.sequenceRelease = JSON.parse(release.stdout);
    }
    if (!uncertain && queueReceipt.sequenceState === "ended" && queueReceipt.state !== "failed")
      uncertain = true;
    const imageRows = report.views?.filter((row) => row?.status === "captured").map((row) => ({
      name: row.file,
      bytes: row.sizeBytes,
      sha256: row.sha256,
    })) || [];
    const localImages = imageRows.length ? verifyPngFiles(out, imageRows) : [];
    summary.cases.push({
      name,
      queueReceipt,
      release: report.sequenceRelease,
      code: response.status,
      transport: report.transportStatus,
      artifacts: report.artifactStatus,
      identity: report.documentIdentity,
      sourceArtifact: report.sourceArtifact,
      fusionBuild: report.fusionBuild,
      captureRecipes: report.captureRecipes,
      views: report.views,
      localImages,
      restoration: report.restoration,
      pixelIntegrity: report.pixelIntegrity,
      errors: report.errors,
      manifestWritten: typeof report.manifestPath === "string" && fs.existsSync(report.manifestPath),
    });
    if (uncertain)
      throw new Error("Pinned review outcome or restoration is not fully known; preserve scratch and lease");
    return { code: response.status, report, transport: report.transportStatus,
      artifacts: report.artifactStatus,
      manifestWritten: typeof report.manifestPath === "string" && fs.existsSync(report.manifestPath) };
  }

  async function cleanupFixtures(asymmetric, documents, token) {
    const expectedIds = new Set(documents.map((row) => row.creationId));
    const turn = await runSequencedScript(
      "capture-integrity-cleanup.py",
      {
        authorization: AUTHORIZATION,
        action: "cleanup",
        creationId: asymmetric.creationId,
        token,
        documents,
      },
      asymmetric.name,
      asymmetric.creationId,
      "cad-v1",
      (result) => result.status === "cleaned" && Array.isArray(result.closed) &&
        result.closed.length === 3 && result.closed.every((row) => expectedIds.has(row.creationId)),
    );
    return {
      ...turn.result,
      queueReceipt: turn.queueReceipt,
      release: turn.release,
    };
  }

  const queue = runCli(["queue", "status"], {
    queueAdmin: true,
    allowEmpty: true,
  });
  if (queue.status !== 0) {
    recordBlockedPreflight(
      "blocked-broker-status-error",
      queue.stderr || "Shared broker queue status failed",
    );
    return;
  }
  let queueState;
  try {
    queueState = JSON.parse(queue.stdout);
  } catch (error) {
    recordBlockedPreflight("blocked-broker-status-unreadable", error.message);
    return;
  }
  if (queueState.blocked || queueState.held || queueState.stopping ||
      queueState.recovery || queueState.paused ||
      queueState.control?.gateClosed || queueState.control?.unresolved ||
      ["PAUSED", "DRAINING", "STOPPING"].includes(queueState.control?.phase)) {
    recordBlockedPreflight(
      "blocked-broker-reconciliation",
      "Broker reports paused, held, stopping, recovery, or blocked state; no Fusion test submitted",
    );
    return;
  }
  summary.preflight = {
    queue: {
      status: "available",
      revision: queueState.revision,
      buildHash: queueState.buildHash,
      activeAtRead: Boolean(queueState.active),
      sequenceLeaseAtRead: Boolean(queueState.lease),
    },
    doctor: null,
    documents: null,
    fusionBuild: null,
  };

  let doctor;
  try {
    doctor = runCli(["doctor"], { allowEmpty: true });
  } catch (error) {
    recordBlockedPreflight(
      uncertain ? "unknown-preflight-preserve-state" : "blocked-addin-health",
      error.message,
    );
    return;
  }
  if (doctor.status !== 0) {
    recordBlockedPreflight(
      "blocked-addin-health",
      doctor.stderr || "Shared-queue add-in doctor check failed",
    );
    return;
  }
  let doctorReceipt;
  try {
    doctorReceipt = parseQueueReceipt(doctor.stderr, "add-in doctor");
  } catch (error) {
    recordBlockedPreflight("blocked-addin-health", error.message);
    return;
  }
  if (!doctorReceipt) {
    recordBlockedPreflight(
      "blocked-addin-health",
      "Add-in doctor did not return a shared-broker receipt",
    );
    return;
  }
  summary.preflight.doctor = {
    status: "connected",
    sha256: createHash("sha256").update(doctor.stdout).digest("hex"),
    queueReceipt: doctorReceipt,
  };

  try {
    const fusionReceipt = {};
    const appState = await executeScript(
      "tests/native/capture-integrity-preflight.py",
      {},
      undefined,
      undefined,
      undefined,
      { readOnly: true, requireReceipt: true, receiptSink: fusionReceipt },
    );
    if (typeof appState.fusionBuild !== "string" || !Array.isArray(appState.documents))
      throw new Error("Fusion version/document preflight returned incomplete data");
    summary.fusionBuild = appState.fusionBuild;
    preflightDocuments = appState.documents;
    preflightDocumentNames = new Set(appState.documents.map(row => row.name));
    summary.preflight.documentCount = appState.documentCount;
    summary.preflight.documentInventorySha256 = createHash("sha256").update(
      JSON.stringify(appState.documents),
    ).digest("hex");
    summary.preflight.fusion = {
      status: "read-only",
      build: appState.fusionBuild,
      documentCount: appState.documentCount,
      queueReceipt: fusionReceipt.value,
    };
    summary.preflight.documents = {
      status: "read-in-same-fusion-turn",
      count: appState.documentCount,
      sha256: summary.preflight.documentInventorySha256,
    };
    if (appState.fusionBuild !== "2706.1.14") {
      recordBlockedPreflight(
        "blocked-unexpected-fusion-build",
        `Expected Fusion 2706.1.14 for this qualification, read ${appState.fusionBuild}`,
      );
      return;
    }
  } catch (error) {
    recordBlockedPreflight(
      uncertain ? "unknown-preflight-preserve-state" : "blocked-fusion-preflight",
      error.message,
    );
    return;
  }

  try {
    fixtureAttempted = true;
    let fixtureReceipt = {};
    if (resume) {
      const documents = resume.documents.map((row) => {
        const current = preflightDocuments?.filter((candidate) =>
          candidate.name === row.name && candidate.creationId === row.creationId,
        ) || [];
        if (current.length !== 1) {
          uncertain = true;
          throw new Error("Prior owned fixture is absent or ambiguous in the fresh document inventory");
        }
        if (current[0].isSaved !== false || current[0].isModified !== row.isModified) {
          uncertain = true;
          throw new Error("Prior owned fixture saved/modified state differs from fresh read-only inventory");
        }
        return { ...row, isSaved: current[0].isSaved, isModified: current[0].isModified };
      });
      fixtureState = {
        status: "ready",
        saved: false,
        token: resume.token,
        fusionBuild: summary.fusionBuild,
        sectionName: `FMCAD_CAPTURE_SECTION_${resume.token}`,
        documents,
      };
      fixtureReceipt = { value: { resumedExistingFixtureReceipt: resume.creationReceipt,
        sourceReportSha256: resume.reportSha256,
        freshInventoryCount: preflightDocuments.length,
        freshInventorySha256: summary.preflight.documentInventorySha256 } };
      summary.resumedFixtureReadback = {
        sourceReport: resume.reportPath,
        sourceReportSha256: resume.reportSha256,
        creationReceipt: resume.creationReceipt,
        status: "verified-against-fresh-broker-inventory",
        inventoryCount: preflightDocuments.length,
        inventorySha256: summary.preflight.documentInventorySha256,
      };
    } else {
      const createTurn = await runSequencedScript(
        "capture-integrity-qualification.py",
        { authorization: AUTHORIZATION, action: "create" },
        undefined,
        undefined,
        undefined,
        (result) => result.status === "ready" && result.saved === false &&
          result.documents?.length === 3 && result.documents.every((row) =>
            typeof row.name === "string" && typeof row.creationId === "string" &&
            row.isSaved === false && row.geometryReadback),
      );
      fixtureState = createTurn.result;
      fixtureReceipt.value = { creation: createTurn.queueReceipt, release: createTurn.release };
    }
    if (fixtureState.status !== "ready" || fixtureState.saved !== false) {
      uncertain = true;
      throw new Error(
        "Synthetic fixtures did not reach a ready, unsaved state",
      );
    }
    if (!resume && (!preflightDocumentNames || fixtureState.documents.some(row =>
      preflightDocumentNames.has(row.name))))
      throw new Error("New synthetic fixture name was present in the fresh preflight inventory");
    if (resume && fixtureState.token !== resume.token) {
      uncertain = true;
      throw new Error("Read-only fixture inspection returned a different fixture token");
    }
    if (fixtureState.fusionBuild !== summary.fusionBuild) {
      uncertain = true;
      throw new Error("Fusion version changed between read-only preflight and scratch creation");
    }
    if (resume) summary.preflight.fixtureNamesRefreshed = true;
    else summary.preflight.fixtureNamesAbsent = true;
    summary.preflight.fixtureCreationReceipt = fixtureReceipt.value;
    summary.fusionBuild = fixtureState.fusionBuild || null;
    summary.documents = fixtureState.documents.map(
      ({ name, creationId, role, isSaved, isModified, geometryReadback }) => ({
        name,
        creationId,
        role,
        isSaved,
        isModified,
        geometryReadback,
      }),
    );
    const asymmetric = fixtureState.documents.find(
      (row) => row.role === "ASYMMETRIC",
    );
    const blank = fixtureState.documents.find((row) => row.role === "BLANK");
    const symmetric = fixtureState.documents.find((row) => row.role === "SYMMETRIC");
    if (!asymmetric || !blank || !symmetric)
      throw new Error("Synthetic document pins are incomplete");
    const spans = (row) => row.geometryReadback?.minimum?.map((value, index) =>
      row.geometryReadback.maximum[index] - value,
    );
    const nearSpans = (actual, expected) => Array.isArray(actual) &&
      actual.length === expected.length &&
      actual.every((value, index) => Math.abs(value - expected[index]) <= 1e-3);
    if (blank.geometryReadback?.bodyCount !== 0 ||
        asymmetric.geometryReadback?.bodyCount !== 1 ||
        symmetric.geometryReadback?.bodyCount !== 1 ||
        asymmetric.geometryReadback?.bodyValid !== true ||
        symmetric.geometryReadback?.bodyValid !== true ||
        !Number.isFinite(asymmetric.geometryReadback?.volume) ||
        asymmetric.geometryReadback.volume <= 0 ||
        !nearSpans(spans(asymmetric), [4, 2, 1]) ||
        !nearSpans(spans(symmetric), [2, 2, 2]))
      throw new Error("Native blank/asymmetric/symmetric geometry readback does not match the synthetic fixture specification");

    const shotpackRoot = path.join(evidenceRoot, "shotpack");
    const shotpackTurn = await runSequencedScript(
      "capture-integrity-capture.py",
      {
        authorization: AUTHORIZATION,
        action: "capture",
        documents: fixtureState.documents,
        sectionName: fixtureState.sectionName,
        outputRoot: fusionPath(shotpackRoot),
        allowedRoot: fusionPath(evidenceRoot),
      },
      asymmetric.name,
      asymmetric.creationId,
      "cad-v1",
      (result) => result.targetReadbackRestored === true &&
        Array.isArray(result.cases) &&
        result.cases.every((row) => row.status !== "unknown" &&
          row.status !== "blocked-restore" && row.cameraRestored !== false &&
          !["failed", "unknown"].includes(row.sectionRestoration)),
    );
    const shotpack = shotpackTurn.result;
    verifyFusionBuild(shotpack, "shot.pack ROI/detail/section capture");
    const shotpackImages = verifyPngFiles(shotpackRoot, shotpack.imageArtifacts || []);
    summary.cases.push({
      name: "shot.pack-roi-detail-section-duplicate-partial-files",
      ...shotpack,
      localImages: shotpackImages,
      queueReceipt: shotpackTurn.queueReceipt,
      release: shotpackTurn.release,
    });
    if (shotpack.status === "unknown" || shotpack.status === "failed") {
      uncertain = shotpack.status === "unknown" ||
        shotpack.targetReadbackRestored !== true;
      throw new Error("shot.pack native capture did not prove its restoration and pixel outcome");
    }

    const blankOutput = path.join(evidenceRoot, "blank.png");
    const blankTurn = await runSequencedScript(
      "capture-integrity-blank.py",
      {
        authorization: AUTHORIZATION,
        action: "blank",
        creationId: blank.creationId,
        documents: fixtureState.documents,
        outputPath: fusionPath(blankOutput),
        allowedRoot: fusionPath(evidenceRoot),
      },
      blank.name,
      blank.creationId,
      "cad-v1",
      (result) => result.cameraRestored === true &&
        result.documentIdentity?.creationId === blank.creationId &&
        result.documentIdentity?.isSaved === false &&
        result.documentIdentity?.isModified === result.documentIdentity?.modifiedBefore,
    );
    const blankShotpack = blankTurn.result;
    verifyFusionBuild(blankShotpack, "shot.pack blank capture");
    const blankImage = verifyPngFiles(evidenceRoot, [blankShotpack.image]);
    const blankPixelIntegrity = application.evaluateReviewPixels([{
      name: "blank",
      pixels: adapters.decodeReviewPng(
        fs.readFileSync(blankOutput), 640, 480, application.CAPTURE_PIXEL_THRESHOLDS,
      ),
      cameraDirection: [0, 0, 1],
    }]);
    summary.cases.push({
      name: "shot.pack-blank-frame-negative-and-partial-output",
      ...blankShotpack,
      pixelIntegrity: blankPixelIntegrity,
      localImages: blankImage,
      queueReceipt: blankTurn.queueReceipt,
      release: blankTurn.release,
    });
    if (blankShotpack.status === "unknown" || blankShotpack.cameraRestored !== true) {
      uncertain = true;
      throw new Error("Blank-frame capture/restoration outcome is unknown; preserve all fixtures");
    }

    const legalRoot = path.join(evidenceRoot, "legal-similarity");
    const legalTurn = await runSequencedScript(
      "capture-integrity-legal-similarity.py",
      {
        authorization: AUTHORIZATION,
        action: "legal-similarity",
        creationId: symmetric.creationId,
        documents: fixtureState.documents,
        outputRoot: fusionPath(legalRoot),
        allowedRoot: fusionPath(evidenceRoot),
      },
      symmetric.name,
      symmetric.creationId,
      "cad-v1",
      (result) => result.cameraRestored === true &&
        result.documentIdentity?.isSaved === false &&
        result.documentIdentity?.isModified === result.documentIdentity?.modifiedBefore &&
        result.presentationRestoration?.status === "restored",
    );
    const legal = legalTurn.result;
    verifyFusionBuild(legal, "shot.pack legal-similarity capture");
    const legalImages = verifyPngFiles(legalRoot, legal.images || []);
    summary.cases.push({ name: "shot.pack-legal-similar-distinct-directions", ...legal,
      localImages: legalImages, queueReceipt: legalTurn.queueReceipt,
      release: legalTurn.release });
    if (legal.status !== "passed")
      throw new Error("Native legal-similarity case did not produce a non-failing similar-view diagnostic");

    const baseline = await reviewCase(
      "review-default",
      asymmetric.name,
      asymmetric.creationId,
    );
    const blankReview = await reviewCase(
      "review-blank",
      blank.name,
      blank.creationId,
    );
    const captureRecipes = shotpack.cases.find(
      (row) => row.name === "roi-detail-section-readback",
    );
    const duplicateCapture = shotpack.cases.find(
      (row) => row.name === "same-direction-duplicate",
    );
    const partialCapture = shotpack.cases.find(
      (row) => row.name === "partial-files-after-later-shot-failure",
    );

    summary.expectedChecks = {
      shotpackCapture: shotpack.status === "passed",
      blankShotpackRejected: blankShotpack.expectedPixelRejection === true &&
        blankShotpack.cameraRestored === true &&
        blankPixelIntegrity.status === "failed" &&
        blankPixelIntegrity.views[0]?.status === "blank",
      legalSimilarityAccepted: legal.status === "passed" &&
        legal.pixelIntegrity.status === "review-required" &&
        legal.pixelIntegrity.duplicatePairs.length === 0,
      partialFilesRetained: partialCapture?.status === "passed" &&
        partialCapture.firstImageRetained === true &&
        partialCapture.failedImageAbsent === true &&
        partialCapture.cameraRestored === true,
      defaultCapture:
        baseline.code === 0 &&
        baseline.report.restoration?.status === "restored",
      blankRejected:
        blankReview.code === 1 &&
        blankReview.report.pixelIntegrity?.status === "failed",
      duplicateRejected: duplicateCapture?.status === "passed" &&
        duplicateCapture.cameraRestored === true,
      roiDetailSectionCapture: captureRecipes?.status === "passed",
      presentationRestored: captureRecipes?.sectionRestoration === "restored" &&
        captureRecipes?.result?.cameraRestored === true,
      sectionAvailable: Boolean(fixtureState.sectionName),
    };
    const unsupported =
      !summary.expectedChecks.sectionAvailable ||
      shotpack.status === "blocked-unsupported" ||
      captureRecipes?.status === "blocked-unsupported";
    summary.status = uncertain
      ? "unknown-preserve-fixtures-and-reconcile"
      : Object.values(summary.expectedChecks).every(Boolean)
        ? "completed-needs-human-image-inspection"
        : unsupported
          ? "blocked-unsupported"
          : "failed";
  } catch (error) {
    if (summary.status === "running")
      summary.status = uncertain
        ? "unknown-preserve-fixtures-and-reconcile"
        : "failed";
    summary.error = error.message;
  } finally {
    if (!fixtureState && resume) {
      summary.cleanup = "not-run: prior owned fixtures require exact-pin readback before cleanup";
    } else if ((fixtureState?.status === "ready" || fixtureAttempted) && !uncertain) {
      try {
        const asymmetric = fixtureState.documents.find((row) => row.role === "ASYMMETRIC");
        if (!asymmetric) throw new Error("No owned asymmetric scratch pin is available for cleanup");
        summary.cleanup = await cleanupFixtures(
          asymmetric,
          fixtureState.documents,
          fixtureState.token,
        );
      } catch (error) {
        summary.cleanup = { status: "failed", message: error.message };
        summary.status = uncertain
          ? "unknown-preserve-fixtures-and-reconcile"
          : "failed";
      }
    } else if (fixtureState?.status === "ready" || fixtureAttempted) {
      summary.cleanup =
        "not-run: remote outcome unknown; inspect Fusion before any cleanup";
    }
    summary.finishedAt = new Date().toISOString();
    summary.saved = false;
    summary.push = false;
    try {
      fs.unlinkSync(privateConfigPath);
    } catch {}
    fs.writeFileSync(
      path.join(evidenceRoot, "qualification-report.json"),
      JSON.stringify(summary, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  }
}
