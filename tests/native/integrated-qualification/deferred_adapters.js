"use strict";

const path = require("node:path");
const fs = require("node:fs");

// These are typed, fail-closed plans, not runnable adapters. They document the
// precise artifact/document capability each feature still lacks.
const BREP_PHASES = {
  capture: "measure.baseline.capture", inspect: "measure.baseline.inspect",
  exactCompare: "measure.baseline.compare", equalVolumeNegative: "measure.baseline.compare",
  poseChangeNegative: "measure.baseline.compare", missingBody: "measure.baseline.compare",
  staleVersion: "measure.baseline.compare", finalRestore: "measure.baseline.compare",
  scratchCleanup: "doc.close",
};
const BREP_CASES = ["durable-export-inspect-and-new-invocation-restore", "exact-geometry-and-pose-positive",
  "equal-volume-different-shape-negative", "pose-change-negative-and-restore-positive",
  "missing-stale-and-budget-outcomes", "owned-scratch-restore-and-cleanup"];
const CAPTURE_PHASES = ["doctor", "fusionPreflight", "fixtureCreate", "shotpack", "blankCapture",
  "legalSimilarity", "reviewDefaultActivation", "reviewDefault", "reviewBlankActivation", "reviewBlank", "cleanup"];
const CAPTURE_CASES = ["corrupt-image-set-fails", "recipe-change-preserves-identity-and-restore-evidence",
  "unsupported-presentation-restore-remains-explicit", "capture-artifact-hashes-and-document-readback",
  "owned-scratch-restore-and-cleanup"];
const SELECTION_PHASES = ["define-reorder", "resolve-reorder", "define-repeated-instances", "resolve-repeated-instances",
  "split-edit", "resolve-split", "merge-edit", "resolve-merge", "delete-edit", "check-missing",
  "save-version-drift", "check-stale", "ownership-conflict", "artifact-reread", "scratch-cleanup"];
const SELECTION_CASES = ["reorder", "repeated-identical-instances", "split", "merge", "deleted-and-stale", "ownership-and-restore"];
const SKETCH_OPERATIONS = [
  "status-before", "create-single", "geometry-single", "create-ambiguous", "geometry-ambiguous",
  "create-annulus", "geometry-annulus", "create-microgap", "geometry-microgap", "create-duplicate", "geometry-duplicate",
  "inspect-single", "check-single", "check-ambiguous", "check-annulus", "check-microgap", "check-duplicate",
  "query-coordinate-positive", "query-shifted-center-negative", "query-bad-diameter-negative",
  "query-unambiguous-profile", "query-ambiguous-profile", "query-explicit-profile",
  "query-hole-material", "query-hole-void", "query-microgap", "query-duplicate", "query-missing-topology", "status-after",
];
const SKETCH_CASES = ["coordinate-positive", "shifted-center-negative", "bad-diameter-negative", "microgap-negative",
  "duplicate-edge-negative", "hole-inside-material-positive", "hole-inside-void-negative",
  "unambiguous-profile-selection-positive", "multiple-profiles-ambiguous-negative",
  "multiple-profiles-explicitly-selected-positive", "missing-or-incomplete-topology-no-first-profile-fallback",
  "read-only-proof-preserves-scratch-state"];
const SKETCH_ALLOWED_OPERATIONS = new Set([
  "document.status", "sketch.create", "sketch.geometry", "sketch.inspect", "sketch.check", "sketch.profile-query",
]);
const SKETCH_REQUIRED_COUNTS = { oneProfile: { profiles: 1, loops: 1, outerLoops: 1, innerLoops: 0 },
  twoProfiles: { profiles: 2, loops: 2, outerLoops: 2, innerLoops: 0 },
  annulus: { profiles: 1, loops: 2, outerLoops: 1, innerLoops: 1 } };
const TEMP_ROOT = "/tmp/opencode";

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function keys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${label} has unsupported field ${key}`);
}

function pinnedNameId(value, label) {
  record(value, label);
  if (typeof value.name !== "string" || !value.name || typeof value.creationId !== "string" || !value.creationId) {
    throw new TypeError(`${label} requires exact name and creationId pins`);
  }
  return Object.freeze({ name: value.name, creationId: value.creationId });
}

function stableIds(value, names, label) {
  record(value, `${label}.requestIds`);
  keys(value, names, `${label}.requestIds`);
  if (names.some((name) => typeof value[name] !== "string" || !value[name])) {
    throw new TypeError(`${label} requires a stable request ID for every planned operation`);
  }
  if (new Set(names.map((name) => value[name])).size !== names.length) {
    throw new TypeError(`${label} request IDs must be distinct`);
  }
  return Object.freeze(Object.fromEntries(names.map((name) => [name, value[name]])));
}

function validateBrepRequest(input) {
  record(input, "BRep request");
  keys(input, ["schemaVersion", "clientId", "document", "requestIds", "fixture", "caseIds"], "BRep request");
  if (input.schemaVersion !== 1 || typeof input.clientId !== "string" || !input.clientId) {
    throw new TypeError("BRep request requires schemaVersion 1 and the already registered owner client ID");
  }
  record(input.document, "BRep document");
  keys(input.document, ["name", "creationId", "projectId", "fileId", "version", "isSaved", "isModified"], "BRep document");
  const document = { ...pinnedNameId(input.document, "BRep document") };
  if (typeof input.document.projectId !== "string" || !input.document.projectId ||
      typeof input.document.fileId !== "string" || !input.document.fileId ||
      !Number.isSafeInteger(input.document.version) || input.document.version < 1 ||
      input.document.isSaved !== true || input.document.isModified !== false) {
    throw new TypeError("BRep baseline needs an unchanged saved/versioned DataFile with exact projectId/fileId/version pins");
  }
  document.projectId = input.document.projectId;
  document.fileId = input.document.fileId;
  document.version = input.document.version;
  document.isSaved = true;
  document.isModified = false;
  const phases = Object.keys(BREP_PHASES);
  const requestIds = stableIds(input.requestIds, phases, "BRep request");
  if (!Array.isArray(input.caseIds) || input.caseIds.length !== BREP_CASES.length ||
      BREP_CASES.some((caseId) => !input.caseIds.includes(caseId)) ||
      new Set(input.caseIds).size !== BREP_CASES.length) {
    throw new TypeError("BRep request requires the complete unique acceptance-case set");
  }
  record(input.fixture, "BRep fixture");
  keys(input.fixture, ["frame", "bodyRoles", "equalVolumeControl", "changedPoseControl"], "BRep fixture");
  if (!['assembly', 'component local'].includes(input.fixture.frame) ||
      !Array.isArray(input.fixture.bodyRoles) || input.fixture.bodyRoles.length < 2 ||
      input.fixture.bodyRoles.some((role) => typeof role !== "string" || !role) ||
      new Set(input.fixture.bodyRoles).size !== input.fixture.bodyRoles.length ||
      typeof input.fixture.equalVolumeControl !== "boolean" ||
      typeof input.fixture.changedPoseControl !== "boolean") {
    throw new TypeError("BRep fixture requires explicit frame, unique body roles, and equal-volume/pose controls");
  }
  return Object.freeze({ schemaVersion: 1, clientId: input.clientId, document: Object.freeze(document), requestIds,
    requests: Object.freeze(phases.map((phase) => Object.freeze({ phase, operation: BREP_PHASES[phase],
      requestId: requestIds[phase], requiresNewInvocation: phase !== "capture" }))),
    caseIds: Object.freeze([...input.caseIds]),
    fixture: Object.freeze({ ...input.fixture, bodyRoles: Object.freeze([...input.fixture.bodyRoles]) }),
    executionPolicy: Object.freeze({ requireExactDocumentOwner: true, stopOnUnknown: true,
      replayUnknown: false, cleanupOnlyAfterAllTerminalReads: true }),
    status: "NOTRUN", unsupportedCapability: "saved-versioned-document-and-broker-owned-exact-brep-staging",
    reason: "Current authorized scratch scope is unsaved; baseline capture is node-only, requires a saved/versioned DataFile and broker-owned durable exact-BRep staging, then a separate invocation." });
}

function validateCaptureRequest(input) {
  record(input, "Capture request");
  keys(input, ["schemaVersion", "clientId", "fusionSessionId", "documents", "sectionName",
    "sectionUnsupportedReason", "requestIds", "caseIds", "outputRoot"], "Capture request");
  if (input.schemaVersion !== 1 || typeof input.clientId !== "string" || !input.clientId ||
      typeof input.fusionSessionId !== "string" || !input.fusionSessionId) {
    throw new TypeError("Capture request requires schemaVersion 1 and the current registered client/Fusion session");
  }
  record(input.documents, "Capture documents");
  keys(input.documents, ["BLANK", "ASYMMETRIC", "SYMMETRIC"], "Capture documents");
  const documents = Object.fromEntries(['BLANK', 'ASYMMETRIC', 'SYMMETRIC'].map((role) =>
    [role, pinnedNameId(input.documents[role], `Capture ${role} document`)]));
  for (const role of ["BLANK", "ASYMMETRIC", "SYMMETRIC"]) {
    const document = input.documents[role];
    if (document.isSaved !== false || typeof document.isModified !== "boolean" ||
        !document.geometryReadback || typeof document.geometryReadback.bodyCount !== "number") {
      throw new TypeError(`Capture ${role} requires unsaved state and native geometry readback`);
    }
    const expectedBodies = role === "BLANK" ? 0 : 1;
    if (document.geometryReadback.bodyCount !== expectedBodies ||
        (role !== "BLANK" && document.geometryReadback.bodyValid !== true)) {
      throw new TypeError(`Capture ${role} geometry does not match its exact fixture role`);
    }
    if (role !== "BLANK") {
      const { minimum, maximum, volume } = document.geometryReadback;
      const expectedSpans = role === "ASYMMETRIC" ? [4, 2, 1] : [2, 2, 2];
      if (!Array.isArray(minimum) || !Array.isArray(maximum) || minimum.length !== 3 || maximum.length !== 3 ||
          !Number.isFinite(volume) || volume <= 0 || expectedSpans.some((span, index) =>
            !Number.isFinite(minimum[index]) || !Number.isFinite(maximum[index]) ||
            Math.abs((maximum[index] - minimum[index]) - span) > 1e-3)) {
        throw new TypeError(`Capture ${role} requires actual positive volume and expected asymmetric/symmetric bounds`);
      }
    }
    documents[role] = Object.freeze({ name: document.name, creationId: document.creationId,
      isSaved: document.isSaved, isModified: document.isModified, geometryReadback: document.geometryReadback });
  }
  const section = typeof input.sectionName === "string" && input.sectionName
    ? { status: "prepared", name: input.sectionName }
    : input.sectionName === null && typeof input.sectionUnsupportedReason === "string" && input.sectionUnsupportedReason
      ? { status: "NOTRUN", reason: input.sectionUnsupportedReason }
      : null;
  if (!section) {
    throw new TypeError("Capture request requires an exact synthetic section identity or explicit unsupported reason");
  }
  if (new Set(Object.values(documents).map((row) => row.creationId)).size !== 3) {
    throw new TypeError("Capture scratch roles must have distinct creationIds");
  }
  const requestIds = stableIds(input.requestIds, CAPTURE_PHASES, "Capture request");
  if (!Array.isArray(input.caseIds) || input.caseIds.length !== CAPTURE_CASES.length ||
      CAPTURE_CASES.some((caseId) => !input.caseIds.includes(caseId)) ||
      new Set(input.caseIds).size !== CAPTURE_CASES.length) {
    throw new TypeError("Capture request requires the complete unique native acceptance-case set");
  }
  if (typeof input.outputRoot !== "string" || !path.isAbsolute(input.outputRoot) ||
      !path.resolve(input.outputRoot).startsWith(`${TEMP_ROOT}${path.sep}`) ||
      input.outputRoot.split(/[\\/]/).includes("..")) {
    throw new TypeError("Capture outputRoot must be a private run-owned directory under /tmp/opencode");
  }
  const outputRoot = path.resolve(input.outputRoot);
  const outputStat = fs.lstatSync(outputRoot);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink() || fs.realpathSync(outputRoot) !== outputRoot ||
      (outputStat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && outputStat.uid !== process.getuid())) {
    throw new TypeError("Capture outputRoot must already be an owned private non-symlink directory");
  }
  return Object.freeze({ schemaVersion: 1, clientId: input.clientId,
    fusionSessionId: input.fusionSessionId, documents: Object.freeze(documents),
    section, requestIds, caseIds: Object.freeze([...input.caseIds]),
    executionPolicy: Object.freeze({ requireCurrentClientAndSession: true, stopOnUnknown: true,
      replayUnknown: false, cleanupOnlyAfterKnownRestoration: true }),
    outputRoot: input.outputRoot, status: "NOTRUN",
    unsupportedCapability: "three-document-capture-fixture-and-current-client-bound-review-host",
    reason: "The accepted Capture host creates three documents through global app.documents.add and pins a historical client. The authorized epoch scope allows one caller-pinned scratch only; no existing helper proves this multi-document lifecycle safely." });
}

function validateSelectionRequest(input) {
  record(input, "Selection-rules request");
  keys(input, ["schemaVersion", "clientId", "document", "requestIds", "fixture"], "Selection-rules request");
  if (input.schemaVersion !== 1 || typeof input.clientId !== "string" || !input.clientId) {
    throw new TypeError("Selection-rules request requires schemaVersion 1 and the registered client ID");
  }
  record(input.document, "Selection-rules document");
  keys(input.document, ["name", "creationId", "projectId", "fileId", "version", "isSaved", "isModified"], "Selection-rules document");
  const document = { ...pinnedNameId(input.document, "Selection-rules document") };
  if (typeof input.document.projectId !== "string" || !input.document.projectId ||
      typeof input.document.fileId !== "string" || !input.document.fileId ||
      !Number.isSafeInteger(input.document.version) || input.document.version < 1 ||
      input.document.isSaved !== true || input.document.isModified !== false) {
    throw new TypeError("Selection rules require an unchanged saved project/file/version; an unsaved scratch has no DataFile ID");
  }
  document.projectId = input.document.projectId;
  document.fileId = input.document.fileId;
  document.version = input.document.version;
  document.isSaved = true;
  document.isModified = false;
  const requestIds = stableIds(input.requestIds, SELECTION_PHASES, "Selection-rules request");
  record(input.fixture, "Selection-rules fixture");
  keys(input.fixture, ["component", "faces", "caseIds"], "Selection-rules fixture");
  if (typeof input.fixture.component !== "string" || !input.fixture.component ||
      !Array.isArray(input.fixture.faces) || input.fixture.faces.length < 2 ||
      input.fixture.faces.some((face) => !face || typeof face.path !== "string" || !face.path ||
        typeof face.semanticLabel !== "string" || !face.semanticLabel ||
        typeof face.occurrencePath !== "string" || !face.occurrencePath) ||
      !Array.isArray(input.fixture.caseIds) || input.fixture.caseIds.length !== SELECTION_CASES.length ||
      SELECTION_CASES.some((caseId) => !input.fixture.caseIds.includes(caseId)) ||
      new Set(input.fixture.caseIds).size !== input.fixture.caseIds.length) {
    throw new TypeError("Selection fixture requires exact case list plus semantic refs with component and occurrence paths");
  }
  if (input.fixture.faces.some((face) => {
    const segments = face.path.split("/");
    const occurrence = face.occurrencePath.split("/");
    return segments.length < 3 || occurrence.length < 2 ||
      [...segments, ...occurrence].some((segment) => !segment || segment === "." || segment === "..");
  })) {
    throw new TypeError("Selection face path must be a full non-traversing occurrence path, not a bare name/token");
  }
  if (new Set(input.fixture.faces.map((face) => face.semanticLabel)).size !== input.fixture.faces.length ||
      new Set(input.fixture.faces.map((face) => face.path)).size !== input.fixture.faces.length) {
    throw new TypeError("Selection semantic face labels and paths must be distinct");
  }
  return Object.freeze({ schemaVersion: 1, clientId: input.clientId, document: Object.freeze(document), requestIds,
    fixture: Object.freeze({ ...input.fixture,
      caseIds: Object.freeze([...input.fixture.caseIds]),
      faces: Object.freeze(input.fixture.faces.map((face) => Object.freeze({ ...face }))) }),
    executionPolicy: Object.freeze({ requireExactProjectFileVersion: true, stopOnUnknown: true,
      replayUnknown: false, neverAdvanceManifestAfterNonresolvedOutcome: true }),
    status: "NOTRUN", unsupportedCapability: "saved-file-selection-artifact-persistence-and-cross-invocation-reread",
    reason: "The full acceptance plan needs durable artifact reread plus authorized split/merge/delete edits and a source save/version change. Current grant allows only one unsaved scratch with sketch/extrude/read/cleanup, so no selection operation is dispatched." });
}

function validateSketchRequest(input) {
  record(input, "Sketch-geometry request");
  keys(input, ["schemaVersion", "clientId", "ownerJobs", "creationReceipt", "fixturePrefix", "requestIds", "cleanupRequestId"],
    "Sketch-geometry request");
  if (input.schemaVersion !== 1 || typeof input.clientId !== "string" || !input.clientId) {
    throw new TypeError("Sketch request requires the already registered qualifier clientId");
  }
  record(input.ownerJobs, "Original owner jobs");
  keys(input.ownerJobs, ["targetJobId", "observationJobId"], "Original owner jobs");
  if (typeof input.ownerJobs.targetJobId !== "string" || !input.ownerJobs.targetJobId ||
      typeof input.ownerJobs.observationJobId !== "string" || !input.ownerJobs.observationJobId ||
      input.ownerJobs.targetJobId === input.ownerJobs.observationJobId) {
    throw new TypeError("Sketch request requires distinct actual target and observer job IDs");
  }
  record(input.creationReceipt, "Isolated scratch creation receipt");
  keys(input.creationReceipt, ["status", "requestId", "jobId", "epochId", "document"], "Scratch creation receipt");
  if (input.creationReceipt.status !== "succeeded" || typeof input.creationReceipt.requestId !== "string" ||
      !input.creationReceipt.requestId || typeof input.creationReceipt.jobId !== "string" ||
      !input.creationReceipt.jobId || typeof input.creationReceipt.epochId !== "string" || !input.creationReceipt.epochId) {
    throw new TypeError("Sketch request requires the actual successful scratch creation receipt and epoch ID");
  }
  record(input.creationReceipt.document, "Qualified scratch identity");
  keys(input.creationReceipt.document, ["name", "creationId"], "Qualified scratch identity");
  const document = pinnedNameId(input.creationReceipt.document, "Qualified sketch scratch");
  const epochId = input.creationReceipt.epochId;
  if (typeof input.fixturePrefix !== "string" || !/^[A-Z0-9]{8,24}$/.test(input.fixturePrefix)) {
    throw new TypeError("Sketch request fixturePrefix must be uppercase alphanumeric text");
  }
  const requestIds = stableIds(input.requestIds, SKETCH_OPERATIONS, "Sketch-geometry request");
  if (typeof input.cleanupRequestId !== "string" || !input.cleanupRequestId ||
      Object.values(requestIds).includes(input.cleanupRequestId) ||
      Object.values(requestIds).includes(input.creationReceipt.requestId) ||
      input.cleanupRequestId === input.creationReceipt.requestId) {
    throw new TypeError("Sketch request requires distinct stable operation, creation and owner cleanup request IDs");
  }
  const prefix = input.fixturePrefix;
  const names = {
    single: `${prefix}_Single`, ambiguous: `${prefix}_Ambiguous`, annulus: `${prefix}_Annulus`,
    microgap: `${prefix}_Microgap`, duplicate: `${prefix}_Duplicate`,
  };
  const calls = [];
  const add = (phase, operation, data) => {
    if (!SKETCH_ALLOWED_OPERATIONS.has(operation)) throw new TypeError(`Sketch plan contains unapproved operation ${operation}`);
    const purpose = `isolated sketch qualification epoch ${epochId} case ${phase}`;
    const invocation = Object.freeze({ version: 1, kind: "cad", operation,
      doc: document.name, docId: document.creationId, data: Object.freeze(data), purpose });
    calls.push(Object.freeze({ phase, clientId: input.clientId, requestId: requestIds[phase], epochId, purpose,
      toolRequest: Object.freeze({ action: "execute", requestId: requestIds[phase], invocation }) }));
  };
  const circle = (name, center, radius) => ({ type: "circle", name, center, radius });
  const query = (phase, sketch, criteria, expected) => add(phase, "sketch.profile-query",
    { schemaVersion: 1, sketch, query: criteria, expected });
  const pi = Math.PI;
  add("status-before", "document.status", {});
  for (const key of Object.keys(names)) {
    add(`create-${key}`, "sketch.create", { name: names[key], plane: "XY" });
  }
  add("geometry-single", "sketch.geometry", { sketch: names.single, inferencePolicy: "explicit",
    geometry: [circle("qualifiedCircle", ["10 mm", "20 mm", "0 mm"], "10 mm")] });
  add("geometry-ambiguous", "sketch.geometry", { sketch: names.ambiguous, inferencePolicy: "explicit",
    geometry: [circle("left", ["0 mm", "0 mm", "0 mm"], "5 mm"),
      circle("right", ["20 mm", "0 mm", "0 mm"], "5 mm")] });
  add("geometry-annulus", "sketch.geometry", { sketch: names.annulus, inferencePolicy: "explicit",
    geometry: [circle("outer", ["0 mm", "0 mm", "0 mm"], "10 mm"),
      circle("inner", ["0 mm", "0 mm", "0 mm"], "5 mm")] });
  add("geometry-microgap", "sketch.geometry", { sketch: names.microgap, inferencePolicy: "explicit",
    geometry: [
      { type: "line", name: "bottom", start: ["0 mm", "0 mm", "0 mm"], end: ["10 mm", "0 mm", "0 mm"] },
      { type: "line", name: "right", start: ["10 mm", "0 mm", "0 mm"], end: ["10 mm", "10 mm", "0 mm"] },
      { type: "line", name: "top", start: ["10 mm", "10 mm", "0 mm"], end: ["0 mm", "10 mm", "0 mm"] },
      { type: "line", name: "left-short", start: ["0 mm", "10 mm", "0 mm"], end: ["0.05 mm", "0 mm", "0 mm"] },
    ] });
  add("geometry-duplicate", "sketch.geometry", { sketch: names.duplicate, inferencePolicy: "explicit",
    geometry: [circle("firstStroke", ["0 mm", "0 mm", "0 mm"], "5 mm"),
      circle("duplicateStroke", ["0 mm", "0 mm", "0 mm"], "5 mm")] });
  add("inspect-single", "sketch.inspect", { sketch: names.single });
  for (const key of ["single", "ambiguous", "annulus", "microgap", "duplicate"]) {
    add(`check-${key}`, "sketch.check", { sketch: names[key] });
  }
  query("query-coordinate-positive", names.single,
    { area: pi, centroid: ["10 mm", "20 mm", "0 mm"], contains: ["10 mm", "20 mm", "0 mm"], outerLoops: 1, innerLoops: 0 },
    SKETCH_REQUIRED_COUNTS.oneProfile);
  query("query-shifted-center-negative", names.single,
    { area: pi, centroid: ["11 mm", "20 mm", "0 mm"], outerLoops: 1, innerLoops: 0 },
    SKETCH_REQUIRED_COUNTS.oneProfile);
  query("query-bad-diameter-negative", names.single,
    { area: pi * 0.81, centroid: ["10 mm", "20 mm", "0 mm"], outerLoops: 1, innerLoops: 0 },
    SKETCH_REQUIRED_COUNTS.oneProfile);
  query("query-unambiguous-profile", names.single,
    { area: pi, centroid: ["10 mm", "20 mm", "0 mm"], outerLoops: 1, innerLoops: 0 },
    SKETCH_REQUIRED_COUNTS.oneProfile);
  query("query-ambiguous-profile", names.ambiguous,
    { area: pi * 0.25, outerLoops: 1, innerLoops: 0 }, SKETCH_REQUIRED_COUNTS.twoProfiles);
  query("query-explicit-profile", names.ambiguous,
    { area: pi * 0.25, centroid: ["0 mm", "0 mm", "0 mm"], outerLoops: 1, innerLoops: 0 },
    SKETCH_REQUIRED_COUNTS.twoProfiles);
  query("query-hole-material", names.annulus,
    { area: pi * 0.75, contains: ["7.5 mm", "0 mm", "0 mm"], outerLoops: 1, innerLoops: 1 },
    SKETCH_REQUIRED_COUNTS.annulus);
  query("query-hole-void", names.annulus,
    { area: pi * 0.75, contains: ["2 mm", "0 mm", "0 mm"], outerLoops: 1, innerLoops: 1 },
    SKETCH_REQUIRED_COUNTS.annulus);
  query("query-microgap", names.microgap, { index: 0 }, { profiles: 0 });
  query("query-duplicate", names.duplicate, { index: 0 }, {});
  query("query-missing-topology", names.microgap, { index: 0 }, { profiles: 1 });
  add("status-after", "document.status", {});
  if (calls.length !== SKETCH_OPERATIONS.length ||
      calls.some((call) => !SKETCH_ALLOWED_OPERATIONS.has(call.toolRequest.invocation.operation)) ||
      new Set(calls.map((call) => call.requestId)).size !== calls.length) {
    throw new TypeError("Sketch plan does not match the allowed typed operation set or request-ID cardinality");
  }
  const casePhases = {
    "coordinate-positive": ["status-before", "create-single", "geometry-single", "inspect-single", "check-single", "query-coordinate-positive", "status-after"],
    "shifted-center-negative": ["create-single", "geometry-single", "query-shifted-center-negative"],
    "bad-diameter-negative": ["create-single", "geometry-single", "query-bad-diameter-negative"],
    "microgap-negative": ["create-microgap", "geometry-microgap", "check-microgap", "query-microgap"],
    "duplicate-edge-negative": ["create-duplicate", "geometry-duplicate", "check-duplicate", "query-duplicate"],
    "hole-inside-material-positive": ["create-annulus", "geometry-annulus", "query-hole-material"],
    "hole-inside-void-negative": ["create-annulus", "geometry-annulus", "query-hole-void"],
    "unambiguous-profile-selection-positive": ["create-single", "geometry-single", "query-unambiguous-profile"],
    "multiple-profiles-ambiguous-negative": ["create-ambiguous", "geometry-ambiguous", "query-ambiguous-profile"],
    "multiple-profiles-explicitly-selected-positive": ["create-ambiguous", "geometry-ambiguous", "query-explicit-profile"],
    "missing-or-incomplete-topology-no-first-profile-fallback": ["create-microgap", "geometry-microgap", "query-missing-topology"],
    "read-only-proof-preserves-scratch-state": ["status-before", "status-after"],
  };
  if (Object.keys(casePhases).length !== SKETCH_CASES.length ||
      SKETCH_CASES.some((caseId) => !Array.isArray(casePhases[caseId]) ||
        casePhases[caseId].some((phase) => !SKETCH_OPERATIONS.includes(phase)))) {
    throw new TypeError("Sketch case-to-operation plan is incomplete");
  }
  return Object.freeze({ schemaVersion: 1, clientId: input.clientId, epochId,
    ownerJobs: Object.freeze({ ...input.ownerJobs }),
    creationReceipt: Object.freeze({ status: input.creationReceipt.status,
      requestId: input.creationReceipt.requestId, jobId: input.creationReceipt.jobId,
      document: Object.freeze({ ...document }), epochId }),
    document, fixturePrefix: prefix, caseIds: Object.freeze([...SKETCH_CASES]),
    unsupportedCases: Object.freeze(["coordinate-positive", "shifted-center-negative", "bad-diameter-negative"]),
    casePhases: Object.freeze(Object.fromEntries(Object.entries(casePhases).map(([caseId, phases]) =>
      [caseId, Object.freeze([...phases])]))),
    calls: Object.freeze(calls),
    cleanup: Object.freeze({ kind: "owner-only-epoch-close", requestId: input.cleanupRequestId,
      command: "queue close-isolated-scratch", epochId, document,
      ownerJobs: Object.freeze({ ...input.ownerJobs }) }),
    caseResults: Object.freeze(Object.fromEntries(SKETCH_CASES.map((caseId) => [caseId,
      Object.freeze({ status: "NOTRUN", reason: "This broader proof plan is not dispatched; only the separate minimal first-smoke path has an injected fmcad.execute executor." })]))),
    executionPolicy: Object.freeze({ requireExactDocEpochClient: true, requireOwnerJobs: true,
      stopOnUnknown: true, replayUnknown: false, ownerCleanupOnly: true }),
    status: "NOTRUN", unsupportedCapability: "isolated-epoch-sketch.coordinate-check-for-full-proof",
    reason: "The separate six-operation first-smoke path is executable after actual authority. Full sketch-geometry-proof remains NOTRUN because the narrow epoch omits sketch.coordinate-check required for its three coordinate/world-geometry cases; this broader plan is not dispatched." });
}

module.exports = { BREP_CASES, BREP_PHASES, CAPTURE_CASES, CAPTURE_PHASES, SELECTION_CASES, SELECTION_PHASES,
  SKETCH_ALLOWED_OPERATIONS, SKETCH_CASES, SKETCH_OPERATIONS, SKETCH_REQUIRED_COUNTS,
  validateBrepRequest, validateCaptureRequest, validateSelectionRequest, validateSketchRequest };
