import type { ScopedPrepared } from "./queue-admission";
/** Typed inventory of the retained Node adapters consumed by broker composition.
 * These contracts are private and do not widen the public CAD API. */
import type * as P from "./queue-broker-ports";
import type {
  PhasedWorkerOptions,
  PhasedWorkers,
} from "../packages/node-adapters/src/execution/phased-workers";
import type { QueueGate } from "../packages/node-adapters/dist/execution/gate";
import type { BrokerControlFence } from "../packages/core/src/application/broker-control";
import type { PreparedPythonArtifact } from "../packages/core/src/domain/python-artifact";
import type {
  BrokerGrant,
  BrokerHold,
  createBrokerSession,
} from "../packages/core/src/application/broker-session";
import type { TurnIdentity } from "../packages/core/src/application/broker-execution";
import type { createAddinAdmission } from "../packages/node-adapters/src/execution/addin-admission-client";
import { isDeepStrictEqual } from "node:util";

const metadataTool = "get_open_document_metadata";

function refuse(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, notStarted: true });
}

export function isAddinMetadata(payload: P.Rpc) {
  return payload.method === "tools/call" && payload.params?.name === metadataTool;
}

function metadataWire(payload: P.Rpc) {
  const params = payload.params;
  const args = params?.arguments;
  const id = payload.id;
  if (
    !isAddinMetadata(payload) ||
    payload.jsonrpc !== "2.0" ||
    !((typeof id === "string" && id.length > 0) ||
      (typeof id === "number" && Number.isSafeInteger(id))) ||
    Object.keys(payload).length !== 4 ||
    !["jsonrpc", "method", "id", "params"].every((key) => Object.hasOwn(payload, key)) ||
    !params ||
    Object.keys(params).length !== 2 ||
    !Object.hasOwn(params, "name") ||
    !Object.hasOwn(params, "arguments") ||
    !args ||
    Array.isArray(args) ||
    Object.keys(args).length !== 2 ||
    !Object.hasOwn(args, "fileId") ||
    !Object.hasOwn(args, "version") ||
    typeof args["fileId"] !== "string" ||
    !args["fileId"].trim() ||
    typeof args["version"] !== "number" ||
    !Number.isSafeInteger(args["version"]) ||
    args["version"] <= 0
  )
    refuse("INVALID_RPC", "Expected one exact saved-document metadata request");
  return Object.freeze({
    jsonrpc: "2.0",
    method: "tools/call",
    id,
    params: Object.freeze({
      name: metadataTool,
      arguments: Object.freeze({ fileId: args["fileId"], version: args["version"] }),
    }),
  });
}

export function addinMetadataSelector(payload: P.Rpc) {
  return {
    kind: "saved-document-metadata",
    ...metadataWire(payload).params.arguments,
  } as const;
}

/** A capability-specific proof, separate from every Python certificate. */
export function prepareMetadataWire(payload: P.Rpc): P.MetadataWireProof {
  const wire = metadataWire(payload);
  const bytes = JSON.stringify(wire);
  return Object.freeze({
    wire,
    fence(current: P.Rpc) {
      if (JSON.stringify(current) !== bytes)
        refuse("INPUT_CHANGED", "Prepared ADDIN metadata bytes changed");
    },
  });
}

export function provisionAddinMetadata(
  config: P.TrustedAddinMetadataAdmission | undefined,
  backend: string | undefined,
  prepare: typeof createAddinAdmission,
) {
  if (config === undefined) return null;
  if (
    !config ||
    backend !== "addin" ||
    config.capability !== metadataTool ||
    !Number.isSafeInteger(config.pid) ||
    config.pid <= 0
  )
    refuse("INVALID_ADMISSION_PROVISIONING", "Expected a provisioned ADDIN metadata capability");
  const { endpoint, token, pid, birth, instance, epoch, source, build, owner: provisionedOwner } = config;
  if ([endpoint, token, birth, instance, epoch, source, build, provisionedOwner].some(
    (pin) => typeof pin !== "string" || !pin.trim(),
  ))
    refuse("INVALID_ADMISSION_PROVISIONING", "ADDIN metadata provisioning is incomplete");

  return {
    bind(
      wire: ReturnType<typeof metadataWire>,
      observed: P.Instance | undefined,
      pinned: P.Instance,
      owner: string,
      request: string,
      timeoutMs: number,
    ) {
      if (owner !== provisionedOwner)
        refuse("ADMISSION_OWNER_MISMATCH", "Client does not match the provisioned ADDIN owner");
      const { fileId, version } = wire.params.arguments;
      const target = fields(observed?.documentState?.state?.identity);
      const creationId = target["creationId"];
      const lineage = observed?.documents?.map(fields).filter(
        (entry) => entry["id"] === creationId && entry["fileId"] === fileId,
      );
      const inventory = lineage?.filter((entry) => entry["version"] === version);
      const entry = inventory?.length === 1 ? inventory[0] : undefined;
      if (
        observed?.pid !== pid ||
        observed.birth !== birth ||
        pinned.pid !== pid ||
        pinned.birth !== birth ||
        observed.documentState?.status !== "complete" ||
        typeof creationId !== "string" ||
        !creationId.trim() ||
        target["fileId"] !== fileId ||
        target["version"] !== version ||
        target["isSaved"] !== true ||
        lineage?.some((row) =>
          typeof row["version"] !== "number" ||
          !Number.isSafeInteger(row["version"]) ||
          row["version"] < 1 ||
          row["dataFileError"] !== undefined,
        ) ||
        !entry ||
        entry["isSaved"] !== true
      )
        refuse("DOCUMENT_ADMISSION_UNPROVEN", "Preflight did not prove the provisioned saved document");

      const identity = Object.freeze({
        owner,
        request,
        instance,
        epoch,
        source,
        build,
        document: JSON.stringify({ creationId, fileId, version }),
      });
      try {
        // Construction is local. It validates the credentials, endpoint and
        // exact bytes before a journal can imply that a send was possible.
        const { binding } = prepare({ endpoint, token, timeoutMs }, identity, wire);
        return { scope: Object.freeze({ endpoint, token, identity }), binding };
      } catch {
        refuse("INVALID_ADMISSION_PROVISIONING", "Invalid ADDIN admission provisioning");
      }
    },
  };
}

function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function matchMetadataEvidence(
  response: P.Response,
  binding: unknown,
  rpcId: string,
  wireId: P.Rpc["id"],
  decode: (raw: string) => unknown,
): P.Reply {
  function invalid(): never {
    throw Object.assign(new Error("Metadata response lacks original bound terminal evidence"), {
      code: "RECEIPT_MISMATCH",
    });
  }
  let envelope: Record<string, unknown>;
  try {
    envelope = fields(decode(response.raw));
  } catch {
    return invalid();
  }
  const terminal = fields(envelope["record"]);
  const reply = fields(response.toolResponse);
  if (
    response.status !== 200 ||
    fields(binding)["request"] !== rpcId ||
    wireId !== `fmcad:${rpcId}` ||
    envelope["version"] !== 1 ||
    !isDeepStrictEqual(fields(envelope["binding"]), binding) ||
    terminal["state"] !== "terminal" ||
    Object.keys(terminal).length !== 2 ||
    !Object.hasOwn(terminal, "result") ||
    Object.keys(reply).length !== 3 ||
    reply["jsonrpc"] !== "2.0" ||
    reply["id"] !== wireId ||
    !isDeepStrictEqual(reply["result"], terminal["result"])
  )
    return invalid();
  return { jsonrpc: "2.0", id: wireId, result: reply["result"] };
}

export function matchRetainedMetadataEvidence(
  record: Pick<P.RecordEvidence, "response" | "wireRequest" | "binding">,
  original: {
    version: number;
    kind: string;
    binding: P.Binding;
    wireId?: P.Rpc["id"];
    response: P.Response;
  } | null,
  decode: (raw: string) => unknown,
) {
  const { response, wireRequest, binding } = record;
  if (
    !response ||
    !wireRequest ||
    !original ||
    original.version !== 1 ||
    original.kind !== "owned-rpc-received-response-v1" ||
    !isDeepStrictEqual(original.binding, binding) ||
    original.wireId !== wireRequest.id ||
    original.response?.status !== response.status ||
    original.response.raw !== response.raw
  )
    throw Object.assign(new Error("ADDIN metadata differs from the original retained response"), {
      code: "RECEIPT_MISMATCH",
    });
  return matchMetadataEvidence(response, binding["addinAdmission"], binding.rpcId, wireRequest.id, decode);
}

export function usesRetainedMetadataEvidence(
  record: Pick<P.RecordEvidence, "binding" | "dispatchClass">,
) {
  const metadata = record.dispatchClass === "addin-metadata";
  const binding = Object.hasOwn(record.binding, "addinAdmission");
  if (metadata !== binding || (metadata && !record.binding["addinAdmission"]))
    throw Object.assign(new Error("ADDIN metadata dispatch is missing its exact binding"), {
      code: "RECEIPT_MISMATCH",
    });
  return metadata;
}

type Grant = BrokerGrant<P.LaneContext>;
type Hold = BrokerHold<P.LaneContext>;

/** Runtime routing for existing grant capabilities; the session still owns
 * eligibility, and the caller owns durable domain/receipt transitions. */
export function createBrokerLane(
  session: ReturnType<typeof createBrokerSession<P.LaneContext>>,
  ports: { durableHoldReason(): unknown; wakeup(): void },
) {
  let current: Grant | null = null;
  let held: Hold | null = null;
  let fault: string | null = null;
  let administrative = false;

  return {
    snapshot: session.snapshot,
    assertCurrent: session.assertCurrentGrant,
    currentGrant: () => current,
    hasHold: () => held !== null,
    busy: () =>
      administrative ||
      session.snapshot().active !== null ||
      !!held?.context?.executing,
    activeWorker: () =>
      current?.context.postflight
        ? null
        : current?.context.worker ?? held?.context?.worker ?? null,
    heldWorker: () => held?.context?.worker ?? null,
    heldReason() {
      const reason = ports.durableHoldReason();
      return (
        fault ??
        session.snapshot().held?.reason ??
        (typeof reason === "string" ? reason : null)
      );
    },
    recordFault(reason: string) {
      fault ??= reason;
    },
    faulted: () => fault !== null,
    setAdministrative(value: boolean) {
      administrative = value;
    },
    begin(job: P.Job, turn: TurnIdentity, scoped: boolean) {
      current = session.acquire(
        { job, executing: true },
        turn,
        scoped ? held ?? undefined : undefined,
      );
      return current;
    },
    hold(grant: Grant, reason: string, commit: () => void) {
      if (current !== grant) return false;
      held = session.hold(grant, reason);
      current = null;
      commit();
      return true;
    },
    setControlHold(reason: string | null) {
      if (current) return;
      if (reason !== null) held = session.hold(held, reason);
      else {
        if (held) session.settle(held, () => undefined);
        held = null;
      }
    },
    settle(grant: Grant, commit: () => undefined) {
      session.settle(grant, commit);
      current = null;
      ports.wakeup();
    },
    captureRecovery() {
      const expected = held;
      function assertCurrent() {
        if (expected !== held || current)
          throw Object.assign(
            new Error("Runtime hold changed before recovery settlement"),
            { code: "STATE_CONFLICT" },
          );
      }
      return {
        assertCurrent,
        settle<T>(commit: () => T): T {
          assertCurrent();
          if (!expected) return commit();
          let result!: T;
          session.settle(expected, () => {
            result = commit();
          });
          held = null;
          ports.wakeup();
          return result;
        },
      };
    },
  };
}

interface Control {
  handle(message: P.Message, clientId: string): Promise<unknown>;
}
interface ScratchControl {
  create(message: P.Message, clientId: string): Promise<unknown>;
  close(message: P.Message, clientId: string): Promise<unknown>;
  grant(message: P.Message, clientId: string): Promise<unknown>;
}
interface SavedFixtureControl {
  observe(message: P.Message, clientId: string): Promise<unknown>;
  probe(message: P.Message, clientId: string): Promise<unknown>;
  retain(message: P.Message, clientId: string): Promise<unknown>;
}
interface SuccessorControl {
  create(message: P.Message, clientId: string): Promise<unknown>;
  observe(message: P.Message, clientId: string): Promise<unknown>;
  ownsCreation(requestId: unknown): boolean;
  metadata(): unknown;
}
interface Inspection {
  identity: P.AtomicIdentity;
  instance: P.Instance;
  before: AuditSnapshot;
  prepared: P.AtomicPrepared;
  hashes: Array<{ file: string; sha256: string }>;
  binding: {
    targetJobId: string;
    observationJobId: string;
    [key: string]: unknown;
  };
}
export interface AuditSnapshot {
  owner: P.Owner;
  identity: P.Identity;
  paused: boolean;
  generation: number;
  contextEpoch: number;
  active: string | null;
  blocked: unknown;
  lease: unknown;
  jobs: unknown[];
}
export interface AuditPorts {
  installation: string;
  buildHash: string;
  jobDirectory(id: string): string;
  assertOwner(target: string, observer: string, clientId: string): void;
  inspect(message: P.Message, clientId: string): Promise<Inspection>;
  fence(value: Inspection, inFlight: boolean): void;
  begin(): void;
  end(): void;
  admit<T>(send: () => Promise<T>): Promise<T>;
  check(
    payload: P.Rpc,
    artifact?: PreparedPythonArtifact,
  ): Promise<P.Certificate>;
  post(payload: P.Rpc, sessionId?: string): Promise<P.Response>;
  match(response: P.Response, payload: P.Rpc): P.Reply | null;
  remoteReceipt(record: {
    receipt?: string;
    binding: P.Binding;
    instance: P.Instance;
  }): P.RemoteReceipt;
  sendScript(scope: P.ScriptScope, script: string): Promise<P.ToolResult>;
}
interface ControllerPorts {
  dir: string;
  state: P.State;
  clients(): Record<string, string>;
  assertControl(control: unknown): void;
  fence?(inFlight?: boolean): void;
  fenceRuntime?(inFlight: boolean): void;
  epochFence?(inFlight: boolean): void;
  epochSnapshot?(): unknown;
  snapshot?(): unknown;
  activate?(epoch: P.Epoch, identity: P.Identity): void;
  closed?(epoch: P.Epoch): void;
  auditPorts?: AuditPorts;
  sendScratchScript?(
    scope: P.ScriptScope,
    script: string,
  ): Promise<P.ToolResult>;
  [key: string]: unknown;
}
interface SuccessorRuntime {
  /** Returned only after immutable predecessor/epoch evidence is verified. */
  effectiveIdentity?: Pick<P.Identity, "buildHash" | "configHash" | "instance">;
  authority: {
    previousBuildHash: string;
    sourceCommit: string;
    predecessor: { rootState: { sha256: string } };
  };
  authorityEntry: unknown;
  audit: string;
}
interface AtomicWire extends ScopedPrepared {
  outgoing: P.Rpc;
  pythonArtifact: PreparedPythonArtifact;
  rpcId: string;
  record: P.RecordEvidence & ScopedPrepared["record"];
  dispatchTimeoutMs: number;
}
export interface BrokerModules {
  "./queue-isolated-epoch": {
    openIsolatedEpoch(dir: string, options?: Record<string, unknown>): P.State;
    epochAdmission(
      state: P.State,
      request: P.Request | undefined,
      clients: Record<string, string>,
    ): { kind?: string; purpose?: string } | null;
  };
  "./queue-epoch-lineage": {
    epochControlDirectory(dir: string, epoch: P.Epoch): string;
  };
  "./queue-gate": { QueueGate: typeof QueueGate };
  "./pause-budget": {
    PauseBudget: new (ms: number, expired: () => void) => P.Budget;
  };
  "./queue-native-receipt": {
    start(record: {
      receipt?: string;
      binding: P.Binding;
      instance: P.Instance;
    }): P.NativeProof | null;
    completion(
      record: { receipt?: string; binding: P.Binding; instance: P.Instance },
      declaration?: P.NativeProof,
    ): P.NativeProof | null;
  };
  "./queue-connection": {
    queueDirectory(): string;
    queueSocket(dir: string): string;
  };
  "./queue-document": {
    documentSelector(
      job: Pick<P.Job, "kind" | "request">,
    ): import("../packages/core/src/domain/document").DocumentSelector | null;
    compareDocumentState: typeof import("../packages/core/src/domain/document").compareDocumentState;
  };
  "./dist/config-platform": typeof import("../packages/node-adapters/dist/config-platform");
  "./queue-instance": {
    durable(file: string, value: unknown, exclusive?: boolean): void;
    readJson<T = unknown>(file: string): T;
    processBirth(pid?: number): string;
    priorProcessAlive(instance: P.Instance): boolean | null;
    reclaim(dir: string, recoverCurrent?: () => void): unknown;
    buildHash(): string;
    brokerConfigHash(config: P.Config): string;
    probe(client: ProbeClient, options: P.ProbeOptions): Promise<P.Instance>;
    prepareProbe(
      client: ProbeClient,
      options: P.ProbeOptions,
    ): Promise<P.Send<P.Instance>>;
    sameInstance(a: unknown, b: unknown): boolean;
    idle(instance: unknown): boolean;
    workflowNonterminal(value: unknown): boolean;
    workflowOutputNonterminal(value: unknown): boolean;
    prepareReceiptScript(
      code: string,
      official: boolean,
      receipt: string,
      binding: P.Binding,
      options?: { mapPath?: (file: string) => string },
    ): PreparedPythonArtifact;
    hash(value: string | Buffer): string;
    fail(code: string, message: string): never;
  };
  "./python": {
    verifyPythonArtifact: typeof import("../packages/node-adapters/dist/python/artifact").verifyPythonArtifact;
    retainPythonOrigin(
      artifact: PreparedPythonArtifact,
      origin: P.Origin,
    ): PreparedPythonArtifact;
    prepareWireArtifact(
      runtime: string,
      source: string,
    ): PreparedPythonArtifact;
    classifyPythonRpc(
      payload: P.Rpc,
    ): { kind: "python"; source: string } | { kind: "non-python" };
  };
  "./queue-admission": typeof import("./queue-admission");
  "./atomic-observation-binding": {
    atomicObservationIdentityHash(identity: P.AtomicIdentity): string;
    assertAtomicObservationWire(
      code: string,
      artifact: PreparedPythonArtifact,
    ): void;
  };
  "./atomic-workflow-observation": {
    atomicStatusSummaryFromReply(reply: P.Reply | null): P.AtomicSummary;
    deriveAtomicHolderScope(
      job: P.Job,
      invocation: unknown,
      cwd: string | undefined,
      config: P.AtomicScopeConfig,
    ): Record<string, unknown> | null;
    prepareAtomicHolderObservation(
      job: P.Job,
      scope: Record<string, unknown>,
      options: Record<string, unknown>,
    ): Promise<P.AtomicPrepared>;
    fastenersScope: P.AtomicScopeConfig;
    isAtomicObservationCandidate(
      job: P.Job,
      build: string | undefined,
      config: P.AtomicScopeConfig,
    ): boolean;
    validateAtomicReconcileInvocation(
      invocation: unknown,
      prepared: P.AtomicPrepared,
    ): void;
    readCurrentAtomicObservationReport(file: string): Promise<{
      fingerprint: string;
      identity: P.AtomicIdentity;
      snapshot: unknown;
      commandId: string;
      sessionNonce: string;
      docId: string;
    }>;
    snapshotStillCurrent(snapshot: unknown): boolean;
    sourceEnvelopeStillCurrent(envelope: unknown): boolean;
    verifyAtomicObservationFence(fence: Record<string, unknown>): void;
    bindAtomicRuntimeAbi(
      prepared: P.AtomicPrepared,
      abi: unknown,
    ): P.BoundAtomicPrepared;
  };
  "./atomic-runtime-abi": {
    buildAtomicRuntimeAbi(
      job: P.Job,
      prepared: P.AtomicPrepared,
      records: P.RecordEvidence[],
      options: { dir: string },
    ): unknown;
  };
  "./cli": { parseFlags(argv: string[]): { rest: string[] } };
  "./commands": {
    findCommand(
      rest: string[],
    ): { key: string; kind: string; target: string } | undefined;
  };
  "./queue-epoch-successor": {
    claimSuccessorBroker(
      dir: string,
      marker: P.Owner,
      nonce: string,
      codeHash: string,
      config: P.Config,
    ): SuccessorRuntime;
  };
  "./queue-atomic-migration-runtime": {
    claimMigratedBroker(
      dir: string,
      marker: P.Owner,
      nonce: string,
      build: string,
      scope: P.AtomicScopeConfig,
    ): string;
    assertMigrationAdmission(dir: string, action: string): void;
  };
  "./queue-epoch-runtime-upgrade": {
    claimEpochRuntimeBroker(
      dir: string,
      marker: P.Owner,
      nonce: string,
      build: string,
    ): string;
  };
  "./queue-preflight": {
    legacyBusyEvidence(
      snapshot: P.Snapshot,
      instance: P.Instance,
      build: string,
      directory: string,
    ): { jobId: string; method: string } | null;
  };
  "./dist/fusion-transport/broker": {
    createBrokerTransport(
      config: P.Config,
      dependencies: {
        version: string;
        requestTimeout: (config: P.Config) => number;
        bridgeSource(): string;
      },
    ): P.Client;
  };
  "../package.json": { version: string };
  "./addin-bridge": { addinBridgeSource(): string };
  "./request-timeout": { requestTimeout(config: P.Config): number };
  "./dist/node-adapters/broker-ipc/normal-admission": typeof import("../packages/node-adapters/dist/broker-ipc/normal-admission");
  "./dist/node-adapters/broker-ipc/normal-restart": typeof import("../packages/node-adapters/dist/broker-ipc/normal-restart");
  "./dist/node-adapters/telemetry/phase-timings": typeof import("../packages/node-adapters/src/telemetry/phase-timings");
  "./queue-phased": {
    PhasedWorkers: new (
      options: Omit<
        PhasedWorkerOptions,
        | "durable"
        | "readResult"
        | "prepareRequest"
        | "processBirth"
        | "workflowNonterminal"
        | "responsePath"
        | "entrypoint"
        | "checkSdkRequest"
        | "onUnknown"
        | "state"
      > & {
        state: P.State;
        checkSdkRequest(
          message: P.WorkerMessage,
          signal: AbortSignal,
        ): Promise<void>;
        onUnknown(job: P.Job, reason: string): void;
      },
    ) => Omit<PhasedWorkers, "pending" | "enqueue" | "start"> & {
      start(job: P.Job): void;
      pending(id: string): { message: P.WorkerMessage } | null;
      enqueue(message: P.WorkerMessage): Promise<unknown>;
    };
  };
  "./queue-console-admin": {
    createAdmin(options: {
      state: P.State;
      gate: QueueGate;
      dir: string;
      marker: P.Owner;
      buildHash: string;
      getContext(): {
        active: boolean;
        busy: boolean;
        stopping: boolean;
        held: string | null;
      };
      setBusy(value: boolean): void;
      resumeCheck(): Promise<P.Instance>;
      observeControlCompletion(): Promise<P.RemoteReceipt>;
      close(): Promise<void>;
      diagnostics(): void;
      durable(file: string, value: unknown, exclusive?: boolean): void;
      readJson(file: string): unknown;
      hash(value: string | Buffer): string;
    }): {
      accepts(action: string): boolean;
      handle(message: P.Message, clientId: string): Promise<unknown>;
    };
  };
  "./dist/node-adapters/broker-ipc/lifecycle": {
    createLifecycleDispatcher(options: {
      gate: QueueGate;
      admin: {
        accepts(action: string): boolean;
        handle(message: P.Message, clientId: string): Promise<unknown>;
      };
      dir: string;
      buildHash: string;
      resumeCheck(proof?: P.ResetProof): Promise<P.Instance>;
      authorizeResetResume(
        nonce: string | undefined,
        clientId: string,
        fence: BrokerControlFence,
      ): P.ResetProof | undefined;
      diagnostics(): void;
      beforeNewResume?(): void;
      canResume(): void;
    }): {
      accepts(action: string): boolean;
      handle(message: P.Message, clientId: string): Promise<unknown>;
    };
  };
  "./queue-atomic-wire": {
    prepareAtomicObservationWire(options: Record<string, unknown>): AtomicWire;
  };
  "./dist/core/application/execution": typeof import("../packages/core/src/application/execution");
  "./queue-response-files": {
    responsePath(
      dir: string,
      job: Pick<P.Job, "id" | "kind">,
      name: string,
      create?: boolean,
    ): string;
    jobOutputs(
      dir: string,
      job: P.Job,
    ): {
      provenance?: unknown;
      execution?: { pythonCheck?: unknown };
      pythonChecks?: unknown[];
    };
  };
  "./dist/node-adapters/persistence/accepted-inputs": {
    readAdmission(dir: string, job: P.Job): unknown;
    retainAdmission(dir: string, request: P.Request): void;
  };
  "./queue-atomic-audit-upgrade": {
    auditUpgradeApproval(approved: unknown, dir: string): { purpose: string };
    auditUpgradeStillCurrent(upgrade: unknown): boolean;
  };
  "./queue-instance-liveness": typeof import("./queue-instance-liveness");
  "./queue-atomic-recovery-audit": {
    createRecoveryAudit(ports: AuditPorts): Control;
  };
  "./queue-audit-facts-capture": {
    createAuditFactsCapture(options: Record<string, unknown>): {
      approvedPrerequisite():
        | { clientId: string; hash: string; currentInstance: P.Instance }
        | undefined;
      handle(message: P.Message, clientId: string): Promise<unknown>;
      authorize(message: P.Message, clientId: string): Promise<unknown>;
    };
  };
  "./queue-scratch-control": {
    createScratchControl(options: ControllerPorts): ScratchControl;
  };
  "./queue-saved-fixture-control": {
    createSavedFixtureControl(options: ControllerPorts): SavedFixtureControl;
  };
  "./queue-epoch-successor-control": {
    createSuccessorControl(options: ControllerPorts): SuccessorControl;
  };
  "./queue-saved-first-save": {
    firstSavePhase(epoch: P.Epoch, jobs: Record<string, P.Job>): string | null;
    grantSavedFirstSave(
      options: ControllerPorts,
      message: P.Message,
      clientId: string,
    ): unknown;
  };
  "./queue-native-fixture-grant": {
    grantNativeFixture(
      options: ControllerPorts,
      message: P.Message,
      clientId: string,
    ): unknown;
  };
  "./queue-closed-epoch-successor": {
    authorizeClosedSuccessor(
      options: ControllerPorts,
      message: P.Message,
      clientId: string,
    ): { authority: unknown };
  };
  "./queue-atomic-control": {
    observationRequest(
      message: P.Message,
      clientId: string,
      job: P.Job | undefined,
      gate: P.GateSnapshot,
      scope: P.AtomicScopeConfig,
    ): P.Request;
  };
  "./composition/stage-dependencies": {
    requiresPhysicalStageOwner(payload: unknown): boolean;
  };
  "./dist/core/domain/queue-request-identity": typeof import("../packages/core/src/domain/queue-request-identity");
  "./batch-atomic": {
    setObserveReadOnlyCatalog(catalog: unknown): void;
    reconcileAtomicBatch(
      observer: unknown,
      file: string,
      args: string[],
    ): Promise<unknown>;
  };
  "./catalog": { catalog: unknown };
}
interface ProbeClient {
  server: { timeoutMs: number };
  callTool?(...args: unknown[]): Promise<P.ToolResult>;
  prepareCallTool?(...args: unknown[]): Promise<P.Send>;
}
