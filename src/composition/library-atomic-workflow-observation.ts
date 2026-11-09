import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type {
  QueueJob,
  QueueSnapshot,
} from "../../packages/core/src/domain/queue-model";
import type { PreparedPythonArtifact } from "../../packages/core/src/domain/python-artifact";
import type { CadContext } from "../../packages/core/src/application/cad/contracts";
import type { AtomicReport } from "../../packages/core/src/application/cad/atomic";
import type {
  AtomicReportSnapshot,
  AtomicFileIdentity,
} from "../../packages/node-adapters/src/persistence/atomic-observation";
const load = createRequire(__filename);
const { verifyAtomicObservationAdmission } = load(
  "../core/application/cad/atomic-observation",
) as typeof import("../../packages/core/src/application/cad/atomic-observation");
const { atomicRpcArgs } = load(
  "../core/application/cad/atomic",
) as typeof import("../../packages/core/src/application/cad/atomic");
const { clone, hash: canonicalHash } = load(
  "../core/application/cad/json",
) as typeof import("../../packages/core/src/application/cad/json");
const { preparePythonArtifact, cadBundleUnits } = load(
  "../../python",
) as typeof import("../../packages/node-adapters/src/python/artifact") &
  typeof import("../../packages/node-adapters/src/python/bundle");
const { resolveRuntimePaths } = load(
  "../config-platform",
) as typeof import("../../packages/node-adapters/src/config-platform");
const { snapshotReport, snapshotStillCurrent } = load(
  "../node-adapters/persistence/atomic-observation",
) as typeof import("../../packages/node-adapters/src/persistence/atomic-observation");
const { readBytes } = load(
  "../node-adapters/persistence/records",
) as typeof import("../../packages/node-adapters/src/persistence/records");
const { queueDirectory } = load("../../queue-connection") as {
  queueDirectory(): string;
};
const { decodeInvocation, policyArguments } = load(
  "../../cad-service",
) as typeof import("./cad-service");
export { snapshotStillCurrent };
export const {
  atomicStatusSummaryFromReply,
  validateAtomicReconcileInvocation,
} = load(
  "../core/application/cad/atomic-observation",
) as typeof import("../../packages/core/src/application/cad/atomic-observation");
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export interface AtomicApprovedScope {
  jobId: string;
  requestId: string;
  projectDirectory: string;
  reportPath: string;
  commandId: string;
  sessionNonce: string;
  docId: string;
}
export interface AtomicHolderScope extends AtomicApprovedScope {
  version: 1;
  kind: "atomic_holder_status";
}
export interface AtomicInvocation {
  version: 1;
  kind: "cad";
  operation: "batch.run";
  data: Record<string, unknown> & {
    reportPath: string;
    runId: string;
    atomic?: boolean;
  };
  doc: string;
  docId: string;
  docFileId?: unknown;
  component?: unknown;
  projectId?: unknown;
  preview?: unknown;
}
export type AtomicObservationJob = Omit<QueueJob, "request"> & {
  request: QueueJob["request"] & {
    backend?: string;
    inputFiles?: { path: string; sha256: string }[];
  };
};
export interface AtomicSourceEnvelope extends AtomicFileIdentity {
  path: string;
}
export interface AtomicRuntimeUnit {
  id: string;
  filename: string;
  sha256: string;
}
export interface AtomicRuntimeAbi {
  proof: Record<string, unknown> & {
    abiPinnedUnits: readonly AtomicRuntimeUnit[];
  };
  hash: string;
}
export interface PreparedAtomicObservation {
  scope: AtomicHolderScope & { clientId: string };
  jobHash: string;
  originalRpcCount: number;
  originalBuildHash: string;
  observerBuildHash: string;
  originalInvocationHash: string;
  sourceEnvelope: AtomicSourceEnvelope | null;
  identity: {
    commandId: string;
    runId: string;
    requestHash: string;
    backend: string;
    sessionNonce: string;
    documentIdentity: AtomicReport["documentIdentity"];
    resolvedIdentity: unknown;
  };
  expectedContext: CadContext;
  reportFingerprint: string;
  snapshot: AtomicReportSnapshot;
  args: Record<string, unknown>;
  artifact: PreparedPythonArtifact;
  sourceCompatibilityUnits: AtomicRuntimeUnit[];
  script: string;
  readOnly: true;
  atomicRuntimeAbi?: AtomicRuntimeAbi;
}
export interface AtomicObservationFence {
  prepared: PreparedAtomicObservation;
  jobId: string;
  observerJobId: string;
  clientId: string;
  state: QueueSnapshot;
  initialState: QueueSnapshot;
  initialActiveIds: string[];
  activeIds: string[];
  originalActiveIds?: string[];
  inFlight?: boolean;
  resetActive: unknown;
  owner: unknown;
  expectedOwner: unknown;
  buildHash: string;
  expectedBuildHash: string;
  instance: unknown;
  expectedInstance: unknown;
  instanceAlive: boolean;
  resuming?: boolean;
  adminTransition?: unknown;
}
const scopeKeys = [
  "version",
  "kind",
  "jobId",
  "requestId",
  "projectDirectory",
  "reportPath",
  "commandId",
  "sessionNonce",
  "docId",
];
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const field = (value: unknown, key: string): unknown =>
  object(value) ? value[key] : undefined;
const maxReportFileBytes = 16 * 1024 * 1024;
export const fastenersScope: Readonly<AtomicApprovedScope> = Object.freeze({
  jobId: "5fbcd38b-8e8a-4cd7-8eab-353e8b025b9a",
  requestId: "measured-fasteners-fixture-setup-20261027-1905z",
  projectDirectory: "/tmp/opencode/fmcad-backlog/measured-fasteners",
  reportPath: "/tmp/opencode/measured-fasteners-native/batch-v1",
  commandId: "fmcad_atomic_d1e7d293bcf73543563ead63f4df62c7",
  sessionNonce: "a87b938ad05f67893a0af5889b7b36c3",
  docId: "f9f27526-55d2-47bb-a4d8-312246f2de08",
});
const atomicRuntimeUnits = new Set([
  "runtime/python/fmcad/adapters/fusion/atomic.py",
  "runtime/python/fmcad/adapters/fusion/identity.py",
  "runtime/python/fmcad/adapters/fusion/values.py",
  "runtime/python/fmcad/domain/values.py",
  "assets/cad/core.py",
]);

const same = (left: unknown, right: unknown) =>
  canonicalHash(left) === canonicalHash(right);
const statusRuntimeFilename =
  "runtime/python/fmcad/adapters/fusion/atomic_status.py";

export function atomicRuntimeAbiUnits(
  root = resolveRuntimePaths({ anchor: __filename }).installation,
) {
  const units = cadBundleUnits(root)
    .filter((unit) => atomicRuntimeUnits.has(unit.filename))
    .map((unit) => ({
      id: unit.id,
      filename: unit.filename,
      sha256: digest(unit.source),
    }));
  if (units.length !== atomicRuntimeUnits.size)
    fail(
      "BUILD_CHANGED",
      "Canonical atomic ABI source inventory is incomplete",
    );
  return units;
}

function pythonLiteral(value: unknown): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string" || typeof value === "number")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(pythonLiteral).join(", ") + "]";
  return (
    "{" +
    Object.entries(value ?? {})
      .map(([key, item]) => JSON.stringify(key) + ": " + pythonLiteral(item))
      .join(", ") +
    "}"
  );
}

function prepareAtomicStatusScript(args: Record<string, unknown>) {
  if (args["operation"] !== "atomic_status")
    fail(
      "WORKFLOW_OPERATION_NOT_ALLOWED",
      "Only atomic_status may be prepared",
    );
  const wrapper = `

_ATOMIC_STATUS_REQUEST: AtomicStatusObject = ${pythonLiteral(clone(args))}

def run(_context: str) -> None:
    import adsk.core
    import json
    _value = atomic_status_readonly(_atomic_status_cast(AtomicStatusApplication, adsk.core.Application.get()), _ATOMIC_STATUS_REQUEST)
    _summary: AtomicStatusObject = {key: _value.get(key) for key in (
        'status', 'accepted', 'completed', 'destroyed', 'cleanupCompleted',
        'definitionDeleted', 'outcome', 'terminationReason', 'idle', 'createdCount',
        'executeCount', 'executeCompleted', 'terminationCompleted', 'notStarted')}
    _identity = _value.get('identity')
    if isinstance(_identity, dict):
        _summary['identity'] = {key: _identity.get(key) for key in (
            'commandId', 'runId', 'requestHash', 'backend', 'sessionNonce',
            'documentIdentity', 'resolvedIdentity')}
    _unavailable = _value.get('unavailableEvidence')
    if isinstance(_unavailable, list) and all(isinstance(item, str) for item in _unavailable):
        _summary['unavailableEvidence'] = _unavailable[:16]
    print('FMCAD_RESULT ' + json.dumps(_summary, allow_nan=False))
`;
  const root = resolveRuntimePaths({ anchor: __filename }).installation;
  const abiPinnedUnits = atomicRuntimeAbiUnits(root);
  const reader = {
    id: "atomic-status",
    filename: statusRuntimeFilename,
    source: fs.readFileSync(path.join(root, statusRuntimeFilename), "utf8"),
    role: "runtime" as const,
  };
  const artifact = preparePythonArtifact(
    [
      reader,
      {
        id: "wrapper",
        filename: "<fmcad-wrapper>",
        source: wrapper,
        role: "wrapper",
      },
    ],
    {
      request: args,
      context: {
        kind: "atomic-status-readonly-v1",
        executedUnits: [reader.filename, "<fmcad-wrapper>"],
        abiPinnedUnits,
      },
    },
  );
  return { artifact, abiPinnedUnits };
}

function validAtomicInvocation(
  invocation: unknown,
): invocation is AtomicInvocation {
  return (
    object(invocation) &&
    invocation["version"] === 1 &&
    invocation["kind"] === "cad" &&
    invocation["operation"] === "batch.run" &&
    object(invocation["data"]) &&
    (invocation["data"]["atomic"] === undefined ||
      invocation["data"]["atomic"] === true) &&
    typeof invocation["data"]["reportPath"] === "string" &&
    typeof invocation["data"]["runId"] === "string" &&
    typeof invocation["doc"] === "string" &&
    !!invocation["doc"] &&
    typeof invocation["docId"] === "string" &&
    !!invocation["docId"]
  );
}

export function atomicInvocationProjection(
  job: AtomicObservationJob,
  approvedScope = fastenersScope,
) {
  const payload = job?.request?.payload;
  const invocation =
    payload?.["kind"] === "cad-command" ? payload["invocation"] : payload;
  if (validAtomicInvocation(invocation))
    return { invocation, sourceEnvelope: null };
  const r = job?.request,
    argv = r?.argv;
  // The original CLI job retains raw argv/hash forever. The broker wrote its
  // typed worker envelope BEFORE the first turn. Observe that immutable input,
  // never rerun argv, reread a mutable --file, or add payload to the original job.
  if (
    payload !== undefined ||
    job?.id !== approvedScope.jobId ||
    job?.requestId !== approvedScope.requestId ||
    r?.cwd !== approvedScope.projectDirectory ||
    r?.phased !== true ||
    !Array.isArray(argv) ||
    argv.length !== 9 ||
    argv[0] !== "batch" ||
    argv[1] !== "run" ||
    argv[2] !== "--doc" ||
    argv[4] !== "--doc-id" ||
    argv[5] !== approvedScope.docId ||
    argv[6] !== "--file" ||
    argv[8] !== "--json" ||
    typeof argv[7] !== "string" ||
    !path.isAbsolute(argv[7]) ||
    !Array.isArray(r.inputFiles) ||
    r.inputFiles.length !== 1 ||
    r.inputFiles[0]?.path !== argv[7] ||
    !/^[a-f0-9]{64}$/.test(r.inputFiles[0]?.sha256 || "")
  )
    return null;
  try {
    const file = path.join(queueDirectory(), "jobs", job.id, "request.json");
    const before = fs.lstatSync(file);
    const bytes = readBytes(file, maxReportFileBytes, fs, file);
    const envelope: unknown = JSON.parse(bytes.toString("utf8"));
    if (!object(envelope) || !object(envelope["request"])) return null;
    const worker = envelope["request"];
    const parsed = decodeInvocation(worker["payload"]);
    if (
      envelope["id"] !== job.id ||
      envelope["buildHash"] !== r.buildHash ||
      !object(worker) ||
      parsed.kind !== "cad-command" ||
      Object.entries(r).some(
        ([key, value]) => key !== "argv" && !same(value, worker[key]),
      ) ||
      Object.keys(worker).some(
        (key) => !Object.hasOwn(r, key) && key !== "payload",
      ) ||
      !same(worker["argv"], policyArguments(parsed)) ||
      parsed.invocation.doc !== argv[3] ||
      parsed.invocation.docId !== argv[5] ||
      parsed.output?.json !== true ||
      parsed.output?.summary === true ||
      !validAtomicInvocation(parsed.invocation)
    )
      return null;
    const after = fs.lstatSync(file);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      return null;
    return {
      invocation: parsed.invocation,
      sourceEnvelope: {
        path: file,
        dev: after.dev,
        ino: after.ino,
        size: after.size,
        mtimeMs: after.mtimeMs,
        sha256: digest(bytes),
      },
    };
  } catch {
    return null;
  } // Missing/changed/unvalidated original input is never reconstructed by replay.
}

export function sourceEnvelopeStillCurrent(
  snapshot: AtomicSourceEnvelope | null,
) {
  if (!snapshot) return true;
  try {
    const stat = fs.lstatSync(snapshot.path);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.dev === snapshot.dev &&
      stat.ino === snapshot.ino &&
      stat.size === snapshot.size &&
      stat.mtimeMs === snapshot.mtimeMs &&
      digest(
        readBytes(snapshot.path, maxReportFileBytes, fs, snapshot.path),
      ) === snapshot.sha256
    );
  } catch {
    return false;
  }
}

function atomicInvocation(
  job: AtomicObservationJob,
  approvedScope = fastenersScope,
) {
  return atomicInvocationProjection(job, approvedScope)?.invocation ?? null;
}

export function isAtomicObservationCandidate(
  job: AtomicObservationJob,
  originalBuildHash: unknown,
  approvedScope = fastenersScope,
) {
  const invocation = atomicInvocation(job, approvedScope);
  return !!(
    job &&
    job.state === "needs_reconciliation" &&
    job.kind === "command" &&
    job.id === approvedScope.jobId &&
    job.requestId === approvedScope.requestId &&
    job.request?.cwd === approvedScope.projectDirectory &&
    Number.isSafeInteger(job.physicalTurns) &&
    (job.physicalTurns ?? 0) > 0 &&
    Number.isSafeInteger(job.dispatch?.rpcCount) &&
    (job.dispatch?.rpcCount ?? 0) > 0 &&
    job.request?.backend === "addin" &&
    typeof originalBuildHash === "string" &&
    job.request.buildHash === originalBuildHash &&
    invocation?.data.atomic !== false &&
    path.resolve(job.request.cwd, invocation?.data.reportPath || "") ===
      approvedScope.reportPath &&
    invocation?.docId === approvedScope.docId &&
    invocation?.data.runId &&
    invocation?.data.reportPath &&
    invocation.doc &&
    invocation.docId
  );
}

export function deriveAtomicHolderScope(
  job: AtomicObservationJob,
  reconcileInvocation: unknown,
  reportPathRoot = job?.request?.cwd,
  approvedScope = fastenersScope,
) {
  const invocation = atomicInvocation(job, approvedScope);
  if (
    !invocation ||
    !object(reconcileInvocation) ||
    reconcileInvocation["operation"] !== "batch.reconcile" ||
    !object(reconcileInvocation["data"]) ||
    typeof job.request.cwd !== "string" ||
    !path.isAbsolute(job.request.cwd)
  )
    return null;
  const data = reconcileInvocation["data"];
  if (
    typeof data["reportPath"] !== "string" ||
    typeof data["blockedJobId"] !== "string" ||
    typeof data["commandId"] !== "string" ||
    typeof data["sessionNonce"] !== "string" ||
    data["blockedJobId"] !== job.id ||
    reconcileInvocation["docId"] !== invocation.docId ||
    reconcileInvocation["doc"] !== invocation.doc ||
    path.resolve(reportPathRoot ?? job.request.cwd, data["reportPath"]) !==
      path.resolve(job.request.cwd, invocation.data.reportPath)
  )
    return null;
  const scope: AtomicHolderScope = {
    version: 1,
    kind: "atomic_holder_status",
    jobId: job.id,
    requestId: job.requestId,
    projectDirectory: job.request.cwd,
    reportPath: path.resolve(job.request.cwd, invocation.data.reportPath),
    commandId: data["commandId"],
    sessionNonce: data["sessionNonce"],
    docId: reconcileInvocation["docId"],
  };
  return Object.entries(approvedScope).every(
    ([key, value]) => scope[key as keyof AtomicApprovedScope] === value,
  )
    ? scope
    : null;
}

function validateScope(scope: unknown): asserts scope is AtomicHolderScope {
  if (
    !object(scope) ||
    Object.keys(scope).length !== scopeKeys.length ||
    Object.keys(scope).some((key) => !scopeKeys.includes(key)) ||
    scope["version"] !== 1 ||
    scope["kind"] !== "atomic_holder_status" ||
    typeof scope["jobId"] !== "string" ||
    typeof scope["requestId"] !== "string" ||
    typeof scope["projectDirectory"] !== "string" ||
    typeof scope["reportPath"] !== "string" ||
    typeof scope["commandId"] !== "string" ||
    typeof scope["sessionNonce"] !== "string" ||
    typeof scope["docId"] !== "string"
  ) {
    fail(
      "INVALID_WORKFLOW_SCOPE",
      "Atomic holder observation requires the exact version-1 scoped identity",
    );
  }
  if (
    !path.isAbsolute(scope["projectDirectory"]) ||
    path.resolve(scope["projectDirectory"]) !== scope["projectDirectory"] ||
    !/^fmcad_atomic_[0-9a-f]{32}$/.test(scope["commandId"]) ||
    !/^[0-9a-f]{32}$/.test(scope["sessionNonce"]) ||
    !scope["docId"].trim() ||
    !scope["requestId"].trim() ||
    !scope["jobId"].trim()
  ) {
    fail(
      "INVALID_WORKFLOW_SCOPE",
      "Atomic holder observation identity is malformed",
    );
  }
}

export function validateAtomicRuntimeSourceCompatibility(
  prepared: PreparedAtomicObservation,
  originalUnitGroups: unknown,
) {
  if (
    !prepared?.artifact?.units ||
    !Array.isArray(originalUnitGroups) ||
    originalUnitGroups.some((group) => !Array.isArray(group))
  )
    fail(
      "BUILD_CHANGED",
      "Original atomic Python source-unit receipts are unavailable",
    );
  const originalUnits = new Map();
  for (const group of originalUnitGroups) {
    for (const unit of group) {
      if (
        !object(unit) ||
        typeof unit["filename"] !== "string" ||
        typeof unit["sha256"] !== "string"
      )
        continue;
      if (!atomicRuntimeUnits.has(unit["filename"])) continue;
      const previous = originalUnits.get(unit["filename"]);
      if (previous && previous !== unit["sha256"])
        fail(
          "RECEIPT_MISMATCH",
          `Original atomic source-unit receipts conflict: ${unit["filename"]}`,
        );
      originalUnits.set(unit["filename"], unit["sha256"]);
    }
  }
  if (
    !Array.isArray(prepared.sourceCompatibilityUnits) ||
    !same(prepared.sourceCompatibilityUnits, atomicRuntimeAbiUnits())
  )
    fail(
      "BUILD_CHANGED",
      "Atomic ABI provenance changed independently of the executed reader",
    );
  const runtime = prepared.artifact.units.filter(
    (unit) => unit.role === "runtime",
  );
  if (
    runtime.length !== 1 ||
    runtime[0]?.filename !== statusRuntimeFilename ||
    runtime[0]?.sha256 !==
      digest(
        fs.readFileSync(
          path.join(
            resolveRuntimePaths({ anchor: __filename }).installation,
            statusRuntimeFilename,
          ),
        ),
      )
  )
    fail(
      "BUILD_CHANGED",
      "Executed atomic status reader is not the canonical read-only source unit",
    );
  const current = new Map(
    prepared.sourceCompatibilityUnits.map((unit) => [
      unit.filename,
      unit.sha256,
    ]),
  );
  for (const filename of atomicRuntimeUnits) {
    if (
      typeof originalUnits.get(filename) !== "string" ||
      current.get(filename) !== originalUnits.get(filename)
    )
      fail(
        "BUILD_CHANGED",
        `Atomic status dependency changed since the original dispatch: ${filename}`,
      );
  }
  return true;
}

export function bindAtomicRuntimeAbi(
  prepared: PreparedAtomicObservation,
  abi: AtomicRuntimeAbi,
) {
  if (
    !abi ||
    canonicalHash(abi.proof) !== abi.hash ||
    !same(abi.proof.abiPinnedUnits, prepared.sourceCompatibilityUnits)
  )
    fail(
      "BUILD_CHANGED",
      "Atomic runtime ABI proof does not bind the canonical pinned source inventory",
    );
  const original = prepared.artifact;
  const mapped = new Set(original.sourceMap.map((entry) => entry.unitId));
  const artifact = preparePythonArtifact(
    original.units.map((unit) => ({ ...unit, embedded: !mapped.has(unit.id) })),
    {
      request: original.request,
      context: {
        ...(object(original.context) ? original.context : {}),
        atomicRuntimeAbiHash: abi.hash,
      },
    },
  );
  return {
    ...prepared,
    artifact,
    script: artifact.script,
    atomicRuntimeAbi: abi,
  };
}

export function verifyAtomicObservationFence(fence: AtomicObservationFence) {
  verifyAtomicObservationAdmission(fence);
  const { prepared, jobId, state } = fence;
  const currentJob = state.jobs[jobId];
  if (!currentJob)
    fail(
      "WORKFLOW_IDENTITY_MISMATCH",
      "Original job is unavailable after admission validation",
    );
  if (!snapshotStillCurrent(prepared.snapshot))
    fail(
      "WORKFLOW_REPORT_CHANGED",
      "Atomic report changed before scoped observation",
    );
  if (
    prepared.atomicRuntimeAbi &&
    !(
      load("../../atomic-runtime-abi") as {
        atomicRuntimeAbiStillCurrent(abi: AtomicRuntimeAbi): boolean;
      }
    ).atomicRuntimeAbiStillCurrent(prepared.atomicRuntimeAbi)
  )
    fail(
      "BUILD_CHANGED",
      "Original atomic runtime ABI witness changed before scoped observation",
    );
  const approvedScope: AtomicApprovedScope = {
    jobId: prepared.scope.jobId,
    requestId: prepared.scope.requestId,
    projectDirectory: prepared.scope.projectDirectory,
    reportPath: prepared.scope.reportPath,
    commandId: prepared.scope.commandId,
    sessionNonce: prepared.scope.sessionNonce,
    docId: prepared.scope.docId,
  };
  const original = atomicInvocationProjection(currentJob, approvedScope);
  if (
    !original ||
    canonicalHash(original.invocation) !== prepared.originalInvocationHash ||
    !same(original.sourceEnvelope, prepared.sourceEnvelope) ||
    !sourceEnvelopeStillCurrent(prepared.sourceEnvelope)
  )
    fail(
      "WORKFLOW_INPUT_CHANGED",
      "Original accepted atomic invocation/envelope changed before scoped observation",
    );
  return true;
}

export async function prepareAtomicHolderObservation(
  job: AtomicObservationJob,
  scope: unknown,
  {
    clientId,
    observerBuildHash,
    originalBuildHash,
    approvedScope = fastenersScope,
  }: {
    clientId: string;
    observerBuildHash: string;
    originalBuildHash: string;
    approvedScope?: AtomicApprovedScope;
  },
): Promise<PreparedAtomicObservation> {
  validateScope(scope);
  if (
    !job ||
    job.id !== scope.jobId ||
    job.requestId !== scope.requestId ||
    job.clientId !== clientId ||
    job.state !== "needs_reconciliation" ||
    job.kind !== "command" ||
    !Number.isSafeInteger(job.physicalTurns) ||
    (job.physicalTurns ?? 0) < 1 ||
    (job.dispatch?.rpcCount || 0) < 1
  ) {
    fail(
      "WORKFLOW_OWNER_OR_JOB_MISMATCH",
      "Scoped atomic observation does not match the authenticated unresolved job",
    );
  }
  if (
    !Object.entries(approvedScope).every(
      ([key, value]) => scope[key as keyof AtomicApprovedScope] === value,
    )
  )
    fail(
      "WORKFLOW_IDENTITY_MISMATCH",
      "Atomic holder observation is restricted to the approved job/report/command/session/document scope",
    );
  if (
    !job.request ||
    typeof job.request.cwd !== "string" ||
    !path.isAbsolute(job.request.cwd) ||
    job.request.cwd !== scope.projectDirectory ||
    typeof originalBuildHash !== "string" ||
    !originalBuildHash ||
    job.request.buildHash !== originalBuildHash ||
    job.request.backend !== "addin" ||
    typeof observerBuildHash !== "string" ||
    !observerBuildHash
  ) {
    fail(
      "BUILD_CHANGED",
      "Original dispatch build and current observer build must be independently pinned",
    );
  }
  const projection = atomicInvocationProjection(job, approvedScope);
  const invocation = projection?.invocation;
  if (!invocation)
    fail(
      "WORKFLOW_TYPE_NOT_ALLOWED",
      "Only the exact pinned typed atomic batch invocation permits holder observation",
    );
  const snapshot = await snapshotReport(scope.reportPath);
  const report = snapshot.report;
  const expectedRequest: Record<string, unknown> = clone(invocation.data);
  delete expectedRequest["mode"];
  delete expectedRequest["reportPath"];
  expectedRequest["atomic"] = true;
  const expectedContext = {
    doc: invocation.doc,
    component: invocation.component ?? null,
    projectId: invocation.projectId ?? null,
    docId: invocation.docId ?? null,
    docFileId: invocation.docFileId ?? null,
    preview: invocation.preview === true,
  };
  const contextKeys = Object.keys(
    expectedContext,
  ) as (keyof typeof expectedContext)[];
  const contextMatches =
    object(report.context) &&
    Object.keys(report.context).every((key) =>
      contextKeys.some((contextKey) => contextKey === key),
    ) &&
    contextKeys.every(
      (key) =>
        (report.context[key] ?? (key === "preview" ? false : null)) ===
        expectedContext[key],
    );
  const expectedIdentity = report.documentIdentity?.expected;
  const resolvedIdentity = report.documentIdentity?.resolved;
  const submittedReportPath = path.resolve(
    job.request.cwd,
    invocation.data.reportPath,
  );
  const matches =
    report.outcome === "unknown" &&
    report.status === "unknown" &&
    report.reportPath === scope.reportPath &&
    submittedReportPath === scope.reportPath &&
    report.atomic?.effective === true &&
    report.atomic.backend === "addin" &&
    report.runId === invocation.data.runId &&
    same(report.request, expectedRequest) &&
    contextMatches &&
    report.commandId === scope.commandId &&
    report.sessionNonce === scope.sessionNonce &&
    report.context?.doc === invocation.doc &&
    report.context?.docId === scope.docId &&
    invocation.docId === scope.docId &&
    expectedIdentity?.["creationId"] === scope.docId &&
    field(resolvedIdentity, "creationId") === scope.docId &&
    (report.context?.component ?? null) === (invocation.component ?? null) &&
    (report.context?.projectId ?? null) === (invocation.projectId ?? null) &&
    (report.context?.docFileId ?? null) === (invocation.docFileId ?? null) &&
    expectedIdentity?.["name"] === invocation.doc &&
    expectedIdentity?.["fileId"] === (invocation.docFileId ?? null) &&
    field(resolvedIdentity, "fileId") === (invocation.docFileId ?? null) &&
    report.commandId === scope.commandId &&
    report.sessionNonce === scope.sessionNonce &&
    /^fmcad_atomic_[a-f0-9]{32}$/.test(report.commandId) &&
    /^[a-f0-9]{32}$/.test(report.sessionNonce);
  if (!matches)
    fail(
      "WORKFLOW_IDENTITY_MISMATCH",
      "Atomic report, worker evidence and requested document pins do not match",
    );

  const args = atomicRpcArgs(report, "atomic_status");
  const { artifact, abiPinnedUnits } = prepareAtomicStatusScript(args);
  const stableSnapshot = {
    dir: snapshot.dir,
    directory: snapshot.directory,
    lock: snapshot.lock,
    files: snapshot.files,
    fingerprint: snapshot.fingerprint,
  };
  return {
    scope: { ...scope, clientId },
    jobHash: job.hash,
    originalRpcCount: job.dispatch?.rpcCount ?? 0,
    originalBuildHash,
    observerBuildHash,
    originalInvocationHash: canonicalHash(invocation),
    sourceEnvelope: projection.sourceEnvelope,
    identity: {
      commandId: report.commandId,
      runId: report.runId,
      requestHash: report.requestHash,
      backend: report.atomic.backend,
      sessionNonce: report.sessionNonce,
      documentIdentity: report.documentIdentity,
      resolvedIdentity,
    },
    expectedContext: {
      doc: invocation.doc,
      docId: report.context.docId ?? null,
      docFileId: report.context.docFileId ?? null,
      component: report.context.component ?? null,
      projectId: report.context.projectId ?? null,
    },
    reportFingerprint: snapshot.fingerprint,
    snapshot: stableSnapshot,
    args,
    artifact,
    sourceCompatibilityUnits: abiPinnedUnits,
    script: artifact.script,
    readOnly: true,
  };
}

export async function readCurrentAtomicObservationReport(reportPath: string) {
  const snapshot = await snapshotReport(reportPath);
  const report = snapshot.report;
  if (
    report.status !== "unknown" ||
    report.outcome !== "unknown" ||
    report.atomic?.effective !== true ||
    report.atomic.backend !== "addin" ||
    !report.documentIdentity?.resolved
  ) {
    fail(
      "WORKFLOW_REPORT_CHANGED",
      "Atomic report is no longer the same unresolved add-in workflow",
    );
  }
  return {
    fingerprint: snapshot.fingerprint,
    snapshot: {
      dir: snapshot.dir,
      directory: snapshot.directory,
      lock: snapshot.lock,
      files: snapshot.files,
      fingerprint: snapshot.fingerprint,
    },
    runId: report.runId,
    requestHash: report.requestHash,
    commandId: report.commandId,
    sessionNonce: report.sessionNonce,
    docId: report.context?.docId,
    identity: {
      commandId: report.commandId,
      runId: report.runId,
      requestHash: report.requestHash,
      backend: report.atomic.backend,
      sessionNonce: report.sessionNonce,
      documentIdentity: report.documentIdentity,
      resolvedIdentity: report.documentIdentity.resolved,
    },
  };
}
