import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type {
  CadWorkerInvocation,
  CatalogInvocation,
  RunInvocation,
} from "@fmcad/core";
import type {
  SaveRequest,
  SaveEvidence,
  SaveStatus,
} from "../../packages/core/src/application/documents/save.js";
import type {
  StageDefinition,
  StageReceiptEvidence,
  StageScope,
} from "../../packages/core/src/application/stage-journal.js";
import type {
  AuthenticatedStageOwner,
  StageOwnerJob,
  StageOwnerPorts,
} from "../../packages/node-adapters/src/persistence/stage-owner.js";
import type { BatchStages } from "./batch.js";
import type { DocumentSaveStageOwner } from "../../packages/core/src/application/documents/stages.js";

const load = createRequire(__filename);
const stagedRoot = [
  path.resolve(__dirname, "../dist"),
  path.resolve(__dirname, ".."),
].find(
  (root) =>
    fs.existsSync(path.join(root, "core/application/cad/json.js")) &&
    fs.existsSync(path.join(root, "node-adapters/persistence/stage-owner.js")),
);
if (!stagedRoot) throw new Error("Cannot locate staged core runtime modules");
const hostRoot = [
  path.resolve(__dirname, ".."),
  path.resolve(__dirname, "../.."),
].find(
  (root) =>
    fs.existsSync(path.join(root, "queue-instance.js")) &&
    fs.existsSync(path.join(root, "queue-isolated-epoch.js")),
);
if (!hostRoot) throw new Error("Cannot locate staged queue host modules");
const loadStaged = (file: string) => load(path.join(stagedRoot, file));
const loadHost = (file: string) => load(path.join(hostRoot, file));
const json = loadStaged(
  "core/application/cad/json.js",
) as typeof import("../../packages/core/src/application/cad/json.js");
const stageCore = loadStaged(
  "core/application/stage-journal.js",
) as typeof import("../../packages/core/src/application/stage-journal.js");
const documentSave = loadStaged(
  "core/application/documents/save.js",
) as typeof import("../../packages/core/src/application/documents/save.js");
const atomic = loadStaged(
  "core/application/cad/atomic-receipt.js",
) as typeof import("../../packages/core/src/application/cad/atomic-receipt.js");
const { createAuthenticatedStageOwner } = loadStaged(
  "node-adapters/persistence/stage-owner.js",
) as typeof import("../../packages/node-adapters/src/persistence/stage-owner.js");
const { stageReceiptReference } = loadStaged(
  "node-adapters/persistence/stage-journal.js",
) as typeof import("../../packages/node-adapters/src/persistence/stage-journal.js");
const { readBytes } = loadStaged(
  "node-adapters/persistence/records.js",
) as typeof import("../../packages/node-adapters/src/persistence/records.js");
const queueInstance = loadHost("queue-instance.js") as Pick<
  StageOwnerPorts,
  "buildHash" | "sameInstance" | "nativeWorkflowIdentity"
>;
const epoch = () =>
  loadHost("queue-isolated-epoch.js") as {
    isolatedEpochDirectory(directory: string): string;
  };

type Accepted = AuthenticatedStageOwner["accepted"];
type ReceiptInput = Parameters<StageOwnerPorts["readOriginalReceipt"]>[0];
type PinInput = Parameters<StageOwnerPorts["resolvePinnedDocument"]>[0];
type PinnedDocument = AuthenticatedStageOwner["owner"]["pinnedDocument"];
interface DocumentRow {
  id?: string;
  fileId?: string | null;
  isSaved?: boolean;
  name?: string;
}
interface Preflight {
  instance?: {
    documents?: DocumentRow[];
    documentState?: {
      status?: string;
      state?: {
        identity?: {
          name?: string;
          creationId?: string;
          fileId?: string | null;
          version?: number;
        };
      };
    };
  };
}
interface Selector {
  creationId?: string | null | undefined;
  fileId?: string | null | undefined;
  name?: string | null | undefined;
}
interface PinAdditions {
  allowUnsaved?: boolean;
  projectId?: string;
}
interface SaveReceiptRecord {
  sequence?: number;
  operation?: string;
  binding?: unknown;
  state?: SaveStatus;
  result?: SaveEvidence;
}
interface AtomicReceiptRecord {
  journal?: { event?: unknown; nativeOutcome?: unknown };
}
interface HelperResult {
  success?: unknown;
  error?: unknown;
  helperCallsOnly?: { status?: unknown; effects?: unknown }[];
}
export interface VerifiedStageInputs {
  brokerDirectory: string;
  jobId: string;
  clientId?: string;
  projectDirectory?: string;
  buildHash?: string;
}
export interface AuthenticatedStageDependencies {
  owner: AuthenticatedStageOwner;
  document:
    | ReturnType<typeof import("./document-stages.js").createDocumentSaveStages>
    | undefined;
  batch: BatchStages | undefined;
  helper: ReturnType<typeof createHelperStages> | undefined;
  stage: {
    journalInspect: AuthenticatedStageOwner["inspect"];
    resumePlan: AuthenticatedStageOwner["resumePlan"];
    revalidate: AuthenticatedStageOwner["revalidate"];
  };
  journalInspect: AuthenticatedStageOwner["inspect"];
  resumePlan: AuthenticatedStageOwner["resumePlan"];
  revalidate: AuthenticatedStageOwner["revalidate"];
}

const digest = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};
function acceptedPayload(
  job: Pick<StageOwnerJob, "request">,
  accepted: Accepted,
): CadWorkerInvocation {
  const retained = accepted.find((item) => item.reference.kind === "payload");
  if (!retained) throw new Error("Owning job has no retained typed payload");
  const payload = JSON.parse(
    retained.bytes.toString("utf8"),
  ) as CadWorkerInvocation;
  if (json.canonical(payload) !== json.canonical(job.request.payload))
    throw new Error(
      "Retained typed payload differs from the authenticated request",
    );
  return payload;
}
function catalogInvocation(value: unknown): CatalogInvocation | null {
  const payload = value as CadWorkerInvocation | null | undefined;
  if (payload?.kind === "cad") return payload;
  if (payload?.kind === "cad-command") return payload.invocation;
  return null;
}
export function requiresPhysicalStageOwner(value: unknown): boolean {
  const payload = value as CadWorkerInvocation | null | undefined;
  const invocation = catalogInvocation(payload);
  return !!(
    (payload?.kind === "run" && payload.request?.helperVersion === "cad-v1") ||
    (invocation &&
      ["document.save.once", "batch.run", "definition.instantiate"].includes(
        invocation.operation,
      ))
  );
}
function candidates(preflight: Preflight, selector: Selector) {
  const rows = preflight.instance?.documents ?? [];
  const matching = rows.filter(
    (row) =>
      (!selector.creationId || row.id === selector.creationId) &&
      (!selector.fileId || row.fileId === selector.fileId),
  );
  const stateIdentity =
    preflight.instance?.documentState?.status === "complete"
      ? preflight.instance.documentState.state?.identity
      : null;
  if (selector.name && matching.some((row) => typeof row.name === "string"))
    return matching.filter((row) => row.name === selector.name);
  if (selector.name && stateIdentity && stateIdentity.name !== selector.name)
    return [];
  if (
    selector.name &&
    !stateIdentity &&
    matching.length !== 1 &&
    !selector.creationId &&
    !selector.fileId
  )
    return [];
  return matching;
}
function pinFromPreflight(
  preflight: Preflight,
  selector: Selector,
  additions: PinAdditions = {},
): PinnedDocument {
  const rows = candidates(preflight, selector);
  if (
    rows.length !== 1 ||
    typeof rows[0]!.id !== "string" ||
    (typeof rows[0]!.fileId !== "string" &&
      !(
        additions.allowUnsaved === true &&
        rows[0]!.fileId === null &&
        rows[0]!.isSaved === false
      ))
  )
    throw new Error(
      "Authenticated document selector does not identify exactly one open document",
    );
  const pinAdditions = { ...additions };
  delete pinAdditions.allowUnsaved;
  const result: PinnedDocument = {
    creationId: rows[0]!.id!,
    fileId: rows[0]!.fileId!,
    ...pinAdditions,
  };
  if (selector.name) result["selectorName"] = selector.name;
  const snapshot = preflight.instance?.documentState;
  const identity =
    snapshot?.status === "complete" ? snapshot.state?.identity : null;
  if (
    identity?.creationId === result.creationId &&
    identity?.fileId === result.fileId &&
    Number.isSafeInteger(identity.version)
  )
    result.version = identity.version!;
  return result;
}
function safeReportRoot(
  scope: StageScope,
  job: Pick<StageOwnerJob, "request">,
  reportPath: string,
) {
  const resolved = path.resolve(job.request.cwd, reportPath);
  if (!inside(scope.project, resolved))
    throw new Error("Owner receipt directory escaped project scope");
  return resolved;
}
function numbered<T>(directory: string) {
  if (fs.realpathSync(directory) !== directory)
    throw new Error("Owner receipt directory is not canonical");
  const names = fs
    .readdirSync(directory)
    .filter((name) => /^\d{8}\.json$/.test(name))
    .sort();
  if (
    names.some(
      (name, index) => name !== `${String(index).padStart(8, "0")}.json`,
    )
  )
    throw new Error("Owner receipt history has a sequence gap");
  return names.map((name, sequence) => {
    const file = path.join(directory, name);
    const bytes = readBytes(file, 16 * 1024 * 1024, fs, file);
    return {
      file,
      bytes,
      record: JSON.parse(bytes.toString("utf8")) as T,
      sequence,
    };
  });
}
function documentSaveReceipt({
  scope,
  stage,
  reference,
  lifecycle,
}: ReceiptInput): StageReceiptEvidence {
  const payload = acceptedPayload(lifecycle.job, lifecycle.accepted);
  const invocation = catalogInvocation(payload);
  if (
    !invocation ||
    !["document.save.once", "document.save.observe"].includes(
      invocation.operation,
    )
  )
    return { status: "missing" };
  const data = { ...invocation.data } as unknown as SaveRequest;
  const binding = documentSave.bindingFor(data);
  if (
    scope.document !== json.canonical(binding.target) ||
    stage.id !== "document.save.once" ||
    stage.requestHash !== binding.requestHash ||
    reference !==
      stageReceiptReference(Buffer.from(json.canonical(binding), "utf8"))
  )
    return { status: "corrupt" };
  const root = safeReportRoot(scope, lifecycle.job, data.reportPath);
  const directory = path.join(
    root,
    "document-save",
    json.hash([binding.requestId, binding.operationId]),
  );
  let records: ReturnType<typeof numbered<SaveReceiptRecord>>;
  try {
    records = numbered<SaveReceiptRecord>(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "missing" };
    throw error;
  }
  if (!records.length) return { status: "missing" };
  const states = new Set([
    "submit_uncertain",
    "accepted",
    "pending",
    "complete",
    "failed",
    "blocked",
    "unknown",
    "noop",
  ]);
  for (const { record, sequence } of records) {
    if (
      record.sequence !== sequence ||
      record.operation !== "document.save.once" ||
      json.canonical(record.binding) !== json.canonical(binding) ||
      !record.result ||
      record.state !== record.result.status ||
      !states.has(record.state!)
    )
      return { status: "corrupt" };
  }
  const last = records.at(-1)!;
  const result = last.record.result!;
  const accepted = records.findLast(
    (item) =>
      item.record.result?.accepted === true &&
      item.record.result?.changed === true &&
      ["accepted", "pending", "complete"].includes(item.record.result?.status),
  );
  if (
    result.status !== "complete" ||
    result.changed !== true ||
    (result.baselineVersion !== undefined &&
      result.baselineVersion !== binding.target.version) ||
    !Number.isSafeInteger(result.resultingVersion) ||
    result.resultingVersion! <= binding.target.version ||
    result.cloudComplete !== true ||
    !lifecycle.rpcReceipts.length
  )
    return {
      status: "unknown",
      reason: `Document save receipt is not terminal-complete: ${json.canonical(result)}`,
    };
  const sha256 = digest(last.bytes);
  const nativeEvidence = accepted
    ? accepted.bytes
    : Buffer.from(
        json.canonical({
          submitIntent:
            records
              .find((item) => item.record.result?.status === "submit_uncertain")
              ?.bytes.toString("base64") ?? null,
          rpcReceipts: lifecycle.rpcReceipts.map((item) => ({
            binding: item.binding,
            receipt: item.sha256,
            native: item.nativeSha256 ?? null,
          })),
        }),
        "utf8",
      );
  return {
    status: "completed",
    sha256,
    ownerTerminalSha256: sha256,
    nativeTerminalSha256: digest(nativeEvidence),
    postflightSha256: lifecycle.postflightEvidenceSha256,
  };
}
function batchBinding(
  payload: unknown,
  job: Pick<StageOwnerJob, "request" | "hash">,
) {
  const invocation = catalogInvocation(payload);
  if (!invocation) throw new Error("Batch receipt has no catalog invocation");
  const request = { ...invocation.data };
  delete request["mode"];
  delete request["reportPath"];
  const context = Object.fromEntries(
    Object.entries({
      doc: invocation.doc,
      docId: invocation.docId,
      docFileId: invocation.docFileId,
      component: invocation.component,
      projectId: invocation.projectId,
      preview: invocation.preview === true,
    }).filter(([, value]) => value !== undefined),
  );
  const requestHash = json.hash({ request, context });
  const reportPath =
    (invocation.data["reportPath"] as string) ||
    path.join(".fmcad-batch", invocation.data["runId"] as string);
  return {
    invocation,
    request,
    context,
    requestHash,
    reportPath: path.resolve(job.request.cwd, reportPath),
  };
}
function batchReceipt({
  scope,
  stage,
  reference,
  lifecycle,
}: ReceiptInput): StageReceiptEvidence {
  const payload = acceptedPayload(lifecycle.job, lifecycle.accepted);
  const binding = batchBinding(payload, lifecycle.job);
  const pinned = JSON.parse(scope.document) as PinnedDocument;
  const stageRequestHash = json.hash({
    jobRequestHash: lifecycle.job.hash,
    reportRequestHash: binding.requestHash,
  });
  if (
    !["batch.run", "definition.instantiate"].includes(
      binding.invocation.operation,
    ) ||
    (binding.invocation.docId &&
      pinned.creationId !== binding.invocation.docId) ||
    (binding.invocation.docFileId &&
      pinned.fileId !== binding.invocation.docFileId) ||
    !["batch.run", "batch.atomic"].includes(stage.id) ||
    stage.requestHash !== stageRequestHash ||
    reference !==
      stageReceiptReference(
        Buffer.from(
          json.canonical({
            operation: stage.id,
            requestHash: stageRequestHash,
          }),
          "utf8",
        ),
      )
  )
    return { status: "corrupt" };
  if (stage.id === "batch.atomic") {
    let atomicRecords: ReturnType<typeof numbered<AtomicReceiptRecord>>;
    try {
      atomicRecords = numbered<AtomicReceiptRecord>(
        safeReportRoot(scope, lifecycle.job, binding.reportPath),
      );
    } catch {
      return { status: "unknown" };
    }
    if (!atomicRecords.length) return { status: "missing" };
    let atomicReport;
    try {
      atomicReport = atomic.validateOwnedAtomicHistory(
        atomicRecords.map((item) => item.record),
        binding,
        pinned,
      );
    } catch {
      return { status: "corrupt" };
    }
    const finalRecord = atomicRecords.at(-1)?.record;
    if (
      atomicReport.status !== "success" ||
      atomicReport.outcome !== "committed" ||
      finalRecord?.journal?.event !== "finalized" ||
      finalRecord.journal.nativeOutcome !== "committed" ||
      !lifecycle.rpcReceipts.some((item) => item.nativeSha256)
    )
      return { status: "unknown" };
    const last = atomicRecords.at(-1)!;
    const receiptSha = digest(last.bytes);
    const nativeSet = digest(
      Buffer.from(
        json.canonical(
          lifecycle.rpcReceipts.map((item) => ({
            binding: item.binding,
            receipt: item.sha256,
            native: item.nativeSha256 ?? null,
          })),
        ),
        "utf8",
      ),
    );
    return {
      status: "completed",
      sha256: receiptSha,
      ownerTerminalSha256: receiptSha,
      nativeTerminalSha256: nativeSet,
      postflightSha256: lifecycle.postflightEvidenceSha256,
    };
  }
  let reportDirectory;
  try {
    reportDirectory = safeReportRoot(scope, lifecycle.job, binding.reportPath);
  } catch {
    return { status: "unknown" };
  }
  let terminal;
  try {
    terminal = (
      load("./batch.js") as typeof import("./batch.js")
    ).readBatchReportSync(reportDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "missing" };
    return { status: "corrupt", reason: (error as Error).message };
  }
  const report = terminal.report;
  if (
    ![1, 2].includes(report.version) ||
    report.operation !== "batch.run" ||
    report.runId !== binding.request["runId"] ||
    report.requestHash !== binding.requestHash ||
    json.canonical(report.request) !== json.canonical(binding.request) ||
    json.canonical(report.context) !== json.canonical(binding.context)
  )
    return { status: "corrupt" };
  const { expandDefinition } = load(
    "../core/application/cad/definition.js",
  ) as typeof import("../../packages/core/src/application/cad/definition.js");
  const { expectedFail } = load(
    "../core/application/cad/batch.js",
  ) as typeof import("../../packages/core/src/application/cad/batch.js");
  const { record } = load(
    "../core/application/cad/contracts.js",
  ) as typeof import("../../packages/core/src/application/cad/contracts.js");
  const { failedOutcome } = load(
    "../core/domain/outcome.js",
  ) as typeof import("../../packages/core/src/domain/outcome.js");
  const operations = expandDefinition(binding.request)["operations"];
  if (
    report.status !== "success" ||
    report.success !== true ||
    !Array.isArray(report.steps) ||
    !Array.isArray(operations) ||
    report.steps.length !== operations.length ||
    lifecycle.rpcReceipts.length === 0 ||
    report.steps.some((step, index) => {
      const expected: unknown = operations[index];
      return (
        !record(expected) ||
        step.id !== expected["id"] ||
        step.operation !== expected["operation"] ||
        (step.expectFail === true) !== (expected["expectFail"] === true) ||
        step.status !== "success" ||
        !(
          expectedFail(
            { expectFail: expected["expectFail"] === true },
            step.output,
          ) ||
          (step.output?.["success"] === true && !failedOutcome(step.output))
        )
      );
    })
  )
    return { status: "unknown" };
  const sha256 = digest(terminal.bytes);
  const nativeSet = digest(
    Buffer.from(
      json.canonical(
        lifecycle.rpcReceipts.map((item) => ({
          binding: item.binding,
          receipt: item.sha256,
          native: item.nativeSha256 ?? null,
        })),
      ),
      "utf8",
    ),
  );
  return {
    status: "completed",
    sha256,
    ownerTerminalSha256: sha256,
    nativeTerminalSha256: nativeSet,
    postflightSha256: lifecycle.postflightEvidenceSha256,
  };
}
function parseHelperResult(text: string): HelperResult | null {
  const lines = String(text)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("FMCAD_RESULT "));
  if (lines.length !== 1) return null;
  try {
    return JSON.parse(lines[0]!.slice("FMCAD_RESULT ".length)) as HelperResult;
  } catch {
    return null;
  }
}
function helperBinding(
  job: Pick<StageOwnerJob, "request" | "hash">,
  accepted: Accepted,
  value: unknown,
) {
  const payload = value as RunInvocation | null | undefined;
  const scriptPath =
    typeof payload?.request?.name === "string"
      ? path.resolve(job.request.cwd, payload.request.name)
      : null;
  const source = accepted.find(
    (item) =>
      item.reference.kind === "source" &&
      item.reference.originalPath === scriptPath,
  );
  if (
    !source ||
    payload?.kind !== "run" ||
    payload.request.helperVersion !== "cad-v1"
  )
    return null;
  return json.hash({
    jobHash: job.hash,
    sourceHash: source.reference.sha256,
    helperVersion: payload.request.helperVersion,
    docId: payload.request.identity.docId ?? null,
    docFileId: payload.request.identity.docFileId ?? null,
  });
}
function helperReceipt({
  scope,
  stage,
  reference,
  lifecycle,
}: ReceiptInput): StageReceiptEvidence {
  const payload = acceptedPayload(lifecycle.job, lifecycle.accepted);
  const baseRequestHash = helperBinding(
    lifecycle.job,
    lifecycle.accepted,
    payload,
  );
  const run = payload as RunInvocation;
  const pinned = JSON.parse(scope.document) as PinnedDocument;
  const scriptReceipts = lifecycle.rpcReceipts.filter((item) =>
    /^[a-f0-9]{64}$/.test(item.binding.sourceHash ?? ""),
  );
  if (
    !baseRequestHash ||
    stage.id !== "python.helpers.run" ||
    stage.requestHash !== baseRequestHash ||
    scriptReceipts.length !== 1 ||
    pinned.creationId !== run.request.identity.docId ||
    pinned.fileId !== (run.request.identity.docFileId ?? null)
  )
    return { status: "corrupt" };
  if (
    reference !==
    stageReceiptReference(
      Buffer.from(
        json.canonical({ operation: stage.id, requestHash: baseRequestHash }),
        "utf8",
      ),
    )
  )
    return { status: "corrupt" };
  const result = parseHelperResult(lifecycle.stdout);
  if (
    !result ||
    result.success !== true ||
    !Array.isArray(result.helperCallsOnly) ||
    result.error !== undefined ||
    lifecycle.rpcReceipts.length === 0 ||
    result.helperCallsOnly.some(
      (call) => call.status !== "completed" || call.effects !== "observed",
    )
  )
    return { status: "unknown" };
  const sha256 = lifecycle.stdoutSha256;
  const nativeSet = digest(
    Buffer.from(
      json.canonical(
        lifecycle.rpcReceipts.map((item) => ({
          binding: item.binding,
          receipt: item.sha256,
          native: item.nativeSha256 ?? null,
        })),
      ),
      "utf8",
    ),
  );
  return {
    status: "completed",
    sha256,
    ownerTerminalSha256: sha256,
    nativeTerminalSha256: nativeSet,
    postflightSha256: lifecycle.postflightEvidenceSha256,
  };
}
export async function createAuthenticatedStageDependencies(
  verifiedWorkerInputs?: Partial<VerifiedStageInputs> | null,
): Promise<AuthenticatedStageDependencies | null> {
  if (!verifiedWorkerInputs?.brokerDirectory || !verifiedWorkerInputs.jobId)
    return null;
  const brokerDirectory = fs.realpathSync(verifiedWorkerInputs.brokerDirectory);
  const admissionDirectory = epoch().isolatedEpochDirectory(brokerDirectory);
  if (fs.existsSync(path.join(admissionDirectory, "queue-state.pending.json")))
    throw new Error("Queue state has an unresolved durability marker");
  const queueFile = path.join(admissionDirectory, "queue-state.json");
  const queue = JSON.parse(
    readBytes(queueFile, 128 * 1024 * 1024, fs, queueFile).toString("utf8"),
  ) as { jobs?: Record<string, StageOwnerJob> };
  const job = queue.jobs?.[verifiedWorkerInputs.jobId];
  if (!job || job.id !== verifiedWorkerInputs.jobId)
    throw new Error("Authenticated queue job is unavailable");
  const payload = job.request?.payload as
    CadWorkerInvocation | null | undefined;
  if (!payload) return null;
  const invocation = catalogInvocation(payload);
  const isDocumentSave = invocation?.operation === "document.save.once";
  const isBatch =
    invocation &&
    ["batch.run", "definition.instantiate"].includes(invocation.operation);
  const isHelper =
    payload.kind === "run" && payload.request?.helperVersion === "cad-v1";
  if (!isDocumentSave && !isBatch && !isHelper) return null;
  if (isHelper)
    (
      load("./cad-service.js") as typeof import("./cad-service.js")
    ).decodeInvocation(payload);
  const owner = createAuthenticatedStageOwner({
    brokerDirectory,
    admissionDirectory: () => epoch().isolatedEpochDirectory(brokerDirectory),
    jobId: verifiedWorkerInputs.jobId,
    expectedClientId: verifiedWorkerInputs.clientId,
    expectedProject: verifiedWorkerInputs.projectDirectory,
    buildHash: queueInstance.buildHash,
    core: { canonical: json.canonical, ...stageCore },
    sameInstance: queueInstance.sameInstance,
    nativeWorkflowIdentity: queueInstance.nativeWorkflowIdentity,
    resolvePinnedDocument,
    readOriginalReceipt(input: ReceiptInput) {
      if (input.stage.id === "document.save.once")
        return documentSaveReceipt(input);
      if (["batch.run", "batch.atomic"].includes(input.stage.id))
        return batchReceipt(input);
      if (input.stage.id === "python.helpers.run") return helperReceipt(input);
      return { status: "missing" };
    },
  } as StageOwnerPorts);
  if (
    verifiedWorkerInputs.buildHash &&
    verifiedWorkerInputs.buildHash !== owner.owner.scope.build
  )
    throw Object.assign(
      new Error(
        "Verified worker build differs from the authenticated stage scope",
      ),
      { code: "BUILD_CHANGED" },
    );
  const admittedPayload = acceptedPayload(owner.job, owner.accepted);
  const document = isDocumentSave
    ? (
        loadStaged(
          "composition/document-stages.js",
        ) as typeof import("./document-stages.js")
      ).createDocumentSaveStages(
        owner.operationDirectory,
        owner.owner as DocumentSaveStageOwner,
        owner.evidence,
      )
    : undefined;
  const batch =
    invocation &&
    ["batch.run", "definition.instantiate"].includes(invocation.operation)
      ? createBatchStages(owner)
      : undefined;
  const helperRequestHash = helperBinding(
    owner.job,
    owner.accepted,
    admittedPayload,
  );
  if (isHelper && !helperRequestHash)
    throw new Error("cad-v1 helper job lacks retained original source bytes");
  const helper = helperRequestHash
    ? createHelperStages(owner, helperRequestHash)
    : undefined;
  return {
    owner,
    document,
    batch,
    helper,
    stage: {
      journalInspect: owner.inspect,
      resumePlan: owner.resumePlan,
      revalidate: owner.revalidate,
    },
    journalInspect: owner.inspect,
    resumePlan: owner.resumePlan,
    revalidate: owner.revalidate,
  };
}
function resolvePinnedDocument(input: PinInput): PinnedDocument {
  const payload = acceptedPayload(input.job, input.accepted);
  const invocation = catalogInvocation(payload);
  if (
    invocation &&
    ["document.save.once", "document.save.observe"].includes(
      invocation.operation,
    )
  )
    return documentSave.bindingFor(invocation.data as unknown as SaveRequest)
      .target as PinnedDocument;
  if (payload?.kind === "run")
    return pinFromPreflight(
      input.preflight,
      {
        creationId: payload.request.identity.docId,
        fileId: payload.request.identity.docFileId,
        name: payload.request.doc,
      },
      { allowUnsaved: payload.request.helperVersion === "cad-v1" },
    );
  if (invocation)
    return pinFromPreflight(
      input.preflight,
      {
        creationId: invocation.docId,
        fileId: invocation.docFileId,
        name: invocation.doc,
      },
      invocation.projectId ? { projectId: invocation.projectId } : {},
    );
  throw new Error(
    "This authenticated job does not own a document-scoped stage",
  );
}
function createNamedStages(
  owner: AuthenticatedStageOwner,
  id: string,
  requestHash: string,
) {
  const definition = { id, requestHash, mutates: true };
  const reference = stageReceiptReference(
    Buffer.from(json.canonical({ operation: id, requestHash }), "utf8"),
  );
  return {
    async plan() {
      owner.stages.plan([definition]);
    },
    async started() {
      owner.stages.started(id, reference);
    },
    context() {
      return {
        stage: { ...definition },
        inspection: owner.inspect(),
        resumePlan: owner.resumePlan(),
      };
    },
  };
}
function createHelperStages(
  owner: AuthenticatedStageOwner,
  baseRequestHash: string,
) {
  let definition: StageDefinition | undefined;
  const id = "python.helpers.run";
  return {
    async plan() {
      definition = { id, requestHash: baseRequestHash, mutates: true };
      owner.stages.plan([definition]);
    },
    async started() {
      if (!definition)
        throw new Error("Helper stage intent requires its durable plan");
      owner.stages.started(
        id,
        stageReceiptReference(
          Buffer.from(
            json.canonical({ operation: id, requestHash: baseRequestHash }),
            "utf8",
          ),
        ),
      );
    },
    context() {
      return {
        stage: { id, requestBaseHash: baseRequestHash },
        inspection: owner.inspect(),
        resumePlan: owner.resumePlan(),
      };
    },
  };
}
function createBatchStages(owner: AuthenticatedStageOwner): BatchStages {
  return {
    async beforeRun({ requestHash: currentHash, atomic }) {
      const payload = acceptedPayload(owner.job, owner.accepted);
      const expectedHash = batchBinding(payload, owner.job).requestHash;
      if (currentHash !== expectedHash)
        throw new Error("Batch request differs from retained owner input");
      const stageRequestHash = json.hash({
        jobRequestHash: owner.job.hash,
        reportRequestHash: currentHash,
      });
      const stages = createNamedStages(
        owner,
        atomic ? "batch.atomic" : "batch.run",
        stageRequestHash,
      );
      await stages.plan();
      await stages.started();
    },
  };
}
