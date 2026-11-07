import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type {
  StageDefinition,
  StageEntry,
  StageEvidencePort,
  StageInspection,
  StageJournalPort,
  StageReceiptEvidence,
  StageScope,
} from "../../../core/src/application/stage-journal";
import {
  readAdmission,
  readAcceptedInput,
  type AcceptedBytes,
} from "./accepted-inputs";
import { jobOutputs, projectDirectory, readOwnedResult } from "./owned-results";
import { readBytes } from "./records";
import { openStageJournal } from "./stage-journal";
import {
  createNativeReceipts,
  type NativeRecord,
  type NativeProof,
} from "../execution/native-receipt";

// Persisted broker receipts have versioned runtime checks below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = any;
interface PinnedDocument extends Record<string, unknown> {
  creationId: string;
  fileId: string | null;
  projectId?: string;
  version?: number | null;
}

export interface StageOwnerJob {
  id: string;
  requestId: string;
  clientId: string;
  request: JsonRecord;
  hash: string;
  order: number;
  sequenceId: string | null;
  sequenceParentId?: string;
  sequenceMode?: string;
  state: string;
  dispatch?: { rpcCount?: number };
}
export interface StageOwnerLifecycle {
  job: Readonly<StageOwnerJob>;
  accepted: readonly { reference: AcceptedBytes; bytes: Buffer }[];
  preflight: JsonRecord;
  postflight: JsonRecord;
  worker: JsonRecord;
  outcome: JsonRecord;
  rpcReceipts: readonly {
    binding: JsonRecord;
    sha256: string;
    nativeSha256?: string;
  }[];
  preflightEvidenceSha256: string;
  postflightEvidenceSha256: string;
  stdout: string;
  stdoutSha256: string;
}
export interface StageOwnerCorePort {
  canonical(value: unknown): string;
  createStageApi(
    journal: StageJournalPort,
    scope: StageScope,
  ): {
    plan(stages: StageDefinition[]): void;
    started(stage: string, receipt: string): void;
  };
  validateStageJournal(entries: StageEntry[], scope: StageScope): void;
  inspectStageJournal(
    journal: StageJournalPort,
    scope: StageScope,
    evidence: StageEvidencePort,
    expectedHead?: string,
  ): StageInspection;
  resumeStagePlan(
    journal: StageJournalPort,
    scope: StageScope,
    evidence: StageEvidencePort,
    expectedHead?: string,
  ): ReturnType<
    typeof import("../../../core/src/application/stage-journal").resumeStagePlan
  >;
  revalidateStagePlan(
    plan: ReturnType<
      typeof import("../../../core/src/application/stage-journal").resumeStagePlan
    >,
    journal: StageJournalPort,
    scope: StageScope,
    evidence: StageEvidencePort,
  ): ReturnType<
    typeof import("../../../core/src/application/stage-journal").revalidateStagePlan
  >;
}
export interface StageOwnerPorts {
  /** Job ID comes only from the verified worker capability environment. */
  brokerDirectory: string;
  /** Trusted composition resolves the current admission snapshot, never input from a script. */
  admissionDirectory?(): string;
  jobId: string;
  expectedClientId?: string;
  expectedProject?: string;
  buildHash(): string;
  core: StageOwnerCorePort;
  sameInstance(left: unknown, right: unknown): boolean;
  nativeWorkflowIdentity(value: { identity: unknown }): { kind: string } | null;
  /** Resolve only from immutable accepted bytes plus checked physical preflight. */
  resolvePinnedDocument(input: {
    job: Readonly<StageOwnerJob>;
    accepted: readonly { reference: AcceptedBytes; bytes: Buffer }[];
    preflight: JsonRecord;
  }): PinnedDocument;
  /** Existing workflow-owned receipt reader; the supplied lifecycle is already
   * bound to the QueueState job and checked RPC/native/postflight receipt set. */
  readOriginalReceipt(input: {
    scope: StageScope;
    stage: StageDefinition;
    reference: string;
    lifecycle: StageOwnerLifecycle;
  }): StageReceiptEvidence;
}
export interface AuthenticatedStageOwner {
  owner: { scope: StageScope; pinnedDocument: PinnedDocument };
  job: Readonly<StageOwnerJob>;
  accepted: readonly { reference: AcceptedBytes; bytes: Buffer }[];
  operationDirectory: string;
  evidence: StageEvidencePort;
  stages: ReturnType<StageOwnerCorePort["createStageApi"]>;
  inspect(expectedHead?: string): StageInspection;
  resumePlan(
    expectedHead?: string,
  ): ReturnType<StageOwnerCorePort["resumeStagePlan"]>;
  revalidate(
    plan: ReturnType<StageOwnerCorePort["resumeStagePlan"]>,
  ): ReturnType<StageOwnerCorePort["revalidateStagePlan"]>;
  lifecycle(): StageOwnerLifecycle;
}

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
function fail(message: string): never {
  throw Object.assign(new Error(message), { code: "STAGE_OWNER_UNAVAILABLE" });
}
function readRecordEvidence(
  file: string,
  maxBytes = 16 * 1024 * 1024,
): { value: JsonRecord; sha256: string } {
  const expected = path.resolve(file);
  const bytes = readBytes(expected, maxBytes, fs, expected);
  return {
    value: JSON.parse(bytes.toString("utf8")) as JsonRecord,
    sha256: digest(bytes),
  };
}
function readRecord(file: string, maxBytes = 16 * 1024 * 1024): JsonRecord {
  return readRecordEvidence(file, maxBytes).value;
}
function canonical(value: unknown, ports: StageOwnerPorts): string {
  return ports.core.canonical(value);
}
function readOwningJob(
  broker: string,
  jobId: string,
  ports: StageOwnerPorts,
): StageOwnerJob {
  if (!/^[a-f0-9-]{36}$/.test(jobId))
    fail("Worker capability does not contain a broker job identifier");
  try {
    fs.lstatSync(path.join(broker, "queue-state.pending.json"));
    fail("Queue snapshot has an unresolved durability marker");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const file = path.join(broker, "queue-state.json");
  const snapshot = readRecord(file, 128 * 1024 * 1024);
  const job =
    snapshot.version === 1 && snapshot.jobs && !Array.isArray(snapshot.jobs)
      ? (snapshot.jobs[jobId] as StageOwnerJob | undefined)
      : undefined;
  if (
    !job ||
    job.id !== jobId ||
    job.clientId !== job.request?.clientId ||
    job.requestId !== job.request?.requestId ||
    !Number.isSafeInteger(job.order) ||
    !/^[a-f0-9]{64}$/.test(job.hash)
  )
    fail("Queue snapshot has no consistent authenticated owning job");
  if (ports.expectedClientId && job.clientId !== ports.expectedClientId)
    fail("Owning job belongs to another authenticated client");
  if (
    (job.sequenceId !== null &&
      (typeof job.sequenceId !== "string" || job.sequenceId.length > 256)) ||
    (job.sequenceMode !== undefined &&
      !["automatic", "exclusive"].includes(job.sequenceMode)) ||
    (job.request.sequence?.action === "begin" && !job.sequenceId) ||
    (job.request.sequence?.action !== undefined &&
      job.request.sequence.action !== "begin" &&
      job.sequenceId !== job.request.sequence.id)
  ) fail("Owning job sequence scope is invalid");
  if (job.sequenceParentId) {
    const parent = snapshot.jobs[job.sequenceParentId] as StageOwnerJob | undefined;
    if (
      !parent || parent.id !== job.sequenceParentId ||
      parent.clientId !== job.clientId || parent.sequenceId !== job.sequenceId
    ) fail("Owning sequence parent is missing or foreign");
  }
  const request = { ...job.request };
  delete request.description;
  if (digest(Buffer.from(canonical(request, ports))) !== job.hash)
    fail("Owning job request hash differs from its immutable request");
  return job;
}
function immutableJob(job: StageOwnerJob, ports: StageOwnerPorts): string {
  return canonical(
    {
      id: job.id,
      requestId: job.requestId,
      clientId: job.clientId,
      request: job.request,
      hash: job.hash,
      sequenceId: job.sequenceId,
      sequenceParentId: job.sequenceParentId ?? null,
      sequenceMode: job.sequenceMode ?? null,
    },
    ports,
  );
}
function validateAcceptedInventory(
  job: StageOwnerJob,
  accepted: readonly { reference: AcceptedBytes; bytes: Buffer }[],
  ports: StageOwnerPorts,
): void {
  let index = 0;
  if (job.request.payload !== undefined) {
    const payload = accepted[index++];
    if (
      payload?.reference.kind !== "payload" ||
      canonical(JSON.parse(payload.bytes.toString("utf8")), ports) !==
        canonical(job.request.payload, ports)
    )
      fail("Accepted payload bytes differ from immutable owning request");
  }
  for (const input of job.request.inputFiles ?? []) {
    const source = accepted[index++];
    const originalPath = path.resolve(job.request.cwd ?? "", input.path);
    if (
      source?.reference.kind !== "source" ||
      source.reference.sha256 !== input.sha256 ||
      source.reference.originalPath !== originalPath
    )
      fail("Accepted source bytes differ from immutable owning request");
  }
  if (index !== accepted.length)
    fail("Accepted-byte inventory contains foreign entries");
}
function assertRemoteReceipt(
  file: string,
  binding: JsonRecord,
  instance: unknown,
  ports: StageOwnerPorts,
): { value: JsonRecord; sha256: string } {
  const { value, sha256 } = readRecordEvidence(file);
  if (
    value.terminal !== true ||
    !["succeeded", "failed"].includes(value.outcome) ||
    !["jobId", "rpcId", "requestHash", "buildHash", "sourceHash"].every(
      (key) => value[key] === binding[key],
    ) ||
    !ports.sameInstance(value.instance, instance)
  )
    fail(
      "Remote receipt is not terminal or does not match original RPC/build/instance",
    );
  return {
    value,
    sha256,
  };
}
function observation(
  label: "preflight" | "postflight",
  job: StageOwnerJob,
  build: string,
  broker: string,
  brokerInstance: unknown,
  ports: StageOwnerPorts,
): { value: JsonRecord; sha256: string } {
  const directory = path.join(broker, "jobs", job.id);
  const start = readRecord(path.join(directory, `${label}-start.json`));
  const binding = start.binding;
  if (
    start.jobId !== job.id ||
    start.buildHash !== build ||
    !ports.sameInstance(start.instance, brokerInstance) ||
    binding?.jobId !== job.id ||
    binding?.buildHash !== build ||
    !/^[a-f0-9-]{36}$/.test(binding.rpcId || "") ||
    binding.requestHash !==
      digest(Buffer.from(`${label}:${job.id}:${binding.rpcId}`)) ||
    start.receipt !==
      path.join(directory, `${label}-${binding.rpcId}.receipt.json`)
  )
    fail(`Original ${label} intent has a foreign job/build/instance binding`);
  const receipt = assertRemoteReceipt(
    start.receipt,
    binding,
    start.instance,
    ports,
  );
  const observationEvidence = readRecordEvidence(
    path.join(directory, `${label}.json`),
  );
  const value = observationEvidence.value;
  if (
    value.version !== 2 ||
    value.jobId !== job.id ||
    value.buildHash !== build ||
    value.completed !== true ||
    (value.requiresIdle === true && value.idle !== true) ||
    !ports.sameInstance(value.instance, start.instance) ||
    receipt.value.outcome !== "succeeded"
  )
    fail(`Original ${label} observation is missing or unacknowledged`);
  return {
    value,
    sha256: digest(
      Buffer.from(
        canonical(
          { receipt: receipt.sha256, observation: observationEvidence.sha256 },
          ports,
        ),
      ),
    ),
  };
}

/** Build authenticated document/workflow dependencies from existing broker evidence. */
export function createAuthenticatedStageOwner(
  ports: StageOwnerPorts,
): AuthenticatedStageOwner {
  const broker = fs.realpathSync(ports.brokerDirectory);
  const admission = ports.admissionDirectory
    ? fs.realpathSync(ports.admissionDirectory())
    : broker;
  const owningJob = (id: string) => {
    if (
      ports.admissionDirectory &&
      fs.realpathSync(ports.admissionDirectory()) !== admission
    )
      fail("Owning admission epoch changed during stage inspection");
    return readOwningJob(admission, id, ports);
  };
  const job = owningJob(ports.jobId);
  const directory = path.join(broker, "jobs", job.id);
  if (fs.realpathSync(directory) !== directory)
    fail("Owning job directory escaped the broker scope");
  const requestRecord = readRecord(path.join(directory, "request.json"));
  if (
    requestRecord.id !== job.id ||
    canonical(requestRecord.request, ports) !== canonical(job.request, ports) ||
    !/^[a-f0-9]{64}$/.test(requestRecord.buildHash || "")
  )
    fail(
      "Persisted execution request differs from the authenticated QueueState job",
    );
  const brokerIdentity = readRecord(path.join(admission, "instance.json"));
  if (
    brokerIdentity.buildHash !== requestRecord.buildHash ||
    !brokerIdentity.instance
  )
    fail("Owning job build/instance differs from the broker identity");

  const acceptedAdmission = readAdmission(broker, job);
  if (acceptedAdmission.status !== "available")
    fail("Original accepted-input manifest is missing");
  const inputIdentity = digest(
    Buffer.from(
      canonical(
        {
          cwd: job.request.cwd ?? null,
          payload: job.request.payload ?? null,
          inputFiles: job.request.inputFiles ?? [],
        },
        ports,
      ),
    ),
  );
  if (acceptedAdmission.inputIdentity !== inputIdentity)
    fail("Accepted-input identity differs from the owning job request");
  const accepted = acceptedAdmission.inputs.map((reference) => {
    const bytes = readAcceptedInput(broker, reference);
    if (bytes.status !== "available")
      fail("Original accepted bytes are missing");
    return { reference: bytes.provenance, bytes: bytes.bytes };
  });
  if (
    accepted.length !==
    (job.request.payload === undefined ? 0 : 1) +
      (job.request.inputFiles?.length ?? 0)
  )
    fail("Original accepted-byte inventory is incomplete");
  validateAcceptedInventory(job, accepted, ports);
  const project = projectDirectory(job.request.cwd);
  if (!project) fail("Owning job has no canonical project scope");
  if (
    ports.expectedProject &&
    project !== fs.realpathSync(ports.expectedProject)
  ) fail("Owning job belongs to another authenticated project");

  const initialPreflight = observation(
    "preflight",
    job,
    requestRecord.buildHash,
    broker,
    brokerIdentity.instance,
    ports,
  );
  const pinnedDocument = ports.resolvePinnedDocument({
    job,
    accepted,
    preflight: initialPreflight.value,
  });
  if (
    typeof pinnedDocument.creationId !== "string" ||
    !pinnedDocument.creationId ||
    (pinnedDocument.fileId === null
      ? !(
          job.request.payload?.kind === "run" &&
          job.request.payload.request?.helperVersion === "cad-v1" &&
          initialPreflight.value.instance?.documentState?.state?.identity
            ?.isSaved === false
        )
      : typeof pinnedDocument.fileId !== "string" || !pinnedDocument.fileId) ||
    (pinnedDocument.projectId !== undefined &&
      typeof pinnedDocument.projectId !== "string") ||
    (pinnedDocument.version !== undefined &&
      !Number.isSafeInteger(pinnedDocument.version))
  )
    fail("Owning workflow returned an incomplete document pin");
  const checkedDocument = initialPreflight.value.instance?.documentState;
  const checkedIdentity = checkedDocument?.state?.identity;
  const openDocument = (initialPreflight.value.instance?.documents ?? []).find(
    (candidate: JsonRecord) =>
      candidate.id === pinnedDocument.creationId &&
      candidate.fileId === pinnedDocument.fileId,
  );
  if (
    checkedDocument?.status === "complete"
      ? !checkedIdentity || Object.entries(pinnedDocument).some(([key, value]) =>
          key === "selectorName"
            ? checkedIdentity.name !== value
            : key in checkedIdentity && checkedIdentity[key] !== value)
      : !openDocument
  )
    fail(
      "Workflow document pin does not match the physical owning-job preflight",
    );
  const scope: StageScope = {
    owner: job.clientId,
    clientId: job.clientId,
    project,
    jobId: job.id,
    sequence: canonical(
      {
        id: job.sequenceId,
        parentId: job.sequenceParentId ?? null,
        mode: job.sequenceMode ?? null,
        action: job.request.sequence?.action ?? null,
      },
      ports,
    ),
    requestId: job.requestId,
    requestHash: job.hash,
    build: requestRecord.buildHash,
    document: canonical(pinnedDocument, ports),
    inputIdentity: acceptedAdmission.inputIdentity,
  };
  const journal = openStageJournal(
    directory,
    scope,
    ports.core.validateStageJournal,
  );
  const rawStages = ports.core.createStageApi(journal, scope);

  const lifecycle = (): StageOwnerLifecycle => {
    const liveJob = owningJob(job.id);
    if (immutableJob(liveJob, ports) !== immutableJob(job, ports))
      fail("Owning job identity changed during evidence inspection");
    if (
      canonical(readRecord(path.join(directory, "request.json")), ports) !==
      canonical(requestRecord, ports)
    )
      fail("Persisted execution request changed");
    if (ports.buildHash() !== requestRecord.buildHash)
      fail("Owning executable build changed; reconciliation is required");

    const currentAdmission = readAdmission(broker, liveJob);
    if (
      currentAdmission.status !== "available" ||
      currentAdmission.inputIdentity !== acceptedAdmission.inputIdentity ||
      canonical(currentAdmission.inputs, ports) !==
        canonical(acceptedAdmission.inputs, ports)
    )
      fail("Original accepted-input manifest changed or disappeared");
    const originalBytes = currentAdmission.inputs.map((reference) =>
      readAcceptedInput(broker, reference),
    );
    if (
      originalBytes.some(
        (value, index) =>
          value.status !== "available" ||
          digest(value.bytes) !== digest(accepted[index]!.bytes),
      )
    )
      fail("Original accepted bytes changed or disappeared");

    const pre = observation(
      "preflight",
      job,
      requestRecord.buildHash,
      broker,
      brokerIdentity.instance,
      ports,
    );
    const post = observation(
      "postflight",
      job,
      requestRecord.buildHash,
      broker,
      brokerIdentity.instance,
      ports,
    );
    const postDocument = post.value.instance?.documentState;
    if (postDocument?.status === "complete") {
      const current = postDocument.state?.identity;
      if (
        current?.creationId !== pinnedDocument.creationId ||
        current?.fileId !== pinnedDocument.fileId
      )
        fail("Postflight document differs from the authenticated target");
    } else {
      const stillOpen = (post.value.instance?.documents ?? []).some(
        (candidate: JsonRecord) =>
          candidate.id === pinnedDocument.creationId &&
          candidate.fileId === pinnedDocument.fileId,
      );
      if (!stillOpen) fail("Postflight did not revalidate the pinned document");
    }

    const worker = readRecord(path.join(directory, "worker-result.json"));
    const outcome = readRecord(path.join(directory, "outcome.json"));
    if (
      !["succeeded", "failed", "needs_reconciliation"].includes(
        liveJob.state,
      ) ||
      worker.jobId !== job.id ||
      worker.terminal !== true ||
      !Number.isSafeInteger(worker.code) ||
      !["succeeded", "failed", "needs_reconciliation"].includes(outcome.state)
    )
      fail("Worker/job does not have terminal local lifecycle evidence");
    const outputs = jobOutputs(broker, liveJob) as JsonRecord;
    const stdoutReference = outputs.outputs?.stdout;
    const stdoutBytes = stdoutReference
      ? readOwnedResult(broker, { jobId: job.id, cwd: job.request.cwd }, stdoutReference, 128 * 1024 * 1024)
      : Buffer.from(typeof outputs.stdout === "string" ? outputs.stdout : "");

    const names = fs
      .readdirSync(directory)
      .filter(
        (name) =>
          /^rpc-[a-f0-9-]+\.json$/.test(name) && name !== "rpc-result.json",
      )
      .sort();
    if (names.length !== (liveJob.dispatch?.rpcCount ?? names.length))
      fail(
        "RPC receipt inventory differs from the authenticated dispatch count",
      );
    const nativeReceipts = requireNativeReceipts(ports);
    const rpcReceipts = names.map((name) => {
      const record = readRecord(path.join(directory, name)) as NativeRecord &
        JsonRecord;
      const binding = record.binding as JsonRecord;
      if (
        record.terminal !== true ||
        record.nonterminal === true ||
        binding?.jobId !== job.id ||
        binding.buildHash !== requestRecord.buildHash ||
        !ports.sameInstance(record.instance, brokerIdentity.instance)
      )
        fail("RPC is not terminal or is bound to a foreign job/build/instance");
      let receiptHash: string | undefined;
      if (record.receipt) {
        const expectedReceipt = path.join(
          directory,
          `remote-${binding.rpcId}.json`,
        );
        if (record.receipt !== expectedReceipt)
          fail("RPC receipt path is not the owning job's derived receipt");
          const receipt = assertRemoteReceipt(
            expectedReceipt,
            binding,
            record.instance,
            ports,
          );
        if (receipt.value.outcome !== "succeeded")
          fail("Original SDK receipt reports failed execution");
        receiptHash = receipt.sha256;
      }
      const declaration = nativeReceipts.start(record);
      let nativeSha256: string | undefined;
      if (declaration) {
        const terminal = nativeReceipts.completion(record, declaration);
        if (!terminal || terminal.outcome !== "succeeded")
          fail("Native receipt lacks successful terminal proof");
        const file = path.resolve(`${record.receipt}.native-end.json`);
        nativeSha256 = digest(readBytes(file, 1024 * 1024, fs, file));
      }
      if (
        !receiptHash &&
        ![
          "initialize",
          "notifications/initialized",
          "ping",
          "tools/list",
        ].includes(record.method)
      )
        fail("RPC has no existing bound terminal script receipt");
      return {
        binding,
        sha256: receiptHash ?? digest(Buffer.from(canonical(record, ports))),
        ...(nativeSha256 ? { nativeSha256 } : {}),
      };
    });
    return {
      job: liveJob,
      accepted,
      preflight: pre.value,
      postflight: post.value,
      worker,
      outcome,
      rpcReceipts,
      preflightEvidenceSha256: pre.sha256,
      postflightEvidenceSha256: post.sha256,
      stdout: stdoutBytes.toString("utf8"),
      stdoutSha256: digest(stdoutBytes),
    };
  };
  const evidence: StageEvidencePort = {
    accepted(expected) {
      try {
        if (canonical(expected, ports) !== canonical(scope, ports))
          return "missing";
        const current = readAdmission(broker, job);
        if (
          current.status !== "available" ||
          current.inputIdentity !== acceptedAdmission.inputIdentity ||
          canonical(current.inputs, ports) !==
            canonical(acceptedAdmission.inputs, ports)
        )
          return "missing";
        const bytes = current.inputs.map((reference) =>
          readAcceptedInput(broker, reference),
        );
        if (
          bytes.some(
            (value, index) =>
              value.status !== "available" ||
              digest(value.bytes) !== digest(accepted[index]!.bytes),
          )
        )
          return "missing";
        return "available";
      } catch {
        return "missing";
      }
    },
    ownerReady(expected) {
      if (canonical(expected, ports) !== canonical(scope, ports))
        return { ready: false, reason: "Foreign owning-job scope" };
      try {
        const liveJob = owningJob(job.id);
        if (immutableJob(liveJob, ports) !== immutableJob(job, ports))
          return { ready: false, reason: "Owning job identity changed" };
        if (ports.buildHash() !== scope.build)
          return { ready: false, reason: "Owning executable build changed" };
        if (liveJob.state !== "succeeded")
          return {
            ready: false,
            reason: "Owning queue job is not reconciled to succeeded",
          };
        lifecycle();
        return { ready: true };
      } catch (error) {
        return { ready: false, reason: (error as Error).message };
      }
    },
    receipt(expected, stage, reference) {
      if (
        canonical(expected, ports) !== canonical(scope, ports) ||
        !/^[a-f0-9]{64}$/.test(reference)
      )
        return { status: "corrupt" };
      let verified: StageOwnerLifecycle;
      try {
        verified = lifecycle();
      } catch (error) {
        return { status: "unknown", reason: (error as Error).message };
      }
      try {
        const original = ports.readOriginalReceipt({
          scope,
          stage,
          reference,
          lifecycle: verified,
        });
        if (
          original.status !== "completed" ||
          !/^[a-f0-9]{64}$/.test(original.sha256 ?? "") ||
          !/^[a-f0-9]{64}$/.test(original.ownerTerminalSha256 ?? "") ||
          (stage.mutates &&
            !/^[a-f0-9]{64}$/.test(original.nativeTerminalSha256 ?? ""))
        )
          return original.status === "completed"
            ? { status: "unknown" }
            : original;
        return {
          ...original,
          postflightSha256: verified.postflightEvidenceSha256,
        };
      } catch {
        return { status: "unknown" };
      }
    },
  };
  const requireOriginalBytes = (): void => {
    if (ports.buildHash() !== scope.build)
      fail("Current executable build differs from the owning-job build");
    const currentJob = owningJob(job.id);
    if (immutableJob(currentJob, ports) !== immutableJob(job, ports))
      fail("Owning job identity changed before stage append");
    if (!["running", "sending"].includes(currentJob.state))
      fail("Stage intents can only be appended by the active owning job");
    if (evidence.accepted(scope) !== "available")
      fail("Original accepted job bytes are unavailable");
  };
  const stages = {
    plan(values: StageDefinition[]) {
      requireOriginalBytes();
      rawStages.plan(values);
    },
    started(stage: string, reference: string) {
      requireOriginalBytes();
      rawStages.started(stage, reference);
    },
  };
  return {
    owner: { scope, pinnedDocument },
    job,
    accepted,
    operationDirectory: directory,
    evidence,
    stages,
    inspect: (expectedHead) =>
      ports.core.inspectStageJournal(journal, scope, evidence, expectedHead),
    resumePlan: (expectedHead) =>
      ports.core.resumeStagePlan(journal, scope, evidence, expectedHead),
    revalidate: (plan) =>
      ports.core.revalidateStagePlan(plan, journal, scope, evidence),
    lifecycle,
  };
}

function requireNativeReceipts(ports: StageOwnerPorts) {
  // The native validator is shared with queue-instance via its admitted ports;
  // caller supplies that exact production factory rather than a second decoder.
  return createNativeReceipts({
    readJson: (file) => readRecord(file) as NativeProof,
    sameInstance: ports.sameInstance,
    identity: ports.nativeWorkflowIdentity,
  });
}
