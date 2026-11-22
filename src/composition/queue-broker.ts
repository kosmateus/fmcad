// Canonical broker composition. Runtime JavaScript is emitted by TypeScript.

import * as fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import type * as P from "../queue-broker-ports";
import type { BrokerGrant } from "../../packages/core/src/application/broker-session";
import {
  addinMetadataSelector,
  createBrokerLane,
  pinPhysicalTurn,
  isAddinMetadata,
  matchMetadataEvidence,
  matchRetainedMetadataEvidence,
  prepareMetadataWire,
  provisionAddinMetadata,
  usesRetainedMetadataEvidence,
} from "../queue-broker-modules";
import type {
  BrokerModules,
  AuditPorts,
  AuditSnapshot,
} from "../queue-broker-modules";
import type { BrokerControlFence } from "../../packages/core/src/application/broker-control";
import type { DispatchFailure } from "../../packages/core/src/application/execution";
import type { BrokerStartup } from "../../packages/node-adapters/src/execution/broker-lifetime";
import type { RecoveryFence } from "../../packages/core/src/application/broker-recovery";
import type {
  PreparedTurn,
  TurnIdentity,
} from "../../packages/core/src/application/broker-execution";
import {
  resolveBackendHead,
  prepareBackendTransition,
} from "../queue-backend-transition";
// Source and packaged launchers share the public facade's installation anchor.
const runtimeAnchor = path.join(__dirname, "..", "queue-broker.js");
const runtimeRequire = createRequire(runtimeAnchor);
const { assertAutodeskFusionBackend } = runtimeRequire(
  "./dist/core/domain/physical-backend",
) as typeof import("../../packages/core/src/domain/physical-backend");
const load = <K extends keyof BrokerModules>(name: K): BrokerModules[K] =>
  runtimeRequire(name) as BrokerModules[K];
const { MAX_BROKER_IPC_BYTES: MAX } = runtimeRequire(
  "./dist/node-adapters/broker-ipc/server",
) as typeof import("../../packages/node-adapters/src/broker-ipc/server");
const { createBrokerIpcDispatch } = runtimeRequire(
  "./dist/node-adapters/broker-ipc/dispatch",
) as typeof import("../../packages/node-adapters/src/broker-ipc/dispatch");
const { claimBrokerLifetime } = runtimeRequire(
  "./dist/node-adapters/execution/broker-lifetime",
) as typeof import("../../packages/node-adapters/src/execution/broker-lifetime");
const {
  createBrokerIpcObserver,
  debugTraceContext,
  publishBrokerDiagnostics,
  summarizeBrokerRaw,
  writeRequestTrace,
} = runtimeRequire(
  "./dist/node-adapters/telemetry/broker-observer",
) as typeof import("../../packages/node-adapters/src/telemetry/broker-observer");
const { openIsolatedEpoch, epochAdmission } = load("./queue-isolated-epoch");
const projectActivity = runtimeRequire(
  "./dist/node-adapters/persistence/project-history/activity",
) as typeof import("../../packages/node-adapters/src/persistence/project-history/activity");
const brokerExecution = runtimeRequire(
  "./dist/core/application/broker-execution",
) as typeof import("../../packages/core/src/application/broker-execution");
const { canonical } = runtimeRequire(
  "./dist/core/domain/queue",
) as typeof import("../../packages/core/src/domain/queue");
const {
  archiveCompletedBrokerTurn,
  checkBrokerTurnInputs,
  prepareBrokerFlights,
  prepareBrokerScript,
} = runtimeRequire(
  "./dist/node-adapters/execution/broker-preparation",
) as typeof import("../../packages/node-adapters/src/execution/broker-preparation");
const { fencePreparedWire, postAddinAdmission } = runtimeRequire(
  "./dist/node-adapters/execution/broker-physical",
) as typeof import("../../packages/node-adapters/src/execution/broker-physical");
const { createAddinAdmission } = runtimeRequire(
  "./dist/node-adapters/execution/addin-admission-client",
) as typeof import("../../packages/node-adapters/src/execution/addin-admission-client");
const { decodeAdmissionJson } = runtimeRequire(
  "./dist/node-adapters/execution/admission-json",
) as typeof import("../../packages/node-adapters/src/execution/admission-json");
const { createBrokerRecords } = runtimeRequire(
  "./dist/node-adapters/persistence/broker-records",
) as typeof import("../../packages/node-adapters/src/persistence/broker-records");
const { createBrokerCheckpointEvidence, checkpointGeneration, checkpointDisclosableConflicts } = runtimeRequire(
  "./document-checkpoint-broker",
) as typeof import("../document-checkpoint-broker");
const { createDocumentUnlockAdmission } = runtimeRequire(
  "./document-unlock-admission",
) as typeof import("../document-unlock-admission");
const { createDocumentUnlockController } = runtimeRequire(
  "./document-unlock-controller",
) as typeof import("../document-unlock-controller");
const { decodeDocumentUnlockRequest } = runtimeRequire(
  "./dist/core/application/document-unlock",
) as typeof import("../../packages/core/src/application/document-unlock");
const { parseNativeResult } = runtimeRequire(
  "./dist/core/application/cad/native-result",
) as typeof import("../../packages/core/src/application/cad/native-result");
const { hash: checkpointStateHash } = runtimeRequire(
  "./dist/core/application/cad/json",
) as typeof import("../../packages/core/src/application/cad/json");
const { createBrokerRecovery } = runtimeRequire(
  "./dist/core/application/broker-recovery",
) as typeof import("../../packages/core/src/application/broker-recovery");
const atomicAcceptance = runtimeRequire(
  "./dist/core/application/broker-atomic-acceptance",
) as typeof import("../../packages/core/src/application/broker-atomic-acceptance");
const {
  createBrokerRecoveryEvidence,
  observeBrokerRecovery,
  publishBrokerRecoveredDispatch,
} = runtimeRequire(
  "./dist/node-adapters/execution/broker-recovery-evidence",
) as typeof import("../../packages/node-adapters/src/execution/broker-recovery-evidence");
const { epochControlDirectory } = load("./queue-epoch-lineage");
const { QueueGate } = load("./queue-gate");
const { PauseBudget } = load("./pause-budget");
const nativeReceipts = load("./queue-native-receipt");
const { queueDirectory, queueSocket } = load("./queue-connection");
const { documentSelector, compareDocumentState } = load("./queue-document");
const {
  resolveRuntimePaths,
  resolveChildEntrypoint,
  assertPlatformCapability,
  detectPlatform,
} = load("./dist/config-platform");
const {
  durable,
  readJson,
  processBirth,
  priorProcessAlive,
  reclaim: reclaimOwner,
  buildHash,
  brokerConfigHash,
  probe,
  sameInstance,
  idle,
  workflowNonterminal,
  workflowOutputNonterminal,
  prepareReceiptScript,
  hash,
} = load("./queue-instance");
function fail(code: string, message: string): never {
  return load("./queue-instance").fail(code, message);
}
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new TypeError("Missing broker record");
  return value;
}
function errorInfo(value: unknown): P.BrokerError {
  if (!value || typeof value !== "object") throw value;
  const fields = value as Record<string, unknown>;
  if (fields["code"] !== undefined && typeof fields["code"] !== "string")
    throw value;
  if (fields["message"] !== undefined && typeof fields["message"] !== "string")
    throw value;
  // Preserve exception identity, including explicit fake-adapter error objects.
  // Reading metadata must not mutate a frozen Error or alias a new dispatch error.
  return value as P.BrokerError;
}
const {
  retainPythonOrigin,
  prepareWireArtifact,
  classifyPythonRpc } = load("./python");
const { createProductionQueueAdmission } = load("./queue-admission");
const { atomicObservationIdentityHash, assertAtomicObservationWire } = load(
  "./atomic-observation-binding",
);
const {
  atomicStatusSummaryFromReply,
  deriveAtomicHolderScope,
  prepareAtomicHolderObservation,
  fastenersScope,
  isAtomicObservationCandidate,
  validateAtomicReconcileInvocation,
  readCurrentAtomicObservationReport,
  snapshotStillCurrent,
  verifyAtomicObservationFence,
  bindAtomicRuntimeAbi,
} = load("./atomic-workflow-observation");
const { buildAtomicRuntimeAbi } = load("./atomic-runtime-abi");

const own = (object: object, key: PropertyKey) => Object.hasOwn(object, key);
const same = isDeepStrictEqual;
const equal = (a: unknown, b: unknown) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
function isToolResult(value: unknown): value is P.ToolResult {
  return (
    value !== null &&
    typeof value === "object" &&
    "text" in value &&
    typeof value.text === "string" &&
    "failed" in value &&
    typeof value.failed === "boolean"
  );
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function rpcPayload(value: unknown): P.Rpc {
  const payload = object(value);
  if (payload["jsonrpc"] !== "2.0" || typeof payload["method"] !== "string")
    fail("INVALID_RPC", "Expected one JSON-RPC 2.0 request or notification");
  return payload as P.Rpc;
}
function replyEnvelope(value: unknown, payload: P.Rpc): value is P.Reply {
  const reply = object(value);
  return (
    !!value &&
    !Array.isArray(value) &&
    reply["jsonrpc"] === "2.0" &&
    reply["id"] === payload.id &&
    Object.hasOwn(reply, "result") !== Object.hasOwn(reply, "error")
  );
}
function decodeRequest(value: unknown): asserts value is P.Request {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_REQUEST", "Request object required");
  const request = value as Record<string, unknown>;
  if (
    typeof request["requestId"] !== "string" ||
    !["command", "rpc"].includes(String(request["kind"]))
  )
    fail("INVALID_REQUEST", "Request identity and supported kind required");
  if (typeof request["timeoutMs"] !== "number")
    fail("INVALID_TIMEOUT", "Execution timeout must be 1..2147483647 ms");
  for (const key of [
    "backend",
    "protocolVersion",
    "sessionId",
    "buildHash",
    "cwd",
    "description",
    "ownerToken",
  ])
    if (request[key] !== undefined && typeof request[key] !== "string")
      fail("INVALID_REQUEST", "Request string field has an invalid type");
  for (const key of ["queueTimeoutMs", "expectedRevision"])
    if (request[key] !== undefined && typeof request[key] !== "number")
      fail("INVALID_REQUEST", "Request numeric field has an invalid type");
  if (request["phased"] !== undefined && typeof request["phased"] !== "boolean")
    fail("INVALID_REQUEST", "phased must be boolean");
  const argv = request["argv"];
  if (
    argv !== undefined &&
    (!Array.isArray(argv) ||
      argv.some((item: unknown) => typeof item !== "string"))
  )
    fail("INVALID_REQUEST", "Command argv must be an array of strings");
  for (const key of ["payload", "rpc", "sequence", "clientContext"]) {
    const field = request[key];
    if (
      field !== undefined &&
      (!field || typeof field !== "object" || Array.isArray(field))
    )
      fail("INVALID_REQUEST", "Request data must be an object");
  }
  const payload = object(request["payload"]);
  for (const key of ["method", "jsonrpc", "kind", "operation"])
    if (payload[key] !== undefined && typeof payload[key] !== "string")
      fail("INVALID_REQUEST", "Payload identity must be a string");
  const rpc = object(request["rpc"]);
  if (rpc["sessionId"] !== undefined && typeof rpc["sessionId"] !== "string")
    fail("INVALID_REQUEST", "RPC session must be a string");
  const sequence = object(request["sequence"]);
  if (
    request["sequence"] !== undefined &&
    (!["begin", "continue", "end"].includes(String(sequence["action"])) ||
      (sequence["id"] !== undefined && typeof sequence["id"] !== "string") ||
      (sequence["mode"] !== undefined &&
        !["automatic", "exclusive"].includes(String(sequence["mode"]))))
  )
    fail("INVALID_REQUEST", "Invalid sequence");
  const inputs = request["inputFiles"];
  if (
    inputs !== undefined &&
    (!Array.isArray(inputs) ||
      inputs.some(
        (item: unknown) =>
          typeof object(item)["path"] !== "string" ||
          !/^[a-f0-9]{64}$/.test(String(object(item)["sha256"])),
      ))
  )
    fail(
      "INVALID_INPUT_FILES",
      "Input files require path and lowercase SHA256",
    );
}
export function assertResetSubmissionOpen(dir: string) {
  try {
    readJson(path.join(dir, "fusion-reset.lock"));
    fail(
      "FUSION_RESET_IN_PROGRESS",
      "A guarded Fusion reset is in progress; retry only after broker readiness is restored.",
    );
  } catch (cause) {
    const error = errorInfo(cause);
    if (error.code !== "ENOENT") throw error;
  }
}

function persistentReference(name: string | undefined, args: P.ToolArguments) {
  // Script source may legitimately contain literal "$ref" dictionaries or
  // dollar-prefixed text. Only RPC argument data can reference server objects.
  const data = { ...args };
  if (name === "execute_python" && typeof data.code === "string")
    delete data.code;
  if (
    name === "fusion_mcp_execute" &&
    data.featureType === "script" &&
    data.object &&
    typeof data.object.script === "string"
  ) {
    data.object = { ...data.object };
    delete data.object.script;
  }
  return /"\$[^"\n]*"/.test(JSON.stringify(data));
}

function isolatedTool(name: string | undefined, args: P.ToolArguments = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    fail("INVALID_REQUEST", "Tool arguments must be a JSON object");
  if (
    args.remember_as !== undefined ||
    persistentReference(name, args) ||
    ["call_autodesk_api", "get_active_selection"].includes(name ?? "")
  ) {
    fail(
      "unsupported_queue_route",
      "Persistent API object references cannot be isolated between queued clients",
    );
  }
  if (
    name === "execute_python" &&
    (args.persistent !== false || args.session_id !== undefined)
  ) {
    fail(
      "unsupported_queue_route",
      "Queued Python requires persistent:false without a shared session_id",
    );
  }
}

function validateRaw(payload: P.Rpc) {
  if (
    !payload ||
    payload.jsonrpc !== "2.0" ||
    typeof payload.method !== "string" ||
    (own(payload, "id") && !["string", "number"].includes(typeof payload.id))
  )
    fail("INVALID_RPC", "Expected one JSON-RPC 2.0 request or notification");
  if (
    ![
      "initialize",
      "notifications/initialized",
      "ping",
      "tools/list",
      "tools/call",
      "resources/list",
      "resources/templates/list",
    ].includes(payload.method)
  ) {
    fail("unsupported_queue_route", "Unsupported raw JSON-RPC route");
  }
  if (!own(payload, "id") && payload.method !== "notifications/initialized")
    fail(
      "unsupported_queue_route",
      "Only the initialized notification has supported completion semantics",
    );
  if (payload.method !== "tools/call") return;
  if (!own(payload, "id"))
    fail(
      "unsupported_queue_route",
      "Tool notifications cannot prove completion",
    );
  const name = payload.params?.name;
  const args = payload.params?.arguments || {};
  isolatedTool(name, args);
  if (
    name === "fusion_mcp_execute" &&
    !["script", "document"].includes(args.featureType ?? "")
  )
    fail(
      "unsupported_queue_route",
      "Raw execute feature has unsupported completion semantics",
    );
  if (name === "execute_python") {
    if (args.persistent !== false || args.session_id !== undefined)
      fail(
        "unsupported_queue_route",
        "Raw Python requires persistent:false without a shared session_id",
      );
  } else if (
    ![
      "fusion_mcp_execute",
      "fusion_mcp_read",
      "fetch_api_documentation",
      "fetch_design_guide",
      "capture_viewport",
      "get_viewport",
    ].includes(name ?? "")
  ) {
    fail(
      "unsupported_queue_route",
      "Raw tools with global references or unknown background semantics are unsupported",
    );
  }
  if (args.remember_as !== undefined || persistentReference(name, args))
    fail(
      "unsupported_queue_route",
      "Remembered objects/global references are unsupported",
    );
  const code =
    name === "execute_python"
      ? args.code
      : args.featureType === "script"
        ? args.object?.script
        : null;
  if (
    (name === "execute_python" || args.featureType === "script") &&
    (typeof code !== "string" || !code.trim())
  )
    fail("INVALID_SCRIPT", "Raw script source must be a nonempty string");
  if (
    code &&
    /\b(threading|asyncio|subprocess|multiprocessing|executeTextCommand|registerCustomEvent|addCustomEvent)\b/.test(
      code,
    )
  ) {
    fail(
      "unsupported_queue_route",
      "Background/native UI raw scripts require an existing workflow receipt and are unsupported here",
    );
  }
}

export function matching(
  client: Pick<P.Client, "_parse">,
  response: P.Response | undefined,
  payload: P.Rpc,
) {
  if (
    !response ||
    !Number.isInteger(response.status) ||
    response.status < 200 ||
    response.status >= 300
  )
    fail("UNKNOWN_RPC", "Invalid HTTP response; outcome unknown");
  if (!own(payload, "id")) {
    if (payload.method !== "notifications/initialized")
      fail("UNKNOWN_RPC", "Unacknowledged notification");
    return null;
  }
  const reply = client._parse(response.raw);
  if (!replyEnvelope(reply, payload))
    fail("UNKNOWN_RPC", "Missing/mismatched JSON-RPC reply; outcome unknown");
  if (
    reply.error &&
    (typeof reply.error !== "object" ||
      typeof object(reply.error)["message"] !== "string")
  )
    fail("UNKNOWN_RPC", "Malformed JSON-RPC error");
  return reply;
}

const { responseForCaller, decodeBoundPublicPythonResponse, verifyBoundRemoteReceipt,
} =
  runtimeRequire("./dist/composition/queue-public-python-result",
) as
    typeof import("./queue-public-python-result");

function privateDirectory(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  )
    fail(
      "UNSAFE_DIRECTORY",
      "Queue directory must be a real directory owned by this user",
    );
  fs.chmodSync(dir, 0o700);
  return fs.realpathSync(dir);
}

function commandEntry(argv: string[]) {
  const { rest } = load("./cli").parseFlags(argv);
  return load("./commands").findCommand(rest);
}

function hasRuntimeRootEvidence(directory: string): boolean {
  return (runtimeRequire("./dist/node-adapters/execution/physical-generation-profile") as
    typeof import("../../packages/node-adapters/src/execution/physical-generation-profile"))
    .hasRuntimeRootEvidence(directory);
}
export async function serve(cfg: P.Config, options: P.Options = {}) {
  let runtimeRootWiring:
    import("../queue-runtime-physical-wiring").RuntimeRootPhysicalWiring | undefined;
  let verifyRuntimeRootBeforeRestore:
    ((context: import("../queue-runtime-physical-wiring").RuntimeRootVerificationContext) =>
      Promise<import("../queue-runtime-physical-wiring").ApprovedRuntimeRoot | undefined>) | undefined;
  if (process.env["FMCAD_PHYSICAL_OPERATOR_PROFILE"] !== undefined) {
    if ([
      options.bindPhysicalTurn,
      options.withPhysicalTurn,
      options.physicalTurnQuiescence,
      options.authorizePhysicalRequest,
      options.preparePhysicalGeneration,
    ].some((value) => value !== undefined))
      fail(
        "PHYSICAL_CAPABILITY_CONFLICT",
        "Private operator profile cannot be combined with injected physical capabilities",
      );
    const physical = load(
      "./dist/node-adapters/execution/physical-generation-profile",
    ).physicalBrokerPortsFromEnvironment<import("../queue-runtime-physical-wiring").ApprovedRuntimeRoot>(
      process.env,
      hasRuntimeRootEvidence(path.resolve(options.dir || queueDirectory()))
        ? {
            runtimeRootFactory(profile) {
              const { createRuntimeRootPhysicalWiring } = runtimeRequire(
                "./queue-runtime-physical-wiring",
              ) as typeof import("../queue-runtime-physical-wiring");
              runtimeRootWiring = createRuntimeRootPhysicalWiring(profile);
              return runtimeRootWiring;
            },
          }
        : {},
    );
    if (!physical)
      fail("PHYSICAL_CAPABILITY_REQUIRED", "Private physical capabilities are unavailable");
    verifyRuntimeRootBeforeRestore = physical.verifyRuntimeRootBeforeRestore;
    options = {
      ...options,
      preparePhysicalGeneration: physical.preparePhysicalGeneration,
      authorizePhysicalRequest: physical.authorizePhysicalRequest,
      bindPhysicalTurn: (request) => physical.bindPhysicalTurn({
        physicalRequestId: request.physicalRequestId,
        ...(request.documentSelector === undefined
          ? {} : { documentSelector: request.documentSelector }),
        ...(request.kind === undefined ? {} : { kind: request.kind }),
        ...(request.brokerNonce === undefined
          ? {} : { brokerNonce: request.brokerNonce }),
      }),
      withPhysicalTurn: physical.withPhysicalTurn,
      physicalTurnQuiescence: physical.physicalTurnQuiescence,
    };
  }
  const physicalIsolation = [
    options.bindPhysicalTurn,
    options.withPhysicalTurn,
    options.physicalTurnQuiescence,
    options.authorizePhysicalRequest,
    options.preparePhysicalGeneration,
  ].some((value) => value !== undefined);
  if (
    physicalIsolation &&
    ![
      options.bindPhysicalTurn,
      options.withPhysicalTurn,
      options.physicalTurnQuiescence,
    ].every((value) => typeof value === "function")
  )
    fail(
      "PHYSICAL_CAPABILITY_INCOMPLETE",
      "Physical isolation requires binder, dispatch scope and quiescence capability",
    );
  if (options.nativePath && !options.createBackend)
    fail(
      "INVALID_BACKEND",
      "Native path injection requires an explicit physical test adapter",
    );
  const nativePaths = options.nativePath ? { mapPath: options.nativePath } : {};
  if (options.confirmOwnership !== true)
    fail(
      "OWNERSHIP_REQUIRED",
      "Explicit Fusion ownership confirmation is required before starting the broker",
    );
  if (cfg?.routing === "direct")
    fail(
      "UNSUPPORTED_ROUTING",
      "routing=direct is no longer supported; start the shared fmcad broker with routing=queue",
    );
  assertAutodeskFusionBackend(cfg);
  cfg = { ...cfg, backend: cfg.backend ?? "addin" };
  const admissionCurlPath = cfg["curlPath"];
  if (admissionCurlPath !== undefined && typeof admissionCurlPath !== "string")
    fail("INVALID_CONFIG", "Admission curlPath must be a string when provided");
  const metadataAdmission = provisionAddinMetadata(
    options.addinMetadataAdmission,
    cfg.backend,
    createAddinAdmission,
    { transport: cfg.transport, curlPath: admissionCurlPath },
    options.authorizePhysicalRequest,
  );
  if (!options.createBackend)
    assertPlatformCapability(detectPlatform(), "fusion");
  const dir = privateDirectory(path.resolve(options.dir || queueDirectory()));
  // Endpoint spelling is not a lock domain. Production always uses the one user-global directory.
  if (
    !options.createBackend &&
    dir !== privateDirectory(path.resolve(queueDirectory()))
  )
    fail(
      "QUEUE_DIRECTORY_MISMATCH",
      "Production brokers must use the user-global queueDirectory()",
    );
  const resetFile = path.join(dir, "fusion-reset.lock");
  let resetMarker: P.ResetMarker | null = null;
  try {
    resetMarker = readJson(resetFile);
  } catch (cause) {
    const error = errorInfo(cause);
    if (error.code !== "ENOENT") throw error;
  }
  const resetNonce =
    options.fusionResetNonce || process.env["FMCAD_FUSION_RESET_NONCE"];
  // Scope the reset owner's single read-only restore probe; never reopen normal
  // submissions while the durable reset marker exists.
  const resetResumeScope = new AsyncLocalStorage<P.ResetProof>();
  if (
    (resetMarker && resetMarker.nonce !== resetNonce) ||
    (resetNonce && (!resetMarker || resetMarker.nonce !== resetNonce))
  ) {
    fail(
      "FUSION_RESET_IN_PROGRESS",
      "A guarded Fusion reset owns the broker directory; no broker was started.",
    );
  }
  if (
    fs.existsSync(path.join(dir, "recovery.lock")) &&
    !options.atomicMigrationNonce &&
    !options.epochRuntimeUpgradeNonce &&
    !options.deadEpochSuccessorNonce
  )
    fail("RECOVERY_IN_PROGRESS", "Explicit broker recovery is incomplete");
  const codeHash = buildHash();
  const observationScopeConfig =
    options.createBackend && options.testAtomicWorkflowScope
      ? options.testAtomicWorkflowScope
      : fastenersScope;
  const pinned: P.Config = JSON.parse(JSON.stringify(cfg)) as P.Config;
  const preparationConcurrency = (
    runtimeRequire("./dist/node-adapters/execution/phased-workers") as Pick<
      typeof import("../../packages/node-adapters/src/execution/phased-workers"),
      "resolvePreparationConcurrency"
    >
  ).resolvePreparationConcurrency(
    (pinned["queue"] as { preparationConcurrency?: unknown } | undefined)
      ?.preparationConcurrency,
  );
  const configHash = brokerConfigHash(pinned);
  // A consumed native root has its own authority. Verify it before touching any
  // legacy selector or restoring jobs; marker presence alone is never approval.
  const approvedRuntimeRoot = await verifyRuntimeRootBeforeRestore?.({
    directory: dir, buildHash: codeHash, configHash,
  });
  if (!approvedRuntimeRoot && hasRuntimeRootEvidence(dir))
    fail("RUNTIME_ROOT_AUTHORITY_REQUIRED", "Use the private native-authenticated runtime-root startup");
  if (approvedRuntimeRoot &&
    [options.backendTransition, options.atomicMigrationNonce,
      options.epochRuntimeUpgradeNonce, options.deadEpochSuccessorNonce].some(
      (value) => value !== undefined,
    ))
    fail("PHYSICAL_CAPABILITY_CONFLICT", "Native runtime-root startup cannot also claim a legacy transition");
  const backendScope = approvedRuntimeRoot
    ? { current: undefined, retired: undefined }
    : resolveBackendHead(dir, () => openIsolatedEpoch(dir, { recover: false }));
  const effectiveBackend = backendScope.current;
  let identityFile =
    approvedRuntimeRoot ? path.join(dir, "runtime-rebaseline-current-instance.json")
      : backendScope.retired?.identityFile || path.join(dir, "instance.json");
  let oldIdentity = fs.existsSync(identityFile)
    ? readJson<P.Identity>(identityFile)
    : null;
  // A known local configuration rejection must not reserve Fusion or leave a
  // dead marker that prevents the correctly configured backend from starting.
  if (
    !options.backendTransition &&
    (effectiveBackend?.identity || oldIdentity)?.configHash !== configHash &&
    oldIdentity
  )
    fail(
      "CONFIG_CHANGED",
      "Pinned backend configuration differs from the durable broker identity",
    );
  const restartPort = runtimeRequire(
    "./dist/node-adapters/broker-ipc/normal-restart",
  ) as typeof import("../../packages/node-adapters/src/broker-ipc/normal-restart");
  function deadPredecessorProof(
    current: P.State,
    sourceFile: string,
  ): import("../queue-backend-transition").DeadPredecessorProof | undefined {
    if (!options.backendTransition || !current.epoch) return undefined;
    const sourceIdentity = readJson<P.Identity>(sourceFile);
    if (priorProcessAlive(sourceIdentity.instance) !== false) return undefined;
    const stopRequestId = options.backendTransition.stopRequestId;
    if (!stopRequestId)
      fail(
        "BACKEND_TRANSITION_UNPROVEN",
        "A dead SDK transition requires the exact completed owner stop request",
      );
    const proof = restartPort.inspectSettledNormalRestart(
      dir,
      current.epoch,
      sourceIdentity,
      current.data,
      { priorProcessAlive },
      stopRequestId,
      sourceFile,
    );
    if (!proof?.deadPredecessorRecord)
      fail(
        "BACKEND_TRANSITION_UNPROVEN",
        "Settled owner-stop evidence for this exact dead SDK is required",
      );
    return {
      identity: sourceIdentity,
      references: proof.evidence,
      record: proof.deadPredecessorRecord,
      assertValid: () =>
        restartPort.assertSettledNormalRestartPredecessor(proof, current.data, {
          priorProcessAlive,
        }),
    };
  }
  function runtimeUpgradeProof(
    current: P.State,
    sourceFile: string,
  ): import("../queue-backend-transition").DeadPredecessorProof | undefined {
    const approval = options.backendTransition;
    if (
      !approval ||
      approval.previousConfig.backend !== approval.nextConfig.backend
    )
      return undefined;
    if (
      !effectiveBackend ||
      !current.epoch ||
      !approval.stopRequestId ||
      approval.nextBuildHash !== codeHash ||
      codeHash === effectiveBackend.identity.buildHash
    )
      fail(
        "BACKEND_TRANSITION_UNPROVEN",
        "Same-backend runtime upgrade requires the active head, owner stop and exact distinct target build",
      );
    const sourceIdentity = readJson<P.Identity>(sourceFile);
    if (!same(sourceIdentity, effectiveBackend.identity))
      fail(
        "BACKEND_TRANSITION_CHANGED",
        "Runtime upgrade source differs from the verified backend head",
      );
    const proof = restartPort.inspectSettledRuntimeUpgrade(
      dir,
      current.epoch,
      sourceIdentity,
      current.data,
      { priorProcessAlive },
      approval.stopRequestId,
      sourceFile,
      {
        path: path.join(path.dirname(sourceFile), "transition.json"),
        sha256: hash(
          fs.readFileSync(
            path.join(path.dirname(sourceFile), "transition.json"),
          ),
        ),
      },
    );
    if (!proof?.runtimeUpgradeRecord)
      fail(
        "BACKEND_TRANSITION_UNPROVEN",
        "Runtime upgrade requires settled work and a proven stopped owner",
      );
    return {
      identity: sourceIdentity,
      references: proof.evidence,
      record: proof.runtimeUpgradeRecord,
      assertValid: () =>
        restartPort.assertSettledNormalRestartPredecessor(proof, current.data, {
          priorProcessAlive,
        }),
    };
  }
  if (options.backendTransition) {
    const preflightState = openIsolatedEpoch(dir, { recover: false });
    const preflightIdentityFile =
      backendScope.current?.identityFile ||
      backendScope.retired?.identityFile ||
      (preflightState.epoch
        ? path.join(preflightState.epoch.root, "instance.json")
        : path.join(dir, "instance.json"));
    prepareBackendTransition(
      dir,
      preflightState,
      pinned,
      options.backendTransition,
      deadPredecessorProof(preflightState, preflightIdentityFile),
      runtimeUpgradeProof(preflightState, preflightIdentityFile),
    );
  }
  function assertBackendHeadOwner(
    current: P.State,
    permittedBuildHash = codeHash,
  ) {
    if (approvedRuntimeRoot) {
      if (!runtimeRootWiring || current.admissionMode !== "runtime-rebaseline")
        fail("RUNTIME_ROOT_AUTHORITY_REQUIRED", "Native runtime-root state is required");
      runtimeRootWiring.assertVerifiedRoot(dir);
      return;
    }
    const currentScope = resolveBackendHead(dir, () => current);
    if (
      !same(currentScope.current?.head, effectiveBackend?.head) ||
      !same(currentScope.retired, backendScope.retired)
    )
      fail(
        "BACKEND_TRANSITION_CHANGED",
        "Physical backend head changed before startup",
      );
    if (
      effectiveBackend &&
      (!current.epoch ||
        current.epoch.epochId !== effectiveBackend.head.epochId ||
        current.epoch.ownerClientId !== effectiveBackend.head.ownerClientId ||
        current.epoch.ownerTokenHash !== effectiveBackend.head.ownerTokenHash)
    )
      fail(
        "BACKEND_TRANSITION_CHANGED",
        "Backend transition no longer belongs to the exact active epoch owner",
      );
    if (
      effectiveBackend &&
      !options.backendTransition &&
      effectiveBackend.identity.buildHash !== permittedBuildHash
    )
      fail(
        "BUILD_CHANGED",
        "Restore the exact physical backend transition runtime before reopening",
      );
  }
  if (effectiveBackend)
    // Only the following authenticated claim can grant the successor runtime.
    // An untrusted nonce gets no physical client or executable capability here.
    assertBackendHeadOwner(
      openIsolatedEpoch(dir, { recover: false }),
      options.deadEpochSuccessorNonce
        ? effectiveBackend.identity.buildHash
        : codeHash,
    );
  if (!approvedRuntimeRoot)
  (runtimeRequire("./dist/composition/queue-frozen-metadata-admission",
    ) as
    typeof import("./queue-frozen-metadata-admission")).assertFrozenMetadataReopen(
    dir, options.addinMetadataAdmission, options.deadEpochSuccessorNonce,
  );
  const socket = queueSocket(dir);
  const startupClaims: {
    successorRuntime: ReturnType<
      BrokerModules["./queue-epoch-successor"]["claimSuccessorBroker"]
    > | null;
    migrationSnapshotHash: string | null;
  } = { successorRuntime: null, migrationSnapshotHash: null };
  let disposeClient = () => {};
  const lifetime = claimBrokerLifetime({
    dir,
    socket,
    buildHash: codeHash,
    configHash,
    processBirth,
    disposeClient: () => disposeClient(),
    claimAuthorizedOwner(marker) {
      const successor = options.deadEpochSuccessorNonce
        ? load("./queue-epoch-successor").claimSuccessorBroker(
            dir,
            marker,
            options.deadEpochSuccessorNonce,
            codeHash,
            pinned,
          )
        : null;
      startupClaims.successorRuntime = successor;
      startupClaims.migrationSnapshotHash = options.atomicMigrationNonce
        ? load("./queue-atomic-migration-runtime").claimMigratedBroker(
            dir,
            marker,
            options.atomicMigrationNonce,
            codeHash,
            observationScopeConfig,
          )
        : options.epochRuntimeUpgradeNonce
          ? load("./queue-epoch-runtime-upgrade").claimEpochRuntimeBroker(
              dir,
              marker,
              options.epochRuntimeUpgradeNonce,
              codeHash,
            )
          : (successor?.authority.predecessor.rootState.sha256 ?? null);
      return !!startupClaims.migrationSnapshotHash;
    },
  });
  const { owner: marker, lock, close } = lifetime;
  let physicalGrantState: "not_attempted" | "unknown" | "issued" = "not_attempted";
  try {
  async function preparePhysicalGeneration() {
    lifetime.assertOwner();
    if (options.preparePhysicalGeneration) {
      lifetime.beginPhysicalProvisioning();
      physicalGrantState = "unknown";
    }
    try {
    await options.preparePhysicalGeneration?.({
      directory: dir, owner: marker, buildHash: codeHash, configHash,
      assertBrokerOwner: lifetime.assertOwner,
    });
    } catch (error) {
      const detail = errorInfo(error);
      const issuance = object(error)["grantIssuance"];
      if (issuance !== "unknown" &&
        (detail.notStarted === true || issuance === "notStarted"))
        physicalGrantState = "not_attempted";
      throw error;
    }
    if (options.preparePhysicalGeneration) physicalGrantState = "issued";
    lifetime.assertOwner();
  }
  if (!approvedRuntimeRoot) await preparePhysicalGeneration();
  const { successorRuntime, migrationSnapshotHash } = startupClaims;
  const executionRecords = createBrokerRecords(dir);
  const currentAuditScopeFile = path.join(
    dir,
    `current-audit-instance-${marker.nonce}.json`,
  );
  const currentAuditScope = fs.existsSync(currentAuditScopeFile)
    ? readJson<P.AuditScope>(currentAuditScopeFile)
    : null;
  const phaseTimings = load(
    "./dist/node-adapters/telemetry/phase-timings",
  ).createPhaseTimingProducer();
  const measuredStateOptions = {
    ...options.stateOptions,
    physicalCatalogDirectory: dir,
    onCommittedSnapshot: phaseTimings.queueCommitted,
  };
   let state: P.State;
   try {
   state = approvedRuntimeRoot
     ? (runtimeRequire("./queue-runtime-root-state") as typeof import("../queue-runtime-root-state"))
       .openRuntimeRootState({
         root: approvedRuntimeRoot,
         assertVerifiedRoot(directory) {
           if (!runtimeRootWiring)
             fail("RUNTIME_ROOT_AUTHORITY_REQUIRED", "Native runtime-root authority is missing");
           runtimeRootWiring.assertVerifiedRoot(directory);
         },
         assertBrokerOwner: lifetime.assertOwner,
         assertNativeModelGrant(clientId, tokenHash) {
           if (clientHashes()[clientId] !== tokenHash)
             fail("NOT_AUTHORIZED", "The runtime-root principal is no longer registered");
           currentCheckpointGeneration();
         },
         stateOptions: measuredStateOptions,
       }) as unknown as P.State
     : openIsolatedEpoch(
    dir,
    migrationSnapshotHash
      ? {
          ...measuredStateOptions,
          recover: false,
          expectedSnapshotHash: migrationSnapshotHash,
        }
      : measuredStateOptions,
   );
   } catch (error) {
     throw error;
   }
   // Project the authenticated existing snapshot under the real writer claim
   // before issuing a new physical grant or admitting any client operation.
   if (approvedRuntimeRoot) await preparePhysicalGeneration();
  function assertPhysicalIsolationAuthority() {
    if (!physicalIsolation && Object.keys(state.data.quarantined ?? {}).length)
      fail("PHYSICAL_CAPABILITY_REQUIRED",
        "Persisted quarantine permits only historical inspection without current physical capabilities");
  }
  try {
    assertPhysicalIsolationAuthority();
  } catch (error) {
    throw error;
  }
  const metadataSuccessorAuthority = successorRuntime?.authority ??
    (state.epoch?.succession
      ? (runtimeRequire("./queue-epoch-lineage",
          ) as typeof import("../queue-epoch-lineage"))
        .successionAuthority(dir, state.epoch.succession).authority
      : undefined);
  const frozenMetadataScope = metadataSuccessorAuthority && "frozenMetadata" in metadataSuccessorAuthority
    ? metadataSuccessorAuthority.frozenMetadata : undefined;
  if (frozenMetadataScope !== undefined)
    (runtimeRequire("./dist/composition/queue-frozen-metadata-admission",
      ) as
      typeof import("./queue-frozen-metadata-admission")).assertFrozenMetadataProvisioning(
      frozenMetadataScope, options.addinMetadataAdmission,
    );
  const frozenMetadataAuthority = successorRuntime?.authorityEntry ?? state.epoch?.succession;
  function admitEpochRequest(request: P.Request | undefined) {
    if (approvedRuntimeRoot) {
      const { admitRuntimeRootRequest } = runtimeRequire(
        "./queue-runtime-root-state",
      ) as typeof import("../queue-runtime-root-state");
      if (!admitRuntimeRootRequest(state, request, clientHashes()))
        fail("RUNTIME_ROOT_AUTHORITY_REQUIRED", "An explicit native runtime-root model grant is required");
      return null;
    }
    if (!state.epoch) return null;
    if (frozenMetadataScope === undefined)
      return epochAdmission(state, request, clientHashes());
    if (!request || !frozenMetadataAuthority)
      fail("FROZEN_METADATA_DOCUMENT_UNPROVEN", "A bound fresh fixture request is required",
      );
    const admission = runtimeRequire("./dist/composition/queue-frozen-metadata-admission",
    ) as
      typeof import("./queue-frozen-metadata-admission");
    if (request.kind === "command") {
      admission.proveFrozenFirstSave(dir, frozenMetadataAuthority, request);
      return epochAdmission(state, request, clientHashes());
    }
    const wire = rpcPayload(request.rpc?.payload || request.payload);
    (runtimeRequire("./dist/composition/queue-frozen-metadata-profile",
      ) as
      typeof import("./queue-frozen-metadata-profile")).assertFrozenMetadataRequest(
      frozenMetadataScope, {
        clientId: request.clientId, requestId: request.requestId, kind: request.kind,
        metadata: isAddinMetadata(wire),
      });
    const selector = addinMetadataSelector(wire);
    admission.proveFrozenMetadataDocument(dir, frozenMetadataAuthority, {
      clientId: request.clientId, clientTokenHash: required(clientHashes()[request.clientId]),
      requestId: request.requestId, fileId: selector.fileId, version: selector.version,
    });
    return null;
  }
  function assertFrozenMetadataObservation(request: P.Request, wire: P.Rpc, observed: P.Instance,
  ) {
    if (frozenMetadataScope === undefined) return;
    if (!frozenMetadataAuthority)
      fail("FROZEN_METADATA_DOCUMENT_UNPROVEN", "The original metadata authority is required",
      );
    const selector = addinMetadataSelector(wire);
    (runtimeRequire("./dist/composition/queue-frozen-metadata-admission",
      ) as
      typeof import("./queue-frozen-metadata-admission")).assertFrozenMetadataProvisioning(
      frozenMetadataScope, options.addinMetadataAdmission,
    );
    (runtimeRequire("./dist/composition/queue-frozen-metadata-admission",
      ) as
      typeof import("./queue-frozen-metadata-admission")).proveFrozenMetadataDocument(
      dir, frozenMetadataAuthority, {
        clientId: request.clientId, clientTokenHash: required(clientHashes()[request.clientId]),
        requestId: request.requestId, fileId: selector.fileId, version: selector.version,
      }, observed,
    );
  }
  phaseTimings.queueCommitted(state.data, state.epoch?.root ?? dir);
  if (state.epoch) identityFile = path.join(state.epoch.root, "instance.json");
  if (successorRuntime?.effectiveIdentity) {
    const expectedIdentity =
      effectiveBackend?.identity || readJson<P.Identity>(identityFile);
    if (
      successorRuntime.effectiveIdentity.buildHash !==
        expectedIdentity.buildHash ||
      successorRuntime.effectiveIdentity.configHash !==
        expectedIdentity.configHash ||
      !sameInstance(
        successorRuntime.effectiveIdentity.instance,
        expectedIdentity.instance,
      )
    )
      fail(
        "BACKEND_TRANSITION_CHANGED",
        "Successor claim differs from the verified predecessor identity",
      );
  }
  assertBackendHeadOwner(
    state,
    successorRuntime?.effectiveIdentity?.buildHash ?? codeHash,
  );
  if (effectiveBackend) {
    identityFile = effectiveBackend.identityFile;
  }
  // Metadata-only preflight happens before constructing a physical client. A
  // foreign owner, altered config or unfinished current job sends zero SDK work.
  const deadPredecessor = options.backendTransition
    ? deadPredecessorProof(state, identityFile)
    : undefined;
  const backendTransition = options.backendTransition
    ? prepareBackendTransition(
        dir,
        state,
        pinned,
        options.backendTransition,
        deadPredecessor,
        runtimeUpgradeProof(state, identityFile),
      )
    : null;
  if (options.startPaused === true)
    state.pause(true, "startup:" + marker.nonce);
  const gate = new QueueGate(state, marker.nonce);
  if (
    !state.epoch &&
    !migrationSnapshotHash &&
    state.data.blocked &&
    oldIdentity
  ) {
    const directory = path.join(dir, "jobs", required(state.data.active));
    const evidence = load("./queue-preflight").legacyBusyEvidence(
      state.data,
      oldIdentity.instance,
      oldIdentity.buildHash,
      directory,
    );
    if (evidence) {
      // Preserve the original files and owner/request. Publish a labelled derived
      // resolution; never invent preflight.json or a remote SDK receipt.
      durable(
        path.join(directory, "legacy-preflight-busy-evidence.json"),
        evidence,
      );
      const outcome = {
        state: "failed",
        code: "FUSION_BUSY",
        executionOutcome: "not_started",
        userScriptSubmitted: false,
        mayHaveMutated: false,
        source: evidence.method,
      };
      state.resolve(evidence.jobId, outcome);
      durable(path.join(directory, "outcome.json"), outcome);
    }
  }
  // The public backend factory may route ordinary callers into this queue. The
  // broker alone constructs the physical client, so routing cannot recurse.
  const factory =
    options.createBackend ||
    ((server) => {
      return load("./dist/fusion-transport/broker").createBrokerTransport(
        server,
        {
          version: load("../package.json").version,
          requestTimeout: load("./request-timeout").requestTimeout,
          bridgeSource: load("./addin-bridge").addinBridgeSource,
          ...(options.authorizePhysicalRequest
            ? { authorizePhysicalRequest: options.authorizePhysicalRequest } : {}),
        },
      );
    });
  const client = factory(pinned);
  disposeClient = () => client.reqOpts?.agent?.destroy();
  if (
    !client.server ||
    typeof client._post !== "function" ||
    typeof client._parse !== "function"
  )
    fail(
      "INVALID_BACKEND",
      "Backend must expose server and the physical McpClient _post/_parse boundary",
    );
  const originalPost = client._post.bind(client);
  const runtime = resolveRuntimePaths({ anchor: runtimeAnchor }).runtime;
  const queueAdmission = createProductionQueueAdmission(runtime);
  const pythonAdmission = queueAdmission.admission;
  let initializing = true;
  function resetResumeProof(
    nonce: string | undefined,
    clientId: string,
    fence: BrokerControlFence,
  ): P.ResetProof | undefined {
    let marker: P.ResetMarker;
    try {
      marker = readJson<P.ResetMarker>(resetFile);
    } catch (cause) {
      const error = errorInfo(cause);
      if (error.code === "ENOENT") return undefined;
      fail(
        "FUSION_RESET_IN_PROGRESS",
        "The reset owner marker is unavailable; resume remains fenced.",
      );
    }
    const pause = marker.resetPause;
    if (
      !nonce ||
      marker.protocol !== 1 ||
      marker.nonce !== nonce ||
      marker.buildHash !== codeHash ||
      !Number.isSafeInteger(marker.pid) ||
      marker.pid <= 0 ||
      typeof marker.birth !== "string" ||
      !pause ||
      typeof pause !== "object" ||
      typeof pause.requestId !== "string" ||
      !identifier(pause.requestId) ||
      pause.instanceId !== fence.instanceId ||
      pause.generation !== fence.expectedGeneration
    ) {
      fail(
        "FUSION_RESET_IN_PROGRESS",
        "Only the reset owner may restore its exact confirmed broker pause.",
      );
    }
    let ownerAlive;
    try {
      ownerAlive = processBirth(marker.pid) === marker.birth;
    } catch (cause) {
      const error = errorInfo(cause);
      if (["ENOENT", "ESRCH"].includes(error.code ?? "")) ownerAlive = false;
      else throw error;
    }
    const pauseReceipt = state.data.controlRequests?.[pause.requestId];
    const nonterminal = Object.values(state.data.jobs || {}).some(
      (job) =>
        !["succeeded", "failed", "cancelled", "expired"].includes(job.state),
    );
    const pauseFile = path.join(
      dir,
      "lifecycle-control-" + hash(pause.requestId) + ".json",
    );
    let pauseIntent: P.PauseIntent | undefined;
    try {
      pauseIntent = readJson<P.PauseIntent>(pauseFile);
    } catch {
      /* Missing durable pause intent is not owner proof. */
    }
    const pauseBinding = pauseIntent?.binding;
    const pauseResult = pauseIntent?.result;
    if (
      !ownerAlive ||
      !state.data.paused ||
      state.data.controlGeneration !== fence.expectedGeneration ||
      pauseReceipt?.paused !== true ||
      pauseReceipt.generation !== fence.expectedGeneration ||
      pauseIntent?.status !== "completed" ||
      pauseBinding?.action !== "pause" ||
      pauseBinding.clientId !== clientId ||
      pauseBinding.requestId !== pause.requestId ||
      pauseBinding.instanceId !== pause.instanceId ||
      pauseBinding.expectedGeneration + 1 !== pause.generation ||
      pauseBinding.buildHash !== codeHash ||
      pauseResult?.instanceId !== pause.instanceId ||
      pauseResult.generation !== pause.generation ||
      pauseResult.phase !== "PAUSED" ||
      pauseResult.activeOperations !== 0 ||
      pauseResult.unresolved !== false
    ) {
      fail(
        "RESET_PAUSE_UNOWNED",
        "The reset-owned pause no longer matches the live queue generation.",
      );
    }
    return {
      nonce,
      clientId,
      pid: marker.pid,
      birth: marker.birth,
      fence: { ...fence },
      nonterminal,
    };
  }
  function authorizeResetResume(
    nonce: string | undefined,
    clientId: string,
    fence: BrokerControlFence,
  ) {
    const proof = resetResumeProof(nonce, clientId, fence);
    if (proof === undefined) return undefined;
    const snapshot = gate.snapshot();
    if (
      gate.adminTransition ||
      gate.resuming ||
      !snapshot.gateClosed ||
      snapshot.phase !== "PAUSED" ||
      snapshot.activeOperations !== 0 ||
      snapshot.unresolved ||
      state.data.active !== null ||
      state.data.blocked ||
      state.data.lease ||
      state.data.controlBlocked ||
      state.data.localUnknown ||
      proof.nonterminal
    ) {
      fail(
        "RESET_RECOVERY_BUSY",
        "Only a clean, idle, reset-owned pause can be restored.",
      );
    }
    return proof;
  }
  function assertResetResumeProbe(scope: P.ResetProof) {
    const current = resetResumeProof(scope.nonce, scope.clientId, scope.fence);
    const snapshot = gate.snapshot();
    // The one active gate turn and controlBlocked receipt belong to this probe.
    // All queue jobs, leases and the original pause remain fenced.
    if (
      !current ||
      current.pid !== scope.pid ||
      current.birth !== scope.birth ||
      current.nonterminal ||
      !state.data.controlBlocked ||
      state.data.controlBlocked.rpcId !== scope.probeRpcId ||
      !state.data.paused ||
      state.data.controlGeneration !== scope.fence.expectedGeneration ||
      state.data.active !== null ||
      state.data.blocked ||
      state.data.localUnknown ||
      state.data.lease ||
      snapshot.instanceId !== scope.fence.instanceId ||
      !snapshot.gateClosed ||
      snapshot.activeOperations !== 1
    ) {
      fail(
        "FUSION_RESET_IN_PROGRESS",
        "The reset owner no longer has the exact idle resume-probe scope.",
      );
    }
  }
  function resetFence() {
    const resetOwner = resetResumeScope.getStore();
    if (resetOwner) {
      assertResetResumeProbe(resetOwner);
      return;
    }
    if (initializing && resetNonce) {
      if (readJson<P.ResetMarker>(resetFile).nonce !== resetNonce)
        fail(
          "FUSION_RESET_IN_PROGRESS",
          "Reset ownership changed before startup probe",
        );
    } else assertResetSubmissionOpen(dir);
  }
  function verifyPreparedJob(
    job:
      (Pick<P.Job, "id"> & Partial<Pick<P.Job, "request">>) | false | undefined,
    expectedContextEpoch: number,
  ) {
    resetFence();
    if ((state.epoch || approvedRuntimeRoot) && job) admitEpochRequest(job.request);
    if (buildHash() !== codeHash)
      fail("BUILD_CHANGED", "Executable changed during local preparation");
    if (job && expectedContextEpoch !== (state.data.contextEpoch || 0))
      fail("DOCUMENT_CHANGED", "Context changed during local preparation");
    for (const input of (job && job.request?.inputFiles) || []) {
      if (
        hash(
          fs.readFileSync(
            path.resolve(
              required(job ? job.request?.cwd : undefined),
              input.path,
            ),
          ),
        ) !== input.sha256
      )
        fail(
          "INPUT_CHANGED",
          "Pinned input changed during offline Python preparation",
        );
    }
  }
  type ProductGrant = BrokerGrant<P.LaneContext>;
  const { quarantineTarget, validRelease, physicalReleaseInput } = runtimeRequire(
    "./dist/core/domain/queue-quarantine",
  ) as typeof import("../../packages/core/src/domain/queue-quarantine");
  let quiescencePending = false;
  let nextQuiescenceCheck = 0;
  const { createBrokerSession } = runtimeRequire(
    "./dist/core/application/broker-session",
  ) as typeof import("../../packages/core/src/application/broker-session");
  const lane = createBrokerLane(createBrokerSession<P.LaneContext>(), {
    durableHoldReason: () =>
      state.data.localUnknown?.reason ?? state.data.blocked?.reason,
    wakeup: () => scheduler.wakeup(),
  });
  const {
    activeWorker: activeContext,
    busy,
    heldReason,
    setControlHold: setHold,
    settle: settleTurn,
  } = lane;
  function finishTurn(
    grant: ProductGrant,
    details: Parameters<typeof state.finish>[1],
  ) {
    settleTurn(grant, () => {
      state.finish(grant.jobId, details);
      continuation.forget(grant.jobId);
      continuationJobs.delete(grant.jobId);
    });
  }
  const physicalGrant = new AsyncLocalStorage<ProductGrant>();
  const probeSendScope = new AsyncLocalStorage<{
    assertCurrent(): void;
    start(): void;
    dispatchBoundary?: P.Send["dispatchBoundary"];
  }>();
  function sendProbe<T>(send: () => T, boundary?: P.Send["dispatchBoundary"]) {
    const scope = probeSendScope.getStore();
    if (!scope) return send();
    if (boundary === "broker-post") {
      scope.assertCurrent();
      return probeSendScope.run({ ...scope, dispatchBoundary: boundary }, send);
    }
    scope.start();
    return send();
  }
  const preparingJob = new AsyncLocalStorage<
    { job: P.Job; turn: TurnIdentity; compiledScope?: Record<string,unknown> } | false
  >();
  const preparingSignal = new AsyncLocalStorage<AbortSignal>();
  function localCheckOptions() {
    const signal = preparingSignal.getStore();
    return signal ? { signal } : {};
  }
  type Flights = { preflight: P.Flight; postflight: P.Flight };
  type OwnedTurn = PreparedTurn<P.PreparedCall>;
  type PostPreparation =
    | { kind: "owned"; turn: OwnedTurn; metadataObservation?: P.Instance | undefined;
      }
    | { kind: "unowned"; checked: P.PreparedPost };
  type LocalPlan = { flights: Flights | null } & (
    | { kind: "raw"; turn: OwnedTurn; callerPayloadHash: string }
    | {
        kind: "worker";
        turn: TurnIdentity;
        message: P.WorkerMessage;
        send: P.Send;
      }
  );
  const localPlans = new Map<string, LocalPlan>();
  type CheckpointActor = import("../document-unlock-admission").UnlockPrincipal;
  type CheckpointTarget = import("../document-unlock-admission").ConfirmedUnlockTarget;
  type CheckpointState = import("../../packages/node-adapters/src/python/cad-script").ParamCheckpointGuardV1;
  type CheckpointReadResult = { jobId: string; checkpoint: CheckpointState };
  const checkpointActor = new AsyncLocalStorage<CheckpointActor>();
  const checkpointViews = new AsyncLocalStorage<{
    states: Map<string, CheckpointState>; justProduced: Set<string>;
    finalChecks: Map<string, (() => void)[]>;
  }>();
  const checkpointIdentity = new AsyncLocalStorage<boolean>();
  const checkpointReads = new Map<string, {
    actor: CheckpointActor; target: CheckpointTarget;
    turn: TurnIdentity; send?: P.Send;
    resolve(value: CheckpointReadResult): void; reject(error: unknown): void;
  }>();
  let checkpointGenerationPin: string | undefined;
  let postPrepared = (
    payload: P.Rpc,
    sessionId: string | undefined,
    requestOptions: unknown,
    ready: PostPreparation,
  ) => {
    if (ready.kind !== "unowned")
      fail("PREPARED_RPC_UNAVAILABLE", "No active grant for the prepared RPC");
    return unownedPost(payload, sessionId, requestOptions, ready.checked);
  };
  let rawPreparations = 0;
  client.preparePost = async (payload, origin) => {
    try {
      const outgoing = structuredClone(payload);
      const contextEpoch = state.data.contextEpoch || 0;
      const localPreparation = preparingJob.getStore();
      const grant = physicalGrant.getStore();
      const owned =
        localPreparation ??
        (!gate.scope.getStore()?.administrative &&
          grant && { job: grant.context.job, turn: grant.turn });
      const job = owned ? owned.job : undefined;
      const classification =
        origin && !job ? classifyPythonRpc(outgoing) : null;
      const unownedArtifact =
        classification?.kind === "python"
          ? retainPythonOrigin(
              prepareWireArtifact(runtime, classification.source),
              required(origin),
            )
          : undefined;
      const ready: PostPreparation = owned
        ? {
            kind: "owned",
            turn: await prepareOwnedTurn(outgoing, owned.job, owned.turn, origin,
            ),
          }
        : {
            kind: "unowned",
            checked: {
              outgoing,
              pythonCertificate: await pythonAdmission.check(
                outgoing,
                unownedArtifact,
                localCheckOptions(),
              ),
              contextEpoch,
            },
          };
      const fence = (prepared: P.PreparedPost | P.PreparedCall) => {
        resetFence();
        if (buildHash() !== codeHash)
          fail("BUILD_CHANGED", "Executable changed after final preparation");
        if (
          job &&
          !prepared.metadataOnly &&
          prepared.contextEpoch !== (state.data.contextEpoch || 0)
        )
          fail("DOCUMENT_CHANGED", "Context changed after final preparation");
        for (const input of (job && job.request.inputFiles) || []) {
          if (
            hash(
              fs.readFileSync(
                path.resolve(
                  required(job ? job.request.cwd : undefined),
                  input.path,
                ),
              ),
            ) !== input.sha256
          )
            fail(
              "INPUT_CHANGED",
              "Pinned input changed after final preparation",
            );
        }
        if ("metadataProof" in prepared && prepared.metadataProof)
          prepared.metadataProof.fence(prepared.outgoing);
        else required(prepared.pythonCertificate).fence(prepared.outgoing);
      };
      let consumed = false;
      return {
        fence() {
          if (ready.kind === "owned") ready.turn.inspect(fence);
          else fence(ready.checked);
        },
        send: (sessionId) => {
          if (consumed)
            fail("PREPARED_RPC_CONSUMED", "A prepared RPC cannot be replayed");
          consumed = true;
          return postPrepared(outgoing, sessionId, undefined, ready);
        },
      };
    } catch (cause) {
      const error = errorInfo(cause);
      error.probeNotSubmitted = true;
      throw error;
    }
  };
  // Install before startup discovery/probes too. No administrative or internal
  // script may reach physical transport without the same local certificate.
  async function unownedPost(
    payload: P.Rpc,
    sessionId?: string,
    requestOptions?: unknown,
    prepared?: P.PreparedPost,
  ) {
    const outgoing = prepared?.outgoing || structuredClone(payload);
    let certificate;
    try {
      certificate =
        prepared?.pythonCertificate || (await pythonAdmission.check(outgoing));
    } catch (cause) {
      const error = errorInfo(cause);
      error.probeNotSubmitted = true;
      throw error;
    }
    return gate.run(() => {
      resetFence();
      if (buildHash() !== codeHash)
        fail(
          "BUILD_CHANGED",
          "Executable changed during offline Python analysis",
        );
      // Broker observations intentionally collect the current document state
      // after a pause. Product operations retain their own epoch fence below;
      // an observation is never permission to execute a stale product request.
      certificate.fence(outgoing);
      const probe = probeSendScope.getStore();
      if (probe) {
        if (
          probe.dispatchBoundary === "broker-post" &&
          outgoing.method === "tools/call"
        )
          probe.start();
        else probe.assertCurrent();
      }
      return originalPost(outgoing, sessionId, requestOptions);
    });
  }
  client._post = unownedPost;
  // Only broker-private physical clients implement scoped request settings.
  // Injected fake backends need no mutable configuration or authorization bypass.
  const withRequest = <T>(
    settings: Parameters<NonNullable<P.Client["withRequest"]>>[0],
    action: () => T,
  ): T =>
    typeof client.withRequest === "function"
      ? client.withRequest(settings, action)
      : action();
  function systemReadTurn(probe: P.ProbeOptions, purpose: string) {
    let consumed = false;
    const physicalRequestId = typeof probe.binding?.rpcId === "string"
      ? probe.binding.rpcId : randomUUID();
    const selector = probe.documentSelector ?? {metadataOnly: true as const};
    const jobId = typeof probe.binding?.jobId === "string" ? probe.binding.jobId : undefined;
    const request: P.PhysicalTurnRequest = Object.freeze({
      kind: "system-read", brokerNonce: marker.nonce, jobId: jobId ?? "system:" + marker.nonce,
      requestId: physicalRequestId, clientId: "broker:" + marker.nonce,
      requestHash: hash(canonical({purpose, physicalRequestId, selector, buildHash: codeHash,
        }),
      ),
      grantGeneration: lane.snapshot().generation,
      physicalRequestId, documentSelector: Object.freeze({...selector}),
    });
    return async <T>(send: () => Promise<T>): Promise<T> => {
      if (!physicalIsolation) return send();
      if (consumed) fail("PHYSICAL_BINDING_REUSED", "A system read may be dispatched only once",
        );
      consumed = true;
      const candidate = required(options.bindPhysicalTurn)(request);
      if (!candidate) fail("PHYSICAL_BINDING_MISSING", "System read has no exact physical binding",
        );
      const physical = pinPhysicalTurn(candidate, request);
      if (checkpointIdentity.getStore() &&
          checkpointGeneration(physical) !== currentCheckpointGeneration())
        fail("DOCUMENT_STATE_CHANGED", "Identity probe generation changed before dispatch");
      const currentJob = jobId ? state.data.jobs[jobId] : undefined;
      const catalogIndex = currentJob && state.data.active === currentJob.id &&
        ["running","sending"].includes(currentJob.state)
        ? (currentJob.physicalDispatchCount ?? currentJob.physicalDispatches?.length ?? 0) + 1
        : undefined;
      durable(path.join(privateDirectory(path.join(dir, "physical-reads")), hash(physicalRequestId) + ".json",
        ), {
        version: 1, purpose, request, physicalTurn: physical,
        ...(catalogIndex === undefined ? {} : {catalogIndex}),
        receiptPath: probe.receiptPath ?? null,
      }, true,
      );
      if (currentJob && catalogIndex !== undefined)
        registerPhysicalDispatch(currentJob, request, physical, catalogIndex);
      return required(options.withPhysicalTurn)(physical, send);
    };
  }
  // Transitional probe orchestration still adjusts its client timeout. Give it
  // invocation-local settings, never the immutable physical adapter config.
  const instanceProbe = (options: P.ProbeOptions) => {
    const read = systemReadTurn(options, "instance-probe");
    const server = { timeoutMs: client.server.timeoutMs };
    const port: {
      server: { timeoutMs: number };
      callTool: P.Client["callTool"];
      prepareCallTool?: (...args: unknown[]) => Promise<P.Send>;
    } = {
      server,
      callTool: (...args) =>
        withRequest({ timeoutMs: server.timeoutMs }, () => {
          // Without a prepared wire call, entry to the injected tool port is
          // the last boundary where the broker can prove the probe was unsent.
          return read(() => sendProbe(() => client.callTool(...args)));
        }),
    };
    if (client.prepareCallTool)
      port.prepareCallTool = async (...args) => {
        const send = await required(client.prepareCallTool).apply(client, args);
        return Object.assign(
          () =>
            withRequest({ timeoutMs: server.timeoutMs }, () => {
              if (
                probeSendScope.getStore() &&
                send.dispatchBoundary !== "broker-post"
              )
                send.fence();
               return read(() => sendProbe(send, send.dispatchBoundary));
            }),
          { fence: () => send.fence() },
        );
      };
    return probe(port, { ...options, ...nativePaths });
  };
  async function prepareJobFlights(
    job: Pick<P.Job, "id" | "request" | "kind"> &
      Partial<Pick<P.Job, "sequenceMode" | "contextRefreshRequired">>,
    expectedMessage?: P.WorkerMessage,
    signal?: AbortSignal,
  ) {
    if (!client.prepareCallTool) return null; // Explicit physical test port has no transport preparation.
    const raw = job.kind === "rpc" ? rpcPayload(job.request.payload) : null;
    const selector = raw && isAddinMetadata(raw)
      ? addinMetadataSelector(raw)
      : job.request.phased ||
        job.sequenceMode === "automatic" ||
        job.contextRefreshRequired
        ? documentSelector(job)
        : undefined;
    return prepareBrokerFlights<P.Send<P.Instance>>({
      jobId: job.id,
      directory: jobDir(job.id),
      buildHash: codeHash,
      hash,
      assertPreparing() {
        if (lifetime.stopping)
          throw Object.assign(
            new Error("Broker stopped accepting local preparation"),
            { code: "BROKER_STOPPING", notStarted: true },
          );
        if (
          expectedMessage &&
          phased.pending(job.id)?.message !== expectedMessage
        )
          fail("WORKER_CLOSED", "Local worker closed during preparation");
      },
      prepare(binding, receiptPath, diagnosticPath) {
        const read = systemReadTurn({
          binding, receiptPath, documentSelector: selector,
        }, "job-flight",
        );
        const server = { timeoutMs: Math.min(client.server.timeoutMs, 15000) };
        const prepare = () =>
          preparingJob.run(false, () =>
            load("./queue-instance").prepareProbe(
              {
                server,
                prepareCallTool: async (...args) => {
                  const send = await required(client.prepareCallTool).apply(
                    client,
                    args,
                  );
                  return Object.assign(
                    () =>
                      withRequest({ timeoutMs: server.timeoutMs }, () => {
                        if (send.dispatchBoundary !== "broker-post")
                          send.fence();
                        return read(() => sendProbe(send, send.dispatchBoundary),
                        );
                      }),
                    { fence: () => send.fence() },
                  );
                },
              },
              {
                receiptPath,
                binding,
                requireIdle: false,
                documentSelector: selector,
                assertCurrent: () => probeSendScope.getStore()?.assertCurrent(),
                ...nativePaths,
                diagnosticPath,
              },
            ),
          );
        return signal ? preparingSignal.run(signal, prepare) : prepare();
      },
    });
  }
  const clientsFile = path.join(dir, "clients.json");
  const ipcDispatch: {
    dispatch(input: unknown): Promise<unknown>;
    clientHashes(): Record<string, string>;
  } = createBrokerIpcDispatch<P.Message, ReturnType<typeof owned>>(
    fs.existsSync(clientsFile) ? readJson(clientsFile) : {},
    {
      persistClients: (hashes) => durable(clientsFile, hashes),
      processUnavailable: () => epochProcessUnavailable,
      hasSuccessor: (): boolean => !!successorControl,
      ownsSuccessorCreation: (requestId): boolean => !!successorControl?.ownsCreation(requestId),
      assertMigrationAdmission,
      readEpochOwner: () => {
        const epoch = state.epoch;
        return epoch ? {
          ownerClientId: epoch.ownerClientId,
          ownerTokenHash: epoch.ownerTokenHash,
        } : undefined;
      },
      isHistorical: (jobId) => state.isHistorical(jobId),
      acceptsLifecycle: (action) => lifecycleControl.accepts(action),
      lifecycle: (message, owner) => lifecycleControl.handle(message, owner),
      backend(message) {
        const workerMessage = message as P.WorkerMessage;
        return state.data.jobs[workerMessage.jobId]?.request.phased
          ? phased.enqueue(workerMessage)
          : backend(workerMessage);
      },
      workerStatus: dispatchWorkerStatus,
      readJob: (id) => state.status(id),
      result: dispatchResult,
      command: dispatchCommand,
    },
  );
  const { dispatch, clientHashes } = ipcDispatch;
  let instance: P.Instance;
  const debugDispatchStarted = new WeakMap<P.PreparedCall, number>();
  const debugPreflightStarted = new WeakMap<P.PreparedCall, number>();
  const debugRawReceived = new WeakSet<P.PreparedCall>();
  const debugResultPublished = new Set<string>();
  const atomicObservationScope = new AsyncLocalStorage<P.ObservationScope>();
  const atomicRecoveryAuditScope = new AsyncLocalStorage<P.ScriptScope>();
  let atomicObservationOnly = false;
  let epochProcessUnavailable = false;
  let recovery: P.Recovery | null = null,
    lastRecoveryCheck = 0;
  const normalRestartPort = load(
    "./dist/node-adapters/broker-ipc/normal-restart",
  ) as typeof import("../../packages/node-adapters/src/broker-ipc/normal-restart");
  await lifetime.initialize(
    {
      recovery: !!state.summary().blocked,
      ...(backendTransition && !backendTransition.deadPredecessor
        ? {
            auditExpectedInstance: {
              pid: backendTransition.identity.instance.pid,
              birth: backendTransition.identity.instance.birth,
              version: backendTransition.identity.instance.version,
            },
          }
        : {}),
      startupQuiescent() {
        const { jobs, active, blocked, lease, localUnknown, controlBlocked } =
          state.data;
        return (
          !active &&
          !blocked &&
          !lease &&
          !localUnknown &&
          !controlBlocked &&
          Object.values(jobs).every((job) =>
            ["succeeded", "failed", "cancelled", "expired"].includes(job.state),
          )
        );
      },
    },
    identifyForStartup,
  );
  initializing = false;

  function assertCheckpointOwner() {
    resetFence();
    if (lifetime.stopping || buildHash() !== codeHash ||
        !same(readJson(lock), marker))
      fail("STORAGE_UNAVAILABLE", "Checkpoint broker ownership changed");
    const actor = checkpointActor.getStore();
    if (actor && clientHashes()[actor.clientId] !== actor.clientTokenHash)
      fail("NOT_AUTHORIZED", "The checkpoint principal is no longer registered");
  }
  function currentCheckpointGeneration() {
    assertCheckpointOwner();
    if (!physicalIsolation)
      fail("SDK_QUIESCENCE_UNPROVEN", "Checkpoint reads require native physical capabilities");
    const id = randomUUID();
    const request: P.PhysicalTurnRequest = {
      kind: "system-read", brokerNonce: marker.nonce, jobId: `generation:${marker.nonce}`,
      requestId: id, clientId: `broker:${marker.nonce}`, requestHash: hash(id),
      grantGeneration: lane.snapshot().generation, physicalRequestId: id,
      documentSelector: { metadataOnly: true },
    };
    // Binding validates the actual current private grant. This deliberately
    // creates no physical intent and submits no SDK request.
    const binding = pinPhysicalTurn(required(options.bindPhysicalTurn)(request)!, request, instance);
    const generation = checkpointGeneration(binding);
    if (checkpointGenerationPin && checkpointGenerationPin !== generation)
      fail("DOCUMENT_STATE_CHANGED", "Native generation changed");
    checkpointGenerationPin = generation;
    return generation;
  }
  const checkpointAdmission = createDocumentUnlockAdmission(() => ({
    state: state as unknown as import("../document-unlock-admission").UnlockAdmissionContext["state"],
    clients: clientHashes(), generation: currentCheckpointGeneration(),
    scope: frozenMetadataScope === undefined ? "ordinary" : "frozen-metadata",
  }));
  const checkpointEvidence = createBrokerCheckpointEvidence({
    directory: dir, buildHash: codeHash, records: executionRecords,
    readJob: (id) => required(state.data.jobs[id]),
    recheck() {
      assertCheckpointOwner();
      // Revalidate the actual current private authorization too, not just the
      // local owner marker. Historical reads still use their original binding.
      currentCheckpointGeneration();
    },
    currentGeneration: currentCheckpointGeneration,
    compile: (operation, data, context, pathMapper, guard, privateReadback) =>
      (runtimeRequire("./dist/composition/cad") as typeof import("./cad")).prepareCadScript(
        operation, data, context, pathMapper, guard, privateReadback,
      ),
    wrapReceipt: (code, receipt, binding) =>
      prepareReceiptScript(code, false, receipt, binding, nativePaths),
    matchResponse: (record) => matchRecordedResponse(record),
    verifyReceipt(record, receipt) {
      remoteReceipt(record, true, receipt);
      const declaration = nativeReceipts.start(record);
      const end = declaration ? nativeReceipts.completion(record, declaration) : null;
      if ((declaration && (!end || end.outcome !== "succeeded")) ||
          (!declaration && (object(record)["nativeDeclaration"] || record.nativeCompletion)))
        fail("STORAGE_UNAVAILABLE", "Original native checkpoint workflow is incomplete");
      if (end && !same(end.native?.state, record.nativeCompletion))
        fail("STORAGE_UNAVAILABLE", "Native completion differs from its retained record");
    },
    authenticatePhysical: (binding) => {
      assertCheckpointOwner();
      return required(options.physicalTurnQuiescence)(binding);
    },
  });
  const continuation = (
    runtimeRequire("./document-continuation-broker") as
      typeof import("../document-continuation-broker")
  ).createDocumentContinuationBroker({
    domain: state as unknown as import("@fmcad/core").QueueDomain,
    currentGeneration: currentCheckpointGeneration,
    recheck(actor, target) {
      assertCheckpointOwner();
      if (!target.creationId)
        fail("DOCUMENT_TARGET_UNAVAILABLE", "Continuation requires an exact creationId");
      checkpointAdmission.authorizeStatus(actor, {
        docId: target.creationId,
        ...(target.fileId === undefined ? {} : { docFileId: target.fileId }),
      }).recheck();
      const commands = runtimeRequire("./dist/core/application/cad/worker-command") as
        typeof import("../../packages/core/src/application/cad/worker-command");
      // Check actual model policy without pretending a retained checkpoint is
      // a new identity probe. The in-SDK guard will verify the current CAD state.
      const epoch = state.epoch;
      const payload = {
        version: 1, kind: "cad", operation: "param.apply",
        docId: target.creationId,
        // The isolated policy requires its exact known name. Ordinary admission
        // uses this non-executed label only to form a valid typed policy request;
        // it is not an alias/existence proof for the actual CAD invocation.
        doc: epoch?.document.creationId === target.creationId
          ? epoch.document.name : target.creationId,
        ...(target.fileId === undefined ? {} : { docFileId: target.fileId }),
        data: { parameters: [] },
      };
      const decoded = commands.decodeCadWorkerInvocation(payload);
      admitEpochRequest({
        kind: "command", clientId: actor.clientId, ownerToken: actor.clientTokenHash,
        requestId: "continuation-model-admission", timeoutMs: 1, cwd: dir, payload,
        argv: commands.cadWorkerPolicyArguments(decoded),
      });
    },
    verifyObservation: (observation, actor) =>
      checkpointActor.run(actor, () => checkpointEvidence.verify(observation)),
  });
  const continuationJobs = new Set<string>();
  function acceptedContinuationTarget(request: P.Request) {
    if (request.kind !== "command" || !physicalIsolation) return null;
    const commands = runtimeRequire("./dist/core/application/cad/worker-command") as
      typeof import("../../packages/core/src/application/cad/worker-command");
    const decoded = commands.decodeCadWorkerInvocation(request.payload);
    const invocation = decoded.kind === "cad-command" ? decoded.invocation :
      decoded.kind === "cad" ? decoded : null;
    if (!invocation || invocation.operation !== "param.apply" ||
      !invocation.docId || invocation.preview === true || invocation.component !== undefined)
      return null;
    const target = { creationId: invocation.docId,
      ...(invocation.docFileId === undefined ? {} : { fileId: invocation.docFileId }) };
    const { documentTargetKey } = runtimeRequire("./dist/core/domain/document-checkpoint") as
      typeof import("../../packages/core/src/domain/document-checkpoint");
    const records = state.data.documentCheckpoints;
    const head = records?.heads[documentTargetKey(target)];
    return head && records?.acceptances[head]?.actorClientId === request.clientId &&
      state.documentConflicts(target).length ? target : null;
  }
  function checkpointConflicts(target: import("@fmcad/core").QueueIsolationTarget | null) {
    return state.documentConflicts(target);
  }
  async function probeCheckpointIdentity(actor: CheckpointActor,
    selector: import("../document-unlock-admission").UnlockTargetSelector) {
    assertCheckpointOwner();
    checkpointAdmission.authorizeStatus(actor, selector).recheck();
    state.assertDocumentProbeAllowed();
    if (state.data.paused || busy() || activeContext() || gate.resuming || gate.adminTransition || gate.active.size)
      fail("SDK_TURN_ACTIVE", "Another SDK turn is still active");
    currentCheckpointGeneration();
    lane.setAdministrative(true);
    try {
      return await checkpointIdentity.run(true, () => gate.administrative(async () => {
        assertCheckpointOwner();
        state.assertDocumentProbeAllowed();
        const id = randomUUID();
        const folder = privateDirectory(path.join(dir, "document-identity-reads"));
        const observed = await checkInstance({
          requireIdle: true,
          binding: { jobId: `identity-${id}`, rpcId: id,
            requestHash: hash(canonical(selector)), buildHash: codeHash },
          receiptPath: path.join(folder, `${id}.json`),
          documentSelector: {
            ...(selector.docId === undefined ? {} : { creationId: selector.docId }),
            ...(selector.docFileId === undefined ? {} : { fileId: selector.docFileId }),
          },
        });
        checkpointAdmission.authorizeStatus(actor, selector).recheck();
        const document = observed.documentState;
        const identity = object(object(document?.state)["identity"]);
        if (document?.status !== "complete" ||
            typeof document.fingerprint !== "string" ||
            !/^[a-f0-9]{64}$/.test(document.fingerprint) ||
            typeof identity["creationId"] !== "string" ||
            typeof identity["name"] !== "string" ||
            (identity["fileId"] != null && typeof identity["fileId"] !== "string"))
          fail("DOCUMENT_TARGET_UNAVAILABLE", "An exact current document identity is unavailable");
        return {
          complete: true as const, creationId: identity["creationId"],
          name: identity["name"], fingerprint: document.fingerprint,
          ...(typeof identity["fileId"] === "string" ? { fileId: identity["fileId"] } : {}),
          ...(typeof identity["version"] === "number" ? { version: identity["version"] } : {}),
        };
      }));
    } finally {
      lane.setAdministrative(false);
      lifetime.progress();
    }
  }
  async function readCheckpoint(actor: CheckpointActor,
    target: import("../document-unlock-admission").CurrentUnlockTarget,
    fence: import("@fmcad/core").DocumentInspection) {
    assertCheckpointOwner();
    const confirmed = target as CheckpointTarget; // Runtime admission WeakMap still checks the original object.
    checkpointAdmission.authorize(actor, "inspect", confirmed).recheck();
    if (fence.generation !== currentCheckpointGeneration())
      fail("DOCUMENT_STATE_CHANGED", "Checkpoint generation changed before admission");
    const payload = {
      version: 1, kind: "cad", operation: "param.inspect",
      doc: target.name, docId: target.creationId,
      ...(target.fileId ? { docFileId: target.fileId } : {}),
      data: { includeModel: true },
    };
    const commands = runtimeRequire("./dist/core/application/cad/worker-command") as
      typeof import("../../packages/core/src/application/cad/worker-command");
    const decoded = commands.decodeCadWorkerInvocation(payload);
    const request: P.Request = {
      requestId: randomUUID(), clientId: actor.clientId, ownerToken: actor.clientTokenHash,
      kind: "command", cwd: dir, timeoutMs: 15000, queueTimeoutMs: 15000,
      phased: true,
      buildHash: codeHash, backend: "addin", payload,
      argv: commands.cadWorkerPolicyArguments(decoded),
    };
    if (state.epoch || approvedRuntimeRoot) admitEpochRequest(request);
    const status = state.submitDocumentInspection(request, fence);
    const jobId = status["id"];
    if (typeof jobId !== "string") fail("STORAGE_UNAVAILABLE", "Inspection admission lost its job identity");
    const job = required(state.data.jobs[jobId]);
    if (!["queued", "preparing", "processing"].includes(job.state))
      fail(job.code || "DOCUMENT_UNLOCK_REQUIRED", "Checkpoint read was not admitted");
    const result = new Promise<CheckpointReadResult>((resolve, reject) => {
      checkpointReads.set(job.id, { actor: { ...actor }, target: confirmed,
        turn: brokerExecution.createTurnIdentity(job.id), resolve, reject });
    });
    result.catch(() => {});
    try {
      const task = required(checkpointReads.get(job.id));
      privateDirectory(jobDir(job.id));
      executionRecords.createIntent(job.id, {
        id: job.id, request: job.request, buildHash: codeHash,
        properties: {}, deadline: Date.now() + job.timeoutMs,
      });
      const compiled = checkpointEvidence.compile(job);
      const origin = load("./python").pythonArtifactManifest(compiled);
      const compiledScope = {
        producer: "compiled-cad-v1", operation: "param.inspect",
        sourceHash: hash(compiled.script), buildHash: codeHash, target: fence.target,
      };
      // Ordinary offline preparation remains outside the sole physical lane.
      // Its prepared turn identity and checker fence are consumed only once.
      task.send = await preparingJob.run({ job, turn: task.turn, compiledScope }, () =>
        required(client.prepareCallTool).call(client, {
          featureType: "script", object: { script: compiled.script, readOnly: true },
        }, "fusion_mcp_execute", origin),
      );
      assertCheckpointOwner();
      checkpointAdmission.authorize(actor, "inspect", confirmed).recheck();
      state.readyTurn(job.id);
    } catch (cause) {
      checkpointReads.get(job.id)?.reject(cause);
      checkpointReads.delete(job.id);
      state.finishLocal(job.id, {
        state: "failed", code: errorInfo(cause).code || "CHECKPOINT_PREPARATION_FAILED",
        executionOutcome: "not_started", mayHaveMutated: false, userScriptSubmitted: false,
      });
    }
    // The existing scheduler owns lane.begin, SDK turn and failure isolation.
    // No direct physical send and no whole-application reservation is added.
    lifetime.progress();
    return result;
  }
  const checkpointController = createDocumentUnlockController({
    domain: state as unknown as import("@fmcad/core").QueueDomain,
    admission: checkpointAdmission, generation: currentCheckpointGeneration,
    probeIdentity: probeCheckpointIdentity,
    async inspect(actor, requestId, target, fence) {
      const blockers = checkpointConflicts(fence.target).map((value) => ({
        jobId: value.jobId, requestId: value.requestId, originalHash: value.jobHash,
        catalogDigest: value.catalogDigest, barrierRef: value.evidenceReference,
      }));
      const read = await readCheckpoint(actor, target, fence);
      const observation = await checkpointEvidence.persist({
        version: 1, id: randomUUID(), requestId, actorClientId: actor.clientId,
        target: fence.target, generation: fence.generation, scope: "parameters",
        stateDigest: checkpointStateHash(read.checkpoint), blockers,
        priorCheckpointId: fence.priorCheckpointId, createdAt: Date.now(),
      }, read.jobId);
      checkpointViews.getStore()?.justProduced.add(observation.id);
      return { id: observation.id, stateDigest: observation.stateDigest,
        createdAt: observation.createdAt, readback: observation.readback };
    },
    async verifyStoredObservation(observation) {
      const verified = await checkpointEvidence.verify(observation, true);
      required(checkpointViews.getStore()).finalChecks.set(observation.id, [verified.reverify]);
    },
    verifyFinal(observation) {
      const checks = required(checkpointViews.getStore()).finalChecks.get(observation.id);
      if (!checks?.length) fail("STORAGE_UNAVAILABLE", "Final checkpoint verification is unavailable");
      for (const verify of checks) verify();
    },
    async verifyObservation(observation, target) {
      const original = await checkpointEvidence.verify(observation);
      const scope = required(checkpointViews.getStore());
      const finalChecks = [original.reverify];
      if (!scope.justProduced.delete(observation.id)) {
        const actor = required(checkpointActor.getStore());
        const fence = state.documentInspectionFence(observation.target, currentCheckpointGeneration());
        const current = await readCheckpoint(actor, target, fence);
        // Authenticate this new original read too, not just its client output.
        const { readback: previousReadback, ...previousContext } = observation;
        void previousReadback;
        const confirmation = await checkpointEvidence.persist({
          ...previousContext, id: randomUUID(), createdAt: Date.now(),
          stateDigest: checkpointStateHash(current.checkpoint),
          priorCheckpointId: fence.priorCheckpointId,
          blockers: checkpointConflicts(fence.target).map((value) => ({
            jobId: value.jobId, requestId: value.requestId, originalHash: value.jobHash,
            catalogDigest: value.catalogDigest, barrierRef: value.evidenceReference,
          })),
        }, current.jobId);
        if (confirmation.stateDigest !== observation.stateDigest)
          fail("DOCUMENT_STATE_CHANGED", "Parameters changed after the original observation");
        const fresh = await checkpointEvidence.verify(confirmation);
        finalChecks.push(fresh.reverify);
      }
      scope.states.set(observation.id, original.checkpoint);
      scope.finalChecks.set(observation.id, finalChecks);
    },
    resolution(actor, selector, observation) {
      const target: import("../document-unlock-diagnostics").DocumentUnlockTarget = observation ? {
        docId: required(observation.target.creationId),
        ...(observation.target.fileId ? { docFileId: observation.target.fileId } : {}),
      } : selector.docId ? {
        docId: selector.docId,
        ...(selector.docFileId ? { docFileId: selector.docFileId } : {}),
      } : { docFileId: required(selector.docFileId) };
      const conflicts = checkpointConflicts({
        ...(target.docId === undefined ? {} : { creationId: target.docId }),
        ...(target.docFileId === undefined ? {} : { fileId: target.docFileId }),
      });
      const unfenced = !!(state.data.blocked || state.data.localUnknown || state.data.controlBlocked);
      const { documentConflictAllowsInspection, documentConflictFence } =
        runtimeRequire("./dist/core/domain/document-conflicts") as
          typeof import("../../packages/core/src/domain/document-conflicts");
      const raw = conflicts.some((entry) => !documentConflictAllowsInspection(entry));
      const runtimeRetired = conflicts.some((entry) =>
        documentConflictFence(entry) === "runtime_retired");
      const observed = observation && checkpointViews.getStore()?.states.get(observation.id);
      const checkpoints = state.data.documentCheckpoints;
      const accepted = observation && observed &&
        observation.generation === currentCheckpointGeneration() &&
        same(observation.blockers, conflicts.map((entry) => ({
          jobId: entry.jobId, requestId: entry.requestId, originalHash: entry.jobHash,
          catalogDigest: entry.catalogDigest, barrierRef: entry.evidenceReference,
        }))) &&
        Object.values(checkpoints?.acceptances ?? {}).some((entry) =>
          entry.actorClientId === actor.clientId &&
          entry.observationId === observation.id &&
          entry.observationDigest === checkpointStateHash(observation) &&
          checkpoints?.heads[entry.targetKey] === entry.id);
      // Knowing a target's identity does not authorize another client's job
      // namespace. Hidden conflicts remain in all admission/CAS checks above.
      const visible = checkpointDisclosableConflicts(conflicts, actor.clientId, (id) => state.lookup(id));
      return {
        target, state: unfenced ? "execution_unfenced" : raw ? "scope_unproven" :
          accepted && observed ? "checkpoint_current" :
          conflicts.length || observation ? "inspection_required" : "clear",
        executionFence: unfenced ? "unknown" : runtimeRetired ? "runtime_retired" : "released",
        hasUndisclosedBlockers: visible.length !== conflicts.length,
        disclosableBlockers: visible.map((entry) => ({
          jobId: entry.jobId, requestId: entry.requestId,
          scope: documentConflictFence(entry) === "runtime_retired" ? "runtime" as const :
            entry.target ? "document" as const : "global" as const,
          executionFence: documentConflictFence(entry),
        })),
        ...(observation && observed ? { currentObservation: {
          observationId: observation.id,
          coverage: ["document_identity", "document_version", "parameter_readback"] as const,
          observed, stateDigest: observation.stateDigest,
        } } : {}),
      };
    },
  });

  async function identifyForStartup({
    binding: startupBinding,
    receipt: startupReceipt,
    diagnosticPath,
  }: BrokerStartup) {
    let normalRestart: ReturnType<
      typeof normalRestartPort.inspectSettledNormalRestart
    >;
    let normalRestartReference: P.Reference | undefined;
    oldIdentity = fs.existsSync(identityFile)
      ? readJson<P.Identity>(identityFile)
      : null;
    if (
      !backendTransition &&
      oldIdentity &&
      oldIdentity.configHash !== configHash
    )
      fail(
        "CONFIG_CHANGED",
        "Pinned backend configuration differs from the durable broker identity",
      );
    if (
      state.epoch &&
      state.admissionMode === "normal-multidocument" &&
      oldIdentity &&
      !successorRuntime &&
      !backendTransition &&
      !effectiveBackend
    ) {
      try {
        normalRestart = normalRestartPort.inspectSettledNormalRestart(
          dir,
          state.epoch,
          oldIdentity,
          state.data,
          { priorProcessAlive },
        );
      } catch (cause) {
        const error = errorInfo(cause);
        error.probeNotSubmitted = true;
        throw error;
      }
    }
    if (
      !backendTransition &&
      (successorRuntime ||
        load(
          "./dist/node-adapters/broker-ipc/normal-admission",
        ).epochStartupPinned(
          state,
          oldIdentity?.buildHash,
          codeHash,
          !!normalRestart,
        ))
    ) {
      // Reopening a broker never adopts another active document or replays the
      // creation operation. The immutable epoch remains tied to its live process.
      const epoch = required(state.epoch);
      const closedEpoch = fs.existsSync(path.join(epoch.root, "closed.json"));
      const normalAdmission = state.admissionMode === "normal-multidocument";
      if (!closedEpoch || normalAdmission) {
        try {
          state.assertEpoch(normalAdmission);
        } catch (cause) {
          const error = errorInfo(cause);
          if (error.code !== "INSTANCE_CHANGED") throw error;
          // As with restored unknown work, keep receipts reachable without
          // probing, adopting another process or renewing modeling authority.
          epochProcessUnavailable = true;
        }
      }
      const expectedBuild =
        successorRuntime?.effectiveIdentity?.buildHash ||
        successorRuntime?.authority.previousBuildHash ||
        codeHash;
      if (
        !oldIdentity ||
        oldIdentity.buildHash !== expectedBuild ||
        !sameInstance(
          oldIdentity.instance,
          normalAdmission
            ? effectiveBackend?.identity.instance ||
                (normalRestartPort.normalRestartInstance(
                  dir,
                  epoch,
                  oldIdentity,
                  state.data,
                ) as P.Instance)
            : epoch.currentInstance,
        )
      )
        fail(
          "BUILD_CHANGED",
          "An isolated epoch requires its exact qualified runtime and current process identity",
        );
      if (successorRuntime) epochProcessUnavailable = true;
      instance = oldIdentity.instance;
      setHold(
        epochProcessUnavailable
          ? "Qualified isolated scratch process is unavailable; metadata only, no SDK or replacement authority"
          : normalAdmission
            ? null
            : closedEpoch
              ? "Qualified isolated scratch is closed; historical unknown work remains quarantined"
              : fs.existsSync(
                    path.join(
                      epochControlDirectory(dir, epoch),
                      "isolated-scratch-close",
                      "intent.json",
                    ),
                  )
                ? "Isolated scratch cleanup remains pending or uncertain"
                : null,
      );
    } else if (state.summary().blocked || state.data.controlBlocked) {
      // No Fusion traffic at all until receipt evidence proves the old dispatch ended.
      instance = oldIdentity?.instance as P.Instance;
      if (oldIdentity && oldIdentity.buildHash !== codeHash) {
        const target =
          state.data.blocked && state.data.jobs[state.data.blocked.id];
        if (
          !target ||
          !isAtomicObservationCandidate(
            target,
            oldIdentity.buildHash,
            observationScopeConfig,
          )
        )
          fail(
            "BUILD_CHANGED",
            "Restore the original executable build before reconciling the unfinished job",
          );
        if (!instance)
          fail(
            "INSTANCE_UNAVAILABLE",
            "Original Fusion instance identity is unavailable",
          );
        // A build transition never replays original work. It only starts a held
        // broker that accepts one exact typed atomic_status observer.
        atomicObservationOnly = true;
      }
      setHold(
        atomicObservationOnly
          ? "Read-only atomic holder observation only; all other admission remains blocked"
          : "Restored unfinished job; matching remote terminal receipts are required before any probe",
      );
    } else {
      // A completed busy observation is not an unfinished RPC. Keep the control
      // plane available; modeling workflows still require idle in preflight.
      instance = await gate.administrative(() =>
        instanceProbe({
          receiptPath: startupReceipt,
          binding: startupBinding,
          requireIdle: false,
          diagnosticPath,
        }),
      );
      if (
        !backendTransition &&
        oldIdentity &&
        !sameInstance(instance, oldIdentity.instance)
      ) {
        const previousAlive = priorProcessAlive(oldIdentity.instance);
        const versionChanged =
          oldIdentity.instance.version !== instance.version;
        const summary = state.summary();
        const queueQuiescent =
          !state.data.paused &&
          !summary.active &&
          !summary.blocked &&
          !summary.lease &&
          !state.data.controlBlocked &&
          Object.values(state.data.jobs).every((job) =>
            ["succeeded", "failed", "cancelled", "expired"].includes(job.state),
          );
        if (
          typeof oldIdentity.buildHash !== "string" ||
          previousAlive !== false ||
          !idle(instance) ||
          !Array.isArray(instance.documents) ||
          instance.documents.some(
            (document) => document?.isModified !== false,
          ) ||
          (versionChanged &&
            (options.confirmVersionTransition !== true || !queueQuiescent))
        ) {
          fail(
            "INSTANCE_CHANGED",
            versionChanged
              ? "Fusion version changed; explicit confirmation, a dead old process, an unpaused quiescent queue, an idle UI and clean documents are required"
              : "Fusion identity changed; automatic recovery requires the old process gone, an idle UI and unmodified documents",
          );
        }
        const transitionId = hash(
          JSON.stringify({
            configHash,
            buildHash: codeHash,
            previous: oldIdentity.instance,
            current: instance,
          }),
        );
        if (normalRestart)
          normalRestartReference = normalRestartPort.commitSettledNormalRestart(
            normalRestart,
            state.data,
            instance,
            startupBinding,
            startupReceipt,
            { priorProcessAlive },
          );
        const queueTransition = state.advanceInstanceEpoch(transitionId);
        durable(path.join(dir, `instance-transition-${transitionId}.json`), {
          source: versionChanged
            ? "explicit-quiescent-version-transition"
            : "automatic-quiescent-restart-recovery",
          transitionId,
          at: new Date().toISOString(),
          configHash,
          previousBuildHash: oldIdentity.buildHash,
          buildHash: codeHash,
          previous: oldIdentity.instance,
          current: instance,
          queueTransition,
        });
      }
      if (backendTransition) {
        const observationFiles = [diagnosticPath];
        const receipt = fs.existsSync(startupReceipt)
          ? readJson<Record<string, unknown>>(startupReceipt)
          : null;
        const exactReceipt =
          !!receipt &&
          receipt["terminal"] === true &&
          receipt["outcome"] === "succeeded" &&
          sameInstance(receipt["instance"] as P.Instance, instance) &&
          !Object.entries(startupBinding).some(
            ([key, value]) => !same(receipt[key], value),
          );
        if (!options.createBackend && !exactReceipt)
          fail(
            "BACKEND_TRANSITION_UNPROVEN",
            "Exact target startup receipt is required; ownership is retained without replay",
          );
        if (exactReceipt) observationFiles.push(startupReceipt);
        identityFile = backendTransition.commit(
          instance,
          codeHash,
          observationFiles,
        );
      } else if (effectiveBackend) {
        // A reopen must not rewrite the immutable transition or predecessor.
        if (
          oldIdentity?.buildHash !== codeHash ||
          !sameInstance(oldIdentity.instance, instance)
        )
          fail(
            "BUILD_CHANGED",
            "Restore the exact physical backend transition runtime before reopening",
          );
      } else
        durable(identityFile, {
          configHash,
          buildHash: codeHash,
          instance,
          ...(normalRestartReference || oldIdentity?.normalRestart
            ? {
                normalRestart:
                  normalRestartReference || oldIdentity?.normalRestart,
              }
            : {}),
        });
    }
  }

  function clientProperties() {
    const properties: Record<string, unknown> = {};
    for (const key of [
      "capabilities",
      "serverInfo",
      "negotiatedProtocolVersion",
    ] as const)
      if (client[key] !== undefined) properties[key] = client[key];
    return properties;
  }

  const phased = new (load("./queue-phased").PhasedWorkers)({
    preparationConcurrency,
    state,
    dir,
    cfg: pinned,
    codeHash,
    onLocalPhase(job, phase) {
      phaseTimings.localPhase(state.epoch?.root ?? dir, job, phase);
    },
    async checkSdkRequest(message, signal) {
      assertPhysicalIsolationAuthority();
      const job = required(state.data.jobs[message.jobId]);
      const turn = brokerExecution.createTurnIdentity(job.id);
      const guarded = job.documentContinuation
        ? await continuation.prepareWorker(
            job as unknown as import("@fmcad/core").QueueJob,
            { method: message.method, args: message.args }, turn,
          )
        : null;
      const compiled = guarded ?? (physicalIsolation && job.request.kind === "command" &&
        quarantineTarget(job.request) ? constrainedCadProgram(job) : null);
      if (compiled && !guarded && (message.method !== "callTool" ||
          (message.args[1] && message.args[1] !== "fusion_mcp_execute") ||
          object(object(message.args[0])["object"])["script"] !== compiled.script))
        fail("PHYSICAL_SCOPE_MISMATCH", "Actual pre-wrapper source differs from the broker-compiled constrained program");
      const envelope = compiled ? {
        featureType:"script",object:{script:compiled.script,readOnly:compiled.readOnly},
      } : null;
      if (compiled && !guarded && (message.args.length !== 3 ||
          message.args[1] !== "fusion_mcp_execute" || !same(message.args[0],envelope)))
        fail("PHYSICAL_ENVELOPE_MISMATCH",
          "Actual call differs from the compiled CAD envelope, including featureType and readOnly");
      if (compiled && !guarded && !same(message.args[2],compiled.manifest))
        fail("PHYSICAL_PROVENANCE_MISMATCH",
          "Actual inventory differs from the trusted compiler artifact provenance");
      const adapterArgs = compiled
        ? [envelope,"fusion_mcp_execute",compiled.manifest]
        : message.args;
      const compiledScope = compiled ? {
        producer:"compiled-cad-v1", operation:compiled.operation,sourceHash:hash(compiled.script),
        buildHash:codeHash,target:compiled.target,
      } : undefined;
      const prepare =
        message.method === "callTool"
          ? client.prepareCallTool
          : message.method === "executeUiGuardedScript"
            ? client.prepareUiGuardedScript
            : client.prepareListTools;
      if (prepare) {
        const send = await preparingJob.run({ job, turn, ...(compiledScope ? {compiledScope} : {}) }, () =>
          preparingSignal.run(signal, () =>
            prepare.apply(client, adapterArgs),
          ),
        );
        if (phased.pending(job.id)?.message !== message)
          fail(
            "WORKER_CLOSED",
            "Local worker closed during final artifact preparation",
          );
        resetFence();
        const flights = await prepareJobFlights(job, message, signal);
        if (phased.pending(job.id)?.message !== message)
          fail(
            "WORKER_CLOSED",
            "Local worker closed during final artifact preparation",
          );
        localPlans.set(job.id, { kind: "worker", turn, message, send, flights,
        });
        return;
      }
      if (guarded)
        fail("DOCUMENT_CONTINUATION_UNPROVEN",
          "Guarded continuation requires supported artifact preparation and physical binding");
      // Injected test clients have no native prepare methods. Snapshot once for
      // both checking and invocation, just as the production client does.
      const args = structuredClone(message.args);
      const payload: P.Rpc = {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name:
            message.method === "executeUiGuardedScript"
              ? "fusion_mcp_execute"
              : (args[1] as string | undefined) ||
                pinned.tool ||
                "fusion_mcp_execute",
          arguments:
            message.method === "executeUiGuardedScript"
              ? {
                  featureType: "script",
                  object: { script: args[0] as string },
                }
              : (args[0] as P.ToolArguments),
        },
      };
      if (message.method === "listTools") {
        payload.method = "tools/list";
        delete payload.params;
      }
      const certificate = await pythonAdmission.check(payload, undefined, {
        signal,
      });
      if (signal.aborted || phased.pending(job.id)?.message !== message)
        fail("WORKER_CLOSED", "Local worker closed during preparation");
      const fence = () => certificate.fence(payload);
      localPlans.set(job.id, {
        kind: "worker",
        turn,
        message,
        flights: null,
        send: Object.assign(
          () => {
            fence();
            return Reflect.apply(client[message.method], client, args);
          },
          { fence },
        ),
      });
    },
    properties: clientProperties,
    spawnWorker: options.spawnWorker,
    onFault(error) {
      lane.recordFault(errorInfo(error).code || "LOCAL_WORKER_STORAGE_FAILED");
      diagnostics();
    },
    onUnknown(job, reason) {
      if (state.data.quarantined?.[job.id]) return;
      const turnGrant = lane.currentGrant();
      if (turnGrant?.jobId === job.id && state.data.active === job.id)
        hold(turnGrant, reason);
      else {
        state.blockLocal(job.id, reason);
        if (!turnGrant && !lane.hasHold()) setHold(reason);
      }
      diagnostics();
    },
  });

  function jobDir(id: string) {
    return path.join(dir, "jobs", id);
  }
  function diagnostics() {
    publishBrokerDiagnostics(
      dir,
      durable,
      () => ({
        buildHash: codeHash,
        held: heldReason(),
        recovery,
        activeJobId: state.summary().active,
      }),
      () => ({
        ...gate.snapshot(),
        owner: marker,
        projectActivityFence: projectActivity.projectActivityCapability(),
        queued: Object.values(state.data.jobs).filter(
          (job) => job.state === "queued",
        ).length,
        held: !!heldReason(),
        buildHash: codeHash,
      }),
    );
  }
  function hold(grant: ProductGrant, reason: string) {
    // Repeated error callbacks for the already-held turn are harmless; never
    // let them change the new turn's hold or durable state.
    if (
      lane.hold(grant, reason, () => {
        if (state.status(grant.jobId).state !== "needs_reconciliation")
          state.block(grant.jobId, reason);
      })
    )
      diagnostics();
  }
  async function quarantineReleasedTurn() {
    const port = options.physicalTurnQuiescence;
    const context = lane.heldContext();
    const jobId = context?.job.id ?? state.data.blocked?.id;
    const job = jobId ? state.data.jobs[jobId] : undefined;
    if (
      !port || quiescencePending || Date.now() < nextQuiescenceCheck ||
      !job || context?.executing || state.data.controlBlocked ||
      state.data.localUnknown || state.data.blocked?.id !== job.id
    ) return;
    const originals = job.physicalDispatches;
    if (!originals?.length) return;
    const catalogDigest = hash(JSON.stringify(originals));
    const request = {
      jobId: job.id, requestId: job.requestId,
      clientId: job.clientId, requestHash: job.hash,
    };
    const recoveryHold = lane.captureRecovery();
    quiescencePending = true;
    nextQuiescenceCheck = Date.now() + 250;
    try {
      const proofs = await Promise.all(
        originals.map(async (entry) => {
          const proof = await port(pinPhysicalTurn(entry.physical, entry.request));
          if (
            proof.state !== "released" ||
            !validRelease(proof, entry.physical, hash)
          ) return null;
          return proof;
        }),
      );
      recoveryHold.assertCurrent();
      if (
        lane.heldContext() !== context || context?.executing ||
        state.data.blocked?.id !== job.id ||
        hash(JSON.stringify(state.data.jobs[job.id]?.physicalDispatches)) !==
          catalogDigest || proofs.some((proof) => !proof)
      ) return;
      const proof = proofs[0]!;
      recoveryHold.settle(() => state.quarantineUnknown(request.jobId, {
        jobId: request.jobId, requestId: request.requestId,
        clientId: request.clientId, jobHash: request.requestHash,
        target: quarantineTarget(job.request),
        catalogDigest,
        evidenceReference: proof.physicalEvidenceReference,
        evidenceDigest: proof.evidenceDigest,
        binding: { ...request, physicalTurns: proofs },
      }));
      diagnostics();
    } catch {
      // No proof, stale grant, or failed durable publication never authorizes
      // releasing ownership or rewriting the UNKNOWN result.
    } finally {
      quiescencePending = false;
    }
  }
  function constrainedCadProgram(job: P.Job) {
    const {prepareRequest} = runtimeRequire("./dist/composition/execution-request") as
      typeof import("./execution-request");
    const commands = runtimeRequire("./dist/core/application/cad/worker-command") as
      typeof import("../../packages/core/src/application/cad/worker-command");
    const decoded = commands.decodeCadWorkerInvocation(prepareRequest({
      request: {
        ...job.request, cwd: required(job.request.cwd),
        argv: required(job.request.argv),
      },
    }).payload);
    const invocation = decoded.kind === "cad-command" ? decoded.invocation :
      decoded.kind === "cad" ? decoded : null;
    if (
      !invocation || !["param.inspect", "param.apply"].includes(invocation.operation) ||
      !same(commands.cadWorkerPolicyArguments(decoded),
        job.request.argv?.[0] === "cad" ? job.request.argv : ["cad", ...(job.request.argv ?? [])])
    ) fail("PHYSICAL_SCOPE_MISMATCH", "Document isolation requires a bounded compiled CAD invocation");
    const {prepareCadScript} = runtimeRequire("./dist/composition/cad") as
      typeof import("./cad");
    const compilerContext: import("@fmcad/core").CadContext = {};
    for (const key of ["doc", "docId", "docFileId", "component", "projectId"] as const)
      if (invocation[key] !== undefined) compilerContext[key] = invocation[key];
    compilerContext.preview = invocation.preview === true;
    const expected = prepareCadScript(invocation.operation, invocation.data, compilerContext,
      undefined, undefined, job.documentInspection ? "param-checkpoint" : undefined);
    const catalog = runtimeRequire("./catalog/index") as {
      catalog: Record<string,{readOnly?: boolean}>;
    };
    return {
      script: expected.script, operation: invocation.operation,
      manifest: load("./python").pythonArtifactManifest(expected),
      target: quarantineTarget(job.request),
      readOnly: catalog.catalog[invocation.operation]?.readOnly === true,
    };
  }
  function bindProductPhysicalTurn(grant: ProductGrant, prepared: P.PreparedCall,
  ) {
    if (!physicalIsolation) return;
    const job = grant.context.job;
    const constrainedTarget = quarantineTarget(job.request);
    if (constrainedTarget && !prepared.metadataProof) {
      const compiled = job.documentContinuation
        ? continuation.expectedProduct(
            job as unknown as import("@fmcad/core").QueueJob, grant.turn,
          )
        : constrainedCadProgram(job);
      const scope = object(prepared.record.binding["documentScope"]);
      if (scope["producer"] !== "compiled-cad-v1" ||
          scope["operation"] !== compiled.operation ||
          scope["sourceHash"] !== hash(compiled.script) ||
          scope["wireSourceHash"] !== prepared.record.binding.sourceHash ||
          scope["buildHash"] !== codeHash || !same(scope["target"],constrainedTarget))
        fail("PHYSICAL_SCOPE_MISMATCH", "SDK source lacks the broker-verified pre-wrapper compiler scope");
    }
    const selector = prepared.metadataProof
      ? addinMetadataSelector(prepared.outgoing)
      : (constrainedTarget ?? documentSelector(job));
    const request: P.PhysicalTurnRequest = Object.freeze({
      kind: "product", brokerNonce: marker.nonce,
      jobId: job.id, requestId: job.requestId, clientId: job.clientId,
      requestHash: job.hash, grantGeneration: grant.generation,
      physicalRequestId: prepared.rpcId,
      documentSelector: selector ? Object.freeze({ ...selector }) : undefined,
    });
    const binding = required(options.bindPhysicalTurn)(request);
    if (!binding)
      fail(
        "PHYSICAL_BINDING_MISSING",
        "Product SDK dispatch has no original physical binding",
      );
    const physical = pinPhysicalTurn(binding, request, instance);
    if (job.documentContinuation &&
        checkpointGeneration(physical) !== job.documentContinuation.generation)
      fail("DOCUMENT_STATE_CHANGED",
        "Product physical generation differs from the accepted continuation");
    if (job.documentInspection &&
        (checkpointGeneration(physical) !== job.documentInspection.generation ||
         checkpointGeneration(physical) !== currentCheckpointGeneration()))
      fail("DOCUMENT_STATE_CHANGED", "Checkpoint physical turn differs from its current native pin");
    const current = required(state.data.jobs[job.id]);
    const catalogIndex = (current.physicalDispatchCount ?? current.physicalDispatches?.length ?? 0) + 1;
    prepared.record["physicalCatalogIndex"] = catalogIndex;
    prepared.record.binding["physicalTurn"] = physical;
    return {request,physical,catalogIndex};
  }
  function registerPhysicalDispatch(
    job: P.Job,
    request: P.PhysicalTurnRequest,
    physical: P.PhysicalTurnBinding,
    catalogIndex: number,
    dispatch?: {rpcCount:number;completedCount:number;rpcId:string},
  ) {
    const body = { request, physical, target: quarantineTarget(job.request), catalogIndex };
    const intentReference = `physical-turn-${hash(physical.turnId)}.json`;
    const file = path.join(privateDirectory(jobDir(job.id)), intentReference);
    durable(file, body, true);
    const entry = {
      ...body,
      intentReference,
      intentDigest: hash(fs.readFileSync(file)),
    };
    if (dispatch) state.markDispatch(job.id,dispatch,entry);
    else state.recordPhysicalDispatch(job.id,entry);
  }
  function nativeActivity(context: P.Context) {
    if (context.nativeActivityId) return;
    context.nativeActivityId = randomUUID();
    gate.active.set(context.nativeActivityId, Date.now());
    diagnostics();
  }
  function endNativeActivity(context: P.Context | null) {
    if (!context?.nativeActivityId) return;
    gate.active.delete(context.nativeActivityId);
    delete context.nativeActivityId;
    diagnostics();
  }
  async function settleNative(context: P.Context, grant: ProductGrant) {
    const declared = context.turnRpcs.filter((item) =>
      nativeReceipts.start(item.record),
    );
    if (
      !declared.length ||
      context.unknown ||
      context.turnRpcs.some((item) => !item.record.terminal)
    )
      return;
    for (;;) {
      if (lane.currentGrant() !== grant) return;
      let waiting = false;
      for (const item of declared) {
        const proof = nativeReceipts.completion(item.record);
        if (!proof) {
          waiting = true;
          continue;
        }
        item.record.nativeCompletion = proof.native.state;
        if (proof.outcome === "failed") {
          item.record.failed = true;
          context.executionFailed = true;
        }
        executionRecords.recordRpcNativeCompletion(context.job.id, item.record);
      }
      if (!waiting) {
        // A completed native event is an execution fence, not model acceptance.
        context.workflowUnknown = context.turnRpcs.some(
          (item) => item.record.nonterminal && !item.record.nativeCompletion,
        );
        endNativeActivity(context);
        return;
      }
      nativeActivity(context);
      if (required(context.budget).remaining() <= 0 || context.timedOut) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  gate.changed = diagnostics;
  async function checkInstance(probeOptions: P.ProbeOptions) {
    probeOptions.assertCurrent?.();
    const active = activeContext();
    if (buildHash() !== codeHash)
      throw Object.assign(
        new Error(
          "Pinned executable build changed before the instance probe was submitted",
        ),
        {
          code: "BUILD_CHANGED",
          probeNotSubmitted: true,
        },
      );
    const actual = probeOptions?.prepared
      ? await probeOptions.prepared.send()
      : await instanceProbe({
          diagnosticPath: active
            ? path.join(jobDir(active.job.id), "instance-probe-result.json")
            : undefined,
          ...probeOptions,
          requireIdle: false,
        });
    probeOptions.assertCurrent?.();
    if (probeOptions?.prepared && probeOptions.onObservation)
      await probeOptions.onObservation(actual);
    probeOptions.assertCurrent?.();
    if (!sameInstance(actual, instance))
      fail("INSTANCE_CHANGED", "Fusion PID/birth/build identity changed");
    if (probeOptions?.requireIdle !== false && !idle(actual))
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
    const assertCurrent = () => lane.assertCurrent(grant);
    return probeSendScope.run(
      {
        assertCurrent,
        start() {
          assertCurrent();
          if (sent)
            fail("PREPARED_RPC_CONSUMED", "An instance probe cannot be replayed",
            );
          sent = true;
          writeIntent();
        },
      },
      () => checkInstance({ ...options, assertCurrent }),
    );
  }
  function remoteReceipt(
    record: { receipt?: string; binding: P.Binding; instance: P.Instance },
    requireIdle = true,
    saved?: P.RemoteReceipt,
  ): P.RemoteReceipt {
    if (!record.receipt)
      fail(
        "RECEIPT_UNAVAILABLE",
        "This unresolved non-script RPC has no remote terminal completion receipt",
      );
    let value = saved;
    if (value === undefined) {
      try {
        value = readJson<P.RemoteReceipt>(record.receipt);
      } catch {
        fail(
          "RECEIPT_UNAVAILABLE",
          "Matching durable remote terminal receipt is unavailable or unreadable; no probe sent",
        );
      }
    }
    verifyBoundRemoteReceipt(record, value);
    if (requireIdle && !idle(value.instance))
      fail(
        "NATIVE_RECEIPT_REQUIRED",
        "Remote script returned with a native command pending; an existing matching terminal batch receipt is required. Generic queue reconciliation cannot certify it",
      );
    return value;
  }
  function validateAtomicOriginalReceipts(
    job: P.Job,
    originalBuildHash: string,
    originalInstance: P.Instance,
    scopedIdentity?: P.AtomicIdentity,
  ) {
    if (
      !job ||
      job.state !== "needs_reconciliation" ||
      job.request.buildHash !== originalBuildHash ||
      !originalInstance ||
      !sameInstance(instance, originalInstance)
    ) {
      fail(
        "RECEIPT_MISMATCH",
        "Original atomic job build/instance binding changed",
      );
    }
    const directory = privateDirectory(jobDir(job.id));
    const workerIdentityFile = path.join(directory, "worker-identity.json");
    if (fs.existsSync(workerIdentityFile)) {
      const workerIdentity = readJson<{ pid: number; birth: string }>(
        workerIdentityFile,
      );
      try {
        if (processBirth(workerIdentity.pid) === workerIdentity.birth)
          fail(
            "WORKER_PENDING",
            "Original local worker is still alive; scoped observation is not sent",
          );
      } catch (cause) {
        const error = errorInfo(cause);
        if (!["ENOENT", "ESRCH"].includes(error.code ?? "")) throw error;
      }
    } else if (fs.existsSync(path.join(directory, "worker-start.json"))) {
      fail(
        "WORKER_IDENTITY_UNAVAILABLE",
        "Original worker spawn has no durable process identity",
      );
    }
    const active = activeContext();
    if (
      active?.job?.id === job.id &&
      (active.pending?.size || (active.child && !active.workerClosed))
    )
      fail(
        "WORKER_PENDING",
        "Original worker or broker RPC is still pending; scoped observation is not sent",
      );
    const adapterFile = path.join(directory, "adapter-outcome.json");
    if (fs.existsSync(adapterFile)) {
      const adapter = readJson<P.AdapterOutcome>(adapterFile);
      if (
        adapter.jobId !== job.id ||
        adapter.buildHash !== originalBuildHash ||
        adapter.unknown
      )
        fail(
          "ADAPTER_RECONCILIATION_REQUIRED",
          "Original adapter outcome is unvalidated or belongs to another build",
        );
    }
    for (const stage of ["preflight", "postflight"]) {
      const startedPath = path.join(directory, stage + "-start.json");
      if (!fs.existsSync(startedPath)) continue;
      const started = readJson<P.ProbeRecord>(startedPath);
      const binding = started.binding;
      if (
        started.jobId !== job.id ||
        started.buildHash !== originalBuildHash ||
        !sameInstance(started.instance, originalInstance) ||
        binding?.jobId !== job.id ||
        binding?.buildHash !== originalBuildHash ||
        !/^[a-f0-9-]{36}$/.test(binding.rpcId || "") ||
        binding.requestHash !==
          hash(stage + ":" + job.id + ":" + binding.rpcId) ||
        started.receipt !==
          path.join(directory, `${stage}-${binding.rpcId}.receipt.json`)
      ) {
        fail(
          "RECEIPT_MISMATCH",
          `${stage} probe receipt is not bound to the original atomic job/build`,
        );
      }
      remoteReceipt(
        { receipt: started.receipt, binding, instance: started.instance },
        false,
      );
    }
    const names = fs
      .readdirSync(directory)
      .filter(
        (name) => /^rpc-.*\.json$/.test(name) && name !== "rpc-result.json",
      );
    if (names.length !== (job.dispatch?.rpcCount || 0))
      fail(
        "RECEIPT_UNAVAILABLE",
        "Original atomic dispatch journal count is incomplete",
      );
    const atomicRuntimeUnitGroups = [],
      records: P.RecordEvidence[] = [];
    for (const name of names) {
      const file = path.join(directory, name),
        stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 16 * 1024 * 1024
      )
        fail(
          "RECEIPT_UNSAFE",
          "Original atomic dispatch journal is not a bounded regular file",
        );
      const record = readJson<P.RecordEvidence>(file);
      records.push(record);
      if (
        record.binding?.jobId !== job.id ||
        record.binding?.buildHash !== originalBuildHash ||
        !sameInstance(record.instance, originalInstance) ||
        !record.receipt
      )
        fail(
          "RECEIPT_UNAVAILABLE",
          "Original atomic dispatch is not bound to its original build/instance",
        );
      remoteReceipt(record, false);
      atomicRuntimeUnitGroups.push(
        Array.isArray(record.pythonArtifact?.units)
          ? record.pythonArtifact.units
          : [],
      );
      if (record.terminal) {
        if (!record.request || record.request.method !== record.method)
          fail(
            "RECEIPT_MISMATCH",
            "Original terminal RPC has no matching request identity",
          );
        matching(client, record.response, record.wireRequest || record.request);
      }
      const declared = nativeReceipts.start(record);
      if (declared && scopedIdentity) {
        const identity = declared.native?.identity;
        if (
          !identity ||
          identity.commandId !== scopedIdentity.commandId ||
          identity.runId !== scopedIdentity.runId ||
          identity.requestHash !== scopedIdentity.requestHash ||
          identity.backend !== "addin" ||
          identity.sessionNonce !== scopedIdentity.sessionNonce ||
          !same(identity.documentIdentity, scopedIdentity.documentIdentity) ||
          !same(
            identity.resolvedIdentity,
            scopedIdentity.documentIdentity.resolved,
          )
        ) {
          fail(
            "RECEIPT_MISMATCH",
            "Original native declaration differs from the atomic report identity",
          );
        }
      }
    }
    return {
      dispatchCount: names.length,
      originalBuildHash,
      originalInstance,
      atomicRuntimeUnitGroups,
      records,
    };
  }
  async function resumeCheck(resetAuthorization?: P.ResetProof) {
    const file = path.join(dir, "control-resume.json");
    if (state.data.controlBlocked) {
      const prior = readJson<P.ProbeRecord>(file);
      remoteReceipt(prior, false);
      state._commit((d) => {
        delete d.controlBlocked;
        return null;
      });
      setHold(null);
    }
    const rpcId = randomUUID();
    const binding = {
      jobId: "control",
      rpcId,
      requestHash: hash("resume:" + rpcId),
      buildHash: codeHash,
    };
    const record = {
      binding,
      instance,
      receipt: path.join(dir, "control-" + rpcId + ".receipt.json"),
    };
    durable(file, record);
    state._commit((d) => {
      d.controlBlocked = { rpcId };
      return null;
    });
    const resetProbe = resetAuthorization
      ? { ...resetAuthorization, probeRpcId: rpcId }
      : null;
    try {
      const observe = () =>
        checkInstance({
          requireIdle: true,
          receiptPath: record.receipt,
          binding,
        });
      const observation = resetProbe
        ? await resetResumeScope.run(resetProbe, observe)
        : await observe();
      remoteReceipt(record, false);
      state._commit((d) => {
        delete d.controlBlocked;
        return null;
      });
      return observation;
    } catch (cause) {
      const error = errorInfo(cause);
      try {
        remoteReceipt(record, false);
        state._commit((d) => {
          delete d.controlBlocked;
          return null;
        });
      } catch {
        /* Remain recovery-blocked. */
      }
      throw error;
    }
  }

  const lifecycleAdmin = load("./queue-console-admin").createAdmin({
    state,
    gate,
    dir,
    marker,
    buildHash: codeHash,
    getContext: () => ({
      active: activeContext() !== null,
      busy: busy() || rawPreparations > 0,
      stopping: lifetime.stopping,
      held: heldReason(),
    }),
    setBusy: (value) => {
      lane.setAdministrative(value);
    },
    resumeCheck,
    close,
    diagnostics,
    durable,
    readJson,
    hash,
    async observeControlCompletion() {
      const record = readJson<P.ProbeRecord>(
        path.join(dir, "control-resume.json"),
      );
      const receipt = remoteReceipt(record, false);
      setHold(null);
      return receipt;
    },
  });
  const lifecycleControl = load(
    "./dist/node-adapters/broker-ipc/lifecycle",
  ).createLifecycleDispatcher({
    gate,
    admin: lifecycleAdmin,
    dir,
    buildHash: codeHash,
    resumeCheck,
    authorizeResetResume,
    diagnostics,
    beforeNewResume() {
      if (lifetime.stopping) fail("BROKER_STOPPING", "Broker is stopping");
    },
    canResume() {
      if (
        (heldReason() && !state.data.controlBlocked) ||
        state.summary().blocked ||
        state.data.localUnknown
      ) {
        fail(
          "RECONCILIATION_REQUIRED",
          "Resolve the held instance/job before resuming",
        );
      }
    },
  });

  function originalFusionProcessAlive(identity: P.Instance) {
    if (
      options.createBackend &&
      typeof options.testFusionProcessAlive === "function"
    )
      return options.testFusionProcessAlive(identity) === true;
    return priorProcessAlive(identity) === true;
  }

  function atomicObservationFence(
    scope: P.ObservationScope,
    inFlight: boolean,
  ) {
    scope.assertGrant();
    if (!scope.prepared.atomicRuntimeAbi)
      fail(
        "BUILD_CHANGED",
        "Scoped atomic status has no verified original runtime ABI proof",
      );
    assertResetSubmissionOpen(dir);
    const currentIdentity = readJson<P.Identity>(identityFile);
    if (
      currentIdentity.configHash !== configHash ||
      currentIdentity.buildHash !== scope.instanceBuildHash ||
      !sameInstance(currentIdentity.instance, scope.expectedInstance)
    ) {
      fail(
        "INSTANCE_CHANGED",
        "Durable Fusion identity changed before atomic holder observation",
      );
    }
    verifyAtomicObservationFence({
      prepared: scope.prepared,
      jobId: scope.targetJob.id,
      observerJobId: scope.observerJob.id,
      clientId: scope.clientId,
      state: state.data,
      initialState: scope.initialState,
      initialActiveIds: scope.initialActiveIds,
      activeIds: [...gate.active.keys()],
      originalActiveIds: scope.originalActiveIds,
      inFlight,
      resetActive: fs.existsSync(path.join(dir, "fusion-reset.lock")),
      owner: readJson(lock),
      expectedOwner: marker,
      buildHash: buildHash(),
      expectedBuildHash: codeHash,
      instance,
      expectedInstance: scope.expectedInstance,
      instanceAlive: originalFusionProcessAlive(scope.expectedInstance),
      resuming: gate.resuming,
      adminTransition: gate.adminTransition,
    });
    if (lifetime.stopping || !busy())
      fail("BROKER_STOPPING", "Broker is not available for scoped observation");
  }

  async function scopedAtomicObservationPost(
    payload: P.Rpc,
    sessionId: string | undefined,
    scope: P.ObservationScope,
  ) {
    if (["initialize", "notifications/initialized"].includes(payload?.method)) {
      return gate.administrative(() =>
        gate.run(() => {
          atomicObservationFence(scope, true);
          return originalPost(payload, sessionId);
        }),
      );
    }
    if (
      scope.toolStarted ||
      payload?.method !== "tools/call" ||
      payload.params?.name !== "execute_python"
    ) {
      fail(
        "WORKFLOW_OBSERVATION_NOT_ALLOWED",
        "Scoped atomic observation permits only one broker-generated execute_python call",
      );
    }
    const args = payload.params?.arguments;
    if (
      !args ||
      args.persistent !== false ||
      args.session_id !== undefined ||
      args.code !== scope.expectedToolCode ||
      Object.keys(args).some((key) => !["code", "persistent"].includes(key))
    ) {
      fail(
        "WORKFLOW_OBSERVATION_NOT_ALLOWED",
        "Physical request differs from the pinned atomic_status script",
      );
    }
    return load("./dist/core/application/execution").dispatchPrepared({
      prepare() {
        const nextRpcId = randomUUID();
        scope.rpcId = nextRpcId;
        const receipt = path.join(
          jobDir(scope.observerJob.id),
          `atomic-observation-${nextRpcId}.receipt.json`,
        );
        return load("./queue-atomic-wire").prepareAtomicObservationWire({
          payload,
          rpcId: nextRpcId,
          observerJobId: scope.observerJob.id,
          targetJobId: scope.targetJob.id,
          codeHash,
          identity: scope.prepared.identity,
          instance,
          receipt,
          originArtifact: scope.prepared.artifact,
          atomicRuntimeAbi: scope.prepared.atomicRuntimeAbi,
          dispatchTimeoutMs: Math.max(
            1,
            Math.min(
              scope.observerJob.timeoutMs,
              client.server.timeoutMs || scope.observerJob.timeoutMs,
            ),
          ),
        });
      },
      async check(prepared) {
        await queueAdmission.checkPrepared(prepared);
      },
      admit(send) {
        return gate.administrative(() => gate.run(send));
      },
      fence(prepared) {
        atomicObservationFence(scope, true);
        const userSourceUnit = prepared.pythonArtifact?.units?.find(
          (unit) => unit.role === "user",
        );
        if (
          !prepared.pythonArtifact ||
          !prepared.outgoing.params?.arguments ||
          prepared.outgoing.params.arguments.code !==
            prepared.pythonArtifact.script ||
          userSourceUnit?.sha256 !== prepared.record.binding.sourceHash
        )
          fail(
            "WORKFLOW_ARTIFACT_CHANGED",
            "Final atomic status Python bytes changed after preparation",
          );
        assertAtomicObservationWire(
          prepared.outgoing.params.arguments.code,
          prepared.pythonArtifact,
        );
        queueAdmission.fencePrepared(prepared, codeHash);
        if (scope.toolStarted)
          fail(
            "WORKFLOW_OBSERVATION_REPLAY",
            "This exact atomic holder observation was already submitted",
          );
        if (fs.existsSync(scope.startPath) || fs.existsSync(scope.resultPath))
          fail(
            "WORKFLOW_OBSERVATION_REPLAY",
            "An earlier scoped observation receipt already exists; no SDK request sent",
          );
        const observer = required(state.data.jobs[scope.observerJob.id]);
        if (
          observer.state !== "running" ||
          observer.workflowObservation?.targetJobId !== scope.targetJob.id ||
          observer.clientId !== scope.clientId
        )
          fail(
            "WORKFLOW_OWNER_OR_JOB_MISMATCH",
            "Observation job owner/state changed before send",
          );
        const directory = jobDir(scope.observerJob.id);
        const journal = path.join(directory, `rpc-${prepared.rpcId}.json`);
        durable(journal, prepared.record, true);
        const dispatch = observer.dispatch || {
          rpcCount: 0,
          completedCount: 0,
        };
        state.markDispatch(scope.observerJob.id, {
          rpcCount: dispatch.rpcCount + 1,
          completedCount: dispatch.completedCount,
          rpcId: prepared.rpcId,
          rpcState: "sending",
        });
        durable(
          scope.startPath,
          {
            version: 1,
            kind: scope.prepared.scope.kind,
            observerJobId: scope.observerJob.id,
            observerRequestId: scope.observerJob.requestId,
            targetJobId: scope.targetJob.id,
            targetRequestId: scope.targetJob.requestId,
            clientId: scope.clientId,
            projectDirectory: scope.prepared.scope.projectDirectory,
            reportPath: scope.prepared.scope.reportPath,
            reportFingerprint: scope.prepared.reportFingerprint,
            identity: scope.prepared.identity,
            originalBuildHash: scope.targetJob.request.buildHash,
            originalInvocationHash: scope.prepared.originalInvocationHash,
            sourceEnvelope: scope.prepared.sourceEnvelope,
            atomicRuntimeAbi: scope.prepared.atomicRuntimeAbi.proof,
            atomicRuntimeAbiHash: scope.prepared.atomicRuntimeAbi.hash,
            observerBuildHash: codeHash,
            instance,
            owner: marker,
            initialGate: scope.initialState,
            binding: prepared.record.binding,
            receipt: prepared.record.receipt,
            at: new Date().toISOString(),
          },
          true,
        );
        scope.toolStarted = true;
        scope.rpcJournal = journal;
      },
      send(prepared) {
        const read = systemReadTurn({
          binding: prepared.record.binding,
          receiptPath: required(prepared.record.receipt),
          documentSelector: {creationId: scope.prepared.identity.resolvedIdentity.creationId,
            },
        }, "atomic-holder-status",
        );
        return read(() => withRequest({ timeoutMs: prepared.dispatchTimeoutMs }, () =>
          originalPost(prepared.outgoing, sessionId),
          ),
        );
      },
      settle(prepared, response: P.Response) {
        scope.assertGrant();
        const reply = matching(client, response, prepared.outgoing);
        const failed = !!(reply?.error || object(reply?.result)["isError"]);
        const receipt = remoteReceipt(prepared.record, false);
        if (!failed && receipt.outcome !== "succeeded")
          fail(
            "WORKFLOW_OBSERVATION_FAILED",
            "Atomic status receipt is not a successful read-only completion",
          );
        let summary = null;
        if (!failed) summary = atomicStatusSummaryFromReply(reply);
        const identityMatches = summary?.identity
          ? same(summary.identity, scope.prepared.identity)
          : false;
        const proof = {
          version: 1,
          kind: scope.prepared.scope.kind,
          observerJobId: scope.observerJob.id,
          observerRequestId: scope.observerJob.requestId,
          targetJobId: scope.targetJob.id,
          targetRequestId: scope.targetJob.requestId,
          clientId: scope.clientId,
          projectDirectory: scope.prepared.scope.projectDirectory,
          reportPath: scope.prepared.scope.reportPath,
          reportFingerprint: scope.prepared.reportFingerprint,
          identity: scope.prepared.identity,
          identityMatches,
          originalInvocationHash: scope.prepared.originalInvocationHash,
          sourceEnvelope: scope.prepared.sourceEnvelope,
          atomicRuntimeAbi: scope.prepared.atomicRuntimeAbi.proof,
          atomicRuntimeAbiHash: scope.prepared.atomicRuntimeAbi.hash,
          originalBuildHash: required(scope.targetJob.request.buildHash),
          observerBuildHash: codeHash,
          observerInstance: instance,
          rpcId: prepared.rpcId,
          readOnlyOperation: "atomic_status",
          binding: prepared.record.binding,
          receipt: required(prepared.record.receipt),
          remoteOutcome: receipt.outcome,
          summary,
          toolFailed: failed,
          at: new Date().toISOString(),
        };
        const safeReply = {
          jsonrpc: "2.0",
          id: prepared.outgoing.id,
          result: {
            ...(failed ? { isError: true } : {}),
            content: [
              {
                type: "text",
                text:
                  "FMCAD_RESULT " +
                  JSON.stringify(summary || { status: "unavailable" }),
              },
            ],
          },
        };
        const safeResponse = { ...response, raw: JSON.stringify(safeReply) };
        prepared.record.terminal = true;
        prepared.record.failed = failed || receipt.outcome !== "succeeded";
        prepared.record.response = safeResponse;
        prepared.record.remoteReceipt = receipt;
        durable(required(scope.rpcJournal), prepared.record);
        const current = required(state.status(scope.observerJob.id).dispatch);
        state.markDispatch(scope.observerJob.id, {
          rpcCount: current.rpcCount,
          completedCount: current.completedCount + 1,
          rpcId: prepared.rpcId,
          rpcState: "terminal",
        });
        durable(scope.resultPath, proof, true);
        scope.proof = proof;
        return responseForCaller(safeResponse, payload, safeReply);
      },
      unknown(error) {
        const observer = scope.observerContext;
        if (observer) observer.unknown = true;
        const turnGrant = lane.currentGrant();
        if (turnGrant && turnGrant.context.worker === observer)
          hold(
            turnGrant,
            "Atomic status observation reply is unknown; no second observation will be sent",
          );
        try {
          durable(
            path.join(
              jobDir(scope.observerJob.id),
              `atomic-observation-${scope.rpcId || "unknown"}.uncertain.json`,
            ),
            {
              version: 1,
              kind: scope.prepared.scope.kind,
              observerJobId: scope.observerJob.id,
              targetJobId: scope.targetJob.id,
              observerBuildHash: codeHash,
              code: errorInfo(error).code || "UNKNOWN",
            },
            true,
          );
        } catch {
          /* The immutable start record remains the no-replay fence. */
        }
      },
    });
  }

  async function prepareOwnedPost(
    payload: P.Rpc,
    job: Pick<P.Job, "id"> & Partial<Pick<P.Job, "request">>,
    origin?: P.Origin,
    rawMetadata = false,
  ): Promise<P.PreparedCall> {
    // User jobs need the explicit root grant. Broker-owned startup metadata has
    // no client request and remains bound by its private administrative scope
    // and the native physical grant at the dispatch boundary.
    const epochPolicy = state.epoch || (approvedRuntimeRoot && job.request)
      ? admitEpochRequest(job.request)
      : null;
    const contextEpoch = state.data.contextEpoch || 0;
    const rpcId = randomUUID();
    const binding: P.Binding = {
      jobId: job.id,
      rpcId,
      requestHash: hash(JSON.stringify(payload)),
      buildHash: codeHash,
    };
    if (state.epoch && state.admissionMode !== "normal-multidocument")
      Object.assign(binding, {
        isolatedEpoch: state.epoch.epochId,
        qualifiedDocumentHash: hash(JSON.stringify(state.epoch.document)),
        auditExpectedInstance: state.epoch.currentInstance,
        auditExpectedDocument: state.epoch.document,
      });
    if (epochPolicy?.kind === "saved-first-save")
      Object.assign(binding, {
        purpose: epochPolicy.purpose,
        auditFirstSave: true,
      });
    const request: P.Rpc = { jsonrpc: "2.0", method: payload.method };
    if (own(payload, "id")) request.id = payload.id;
    const record: P.RecordEvidence = {
      binding,
      instance,
      request,
      terminal: false,
      method: payload.method,
    };
    const outgoing = structuredClone(payload);
    let pythonArtifact;
    // Different SDK clients may all use id=1/2. A unique wire ID prevents an
    // old/cross-session HTTP reply from matching another client's invocation.
    if (own(outgoing, "id")) outgoing.id = "fmcad:" + rpcId;
    record.wireRequest = {
      jsonrpc: "2.0",
      method: outgoing.method,
      ...(own(outgoing, "id") ? { id: outgoing.id } : {}),
    };
    if (payload.method === "tools/call") {
      isolatedTool(outgoing.params?.name, outgoing.params?.arguments);
      pythonArtifact = prepareBrokerScript(outgoing, {
        nativeMcp: cfg.backend === "mcp",
        bindSource(source, nativePublicPython) {
          record.receipt = path.join(jobDir(job.id), `remote-${rpcId}.json`);
          binding.sourceHash = hash(source);
          const local = preparingJob.getStore();
          if (local && local.job.id === job.id && local.compiledScope)
            binding["documentScope"] = {
              ...local.compiledScope,wireSourceHash:binding.sourceHash,
            };
          if (nativePublicPython)
            binding["publicPythonResultSchema"] = "fmcad-public-python-result-v1";
        },
        wrap(executable, official, nativePublicPython) {
          const prepared = prepareReceiptScript(
            executable,
            official,
            required(record.receipt),
            binding,
            {
              ...nativePaths,
              ...(nativePublicPython ? { capturePublicPythonResult: true } : {}),
            },
          );
          return origin ? retainPythonOrigin(prepared, origin) : prepared;
        },
      });
      if (pythonArtifact) {
        record.pythonArtifact = {
          version: pythonArtifact.version,
          sha256: pythonArtifact.sha256,
          artifactHash: pythonArtifact.artifactHash,
          sourceMap: pythonArtifact.sourceMap,
          units: pythonArtifact.units.map(({ id, filename, role, sha256 }) => ({
            id,
            filename,
            role,
            sha256,
          })),
        };
      }
    }
    const metadataOnly = [
      "initialize",
      "notifications/initialized",
      "ping",
      "tools/list",
    ].includes(payload.method);
    let prepared: P.PreparedCall;
    if (rawMetadata) {
      if (!metadataAdmission)
        fail("unsupported_queue_route", "ADDIN metadata admission is not provisioned",
        );
      const metadataProof = prepareMetadataWire(outgoing);
      record.dispatchClass = "addin-metadata";
      prepared = {
        outgoing: metadataProof.wire,
        record,
        rpcId,
        contextEpoch,
        metadataOnly,
        metadataProof,
      };
    } else {
      const pythonCertificate = await pythonAdmission.check(
        outgoing,
        pythonArtifact,
        localCheckOptions(),
      );
      if (pythonCertificate.report) record.pythonCheck = pythonCertificate.report;
      record.dispatchClass = pythonCertificate.kind;
      prepared = {
        outgoing, record, rpcId, pythonArtifact, contextEpoch, metadataOnly, pythonCertificate,
      };
    }
    // Test observer may suspend local preparation, never replace checking.
    if (!prepared.metadataProof) await options.testCheckPrepared?.(prepared);
    (prepared.metadataProof ?? prepared.pythonCertificate).fence(prepared.outgoing,
    );
    verifyPreparedJob(job, prepared.contextEpoch);
    return prepared;
  }

  function prepareOwnedTurn(
    payload: P.Rpc,
    job: Parameters<typeof prepareOwnedPost>[1],
    turn: TurnIdentity,
    origin?: P.Origin,
    rawMetadata = false,
  ) {
    return brokerExecution.prepare(turn, () =>
      prepareOwnedPost(payload, job, origin, rawMetadata),
    );
  }

  function retainDispatchFailure(
    context: P.Context,
    error: unknown,
    failure: DispatchFailure<P.PreparedCall>,
  ) {
    // Error messages, causes and child output may contain script/headers/tokens.
    // Read only own data fields and retain a closed vocabulary, never getters.
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
        causeCode = field("causeCode");
      const transportPhase = field("transportPhase");
      const prepared = failure.prepared;
      const binding = prepared?.record.binding;
      const rpcIdentityMatches =
        !!binding &&
        binding.jobId === context.job.id &&
        binding.buildHash === codeHash &&
        binding.rpcId === prepared?.rpcId;
      durable(
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
          buildHash: codeHash,
          phase: failure.phase,
          // This is the local send boundary, not proof of remote SDK entry.
          submitted: failure.submitted,
          code: typeof code === "string" && codes.has(code) ? code : null,
          causeCode:
            typeof causeCode === "string" && codes.has(causeCode)
              ? causeCode
              : null,
          transportPhase:
            typeof transportPhase === "string" &&
            [
              "spawn",
              "process",
              "stdin",
              "output",
              "response",
              "observation",
            ].includes(transportPhase)
              ? transportPhase
              : null,
          rpcIdentityMatches,
          rpc: rpcIdentityMatches
            ? {
                jobId: binding!.jobId,
                rpcId: binding!.rpcId,
                requestHash: binding!.requestHash,
                buildHash: binding!.buildHash,
              }
            : null,
          worker: {
            pid: context.child?.pid ?? null,
            identity: "worker-identity.json",
            start: "worker-start.json",
            result: "worker-result.json",
          },
        },
        true,
      );
    } catch {
      // Diagnostics must never prevent unknown classification or permit replay.
      diagnostics();
    }
  }

  // All adapter calls eventually cross this one physical dispatch boundary.
  const physicalPost = async function (
    payload: P.Rpc,
    sessionId?: string,
    requestOptions?: unknown,
    ready?: PostPreparation,
  ) {
    const recoveryAudit = atomicRecoveryAuditScope.getStore();
    if (recoveryAudit) return recoveryAudit.post(payload, sessionId);
    const atomicObservation = atomicObservationScope.getStore();
    if (atomicObservation)
      return scopedAtomicObservationPost(payload, sessionId, atomicObservation);
    const grant = physicalGrant.getStore();
    const administrative = gate.scope.getStore()?.administrative === true;
    if (administrative || !grant) {
      if (
        ready?.kind === "owned" ||
        (!administrative && activeContext()?.productTurn)
      )
        fail("PREPARED_RPC_UNAVAILABLE", "No active grant for the prepared RPC",
        );
      return unownedPost(payload, sessionId, requestOptions, ready?.checked);
    }
    const context = required(grant.context.worker);
    let admission: ReturnType<NonNullable<typeof metadataAdmission>["bind"]> | undefined;
    let receivedAdmission: P.Response | undefined;
    const tracePreflight = context.job.kind === "rpc";
    const startedAt = Date.now();
    if (tracePreflight)
      writeRequestTrace(context.job.request, context.job.clientId, {
        stage: "preflight",
        status: "started",
        jobId: context.job.id,
        buildHash: codeHash,
        stdoutObservation: "not_observed",
      });
    let turn: OwnedTurn;
    try {
      if (ready?.kind === "unowned")
        fail(
          "PREPARED_RPC_UNAVAILABLE",
          "Owned RPC lost its original prepared record",
        );
      turn =
        ready?.turn ??
        (await prepareOwnedTurn(payload, context.job, grant.turn));
      if (tracePreflight)
        turn.inspect((prepared) =>
          debugPreflightStarted.set(prepared, startedAt),
        );
    } catch (error) {
      if (tracePreflight)
        writeRequestTrace(context.job.request, context.job.clientId, {
          stage: "preflight",
          status: "failed",
          jobId: context.job.id,
          buildHash: codeHash,
          stdoutObservation: "not_observed",
        });
      required(context.localDispatchErrors).add(error);
      retainDispatchFailure(context, error, {
        phase: "prepare",
        submitted: false,
        prepared: undefined,
      });
      throw error;
    }
    return brokerExecution.executeTurn(grant, turn, {
      assertCurrentGrant(current) {
        lane.assertCurrent(current);
        if (
          current.context.worker !== context ||
          state.data.active !== current.jobId ||
          context.workerClosed ||
          context.unknown ||
          state.summary().blocked
        )
          fail(
            "RECONCILIATION_REQUIRED",
            "Original SDK ownership changed before send",
          );
        if (context.timedOut)
          fail("RUN_TIMEOUT", "Worker execution deadline expired before send");
      },
      check(prepared) {
        try {
          (prepared.metadataProof ?? prepared.pythonCertificate).fence(prepared.outgoing,
          );
        } catch (error) {
          if (context.job.kind === "rpc")
            writeRequestTrace(context.job.request, context.job.clientId, {
              stage: "preflight",
              status: "failed",
              jobId: context.job.id,
              buildHash: codeHash,
              stdoutObservation: "not_observed",
            });
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
          assertResetSubmissionOpen(dir);
          if (state.epoch || approvedRuntimeRoot) admitEpochRequest(context.job.request);
          if (
            prepared.record.binding.jobId !== context.job.id ||
            !sameInstance(prepared.record.instance, instance)
          )
            fail(
              "RECONCILIATION_REQUIRED",
              "Prepared SDK binding changed before send",
            );
          if (context.contextEpoch !== (state.data.contextEpoch || 0))
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
          if (buildHash() !== codeHash)
            fail("BUILD_CHANGED", "Pinned executable changed before dispatch");
          for (const input of context.job.request.inputFiles || []) {
            if (
              hash(
                fs.readFileSync(
                  path.resolve(required(context.job.request.cwd), input.path),
                ),
              ) !== input.sha256
            )
              fail("INPUT_CHANGED", "Pinned input changed before dispatch");
          }
          if (prepared.metadataProof)
            prepared.metadataProof.fence(prepared.outgoing);
          else fencePreparedWire(prepared);
          const { record, rpcId } = prepared;
          const dispatchRemaining = Math.ceil(
            Math.min(
              required(context.budget).remaining(),
              context.rpcBudget?.remaining() ?? Infinity,
            ),
          );
          if (dispatchRemaining <= 0)
            fail(
              "RUN_TIMEOUT",
              "Active execution budget expired during Python preparation; no RPC sent",
            );
          if (prepared.metadataProof) {
            if (!metadataAdmission || ready?.kind !== "owned" || context.job.kind !== "rpc")
              fail("PREPARED_RPC_UNAVAILABLE", "Missing owned ADDIN metadata route",
              );
            if (
              record.binding.rpcId !== rpcId ||
              record.wireRequest?.id !== `fmcad:${rpcId}` ||
              prepared.metadataProof.wire.id !== record.wireRequest.id
            )
              fail("PREPARED_RPC_UNAVAILABLE", "ADDIN metadata identity changed before send",
              );
            assertFrozenMetadataObservation(context.job.request, prepared.metadataProof.wire,
              required(ready.metadataObservation),
            );
            admission = metadataAdmission.bind(
              prepared.metadataProof.wire,
              ready.metadataObservation,
              record.instance,
              context.job.clientId,
              rpcId,
              dispatchRemaining,
            );
            record.binding["addinAdmission"] = admission.binding;
          }
          const before = state.status(context.job.id).dispatch;
          const count = (before?.rpcCount || 0) + 1;
          record.dispatchIndex = count;
          const physical = bindProductPhysicalTurn(grant, prepared);
          const journal = executionRecords.createRpcIntent(context.job.id, record,
          );
          context.turnRpcs.push({ record, journal });
          const dispatch = {
            rpcCount: count,
            completedCount: before?.completedCount || 0,
            rpcId,
          };
          if (physical)
            registerPhysicalDispatch(context.job,physical.request,physical.physical,physical.catalogIndex,dispatch);
          else state.markDispatch(context.job.id,dispatch);
          context.dispatched = true;
          Object.assign(prepared, { journal, dispatchRemaining });
          if (context.job.kind === "rpc") {
            const startedAt = debugPreflightStarted.get(prepared);
            writeRequestTrace(context.job.request, context.job.clientId, {
              stage: "preflight",
              status: "passed",
              jobId: context.job.id,
              buildHash: codeHash,
              ...(startedAt === undefined
                ? {}
                : { durationMs: Date.now() - startedAt }),
              stdoutObservation: "not_observed",
            });
          }
        } catch (error) {
          if (context.job.kind === "rpc")
            writeRequestTrace(context.job.request, context.job.clientId, {
              stage: "preflight",
              status: "failed",
              jobId: context.job.id,
              buildHash: codeHash,
              stdoutObservation: "not_observed",
            });
          throw error;
        }
      },
      send: async (prepared) => {
        assertPhysicalIsolationAuthority();
        const startedAt = Date.now();
        debugDispatchStarted.set(prepared, startedAt);
        writeRequestTrace(context.job.request, context.job.clientId, {
          stage: "sdk-dispatch",
          status: "started",
          jobId: context.job.id,
          rpcId: prepared.rpcId,
          buildHash: prepared.record.binding.buildHash,
          sourceHash: prepared.record.binding.sourceHash,
          sdkPid: instance.pid,
          sdkBirth: instance.birth,
          sdkVersion: instance.version,
          stdoutObservation: "not_observed",
        });
        try {
          if (prepared.metadataProof)
            assertFrozenMetadataObservation(context.job.request, prepared.metadataProof.wire,
              required(ready?.kind === "owned" ? ready.metadataObservation : undefined,
              ),
            );
          const sendPhysical = async () => prepared.metadataProof
            ? await postAddinAdmission(
                required(admission).scope,
                prepared.metadataProof.wire,
                required(prepared.dispatchRemaining),
                required(admission),
              )
            : await withRequest(
                { timeoutMs: required(prepared.dispatchRemaining) },
                () => originalPost(prepared.outgoing, sessionId, requestOptions),
               );
          const bound = state.data.jobs[
            context.job.id
          ]?.physicalDispatches?.find(
            (entry) => entry.physical.turnId === prepared.rpcId,
          )?.physical;
          if (
            physicalIsolation &&
            (!bound || !same(bound, prepared.record.binding["physicalTurn"]))
          )
            fail(
              "PHYSICAL_BINDING_MISSING",
              "Every physical product dispatch requires its complete original intent",
            );
          const response = physicalIsolation
            ? await required(options.withPhysicalTurn)(
                required(bound), sendPhysical,
              )
            : await sendPhysical();
          if (prepared.metadataProof) receivedAdmission = response;
          writeRequestTrace(context.job.request, context.job.clientId, {
            stage: "sdk-dispatch",
            status: "passed",
            jobId: context.job.id,
            rpcId: prepared.rpcId,
            buildHash: prepared.record.binding.buildHash,
            sourceHash: prepared.record.binding.sourceHash,
            sdkPid: instance.pid,
            sdkBirth: instance.birth,
            sdkVersion: instance.version,
            durationMs: Date.now() - startedAt,
            stdoutObservation: "not_observed",
          });
          return response;
        } catch (error) {
          writeRequestTrace(context.job.request, context.job.clientId, {
            stage: "sdk-dispatch",
            status: "failed",
            jobId: context.job.id,
            rpcId: prepared.rpcId,
            buildHash: prepared.record.binding.buildHash,
            sourceHash: prepared.record.binding.sourceHash,
            sdkPid: instance.pid,
            sdkBirth: instance.birth,
            sdkVersion: instance.version,
            durationMs: Date.now() - startedAt,
            stdoutObservation: "not_observed",
          });
          throw error;
        }
      },
      settle(prepared, response: P.Response) {
        lane.assertCurrent(grant);
        const { outgoing, record, rpcId, journal } = prepared;
        const trace = debugTraceContext(
          context.job.request,
          context.job.clientId,
        );
        const rawSummary = trace
          ? summarizeBrokerRaw(response.raw)
          : undefined;
        if (trace) debugRawReceived.add(prepared);
        // A returned HTTP response is transport evidence, not SDK settlement.
        // Persist it before matching/receipt validation can throw; otherwise a
        // missing remote receipt discards the only original error response.
        try {
          executionRecords.recordReceivedResponse(context.job.id, {
            version: 1,
            kind: "owned-rpc-received-response-v1",
            binding: record.binding,
            wireId: outgoing.id,
            response,
          });
        } catch (error) {
          if (trace)
            writeRequestTrace(context.job.request, context.job.clientId, {
              stage: "raw-received",
              status: "failed",
              jobId: context.job.id,
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
        if (trace)
          writeRequestTrace(context.job.request, context.job.clientId, {
            stage: "raw-received",
            status:
              response.status >= 200 && response.status < 300
                ? "passed"
                : "failed",
            jobId: context.job.id,
            rpcId,
            buildHash: record.binding.buildHash,
            sourceHash: record.binding.sourceHash,
            sdkPid: instance.pid,
            sdkBirth: instance.birth,
            sdkVersion: instance.version,
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
            ? matchMetadataEvidence(response, required(admission).binding, record.binding.rpcId, outgoing.id, decodeAdmissionJson,
              )
            : matching(client, response, outgoing);
        } catch (error) {
          if (trace)
            writeRequestTrace(context.job.request, context.job.clientId, {
              stage: "parsed",
              status: "failed",
              jobId: context.job.id,
              rpcId,
              buildHash: record.binding.buildHash,
              sourceHash: record.binding.sourceHash,
              sdkPid: instance.pid,
              sdkBirth: instance.birth,
              sdkVersion: instance.version,
              code:
                error && typeof error === "object" && "code" in error
                  ? String(error.code)
                  : undefined,
              ...(rawSummary ? rawSummary : {}),
              ...(rawSummary
                ? { stdoutObservation: rawSummary.stdoutObservation }
                : { stdoutObservation: "not_observed" as const }),
            });
          throw error;
        }
        if (trace)
          writeRequestTrace(context.job.request, context.job.clientId, {
            stage: "parsed",
            status: "passed",
            jobId: context.job.id,
            rpcId,
            buildHash: record.binding.buildHash,
            sourceHash: record.binding.sourceHash,
            sdkPid: instance.pid,
            sdkBirth: instance.birth,
            sdkVersion: instance.version,
            ...(rawSummary ? rawSummary : {}),
            ...(rawSummary
              ? { stdoutObservation: rawSummary.stdoutObservation }
              : { stdoutObservation: "not_observed" as const }),
          });
        if (
          payload.method === "tools/list" &&
          !reply?.error &&
          !Array.isArray(object(reply?.result)["tools"])
        )
          fail("UNKNOWN_RPC", "Malformed tools/list response");
        let receipt: P.RemoteReceipt | null;
        try {
          receipt = record.receipt ? remoteReceipt(record, false) : null;
        } catch (error) {
          writeRequestTrace(context.job.request, context.job.clientId, {
            stage: "native-receipt",
            status: "unknown",
            jobId: context.job.id,
            rpcId,
            buildHash: record.binding.buildHash,
            sourceHash: record.binding.sourceHash,
            sdkPid: instance.pid,
            sdkBirth: instance.birth,
            sdkVersion: instance.version,
            code:
              error && typeof error === "object" && "code" in error
                ? String(error.code)
                : undefined,
            stdoutObservation: "not_observed",
          });
          throw error;
        }
        writeRequestTrace(context.job.request, context.job.clientId, {
          stage: "native-receipt",
          status: receipt ? "passed" : "not_observed",
          jobId: context.job.id,
          rpcId,
          buildHash: record.binding.buildHash,
          sourceHash: record.binding.sourceHash,
          sdkPid: instance.pid,
          sdkBirth: instance.birth,
          sdkVersion: instance.version,
          stdoutObservation: "not_observed",
        });
        const callerResponse = prepared.metadataProof
          ? { status: response.status, raw: "" } : response;
        const returned = record.binding["publicPythonResultSchema"] &&
          receipt?.outcome === "succeeded"
          ? decodeBoundPublicPythonResponse(record, receipt, payload, callerResponse, reply,
              )
          : responseForCaller(callerResponse, payload, reply);
        const declaration = nativeReceipts.start(record);
        const nativeEnd = declaration
          ? nativeReceipts.completion(record, declaration)
          : null;
        const failed = load(
          "./dist/core/application/execution",
        ).executionFailed({
          transportFailed: !!(reply?.error || object(reply?.result)["isError"]),
          receiptOutcome: receipt?.outcome,
          nativeOutcome: nativeEnd?.outcome,
        });
        if (failed) context.executionFailed = true;
        context.lastRpc = { rpcId, failed, record, journal: required(journal) };
        const typedNonterminal =
          workflowOutputNonterminal(reply?.result) ||
          !!(declaration && !nativeEnd);
        const nonterminal =
          (context.job.kind === "rpc" || context.job.request.phased) &&
          typedNonterminal;
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
        executionRecords.recordRpcTerminal(context.job.id, record);
        const current = required(state.status(context.job.id).dispatch);
        state.markDispatch(context.job.id, {
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
          // Keep the original bytes, not a terminal outcome, if the grant
          // was revoked or ADDIN returned nonterminal evidence.
          try {
            const rejected = object(error);
            const raw = rejected["rawResponse"];
            const response = receivedAdmission ??
              (typeof raw === "string" && same(rejected["admissionBinding"], admission.binding)
                ? { status: 200, raw }
                : undefined);
            if (
              response &&
              !executionRecords.evidence.readReceivedResponse(context.job.id, prepared.rpcId,
              )
            )
              executionRecords.recordReceivedResponse(context.job.id, {
                version: 1,
                kind: "owned-rpc-received-response-v1",
                binding: prepared.record.binding,
                wireId: prepared.outgoing.id,
                response,
              });
          } catch {
            // The original immutable intent still prevents replay.
          }
        }
        if (prepared && !debugRawReceived.has(prepared))
          writeRequestTrace(context.job.request, context.job.clientId, {
            stage: "raw-received",
            status: "unknown",
            jobId: context.job.id,
            rpcId: prepared.rpcId,
            buildHash: prepared.record.binding.buildHash,
            sourceHash: prepared.record.binding.sourceHash,
            sdkPid: instance.pid,
            sdkBirth: instance.birth,
            sdkVersion: instance.version,
            stdoutObservation: "not_observed",
          });
        hold(
          grant,
          "Physical RPC outcome is unknown; observe the durable receipt without replay",
        );
        retainDispatchFailure(context, error, failure);
      },
      notSubmitted(error, failure) {
        required(context.localDispatchErrors).add(error);
        const prepared = failure.prepared;
        const code = object(error)["code"];
        if (prepared?.metadataProof && typeof code === "string")
          context.preconditionCode = code;
        if (prepared && !debugRawReceived.has(prepared))
          writeRequestTrace(context.job.request, context.job.clientId, {
            stage: "raw-received",
            status: "not_observed",
            jobId: context.job.id,
            rpcId: prepared.rpcId,
            buildHash: prepared.record.binding.buildHash,
            sourceHash: prepared.record.binding.sourceHash,
            sdkPid: instance.pid,
            sdkBirth: instance.birth,
            sdkVersion: instance.version,
            stdoutObservation: "not_observed",
          });
        retainDispatchFailure(context, error, failure);
      },
    });
  };
  postPrepared = physicalPost;
  client._post = (payload, sessionId, requestOptions) => {
    return physicalPost(payload, sessionId, requestOptions);
  };

  function owned(id: string, clientId: string) {
    const job = state.status(id);
    if (job.clientId !== clientId)
      fail(
        "NOT_OWNER",
        "Only the submitting client may access this job result",
      );
    return job;
  }
  function outputs(id: string) {
    const job = state.lookup(id);
    const result = load("./queue-response-files").jobOutputs(dir, job);
    result.provenance = load(
      "./dist/node-adapters/persistence/accepted-inputs",
    ).readAdmission(dir, job);
    const outcome = path.join(jobDir(id), "outcome.json");
    if (fs.existsSync(outcome)) result.execution = readJson(outcome);
    // Reports are owner-only results, never part of the public status allowlist.
    // Preserve the broker's report bytes; observers do not run another checker.
    const directory = jobDir(id);
    const records = fs.existsSync(directory)
      ? fs
          .readdirSync(directory)
          .filter(
            (name) => /^rpc-.*\.json$/.test(name) && name !== "rpc-result.json",
          )
          .map((name) => readJson<P.RecordEvidence>(path.join(directory, name)))
          .filter((record) => record.pythonCheck)
          .sort(
            (left, right) =>
              required(left.dispatchIndex) - required(right.dispatchIndex),
          )
      : [];
    result.pythonChecks = records.map((record) => record.pythonCheck);
    if (result.execution?.pythonCheck)
      result.pythonChecks.push(result.execution.pythonCheck);
    return result;
  }
  const ipcObserver = createBrokerIpcObserver((id) => {
    const job = state.data.jobs[id];
    if (!job) return;
    return {
      clientId: job.clientId,
      requestId: job.request.requestId,
      debugTrace: job.request.debugTrace,
      buildHash: job.request.buildHash ?? codeHash,
    };
  });
  async function backend(
    message: P.WorkerMessage,
    preparedSend?: P.Send,
  ): Promise<{ value: unknown; properties: Record<string, unknown> }> {
    const grant = lane.currentGrant();
    const context = grant?.context.worker;
    if (
      !grant ||
      !context ||
      grant.context.postflight ||
      !context.productTurn ||
      message.jobId !== context.job.id ||
      !equal(message.workerToken, context.token) ||
      !["running", "sending"].includes(state.status(context.job.id).state)
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
    ipcObserver.accept(message, timeout);
    const initialRpcCount =
      state.status(context.job.id).dispatch?.rpcCount || 0;
    const operation = withRequest({ timeoutMs: timeout }, async () => {
      context.rpcDeadline = Date.now() + timeout;
      try {
        const value: unknown = await physicalGrant.run(grant, () =>
          preparedSend
            ? preparedSend()
            : Reflect.apply(client[message.method], client, message.args),
        );
        if (
          message.method === "listTools"
            ? !Array.isArray(value) ||
              value.some((tool) => !tool || typeof tool.name !== "string")
            : !isToolResult(value)
        ) {
          fail(
            "MALFORMED_BACKEND_RESULT",
            "Physical adapter returned malformed result fields",
          );
        }
        if (isToolResult(value) && value.failed) context.executionFailed = true;
        if (context.job.request.phased && workflowOutputNonterminal(value)) {
          context.workflowUnknown = true;
          if (context.lastRpc) {
            context.lastRpc.record.nonterminal = true;
            executionRecords.retainRpcWorkflowFence(
              context.job.id,
              context.lastRpc.record,
            );
          }
        }
        await settleNative(context, grant);
        const properties = clientProperties();
        if (
          Buffer.byteLength(JSON.stringify({ value, properties })) >
          MAX - 128
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
          (state.status(context.job.id).dispatch?.rpcCount || 0) >
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
          durable(path.join(jobDir(context.job.id), "adapter-outcome.json"), {
            jobId: context.job.id,
            buildHash: codeHash,
            rpcId: context.lastRpc?.rpcId || null,
            unknown: true,
            reason: "Adapter could not validate the physical response",
          });
          hold(
            grant,
            "Physical adapter outcome is unknown; generic synchronous receipts cannot certify its result",
          );
        }
        throw error;
      } finally {
        delete context.rpcDeadline;
      }
    });
    context.pending.add(operation);
    let rejectDeadline: (error: unknown) => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const budget = new PauseBudget(timeout, () => {
      context.timedOut = true;
      if (context.dispatched)
        hold(
          grant,
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

  function readAtomicProofRecord<T extends object = P.AtomicProof>(
    file: string,
  ): { value: T; sha256: string } {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 128 * 1024)
      fail(
        "RECEIPT_UNSAFE",
        "Scoped atomic proof must be a bounded regular file",
      );
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    let bytes;
    try {
      const opened = fs.fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      )
        fail(
          "RECEIPT_MISMATCH",
          "Scoped atomic proof changed while it was read",
        );
      bytes = fs.readFileSync(fd);
      const after = fs.lstatSync(file);
      if (
        after.isSymbolicLink() ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size
      )
        fail(
          "RECEIPT_MISMATCH",
          "Scoped atomic proof changed while it was read",
        );
    } finally {
      fs.closeSync(fd);
    }
    try {
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        fail(
          "RECEIPT_MISMATCH",
          "Scoped atomic proof record must be a JSON object",
        );
      return { value: value as T, sha256: hash(bytes.toString("utf8")) };
    } catch {
      fail("RECEIPT_MISMATCH", "Scoped atomic proof is malformed");
    }
  }

  let recoveryAuditBusy = false;
  function recoveryAuditProcesses(original: P.Instance, observed: P.Instance) {
    if (!currentAuditScope)
      return (
        sameInstance(original, observed) && originalFusionProcessAlive(original)
      );
    if (
      !same(readJson(currentAuditScopeFile), currentAuditScope) ||
      currentAuditScope.purpose !==
        "current-only-after-original-process-loss" ||
      !same(currentAuditScope.owner, marker) ||
      currentAuditScope.buildHash !== codeHash ||
      !sameInstance(currentAuditScope.originalInstance, original) ||
      !sameInstance(currentAuditScope.currentInstance, observed)
    )
      return false;
    const audit = currentAuditScope.migrationAudit;
    const intent = readJson<{
      approved: unknown;
      binding: { requestId: string };
    }>(path.join(audit, "intent.json"));
    const complete = readJson<{
      kind: string;
      requestId: string;
      jobId: string;
      purpose: string;
      gateClosed: boolean;
      unresolved: boolean;
      sdkRequestsSent: number;
      nativeOutcome: string;
      owner: P.Owner;
      observerBuildHash: string;
      currentAuditInstance: P.Instance;
    }>(path.join(audit, "complete.json"));
    const upgradeApi = load("./queue-atomic-audit-upgrade");
    const upgrade = upgradeApi.auditUpgradeApproval(intent.approved, dir);
    if (
      !load("./queue-instance-liveness").processLossAudit(upgrade) ||
      !upgradeApi.auditUpgradeStillCurrent(upgrade) ||
      complete.kind !== "atomic-owner-migration" ||
      complete.requestId !== intent.binding.requestId ||
      complete.jobId !== observationScopeConfig.jobId ||
      complete.purpose !== upgrade.purpose ||
      complete.gateClosed !== true ||
      complete.unresolved !== true ||
      complete.sdkRequestsSent !== 0 ||
      complete.nativeOutcome !== "unknown" ||
      !same(complete.owner, marker) ||
      complete.observerBuildHash !== codeHash ||
      !sameInstance(complete.currentAuditInstance, observed)
    )
      return false;
    load("./queue-instance-liveness").requireRecoveryProcesses(
      original,
      upgrade,
    );
    return true;
  }
  function recoveryAuditSnapshot(
    target: string,
    observer: string,
  ): AuditSnapshot {
    return structuredClone({
      owner: readJson<P.Owner>(lock),
      identity: readJson<P.Identity>(identityFile),
      paused: state.data.paused,
      generation: state.data.controlGeneration || 0,
      contextEpoch: state.data.contextEpoch || 0,
      active: state.data.active,
      blocked: state.data.blocked,
      lease: state.data.lease ?? null,
      jobs: [target, observer].map((id) => {
        const job = state.data.jobs[id];
        return {
          id,
          hash: job?.hash,
          state: job?.state,
          dispatch: job?.dispatch,
        };
      }),
    });
  }
  const recoveryAuditPorts: AuditPorts = {
    ...(pinned.backend === "mcp"
      ? { scriptFormat: "fusion-mcp" as const }
      : {}),
    installation: resolveRuntimePaths({ anchor: runtimeAnchor }).installation,
    buildHash: codeHash,
    jobDirectory: (id) => privateDirectory(jobDir(id)),
    assertOwner(target, observer, clientId) {
      owned(target, clientId);
      owned(observer, clientId);
    },
    async inspect(message, clientId) {
      const target = state.data.jobs[required(message.jobId)],
        observer = state.data.jobs[required(message.observationJobId)];
      if (
        target?.id !== observationScopeConfig.jobId ||
        target.state !== "needs_reconciliation" ||
        observer?.workflowObservation?.targetJobId !== target.id ||
        observer.dispatch?.rpcCount !== 1 ||
        observer.dispatch?.completedCount !== 1 ||
        !["needs_reconciliation", "failed"].includes(observer.state)
      )
        fail(
          "INVALID_AUDIT_SCOPE",
          "Audit requires the original unresolved target and its unavailable scoped observer",
        );
      const control = message.control;
      if (
        !control ||
        Object.keys(control).sort().join(",") !==
          "buildHash,contextEpoch,generation,instanceId" ||
        control.buildHash !== codeHash ||
        control.instanceId !== marker.nonce ||
        control.generation !== (state.data.controlGeneration || 0) ||
        control.contextEpoch !== (state.data.contextEpoch || 0)
      )
        fail(
          "STATE_CONFLICT",
          "Audit requires the complete current broker control fence",
        );
      if (
        Object.values(state.data.jobs).some(
          (job) =>
            ![target.id, observer.id].includes(job.id) &&
            !["succeeded", "failed", "expired", "cancelled"].includes(
              job.state,
            ),
        )
      )
        fail(
          "QUEUE_BUSY",
          "A different unfinished job prevents the recovery audit",
        );
      const before = recoveryAuditSnapshot(target.id, observer.id);
      const proofFile = path.join(
        privateDirectory(jobDir(observer.id)),
        "atomic-observation-proof.json",
      );
      const { value: proof, sha256 } = readAtomicProofRecord(proofFile);
      if (
        proof.kind !== "atomic_holder_status" ||
        proof.targetJobId !== target.id ||
        proof.observerJobId !== observer.id ||
        proof.clientId !== clientId ||
        proof.remoteOutcome !== "succeeded" ||
        proof.toolFailed !== false ||
        proof.readOnlyOperation !== "atomic_status" ||
        proof.identityMatches !== false ||
        proof.summary?.status !== "unavailable" ||
        proof.summary?.outcome !== "unknown" ||
        proof.summary?.completed !== false ||
        proof.summary?.destroyed !== false ||
        proof.originalBuildHash !== target.request.buildHash ||
        proof.observerBuildHash !== observer.request.buildHash ||
        proof.binding?.jobId !== observer.id ||
        proof.binding?.buildHash !== observer.request.buildHash ||
        proof.receipt !==
          path.join(
            jobDir(observer.id),
            `atomic-observation-${proof.rpcId}.receipt.json`,
          )
      )
        fail(
          "INVALID_AUDIT_PROOF",
          "Audit permission requires the exact prior bound unavailable observation",
        );
      const physical = {
        binding: proof.binding,
        receipt: proof.receipt,
        instance: proof.observerInstance,
      };
      if (remoteReceipt(physical, false).outcome !== "succeeded")
        fail(
          "INVALID_AUDIT_PROOF",
          "Prior observation has no successful terminal receipt",
        );
      const prepared = await prepareAtomicHolderObservation(
        target,
        { version: 1, kind: "atomic_holder_status", ...observationScopeConfig },
        {
          clientId,
          observerBuildHash: codeHash,
          originalBuildHash: before.identity.buildHash,
          approvedScope: observationScopeConfig,
        },
      );
      if (
        !same(prepared.identity, proof.identity) ||
        prepared.reportFingerprint !== proof.reportFingerprint ||
        prepared.originalInvocationHash !== proof.originalInvocationHash ||
        !same(prepared.sourceEnvelope, proof.sourceEnvelope)
      )
        fail(
          "INVALID_AUDIT_PROOF",
          "Prior observation no longer matches the exact immutable target input/report",
        );
      const original = validateAtomicOriginalReceipts(
        target,
        before.identity.buildHash,
        before.identity.instance,
        prepared.identity,
      );
      const evidenceFiles = [
        proofFile,
        physical.receipt,
        ...original.records.flatMap((record) => [
          path.join(jobDir(target.id), `rpc-${record.binding.rpcId}.json`),
          required(record.receipt),
        ]),
      ];
      const hashes = evidenceFiles.map((file) => ({
        file,
        sha256: hash(fs.readFileSync(file)),
      }));
      const auditInstance =
        currentAuditScope?.currentInstance || before.identity.instance;
      return {
        identity: prepared.identity,
        instance: auditInstance,
        before,
        prepared,
        hashes,
        binding: {
          purpose: "atomic-recovery-audit-v1",
          targetJobId: target.id,
          observationJobId: observer.id,
          clientId,
          originalJobHash: target.hash,
          observationJobHash: observer.hash,
          priorProofHash: sha256,
          originalBuildHash: before.identity.buildHash,
          auditBuildHash: codeHash,
          identityHash: atomicObservationIdentityHash(prepared.identity),
          reportFingerprint: prepared.reportFingerprint,
          sourceEnvelopeHash: prepared.sourceEnvelope?.sha256 ?? null,
          control,
          ...(currentAuditScope
            ? {
                currentInstance: auditInstance,
                historicalInstance: load(
                  "./queue-instance-liveness",
                ).processTuple(before.identity.instance),
                historicalProcessState: "terminated",
              }
            : {}),
        },
      };
    },
    fence(value, inFlight) {
      const active = activeContext();
      assertResetSubmissionOpen(dir);
      load("./queue-atomic-migration-runtime").assertMigrationAdmission(
        dir,
        "audit-atomic",
      );
      const ids = value.binding;
      if (
        lifetime.stopping ||
        gate.resuming ||
        (busy() && !recoveryAuditBusy) ||
        (gate.adminTransition &&
          gate.adminTransition !== "atomic-recovery-audit") ||
        gate.active.size !== (inFlight ? 1 : 0) ||
        state.data.lease ||
        state.data.controlBlocked ||
        state.data.localUnknown ||
        state.data.paused !== true ||
        !same(
          recoveryAuditSnapshot(ids.targetJobId, ids.observationJobId),
          value.before,
        ) ||
        !same(value.before.owner, marker) ||
        !sameInstance(value.before.identity.instance, instance) ||
        !recoveryAuditProcesses(
          value.before.identity.instance,
          value.instance,
        ) ||
        buildHash() !== codeHash ||
        !snapshotStillCurrent(value.prepared.snapshot) ||
        !load("./atomic-workflow-observation").sourceEnvelopeStillCurrent(
          value.prepared.sourceEnvelope,
        ) ||
        value.hashes.some(
          (row) => hash(fs.readFileSync(row.file)) !== row.sha256,
        ) ||
        (active &&
          (![ids.targetJobId, ids.observationJobId].includes(active.job?.id) ||
            active.pending?.size ||
            (active.child && !active.workerClosed)))
      )
        fail(
          "AUDIT_FENCE_CHANGED",
          "Owner/input/report/instance/pause/reset/zero-active audit fence changed",
        );
    },
    begin() {
      if (busy() || gate.adminTransition)
        fail("BROKER_BUSY", "Another operation owns the broker");
      recoveryAuditBusy = true;
      lane.setAdministrative(true);
      gate.adminTransition = "atomic-recovery-audit";
    },
    end() {
      recoveryAuditBusy = false;
      lane.setAdministrative(false);
      gate.adminTransition = null;
      diagnostics();
    },
    admit: (send) => gate.administrative(() => gate.run(send)),
    check: (payload, artifact) => pythonAdmission.check(payload, artifact),
    post: (payload, sessionId, physicalContext) => {
      if (["initialize", "notifications/initialized"].includes(payload.method))
        return withRequest({ timeoutMs: 30000 }, () => originalPost(payload, sessionId),
        );
      if (!physicalContext)
        fail("PHYSICAL_BINDING_MISSING", "Audit SDK dispatch requires its original read binding",
        );
      const read = systemReadTurn(physicalContext, "atomic-recovery-audit");
      return read(() => withRequest({ timeoutMs: 30000 }, () => originalPost(payload, sessionId),
        ),
      );
    },
    match: (response, payload) => matching(client, response, payload),
    remoteReceipt: (record) => remoteReceipt(record, false),
    sendScript: (scope, script) =>
      atomicRecoveryAuditScope.run(scope, () =>
        pinned.backend === "mcp" && client.executeBrokerScript
          ? client.executeBrokerScript(script, required(scope.origin), true)
          : client.callTool(
              {
                featureType: "script",
                object: { script, readOnly: true },
              },
              "fusion_mcp_execute",
              scope.origin,
            ),
      ),
  };
  const recoveryAuditControl = load(
    "./queue-atomic-recovery-audit",
  ).createRecoveryAudit(recoveryAuditPorts);
  function epochSnapshot() {
    return {
      owner: readJson(lock),
      identity: readJson(identityFile),
      epochId: state.epoch?.epochId,
      stateHash: hash(JSON.stringify(state.data)),
    };
  }
  function assertScratchControl(value: unknown) {
    const control = value as P.Message["control"];
    if (
      !control ||
      Object.keys(control).sort().join(",") !==
        "buildHash,contextEpoch,generation,instanceId" ||
      control.buildHash !== codeHash ||
      control.instanceId !== marker.nonce ||
      control.generation !== state.data.controlGeneration ||
      control.contextEpoch !== state.data.contextEpoch
    )
      fail(
        "STATE_CONFLICT",
        "Complete current recovery/isolated scope control fence required",
      );
  }
  const factsCapture = load(
    "./queue-audit-facts-capture",
  ).createAuditFactsCapture({
    dir,
    state,
    scope: currentAuditScope,
    buildHash: codeHash,
    clients: clientHashes,
    ownerNonce: marker.nonce,
    targetJobId: observationScopeConfig.jobId,
    auditPorts: recoveryAuditPorts,
    assertControl: assertScratchControl,
    approval: currentAuditScope?.auditResponseRecovery
      ? readJson<{ approved: unknown }>(
          path.join(currentAuditScope.migrationAudit, "intent.json"),
        ).approved
      : null,
  });
  const sendOwnedFixtureScript = (scope: P.ScriptScope, script: string) =>
    atomicRecoveryAuditScope.run(scope, () => {
      // Fixed scratch sources already enforce idle UI before their sole add/close
      // and are independently source/endpoint/final-byte bound. Use the existing
      // broker-private guarded-script port; do NOT lie that mutation is read-only,
      // or accept an arbitrary caller prefix/random guard as the authorized body.
      if (pinned.backend === "mcp" && client.executeBrokerScript)
        return client.executeBrokerScript(
          script,
          required(scope.origin),
          false,
        );
      if (typeof client.executeUiGuardedScript === "function")
        return client.executeUiGuardedScript(script, scope.origin);
      if (options.createBackend)
        return client.callTool(
          { featureType: "script", object: { script, readOnly: false } },
          "fusion_mcp_execute",
          scope.origin,
        );
      fail(
        "SCRATCH_TRANSPORT_UNSUPPORTED",
        "Physical backend lacks the private fixed guarded-script route",
      );
    });
  function fenceEpochLifecycle(inFlight: boolean) {
    assertResetSubmissionOpen(dir);
    load("./queue-atomic-migration-runtime").assertMigrationAdmission(
      dir,
      "close-isolated-scratch",
    );
    const allowedAdmin = gate.adminTransition === "atomic-recovery-audit";
    if (
      lifetime.stopping ||
      gate.resuming ||
      (busy() && !recoveryAuditBusy) ||
      (gate.adminTransition && !allowedAdmin) ||
      gate.active.size !== (inFlight ? 1 : 0) ||
      activeContext() ||
      state.data.lease ||
      state.data.localUnknown ||
      state.data.controlBlocked ||
      state.data.blocked ||
      state.data.active ||
      Object.values(state.data.jobs).some(
        (job) =>
          !["succeeded", "failed", "expired", "cancelled"].includes(job.state),
      ) ||
      !same(readJson(lock), marker) ||
      buildHash() !== codeHash
    )
      fail(
        "EPOCH_BUSY",
        "Scratch lifecycle requires the same owner/build and a quiescent isolated epoch",
      );
  }
  const scratchControl = load("./queue-scratch-control").createScratchControl({
    dir,
    state,
    scope: currentAuditScope,
    configHash,
    buildHash: codeHash,
    clients: clientHashes,
    auditPorts: { ...recoveryAuditPorts, sendScript: sendOwnedFixtureScript },
    assertControl: assertScratchControl,
    additionalPrerequisite: () => factsCapture.approvedPrerequisite(),
    epochSnapshot,
    epochFence: fenceEpochLifecycle,
    activate(epoch, identity) {
      if (
        identityFile === path.join(epoch.root, "instance.json") &&
        sameInstance(instance, epoch.currentInstance)
      )
        return;
      identityFile = path.join(epoch.root, "instance.json");
      instance = identity.instance;
      atomicObservationOnly = false;
      epochProcessUnavailable = false;
      setHold(null);
      diagnostics();
    },
    closed(epoch) {
      if (state.admissionMode === "normal-multidocument") {
        setHold(null);
        diagnostics();
        return;
      }
      if (!state.data.paused)
        state.pause(true, "isolated-scratch-closed:" + epoch.epochId);
      setHold(
        "Qualified isolated scratch is closed; historical unknown work remains quarantined",
      );
      diagnostics();
    },
  });
  const savedFixtureControl = load(
    "./queue-saved-fixture-control",
  ).createSavedFixtureControl({
    dir,
    state,
    clients: clientHashes,
    assertControl: assertScratchControl,
    snapshot: epochSnapshot,
    fence: fenceEpochLifecycle,
    auditPorts: { ...recoveryAuditPorts, sendScript: sendOwnedFixtureScript },
    closed(epoch) {
      if (!state.data.paused)
        state.pause(true, "saved-fixture-retained:" + epoch.epochId);
      setHold(
        "New test DataFile retained; owned saved UI document closed; historical unknown work remains quarantined",
      );
      diagnostics();
    },
  });
  const successorAuthority =
    successorRuntime?.authorityEntry ||
    (!epochProcessUnavailable &&
    state.epoch?.succession &&
    priorProcessAlive(state.epoch.currentInstance) === true
      ? state.epoch.succession
      : null);
  function successorController(authority: unknown) {
    return load("./queue-epoch-successor-control").createSuccessorControl({
      dir,
      state,
      configHash,
      buildHash: codeHash,
      clients: clientHashes,
      authority,
      ports: recoveryAuditPorts,
      sendAuditScript: recoveryAuditPorts.sendScript,
      sendScratchScript: sendOwnedFixtureScript,
      assertControl: assertScratchControl,
      epochSnapshot,
      fenceRuntime(inFlight) {
        assertResetSubmissionOpen(dir);
        if (
          fs.existsSync(path.join(dir, "atomic-migration.lock")) ||
          fs.existsSync(path.join(dir, "recovery.lock")) ||
          lifetime.stopping ||
          gate.resuming ||
          (busy() && !recoveryAuditBusy) ||
          activeContext() ||
          (gate.adminTransition &&
            gate.adminTransition !== "atomic-recovery-audit") ||
          gate.active.size !== (inFlight ? 1 : 0) ||
          !same(readJson(lock), marker) ||
          buildHash() !== codeHash
        )
          fail(
            "EPOCH_SUCCESSOR_FENCE_CHANGED",
            "The qualified successor owner, released startup guards and exclusive physical turn must remain unchanged",
          );
      },
      activate(epoch, identity) {
        identityFile = path.join(epoch.root, "instance.json");
        instance = identity.instance;
        atomicObservationOnly = false;
        epochProcessUnavailable = false;
        setHold(null);
        diagnostics();
      },
    });
  }
  let successorControl = successorAuthority
    ? successorController(successorAuthority)
    : null;
  function isolatedScratchScope() {
    if (!state.epoch)
      return {
        admission: "blocked",
        creation:
          currentAuditScope?.epochPrerequisite ||
          factsCapture.approvedPrerequisite()
            ? "owner-bound-new-document-only"
            : "unavailable",
      };
    const admission = epochProcessUnavailable
      ? "blocked-process-unavailable"
      : state.admissionMode === "normal-multidocument"
        ? "normal-multidocument"
        : fs.existsSync(path.join(state.epoch.root, "closed.json"))
          ? "closed"
          : fs.existsSync(
                path.join(
                  epochControlDirectory(dir, state.epoch),
                  "isolated-scratch-close",
                  "intent.json",
                ),
              )
            ? "cleanup-pending-or-unknown"
            : state.data.blocked ||
                state.data.localUnknown ||
                state.data.controlBlocked
              ? "blocked-current-unknown"
              : load("./queue-saved-first-save").firstSavePhase(
                  state.epoch,
                  state.data.jobs,
                ) || "qualified-fresh-scratch-only";
    return {
      epochId: state.epoch.epochId,
      document: state.epoch.document,
      admission,
    };
  }

  async function acceptAtomicObservation(
    id: string,
    clientId: string,
    acceptedOutcome: string,
  ) {
    const hold = lane.captureRecovery();
    const active = activeContext();
    const outcome = atomicAcceptance.atomicOwnerOutcome(acceptedOutcome);
    assertResetSubmissionOpen(dir);
    if (gate.adminTransition || gate.resuming)
      fail(
        "BROKER_BUSY",
        "A broker administrative transition prevents owner acceptance",
      );
    if (buildHash() !== codeHash)
      fail(
        "BUILD_CHANGED",
        "Observer runtime build changed before owner acceptance",
      );
    owned(id, clientId);
    const target = required(state.data.jobs[id]);
    const ownerRequest = {
      targetId: id,
      requestId: target.requestId,
      owner: clientId,
      outcome,
    };
    const queueFacts = () => ({
      paused: state.data.paused,
      controlGeneration: state.data.controlGeneration || 0,
      contextEpoch: state.data.contextEpoch || 0,
      activeId: state.data.active,
      blockedId: state.data.blocked?.id,
      targetState: state.data.jobs[id]?.state,
      leased: !!state.data.lease,
    });
    const targetDir = privateDirectory(jobDir(id));
    const acceptancePath = path.join(
      targetDir,
      "atomic-reconciliation-acceptance.json",
    );
    const relativeAcceptancePath = path.relative(dir, acceptancePath);
    let priorAcceptance = null;
    try {
      priorAcceptance =
        readAtomicProofRecord<P.Acceptance>(acceptancePath).value;
    } catch (cause) {
      const error = errorInfo(cause);
      if (error.code !== "ENOENT") throw error;
    }
    if (priorAcceptance) {
      atomicAcceptance.requirePersistedOwnerAcceptance(priorAcceptance, ownerRequest,
      );
      const priorObserver = state.data.jobs[priorAcceptance.observerJobId];
      const expectedProofPath = priorObserver
        ? path.join(jobDir(priorObserver.id), "atomic-observation-proof.json")
        : "";
      atomicAcceptance.requirePersistedAtomicObserver(
        priorAcceptance,
        target.id,
        priorObserver && {
          state: priorObserver.state,
          targetJobId: priorObserver.workflowObservation?.targetJobId,
          expectedPath: path.relative(dir, expectedProofPath),
        },
      );
      const persistedProof = readAtomicProofRecord(expectedProofPath);
      atomicAcceptance.requirePersistedAtomicProof(priorAcceptance, persistedProof,
      );
      const priorProof = persistedProof.value;
      const priorRemote = remoteReceipt(
        {
          receipt: priorProof.receipt,
          binding: priorProof.binding,
          instance: priorProof.observerInstance,
        },
        false,
      );
      const priorObserverId = priorAcceptance.observerJobId;
      const persistedFacts = () => ({
        ...queueFacts(),
        otherNonterminal: atomicAcceptance.hasOtherNonterminal(
          Object.values(state.data.jobs).map(({ id, state }) => ({ id, state,
          })),
          target.id,
          priorObserverId,
        ),
      });
      const decision = atomicAcceptance.decidePersistedAtomicAcceptance(
        priorAcceptance,
        priorProof,
        {
          outcome: priorRemote.outcome,
          expectedPath: path.join(
            jobDir(priorAcceptance.observerJobId),
            `atomic-observation-${priorProof.rpcId}.receipt.json`,
          ),
        },
        persistedFacts(),
      );
      if (decision === "already-settled") return priorAcceptance;
      const currentIdentity = readJson<P.Identity>(identityFile);
      atomicAcceptance.requirePersistedAtomicInstance(
        priorAcceptance, currentIdentity, target.request.buildHash,
        () => originalFusionProcessAlive(currentIdentity.instance),
      );
      validateAtomicOriginalReceipts(
        target,
        priorAcceptance.originalBuildHash,
        currentIdentity.instance,
        priorAcceptance.identity,
      );
      const currentReport = await readCurrentAtomicObservationReport(
        priorAcceptance.reportPath,
      );
      const resolution = atomicAcceptance.completePersistedAtomicAcceptance(
        priorAcceptance,
        ownerRequest,
        {
          fingerprint: currentReport.fingerprint,
          identity: currentReport.identity,
          isCurrent: () => snapshotStillCurrent(currentReport.snapshot),
        },
        relativeAcceptancePath,
        persistedFacts(),
      );
      assertResetSubmissionOpen(dir);
      const result = hold.settle(() => state.resolve(target.id, resolution));
      endNativeActivity(active?.job?.id === target.id ? active : null);
      recovery = {
        jobId: id,
        observationJobId: priorAcceptance.observerJobId,
        status: "owner_accepted_" + acceptedOutcome,
        at: Date.now(),
      };
      diagnostics();
      return { ...priorAcceptance, job: result };
    }
    atomicAcceptance.requireFreshAtomicAdmission(target.id, {
      candidate: isAtomicObservationCandidate(target, target.request.buildHash, observationScopeConfig,
      ),
      fence: queueFacts(),
      active: active && {
        jobId: active.job?.id,
        unknown: !!(active.unknown || active.workflowUnknown),
        pending: !!active.pending.size,
        childRunning: !!active.child && !active.workerClosed,
      },
      otherActivity: [...gate.active.keys()].some((key) => key !== active?.nativeActivityId,
      ),
    });
    const identity = readJson<P.Identity>(identityFile);
    atomicAcceptance.requireFreshAtomicInstance(
      identity, instance, target.request.buildHash,
      () => originalFusionProcessAlive(identity.instance),
    );

    const { observer, marker } = atomicAcceptance.selectFreshAtomicObserver({
      ...ownerRequest,
      targetHash: target.hash,
      targetBuildHash: target.request.buildHash,
      targetDirectory: target.request.cwd,
      build: codeHash,
      fence: queueFacts(),
      jobs: Object.values(state.data.jobs).map((job) => ({
        id: job.id,
        requestId: job.requestId,
        state: job.state,
        buildHash: job.request.buildHash,
        projectDirectory: job.request.cwd,
        marker: job.workflowObservation,
      })),
    });
    const proofFile = path.join(
      jobDir(observer.id),
      "atomic-observation-proof.json",
    );
    const { value: proof, sha256: proofHash } =
      readAtomicProofRecord(proofFile);
    const summary = atomicAcceptance.requireFreshAtomicProof({
      ...ownerRequest,
      observer: { id: observer.id, requestId: observer.requestId },
      marker,
      expectedInstance: identity.instance,
      proof,
      build: codeHash,
    });
    const report = await readCurrentAtomicObservationReport(marker.reportPath);
    atomicAcceptance.requireFreshAtomicReport(proof, marker, report);
    validateAtomicOriginalReceipts(
      target,
      identity.buildHash,
      identity.instance,
      report.identity,
    );
    atomicAcceptance.requireFreshAtomicRemoteBinding(proof, {
      instance: identity.instance,
      receiptPath: path.join(jobDir(observer.id), `atomic-observation-${proof.rpcId}.receipt.json`,
      ),
      observerId: observer.id,
      targetId: target.id,
      build: codeHash,
      identityHash: atomicObservationIdentityHash(proof.identity),
    });
    const remote = remoteReceipt(
      {
        receipt: proof.receipt,
        binding: proof.binding,
        instance: proof.observerInstance,
      },
      false,
    );
    const { acceptance, resolution } = atomicAcceptance.completeFreshAtomicAcceptance({
      ...ownerRequest,
      proof,
      summary,
      marker,
      remoteOutcome: remote.outcome,
      proofPath: path.relative(dir, proofFile),
      proofSha256: proofHash,
      acceptancePath: relativeAcceptancePath,
      acceptedAt: new Date().toISOString(),
      reportCurrent: () => snapshotStillCurrent(report.snapshot),
      fence: queueFacts(),
    });
    assertResetSubmissionOpen(dir);
    hold.assertCurrent();
    durable(acceptancePath, acceptance, true);
    const result = hold.settle(() => state.resolve(target.id, resolution));
    endNativeActivity(active?.job?.id === target.id ? active : null);
    recovery = {
      jobId: target.id,
      observationJobId: observer.id,
      status: "owner_accepted_" + acceptedOutcome,
      at: Date.now(),
    };
    diagnostics();
    return { ...acceptance, job: result };
  }

  function readRecoveryFence(id: string): RecoveryFence | null {
    const data = state.data;
    const job = data.jobs[id];
    const active = activeContext();
    if (
      !job ||
      lifetime.closed ||
      epochProcessUnavailable ||
      !instance ||
      state._writing ||
      state._fault ||
      (active && active.job.id !== id)
    )
      return null;
    try {
      assertResetSubmissionOpen(dir);
      const epoch = state.epoch;
      const normal = state.admissionMode === "normal-multidocument";
      if (epoch) state.assertEpoch(normal);
      if (
        fs.lstatSync(
          path.join(epoch?.root ?? dir, "queue-state.pending.json"),
          { throwIfNoEntry: false },
        ) ||
        !same(readJson<P.Owner>(lock), marker)
      )
        return null;
      const identity = readJson<P.Identity>(identityFile);
      if (
        identity.configHash !== configHash ||
        identity.buildHash !== codeHash ||
        !sameInstance(identity.instance, instance)
      )
        return null;
      return {
        jobId: id,
        clientId: job.clientId,
        requestId: job.requestId,
        jobHash: job.hash,
        state: job.state,
        rpcCount: job.dispatch?.rpcCount || 0,
        brokerInstanceId: marker.nonce,
        instance: identity.instance,
        buildHash: codeHash,
        executableBuildHash: buildHash(),
        epochId: epoch?.epochId ?? null,
        receiptEpoch: normal ? undefined : epoch?.epochId,
        revision: data.revision,
        generation: data.controlGeneration || 0,
        contextEpoch: data.contextEpoch || 0,
        activeJobId: data.active,
        blockedJobId: data.quarantined?.[id] ? id : (data.blocked?.id ?? null),
      };
    } catch {
      // Unreadable durable ownership or state is not recovery authority.
      return null;
    }
  }
  function matchRecordedResponse(record: P.RecordEvidence) {
    if (!record.request || record.request.method !== record.method)
      fail("RECEIPT_MISMATCH", "Terminal RPC has no original reply identity");
    const wire = record.wireRequest || record.request;
    if (usesRetainedMetadataEvidence(record)) {
      const { jobId, rpcId } = record.binding;
      const original = executionRecords.evidence.readReceivedResponse(jobId, rpcId,
      );
      return matchRetainedMetadataEvidence(record, original, decodeAdmissionJson,
      );
    }
    return matching(client, record.response, wire);
  }

  const recoveryEvaluator = createBrokerRecovery(
    createBrokerRecoveryEvidence(executionRecords.evidence, {
      readFence: readRecoveryFence,
      workerContext: () => {
        const active = activeContext();
        return !active
          ? "absent"
          : active.pending.size || (active.child && !active.workerClosed)
            ? "pending"
            : "closed";
      },
      processBirth,
      workflowNonterminal,
      nativeReceipts,
      validateTerminalResponse(record) {
        matchRecordedResponse(record);
      },
    }),
  );

  async function reconcile(id: string, clientId: string) {
    const hold = lane.captureRecovery();
    if (owned(id, clientId).state !== "needs_reconciliation")
      fail("NOT_BLOCKED", "Job does not require reconciliation");
    if (!instance)
      fail(
        "INSTANCE_UNAVAILABLE",
        "Original pinned instance record unavailable; no probe sent",
      );
    const expected = readRecoveryFence(id);
    if (!expected)
      fail("STATE_CONFLICT", "Recovery owner or local fence is unavailable");
    const job = state.lookup(id);
    const directory = privateDirectory(jobDir(id));
    const context = activeContext();
    return recoveryEvaluator.settleOwned(job, expected, {
      assertHold: hold.assertCurrent,
      observe: (previous, grant) =>
        observeBrokerRecovery(
          { id, directory, instance, buildHash: codeHash },
          previous,
          grant,
          {
            read: readJson,
            write: durable,
            send: (probe, fence) =>
              probeSendScope.run(fence, () => checkInstance(probe)),
          },
        ),
      settleUndispatched(outcome, assertCurrent) {
        assertCurrent();
        durable(path.join(directory, "outcome.json"), outcome);
        assertCurrent();
        const result = hold.settle(() => state.resolve(id, outcome));
        diagnostics();
        return result;
      },
      settleDispatched(decision, assertCurrent) {
        const { responsePath } = load("./queue-response-files");
        return publishBrokerRecoveredDispatch(directory, decision, assertCurrent, {
          rpc: job.kind === "rpc",
          readOutput() {
            const file = responsePath(dir, job, "rpc-result.json");
            return fs.existsSync(file) ? readJson<P.Response>(file) : null;
          },
          restoreOutput(record) {
            const response = required(record.response);
            return record.wireRequest
              ? responseForCaller(
                  record.binding["addinAdmission"] === undefined
                    ? response
                    : { status: response.status, raw: "" },
                  required(record.request),
                  matchRecordedResponse(record),
                )
              : response;
          },
          publishOutput(response) {
            durable(responsePath(dir, job, "rpc-result.json", true), response,
              );
          },
          successfulOutput(response) {
            const reply = object(client._parse(response.raw));
            return !reply["error"] && !object(reply["result"])["isError"];
          },
          describeNativeEnd(proof) {
            return {
              kind: proof.native.kind,
              commandId: proof.native.identity.commandId,
              ...proof.native.state,
            };
          },
          write: durable,
          resolve(details) {
            const result = hold.settle(() => state.resolve(id, details));
            endNativeActivity(context);
            diagnostics();
            return result;
          },
        },
        );
      },
    });
  }

  function workerSnapshotHash(): string {
    if (state._writing || state._fault)
      fail(
        "STORAGE_UNAVAILABLE",
        "Queue snapshot has unresolved durability evidence",
      );
    try {
      fs.lstatSync(
        path.join(state.epoch?.root ?? dir, "queue-state.pending.json"),
      );
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        fail(
          "STORAGE_UNAVAILABLE",
          "Queue snapshot durability cannot be inspected",
        );
      return hash(JSON.stringify(state.data));
    }
    fail(
      "STORAGE_UNAVAILABLE",
      "Queue snapshot has unresolved durability evidence",
    );
  }

  function assertMigrationAdmission(action: string) {
    if (fs.existsSync(path.join(dir, "atomic-migration.lock"))) {
      const guard = readJson<{ kind: string; nonce: string; audit: string }>(
        path.join(dir, "atomic-migration.lock"),
      );
      if (!(
        successorRuntime &&
        epochProcessUnavailable &&
        guard.kind === "dead-epoch-successor" &&
        guard.nonce === options.deadEpochSuccessorNonce &&
        guard.audit === successorRuntime.audit
      ))
        load("./queue-atomic-migration-runtime").assertMigrationAdmission(
          dir,
          action,
        );
    }
  }

  function dispatchWorkerStatus(message: P.Message) {
      const active = activeContext();
      if (
        !active ||
        message.jobId !== active.job.id ||
        !equal(message.workerToken, active.token)
      ) {
        phased.authorize({
          jobId: required(message.jobId),
          workerToken: required(message.workerToken),
        });
        const snapshotHash =
          message.snapshotFence === true ? workerSnapshotHash() : undefined;
        const job = state.status(required(message.jobId));
        // The admitted worker also waits here during preflight/postflight, when
        // the physical probe is owned by the broker rather than active.context.
        if (
          !["preparing", "processing", "queued", "running", "sending"].includes(
            job.state,
          )
        )
          fail(
            job.code || "RECONCILIATION_REQUIRED",
            "SDK turn is not available for local work",
          );
        ipcObserver.accept(message);
        return {
          remainingMs: job.sdkRemainingMs ?? job.timeoutMs,
          phase: job.state,
          ...(snapshotHash === undefined ? {} : { snapshotHash }),
          control: gate.snapshot(),
        };
      }
      if (active.unknown || state.summary().blocked)
        fail("RECONCILIATION_REQUIRED", "SDK outcome remains unresolved");
      ipcObserver.accept(message);
      const snapshotHash =
        message.snapshotFence === true ? workerSnapshotHash() : undefined;
      return {
        remainingMs: required(active.budget).remaining(),
        waitingForPause: !!active.waitingForPause,
        ...(snapshotHash === undefined ? {} : { snapshotHash }),
        control: gate.snapshot(),
      };
  }

  async function dispatchCommand(message: P.Message, clientId: string, successorAction: boolean,
  ) {
    switch (message.action) {
      case "document-unlock": {
        const decoded = decodeDocumentUnlockRequest(message.request);
        const target: import("../document-unlock-diagnostics").DocumentUnlockTarget = decoded.target.docId ? {
          docId: decoded.target.docId,
          ...(decoded.target.docFileId ? { docFileId: decoded.target.docFileId } : {}),
        } : { docFileId: required(decoded.target.docFileId) };
        const request: import("../document-unlock-diagnostics").DocumentUnlockMcpRequest =
          decoded.action === "status" ? { action: "status", target } :
          decoded.action === "inspect" ? { action: "inspect", target, requestId: decoded.requestId } :
          { action: "accept", target, requestId: decoded.requestId, observationId: decoded.observationId };
        const actor = { clientId, clientTokenHash: required(clientHashes()[clientId]) };
        return checkpointActor.run(actor, () => checkpointViews.run({
          states: new Map(), justProduced: new Set(), finalChecks: new Map(),
        }, () => checkpointController.handle(request, actor)));
      }
      case "probe-saved-destination":
        return savedFixtureControl.probe(message, clientId);
      case "observe-saved-first-save":
        return savedFixtureControl.observe(message, clientId);
      case "retain-saved-fixture":
        return savedFixtureControl.retain(message, clientId);
      case "grant-native-fixture":
      case "grant-saved-first-save":
        return (
          message.action === "grant-native-fixture"
            ? load("./queue-native-fixture-grant").grantNativeFixture
            : load("./queue-saved-first-save").grantSavedFirstSave
        )(
          {
            dir,
            state,
            buildHash: codeHash,
            clients: clientHashes,
            assertControl: assertScratchControl,
            fence() {
              assertResetSubmissionOpen(dir);
              if (
                lifetime.stopping ||
                busy() ||
                activeContext() ||
                gate.resuming ||
                gate.adminTransition ||
                gate.active.size ||
                fs.existsSync(path.join(dir, "recovery.lock")) ||
                fs.existsSync(path.join(dir, "atomic-migration.lock")) ||
                !same(readJson(lock), marker) ||
                buildHash() !== codeHash
              )
                fail(
                  "EPOCH_BUSY",
                  "A fixture grant requires the same idle live broker and no pending lifecycle",
                );
            },
          },
          message,
          clientId,
        );
      case "authorize-closed-successor": {
        const result = load(
          "./queue-closed-epoch-successor",
        ).authorizeClosedSuccessor(
          {
            dir,
            state,
            marker,
            buildHash: codeHash,
            runtime: resolveRuntimePaths({ anchor: runtimeAnchor }).installation,
            clients: clientHashes,
            assertControl: assertScratchControl,
            fence() {
              assertResetSubmissionOpen(dir);
              if (
                fs.existsSync(path.join(dir, "recovery.lock")) ||
                fs.existsSync(path.join(dir, "atomic-migration.lock")) ||
                lifetime.stopping ||
                busy() ||
                activeContext() ||
                gate.resuming ||
                gate.adminTransition ||
                gate.active.size ||
                !same(readJson(lock), marker) ||
                buildHash() !== codeHash
              )
                fail(
                  "EPOCH_BUSY",
                  "The exact live quiescent broker must authorize the next closed-scratch succession",
                );
            },
          },
          message,
          clientId,
        );
        successorControl = successorController(result.authority);
        return result;
      }
      case "observe-successor":
        if (!successorControl)
          fail(
            "EPOCH_SUCCESSOR_REQUIRED",
            "There is no owner-authenticated successor authority",
          );
        return successorControl.observe(message, clientId);
      case "capture-audit-facts":
        return factsCapture.handle(message, clientId);
      case "authorize-isolated-scratch":
        return factsCapture.authorize(message, clientId);
      case "create-isolated-scratch":
        return successorAction
          ? required(successorControl).create(message, clientId)
          : scratchControl.create(message, clientId);
      case "close-isolated-scratch":
        return scratchControl.close(message, clientId);
      case "grant-isolated-scratch":
        return scratchControl.grant(message, clientId);
      case "audit-atomic":
        return recoveryAuditControl.handle(message, clientId);
      case "observe-atomic": {
        const request = load("./queue-atomic-control").observationRequest(
          message,
          clientId,
          state.data.jobs[required(message.jobId)],
          gate.snapshot(),
          observationScopeConfig,
        );
        // Reuse the sole authenticated typed submission path, including all
        // report/receipt/document fences and the existing physical scheduler.
        return dispatch({ action: "submit", auth: message.auth, request });
      }
      case "submit": {
        assertResetSubmissionOpen(dir);
        if (lifetime.stopping) fail("BROKER_STOPPING", "Broker is stopping");
        if (gate.adminTransition)
          fail("BROKER_BUSY", "An administrative transition is pending");
        const r = message.request;
        if (!r || typeof r !== "object" || Array.isArray(r))
          fail("INVALID_REQUEST", "Request object required");
        if (own(r, "workflowObservation"))
          fail(
            "INVALID_REQUEST",
            "workflowObservation is broker-authored and cannot be supplied by a client",
          );
        decodeRequest(r);
        const request = { ...r, clientId, ownerToken: clientHashes()[clientId],
        };
        if (frozenMetadataScope !== undefined && request.kind !== "command")
          (runtimeRequire("./dist/composition/queue-frozen-metadata-profile",
            ) as
          typeof import("./queue-frozen-metadata-profile")).assertFrozenMetadataRequest(
          frozenMetadataScope,
          {
            clientId, requestId: request.requestId, kind: request.kind,
            metadata: request.kind === "rpc" && isAddinMetadata(rpcPayload(r.rpc?.payload || r.payload)),
          });
        if (state.epoch || approvedRuntimeRoot) {
          if (own(r, "isolatedEpoch"))
            fail(
              "INVALID_REQUEST",
              "Admission epoch is broker-authored, never caller-supplied",
            );
          const prior = state.findAnyRequest(clientId, request.requestId);
          if (prior && state.isHistorical(prior.id))
            fail(
              "HISTORICAL_REQUEST_QUARANTINED",
              "Historical request IDs cannot be reused in a new epoch",
            );
          admitEpochRequest(request);
          if (state.epoch) request.isolatedEpoch = state.epoch.epochId;
        }
        if (
          !Number.isSafeInteger(request.timeoutMs) ||
          request.timeoutMs <= 0 ||
          request.timeoutMs > 2147483647
        )
          fail("INVALID_TIMEOUT", "Execution timeout must be 1..2147483647 ms");
        const existingObservation = Object.values(state.data.jobs).find(
          (job) =>
            job.requestId === request.requestId &&
            job.clientId === clientId &&
            job.workflowObservation,
        );
        if (existingObservation) return state.submit(request); // Idempotent receipt lookup; never re-dispatch.
        let workflowObservation:
          | {
              -readonly [
                K in keyof import("../../packages/core/src/domain/queue-model").AtomicWorkflowObservation
              ]: import("../../packages/core/src/domain/queue-model").AtomicWorkflowObservation[K];
            }
          | null = null;
        const blockedJob = state.data.blocked
          ? state.data.jobs[state.data.blocked.id]
          : null;
        const invocation =
          request.payload?.kind === "cad-command"
            ? request.payload.invocation
            : request.payload;
        const isReconcile =
          request.kind === "command" &&
          invocation?.kind === "cad" &&
          invocation.operation === "batch.reconcile";
        if (isReconcile || atomicObservationOnly) {
          if (!isReconcile || !blockedJob) {
            fail(
              atomicObservationOnly
                ? "ATOMIC_OBSERVATION_ONLY"
                : "RECOVERY_BLOCKED",
              "Only the owner-scoped atomic batch.reconcile observation is admitted while this workflow blocks the queue",
            );
          }
          if (
            request.phased === true ||
            request.sequence ||
            request.inputFiles?.length ||
            request.buildHash !== codeHash ||
            request.backend !== (pinned.backend || "addin") ||
            request.cwd !== blockedJob.request.cwd
          ) {
            fail(
              "WORKFLOW_OBSERVATION_REQUEST_MISMATCH",
              "Scoped observation must use the same owner project, backend and current observer build",
            );
          }
          if (clientId !== blockedJob.clientId)
            fail(
              "NOT_OWNER",
              "Only the original job owner may request scoped atomic holder observation",
            );
          const requestContext = request.clientContext;
          if (
            requestContext?.projectDirectory !== undefined &&
            requestContext.projectDirectory !== blockedJob.request.cwd
          ) {
            fail(
              "WORKFLOW_PROJECT_MISMATCH",
              "Scoped observation project root differs from the original owner project",
            );
          }
          if (state.data.lease)
            fail(
              "QUEUE_BUSY",
              "A queue lease must be resolved before scoped atomic observation",
            );
          const before = {
            revision: state.data.revision,
            generation: state.data.controlGeneration || 0,
            contextEpoch: state.data.contextEpoch || 0,
            paused: state.data.paused,
            blocked: state.data.blocked?.id,
            active: state.data.active,
            lease: state.data.lease ? structuredClone(state.data.lease) : null,
          };
          const active = activeContext();
          const originalActiveIds =
            active?.nativeActivityId && gate.active.has(active.nativeActivityId)
              ? [active.nativeActivityId]
              : [];
          if (
            busy() ||
            gate.resuming ||
            gate.adminTransition ||
            (active && active.job?.id !== blockedJob.id) ||
            !same([...gate.active.keys()].sort(), [...originalActiveIds].sort())
          )
            fail(
              "BROKER_BUSY",
              "Original owner job or another broker operation is still active",
            );
          if (
            active &&
            (active.pending.size || (active.child && !active.workerClosed))
          )
            fail(
              "WORKER_PENDING",
              "Original worker/RPC has not settled; no atomic status was sent",
            );
          const previousObservation = Object.values(state.data.jobs).find(
            (job) => job.workflowObservation?.targetJobId === blockedJob.id,
          );
          if (
            previousObservation &&
            !(
              previousObservation.state === "failed" &&
              previousObservation.details?.["executionOutcome"] ===
                "not_started" &&
              previousObservation.details?.["mayHaveMutated"] === false &&
              (previousObservation.dispatch?.rpcCount || 0) === 0
            )
          )
            fail(
              "WORKFLOW_OBSERVATION_EXISTS",
              "A scoped atomic observation was already sent or has an uncertain receipt",
            );
          const scope = deriveAtomicHolderScope(
            blockedJob,
            invocation,
            blockedJob.request.cwd,
            observationScopeConfig,
          );
          if (!scope)
            fail(
              "INVALID_WORKFLOW_SCOPE",
              "Typed batch.reconcile does not point to the original blocked atomic report",
            );
          const identity = readJson<P.Identity>(identityFile);
          if (
            blockedJob.request.buildHash !== identity.buildHash ||
            !sameInstance(instance, identity.instance)
          ) {
            fail(
              "BUILD_CHANGED",
              "Original job/instance binding differs from the durable broker identity",
            );
          }
          if (!originalFusionProcessAlive(identity.instance))
            fail(
              "INSTANCE_CHANGED",
              "The original Fusion PID/birth identity is not live; no atomic status was sent",
            );
          const prepared = await prepareAtomicHolderObservation(
            blockedJob,
            scope,
            {
              clientId,
              observerBuildHash: codeHash,
              originalBuildHash: identity.buildHash,
              approvedScope: observationScopeConfig,
            },
          );
          const originalReceipts = validateAtomicOriginalReceipts(
            blockedJob,
            identity.buildHash,
            identity.instance,
            prepared.identity,
          );
          buildAtomicRuntimeAbi(
            blockedJob,
            prepared,
            originalReceipts.records,
            { dir },
          );
          validateAtomicReconcileInvocation(invocation, prepared);
          assertResetSubmissionOpen(dir);
          const currentContext = activeContext();
          if (
            busy() ||
            gate.resuming ||
            (currentContext && currentContext.job.id !== blockedJob.id) ||
            gate.adminTransition ||
            !same(
              [...gate.active.keys()].sort(),
              [...originalActiveIds].sort(),
            ) ||
            state.data.revision !== before.revision ||
            (state.data.controlGeneration || 0) !== before.generation ||
            (state.data.contextEpoch || 0) !== before.contextEpoch ||
            state.data.paused !== before.paused ||
            state.data.blocked?.id !== before.blocked ||
            state.data.active !== before.active ||
            !same(state.data.lease ?? null, before.lease)
          ) {
            fail(
              "WORKFLOW_GATE_CHANGED",
              "Queue fences changed during scoped observation preparation; no probe sent",
            );
          }
          const observerBuildHash = codeHash;
          workflowObservation = {
            version: 1,
            kind: "atomic-holder-status",
            targetJobId: blockedJob.id,
            targetRequestId: blockedJob.requestId,
            targetClientId: blockedJob.clientId,
            targetJobHash: blockedJob.hash,
            observerJobHash: "",
            targetBuildHash: identity.buildHash,
            observerBuildHash,
            projectDirectory: required(blockedJob.request.cwd),
            paused: before.paused,
            controlGeneration: before.generation,
            contextEpoch: before.contextEpoch,
            reportPath: prepared.scope.reportPath,
            reportFingerprint: prepared.reportFingerprint,
            commandId: prepared.identity.commandId,
            sessionNonce: prepared.identity.sessionNonce,
            docId: prepared.expectedContext.docId,
          };
          // This is a broker-scoped physical observation, not a normal worker turn.
          delete request.phased;
        }
        if (request.kind === "command" && Array.isArray(request.argv)) {
          // Stage ownership binds a physical preflight before preparing its
          // journal/helper context. Retain the preflight-first worker path for
          // these consumers; offline phased workers have no such evidence yet.
          if (!workflowObservation) {
            if (
              load(
                "./composition/stage-dependencies",
              ).requiresPhysicalStageOwner(request.payload)
            )
              delete request.phased;
            else request.phased = true;
          }
          const entry = commandEntry(request.argv);
          if (
            ["queue", "init", "console"].includes(
              entry?.key.split(" ")[0] ?? "",
            )
          )
            fail(
              "unsupported_queue_route",
              "Console and broker/configuration lifecycle commands are not queued workflows",
            );
          if (entry?.target === "animation.play")
            fail(
              "unsupported_queue_route",
              "Asynchronous animation.play has no supported terminal queue receipt",
            );
        }
        if (
          request.protocolVersion !== undefined &&
          (typeof request.protocolVersion !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(request.protocolVersion) ||
            !Number.isFinite(Date.parse(request.protocolVersion)) ||
            new Date(request.protocolVersion).toISOString().slice(0, 10) !==
              request.protocolVersion)
        )
          fail(
            "INVALID_PROTOCOL_VERSION",
            "protocolVersion must be a valid YYYY-MM-DD protocol date",
          );
        if (request.kind === "rpc") {
          request.payload = r.rpc?.payload || r.payload;
          request.sessionId = r.rpc?.sessionId ?? r.sessionId;
          delete request.rpc;
          if (request.sessionId === undefined) delete request.sessionId;
          const raw = rpcPayload(request.payload);
          if (isAddinMetadata(raw)) {
            if (!metadataAdmission)
              fail("unsupported_queue_route", "ADDIN metadata admission is not provisioned",
              );
            addinMetadataSelector(raw);
          } else validateRaw(raw);
        }
        if (
          request.inputFiles !== undefined &&
          (!Array.isArray(request.inputFiles) ||
            request.inputFiles.some(
              (f) =>
                !f ||
                typeof f.path !== "string" ||
                !/^[a-f0-9]{64}$/.test(f.sha256),
            ))
        )
          fail(
            "INVALID_INPUT_FILES",
            "Input files require path and lowercase SHA256",
          );
        if (
          (request.kind === "command" || request.inputFiles?.length) &&
          (typeof request.cwd !== "string" || !path.isAbsolute(request.cwd))
        )
          fail("INVALID_CWD", "Commands/input files require an absolute cwd");
        if (request.buildHash !== undefined && request.buildHash !== codeHash)
          throw Object.assign(
            new Error(
              "Submitted buildHash differs from pinned broker build; request was not admitted",
            ),
            { code: "BUILD_CHANGED", notStarted: true },
          );
        if (request.backend && request.backend !== (pinned.backend || "addin"))
          fail(
            "BACKEND_MISMATCH",
            "Job backend differs from the broker; no fallback",
          );
        // Preserve old request hashes; historical retries must not invent original
        // bytes by capturing their current source files.
        const existing = Object.values(state.data.jobs).some(
          (job) => job.requestId === request.requestId,
        );
        let rawPlan: LocalPlan | undefined;
        let preparedId: string | undefined;
        try {
          if (!existing && request.kind === "rpc") {
            preparedId = randomUUID();
            rawPreparations++;
            const rawPayload = rpcPayload(request.payload);
            const callerPayloadHash = hash(canonical(rawPayload));
            const turn = await prepareOwnedTurn(
              rawPayload,
              { id: preparedId, request },
              brokerExecution.createTurnIdentity(preparedId),
              undefined,
              isAddinMetadata(rawPayload),
            );
            resetFence();
            const flights = await prepareJobFlights({
              id: preparedId,
              request,
              kind: "rpc",
              sequenceMode: request.sequence?.mode,
            });
            rawPlan = { kind: "raw", turn, flights, callerPayloadHash };
          }
          // Offline raw preparation can outlive a stop/reset/build transition.
          // Recheck ownership before publishing an accepted job, not just at SDK send.
          const verifyAcceptance = () => {
            if (lifetime.stopping)
              throw Object.assign(
                new Error("Broker is stopping; request was not accepted"),
                { code: "BROKER_STOPPING", notStarted: true },
              );
            if (readJson<P.Owner>(lock).nonce !== marker.nonce)
              throw Object.assign(
                new Error("Broker ownership changed before acceptance"),
                { code: "LOCK_CHANGED", notStarted: true },
              );
            if (buildHash() !== codeHash)
              throw Object.assign(
                new Error("Executable changed before acceptance"),
                { code: "BUILD_CHANGED", notStarted: true },
              );
            resetFence();
          };
          verifyAcceptance();
          const target = !existing && acceptedContinuationTarget(request);
          let refuseContinuation = false;
          const staleContinuation = (error: unknown) =>
            ["DOCUMENT_CONTINUATION_UNPROVEN", "DOCUMENT_STATE_CHANGED",
              "DOCUMENT_UNLOCK_STALE", "CHECKPOINT_CHANGED"].includes(errorInfo(error).code ?? "");
          let preparedContinuation:
            import("../document-continuation-broker").PreparedDocumentContinuationSubmission | undefined;
          if (target) {
            try {
              // The normal worker reads the canonically persisted request.
              // Match its object key order before compiling exact source bytes.
              const { clone } = runtimeRequire("./dist/core/application/cad/json") as
                typeof import("../../packages/core/src/application/cad/json");
              preparedContinuation = await continuation.prepareSubmit(
                clone(request) as unknown as import("@fmcad/core").QueueRequest,
                { clientId, clientTokenHash: required(clientHashes()[clientId]) },
              );
            } catch (error) {
              if (!staleContinuation(error)) throw error;
              refuseContinuation = true;
            }
            verifyAcceptance();
          }
          const accept = () => {
            verifyAcceptance();
            if (state.epoch || approvedRuntimeRoot) admitEpochRequest(request);
            if (!existing)
              load(
                "./dist/node-adapters/persistence/accepted-inputs",
              ).retainAdmission(dir, request);
            let job: P.PublicJob;
            try {
              job = (refuseContinuation
                ? state.refuseDocumentContinuation(request, preparedId)
                : preparedContinuation
                  ? preparedContinuation.submit() : state.submit(request, preparedId)) as P.PublicJob;
            } catch (error) {
              if (!preparedContinuation || !staleContinuation(error)) throw error;
              job = state.refuseDocumentContinuation(request, preparedId) as P.PublicJob;
            }
            const admitted = state.data.jobs[job.id];
            if (admitted?.documentContinuation) continuationJobs.add(job.id);
            writeRequestTrace(admitted?.request ?? request, clientId, {
              stage: "request-accepted",
              status: "passed",
              jobId: job.id,
              buildHash: codeHash,
              stdoutObservation: "not_observed",
            });
            if (workflowObservation) {
              workflowObservation.observerJobHash = required(
                state.data.jobs[job.id],
              ).hash;
              state.armWorkflowObservation(job.id, workflowObservation);
            }
            if (rawPlan && job.id === preparedId)
              localPlans.set(job.id, rawPlan);
            if (request.phased && job.state === "preparing")
              phased.start(required(state.data.jobs[job.id]));
            return job;
          };
          // Original request lookup remains available after archival and never
          // creates a second job. New durable acceptance shares the project's
          // lifecycle fence with archive and presence writers.
          if (existing) return accept();
          for (;;) {
            let accepting = false;
            try {
              return projectActivity.withProjectActivityFence(
                request.cwd,
                () => {
                  accepting = true;
                  return accept();
                },
              );
            } catch (error) {
              // The callback has not run: no input retention, job acceptance or
              // worker launch occurred. Yield IPC while another writer settles.
              if (
                accepting ||
                !error ||
                typeof error !== "object" ||
                !("code" in error) ||
                error.code !== "REGISTRY_BUSY" ||
                ("retryable" in error && error.retryable === false)
              )
                throw error;
              await new Promise((resolve) => setTimeout(resolve, 10));
              verifyAcceptance();
            }
          }
        } finally {
          if (preparedId) rawPreparations--;
          lifetime.progress();
        }
      }
      case "control-status":
        return gate.snapshot();
      case "queue-summary": {
        const jobs = Object.values(state.data.jobs);
        const stateCounts: Record<string, number> = {};
        for (const job of jobs)
          stateCounts[job.state] = (stateCounts[job.state] || 0) + 1;
        return {
          ...state.summary(),
          jobCount: jobs.length,
          stateCounts,
          ...(state.epoch &&
          (successorRuntime?.authority.sourceCommit ||
            readJson<P.Identity>(identityFile).sourceCommit)
            ? {
                sourceCommit:
                  successorRuntime?.authority.sourceCommit ||
                  readJson<P.Identity>(identityFile).sourceCommit,
              }
            : {}),
          ...(successorControl
            ? { deadEpochSuccessor: successorControl.metadata() }
            : {}),
          nonterminalJobCount: jobs.filter(
            (job) =>
              !["succeeded", "failed", "cancelled", "expired"].includes(
                job.state,
              ),
          ).length,
          control: gate.snapshot(),
          held: heldReason(),
          stopping: lifetime.stopping,
          recovery,
          buildHash: codeHash,
          features: {
            projectHistoryActivityFence: true,
            conditionalIdleStop: true,
            phasedCommands: true,
            atomicWorkflowObserve: true,
            atomicRecoveryAudit: true,
            atomicRecoveryProcessLossAudit: !!currentAuditScope,
            auditFactsCapture: !!currentAuditScope?.auditResponseRecovery,
            deadEpochSuccessor: !!successorControl,
            isolatedScratchEpoch:
              !!currentAuditScope?.epochPrerequisite ||
              !!state.epoch ||
              !!factsCapture.approvedPrerequisite(),
            savedFirstSaveLifecycle: !!state.epoch && !epochProcessUnavailable,
          },
          isolatedScratchScope: isolatedScratchScope(),
          ...(currentAuditScope
            ? {
                recoveryAuditScope: {
                  purpose: currentAuditScope.purpose,
                  originalInstance: currentAuditScope.originalInstance,
                  currentInstance: currentAuditScope.currentInstance,
                  historicalProcessState: "terminated",
                  currentModelingAdmission: state.epoch
                    ? isolatedScratchScope().admission
                    : "blocked",
                  newInstanceRebound: false,
                  endpointVerified: false,
                },
              }
            : {}),
        };
      }
      case "find-request": {
        if (!identifier(message.requestId))
          fail("INVALID_REQUEST", "requestId must contain 1..256 characters");
        if (message.expectedRequest !== undefined) {
          const prior = state.epoch || approvedRuntimeRoot
            ? state.findAnyRequest(clientId, message.requestId) : null;
          const retained = prior && state.lookup(prior.id);
          const id = load(
            "./dist/core/domain/queue-request-identity",
          ).matchAdmittedRequest(
            retained ? { [retained.id]: retained } : state.data.jobs,
            clientId,
            message.requestId,
            message.expectedRequest,
            same,
          );
          return {
            job: id ? state.status(id) : null,
            requestMatched: id !== null,
            buildHash: codeHash,
          };
        }
        if (state.epoch || approvedRuntimeRoot)
          return {
            job: state.findAnyRequest(clientId, message.requestId),
            buildHash: codeHash,
          };
        const matches = Object.values(state.data.jobs).filter(
          (job) =>
            job.requestId === message.requestId && job.clientId === clientId,
        );
        if (matches.length > 1)
          fail(
            "REQUEST_CONFLICT",
            "Broker returned conflicting jobs for one owned requestId",
          );
        return {
          job: matches.length ? state.status(required(matches[0]).id) : null,
          buildHash: codeHash,
        };
      }
      case "status":
        return message.jobId
          ? state.status(message.jobId)
          : {
              ...state.status(),
              control: gate.snapshot(),
              held: heldReason(),
              stopping: lifetime.stopping,
              recovery,
              buildHash: codeHash,
              ...(successorControl
                ? { deadEpochSuccessor: successorControl.metadata() }
                : {}),
              features: {
                projectHistoryActivityFence: true,
                conditionalIdleStop: true,
                phasedCommands: true,
                atomicWorkflowObserve: true,
                atomicRecoveryAudit: true,
                atomicRecoveryProcessLossAudit: !!currentAuditScope,
                auditFactsCapture: !!currentAuditScope?.auditResponseRecovery,
                isolatedScratchEpoch:
                  !!currentAuditScope?.epochPrerequisite ||
                  !!state.epoch ||
                  !!factsCapture.approvedPrerequisite(),
              },
              isolatedScratchScope: isolatedScratchScope(),
              ...(currentAuditScope
                ? {
                    recoveryAuditScope: {
                      purpose: currentAuditScope.purpose,
                      originalInstance: currentAuditScope.originalInstance,
                      currentInstance: currentAuditScope.currentInstance,
                      historicalProcessState: "terminated",
                      currentModelingAdmission: state.epoch
                        ? isolatedScratchScope().admission
                        : "blocked",
                      newInstanceRebound: false,
                      endpointVerified: false,
                    },
                  }
                : {}),
            };
      case "cancel":
        return state.cancel(required(message.jobId), clientId);
      case "release":
        return state.release(required(message.sequenceId), clientId);
      case "reconcile":
        if (busy()) fail("BROKER_BUSY", "Original execution has not settled");
        lane.setAdministrative(true);
        try {
          return own(message, "acceptedOutcome")
            ? await acceptAtomicObservation(
                required(message.jobId),
                clientId,
                required(message.acceptedOutcome),
              )
            : await gate.administrative(() =>
                reconcile(required(message.jobId), clientId),
              );
        } finally {
          lane.setAdministrative(false);
          diagnostics();
          lifetime.progress();
        }
      case "stop":
        if (message.onlyIfQuiescent === true) {
          if (
            message.expectedBuildHash !== codeHash ||
            message.expectedRevision !== state.summary().revision
          )
            fail("STATE_CONFLICT", "Broker changed before idle reload");
          if (
            heldReason() ||
            activeContext() ||
            busy() ||
            rawPreparations ||
            gate.active.size ||
            gate.resuming ||
            state.summary().active ||
            state.summary().blocked ||
            state.summary().lease ||
            Object.values(state.data.jobs).some(
              (job) =>
                !["succeeded", "failed", "cancelled", "expired"].includes(
                  job.state,
                ),
            )
          )
            fail(
              "QUEUE_BUSY",
              "Idle-only reload cannot stop active, queued, processing, leased or unknown work",
            );
        }
        // Latch admission before acknowledging; the accepted IPC reply is
        // flushed by the transport even if shutdown wins the next turn.
        void lifetime.requestStop().catch(() => diagnostics());
        return { stopping: true, draining: !!state.summary().active };
      default:
        fail("INVALID_ACTION", "Unknown broker action");
    }
  }

  function dispatchResult(clientId: string, publicJob: ReturnType<typeof owned> | undefined,
  ) {
        if (!publicJob)
          return {
            ...state.status(),
            held: heldReason(),
            stopping: lifetime.stopping,
            recovery,
            buildHash: codeHash,
          };
        if (
          [
            "succeeded",
            "failed",
            "cancelled",
            "expired",
            "needs_reconciliation",
          ].includes(publicJob.state) &&
          !debugResultPublished.has(publicJob.id)
        ) {
          const job = state.lookup(publicJob.id);
          const trace = debugTraceContext(job.request, clientId);
          if (trace) {
            const artifactName =
              job.kind === "rpc" ? "rpc-result.json" : "stdout.txt";
            let artifactRef: string | undefined;
            let stdoutObservation:
              "not_observed" | "observed_empty" | "observed_nonempty" =
              "not_observed";
            let stdoutBytes: number | undefined;
            try {
              const file = load("./queue-response-files").responsePath(
                dir,
                job,
                artifactName,
              );
              const stat = fs.lstatSync(file);
              if (stat.isFile() && !stat.isSymbolicLink()) {
                artifactRef = artifactName;
                if (job.kind === "command") {
                  stdoutBytes = stat.size;
                  stdoutObservation =
                    stat.size === 0 ? "observed_empty" : "observed_nonempty";
                }
              }
            } catch {
              // Trace metadata never gates retrieval of the owned result.
            }
            writeRequestTrace(job.request, clientId, {
              stage: "result-published",
              status:
                publicJob.state === "succeeded"
                  ? "published"
                  : publicJob.state === "needs_reconciliation"
                    ? "unknown"
                    : "failed",
              jobId: job.id,
              buildHash: codeHash,
              code: publicJob.code,
              artifactRef,
              stdoutBytes,
              stdoutObservation,
            });
            debugResultPublished.add(publicJob.id);
          }
        }
        return {
          job: publicJob,
          ...outputs(publicJob.id),
        };
  }

  async function executeAtomicObservation(
    observerJob: P.Job,
    grant: ProductGrant,
  ) {
    const marker = observerJob.workflowObservation;
    const targetJob = marker && state.data.jobs[marker.targetJobId];
    const payload = observerJob.request.payload;
    const invocation =
      payload?.kind === "cad-command" ? payload.invocation : payload;
    if (
      !marker ||
      !targetJob ||
      !deriveAtomicHolderScope(
        targetJob,
        invocation,
        targetJob.request.cwd,
        observationScopeConfig,
      )
    )
      fail(
        "WORKFLOW_OWNER_OR_JOB_MISMATCH",
        "Queued observer no longer matches its blocked atomic owner job",
      );
    if (
      observerJob.request.buildHash !== codeHash ||
      observerJob.request.backend !== "addin" ||
      observerJob.clientId !== targetJob.clientId
    ) {
      fail(
        "BUILD_CHANGED",
        "Scoped observation job is not pinned to the current add-in observer build/owner",
      );
    }
    const currentIdentity = readJson<P.Identity>(identityFile);
    if (
      targetJob.request.buildHash !== marker.targetBuildHash ||
      currentIdentity.buildHash !== marker.targetBuildHash ||
      !sameInstance(instance, currentIdentity.instance)
    ) {
      fail(
        "BUILD_CHANGED",
        "Original job build/instance binding changed; no atomic status was sent",
      );
    }
    if (!originalFusionProcessAlive(currentIdentity.instance))
      fail(
        "INSTANCE_CHANGED",
        "The original Fusion PID/birth identity is not live; no atomic status was sent",
      );
    if (
      state.data.paused !== marker.paused ||
      (state.data.controlGeneration || 0) !== marker.controlGeneration ||
      (state.data.contextEpoch || 0) !== marker.contextEpoch ||
      state.data.lease
    ) {
      fail(
        "WORKFLOW_GATE_CHANGED",
        "Pause/reset/lease context changed since the owner submitted scoped observation",
      );
    }
    const unboundPrepared = await prepareAtomicHolderObservation(
      targetJob,
      {
        version: 1,
        kind: "atomic_holder_status",
        jobId: targetJob.id,
        requestId: targetJob.requestId,
        projectDirectory: targetJob.request.cwd,
        reportPath: marker.reportPath,
        commandId: marker.commandId,
        sessionNonce: marker.sessionNonce,
        docId: marker.docId,
      },
      {
        clientId: observerJob.clientId,
        observerBuildHash: codeHash,
        originalBuildHash: marker.targetBuildHash,
        approvedScope: observationScopeConfig,
      },
    );
    const originalReceipts = validateAtomicOriginalReceipts(
      targetJob,
      marker.targetBuildHash,
      currentIdentity.instance,
      unboundPrepared.identity,
    );
    const prepared = bindAtomicRuntimeAbi(
      unboundPrepared,
      buildAtomicRuntimeAbi(
        targetJob,
        unboundPrepared,
        originalReceipts.records,
        {
          dir,
        },
      ),
    );
    validateAtomicReconcileInvocation(invocation, prepared);
    if (
      prepared.reportFingerprint !== marker.reportFingerprint ||
      prepared.identity.commandId !== marker.commandId ||
      prepared.identity.sessionNonce !== marker.sessionNonce ||
      prepared.identity.documentIdentity?.resolved?.creationId !==
        marker.docId ||
      marker.targetJobHash !== targetJob.hash ||
      marker.observerBuildHash !== codeHash
    ) {
      fail(
        "WORKFLOW_IDENTITY_MISMATCH",
        "Scoped observer marker no longer matches immutable report/job identity",
      );
    }

    const originalContext = lane.heldWorker();
    if (
      originalContext &&
      (originalContext.job?.id !== targetJob.id ||
        originalContext.pending?.size ||
        (originalContext.child && !originalContext.workerClosed))
    ) {
      fail(
        "WORKER_PENDING",
        "Original worker/RPC is still pending; no scoped observer sent",
      );
    }
    const nativeId = originalContext?.nativeActivityId;
    const originalActiveIds =
      nativeId && gate.active.has(nativeId) ? [nativeId] : [];
    const initialActiveIds = [...gate.active.keys()].sort();
    if (!same(initialActiveIds, [...originalActiveIds].sort()))
      fail(
        "BROKER_BUSY",
        "A different physical admission is active; scoped observation is deferred",
      );
    const initialState = {
      active: state.data.active,
      blocked: structuredClone(state.data.blocked),
      paused: marker.paused,
      controlGeneration: marker.controlGeneration,
      contextEpoch: marker.contextEpoch,
      lease: null,
    };
    if (
      initialState.active !== observerJob.id ||
      initialState.blocked?.id !== targetJob.id
    )
      fail(
        "WORKFLOW_GATE_CHANGED",
        "Queue no longer has the authorized observer turn",
      );
    const observerDirectory = privateDirectory(jobDir(observerJob.id));
    const scope: P.ObservationScope = {
      assertGrant: () => lane.assertCurrent(grant),
      targetJob,
      observerJob,
      clientId: observerJob.clientId,
      prepared,
      expectedInstance: currentIdentity.instance,
      instanceBuildHash: currentIdentity.buildHash,
      initialState,
      initialActiveIds,
      originalActiveIds,
      expectedToolCode: prepared.script + '\n\nrun("")\n',
      startPath: path.join(observerDirectory, "atomic-observation-start.json"),
      resultPath: path.join(observerDirectory, "atomic-observation-proof.json"),
      toolStarted: false,
      proof: null,
      originalContext,
    };
    atomicObservationFence(scope, false);
    if (fs.existsSync(scope.startPath) || fs.existsSync(scope.resultPath))
      fail(
        "WORKFLOW_OBSERVATION_REPLAY",
        "A durable scoped observation already exists; no second request is sent",
      );

    const context: P.Context = {
      job: observerJob,
      token: randomBytes(32).toString("hex"),
      pending: new Set(),
      dispatched: false,
      unknown: false,
      timedOut: false,
      workerClosed: true,
      executionFailed: false,
      deadline: Date.now() + observerJob.timeoutMs,
      contextEpoch: state.data.contextEpoch || 0,
      turnRpcs: [],
      workflowObservation: scope,
    };
    scope.observerContext = context;
    grant.context.worker = context;
    try {
      await atomicObservationScope.run(scope, () =>
        client.callTool(
          {
            featureType: "script",
            object: { script: prepared.script, readOnly: true },
          },
          "fusion_mcp_execute",
        ),
      );
      if (!scope.proof)
        fail(
          "WORKFLOW_OBSERVATION_RECEIPT_UNAVAILABLE",
          "Scoped atomic_status returned without its bound proof receipt",
        );

      let output;
      if (scope.proof.toolFailed || scope.proof.remoteOutcome !== "succeeded") {
        output = {
          operation: "batch.reconcile",
          runId: prepared.identity.runId,
          requestHash: prepared.identity.requestHash,
          outcome: "unknown",
          status: "unavailable",
          receiptOutcome: "unknown",
          nativeOutcome: null,
          observation: { status: "unavailable", destroyed: false },
          candidates: [],
          unavailableEvidence: ["bound atomic_status tool receipt failed"],
        };
      } else {
        const observer = {
          capabilities: { backend: "addin", atomicBatch: true },
          server: client.server,
          async callTool() {
            return {
              failed: false,
              text:
                "FMCAD_RESULT " + JSON.stringify(required(scope.proof).summary),
            };
          },
        };
        const atomic = load("./batch-atomic");
        atomic.setObserveReadOnlyCatalog(load("./catalog").catalog);
        output = await atomic.reconcileAtomicBatch(
          observer,
          prepared.scope.reportPath,
          [],
        );
      }
      const stdout = JSON.stringify(output) + "\n";
      if (Buffer.byteLength(stdout) > MAX - 4096)
        fail(
          "OUTPUT_PUBLICATION_FAILED",
          "Scoped atomic status summary exceeds the bounded observer output",
        );
      fs.writeFileSync(
        load("./queue-response-files").responsePath(
          dir,
          observerJob,
          "stdout.txt",
          true,
        ),
        stdout,
        { flag: "wx", mode: 0o600 },
      );
      const details = {
        state:
          !scope.proof.toolFailed &&
          scope.proof.remoteOutcome === "succeeded" &&
          scope.proof.identityMatches
            ? "succeeded"
            : "failed",
        code:
          scope.proof.toolFailed || scope.proof.remoteOutcome !== "succeeded"
            ? "ATOMIC_STATUS_UNAVAILABLE"
            : scope.proof.identityMatches
              ? "ATOMIC_STATUS_OBSERVED"
              : "ATOMIC_STATUS_IDENTITY_MISMATCH",
        executionOutcome:
          !scope.proof.toolFailed &&
          scope.proof.remoteOutcome === "succeeded" &&
          scope.proof.identityMatches
            ? "succeeded"
            : "failed",
        mayHaveMutated: false,
        sdkSettled: true,
        publicationOutcome: "published",
        observationTargetJobId: targetJob.id,
        observationProof: path.relative(dir, scope.resultPath),
      };
      durable(path.join(observerDirectory, "outcome.json"), details);
      finishTurn(grant, details);
      recovery = {
        jobId: targetJob.id,
        observationJobId: observerJob.id,
        status: "atomic_status_observed",
        at: Date.now(),
      };
      diagnostics();
    } catch (cause) {
      const error = errorInfo(cause);
      if (
        scope.toolStarted ||
        (state.status(observerJob.id).dispatch?.rpcCount || 0) > 0
      ) {
        if (state.status(observerJob.id).state !== "needs_reconciliation")
          hold(
            grant,
            "Atomic status observation outcome is unknown; no replay",
          );
      } else if (state.status(observerJob.id).state === "running") {
        const details = {
          state: "failed",
          code: error.code || "ATOMIC_OBSERVATION_NOT_STARTED",
          executionOutcome: "not_started",
          mayHaveMutated: false,
          sdkSettled: true,
          publicationOutcome: "not_started",
          message: error.message,
          ...(error.pythonCheck ? { pythonCheck: error.pythonCheck } : {}),
        };
        durable(path.join(observerDirectory, "outcome.json"), details);
        finishTurn(grant, details);
      }
      diagnostics();
      throw error;
    }
  }

  async function execute(job: P.Job, grant: ProductGrant) {
    if (job.documentInspection) return executeCheckpointRead(job, grant);
    const directory = privateDirectory(jobDir(job.id));
    const plan = localPlans.get(job.id);
    localPlans.delete(job.id);
    const flights = plan?.flights;
    const notStartedDetails = {
      executionOutcome: job.physicalTurns
        ? "previous_turns_complete_current_not_started"
        : "not_started",
      userScriptSubmitted: !!job.dispatch?.rpcCount,
      mayHaveMutated: !!job.dispatch?.rpcCount,
      currentTurnSubmitted: false,
    };
    let previousTurn: P.Instance["documentState"] | null = null;
    let observed: P.Instance | undefined;
    let guardSelector: ReturnType<typeof documentSelector> | undefined;
    let allowsBusyAfter = false;
    return brokerExecution.runBrokerProductTurn({
      inspectPrepared() {
        let localContextChanged = false;
        flights?.preflight.send.fence();
        flights?.postflight.send.fence();
        if (job.request.phased) {
          if (
            plan?.kind !== "worker" ||
            phased.pending(job.id)?.message !== plan.message
          )
            fail("PREPARED_RPC_UNAVAILABLE", "The prepared worker turn is gone",
            );
          plan.send.fence();
        }
        if (job.kind === "rpc") {
          if (plan?.kind !== "raw")
            fail(
              "PREPARED_RPC_UNAVAILABLE",
              "The original checked RPC is unavailable; it is never reconstructed for replay",
            );
          plan.turn.inspect((prepared) => {
            (prepared.metadataProof ?? prepared.pythonCertificate).fence(prepared.outgoing,
            );
            localContextChanged =
              !prepared.metadataOnly &&
              prepared.contextEpoch !== (state.data.contextEpoch || 0);
          });
        }
        return localContextChanged;
      },
      errorInfo,
      refusePreparation(error) {
        const details = {
          state: "failed",
          code: error.code || "LOCAL_PREPARATION_FAILED",
          executionOutcome: job.physicalTurns
            ? "previous_turns_complete_current_not_started"
            : "not_started",
          currentTurnSubmitted: false,
          mayHaveMutated: !!job.dispatch?.rpcCount,
          ...(error.pythonCheck ? { pythonCheck: error.pythonCheck } : {}),
        };
        durable(path.join(directory, "outcome.json"), details);
        finishTurn(grant, details);
        if (job.request.phased)
          phased.reject(job.id, Object.assign(error, { notStarted: true }));
      },
      runObservation: job.workflowObservation
        ? () => executeAtomicObservation(job, grant)
        : undefined,
      verifyLocalInputs() {
        if (job.request.phased && job.physicalTurns) {
          previousTurn = readJson<P.Instance>(path.join(directory, "postflight.json"),
          )
            .documentState;
          archiveCompletedBrokerTurn(directory, job.physicalTurns, {
            privateDirectory,
            read: readJson,
            writeFresh: (file, value) => durable(file, value, true),
          });
        }
        const inputFailure = checkBrokerTurnInputs(job.request, codeHash);
        if (!inputFailure) return true;
        const details = {
          state: "failed",
          code: inputFailure,
          ...notStartedDetails,
        };
        durable(path.join(directory, "outcome.json"), details);
        finishTurn(grant, details);
        if (job.request.phased)
          phased.reject(
            job.id,
            Object.assign(new Error(inputFailure), {
              code: inputFailure,
              notStarted: true,
            }),
          );
        return false;
      },
      assertCurrent: () => lane.assertCurrent(grant),
      preflight() {
        const entry =
          job.kind === "command" ? commandEntry(required(job.request.argv)) : null;
        const raw = job.kind === "rpc" ? rpcPayload(job.request.payload) : null;
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
          ["ui.inspect", "ui.respond", "ui.resolve"].includes(entry?.target ?? "",
          );
        allowsBusyAfter = protocolOnly || entry?.target === "ui.inspect";
        guardSelector = raw && isAddinMetadata(raw)
          ? addinMetadataSelector(raw)
          : job.request.phased ||
            job.sequenceMode === "automatic" ||
            job.contextRefreshRequired ||
            load("./composition/stage-dependencies",
                ).requiresPhysicalStageOwner(
              job.request.payload)
            ? documentSelector(job)
            : undefined;
        // Record completion before applying idle policy. A lost response
        // retains the bound remote receipt for later observation.
        const rpcId = flights?.preflight.binding.rpcId || randomUUID();
        const binding = flights?.preflight.binding || {
          jobId: job.id,
          rpcId,
          requestHash: hash("preflight:" + job.id + ":" + rpcId),
          buildHash: codeHash,
        };
        const receipt =
          flights?.preflight.receipt ||
          path.join(directory, "preflight-" + rpcId + ".receipt.json");
        return checkTurnInstance(
        grant,
        {
          prepared: flights?.preflight,
          receiptPath: receipt,
          binding,
          requireIdle: !allowsBusy,
          diagnosticPath: path.join(directory, "preflight-result.json"),
          documentSelector: guardSelector,
          onObservation: (observation) => {
            lane.assertCurrent(grant);
            observed = observation;
            executionRecords.recordProbeTerminal(job.id, "preflight", {
              version: 2,
              jobId: job.id,
              buildHash: codeHash,
              completed: true,
              instance: observation,
              idle: idle(observation),
              requiresIdle: !allowsBusy,
            });
          },
        },
        () =>
          executionRecords.createProbeIntent(job.id, "preflight", {
            version: 2,
            jobId: job.id,
            buildHash: codeHash,
            instance,
            at: Date.now(),
            binding,
            receipt,
          }),
      );
      },
      sameObservedInstance: (error) => sameInstance(error.observation, instance),
      refusePreflight(refusal, error) {
      const outcome = {
        state: "failed",
        ...notStartedDetails,
        ...refusal,
        ...(refusal.preflightCompleted
          ? { activeCommand: required(error.observation).activeCommand }
          : {}),
      };
      durable(path.join(directory, "outcome.json"), outcome);
      finishTurn(grant, outcome);
      if (job.request.phased)
        phased.reject(
          job.id,
          Object.assign(new Error(error.message), {
            code: refusal.code,
            notStarted: true,
          }),
        );
      },
      verifyDocument(localContextChanged) {
    if (
      localContextChanged ||
      (job.request.phased && job.physicalTurns) ||
      (job.sequenceMode === "automatic" && job.sequenceParentId) ||
      (job.contextRefreshRequired && !guardSelector?.metadataOnly)
    ) {
      const baselineFile = job.sequenceParentId
        ? path.join(jobDir(job.sequenceParentId), "postflight.json")
        : null;
      const baseline =
        previousTurn ||
        (baselineFile && fs.existsSync(baselineFile)
          ? readJson<P.Instance>(baselineFile).documentState
          : null);
      const code = localContextChanged
        ? "DOCUMENT_CHANGED"
        : compareDocumentState(baseline, observed?.documentState);
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
        durable(refreshedStatePath, refresh);
        durable(path.join(directory, "outcome.json"), {
          state: "failed",
          code,
          ...notStartedDetails,
          refreshedStatePath,
        });
        fs.writeFileSync(
          load("./queue-response-files").responsePath(
            dir,
            job,
            "stdout.txt",
            true,
          ),
          JSON.stringify(refresh) + "\n",
          { flag: job.request.phased ? "a" : "wx", mode: 0o600 },
        );
        finishTurn(grant, {
          state: "failed",
          code,
          ...notStartedDetails,
          refreshedStatePath,
        });
        if (job.request.phased)
          phased.reject(
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
        executePreparedProduct(job, grant, plan, directory, guardSelector, allowsBusyAfter, observed,
        ),
    });
  }

  async function executeCheckpointRead(job: P.Job, grant: ProductGrant) {
    const task = checkpointReads.get(job.id);
    if (!task) {
      // A process restart does not reconstruct/replay a retained private read.
      // Dispatched reads remain UNKNOWN in the existing domain recovery path.
      if (job.dispatch?.rpcCount)
        return hold(grant, "Original checkpoint read has no live producer");
      return finishTurn(grant, {
        state: "failed", code: "CHECKPOINT_READ_NOT_STARTED",
        executionOutcome: "not_started", userScriptSubmitted: false, mayHaveMutated: false,
      });
    }
    try {
      await runCheckpointRead(job, grant, task);
    } catch (cause) {
      // Includes setup, durable outcome/hold and diagnostics failures. Client
      // terminal notification must not depend on a successful disk write.
      task.reject(cause);
      // Keep the existing scheduler's failure route authoritative: it records a
      // durable UNKNOWN hold if the read crossed the SDK boundary. Swallowing
      // this would leave an active sending job without reconciliation.
      throw cause;
    } finally {
      checkpointReads.delete(job.id);
    }
  }

  async function runCheckpointRead(job: P.Job, grant: ProductGrant,
    task: NonNullable<ReturnType<typeof checkpointReads.get>>) {
    const directory = privateDirectory(jobDir(job.id));
    const context: P.ProductContext = {
      job, productTurn: grant.turn, token: randomBytes(32).toString("hex"),
      pending: new Set(), dispatched: false, unknown: false, timedOut: false,
      workerClosed: false, executionFailed: false, deadline: Date.now() + job.timeoutMs,
      contextEpoch: state.data.contextEpoch || 0, turnRpcs: [], localDispatchErrors: new Set(),
    };
    let rejectTimeout!: (error: unknown) => void;
    const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    timeout.catch(() => {});
    context.budget = new PauseBudget(job.timeoutMs, () => {
      context.timedOut = true;
      let cause: unknown = Object.assign(new Error("Checkpoint read timed out"), { code: "RUN_TIMEOUT" });
      try {
        if (context.dispatched && lane.currentGrant() === grant)
          hold(grant, "Checkpoint read execution deadline expired; no replay");
      } catch (error) { cause = error; }
      finally { rejectTimeout(cause); }
    });
    grant.context.worker = context;
    let settled = false;
    try {
      assertCheckpointOwner();
      checkpointAdmission.authorize(task.actor, "inspect", task.target).recheck();
      if (job.documentInspection?.generation !== currentCheckpointGeneration())
        fail("DOCUMENT_STATE_CHANGED", "Checkpoint generation changed before its turn");
      const send = required(task.send);
      checkpointAdmission.authorize(task.actor, "inspect", task.target).recheck();
      send.fence();
      const pending = physicalGrant.run(grant, () => send());
      context.pending.add(pending);
      void pending.finally(() => context.pending.delete(pending)).catch(() => {});
      const result = await Promise.race([pending, timeout]);
      lane.assertCurrent(grant);
      const retained = state.data.jobs[job.id];
      for (const entry of retained?.physicalDispatches ?? []) {
        const proof = await required(options.physicalTurnQuiescence)(entry.physical);
        lane.assertCurrent(grant);
        if (!validRelease(proof, entry.physical, hash) ||
            (proof as { evidenceDigest?: string }).evidenceDigest !==
              hash(physicalReleaseInput(entry.physical, "dispatch-finally")))
          fail("SDK_QUIESCENCE_UNPROVEN", "Checkpoint SDK turn is not irreversibly released");
      }
      if (!retained?.physicalDispatches?.length ||
          !context.turnRpcs.length || context.turnRpcs.some((item) => !item.record.terminal))
        fail("SDK_QUIESCENCE_UNPROVEN", "Checkpoint terminal RPC is unavailable");
      settled = true;
      checkpointAdmission.authorize(task.actor, "inspect", task.target).recheck();
      if (!isToolResult(result) || result.failed || context.executionFailed)
        fail("DOCUMENT_STATE_CHANGED", "Checkpoint read did not return a successful result");
      const parsed = parseNativeResult(result.text);
      if (parsed["success"] !== true || parsed["operation"] !== "param.inspect")
        fail("DOCUMENT_STATE_CHANGED", "Checkpoint result operation changed");
      const checkpoint = checkpointEvidence.decode(parsed["result"], job.documentInspection!.target);
      const readRecords = context.turnRpcs.map((item) => item.record).filter((record) =>
        (record.binding["documentScope"] as { operation?: string } | undefined)?.operation === "param.inspect");
      if (readRecords.length !== 1)
        fail("STORAGE_UNAVAILABLE", "Fresh checkpoint requires one original read receipt");
      const record = readRecords[0]!;
      const { sealFreshCheckpointReceipt } = runtimeRequire("./document-checkpoint-receipt") as
        typeof import("../document-checkpoint-receipt");
      sealFreshCheckpointReceipt({
        directory: dir, jobId: job.id, rpcId: record.binding.rpcId,
        receiptPath: required(record.receipt),
        authenticateOriginal(bytes) {
          lane.assertCurrent(grant);
          assertCheckpointOwner();
          checkpointAdmission.authorize(task.actor, "inspect", task.target).recheck();
          if (checkpointReads.get(job.id) !== task || record.terminal !== true ||
              record.binding.jobId !== job.id ||
              job.documentInspection?.generation !== currentCheckpointGeneration() ||
              !retained.physicalDispatches?.some((entry) =>
                entry.physical.turnId === record.binding.rpcId &&
                same(entry.physical, record.binding["physicalTurn"])))
            fail("STORAGE_UNAVAILABLE", "Fresh checkpoint receipt lost its original turn");
          const original = decodeAdmissionJson(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          ) as P.RemoteReceipt;
          remoteReceipt(record, true, original);
          if (!same(original, record.remoteReceipt))
            fail("STORAGE_UNAVAILABLE", "Fresh checkpoint receipt bytes differ from its terminal RPC");
        },
      });
      finishTurn(grant, {
        state: "succeeded", code: "CHECKPOINT_READ_COMPLETE", sdkSettled: true,
        userScriptSubmitted: false, mayHaveMutated: false, currentTurnSubmitted: true,
      });
      task.resolve({ jobId: job.id, checkpoint });
    } catch (cause) {
      task.reject(cause);
      if (lane.currentGrant() === grant) {
        if ((!context.dispatched && !context.unknown) || settled) {
          const details = {
            state: "failed", code: errorInfo(cause).code || "CHECKPOINT_READ_FAILED",
            ...(context.dispatched ? { sdkSettled: true } : { executionOutcome: "not_started" }),
            userScriptSubmitted: false, mayHaveMutated: false,
          };
          durable(path.join(directory, "outcome.json"), details);
          finishTurn(grant, details);
        } else hold(grant, "Checkpoint read outcome is unknown; original request is not replayed");
      }
    } finally {
      context.workerClosed = true;
      context.budget.close();
      checkpointReads.delete(job.id);
      diagnostics();
    }
  }

  async function executePreparedProduct(
    job: P.Job,
    grant: ProductGrant,
    plan: LocalPlan | undefined,
    directory: string,
    guardSelector: ReturnType<typeof documentSelector> | undefined,
    allowsBusyAfter: boolean,
    observed: P.Instance | undefined,
  ) {
    const flights = plan?.flights;
    const context: P.ProductContext = {
      job,
      productTurn: grant.turn,
      token: job.request.phased
        ? required(phased.token(job.id))
        : randomBytes(32).toString("hex"),
      pending: new Set(),
      dispatched: false,
      unknown: false,
      timedOut: false,
      workerClosed: false,
      executionFailed: false,
      deadline: Date.now() + (job.sdkRemainingMs ?? job.timeoutMs),
      contextEpoch: state.data.contextEpoch || 0,
      turnRpcs: [],
      localDispatchErrors: new Set(),
    };
    let rejectTimeout: (error: unknown) => void;
    context.timeoutPromise = new Promise((resolve, reject) => {
      rejectTimeout = reject;
    });
    context.timeoutPromise.catch(() => {});
    context.budget = new PauseBudget(
      job.sdkRemainingMs ?? job.timeoutMs,
      () => {
        context.timedOut = true;
        if (context.dispatched)
          hold(
            grant,
            "Execution budget expired; remote operation is not cancelled",
          );
        context.child?.kill("SIGKILL");
        rejectTimeout(
          Object.assign(new Error("Execution budget expired"), {
            code: "RUN_TIMEOUT",
          }),
        );
      },
    );
    grant.context.worker = context;
    let code: number | undefined,
      publicationError = false,
      adapted:
        { value: unknown; properties: Record<string, unknown> } | undefined;
    if (job.request.phased) {
      const pending = phased.pending(job.id);
      if (!pending || plan?.kind !== "worker" || pending.message !== plan.message)
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
        const rawPayload = rpcPayload(job.request.payload);
        // The queue canonicalizes JSON object keys at admission. Compare the
        // logical caller payload without changing its original receipt hash
        // or the checked transport bytes.
        if (hash(canonical(rawPayload)) !== plan.callerPayloadHash)
          fail("PREPARED_RPC_UNAVAILABLE", "Prepared raw input no longer matches",
          );
        const physicalCatalogRead = [
          "resources/list",
          "resources/templates/list",
        ].includes(rawPayload.method);
        // Local stdio initialization does not create an upstream HTTP session.
        // Raw calls without an explicit upstream session must negotiate their
        // own, just like broker-owned catalog reads and prepared tool calls.
        const admissionRoute = isAddinMetadata(rawPayload);
        const openSession = !admissionRoute && (
          physicalCatalogRead ||
          (rawPayload.method === "tools/call" && job.request.sessionId === undefined)
        );
        const headers = Object.fromEntries(
          Object.entries(client.server.headers || {}).filter(
            ([name]) => name.toLowerCase() !== "mcp-protocol-version",
          ),
        );
        const operation = physicalGrant.run(
          grant,
          async () => {
            const sessionId = openSession
              ? await client._openSession()
              : job.request.sessionId;
            const protocolVersion = openSession
              ? client.negotiatedProtocolVersion
              : job.request.protocolVersion;
            if (protocolVersion)
              headers["MCP-Protocol-Version"] = protocolVersion;
            return withRequest(
              { headers, timeoutMs: job.timeoutMs, protocolVersion },
              () =>
                postPrepared(rawPayload, sessionId, undefined, {
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
        const reply = matching(client, result, rawPayload);
        code =
          reply?.error ||
          object(reply?.result)["isError"] ||
          context.executionFailed
            ? 1
            : 0;
        durable(
          load("./queue-response-files").responsePath(
            dir,
            job,
            "rpc-result.json",
            true,
          ),
          result,
        );
      } catch {
        code = 1;
        if (!context.unknown && !context.timedOut) publicationError = true;
      }
      context.workerClosed = true;
    } else {
      const safeCfg = {
        backend: pinned.backend || "addin",
        tool: pinned.tool,
        transport: pinned.transport,
        timeoutMs: job.timeoutMs,
        protocolVersion: pinned.protocolVersion,
        url: "http://queue.invalid",
        headers: {},
      };
      const requestFile = executionRecords.createIntent(job.id, {
        id: job.id,
        request: job.request,
        buildHash: codeHash,
        properties: clientProperties(),
        deadline: context.deadline,
      });
      const out = fs.openSync(
        load("./queue-response-files").responsePath(
          dir,
          job,
          "stdout.txt",
          true,
        ),
        "wx",
        0o600,
      );
      const err = fs.openSync(
        load("./queue-response-files").responsePath(
          dir,
          job,
          "stderr.txt",
          true,
        ),
        "wx",
        0o600,
      );
      try {
        // A fixed Node entry point invokes cli.main with fixed dependencies; no shell/argv interpreter.
        const env: NodeJS.ProcessEnv = {};
        for (const key of [
          "PATH",
          "HOME",
          "USER",
          "LOGNAME",
          "LANG",
          "LC_ALL",
          "XDG_CONFIG_HOME",
          "XDG_STATE_HOME",
          "XDG_CACHE_HOME",
          "XDG_DATA_HOME",
          "FMCAD_CONFIG",
          "FMCAD_PYTHON",
          "WSL_DISTRO_NAME",
          "TMPDIR",
          "SYSTEMROOT",
        ]) {
          if (process.env[key] !== undefined) env[key] = process.env[key];
        }
        Object.assign(env, {
          FMCAD_QUEUE_WORKER_JOB: job.id,
          FMCAD_QUEUE_WORKER_TOKEN: context.token,
          FMCAD_QUEUE_DIR: dir,
          FMCAD_QUEUE_WORKER_CONFIG: JSON.stringify(safeCfg),
          FMCAD_QUEUE: "worker",
        });
        durable(
          path.join(directory, "worker-start.json"),
          { jobId: job.id, buildHash: codeHash, at: Date.now() },
          true,
        );
        const child = spawn(
          process.execPath,
          [
            resolveChildEntrypoint(
              resolveRuntimePaths({ anchor: runtimeAnchor }),
              "queue-worker",
            ),
            requestFile,
          ],
          {
            cwd: job.request.cwd,
            shell: false,
            env,
            stdio: ["ignore", out, err],
          },
        );
        context.child = child;
        let spawnError;
        child.once("spawn", () => {
          try {
            durable(
              path.join(directory, "worker-identity.json"),
              { pid: child.pid, birth: processBirth(child.pid) },
              true,
            );
          } catch (cause) {
            const error = errorInfo(cause);
            publicationError = true;
            if (!["ENOENT", "ESRCH"].includes(error.code ?? "")) {
              if (context.dispatched)
                hold(grant, "Local worker identity could not be persisted");
              child.kill("SIGKILL");
            }
          }
        });
        code = await new Promise<number>((resolve) => {
          child.once("error", (error) => {
            spawnError = error;
          });
          child.once("close", (exitCode) => resolve(exitCode ?? 1));
        });
        context.workerClosed = true;
        if (spawnError) code = 1;
        fs.fsyncSync(out);
        fs.fsyncSync(err);
      } catch {
        code = 1;
        publicationError = true;
      } finally {
        fs.closeSync(out);
        fs.closeSync(err);
      }
    }
    return load("./dist/core/application/execution").completeSdkTurn({
      async settle() {
        try {
          await settleNative(context, grant);
        } catch (cause) {
          const error = errorInfo(cause);
          context.unknown = true;
          hold(grant, error.code || "NATIVE_RECEIPT_UNAVAILABLE");
        }
        required(context.budget).close();
        const decision = brokerExecution.decideBrokerWorkerExit(
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
              return fs.existsSync(file) ? readJson<P.WorkerResult>(file) : null;
            },
            workflowNonterminal,
            blocked: () => !!state.summary().blocked,
          },
        );
        if (decision.kind === "postflight") {
          publicationError ||= decision.missingPublication;
          return true;
        }
        if (decision.kind === "hold") {
          if (decision.outcome)
            durable(path.join(directory, "outcome.json"), decision.outcome);
          hold(grant, decision.reason);
        }
        if (job.request.phased && decision.rejection)
          phased.reject(
            job.id,
            Object.assign(new Error(decision.rejection.message), {
              code: decision.rejection.code,
            }),
          );
        return undefined;
      },
      async postflight(settled) {
        if (!settled) return false;
        grant.context.postflight = true;
        const postRpcId = flights?.postflight.binding.rpcId || randomUUID();
        const postBinding = flights?.postflight.binding || {
          jobId: job.id,
          rpcId: postRpcId,
          requestHash: hash("postflight:" + job.id + ":" + postRpcId),
          buildHash: codeHash,
        };
        const postReceipt =
          flights?.postflight.receipt ||
          path.join(directory, "postflight-" + postRpcId + ".receipt.json");
        try {
          const observation = await checkTurnInstance(
            grant,
            {
              prepared: flights?.postflight,
              requireIdle: !allowsBusyAfter,
              receiptPath: postReceipt,
              binding: postBinding,
              diagnosticPath: path.join(directory, "postflight-result.json"),
              documentSelector: guardSelector,
            },
            () =>
              executionRecords.createProbeIntent(job.id, "postflight", {
                version: 2,
                jobId: job.id,
                buildHash: codeHash,
                instance,
                at: Date.now(),
                binding: postBinding,
                receipt: postReceipt,
              }),
          );
          lane.assertCurrent(grant);
          executionRecords.recordProbeTerminal(job.id, "postflight", observation,
          );
        } catch (cause) {
          lane.assertCurrent(grant);
          const error = errorInfo(cause);
          grant.context.postflight = false;
          const decision = brokerExecution.decideBrokerPostflightFailure(
            error,
            { unknown: context.unknown, pending: !!context.pending.size },
            () => {
              const expected = readRecoveryFence(job.id);
              if (
                expected &&
                recoveryEvaluator.verifyCompletedDispatch(
                  state.lookup(job.id),
                  expected,
                ).kind === "settled"
              )
                return expected;
              return undefined;
            },
          );
          if (decision.kind === "settle") {
            const expected = decision.fence;
            recoveryEvaluator.assertCurrentFence(expected);
            durable(
              path.join(directory, "postflight-not-submitted.json"),
              {
                jobId: job.id,
                binding: postBinding,
                code: "LOCAL_BUILD_CHANGED",
                probeSubmitted: false,
                source: "local guard before probe; not a remote SDK receipt",
              },
              true,
            );
            const dispatched = !!state.status(job.id).dispatch?.rpcCount;
            const details = {
              ...decision.details,
              userScriptSubmitted: dispatched,
              mayHaveMutated: dispatched,
            };
            recoveryEvaluator.assertCurrentFence(expected);
            durable(path.join(directory, "outcome.json"), details);
            recoveryEvaluator.assertCurrentFence(expected);
            finishTurn(grant, details);
            if (job.request.phased)
              phased.reject(
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
          hold(grant, decision.reason);
          if (job.request.phased) phased.reject(job.id, error);
          return false;
        }
        return;
      },
      release() {
        lane.assertCurrent(grant);
        if (job.request.phased) {
          const details = {
            state: "processing",
            code: context.phaseError?.code || "SDK_TURN_COMPLETE",
            exitCode: code,
            sdkSettled: true,
          };
          durable(path.join(directory, "outcome.json"), details);
          settleTurn(grant, () => {
            state.releaseTurn(
              job.id,
              Math.max(0, Math.floor(required(context.budget).remaining())),
            );
          });
        }
      },
      finalize() {
        if (job.request.phased) {
          if (context.phaseError) phased.reject(job.id, context.phaseError);
          else
            phased.resolve(job.id, adapted, {
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
          mayHaveMutated: !!state.status(job.id).dispatch?.rpcCount,
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
        durable(path.join(directory, "outcome.json"), details);
        finishTurn(grant, details);
      },
    });
  }

  async function maybeRecover(id: string) {
    const blockedJob = state.data.jobs[id];
    if (
      busy() ||
      atomicObservationOnly ||
      options.autoReconcile !== true ||
      Date.now() - lastRecoveryCheck < 1000 ||
      (blockedJob &&
        isAtomicObservationCandidate(
          blockedJob,
          blockedJob.request.buildHash,
          observationScopeConfig,
        ))
    )
      return;
    lastRecoveryCheck = Date.now();
    lane.setAdministrative(true);
    try {
      await gate.administrative(() => reconcile(id, state.status(id).clientId));
      recovery = { jobId: id, status: "resolved", at: Date.now() };
    } catch (cause) {
      recovery = {
        jobId: id,
        status: "waiting_for_evidence",
        code: errorInfo(cause).code || "RECOVERY_ERROR",
        at: Date.now(),
      };
    } finally {
      lane.setAdministrative(false);
      diagnostics();
    }
  }

  const schedulingOpen = () => !lifetime.stopping && !epochProcessUnavailable;
  const canSelect = () =>
    schedulingOpen() &&
    !busy() &&
    !lane.faulted() &&
    (!heldReason() || !!state.data.blocked);
  const scheduler = (
    runtimeRequire(
      "./dist/core/application/broker-scheduler",
    ) as typeof import("../../packages/core/src/application/broker-scheduler")
  ).createBrokerScheduler<P.Job>({
      maintain() {
        if (!schedulingOpen()) return;
        void quarantineReleasedTurn();
       if (!canSelect()) state.next({ grant: false });
        for (const id of continuationJobs) {
          const job = state.data.jobs[id];
          if (!job || ["succeeded", "failed", "cancelled", "expired", "needs_reconciliation"].includes(job.state)) {
            continuation.forget(id);
            continuationJobs.delete(id);
          }
        }
        // Only outstanding prepared plans, never retained terminal history.
        for (const id of localPlans.keys()) {
          const job = state.data.jobs[id];
          if (
            !job ||
            ["succeeded", "failed", "cancelled", "expired"].includes(job.state)
          )
            localPlans.delete(id);
        }
        for (const [id, task] of checkpointReads) {
          const job = state.data.jobs[id];
          if (!job || ["failed", "cancelled", "expired"].includes(job.state)) {
            checkpointReads.delete(id);
            task.reject(Object.assign(new Error("Checkpoint read was not completed"), {
              code: job?.code || "DOCUMENT_STATE_CHANGED",
            }));
          }
        }
      },
      canSelect,
      select() {
        const blocked = state.data.blocked;
        if (blocked && !lane.hasHold())
          setHold(heldReason() || "Original work requires reconciliation");
        const job = state.next();
        if (!job && blocked) void maybeRecover(blocked.id);
        return job;
      },
      async start(job) {
        const plan = localPlans.get(job.id);
        const turn = checkpointReads.get(job.id)?.turn ?? (
          plan?.kind === "raw"
            ? plan.turn.turn
            : (plan?.turn ?? brokerExecution.createTurnIdentity(job.id)));
        const grant = lane.begin(job, turn, !!job.workflowObservation);
        try {
          await execute(job, grant);
        } catch (cause) {
          const error = errorInfo(cause);
          if (lane.currentGrant() !== grant) return; // Never affect a successor.
          if (
            job.workflowObservation &&
            (state.status(job.id).dispatch?.rpcCount || 0) === 0 &&
            state.status(job.id).state === "running"
          ) {
            finishTurn(grant, {
              state: "failed",
              code: error.code || "ATOMIC_OBSERVATION_NOT_STARTED",
              executionOutcome: "not_started",
              mayHaveMutated: false,
              reason: error.message,
            });
          } else {
            hold(grant, error.code || "BROKER_EXECUTION_FAILED");
            if (job.request.phased) phased.reject(job.id, error);
          }
          diagnostics();
        } finally {
          grant.context.executing = false;
          lifetime.progress();
        }
      },
      defer: setImmediate,
      onFailure(cause, job) {
        const reason = errorInfo(cause).code || "BROKER_STORAGE_FAILED";
        const turnGrant = lane.currentGrant();
        if (!job || (!turnGrant && !lane.hasHold())) lane.recordFault(reason);
        else if (turnGrant?.context.job === job) {
          try {
            hold(turnGrant, reason);
          } catch {
            // An uncertain store stays held in the runtime session.
          }
        }
        diagnostics();
      },
    });

  await lifetime.listen({
    dispatch(message) {
      ipcObserver.start(message);
      return dispatch(message);
    },
    observeReply: ipcObserver.reply,
    inspectDrain() {
      const summary = state.summary();
      const context = activeContext();
      if (
        heldReason() ||
        summary.blocked ||
        state.data.localUnknown ||
        state.data.controlBlocked ||
        context?.unknown ||
        state._fault
      )
        return "blocked";
      // Stop does not supply resume authority. A closed gate can leave an
      // existing turn unable to settle until the owner explicitly resumes.
      if (state.data.paused && (lane.snapshot().active || gate.waiters.size))
        return "paused-work";
      if (gate.resuming || gate.active.size) return "physical";
      if (busy() || context || rawPreparations || summary.active)
        return "pending";
      return "idle";
    },
    retireWorkers: () => phased.close(),
    releaseLease() {
      const lease = state.summary().lease;
      if (lease) {
        try {
          state.release(lease.id, lease.clientId);
        } catch (cause) {
          const error = errorInfo(cause);
          if (error.code !== "SEQUENCE_MISMATCH" || state.summary().lease)
            throw error;
        }
      }
    },
    onTransportError() {
      lane.recordFault("IPC_SERVER_ERROR");
    },
    onShutdownError(cause) {
      lane.recordFault(errorInfo(cause).code || "CLOSE_FAILED");
    },
    poll() {
      lifetime.progress();
      void scheduler.tick();
    },
    pollMs: options.pollMs || 100,
  });
  diagnostics();
  return {
    close,
    dir,
    socket,
    buildHash: codeHash,
    status: () => ({
      ...state.status(),
      held: heldReason(),
      stopping: lifetime.stopping,
      buildHash: codeHash,
    }),
  };
  } catch (error) {
    try {
      if (physicalGrantState === "not_attempted")
        lifetime.abortBeforeInitialize({ grantIssuance: "notStarted" });
      else lifetime.retainBeforeInitializeFailure({
        code: errorInfo(error).code || "BROKER_STARTUP_FAILED",
        grantIssuance: physicalGrantState,
      });
    } catch { /* Preserve the failure and retain ownership if evidence cannot be written. */ }
    throw error;
  }
}

function reclaim(dir: string) {
  return reclaimOwner(dir, () => {
    if (fs.existsSync(path.join(dir, "isolated-admission-epoch.json")))
      openIsolatedEpoch(dir);
  });
}

export { reclaim, brokerConfigHash };
