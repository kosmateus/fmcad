import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import type * as P from "./queue-broker-ports";
import type {
  BrokerModules,
  createBrokerLane,
  provisionAddinMetadata,
} from "./queue-broker-modules";
import type * as Execution from "../packages/core/src/application/broker-execution";
import type { BrokerGrant } from "../packages/core/src/application/broker-session";
import type { DispatchFailure } from "../packages/core/src/application/execution";
import type {
  RecoveryFence,
  createBrokerRecovery,
} from "../packages/core/src/application/broker-recovery";
import type { QueueDetails } from "../packages/core/src/domain/queue-model";
import type { BrokerRecords } from "../packages/node-adapters/src/persistence/broker-records";
import type { QueueGate } from "../packages/node-adapters/src/execution/gate";
import type * as Physical from "../packages/node-adapters/src/execution/broker-physical";
import type * as Preparation from "../packages/node-adapters/src/execution/broker-preparation";
import type * as Worker from "../packages/node-adapters/src/execution/local-worker-process";
import type * as Telemetry from "../packages/node-adapters/src/telemetry/broker-observer";
import type { DebugTraceEvent } from "../packages/node-adapters/src/telemetry/diagnostic-log";
import type * as Results from "./composition/queue-public-python-result";
import type {
  BrokerRuntimeIdentity,
  RuntimeAuthorityCapture,
} from "./queue-runtime-authority";

export type ProductGrant = BrokerGrant<P.LaneContext>;
export type OwnedTurn = Execution.PreparedTurn<P.PreparedCall>;
export interface ProductFlights {
  preflight: P.Flight;
  postflight: P.Flight;
}
export type PreparedProductPlan = { flights: ProductFlights | null } & (
  | {
      kind: "raw";
      turn: OwnedTurn;
      callerPayloadHash: string;
      compiledPayload?: P.Rpc;
    }
  | {
      kind: "worker";
      turn: Execution.TurnIdentity;
      message: P.WorkerMessage;
      send: P.Send;
    }
);
export interface OwnedPost {
  kind: "owned";
  turn: OwnedTurn;
  metadataObservation?: P.Instance | undefined;
}
/** A broker-read boundary capability, never a product grant or worker context. */
export interface ProbeBoundary {
  assertCurrent(): void;
  start(): void;
  readonly dispatchBoundary?: P.Send["dispatchBoundary"];
}
export interface TurnExecutionSnapshot {
  readonly jobId: string;
  readonly job: Readonly<Pick<P.Job, "id" | "clientId" | "requestId" | "kind">>;
  readonly running: boolean;
  readonly postflight: boolean;
  readonly pendingCount: number;
  readonly dispatched: boolean;
  readonly unknown: boolean;
  readonly timedOut: boolean;
  readonly workerClosed: boolean;
  readonly hasWorkerProcess: boolean;
  readonly executionFailed: boolean;
  readonly workflowUnknown: boolean;
  readonly waitingForPause: boolean;
  readonly nativeActivityId: string | null;
  readonly deadline: number;
  readonly rpcDeadline: number | null;
}
type Selector = P.ProbeOptions["documentSelector"];
type Phased = InstanceType<BrokerModules["./queue-phased"]["PhasedWorkers"]>;
type Admission = NonNullable<ReturnType<typeof provisionAddinMetadata>>;
type Recovery = ReturnType<typeof createBrokerRecovery>;
type ScopeProgram = {
  operation: string;
  script: string;
};
interface ActivityToken {
  readonly id: string;
}

export interface BrokerTurnServices {
  configuration: {
    directory: string;
    buildHash: string;
    brokerNonce: string;
    backend: Readonly<P.Config>;
    maxIpcBytes: number;
  };
  /** Supply the SAME canonical module that minted every PreparedTurn. */
  execution: typeof Execution;
  completion: Pick<
    typeof import("../packages/core/src/application/execution"),
    "completeSdkTurn" | "executionFailed"
  >;
  queue: Pick<
    P.State,
    | "data"
    | "epoch"
    | "lookup"
    | "summary"
    | "finish"
    | "block"
    | "releaseTurn"
    | "markDispatch"
    | "recordPhysicalDispatch"
    | "assertDocumentMetadataRead"
    | "assertDocumentCreation"
    | "assertProtocolMetadata"
    | "assertPythonStdout"
  > & { status(id: string): P.PublicJob };
  lane: Pick<
    ReturnType<typeof createBrokerLane>,
    "assertCurrent" | "currentGrant" | "heldContext" | "hold" | "settle"
  >;
  gate: Pick<QueueGate, "run" | "isAdministrative"> & {
    beginActivity(): ActivityToken;
    endActivity(token: ActivityToken): boolean;
    hasOtherActivity(token?: ActivityToken): boolean;
  };
  authority: Pick<
    BrokerRuntimeIdentity,
    "current" | "capture" | "assertCurrent" | "selection"
  >;
  prepareOwnedPost(
    payload: P.Rpc,
    job: Readonly<Pick<P.Job, "id"> & Partial<Pick<P.Job, "request">>>,
    origin?: P.Origin,
    rawMetadata?: boolean,
  ): Promise<P.PreparedCall>;
  records: BrokerRecords;
  files: Pick<
    BrokerModules["./queue-instance"],
    | "readJson"
    | "durable"
    | "hash"
    | "buildHash"
    | "sameInstance"
    | "idle"
    | "workflowNonterminal"
    | "workflowOutputNonterminal"
    | "processBirth"
  > & {
    privateDirectory(directory: string): string;
    responsePath(
      directory: string,
      job: P.Job,
      name: string,
      write: boolean,
    ): string;
  };
  protocol: Pick<
    typeof Results,
    | "responseForCaller"
    | "decodeBoundPublicPythonResponse"
    | "verifyBoundRemoteReceipt"
  > & {
    matching(
      client: Pick<P.Client, "_parse">,
      response: P.Response | undefined,
      payload: P.Rpc,
    ): P.Reply | null;
    rpcPayload(value: unknown): P.Rpc;
    canonical(value: unknown): string;
    commandEntry(
      argv: string[],
    ): { kind?: string; target?: string } | null | undefined;
  };
  transport: {
    client: P.Client;
    originalPost(
      payload: P.Rpc,
      sessionId?: string,
      options?: unknown,
    ): Promise<P.Response>;
    withControlledStdoutWire?<T>(
      wire: P.Rpc, assertOriginal: () => void, send: () => Promise<T>,
    ): Promise<T>;
    withControlledServiceWire?<T>(
      wire: P.Rpc, assertOriginal: () => void, send: () => Promise<T>,
    ): Promise<T>;
    observe(options: P.ProbeOptions): Promise<P.Instance>;
    metadataAdmission?: Admission | undefined;
    physicalIsolation: boolean;
    bindPhysicalTurn?: P.Options["bindPhysicalTurn"];
    withPhysicalTurn?: P.Options["withPhysicalTurn"];
    pinPhysicalTurn: typeof import("./queue-broker-modules").pinPhysicalTurn;
    brokerPhysical: Pick<
      typeof Physical,
      "fencePreparedWire" | "postAddinAdmission"
    >;
    metadata: Pick<
      typeof import("./queue-broker-modules"),
      "isAddinMetadata" | "addinMetadataSelector" | "matchMetadataEvidence"
    >;
    decodeAdmissionJson: typeof import("../packages/node-adapters/src/execution/admission-json").decodeAdmissionJson;
  };
  guards: {
    resetSubmissionOpen(directory: string): void;
    admitEpochRequest(request: P.Request): unknown;
    assertPhysicalIsolationAuthority(): void;
    assertFrozenMetadataObservation(
      request: P.Request,
      wire: P.Rpc,
      observed: P.Instance,
    ): void;
  };
  documents: BrokerModules["./queue-document"] & {
    quarantineTarget: typeof import("../packages/core/src/domain/queue-quarantine").quarantineTarget;
    currentCheckpointGeneration(): string;
    checkpointGeneration(binding: P.PhysicalTurnBinding): string;
    requiresPhysicalStageOwner(payload: unknown): boolean;
    constrainedCadProgram(job: P.Job): ScopeProgram;
    continuation: {
      expectedProduct(job: P.Job, turn: Execution.TurnIdentity): ScopeProgram;
      forget(jobId: string, turn: Execution.TurnIdentity): void;
    };
  };
  worker: {
    resolveEntrypoint(): string;
    phased: Pick<Phased, "token" | "pending" | "reject" | "resolve">;
    launch: typeof Worker.launchLocalWorker;
    Budget: BrokerModules["./pause-budget"]["PauseBudget"];
  };
  nativeReceipts: BrokerModules["./queue-native-receipt"];
  recovery: {
    readFence(jobId: string): RecoveryFence | null;
    evaluator: Pick<Recovery, "verifyCompletedDispatch" | "assertCurrentFence">;
  };
  preparation: Pick<
    typeof Preparation,
    "archiveCompletedBrokerTurn" | "checkBrokerTurnInputs"
  >;
  telemetry: Pick<
    typeof Telemetry,
    "debugTraceContext" | "summarizeBrokerRaw" | "writeRequestTrace"
  > & {
    observer: Pick<
      ReturnType<typeof Telemetry.createBrokerIpcObserver>,
      "accept"
    >;
    changed(): void;
  };
}

interface Context extends Omit<P.ProductContext, "nativeActivityToken"> {
  nativeActivityToken?: ActivityToken;
  readonly grant: ProductGrant;
  readonly runtimePin: RuntimeAuthorityCapture;
  running: boolean;
  postflight: boolean;
}
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function required<Value>(value: Value | null | undefined): Value {
  if (value === undefined || value === null)
    throw new TypeError("Missing broker record");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
function errorInfo(value: unknown): P.BrokerError {
  // Preserve exception identity/cause; never replace an explicit adapter error.
  return value && typeof value === "object" ? (value as P.BrokerError) : {};
}
function isToolResult(value: unknown): value is P.ToolResult {
  return (
    !!value &&
    typeof value === "object" &&
    "text" in value &&
    typeof value.text === "string" &&
    "failed" in value &&
    typeof value.failed === "boolean"
  );
}
function equal(left: unknown, right: unknown): boolean {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    Buffer.byteLength(left) === Buffer.byteLength(right) &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}
function freeze<Value>(value: Value): Value {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Own the ordinary product protocol. Durable queue/session/records remain their
 * existing services; only this module can mutate a live execution context.
 * Scoped audit/admin/atomic/checkpoint routing happens before entering here.
 */
export function createBrokerTurnExecution(services: BrokerTurnServices) {
  const {
    queue,
    lane,
    gate,
    authority,
    execution,
    files,
    protocol,
    transport,
    guards,
    documents,
    worker,
    records,
    telemetry,
  } = services;
  const config = Object.freeze({
    ...services.configuration,
    backend: { ...services.configuration.backend },
  });
  const productScope = new AsyncLocalStorage<ProductGrant>();
  const probeBoundary = new AsyncLocalStorage<ProbeBoundary>();
  const contexts = new Map<ProductGrant, Context>();
  const startedRuns = new WeakSet<ProductGrant>();
  const plans = new Map<string, PreparedProductPlan>();
  const debugPreflightStarted = new WeakMap<P.PreparedCall, number>();
  const debugDispatchStarted = new WeakMap<P.PreparedCall, number>();
  const debugRawReceived = new WeakSet<P.PreparedCall>();
  const jobDir = (id: string) => path.join(config.directory, "jobs", id);
  const currentInstance = () => required(authority.current().instance);
  const contextFor = (grant: ProductGrant) => required(contexts.get(grant));
  const heldExecutionContext = () => {
    const held = lane.heldContext();
    if (held)
      for (const [grant, context] of contexts)
        if (grant.context === held) return context;
    return undefined;
  };
  const currentContext = () => {
    const grant = lane.currentGrant();
    if (grant) return contexts.get(grant);
    return heldExecutionContext();
  };
  const assertCurrent = (context: Context) => {
    lane.assertCurrent(context.grant);
    authority.assertCurrent(context.runtimePin);
  };
  const hold = (context: Context, reason: string) => {
    if (
      lane.hold(context.grant, reason, () => {
        if (queue.status(context.job.id).state !== "needs_reconciliation")
          queue.block(context.job.id, reason);
      })
    ) {
      telemetry.changed();
    }
  };
  const finish = (grant: ProductGrant, details: QueueDetails) => {
    lane.settle(grant, () => {
      queue.finish(grant.jobId, details);
      documents.continuation.forget(grant.jobId, grant.turn);
    });
  };
  function trace(context: Context, event: DebugTraceEvent): void {
    telemetry.writeRequestTrace(context.job.request, context.job.clientId, {
      jobId: context.job.id,
      buildHash: config.buildHash,
      stdoutObservation: "not_observed",
      ...event,
    });
  }
  const physicalTrace = (prepared: P.PreparedCall) => ({
    rpcId: prepared.rpcId,
    buildHash: prepared.record.binding.buildHash,
    sourceHash: prepared.record.binding.sourceHash,
    sdkPid: currentInstance().pid,
    sdkBirth: currentInstance().birth,
    sdkVersion: currentInstance().version,
  });
  const withRequest = <Result>(
    settings: Parameters<NonNullable<P.Client["withRequest"]>>[0],
    action: () => Result,
  ): Result =>
    transport.client.withRequest
      ? transport.client.withRequest(settings, action)
      : action();
  const clientProperties = () => {
    const result: Record<string, unknown> = {};
    for (const key of [
      "capabilities",
      "serverInfo",
      "negotiatedProtocolVersion",
    ] as const)
      if (transport.client[key] !== undefined)
        result[key] = transport.client[key];
    return result;
  };
  const prepare = (
    payload: P.Rpc,
    job: Readonly<Pick<P.Job, "id"> & Partial<Pick<P.Job, "request">>>,
    turn: Execution.TurnIdentity,
    origin?: P.Origin,
    rawMetadata = false,
  ) =>
    execution.prepare(turn, () =>
      services.prepareOwnedPost(payload, job, origin, rawMetadata),
    );
  function nativeActivity(context: Context) {
    if (context.nativeActivityToken) return;
    const token = gate.beginActivity();
    context.nativeActivityToken = token;
    context.nativeActivityId = token.id;
    telemetry.changed();
  }
  function endNativeActivity(context: Context) {
    if (!context.nativeActivityToken) return;
    gate.endActivity(context.nativeActivityToken);
    delete context.nativeActivityToken;
    delete context.nativeActivityId;
    telemetry.changed();
  }
  async function settleNative(context: Context) {
    const declared = context.turnRpcs.filter((item) =>
      services.nativeReceipts.start(item.record),
    );
    if (
      !declared.length ||
      context.unknown ||
      context.turnRpcs.some((item) => !item.record.terminal)
    )
      return;
    for (;;) {
      if (lane.currentGrant() !== context.grant) return;
      let waiting = false;
      for (const item of declared) {
        const proof = services.nativeReceipts.completion(item.record);
        if (!proof) {
          waiting = true;
          continue;
        }
        item.record.nativeCompletion = proof.native.state;
        if (proof.outcome === "failed") {
          item.record.failed = true;
          context.executionFailed = true;
        }
        records.recordRpcNativeCompletion(context.job.id, item.record);
      }
      if (!waiting) {
        context.workflowUnknown = context.turnRpcs.some(
          (item) => item.record.nonterminal && !item.record.nativeCompletion,
        );
        endNativeActivity(context);
        return;
      }
      nativeActivity(context);
      if (required(context.budget).remaining() <= 0 || context.timedOut) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  function assertMetadataPrepared(
    job: P.Job,
    prepared: P.PreparedCall,
    committedRpcId?: string,
  ) {
    const marker = job.documentMetadataRead;
    if (!marker) return;
    const scope = object(prepared.record.binding["documentScope"]);
    if (
      prepared.metadataProof ||
      !prepared.pythonCertificate ||
      scope["producer"] !== "compiled-document-metadata-v1" ||
      scope["operation"] !== "document.list" ||
      scope["requestHash"] !== job.hash ||
      scope["rpcHash"] !== marker.rpcHash ||
      scope["programHash"] !== marker.programHash ||
      scope["generation"] !== marker.generation ||
      scope["buildHash"] !== config.buildHash ||
      prepared.record.binding.sourceHash !== marker.programHash ||
      scope["wireSourceHash"] !== prepared.record.binding.sourceHash ||
      documents.currentCheckpointGeneration() !== marker.generation
    )
      fail(
        "DOCUMENT_METADATA_READ_UNPROVEN",
        "Actual metadata program lacks its private compiler and current runtime binding",
      );
    prepared.pythonCertificate.fence(prepared.outgoing);
    queue.assertDocumentMetadataRead(
      job.id,
      marker.programHash,
      marker.rpcHash,
      committedRpcId,
    );
  }
  function assertCreationPrepared(
    job: P.Job,
    prepared: P.PreparedCall,
    committedRpcId?: string,
  ) {
    const marker = job.documentCreation;
    if (!marker) return;
    const scope = object(prepared.record.binding["documentScope"]);
    if (
      prepared.metadataProof ||
      !prepared.pythonCertificate ||
      scope["producer"] !== "compiled-document-creation-v1" ||
      scope["operation"] !== "document.new" ||
      scope["requestHash"] !== job.hash ||
      scope["rpcHash"] !== marker.rpcHash ||
      scope["programHash"] !== marker.programHash ||
      scope["generation"] !== marker.generation ||
      scope["buildHash"] !== config.buildHash ||
      scope["wireSourceHash"] !== prepared.record.binding.sourceHash ||
      documents.currentCheckpointGeneration() !== marker.generation
    )
      fail(
        "DOCUMENT_CREATION_UNPROVEN",
        "Creation lacks the original compiler and current runtime binding",
      );
    prepared.pythonCertificate.fence(prepared.outgoing);
    queue.assertDocumentCreation(
      job.id,
      marker.programHash,
      marker.rpcHash,
      committedRpcId,
    );
  }
  function assertProtocolPrepared(
    job: P.Job,
    prepared: P.PreparedCall,
    committedRpcId?: string,
  ) {
    const marker = job.protocolMetadata;
    if (!marker) return;
    const scope = object(prepared.record.binding["protocolScope"]);
    if (
      !prepared.metadataOnly ||
      prepared.metadataProof ||
      prepared.pythonCertificate?.kind !== "non-python" ||
      scope["producer"] !== "compiled-protocol-metadata-v1" ||
      scope["requestHash"] !== job.hash ||
      scope["rpcHash"] !== marker.rpcHash ||
      scope["generation"] !== marker.generation ||
      scope["buildHash"] !== config.buildHash ||
      documents.currentCheckpointGeneration() !== marker.generation
    )
      fail(
        "PROTOCOL_METADATA_UNPROVEN",
        "Protocol RPC lacks original current metadata authority",
      );
    prepared.pythonCertificate.fence(prepared.outgoing);
    queue.assertProtocolMetadata(job.id, marker.rpcHash, committedRpcId);
  }
  function assertStdoutPrepared(
    job: P.Job,
    prepared: P.PreparedCall,
    committedRpcId?: string,
  ) {
    const marker = job.pythonStdout;
    if (!marker) return;
    const scope = object(prepared.record.binding["documentScope"]);
    if (
      !prepared.metadataOnly ||
      prepared.metadataProof ||
      prepared.pythonCertificate?.kind !== "python" ||
      scope["producer"] !== "compiled-python-stdout-v1" ||
      scope["requestHash"] !== job.hash ||
      scope["rpcHash"] !== marker.rpcHash ||
      scope["programHash"] !== marker.programHash ||
      scope["sourceHash"] !== marker.sourceHash ||
      scope["hostBindingHash"] !== marker.hostBindingHash ||
      scope["engineVersion"] !== marker.engineVersion ||
      scope["profileVersion"] !== marker.profileVersion ||
      scope["generation"] !== marker.generation ||
      scope["buildHash"] !== config.buildHash ||
      scope["wireSourceHash"] !== prepared.record.binding.sourceHash ||
      documents.currentCheckpointGeneration() !== marker.generation
    )
      fail(
        "PYTHON_STDOUT_UNPROVEN",
        "Stdout lacks its original compiler, host and current wire binding",
      );
    prepared.pythonCertificate.fence(prepared.outgoing);
    queue.assertPythonStdout(
      job.id,
      marker.programHash,
      marker.rpcHash,
      committedRpcId,
    );
  }
  function bindPhysical(context: Context, prepared: P.PreparedCall) {
    if (!transport.physicalIsolation) return undefined;
    const { job, grant } = context;
    assertMetadataPrepared(job, prepared);
    assertCreationPrepared(job, prepared);
    assertProtocolPrepared(job, prepared);
    assertStdoutPrepared(job, prepared);
    const target = documents.quarantineTarget(job.request);
    if (target && !prepared.metadataProof) {
      const compiled = job.documentContinuation
        ? documents.continuation.expectedProduct(job, grant.turn)
        : documents.constrainedCadProgram(job);
      const scope = object(prepared.record.binding["documentScope"]);
      if (
        scope["producer"] !== "compiled-cad-v1" ||
        scope["operation"] !== compiled.operation ||
        scope["sourceHash"] !== files.hash(compiled.script) ||
        scope["wireSourceHash"] !== prepared.record.binding.sourceHash ||
        scope["buildHash"] !== config.buildHash ||
        !same(scope["target"], target)
      )
        fail(
          "PHYSICAL_SCOPE_MISMATCH",
          "SDK source lacks the broker-verified pre-wrapper compiler scope",
        );
    }
    const selector = job.pythonStdout
      ? { metadataOnly: true as const }
      : prepared.metadataProof
        ? transport.metadata.addinMetadataSelector(prepared.outgoing)
        : job.documentCreation
          ? null
          : (target ?? documents.documentSelector(job));
    const request: P.PhysicalTurnRequest = Object.freeze({
      kind: "product",
      brokerNonce: config.brokerNonce,
      jobId: job.id,
      requestId: job.requestId,
      clientId: job.clientId,
      requestHash: job.hash,
      grantGeneration: grant.generation,
      physicalRequestId: prepared.rpcId,
      documentSelector: selector ? Object.freeze({ ...selector }) : undefined,
    });
    const binding = required(transport.bindPhysicalTurn)(request);
    if (!binding)
      fail(
        "PHYSICAL_BINDING_MISSING",
        "Product SDK dispatch has no original physical binding",
      );
    const physical = transport.pinPhysicalTurn(
      binding,
      request,
      currentInstance(),
    );
    if (
      job.documentCreation &&
      documents.checkpointGeneration(physical) !==
        job.documentCreation.generation
    )
      fail(
        "DOCUMENT_STATE_CHANGED",
        "Creation physical turn differs from its compiler-bound generation",
      );
    if (
      job.protocolMetadata &&
      documents.checkpointGeneration(physical) !==
        job.protocolMetadata.generation
    )
      fail(
        "DOCUMENT_STATE_CHANGED",
        "Protocol physical turn differs from its original generation",
      );
    if (
      job.pythonStdout &&
      documents.checkpointGeneration(physical) !== job.pythonStdout.generation
    )
      fail(
        "DOCUMENT_STATE_CHANGED",
        "Stdout physical turn differs from its original generation",
      );
    if (
      job.documentMetadataRead &&
      documents.checkpointGeneration(physical) !==
        job.documentMetadataRead.generation
    )
      fail(
        "DOCUMENT_STATE_CHANGED",
        "Metadata physical turn differs from its compiler-bound generation",
      );
    if (
      job.documentContinuation &&
      documents.checkpointGeneration(physical) !==
        job.documentContinuation.generation
    )
      fail(
        "DOCUMENT_STATE_CHANGED",
        "Product physical generation differs from the accepted continuation",
      );
    if (
      job.documentInspection &&
      (documents.checkpointGeneration(physical) !==
        job.documentInspection.generation ||
        documents.checkpointGeneration(physical) !==
          documents.currentCheckpointGeneration())
    )
      fail(
        "DOCUMENT_STATE_CHANGED",
        "Checkpoint physical turn differs from its current native pin",
      );
    const current = required(queue.data.jobs[job.id]);
    const catalogIndex =
      (current.physicalDispatchCount ??
        current.physicalDispatches?.length ??
        0) + 1;
    prepared.record.physicalCatalogIndex = catalogIndex;
    prepared.record.binding["physicalTurn"] = physical;
    return { request, physical, catalogIndex };
  }
  function registerPhysicalDispatch(
    job: P.Job,
    bound: NonNullable<ReturnType<typeof bindPhysical>>,
    dispatch: { rpcCount: number; completedCount: number; rpcId: string },
  ) {
    const body = { ...bound, target: documents.quarantineTarget(job.request) };
    const intentReference = `physical-turn-${files.hash(bound.physical.turnId)}.json`;
    const file = path.join(
      files.privateDirectory(jobDir(job.id)),
      intentReference,
    );
    files.durable(file, body, true);
    queue.markDispatch(job.id, dispatch, {
      ...body,
      intentReference,
      intentDigest: files.hash(fs.readFileSync(file)),
    });
  }
  function retainFailure(
    context: Context,
    error: unknown,
    failure: DispatchFailure<P.PreparedCall>,
  ) {
    const field = (key: string): unknown =>
      error && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, key)?.value
        : undefined;
    const codes = new Set([
      "ENOENT",
      "EACCES",
      "EPERM",
      "EINVAL",
      "EMFILE",
      "ENFILE",
      "EAGAIN",
      "ENOMEM",
      "ENOSYS",
      "ENOEXEC",
      "EPIPE",
      "ECONNRESET",
      "ETIMEDOUT",
      "ABORT_ERR",
      "EINTR",
      "ENOBUFS",
      "EIO",
      "ESRCH",
      "ECHILD",
      "EPROTO",
      "UNKNOWN_RPC",
      "MALFORMED_BACKEND_RESULT",
      "PYTHON_CHECK_REJECTED",
      "BUILD_CHANGED",
      "INPUT_CHANGED",
      "DOCUMENT_CHANGED",
      "RUN_TIMEOUT",
      "PREPARED_RPC_UNAVAILABLE",
      "OUTPUT_PUBLICATION_FAILED",
      "unsupported_queue_route",
      "INVALID_SCRIPT",
      "INVALID_REQUEST",
      "ADDIN_ADMISSION_UNCERTAIN",
      "DOCUMENT_ADMISSION_UNPROVEN",
      "INVALID_ADMISSION_PROVISIONING",
    ]);
    try {
      const code = field("code"),
        causeCode = field("causeCode"),
        phase = field("transportPhase");
      const prepared = failure.prepared,
        binding = prepared?.record.binding;
      const matches =
        !!binding &&
        binding.jobId === context.job.id &&
        binding.buildHash === config.buildHash &&
        binding.rpcId === prepared?.rpcId;
      files.durable(
        path.join(
          jobDir(context.job.id),
          `dispatch-failure-${randomUUID()}.json`,
        ),
        {
          version: 1,
          at: Date.now(),
          jobId: context.job.id,
          requestId: context.job.requestId,
          clientId: context.job.clientId,
          buildHash: config.buildHash,
          phase: failure.phase,
          submitted: failure.submitted,
          code: typeof code === "string" && codes.has(code) ? code : null,
          causeCode:
            typeof causeCode === "string" && codes.has(causeCode)
              ? causeCode
              : null,
          transportPhase:
            typeof phase === "string" &&
            [
              "spawn",
              "process",
              "stdin",
              "output",
              "response",
              "observation",
            ].includes(phase)
              ? phase
              : null,
          rpcIdentityMatches: matches,
          rpc: matches
            ? {
                jobId: binding.jobId,
                rpcId: binding.rpcId,
                requestHash: binding.requestHash,
                buildHash: binding.buildHash,
              }
            : null,
          worker: {
            pid: context.workerProcess?.snapshot().pid ?? null,
            identity: "worker-identity.json",
            start: "worker-start.json",
            result: "worker-result.json",
          },
        },
        true,
      );
    } catch {
      telemetry.changed();
    }
  }

  async function post(
    payload: P.Rpc,
    sessionId?: string,
    requestOptions?: unknown,
    ready?: OwnedPost,
  ): Promise<P.Response> {
    const grant = productScope.getStore();
    if (!grant || gate.isAdministrative || !contexts.has(grant))
      fail(
        "PREPARED_RPC_UNAVAILABLE",
        "No product grant for this physical request",
      );
    const context = contextFor(grant);
    let admission: ReturnType<Admission["bind"]> | undefined;
    let receivedAdmission: P.Response | undefined;
    const tracePreflight = context.job.kind === "rpc";
    const startedAt = Date.now();
    if (tracePreflight)
      trace(context, { stage: "preflight", status: "started" });
    let turn: OwnedTurn;
    try {
      turn = ready?.turn ?? (await prepare(payload, context.job, grant.turn));
      if (tracePreflight)
        turn.inspect((prepared) =>
          debugPreflightStarted.set(prepared, startedAt),
        );
    } catch (error) {
      if (tracePreflight)
        trace(context, { stage: "preflight", status: "failed" });
      required(context.localDispatchErrors).add(error);
      retainFailure(context, error, {
        phase: "prepare",
        submitted: false,
        prepared: undefined,
      });
      throw error;
    }
    return execution.executeTurn(grant, turn, {
      assertCurrentGrant(current) {
        lane.assertCurrent(current);
        if (
          contexts.get(current) !== context ||
          queue.data.active !== current.jobId ||
          context.workerClosed ||
          context.unknown ||
          queue.summary().blocked
        )
          fail(
            "RECONCILIATION_REQUIRED",
            "Original SDK ownership changed before send",
          );
        if (context.timedOut)
          fail("RUN_TIMEOUT", "Worker execution deadline expired before send");
        return undefined;
      },
      check(prepared) {
        try {
          (prepared.metadataProof ?? prepared.pythonCertificate).fence(
            prepared.outgoing,
          );
        } catch (error) {
          if (tracePreflight)
            trace(context, { stage: "preflight", status: "failed" });
          throw error;
        }
      },
      admit: (send) =>
        gate.run(send, {
          onWait(waiting) {
            context.waitingForPause = waiting;
            for (const budget of [context.budget, context.rpcBudget])
              if (budget) {
                if (waiting) budget.freeze();
                else budget.resume();
              }
            if (!waiting) {
              context.deadline =
                Date.now() + required(context.budget).remaining();
              if (context.rpcBudget)
                context.rpcDeadline =
                  Date.now() + context.rpcBudget.remaining();
            }
          },
        }),
      fence(prepared) {
        try {
          guards.resetSubmissionOpen(config.directory);
          if (queue.epoch || authority.selection().approvedRuntimeRoot)
            guards.admitEpochRequest(context.job.request);
          authority.assertCurrent(context.runtimePin);
          if (
            prepared.record.binding.jobId !== context.job.id ||
            !files.sameInstance(prepared.record.instance, currentInstance())
          )
            fail(
              "RECONCILIATION_REQUIRED",
              "Prepared SDK binding changed before send",
            );
          if (context.contextEpoch !== (queue.data.contextEpoch || 0))
            fail(
              "DOCUMENT_CHANGED",
              "Context changed during local preparation or pause",
            );
          if (
            !prepared.metadataOnly &&
            prepared.contextEpoch !== context.contextEpoch
          )
            fail(
              "DOCUMENT_CHANGED",
              "Context changed after final Python analysis",
            );
          if (files.buildHash() !== config.buildHash)
            fail("BUILD_CHANGED", "Pinned executable changed before dispatch");
          for (const input of context.job.request.inputFiles || [])
            if (
              files.hash(
                fs.readFileSync(
                  path.resolve(required(context.job.request.cwd), input.path),
                ),
              ) !== input.sha256
            )
              fail("INPUT_CHANGED", "Pinned input changed before dispatch");
          if (prepared.metadataProof)
            prepared.metadataProof.fence(prepared.outgoing);
          else transport.brokerPhysical.fencePreparedWire(prepared);
          const { record, rpcId } = prepared;
          const remaining = Math.ceil(
            Math.min(
              required(context.budget).remaining(),
              context.rpcBudget?.remaining() ?? Infinity,
            ),
          );
          if (remaining <= 0)
            fail(
              "RUN_TIMEOUT",
              "Active execution budget expired during Python preparation; no RPC sent",
            );
          if (prepared.metadataProof) {
            if (
              !transport.metadataAdmission ||
              !ready ||
              context.job.kind !== "rpc"
            )
              fail(
                "PREPARED_RPC_UNAVAILABLE",
                "Missing owned ADDIN metadata route",
              );
            if (
              record.binding.rpcId !== rpcId ||
              record.wireRequest?.id !== `fmcad:${rpcId}` ||
              prepared.metadataProof.wire.id !== record.wireRequest.id
            )
              fail(
                "PREPARED_RPC_UNAVAILABLE",
                "ADDIN metadata identity changed before send",
              );
            guards.assertFrozenMetadataObservation(
              context.job.request,
              prepared.metadataProof.wire,
              required(ready.metadataObservation),
            );
            admission = transport.metadataAdmission.bind(
              prepared.metadataProof.wire,
              ready.metadataObservation,
              record.instance,
              context.job.clientId,
              rpcId,
              remaining,
            );
            record.binding["addinAdmission"] = admission.binding;
          }
          const before = queue.status(context.job.id).dispatch;
          const count = (before?.rpcCount || 0) + 1;
          record.dispatchIndex = count;
          const physical = bindPhysical(context, prepared);
          const journal = records.createRpcIntent(context.job.id, record);
          context.turnRpcs.push({ record, journal });
          const dispatch = {
            rpcCount: count,
            completedCount: before?.completedCount || 0,
            rpcId,
          };
          if (physical)
            registerPhysicalDispatch(context.job, physical, dispatch);
          else queue.markDispatch(context.job.id, dispatch);
          context.dispatched = true;
          Object.assign(prepared, { journal, dispatchRemaining: remaining });
          if (tracePreflight) {
            const start = debugPreflightStarted.get(prepared);
            trace(context, {
              stage: "preflight",
              status: "passed",
              ...(start === undefined
                ? {}
                : { durationMs: Date.now() - start }),
            });
          }
          return undefined;
        } catch (error) {
          if (tracePreflight)
            trace(context, { stage: "preflight", status: "failed" });
          throw error;
        }
      },
      async send(prepared): Promise<P.Response> {
        guards.assertPhysicalIsolationAuthority();
        assertMetadataPrepared(context.job, prepared, prepared.rpcId);
        assertCreationPrepared(context.job, prepared, prepared.rpcId);
        assertProtocolPrepared(context.job, prepared, prepared.rpcId);
        assertStdoutPrepared(context.job, prepared, prepared.rpcId);
        const started = Date.now();
        debugDispatchStarted.set(prepared, started);
        trace(context, {
          stage: "sdk-dispatch",
          status: "started",
          ...physicalTrace(prepared),
        });
        try {
          if (prepared.metadataProof)
            guards.assertFrozenMetadataObservation(
              context.job.request,
              prepared.metadataProof.wire,
              required(ready?.metadataObservation),
            );
          const sendPhysical = async () =>
            prepared.metadataProof
              ? await transport.brokerPhysical.postAddinAdmission(
                  required(admission).scope,
                  prepared.metadataProof.wire,
                  required(prepared.dispatchRemaining),
                  required(admission),
                )
              : await withRequest(
                  { timeoutMs: required(prepared.dispatchRemaining) },
                  () =>
                    transport.originalPost(
                      prepared.outgoing,
                      sessionId,
                      requestOptions,
                    ),
                );
          const bound = queue.data.jobs[
            context.job.id
          ]?.physicalDispatches?.find(
            (entry) => entry.physical.turnId === prepared.rpcId,
          )?.physical;
          if (
            transport.physicalIsolation &&
            (!bound || !same(bound, prepared.record.binding["physicalTurn"]))
          )
            fail(
              "PHYSICAL_BINDING_MISSING",
              "Every physical product dispatch requires its complete original intent",
            );
          const sendBound = () => transport.physicalIsolation
            ? required(transport.withPhysicalTurn)(
                required(bound),
                sendPhysical,
              )
            : sendPhysical();
          const assertOriginal = () => {
            // These functions check the original private domain authority,
            // exact closed compiler scope and final Python/non-Python wire
            // certificate. A job flag or metadataOnly alone is never enough.
            assertMetadataPrepared(context.job, prepared, prepared.rpcId);
            assertCreationPrepared(context.job, prepared, prepared.rpcId);
            assertProtocolPrepared(context.job, prepared, prepared.rpcId);
            assertStdoutPrepared(context.job, prepared, prepared.rpcId);
            if (prepared.metadataProof) {
              prepared.metadataProof.fence(prepared.outgoing);
              guards.assertFrozenMetadataObservation(
                context.job.request, prepared.metadataProof.wire,
                required(ready?.metadataObservation),
              );
            }
          };
          const closedService = !!(context.job.documentMetadataRead ||
            context.job.documentCreation || context.job.protocolMetadata ||
            prepared.metadataProof);
          const response = context.job.pythonStdout && transport.withControlledStdoutWire
            ? await transport.withControlledStdoutWire(
                prepared.outgoing, assertOriginal, sendBound,
              )
              : closedService && transport.withControlledServiceWire
                ? await transport.withControlledServiceWire(
                  prepared.metadataProof?.wire ?? prepared.outgoing,
                  assertOriginal, sendBound,
                )
              : await sendBound();
          if (prepared.metadataProof) receivedAdmission = response;
          trace(context, {
            stage: "sdk-dispatch",
            status: "passed",
            ...physicalTrace(prepared),
            durationMs: Date.now() - started,
          });
          return response;
        } catch (error) {
          trace(context, {
            stage: "sdk-dispatch",
            status: "failed",
            ...physicalTrace(prepared),
            durationMs: Date.now() - started,
          });
          throw error;
        }
      },
      settle(prepared, response: P.Response) {
        // Retaining/validating the original bound response is not a new SDK
        // grant. Preserve its evidence even if the local executable changed;
        // the postflight pre-send guard has its existing SDK-complete path.
        lane.assertCurrent(grant);
        const { outgoing, record, rpcId, journal } = prepared;
        const tracing = telemetry.debugTraceContext(
          context.job.request,
          context.job.clientId,
        );
        const rawSummary = tracing
          ? telemetry.summarizeBrokerRaw(response.raw)
          : undefined;
        if (tracing) debugRawReceived.add(prepared);
        // Transport response is retained before receipt/matching, not called SDK settlement.
        try {
          records.recordReceivedResponse(context.job.id, {
            version: 1,
            kind: "owned-rpc-received-response-v1",
            binding: record.binding,
            wireId: outgoing.id,
            response,
          });
        } catch (error) {
          if (tracing)
            trace(context, {
              stage: "raw-received",
              status: "failed",
              rpcId,
              buildHash: record.binding.buildHash,
              sourceHash: record.binding.sourceHash,
              code: "RESPONSE_RETENTION_FAILED",
              ...(rawSummary ?? {}),
              stdoutObservation:
                rawSummary?.stdoutObservation ?? "not_observed",
            });
          throw error;
        }
        if (tracing)
          trace(context, {
            stage: "raw-received",
            status:
              response.status >= 200 && response.status < 300
                ? "passed"
                : "failed",
            ...physicalTrace(prepared),
            artifactRef: `received-response-${rpcId}.json`,
            httpStatus: response.status,
            ...(debugDispatchStarted.has(prepared)
              ? {
                  durationMs:
                    Date.now() - required(debugDispatchStarted.get(prepared)),
                }
              : {}),
            ...(rawSummary ?? {}),
            stdoutObservation: rawSummary?.stdoutObservation ?? "not_observed",
          });
        let reply: P.Reply | null;
        try {
          reply = prepared.metadataProof
            ? transport.metadata.matchMetadataEvidence(
                response,
                required(admission).binding,
                record.binding.rpcId,
                outgoing.id,
                transport.decodeAdmissionJson,
              )
            : protocol.matching(transport.client, response, outgoing);
        } catch (error) {
          if (tracing)
            trace(context, {
              stage: "parsed",
              status: "failed",
              ...physicalTrace(prepared),
              code:
                typeof object(error)["code"] === "string"
                  ? String(object(error)["code"])
                  : undefined,
              ...(rawSummary ?? {}),
              stdoutObservation:
                rawSummary?.stdoutObservation ?? "not_observed",
            });
          throw error;
        }
        if (tracing)
          trace(context, {
            stage: "parsed",
            status: "passed",
            ...physicalTrace(prepared),
            ...(rawSummary ?? {}),
            stdoutObservation: rawSummary?.stdoutObservation ?? "not_observed",
          });
        if (
          payload.method === "tools/list" &&
          !reply?.error &&
          !Array.isArray(object(reply?.result)["tools"])
        )
          fail("UNKNOWN_RPC", "Malformed tools/list response");
        let receipt: P.RemoteReceipt | null;
        try {
          receipt = record.receipt ? remoteReceipt(record) : null;
        } catch (error) {
          trace(context, {
            stage: "native-receipt",
            status: "unknown",
            ...physicalTrace(prepared),
            code:
              typeof object(error)["code"] === "string"
                ? String(object(error)["code"])
                : undefined,
          });
          throw error;
        }
        trace(context, {
          stage: "native-receipt",
          status: receipt ? "passed" : "not_observed",
          ...physicalTrace(prepared),
        });
        const callerResponse = prepared.metadataProof
          ? { status: response.status, raw: "" }
          : response;
        const returned =
          record.binding["publicPythonResultSchema"] &&
          receipt?.outcome === "succeeded"
            ? protocol.decodeBoundPublicPythonResponse(
                record,
                receipt,
                payload,
                callerResponse,
                reply,
              )
            : protocol.responseForCaller(callerResponse, payload, reply);
        const declaration = services.nativeReceipts.start(record);
        const nativeEnd = declaration
          ? services.nativeReceipts.completion(record, declaration)
          : null;
        const failed = services.completion.executionFailed({
          transportFailed: !!(reply?.error || object(reply?.result)["isError"]),
          receiptOutcome: receipt?.outcome,
          nativeOutcome: nativeEnd?.outcome,
        });
        if (failed) context.executionFailed = true;
        context.lastRpc = { rpcId, failed, record, journal: required(journal) };
        const nonterminal =
          (context.job.kind === "rpc" || context.job.request.phased) &&
          (files.workflowOutputNonterminal(reply?.result) ||
            !!(declaration && !nativeEnd));
        if (nonterminal) context.workflowUnknown = true;
        if (declaration && !nativeEnd) nativeActivity(context);
        Object.assign(record, {
          terminal: true,
          failed,
          nonterminal,
          response,
          ...(receipt ? { remoteReceipt: receipt } : {}),
          ...(declaration ? { nativeDeclaration: declaration.native } : {}),
          ...(nativeEnd ? { nativeCompletion: nativeEnd.native.state } : {}),
        });
        records.recordRpcTerminal(context.job.id, record);
        const current = required(queue.status(context.job.id).dispatch);
        queue.markDispatch(context.job.id, {
          rpcCount: current.rpcCount,
          completedCount: current.completedCount + 1,
          rpcId,
          rpcState: "terminal",
        });
        return returned;
      },
      unknown(error, failure) {
        context.unknown = true;
        const prepared = failure.prepared;
        if (prepared?.metadataProof && admission) {
          try {
            const rejected = object(error),
              raw = rejected["rawResponse"];
            const response =
              receivedAdmission ??
              (typeof raw === "string" &&
              same(rejected["admissionBinding"], admission.binding)
                ? { status: 200, raw }
                : undefined);
            if (
              response &&
              !records.evidence.readReceivedResponse(
                context.job.id,
                prepared.rpcId,
              )
            )
              records.recordReceivedResponse(context.job.id, {
                version: 1,
                kind: "owned-rpc-received-response-v1",
                binding: prepared.record.binding,
                wireId: prepared.outgoing.id,
                response,
              });
          } catch {
            /* Original immutable intent remains the no-replay fence. */
          }
        }
        if (prepared && !debugRawReceived.has(prepared))
          trace(context, {
            stage: "raw-received",
            status: "unknown",
            ...physicalTrace(prepared),
          });
        hold(
          context,
          "Physical RPC outcome is unknown; observe the durable receipt without replay",
        );
        retainFailure(context, error, failure);
      },
      notSubmitted(error, failure) {
        required(context.localDispatchErrors).add(error);
        const prepared = failure.prepared,
          code = object(error)["code"];
        if (prepared?.metadataProof && typeof code === "string")
          context.preconditionCode = code;
        if (prepared && !debugRawReceived.has(prepared))
          trace(context, {
            stage: "raw-received",
            status: "not_observed",
            ...physicalTrace(prepared),
          });
        retainFailure(context, error, failure);
      },
    });
  }
  function remoteReceipt(record: P.RecordEvidence): P.RemoteReceipt {
    if (!record.receipt)
      fail(
        "RECEIPT_UNAVAILABLE",
        "This unresolved non-script RPC has no remote terminal completion receipt",
      );
    let value: P.RemoteReceipt;
    try {
      value = files.readJson<P.RemoteReceipt>(record.receipt);
    } catch {
      fail(
        "RECEIPT_UNAVAILABLE",
        "Matching durable remote terminal receipt is unavailable or unreadable; no probe sent",
      );
    }
    protocol.verifyBoundRemoteReceipt(record, value);
    return value;
  }

  async function backend(
    message: P.WorkerMessage,
    preparedSend?: P.Send,
  ): Promise<{ value: unknown; properties: Record<string, unknown> }> {
    const grant = lane.currentGrant();
    const context = grant && contexts.get(grant);
    if (
      !grant ||
      !context ||
      context.postflight ||
      !context.productTurn ||
      message.jobId !== context.job.id ||
      !equal(message.workerToken, context.token) ||
      !["running", "sending"].includes(queue.status(context.job.id).state)
    )
      fail("INVALID_CAPABILITY", "No active worker capability for this job");
    if (
      !["callTool", "listTools", "executeUiGuardedScript"].includes(
        message.method,
      ) ||
      !Array.isArray(message.args)
    )
      fail("INVALID_BACKEND_METHOD", "Unsupported worker backend method");
    if (context.pending.size || context.workerClosed || context.timedOut)
      fail(
        "WORKER_BUSY",
        "Worker RPC is concurrent, closed, or past its deadline",
      );
    if (
      !Number.isSafeInteger(message.rpcTimeoutMs) ||
      message.rpcTimeoutMs <= 0
    )
      fail("INVALID_TIMEOUT", "Positive RPC timeout required");
    const timeout = Math.ceil(
      Math.min(message.rpcTimeoutMs, required(context.budget).remaining()),
    );
    if (timeout <= 0) fail("RUN_TIMEOUT", "Worker execution deadline expired");
    telemetry.observer.accept(message, timeout);
    const initialRpcCount =
      queue.status(context.job.id).dispatch?.rpcCount || 0;
    const operation = withRequest({ timeoutMs: timeout }, async () => {
      context.rpcDeadline = Date.now() + timeout;
      try {
        const value: unknown = await productScope.run(grant, () =>
          preparedSend
            ? preparedSend()
            : Reflect.apply(
                transport.client[message.method],
                transport.client,
                message.args,
              ),
        );
        if (
          message.method === "listTools"
            ? !Array.isArray(value) ||
              value.some((tool) => !tool || typeof tool.name !== "string")
            : !isToolResult(value)
        )
          fail(
            "MALFORMED_BACKEND_RESULT",
            "Physical adapter returned malformed result fields",
          );
        if (isToolResult(value) && value.failed) context.executionFailed = true;
        if (
          context.job.request.phased &&
          files.workflowOutputNonterminal(value)
        ) {
          context.workflowUnknown = true;
          if (context.lastRpc) {
            context.lastRpc.record.nonterminal = true;
            records.retainRpcWorkflowFence(
              context.job.id,
              context.lastRpc.record,
            );
          }
        }
        await settleNative(context);
        const properties = clientProperties();
        if (
          Buffer.byteLength(JSON.stringify({ value, properties })) >
          config.maxIpcBytes - 128
        ) {
          context.publicationError = true;
          fail(
            "OUTPUT_PUBLICATION_FAILED",
            "Adapted backend result exceeds the bounded IPC response size",
          );
        }
        return { value, properties };
      } catch (cause) {
        const error = errorInfo(cause);
        if (lane.currentGrant() !== grant) throw error;
        const newDispatch =
          (queue.status(context.job.id).dispatch?.rpcCount || 0) >
          initialRpcCount;
        const malformed =
          error instanceof SyntaxError ||
          /malformed|missing .*result|empty response|invalid.*response/i.test(
            error.message ?? "",
          );
        const rejectedBeforeDispatch =
          required(context.localDispatchErrors).has(error) ||
          [
            "unsupported_queue_route",
            "INVALID_SCRIPT",
            "INVALID_REQUEST",
          ].includes(error.code ?? "");
        if (
          newDispatch &&
          !context.unknown &&
          !rejectedBeforeDispatch &&
          error.code !== "OUTPUT_PUBLICATION_FAILED" &&
          (malformed || !context.lastRpc?.failed)
        ) {
          context.unknown = true;
          files.durable(
            path.join(jobDir(context.job.id), "adapter-outcome.json"),
            {
              jobId: context.job.id,
              buildHash: config.buildHash,
              rpcId: context.lastRpc?.rpcId || null,
              unknown: true,
              reason: "Adapter could not validate the physical response",
            },
          );
          hold(
            context,
            "Physical adapter outcome is unknown; generic synchronous receipts cannot certify its result",
          );
        }
        throw error;
      } finally {
        delete context.rpcDeadline;
      }
    });
    context.pending.add(operation);
    let rejectDeadline!: (error: unknown) => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const budget = new worker.Budget(timeout, () => {
      context.timedOut = true;
      if (context.dispatched)
        hold(
          context,
          "Worker backend RPC exceeded its deadline; completion remains unknown",
        );
      rejectDeadline(
        Object.assign(
          new Error(
            "Worker backend RPC deadline expired; no remote cancellation",
          ),
          { code: "RUN_TIMEOUT" },
        ),
      );
    });
    context.rpcBudget = budget;
    if (context.waitingForPause) budget.freeze();
    operation.then(
      () => context.pending.delete(operation),
      () => context.pending.delete(operation),
    );
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      budget.close();
      if (context.rpcBudget === budget) delete context.rpcBudget;
    }
  }
  async function checkInstance(options: P.ProbeOptions): Promise<P.Instance> {
    options.assertCurrent?.();
    if (files.buildHash() !== config.buildHash)
      throw Object.assign(
        new Error(
          "Pinned executable build changed before the instance probe was submitted",
        ),
        { code: "BUILD_CHANGED", probeNotSubmitted: true },
      );
    const actual = options.prepared
      ? await options.prepared.send()
      : await transport.observe({ ...options, requireIdle: false });
    options.assertCurrent?.();
    if (options.prepared && options.onObservation)
      await options.onObservation(actual);
    options.assertCurrent?.();
    if (!files.sameInstance(actual, currentInstance()))
      fail("INSTANCE_CHANGED", "Fusion PID/birth/build identity changed");
    if (options.requireIdle !== false && !files.idle(actual))
      throw Object.assign(new Error("An interactive Fusion command is open"), {
        code: "FUSION_BUSY",
        probeCompleted: true,
        observation: actual,
      });
    return actual;
  }
  function checkTurnInstance(
    grant: ProductGrant,
    options: P.ProbeOptions,
    writeIntent: () => void,
  ) {
    let sent = false;
    lane.assertCurrent(grant);
    // Keep the existing SDK-complete/local-build-change path distinguishable
    // from a changed remote/owner identity. No probe has been submitted here.
    if (files.buildHash() !== config.buildHash)
      throw Object.assign(
        new Error(
          "Pinned executable build changed before the instance probe was submitted",
        ),
        { code: "BUILD_CHANGED", probeNotSubmitted: true },
      );
    const runtimePin = authority.capture();
    const assert = () => {
      lane.assertCurrent(grant);
      authority.assertCurrent(runtimePin);
    };
    return probeBoundary.run(
      {
        assertCurrent: assert,
        start() {
          assert();
          if (sent)
            fail(
              "PREPARED_RPC_CONSUMED",
              "An instance probe cannot be replayed",
            );
          sent = true;
          writeIntent();
        },
      },
      () => checkInstance({ ...options, assertCurrent: assert }),
    );
  }
  function createContext(
    job: P.Job,
    grant: ProductGrant,
    checkpoint = false,
  ): Context {
    const context: Context = {
      job,
      grant,
      productTurn: grant.turn,
      runtimePin: authority.capture(),
      token:
        !checkpoint && job.request.phased
          ? required(worker.phased.token(job.id))
          : randomBytes(32).toString("hex"),
      pending: new Set(),
      localDispatchErrors: new Set(),
      turnRpcs: [],
      dispatched: false,
      unknown: false,
      timedOut: false,
      workerClosed: false,
      executionFailed: false,
      deadline:
        Date.now() +
        (checkpoint ? job.timeoutMs : (job.sdkRemainingMs ?? job.timeoutMs)),
      contextEpoch: queue.data.contextEpoch || 0,
      running: true,
      postflight: false,
    };
    let rejectTimeout!: (error: unknown) => void;
    context.timeoutPromise = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    context.timeoutPromise.catch(() => {});
    context.budget = new worker.Budget(
      checkpoint ? job.timeoutMs : (job.sdkRemainingMs ?? job.timeoutMs),
      () => {
        context.timedOut = true;
        if (checkpoint) {
          let cause: unknown = Object.assign(
            new Error("Checkpoint read timed out"),
            {
              code: "RUN_TIMEOUT",
            },
          );
          try {
            if (context.dispatched && lane.currentGrant() === grant)
              hold(
                context,
                "Checkpoint read execution deadline expired; no replay",
              );
          } catch (error) {
            cause = error;
          } finally {
            rejectTimeout(cause);
          }
          return;
        }
        if (
          context.dispatched &&
          (!checkpoint || lane.currentGrant() === grant)
        )
          hold(
            context,
            "Execution budget expired; remote operation is not cancelled",
          );
        context.workerProcess?.terminateOwnProcess();
        rejectTimeout(
          Object.assign(new Error("Execution budget expired"), {
            code: "RUN_TIMEOUT",
          }),
        );
      },
    );
    contexts.set(grant, context);
    return context;
  }
  async function withCheckpointTurn<Result>(
    job: P.Job,
    grant: ProductGrant,
    read: (scope: {
      send<Value>(send: P.Send<Value>): Promise<Value>;
      evidence(): {
        readonly dispatched: boolean;
        readonly unknown: boolean;
        readonly timedOut: boolean;
        readonly executionFailed: boolean;
        readonly turnRpcs: readonly Readonly<P.RecordEvidence>[];
      };
    }) => Promise<Result>,
  ): Promise<Result> {
    lane.assertCurrent(grant);
    if (!job.documentInspection || job.id !== grant.jobId)
      fail(
        "INVALID_CAPABILITY",
        "Checkpoint scope requires its exact inspection turn",
      );
    if (startedRuns.has(grant))
      fail(
        "PREPARED_RPC_CONSUMED",
        "This checkpoint grant has already started",
      );
    startedRuns.add(grant);
    const context = createContext(job, grant, true);
    let open = true,
      sent = false;
    const assertOpen = () => {
      if (!open)
        fail("INVALID_CAPABILITY", "Checkpoint execution scope has closed");
      lane.assertCurrent(grant);
    };
    try {
      return await read({
        async send(send) {
          assertOpen();
          if (sent)
            fail(
              "PREPARED_RPC_CONSUMED",
              "Checkpoint send has already started",
            );
          sent = true;
          send.fence();
          const pending = productScope.run(grant, () => send());
          context.pending.add(pending);
          void pending
            .finally(() => context.pending.delete(pending))
            .catch(() => {});
          return Promise.race([pending, required(context.timeoutPromise)]);
        },
        evidence() {
          if (!open)
            fail("INVALID_CAPABILITY", "Checkpoint execution scope has closed");
          return freeze(
            structuredClone({
              dispatched: context.dispatched,
              unknown: context.unknown,
              timedOut: context.timedOut,
              executionFailed: context.executionFailed,
              turnRpcs: context.turnRpcs.map((item) => item.record),
            }),
          );
        },
      });
    } finally {
      open = false;
      context.workerClosed = true;
      context.running = false;
      context.budget?.close();
      if (
        !context.pending.size &&
        !context.nativeActivityToken &&
        lane.currentGrant() !== grant &&
        heldExecutionContext() !== context
      )
        contexts.delete(grant);
    }
  }
  async function executePreparedProduct(
    job: P.Job,
    grant: ProductGrant,
    plan: PreparedProductPlan | undefined,
    directory: string,
    selector: Selector,
    allowsBusyAfter: boolean,
    observed: P.Instance | undefined,
  ) {
    const context = createContext(job, grant);
    let code: number | undefined,
      publicationError = false;
    let adapted:
      { value: unknown; properties: Record<string, unknown> } | undefined;
    try {
      if (job.request.phased) {
        const pending = worker.phased.pending(job.id);
        if (
          !pending ||
          plan?.kind !== "worker" ||
          pending.message !== plan.message
        )
          fail(
            "WORKER_CLOSED",
            "No prepared SDK request exists for the admitted turn",
          );
        try {
          adapted = await backend(pending.message, plan.send);
          code =
            (isToolResult(adapted.value) && adapted.value.failed) ||
            context.executionFailed
              ? 1
              : 0;
        } catch (cause) {
          const error = errorInfo(cause);
          code = 1;
          context.phaseError = error;
          if (!context.unknown && !context.timedOut) publicationError = true;
        }
        context.workerClosed = true;
      } else if (job.kind === "rpc") {
        try {
          if (plan?.kind !== "raw")
            fail("PREPARED_RPC_UNAVAILABLE", "The prepared raw turn is gone");
          const callerPayload = protocol.rpcPayload(job.request.payload);
          if (
            files.hash(protocol.canonical(callerPayload)) !==
            plan.callerPayloadHash
          )
            fail(
              "PREPARED_RPC_UNAVAILABLE",
              "Prepared raw input no longer matches",
            );
          if (!!job.pythonStdout !== !!plan.compiledPayload)
            fail(
              "PYTHON_STDOUT_UNPROVEN",
              "A compiled stdout RPC must retain its private original plan",
            );
          const rawPayload = plan.compiledPayload ?? callerPayload;
          const physicalCatalogRead = [
            "resources/list",
            "resources/templates/list",
          ].includes(rawPayload.method);
          const admissionRoute = transport.metadata.isAddinMetadata(rawPayload);
          const openSession =
            !admissionRoute &&
            (physicalCatalogRead ||
              (rawPayload.method === "tools/call" &&
                job.request.sessionId === undefined));
          const headers = Object.fromEntries(
            Object.entries(transport.client.server.headers || {}).filter(
              ([name]) => name.toLowerCase() !== "mcp-protocol-version",
            ),
          );
          const operation = productScope.run(grant, async () => {
            const sessionId = openSession
              ? await transport.client._openSession()
              : job.request.sessionId;
            const protocolVersion = openSession
              ? transport.client.negotiatedProtocolVersion
              : job.request.protocolVersion;
            if (protocolVersion)
              headers["MCP-Protocol-Version"] = protocolVersion;
            return withRequest(
              { headers, timeoutMs: job.timeoutMs, protocolVersion },
              () =>
                post(rawPayload, sessionId, undefined, {
                  kind: "owned",
                  turn: plan.turn,
                  ...(admissionRoute ? { metadataObservation: observed } : {}),
                }),
            );
          });
          context.pending.add(operation);
          operation.then(
            () => context.pending.delete(operation),
            () => context.pending.delete(operation),
          );
          const result = await Promise.race([
            operation,
            required(context.timeoutPromise),
          ]);
          const reply = protocol.matching(transport.client, result, rawPayload);
          code =
            reply?.error ||
            object(reply?.result)["isError"] ||
            context.executionFailed
              ? 1
              : 0;
          files.durable(
            files.responsePath(config.directory, job, "rpc-result.json", true),
            result,
          );
        } catch {
          code = 1;
          if (!context.unknown && !context.timedOut) publicationError = true;
        }
        context.workerClosed = true;
      } else {
        const local = worker.launch(
          {
            intent: {
              id: job.id,
              request: job.request,
              buildHash: config.buildHash,
              properties: clientProperties(),
              deadline: context.deadline,
            },
            brokerDirectory: config.directory,
            entrypoint: worker.resolveEntrypoint(),
            capability: { jobId: job.id, token: context.token },
            backend: {
              backend: config.backend.backend || "addin",
              tool: config.backend.tool,
              transport: config.backend.transport,
              protocolVersion: config.backend.protocolVersion,
            },
          },
          {
            records,
            processBirth: files.processBirth,
            onIdentityPublicationFailure() {
              if (context.dispatched)
                hold(context, "Local worker identity could not be persisted");
            },
          },
        );
        context.workerProcess = local;
        try {
          const completed = await local.completion;
          code = completed.exitCode;
          publicationError ||= completed.publicationFailed;
        } finally {
          // This boundary intentionally propagates setup/open/close rejection.
          context.workerClosed = true;
        }
      }
      return await completeProduct(
        context,
        plan,
        directory,
        selector,
        allowsBusyAfter,
        code,
        publicationError,
        adapted,
      );
    } finally {
      context.running = false;
      // A held/pending operation keeps its original context and activity token.
      // Known completion no longer needs a mutable in-memory execution object.
      if (
        !context.unknown &&
        !context.workflowUnknown &&
        !context.pending.size &&
        !context.nativeActivityToken &&
        lane.currentGrant() !== grant &&
        heldExecutionContext() !== context
      )
        contexts.delete(grant);
    }
  }

  async function completeProduct(
    context: Context,
    plan: PreparedProductPlan | undefined,
    directory: string,
    selector: Selector,
    allowsBusyAfter: boolean,
    code: number | undefined,
    initialPublicationError: boolean,
    adapted:
      { value: unknown; properties: Record<string, unknown> } | undefined,
  ) {
    const { job, grant } = context;
    const flights = plan?.flights;
    let publicationError = initialPublicationError;
    return services.completion.completeSdkTurn({
      async settle() {
        try {
          await settleNative(context);
        } catch (cause) {
          const error = errorInfo(cause);
          context.unknown = true;
          hold(context, error.code || "NATIVE_RECEIPT_UNAVAILABLE");
        }
        required(context.budget).close();
        const decision = execution.decideBrokerWorkerExit(
          {
            jobId: job.id,
            kind: job.kind,
            phased: !!job.request.phased,
            pending: !!context.pending.size,
            workflowUnknown: !!context.workflowUnknown,
            unknown: context.unknown,
            timedOut: context.timedOut,
            dispatched: context.dispatched,
            exitCode: code,
          },
          {
            worker() {
              const file = path.join(directory, "worker-result.json");
              return fs.existsSync(file)
                ? files.readJson<P.WorkerResult>(file)
                : null;
            },
            workflowNonterminal: files.workflowNonterminal,
            blocked: () => !!queue.summary().blocked,
          },
        );
        if (decision.kind === "postflight") {
          publicationError ||= decision.missingPublication;
          return true;
        }
        if (decision.kind === "hold") {
          if (decision.outcome)
            files.durable(
              path.join(directory, "outcome.json"),
              decision.outcome,
            );
          hold(context, decision.reason);
        }
        if (job.request.phased && decision.rejection)
          worker.phased.reject(
            job.id,
            Object.assign(new Error(decision.rejection.message), {
              code: decision.rejection.code,
            }),
          );
        return undefined;
      },
      async postflight(settled) {
        if (!settled) return false;
        context.postflight = true;
        const rpcId = flights?.postflight.binding.rpcId || randomUUID();
        const binding = flights?.postflight.binding || {
          jobId: job.id,
          rpcId,
          requestHash: files.hash(`postflight:${job.id}:${rpcId}`),
          buildHash: config.buildHash,
        };
        const receipt =
          flights?.postflight.receipt ||
          path.join(directory, `postflight-${rpcId}.receipt.json`);
        try {
          const observation = await checkTurnInstance(
            grant,
            {
              prepared: flights?.postflight,
              requireIdle: !allowsBusyAfter,
              receiptPath: receipt,
              binding,
              diagnosticPath: path.join(directory, "postflight-result.json"),
              documentSelector: selector,
            },
            () =>
              records.createProbeIntent(job.id, "postflight", {
                version: 2,
                jobId: job.id,
                buildHash: config.buildHash,
                instance: currentInstance(),
                at: Date.now(),
                binding,
                receipt,
              }),
          );
          assertCurrent(context);
          records.recordProbeTerminal(job.id, "postflight", observation);
        } catch (cause) {
          lane.assertCurrent(grant);
          const error = errorInfo(cause);
          context.postflight = false;
          const decision = execution.decideBrokerPostflightFailure(
            error,
            { unknown: context.unknown, pending: !!context.pending.size },
            () => {
              const expected = services.recovery.readFence(job.id);
              if (
                expected &&
                services.recovery.evaluator.verifyCompletedDispatch(
                  queue.lookup(job.id),
                  expected,
                ).kind === "settled"
              )
                return expected;
              return undefined;
            },
          );
          if (decision.kind === "settle") {
            const expected = decision.fence;
            services.recovery.evaluator.assertCurrentFence(expected);
            files.durable(
              path.join(directory, "postflight-not-submitted.json"),
              {
                jobId: job.id,
                binding,
                code: "LOCAL_BUILD_CHANGED",
                probeSubmitted: false,
                source: "local guard before probe; not a remote SDK receipt",
              },
              true,
            );
            const dispatched = !!queue.status(job.id).dispatch?.rpcCount;
            const details = {
              ...decision.details,
              userScriptSubmitted: dispatched,
              mayHaveMutated: dispatched,
            };
            services.recovery.evaluator.assertCurrentFence(expected);
            files.durable(path.join(directory, "outcome.json"), details);
            services.recovery.evaluator.assertCurrentFence(expected);
            finish(grant, details);
            if (job.request.phased)
              worker.phased.reject(
                job.id,
                Object.assign(
                  new Error(
                    "Original SDK settled; local build changed before postflight. Inspect the result before further work.",
                  ),
                  { code: details.code },
                ),
              );
            return false;
          }
          hold(context, decision.reason);
          if (job.request.phased) worker.phased.reject(job.id, error);
          return false;
        }
        return;
      },
      release() {
        lane.assertCurrent(grant);
        if (job.request.phased) {
          files.durable(path.join(directory, "outcome.json"), {
            state: "processing",
            code: context.phaseError?.code || "SDK_TURN_COMPLETE",
            exitCode: code,
            sdkSettled: true,
          });
          lane.settle(grant, () => {
            queue.releaseTurn(
              job.id,
              Math.max(0, Math.floor(required(context.budget).remaining())),
            );
          });
        }
      },
      finalize() {
        if (job.request.phased) {
          if (context.phaseError)
            worker.phased.reject(job.id, context.phaseError);
          else
            worker.phased.resolve(job.id, adapted, {
              sdkFailed: !!context.executionFailed,
            });
          return;
        }
        lane.assertCurrent(grant);
        const details = {
          state:
            code === 0 &&
            !context.executionFailed &&
            !publicationError &&
            !context.publicationError
              ? "succeeded"
              : "failed",
          mayHaveMutated: !!queue.status(job.id).dispatch?.rpcCount,
          sdkSettled: true,
          publicationOutcome:
            publicationError || context.publicationError
              ? "failed"
              : "published",
          code:
            context.preconditionCode ||
            (publicationError || context.publicationError
              ? "OUTPUT_PUBLICATION_FAILED"
              : context.timedOut
                ? "RUN_TIMEOUT"
                : "EXECUTION_COMPLETE"),
          exitCode: code,
        };
        files.durable(path.join(directory, "outcome.json"), details);
        finish(grant, details);
      },
    });
  }
  async function run(job: P.Job, grant: ProductGrant) {
    lane.assertCurrent(grant);
    if (grant.jobId !== job.id || grant.context.job !== job)
      fail(
        "RECONCILIATION_REQUIRED",
        "The original job does not own this exact grant",
      );
    if (job.workflowObservation || job.documentInspection)
      fail(
        "INVALID_CAPABILITY",
        "Specialized broker reads cannot enter the product executor",
      );
    if (startedRuns.has(grant))
      fail("PREPARED_RPC_CONSUMED", "This exact product grant already started");
    startedRuns.add(grant);
    const directory = files.privateDirectory(jobDir(job.id));
    const plan = plans.get(job.id);
    plans.delete(job.id);
    if (
      plan &&
      (plan.kind === "raw" ? plan.turn.turn : plan.turn) !== grant.turn
    )
      fail(
        "PREPARED_RPC_UNAVAILABLE",
        "Prepared product plan belongs to another turn",
      );
    const flights = plan?.flights;
    const notStarted = {
      executionOutcome: job.physicalTurns
        ? "previous_turns_complete_current_not_started"
        : "not_started",
      userScriptSubmitted: !!job.dispatch?.rpcCount,
      mayHaveMutated: !!job.dispatch?.rpcCount,
      currentTurnSubmitted: false,
    };
    let previousTurn: P.Instance["documentState"] | null = null;
    let observed: P.Instance | undefined;
    let selector: Selector;
    let allowsBusyAfter = false;
    return execution.runBrokerProductTurn({
      inspectPrepared() {
        let changed = false;
        flights?.preflight.send.fence();
        flights?.postflight.send.fence();
        if (job.request.phased) {
          if (
            plan?.kind !== "worker" ||
            worker.phased.pending(job.id)?.message !== plan.message
          )
            fail(
              "PREPARED_RPC_UNAVAILABLE",
              "The prepared worker turn is gone",
            );
          plan.send.fence();
        }
        if (job.kind === "rpc") {
          if (plan?.kind !== "raw")
            fail(
              "PREPARED_RPC_UNAVAILABLE",
              "The original checked RPC is unavailable; it is never reconstructed for replay",
            );
          if (!!job.pythonStdout !== !!plan.compiledPayload)
            fail(
              "PYTHON_STDOUT_UNPROVEN",
              "A compiled stdout RPC must retain its private original plan",
            );
          plan.turn.inspect((prepared) => {
            assertStdoutPrepared(job, prepared);
            (prepared.metadataProof ?? prepared.pythonCertificate).fence(
              prepared.outgoing,
            );
            changed =
              !prepared.metadataOnly &&
              prepared.contextEpoch !== (queue.data.contextEpoch || 0);
          });
        }
        return changed;
      },
      errorInfo,
      refusePreparation(error) {
        const details = {
          state: "failed",
          code: error.code || "LOCAL_PREPARATION_FAILED",
          executionOutcome: notStarted.executionOutcome,
          currentTurnSubmitted: false,
          mayHaveMutated: notStarted.mayHaveMutated,
          ...(error.pythonCheck ? { pythonCheck: error.pythonCheck } : {}),
        };
        files.durable(path.join(directory, "outcome.json"), details);
        finish(grant, details);
        if (job.request.phased)
          worker.phased.reject(
            job.id,
            Object.assign(error, { notStarted: true }),
          );
      },
      verifyLocalInputs() {
        if (job.request.phased && job.physicalTurns) {
          previousTurn = files.readJson<P.Instance>(
            path.join(directory, "postflight.json"),
          ).documentState;
          services.preparation.archiveCompletedBrokerTurn(
            directory,
            job.physicalTurns,
            {
              privateDirectory: files.privateDirectory,
              read: files.readJson,
              writeFresh: (file, value) => files.durable(file, value, true),
            },
          );
        }
        const failure = services.preparation.checkBrokerTurnInputs(
          job.request,
          config.buildHash,
        );
        if (!failure) return true;
        const details = { state: "failed", code: failure, ...notStarted };
        files.durable(path.join(directory, "outcome.json"), details);
        finish(grant, details);
        if (job.request.phased)
          worker.phased.reject(
            job.id,
            Object.assign(new Error(failure), {
              code: failure,
              notStarted: true,
            }),
          );
        return false;
      },
      assertCurrent: () => lane.assertCurrent(grant),
      preflight() {
        const entry =
          job.kind === "command"
            ? protocol.commandEntry(required(job.request.argv))
            : null;
        const raw =
          job.kind === "rpc" ? protocol.rpcPayload(job.request.payload) : null;
        const protocolOnly =
          job.kind === "rpc"
            ? [
                "initialize",
                "notifications/initialized",
                "ping",
                "tools/list",
              ].includes(required(raw).method)
            : ["tools", "doctor"].includes(entry?.kind ?? "");
        const allowsBusy =
          protocolOnly ||
          ["ui.inspect", "ui.respond", "ui.resolve"].includes(
            entry?.target ?? "",
          );
        allowsBusyAfter = protocolOnly || entry?.target === "ui.inspect";
        selector = job.documentCreation
          ? undefined
          : raw && transport.metadata.isAddinMetadata(raw)
            ? transport.metadata.addinMetadataSelector(raw)
            : job.request.phased ||
                job.sequenceMode === "automatic" ||
                job.contextRefreshRequired ||
                documents.requiresPhysicalStageOwner(job.request.payload)
              ? documents.documentSelector(job)
              : undefined;
        const rpcId = flights?.preflight.binding.rpcId || randomUUID();
        const binding = flights?.preflight.binding || {
          jobId: job.id,
          rpcId,
          requestHash: files.hash(`preflight:${job.id}:${rpcId}`),
          buildHash: config.buildHash,
        };
        const receipt =
          flights?.preflight.receipt ||
          path.join(directory, `preflight-${rpcId}.receipt.json`);
        return checkTurnInstance(
          grant,
          {
            prepared: flights?.preflight,
            receiptPath: receipt,
            binding,
            requireIdle: !allowsBusy,
            diagnosticPath: path.join(directory, "preflight-result.json"),
            documentSelector: selector,
            onObservation(observation) {
              lane.assertCurrent(grant);
              observed = observation;
              records.recordProbeTerminal(job.id, "preflight", {
                version: 2,
                jobId: job.id,
                buildHash: config.buildHash,
                completed: true,
                instance: observation,
                idle: files.idle(observation),
                requiresIdle: !allowsBusy,
              });
            },
          },
          () =>
            records.createProbeIntent(job.id, "preflight", {
              version: 2,
              jobId: job.id,
              buildHash: config.buildHash,
              instance: currentInstance(),
              at: Date.now(),
              binding,
              receipt,
            }),
        );
      },
      sameObservedInstance: (error) =>
        files.sameInstance(error.observation, currentInstance()),
      refusePreflight(refusal, error) {
        const outcome = {
          state: "failed",
          ...notStarted,
          ...refusal,
          ...(refusal.preflightCompleted
            ? { activeCommand: required(error.observation).activeCommand }
            : {}),
        };
        files.durable(path.join(directory, "outcome.json"), outcome);
        finish(grant, outcome);
        if (job.request.phased)
          worker.phased.reject(
            job.id,
            Object.assign(new Error(error.message), {
              code: refusal.code,
              notStarted: true,
            }),
          );
      },
      verifyDocument(localChanged) {
        if (
          localChanged ||
          (job.request.phased && job.physicalTurns) ||
          (job.sequenceMode === "automatic" && job.sequenceParentId) ||
          (job.contextRefreshRequired && !selector?.metadataOnly)
        ) {
          const baselineFile = job.sequenceParentId
            ? path.join(jobDir(job.sequenceParentId), "postflight.json")
            : null;
          const baseline =
            previousTurn ||
            (baselineFile && fs.existsSync(baselineFile)
              ? files.readJson<P.Instance>(baselineFile).documentState
              : null);
          const code = localChanged
            ? "DOCUMENT_CHANGED"
            : documents.compareDocumentState(baseline, observed?.documentState);
          if (code) {
            const refreshedStatePath = path.join(
              directory,
              "refreshed-document-state.json",
            );
            const refresh = {
              success: false,
              status:
                code === "DOCUMENT_CHANGED"
                  ? "document_changed"
                  : "document_guard_rejected",
              code,
              operationSubmitted: false,
              mayHaveMutated: false,
              ...(job.physicalTurns
                ? {
                    scope: "current SDK turn",
                    priorSdkTurns: job.physicalTurns,
                    priorSdkMayHaveMutated: !!job.dispatch?.rpcCount,
                  }
                : {}),
              automaticallyRefreshed:
                observed?.documentState?.status === "complete",
              previousFingerprint: baseline?.fingerprint || null,
              currentState: observed?.documentState || null,
              refreshedStatePath,
              openDocuments: observed?.documents || [],
              message:
                observed?.documentState?.status === "complete"
                  ? "The original operation was not executed. Current document state was collected in this same queue turn; no second queued read is needed to inspect it."
                  : "The original operation was not executed. The response includes the observed target-state availability and open documents; no unchanged-state claim is made.",
            };
            files.durable(refreshedStatePath, refresh);
            const details = {
              state: "failed",
              code,
              ...notStarted,
              refreshedStatePath,
            };
            files.durable(path.join(directory, "outcome.json"), details);
            fs.writeFileSync(
              files.responsePath(config.directory, job, "stdout.txt", true),
              JSON.stringify(refresh) + "\n",
              { flag: job.request.phased ? "a" : "wx", mode: 0o600 },
            );
            finish(grant, details);
            if (job.request.phased)
              worker.phased.reject(
                job.id,
                Object.assign(new Error(refresh.message), {
                  code,
                  notStarted: true,
                }),
              );
            return false;
          }
        }
        return true;
      },
      executeAndComplete: () =>
        executePreparedProduct(
          job,
          grant,
          plan,
          directory,
          selector,
          allowsBusyAfter,
          observed,
        ),
    });
  }
  function snapshot(
    context: Context | undefined,
  ): TurnExecutionSnapshot | null {
    if (!context) return null;
    const { job } = context;
    return freeze({
      jobId: job.id,
      job: {
        id: job.id,
        clientId: job.clientId,
        requestId: job.requestId,
        kind: job.kind,
      },
      running: context.running,
      postflight: context.postflight,
      pendingCount: context.pending.size,
      dispatched: context.dispatched,
      unknown: context.unknown,
      timedOut: context.timedOut,
      workerClosed: context.workerClosed,
      hasWorkerProcess: context.workerProcess !== undefined,
      executionFailed: context.executionFailed,
      workflowUnknown: !!context.workflowUnknown,
      waitingForPause: !!context.waitingForPause,
      nativeActivityId: context.nativeActivityId ?? null,
      deadline: context.deadline,
      rpcDeadline: context.rpcDeadline ?? null,
    });
  }
  return Object.freeze({
    prepare,
    prepareCurrent(payload: P.Rpc, origin?: P.Origin) {
      const grant = productScope.getStore();
      if (!grant || gate.isAdministrative)
        fail("PREPARED_RPC_UNAVAILABLE", "No product preparation scope");
      return prepare(payload, contextFor(grant).job, grant.turn, origin);
    },
    hasProductScope: () => !!productScope.getStore() && !gate.isAdministrative,
    retainPlan(jobId: string, plan: PreparedProductPlan) {
      const turn = plan.kind === "raw" ? plan.turn.turn : plan.turn;
      if (
        turn.jobId !== jobId ||
        (plan.kind === "worker" && plan.message.jobId !== jobId)
      )
        fail(
          "PREPARED_RPC_UNAVAILABLE",
          "Prepared plan belongs to another job",
        );
      if (plans.has(jobId))
        fail(
          "PREPARED_RPC_UNAVAILABLE",
          "An unconsumed plan already owns this job",
        );
      plans.set(jobId, plan);
    },
    preparedTurn(jobId: string): Execution.TurnIdentity | undefined {
      const plan = plans.get(jobId);
      return plan?.kind === "raw" ? plan.turn.turn : plan?.turn;
    },
    discardUnsubmitted(
      jobId: string,
      expected: Execution.TurnIdentity,
    ): boolean {
      const plan = plans.get(jobId);
      if (
        !plan ||
        (plan.kind === "raw" ? plan.turn.turn : plan.turn) !== expected
      )
        return false;
      plans.delete(jobId);
      return true;
    },
    prunePlans() {
      for (const id of plans.keys()) {
        const job = queue.data.jobs[id];
        if (
          !job ||
          ["succeeded", "failed", "cancelled", "expired"].includes(job.state)
        )
          plans.delete(id);
      }
      for (const [grant, context] of contexts)
        if (
          !context.running &&
          !context.pending.size &&
          !context.nativeActivityToken &&
          (!context.workerProcess || context.workerClosed) &&
          lane.currentGrant() !== grant &&
          lane.heldContext() !== grant.context
        )
          contexts.delete(grant);
    },
    run,
    withCheckpointTurn,
    post,
    backend,
    checkInstance,
    checkTurnInstance,
    snapshot(grant?: ProductGrant) {
      return snapshot(grant ? contexts.get(grant) : currentContext());
    },
    activeSnapshot() {
      const context = currentContext();
      return context?.postflight ? null : snapshot(context);
    },
    heldSnapshot: () => snapshot(heldExecutionContext()),
    hasOtherActivity(
      jobId?: string,
      expectedActivityId?: string | null,
    ): boolean {
      const context = currentContext();
      const token =
        context &&
        context.job.id === jobId &&
        context.nativeActivityToken?.id === expectedActivityId
          ? context.nativeActivityToken
          : undefined;
      return gate.hasOtherActivity(token);
    },
    workerStatus(message: { jobId?: string; workerToken?: string }) {
      const context = currentContext();
      if (
        !context ||
        context.postflight ||
        message.jobId !== context.job.id ||
        !equal(message.workerToken, context.token)
      )
        return null;
      if (context.unknown || queue.summary().blocked)
        fail("RECONCILIATION_REQUIRED", "SDK outcome remains unresolved");
      return Object.freeze({
        remainingMs: required(context.budget).remaining(),
        waitingForPause: !!context.waitingForPause,
      });
    },
    /** Called only after the existing receipt-validated recovery/acceptance. */
    endNativeActivity(jobId: string, expectedActivityId: string): boolean {
      for (const context of contexts.values())
        if (
          context.job.id === jobId &&
          context.nativeActivityToken?.id === expectedActivityId
        ) {
          endNativeActivity(context);
          return true;
        }
      return false;
    },
    probeScope: () => probeBoundary.getStore(),
    runProbeScope<Result>(scope: ProbeBoundary, action: () => Result): Result {
      return probeBoundary.run(scope, action);
    },
    sendProbe<Result>(
      send: () => Result,
      boundary?: P.Send["dispatchBoundary"],
    ): Result {
      const scope = probeBoundary.getStore();
      if (!scope) return send();
      if (boundary === "broker-post") {
        scope.assertCurrent();
        return probeBoundary.run(
          { ...scope, dispatchBoundary: boundary },
          send,
        );
      }
      scope.start();
      return send();
    },
  });
}
