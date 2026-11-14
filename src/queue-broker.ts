// Canonical broker composition. Runtime JavaScript is emitted by TypeScript.

import * as fs from "node:fs";
import path from "node:path";
import * as net from "node:net";
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import type * as P from "./queue-broker-ports";
import type {
  BrokerModules,
  AuditPorts,
  AuditSnapshot,
} from "./queue-broker-modules";
import type { BrokerControlFence } from "../packages/core/src/application/broker-control";
import type { DispatchFailure } from "../packages/core/src/application/execution";
import {
  backendHead,
  prepareBackendTransition,
} from "./queue-backend-transition";
const runtimeRequire = createRequire(__filename);
const load = <K extends keyof BrokerModules>(name: K): BrokerModules[K] =>
  runtimeRequire(name) as BrokerModules[K];
const { openIsolatedEpoch, epochAdmission } = load("./queue-isolated-epoch");
const projectActivity = runtimeRequire(
  "./dist/node-adapters/persistence/project-history/activity",
) as typeof import("../packages/node-adapters/src/persistence/project-history/activity");
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
  reclaim,
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
  verifyPythonArtifact,
  retainPythonOrigin,
  prepareWireArtifact,
  classifyPythonRpc,
} = load("./python");
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

const MAX = 16 * 1024 * 1024;
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
/** IPC is JSON, not a trusted TypeScript caller. Decode only structure here;
 * ownership, hashes, timeouts and admission remain the original branch guards. */
function decodeEnvelope(
  value: unknown,
): Record<string, unknown> & { action: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_MESSAGE", "Expected a JSON object");
  const message = value as Record<string, unknown>;
  if (typeof message["action"] !== "string")
    fail("INVALID_ACTION", "Unknown broker action");
  return message as Record<string, unknown> & { action: string };
}
function decodeMessage(value: unknown): P.Message {
  const message = decodeEnvelope(value);
  for (const key of [
    "clientId",
    "clientToken",
    "jobId",
    "requestId",
    "sequenceId",
    "observationJobId",
    "workerToken",
    "acceptedOutcome",
    "expectedBuildHash",
  ]) {
    if (message[key] !== undefined && typeof message[key] !== "string")
      fail("INVALID_REQUEST", "Broker identifiers must be strings");
  }
  for (const key of ["rpcTimeoutMs", "expectedRevision"]) {
    if (message[key] !== undefined && typeof message[key] !== "number")
      fail("INVALID_REQUEST", "Broker numeric fields must be numbers");
  }
  const auth = message["auth"];
  if (
    auth !== undefined &&
    (auth === null ||
      typeof auth !== "object" ||
      Array.isArray(auth) ||
      typeof object(auth)["clientId"] !== "string" ||
      typeof object(auth)["clientToken"] !== "string")
  )
    fail("UNAUTHORIZED", "Valid registered client credentials required");
  if (message["action"] === "backend") {
    if (
      !["callTool", "listTools", "executeUiGuardedScript"].includes(
        String(message["method"]),
      ) ||
      !Array.isArray(message["args"])
    )
      fail("INVALID_BACKEND_METHOD", "Unsupported worker backend method");
  }
  const control = message["control"];
  if (control !== undefined) {
    if (!control || typeof control !== "object" || Array.isArray(control))
      fail("INVALID_REQUEST", "Control fence must be an object");
    const fence = object(control);
    for (const key of ["requestId", "instanceId", "buildHash"])
      if (fence[key] !== undefined && typeof fence[key] !== "string")
        fail("INVALID_REQUEST", "Control identities must be strings");
    for (const key of ["expectedGeneration", "generation", "contextEpoch"])
      if (fence[key] !== undefined && typeof fence[key] !== "number")
        fail("INVALID_REQUEST", "Control generations must be numbers");
  }
  return message as P.Message;
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

function responseForCaller(
  response: P.Response,
  request: P.Rpc,
  reply: P.Reply | null,
) {
  return own(request, "id")
    ? { ...response, raw: JSON.stringify({ ...reply, id: request.id }) }
    : response;
}

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

export async function serve(cfg: P.Config, options: P.Options = {}) {
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
  const preparationConcurrency = (runtimeRequire(
    "./dist/node-adapters/execution/phased-workers",
  ) as Pick<typeof import("../packages/node-adapters/src/execution/phased-workers"),"resolvePreparationConcurrency">).resolvePreparationConcurrency(
    (pinned["queue"] as {preparationConcurrency?:unknown}|undefined)?.preparationConcurrency,
  );
  const configHash = brokerConfigHash(pinned);
  const effectiveBackend = backendHead(dir);
  let identityFile = path.join(dir, "instance.json");
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
  if (options.backendTransition)
    prepareBackendTransition(
      dir,
      openIsolatedEpoch(dir, { recover: false }),
      pinned,
      options.backendTransition,
    );
  function assertBackendHeadOwner(current: P.State) {
    if (!same(backendHead(dir)?.head, effectiveBackend?.head))
      fail("BACKEND_TRANSITION_CHANGED", "Physical backend head changed before startup");
    if (effectiveBackend && (!current.epoch ||
        current.epoch.epochId !== effectiveBackend.head.epochId ||
        current.epoch.ownerClientId !== effectiveBackend.head.ownerClientId ||
        current.epoch.ownerTokenHash !== effectiveBackend.head.ownerTokenHash))
      fail("BACKEND_TRANSITION_CHANGED", "Backend transition no longer belongs to the exact active epoch owner");
    if (effectiveBackend && !options.backendTransition && effectiveBackend.identity.buildHash !== codeHash)
      fail("BUILD_CHANGED", "Restore the exact physical backend transition runtime before reopening");
  }
  if (effectiveBackend)
    assertBackendHeadOwner(openIsolatedEpoch(dir, { recover: false }));
  const marker = {
    pid: process.pid,
    birth: processBirth(),
    nonce: randomUUID(),
    protocol: 2,
  };
  const lock = path.join(dir, "broker.lock");
  const successorRuntime = options.deadEpochSuccessorNonce
    ? load("./queue-epoch-successor").claimSuccessorBroker(
        dir,
        marker,
        options.deadEpochSuccessorNonce,
        codeHash,
        pinned,
      )
    : null;
  const migrationSnapshotHash = options.atomicMigrationNonce
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
      : successorRuntime
        ? successorRuntime.authority.predecessor.rootState.sha256
        : null;
  if (!migrationSnapshotHash) durable(lock, marker, true); // Never steal a lock, even if its PID looks stale.
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
    onCommittedSnapshot: phaseTimings.queueCommitted,
  };
  const state = openIsolatedEpoch(
    dir,
    migrationSnapshotHash
      ? {
          ...measuredStateOptions,
          recover: false,
          expectedSnapshotHash: migrationSnapshotHash,
        }
      : measuredStateOptions,
  );
  phaseTimings.queueCommitted(state.data, state.epoch?.root ?? dir);
  if (state.epoch) identityFile = path.join(state.epoch.root, "instance.json");
  assertBackendHeadOwner(state);
  if (effectiveBackend) {
    identityFile = effectiveBackend.identityFile;
  }
  // Metadata-only preflight happens before constructing a physical client. A
  // foreign owner, altered config or unfinished current job sends zero SDK work.
  const backendTransition = options.backendTransition
    ? prepareBackendTransition(dir, state, pinned, options.backendTransition)
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
          bridgeSource: () =>
            fs.readFileSync(
              path.join(
                resolveRuntimePaths({ anchor: __filename }).assets,
                "cad/identity.py",
              ),
              "utf8",
            ) +
            "\n" +
            fs.readFileSync(
              path.join(
                resolveRuntimePaths({ anchor: __filename }).assets,
                "addin-bridge.py",
              ),
              "utf8",
            ),
        },
      );
    });
  const client = factory(pinned);
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
  const runtime = resolveRuntimePaths({ anchor: __filename }).runtime;
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
    if (state.epoch && job) epochAdmission(state, job.request, clients);
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
  const preparedPosts = new WeakMap<P.Rpc, P.Prepared | P.PreparedPost>();
  const preparingJob = new AsyncLocalStorage<P.Job | false>();
  const preparingSignal = new AsyncLocalStorage<AbortSignal>();
  function localCheckOptions() {
    const signal = preparingSignal.getStore();
    return signal ? { signal } : {};
  }
  const preparedCalls = new WeakMap<P.WorkerMessage, P.Send>();
  const rawPreparedPosts = new Map<string, P.Prepared>();
  const flightPlans = new Map<
    string,
    { preflight: P.Flight; postflight: P.Flight }
  >();
  let rawPreparations = 0;
  client.preparePost = async (payload, origin) => {
    try {
      const outgoing = structuredClone(payload);
      const contextEpoch = state.data.contextEpoch || 0;
      const localJob = preparingJob.getStore();
      const job =
        localJob !== undefined
          ? localJob
          : !gate.scope.getStore()?.administrative && active?.job;
      const classification =
        origin && !job ? classifyPythonRpc(outgoing) : null;
      const unownedArtifact =
        classification?.kind === "python"
          ? retainPythonOrigin(
              prepareWireArtifact(runtime, classification.source),
              required(origin),
            )
          : undefined;
      const prepared: P.Prepared | P.PreparedPost = job
        ? await prepareOwnedPost(outgoing, job, origin)
        : {
            outgoing,
            pythonCertificate: await pythonAdmission.check(
              outgoing,
              unownedArtifact,
              localCheckOptions(),
            ),
            contextEpoch,
          };
      preparedPosts.set(outgoing, prepared);
      let consumed = false;
      return {
        fence() {
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
          prepared.pythonCertificate.fence(prepared.outgoing);
        },
        send: (sessionId) => {
          if (consumed)
            fail("PREPARED_RPC_CONSUMED", "A prepared RPC cannot be replayed");
          consumed = true;
          return client._post(outgoing, sessionId);
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
  ) {
    const prepared = preparedPosts.get(payload);
    preparedPosts.delete(payload);
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
  // Transitional probe orchestration still adjusts its client timeout. Give it
  // invocation-local settings, never the immutable physical adapter config.
  const instanceProbe = (options: P.ProbeOptions) => {
    const server = { timeoutMs: client.server.timeoutMs };
    const port: {
      server: { timeoutMs: number };
      callTool: P.Client["callTool"];
      prepareCallTool?: (...args: unknown[]) => Promise<P.Send>;
    } = {
      server,
      callTool: (...args) =>
        withRequest({ timeoutMs: server.timeoutMs }, () =>
          client.callTool(...args),
        ),
    };
    if (client.prepareCallTool)
      port.prepareCallTool = async (...args) => {
        const send = await required(client.prepareCallTool).apply(client, args);
        return Object.assign(
          () => withRequest({ timeoutMs: server.timeoutMs }, send),
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
    const selector =
      job.request.phased ||
      job.sequenceMode === "automatic" ||
      job.contextRefreshRequired
        ? documentSelector(job)
        : undefined;
    const plan: Partial<Record<"preflight" | "postflight", P.Flight>> = {};
    for (const stage of ["preflight", "postflight"] as const) {
      if (stopping || closed || closing)
        throw Object.assign(
          new Error("Broker stopped accepting local preparation"),
          { code: "BROKER_STOPPING", notStarted: true },
        );
      if (
        expectedMessage &&
        phased.pending(job.id)?.message !== expectedMessage
      )
        fail("WORKER_CLOSED", "Local worker closed during preparation");
      const rpcId = randomUUID();
      const binding = {
        jobId: job.id,
        rpcId,
        requestHash: hash(stage + ":" + job.id + ":" + rpcId),
        buildHash: codeHash,
      };
      const receipt = path.join(
        jobDir(job.id),
        stage + "-" + rpcId + ".receipt.json",
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
                  () => withRequest({ timeoutMs: server.timeoutMs }, send),
                  { fence: () => send.fence() },
                );
              },
            },
            {
              receiptPath: receipt,
              binding,
              requireIdle: false,
              documentSelector: selector,
              ...nativePaths,
              diagnosticPath: path.join(jobDir(job.id), stage + "-result.json"),
            },
          ),
        );
      const send = await (signal
        ? preparingSignal.run(signal, prepare)
        : prepare());
      if (
        expectedMessage &&
        phased.pending(job.id)?.message !== expectedMessage
      )
        fail("WORKER_CLOSED", "Local worker closed during preparation");
      plan[stage] = { binding, receipt, send };
    }
    return plan as { preflight: P.Flight; postflight: P.Flight };
  }
  let clients: Record<string, string> = {};
  const clientsFile = path.join(dir, "clients.json");
  if (fs.existsSync(clientsFile)) clients = readJson(clientsFile);
  let active: P.Context | null = null,
    busy = false,
    stopping = false,
    closed = false,
    instance: P.Instance;
  const atomicObservationScope = new AsyncLocalStorage<P.ObservationScope>();
  const atomicRecoveryAuditScope = new AsyncLocalStorage<P.ScriptScope>();
  let atomicObservationOnly = false;
  let closing = false,
    closeTask: Promise<void> | null = null,
    closeResolve: () => void,
    closeReject: (error: unknown) => void;
  let held: string | null = null;
  let epochProcessUnavailable = false;
  let recovery: P.Recovery | null = null,
    lastRecoveryCheck = 0;
  const lifecycleFile = path.join(dir, `broker-lifecycle-${marker.nonce}.json`);
  const startupReceipt = path.join(
    dir,
    `broker-startup-${marker.nonce}.receipt.json`,
  );
  const startupBinding = {
    brokerNonce: marker.nonce,
    ownerPid: marker.pid,
    ownerBirth: marker.birth,
    buildHash: codeHash,
    stage: "startup",
    ...(backendTransition ? { auditExpectedInstance: {
      pid: backendTransition.identity.instance.pid,
      birth: backendTransition.identity.instance.birth,
      version: backendTransition.identity.instance.version,
    } } : {}),
  };
  const lifecycle = {
    owner: marker,
    buildHash: codeHash,
    configHash,
    stage: state.summary().blocked ? "recovery" : "starting",
    receipt: startupReceipt,
    binding: startupBinding,
  };
  durable(lifecycleFile, lifecycle, true);
  try {
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
      !backendTransition &&
      (successorRuntime ||
        load(
          "./dist/node-adapters/broker-ipc/normal-admission",
        ).epochStartupPinned(state, oldIdentity?.buildHash, codeHash))
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
        successorRuntime?.authority.previousBuildHash || codeHash;
      if (
        !oldIdentity ||
        oldIdentity.buildHash !== expectedBuild ||
        !sameInstance(oldIdentity.instance, epoch.currentInstance)
      )
        fail(
          "BUILD_CHANGED",
          "An isolated epoch requires its exact qualified runtime and current process identity",
        );
      if (successorRuntime) epochProcessUnavailable = true;
      instance = oldIdentity.instance;
      held = epochProcessUnavailable
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
              : null;
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
      held = atomicObservationOnly
        ? "Read-only atomic holder observation only; all other admission remains blocked"
        : "Restored unfinished job; matching remote terminal receipts are required before any probe";
    } else {
      // A completed busy observation is not an unfinished RPC. Keep the control
      // plane available; modeling workflows still require idle in preflight.
      instance = await gate.administrative(() =>
        instanceProbe({
          receiptPath: startupReceipt,
          binding: startupBinding,
          requireIdle: false,
          diagnosticPath: path.join(
            dir,
            `broker-startup-${marker.nonce}.result.json`,
          ),
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
        const diagnosticPath = path.join(dir, `broker-startup-${marker.nonce}.result.json`);
        const observationFiles = [diagnosticPath];
        if (!options.createBackend) {
          const receipt = readJson<Record<string, unknown>>(startupReceipt);
          if (receipt["terminal"] !== true || receipt["outcome"] !== "succeeded" ||
              !sameInstance(receipt["instance"] as P.Instance, instance) ||
              Object.entries(startupBinding).some(([key, value]) => !same(receipt[key], value)))
            fail("BACKEND_TRANSITION_UNPROVEN", "Exact target startup receipt is required; ownership is retained without replay");
          observationFiles.push(startupReceipt);
        }
        identityFile = backendTransition.commit(instance, codeHash, observationFiles);
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
        durable(identityFile, { configHash, buildHash: codeHash, instance });
    }
  } catch (cause) {
    const error = errorInfo(cause);
    // Only proven local/terminal startup rejections can release our own marker.
    // Transport uncertainty, restored unknowns and storage faults retain it.
    if (
      ["CONFIG_CHANGED", "INSTANCE_CHANGED", "FUSION_BUSY"].includes(
        error.code ?? "",
      )
    ) {
      try {
        const snapshot = state.status();
        if (
          !snapshot.active &&
          !snapshot.blocked &&
          !snapshot.lease &&
          Object.values(snapshot.jobs).every((job) =>
            ["succeeded", "failed", "cancelled", "expired"].includes(job.state),
          ) &&
          readJson<P.Owner>(lock).nonce === marker.nonce
        ) {
          durable(lifecycleFile, {
            ...lifecycle,
            stage: "rejected",
            safeToRecover: true,
            code: error.code,
          });
          client.reqOpts?.agent?.destroy();
          fs.unlinkSync(lock);
          const fd = fs.openSync(dir, "r");
          try {
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
        }
      } catch {
        /* Uncertain cleanup never justifies removing another marker. */
      }
    }
    throw error;
  }
  initializing = false;

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
      const job = required(state.data.jobs[message.jobId]);
      const prepare =
        message.method === "callTool"
          ? client.prepareCallTool
          : message.method === "executeUiGuardedScript"
            ? client.prepareUiGuardedScript
            : client.prepareListTools;
      if (prepare) {
        const send = await preparingJob.run(job, () =>
          preparingSignal.run(signal, () =>
            prepare.apply(client, message.args),
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
        if (flights) flightPlans.set(job.id, flights);
        preparedCalls.set(message, send);
        return;
      }
      const payload: P.Rpc = {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name:
            message.method === "executeUiGuardedScript"
              ? "fusion_mcp_execute"
              : (message.args[1] as string | undefined) ||
                pinned.tool ||
                "fusion_mcp_execute",
          arguments:
            message.method === "executeUiGuardedScript"
              ? {
                  featureType: "script",
                  object: { script: message.args[0] as string },
                }
              : (message.args[0] as P.ToolArguments),
        },
      };
      if (message.method === "listTools") {
        payload.method = "tools/list";
        delete payload.params;
      }
      await pythonAdmission.check(payload, undefined, { signal });
    },
    properties: clientProperties,
    spawnWorker: options.spawnWorker,
    onFault(error) {
      held = errorInfo(error).code || "LOCAL_WORKER_STORAGE_FAILED";
      diagnostics();
    },
    onUnknown(job, reason) {
      held = reason;
      if (state.data.active === job.id) hold(job, reason);
      else state.blockLocal(job.id, reason);
      diagnostics();
    },
  });

  function jobDir(id: string) {
    return path.join(dir, "jobs", id);
  }
  function diagnostics() {
    // Passive observer input, never completion evidence or a queue state override.
    try {
      durable(path.join(dir, "queue-diagnostics.json"), {
        at: Date.now(),
        buildHash: codeHash,
        held,
        recovery,
        activeJobId: state.summary().active,
      });
      durable(path.join(dir, "console-state.json"), {
        at: Date.now(),
        ...gate.snapshot(),
        owner: marker,
        projectActivityFence: projectActivity.projectActivityCapability(),
        queued: Object.values(state.data.jobs).filter(
          (job) => job.state === "queued",
        ).length,
        held: !!held,
        buildHash: codeHash,
      });
    } catch {
      /* Diagnostics cannot change execution. */
    }
  }
  function hold(job: Pick<P.Job, "id">, reason: string) {
    held = reason;
    if (state.status(job.id).state !== "needs_reconciliation")
      state.block(job.id, reason);
    diagnostics();
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
  async function settleNative(context: P.Context) {
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
        durable(item.journal, item.record);
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
    if (probeOptions?.prepared && probeOptions.onObservation)
      await probeOptions.onObservation(actual);
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
    const binding = record.binding;
    if (
      value.terminal !== true ||
      !["succeeded", "failed"].includes(value.outcome) ||
      !["jobId", "rpcId", "requestHash", "buildHash", "sourceHash"].every(
        (key) => value[key] === binding[key],
      ) ||
      !sameInstance(value.instance, record.instance)
    )
      fail(
        "RECEIPT_MISMATCH",
        "Receipt is not terminal or bound to the original request/instance/build",
      );
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
      held = null;
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
      active,
      busy: busy || rawPreparations > 0,
      stopping,
      held,
    }),
    setBusy: (value) => {
      busy = value;
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
      held = null;
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
    canResume() {
      if (
        (held && !state.data.controlBlocked) ||
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
    if (stopping || closed || !busy)
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
        return withRequest({ timeoutMs: prepared.dispatchTimeoutMs }, () =>
          originalPost(prepared.outgoing, sessionId),
        );
      },
      settle(prepared, response: P.Response) {
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
        hold(
          scope.observerJob,
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
  ): Promise<P.Prepared> {
    const epochPolicy = state.epoch
      ? epochAdmission(state, job.request, clients)
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
      const args = outgoing.params?.arguments;
      isolatedTool(outgoing.params?.name, args);
      const python = outgoing.params?.name === "execute_python";
      const official =
        outgoing.params?.name === "fusion_mcp_execute" &&
        args?.featureType === "script";
      if (python || official) {
        const scriptArgs = required(args);
        const code = python ? scriptArgs.code : scriptArgs.object?.script;
        if (typeof code !== "string")
          fail("INVALID_SCRIPT", "Script source must be a string");
        if (python && scriptArgs.persistent !== false)
          fail(
            "unsupported_queue_route",
            "Queued low-level Python must use persistent:false",
          );
        record.receipt = path.join(jobDir(job.id), `remote-${rpcId}.json`);
        // Receipt/instance/transport wrappers are bound BEFORE final bytes are
        // prepared. No code substitution is allowed after this boundary.
        binding.sourceHash = hash(code);
        let prepared = prepareReceiptScript(
          code,
          official,
          record.receipt,
          binding,
          nativePaths,
        );
        if (origin) prepared = retainPythonOrigin(prepared, origin);
        verifyPythonArtifact(prepared);
        pythonArtifact = prepared;
        record.pythonArtifact = {
          version: prepared.version,
          sha256: prepared.sha256,
          artifactHash: prepared.artifactHash,
          sourceMap: prepared.sourceMap,
          units: prepared.units.map(({ id, filename, role, sha256 }) => ({
            id,
            filename,
            role,
            sha256,
          })),
        };
        if (python) scriptArgs.code = prepared.script;
        else required(scriptArgs.object).script = prepared.script;
      }
    }
    const metadataOnly = [
      "initialize",
      "notifications/initialized",
      "ping",
      "tools/list",
    ].includes(payload.method);
    const pythonCertificate = await pythonAdmission.check(
      outgoing,
      pythonArtifact,
      localCheckOptions(),
    );
    const prepared: P.Prepared = {
      outgoing,
      record,
      rpcId,
      pythonArtifact,
      contextEpoch,
      metadataOnly,
      pythonCertificate,
    };
    if (prepared.pythonCertificate.report)
      prepared.record.pythonCheck = prepared.pythonCertificate.report;
    prepared.record.dispatchClass = prepared.pythonCertificate.kind;
    // Test observer may suspend local preparation, never replace checking.
    await options.testCheckPrepared?.(prepared);
    prepared.pythonCertificate.fence(prepared.outgoing);
    verifyPreparedJob(job, prepared.contextEpoch);
    return prepared;
  }

  function retainDispatchFailure(
    context: P.Context,
    error: unknown,
    failure: DispatchFailure<P.Prepared>,
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
  ) {
    const recoveryAudit = atomicRecoveryAuditScope.getStore();
    if (recoveryAudit) return recoveryAudit.post(payload, sessionId);
    const atomicObservation = atomicObservationScope.getStore();
    if (atomicObservation)
      return scopedAtomicObservationPost(payload, sessionId, atomicObservation);
    if (gate.scope.getStore()?.administrative)
      return unownedPost(payload, sessionId, requestOptions);
    const context = active;
    if (!context) return unownedPost(payload, sessionId, requestOptions);
    return load("./dist/core/application/execution").dispatchPrepared({
      async prepare(): Promise<P.Prepared> {
        const prepared = preparedPosts.get(payload);
        preparedPosts.delete(payload);
        if (prepared && !("record" in prepared))
          fail(
            "PREPARED_RPC_UNAVAILABLE",
            "Owned RPC lost its original prepared record",
          );
        return prepared || prepareOwnedPost(payload, context.job);
      },
      check(prepared) {
        prepared.pythonCertificate.fence(prepared.outgoing);
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
        assertResetSubmissionOpen(dir);
        if (state.epoch) epochAdmission(state, context.job.request, clients);
        if (active !== context || context.unknown || state.summary().blocked)
          fail(
            "RECONCILIATION_REQUIRED",
            "Original SDK ownership changed before send",
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
        prepared.pythonCertificate.fence(prepared.outgoing);
        if (prepared.pythonArtifact) {
          verifyPythonArtifact(prepared.pythonArtifact);
          const args = prepared.outgoing.params?.arguments;
          const wireScript =
            prepared.outgoing.params?.name === "execute_python"
              ? args?.code
              : args?.object?.script;
          if (wireScript !== prepared.pythonArtifact.script)
            fail(
              "INPUT_CHANGED",
              "Final Python bytes changed after offline preparation",
            );
        }
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
        const journal = path.join(jobDir(context.job.id), `rpc-${rpcId}.json`);
        const before = state.status(context.job.id).dispatch;
        const count = (before?.rpcCount || 0) + 1;
        record.dispatchIndex = count;
        durable(journal, record, true);
        context.turnRpcs.push({ record, journal });
        state.markDispatch(context.job.id, {
          rpcCount: count,
          completedCount: before?.completedCount || 0,
          rpcId,
        });
        context.dispatched = true;
        Object.assign(prepared, { journal, dispatchRemaining });
      },
      send: (prepared) =>
        withRequest({ timeoutMs: required(prepared.dispatchRemaining) }, () =>
          originalPost(prepared.outgoing, sessionId, requestOptions),
        ),
      settle(prepared, response: P.Response) {
        const { outgoing, record, rpcId, journal } = prepared;
        const reply = matching(client, response, outgoing);
        const returned = responseForCaller(response, payload, reply);
        if (
          payload.method === "tools/list" &&
          !reply?.error &&
          !Array.isArray(object(reply?.result)["tools"])
        )
          fail("UNKNOWN_RPC", "Malformed tools/list response");
        const receipt = record.receipt ? remoteReceipt(record, false) : null;
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
        durable(required(journal), record);
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
        hold(
          context.job,
          "Physical RPC outcome is unknown; observe the durable receipt without replay",
        );
        retainDispatchFailure(context, error, failure);
      },
      notSubmitted(error, failure) {
        required(context.localDispatchErrors).add(error);
        retainDispatchFailure(context, error, failure);
      },
    });
  };
  client._post = (payload, sessionId, requestOptions) => {
    return physicalPost(payload, sessionId, requestOptions);
  };

  function auth(message: P.Message) {
    const value = message.auth;
    if (
      !value ||
      !identifier(value.clientId) ||
      !identifier(value.clientToken) ||
      !own(clients, value.clientId) ||
      !equal(clients[value.clientId], hash(value.clientToken))
    )
      fail("UNAUTHORIZED", "Valid registered client credentials required");
    return value.clientId;
  }
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
  async function backend(
    message: P.WorkerMessage,
  ): Promise<{ value: unknown; properties: Record<string, unknown> }> {
    const context = active;
    if (
      !context ||
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
    const initialRpcCount =
      state.status(context.job.id).dispatch?.rpcCount || 0;
    const operation = withRequest({ timeoutMs: timeout }, async () => {
      context.rpcDeadline = Date.now() + timeout;
      try {
        const send = preparedCalls.get(message);
        preparedCalls.delete(message);
        const value: unknown = send
          ? await send()
          : await Reflect.apply(client[message.method], client, message.args);
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
            durable(context.lastRpc.journal, context.lastRpc.record);
          }
        }
        await settleNative(context);
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
            context.job,
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
          context.job,
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
    installation: resolveRuntimePaths({ anchor: __filename }).installation,
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
      assertResetSubmissionOpen(dir);
      load("./queue-atomic-migration-runtime").assertMigrationAdmission(
        dir,
        "audit-atomic",
      );
      const ids = value.binding;
      if (
        stopping ||
        closed ||
        gate.resuming ||
        (busy && !recoveryAuditBusy) ||
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
      if (busy || gate.adminTransition)
        fail("BROKER_BUSY", "Another operation owns the broker");
      busy = recoveryAuditBusy = true;
      gate.adminTransition = "atomic-recovery-audit";
    },
    end() {
      recoveryAuditBusy = busy = false;
      gate.adminTransition = null;
      diagnostics();
    },
    admit: (send) => gate.administrative(() => gate.run(send)),
    check: (payload, artifact) => pythonAdmission.check(payload, artifact),
    post: (payload, sessionId) =>
      withRequest({ timeoutMs: 30000 }, () => originalPost(payload, sessionId)),
    match: (response, payload) => matching(client, response, payload),
    remoteReceipt: (record) => remoteReceipt(record, false),
    sendScript: (scope, script) =>
      atomicRecoveryAuditScope.run(scope, () =>
        client.callTool(
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
    clients: () => clients,
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
      stopping ||
      closed ||
      gate.resuming ||
      (busy && !recoveryAuditBusy) ||
      (gate.adminTransition && !allowedAdmin) ||
      gate.active.size !== (inFlight ? 1 : 0) ||
      active ||
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
    clients: () => clients,
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
      held = null;
      active = null;
      diagnostics();
    },
    closed(epoch) {
      if (state.admissionMode === "normal-multidocument") {
        held = null;
        diagnostics();
        return;
      }
      if (!state.data.paused)
        state.pause(true, "isolated-scratch-closed:" + epoch.epochId);
      held =
        "Qualified isolated scratch is closed; historical unknown work remains quarantined";
      diagnostics();
    },
  });
  const savedFixtureControl = load(
    "./queue-saved-fixture-control",
  ).createSavedFixtureControl({
    dir,
    state,
    clients: () => clients,
    assertControl: assertScratchControl,
    snapshot: epochSnapshot,
    fence: fenceEpochLifecycle,
    auditPorts: { ...recoveryAuditPorts, sendScript: sendOwnedFixtureScript },
    closed(epoch) {
      if (!state.data.paused)
        state.pause(true, "saved-fixture-retained:" + epoch.epochId);
      held =
        "New test DataFile retained; owned saved UI document closed; historical unknown work remains quarantined";
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
      clients: () => clients,
      authority,
      ports: recoveryAuditPorts,
      sendAuditScript: recoveryAuditPorts.sendScript,
      sendScratchScript: (scope, script) =>
        atomicRecoveryAuditScope.run(scope, () => {
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
        }),
      assertControl: assertScratchControl,
      epochSnapshot,
      fenceRuntime(inFlight) {
        assertResetSubmissionOpen(dir);
        if (
          fs.existsSync(path.join(dir, "atomic-migration.lock")) ||
          fs.existsSync(path.join(dir, "recovery.lock")) ||
          stopping ||
          closed ||
          gate.resuming ||
          (busy && !recoveryAuditBusy) ||
          active ||
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
        held = null;
        active = null;
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
    if (!["committed", "aborted"].includes(acceptedOutcome))
      fail(
        "INVALID_ACCEPTED_OUTCOME",
        "Owner acceptance must name the observed committed or aborted outcome",
      );
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
    const targetDir = privateDirectory(jobDir(id));
    const acceptancePath = path.join(
      targetDir,
      "atomic-reconciliation-acceptance.json",
    );
    let priorAcceptance = null;
    try {
      priorAcceptance =
        readAtomicProofRecord<P.Acceptance>(acceptancePath).value;
    } catch (cause) {
      const error = errorInfo(cause);
      if (error.code !== "ENOENT") throw error;
    }
    if (priorAcceptance) {
      if (
        priorAcceptance.kind !== "atomic-workflow-owner-acceptance" ||
        priorAcceptance.targetJobId !== id ||
        priorAcceptance.targetRequestId !== target.requestId ||
        priorAcceptance.clientId !== clientId ||
        priorAcceptance.acceptedOutcome !== acceptedOutcome ||
        priorAcceptance.resolvedState !==
          (acceptedOutcome === "committed" ? "succeeded" : "failed")
      )
        fail(
          "ACCEPTANCE_CONFLICT",
          "A different owner outcome was already durably accepted for this job",
        );
      const priorObserver = state.data.jobs[priorAcceptance.observerJobId];
      const expectedProofPath = priorObserver
        ? path.join(jobDir(priorObserver.id), "atomic-observation-proof.json")
        : "";
      if (
        !priorObserver ||
        priorObserver.state !== "succeeded" ||
        priorObserver.workflowObservation?.targetJobId !== target.id ||
        priorAcceptance.proofPath !== path.relative(dir, expectedProofPath)
      )
        fail(
          "ACCEPTANCE_RECEIPT_MISMATCH",
          "Persisted owner acceptance no longer binds the unique scoped observer",
        );
      const persistedProof = readAtomicProofRecord(expectedProofPath);
      if (persistedProof.sha256 !== priorAcceptance.proofSha256)
        fail(
          "ACCEPTANCE_RECEIPT_MISMATCH",
          "Scoped atomic proof changed after owner acceptance",
        );
      const priorProof = persistedProof.value;
      if (
        priorProof.version !== 1 ||
        priorProof.kind !== "atomic_holder_status" ||
        priorProof.targetJobId !== target.id ||
        priorProof.observerJobId !== priorObserver.id ||
        priorProof.identityMatches !== true ||
        priorProof.readOnlyOperation !== "atomic_status" ||
        priorProof.remoteOutcome !== "succeeded" ||
        priorProof.toolFailed === true ||
        priorProof.summary?.outcome !== acceptedOutcome ||
        priorProof.summary?.destroyed !== true ||
        priorProof.summary?.idle !== true ||
        !same(priorAcceptance.identity, priorProof.identity) ||
        priorAcceptance.reportFingerprint !== priorProof.reportFingerprint ||
        (priorAcceptance.instance &&
          !sameInstance(priorAcceptance.instance, priorProof.observerInstance))
      )
        fail(
          "ACCEPTANCE_RECEIPT_MISMATCH",
          "Scoped proof no longer matches the persisted owner acceptance",
        );
      const priorRemote = remoteReceipt(
        {
          receipt: priorProof.receipt,
          binding: priorProof.binding,
          instance: priorProof.observerInstance,
        },
        false,
      );
      if (
        priorRemote.outcome !== "succeeded" ||
        priorProof.binding?.jobId !== priorObserver.id ||
        priorProof.binding?.rpcId !== priorProof.rpcId ||
        priorProof.binding?.buildHash !== priorAcceptance.observerBuildHash ||
        priorProof.receipt !==
          path.join(
            jobDir(priorObserver.id),
            `atomic-observation-${priorProof.rpcId}.receipt.json`,
          )
      )
        fail(
          "ACCEPTANCE_RECEIPT_MISMATCH",
          "Original scoped transport receipt is no longer valid",
        );
      if (target.state === priorAcceptance.resolvedState)
        return priorAcceptance;
      if (
        target.state !== "needs_reconciliation" ||
        state.data.blocked?.id !== target.id ||
        state.data.active !== target.id
      )
        fail(
          "ACCEPTANCE_INCOMPLETE",
          "Prior owner acceptance receipt cannot be applied to the current queue state",
        );
      if (
        priorAcceptance.paused !== state.data.paused ||
        priorAcceptance.controlGeneration !==
          (state.data.controlGeneration || 0) ||
        priorAcceptance.contextEpoch !== (state.data.contextEpoch || 0) ||
        state.data.lease ||
        Object.values(state.data.jobs).some(
          (job) =>
            job.id !== target.id &&
            job.id !== priorObserver.id &&
            !["succeeded", "failed", "cancelled", "expired"].includes(
              job.state,
            ),
        )
      )
        fail(
          "WORKFLOW_GATE_CHANGED",
          "Queue changed since owner acceptance was durably recorded",
        );
      const currentIdentity = readJson<P.Identity>(identityFile);
      if (
        target.request.buildHash !== priorAcceptance.originalBuildHash ||
        currentIdentity.buildHash !== priorAcceptance.originalBuildHash ||
        !sameInstance(currentIdentity.instance, priorAcceptance.instance) ||
        !originalFusionProcessAlive(currentIdentity.instance)
      )
        fail(
          "INSTANCE_CHANGED",
          "Original Fusion identity changed since owner acceptance was recorded",
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
      if (
        currentReport.fingerprint !== priorAcceptance.reportFingerprint ||
        !same(currentReport.identity, priorAcceptance.identity) ||
        !snapshotStillCurrent(currentReport.snapshot)
      )
        fail(
          "WORKFLOW_REPORT_CHANGED",
          "Atomic report changed since owner acceptance was durably recorded",
        );
      const result = state.resolve(target.id, {
        state: priorAcceptance.resolvedState,
        code:
          acceptedOutcome === "committed"
            ? "OWNER_ACCEPTED_ATOMIC_COMMIT"
            : "OWNER_ACCEPTED_ATOMIC_ABORT",
        executionOutcome:
          acceptedOutcome === "committed" ? "succeeded" : "failed",
        mayHaveMutated: true,
        sdkSettled: true,
        publicationOutcome: "unavailable",
        acceptanceReceipt: path.relative(dir, acceptancePath),
        observationJobId: priorAcceptance.observerJobId,
        nativeOutcome: acceptedOutcome,
        modelValidation: "not_performed",
        rollbackVerification: "not_performed",
      });
      endNativeActivity(active?.job?.id === target.id ? active : null);
      active = null;
      held = null;
      recovery = {
        jobId: id,
        observationJobId: priorAcceptance.observerJobId,
        status: "owner_accepted_" + acceptedOutcome,
        at: Date.now(),
      };
      diagnostics();
      return { ...priorAcceptance, job: result };
    }
    if (
      !isAtomicObservationCandidate(
        target,
        target?.request?.buildHash,
        observationScopeConfig,
      )
    )
      fail(
        "WORKFLOW_TYPE_NOT_ALLOWED",
        "Owner outcome acceptance is restricted to the exact Fasteners atomic job",
      );
    if (
      target.state !== "needs_reconciliation" ||
      state.data.blocked?.id !== target.id ||
      state.data.active !== target.id
    )
      fail(
        "NOT_BLOCKED",
        "The exact Fasteners atomic job is no longer the blocked queue owner",
      );
    if (state.data.lease)
      fail(
        "QUEUE_BUSY",
        "An unresolved queue lease prevents atomic owner acceptance",
      );
    if (
      active &&
      (active.job?.id !== target.id ||
        (!active.unknown && !active.workflowUnknown) ||
        active.pending.size ||
        (active.child && !active.workerClosed))
    )
      fail(
        "WORKER_PENDING",
        "Original worker or RPC is still pending; owner acceptance is unavailable",
      );
    const originalActivityId = active?.nativeActivityId;
    const remainingActiveIds = [...gate.active.keys()].filter(
      (id) => id !== originalActivityId,
    );
    if (remainingActiveIds.length)
      fail(
        "BROKER_BUSY",
        "Another physical admission remains active; owner acceptance is deferred",
      );
    const identity = readJson<P.Identity>(identityFile);
    if (
      target.request.buildHash !== identity.buildHash ||
      !sameInstance(instance, identity.instance)
    )
      fail(
        "BUILD_CHANGED",
        "Original target job/instance binding changed before acceptance",
      );
    if (!originalFusionProcessAlive(identity.instance))
      fail(
        "INSTANCE_CHANGED",
        "The original Fusion PID/birth identity is no longer alive at owner acceptance",
      );

    const observers = Object.values(state.data.jobs).filter(
      (job) =>
        job.workflowObservation?.targetJobId === target.id &&
        job.state === "succeeded",
    );
    if (observers.length !== 1)
      fail(
        "ATOMIC_OBSERVATION_REQUIRED",
        "Exactly one successful scoped atomic status observation is required",
      );
    const observer = required(observers[0]);
    const marker = observer.workflowObservation;
    if (
      !marker ||
      marker.targetRequestId !== target.requestId ||
      marker.targetClientId !== clientId ||
      marker.targetJobHash !== target.hash ||
      marker.targetBuildHash !== target.request.buildHash ||
      marker.observerBuildHash !== codeHash ||
      observer.request.buildHash !== codeHash ||
      observer.request.cwd !== marker.projectDirectory ||
      marker.projectDirectory !== target.request.cwd ||
      state.data.paused !== marker.paused ||
      (state.data.controlGeneration || 0) !== marker.controlGeneration ||
      (state.data.contextEpoch || 0) !== marker.contextEpoch
    ) {
      fail(
        "WORKFLOW_GATE_CHANGED",
        "Owner, pause, context, job or build fence changed after the scoped observation",
      );
    }
    const otherPendingJobs = Object.values(state.data.jobs).filter(
      (job) =>
        job.id !== target.id &&
        job.id !== observer.id &&
        !["succeeded", "failed", "cancelled", "expired"].includes(job.state),
    );
    if (otherPendingJobs.length)
      fail(
        "QUEUE_BUSY",
        "Other queued/local jobs must remain held until the scoped owner acceptance is complete",
      );
    const proofFile = path.join(
      jobDir(observer.id),
      "atomic-observation-proof.json",
    );
    const { value: proof, sha256: proofHash } =
      readAtomicProofRecord(proofFile);
    const proofEnvelopeMatches =
      proof.version === 1 &&
      proof.kind === "atomic_holder_status" &&
      proof.targetJobId === target.id &&
      proof.targetRequestId === target.requestId &&
      proof.observerJobId === observer.id &&
      proof.observerRequestId === observer.requestId &&
      proof.clientId === clientId &&
      proof.projectDirectory === marker.projectDirectory &&
      proof.reportPath === marker.reportPath &&
      proof.reportFingerprint === marker.reportFingerprint &&
      proof.originalBuildHash === target.request.buildHash &&
      proof.observerBuildHash === codeHash &&
      proof.readOnlyOperation === "atomic_status" &&
      proof.remoteOutcome === "succeeded" &&
      proof.toolFailed !== true;
    if (!proofEnvelopeMatches)
      fail(
        "RECEIPT_MISMATCH",
        "Scoped proof envelope, owner, build or transport outcome differs from the authorized observation",
      );
    if (
      proof.identityMatches !== true ||
      !proof.summary ||
      proof.summary.identityMatches === false ||
      !same(proof.summary.identity, proof.identity)
    )
      fail(
        "RECEIPT_MISMATCH",
        "Atomic status summary identity does not exactly match the report-bound holder identity",
      );
    const proofIdentityMatches = same(proof.identity, {
      commandId: marker.commandId,
      runId: proof.identity?.runId,
      requestHash: proof.identity?.requestHash,
      backend: "addin",
      sessionNonce: marker.sessionNonce,
      documentIdentity: proof.identity?.documentIdentity,
      resolvedIdentity: proof.identity?.documentIdentity?.resolved,
    });
    if (
      !proofIdentityMatches ||
      proof.identity?.documentIdentity?.expected?.creationId !== marker.docId ||
      proof.identity?.documentIdentity?.resolved?.creationId !== marker.docId ||
      proof.identity?.resolvedIdentity?.creationId !== marker.docId
    )
      fail(
        "RECEIPT_MISMATCH",
        "Scoped proof identity does not match the original command, session and document pin",
      );
    if (!sameInstance(proof.observerInstance, identity.instance))
      fail(
        "INSTANCE_CHANGED",
        "Atomic status proof came from a different Fusion PID/birth/version",
      );
    if (
      !proof.summary ||
      proof.summary.outcome !== acceptedOutcome ||
      proof.summary.destroyed !== true ||
      proof.summary.idle !== true ||
      (acceptedOutcome === "committed" &&
        (proof.summary.status !== "completed" ||
          proof.summary.completed !== true)) ||
      (acceptedOutcome === "aborted" &&
        (proof.summary.status !== "terminated" ||
          proof.summary.completed !== false))
    )
      fail(
        "OBSERVED_OUTCOME_MISMATCH",
        "Atomic status does not show the exact owner-selected destroyed and idle terminal outcome",
      );
    const report = await readCurrentAtomicObservationReport(marker.reportPath);
    if (
      report.fingerprint !== marker.reportFingerprint ||
      report.fingerprint !== proof.reportFingerprint ||
      report.commandId !== marker.commandId ||
      report.sessionNonce !== marker.sessionNonce ||
      report.docId !== marker.docId ||
      !same(report.identity, proof.identity)
    ) {
      fail(
        "WORKFLOW_REPORT_CHANGED",
        "Atomic report identity/history changed after the holder observation",
      );
    }
    validateAtomicOriginalReceipts(
      target,
      identity.buildHash,
      identity.instance,
      report.identity,
    );
    if (
      !/^[a-f0-9-]{36}$/.test(proof.rpcId || "") ||
      proof.receipt !==
        path.join(
          jobDir(observer.id),
          `atomic-observation-${proof.rpcId}.receipt.json`,
        ) ||
      proof.binding?.jobId !== observer.id ||
      proof.binding?.rpcId !== proof.rpcId ||
      proof.binding?.buildHash !== codeHash ||
      proof.binding?.observationKind !== "atomic_holder_status" ||
      proof.binding?.observationTargetJobId !== target.id ||
      proof.binding?.observationIdentityHash !==
        atomicObservationIdentityHash(proof.identity) ||
      !sameInstance(proof.observerInstance, identity.instance)
    ) {
      fail(
        "RECEIPT_MISMATCH",
        "Scoped atomic status transport receipt is not bound to the observed target/build/identity",
      );
    }
    const remote = remoteReceipt(
      {
        receipt: proof.receipt,
        binding: proof.binding,
        instance: proof.observerInstance,
      },
      false,
    );
    if (remote.outcome !== "succeeded")
      fail(
        "RECEIPT_MISMATCH",
        "Scoped atomic status transport receipt is not a successful terminal receipt",
      );

    const resolvedState =
      acceptedOutcome === "committed" ? "succeeded" : "failed";
    const acceptance = {
      version: 1,
      kind: "atomic-workflow-owner-acceptance",
      targetJobId: target.id,
      targetRequestId: target.requestId,
      observerJobId: observer.id,
      observerRequestId: observer.requestId,
      clientId,
      acceptedOutcome,
      resolvedState,
      projectDirectory: marker.projectDirectory,
      reportPath: marker.reportPath,
      reportFingerprint: marker.reportFingerprint,
      identity: proof.identity,
      instance: proof.observerInstance,
      originalBuildHash: target.request.buildHash,
      observerBuildHash: proof.observerBuildHash,
      paused: marker.paused,
      controlGeneration: marker.controlGeneration,
      contextEpoch: marker.contextEpoch,
      proofPath: path.relative(dir, proofFile),
      proofSha256: proofHash,
      remoteReceipt: {
        rpcId: proof.rpcId,
        outcome: remote.outcome,
        observerBuildHash: codeHash,
      },
      effects: {
        nativeOutcome: acceptedOutcome,
        destroyed: true,
        idleAtObservation: true,
        cleanupCompleted: proof.summary.cleanupCompleted === true,
        definitionDeleted: proof.summary.definitionDeleted === true,
        modelValidation: "not_performed",
        rollbackVerification: "not_performed",
        mayHaveMutated: true,
      },
      acceptedAt: new Date().toISOString(),
    };
    if (
      !snapshotStillCurrent(report.snapshot) ||
      state.data.blocked?.id !== target.id ||
      state.data.active !== target.id ||
      target.state !== "needs_reconciliation" ||
      state.data.paused !== marker.paused ||
      (state.data.controlGeneration || 0) !== marker.controlGeneration ||
      (state.data.contextEpoch || 0) !== marker.contextEpoch ||
      state.data.lease
    )
      fail(
        "WORKFLOW_GATE_CHANGED",
        "Report or queue fences changed during owner acceptance; unresolved blocker is retained",
      );
    durable(acceptancePath, acceptance, true);
    const result = state.resolve(target.id, {
      state: resolvedState,
      code:
        acceptedOutcome === "committed"
          ? "OWNER_ACCEPTED_ATOMIC_COMMIT"
          : "OWNER_ACCEPTED_ATOMIC_ABORT",
      executionOutcome:
        acceptedOutcome === "committed" ? "succeeded" : "failed",
      mayHaveMutated: true,
      sdkSettled: true,
      publicationOutcome: "unavailable",
      acceptanceReceipt: path.relative(dir, acceptancePath),
      observationJobId: observer.id,
      nativeOutcome: acceptedOutcome,
      cleanupCompleted: proof.summary.cleanupCompleted === true,
      definitionDeleted: proof.summary.definitionDeleted === true,
      modelValidation: "not_performed",
      rollbackVerification: "not_performed",
    });
    endNativeActivity(active?.job?.id === target.id ? active : null);
    active = null;
    held = null;
    recovery = {
      jobId: target.id,
      observationJobId: observer.id,
      status: "owner_accepted_" + acceptedOutcome,
      at: Date.now(),
    };
    diagnostics();
    return { ...acceptance, job: result };
  }

  async function reconcile(id: string, clientId: string) {
    const job = owned(id, clientId);
    if (job.state !== "needs_reconciliation")
      fail("NOT_BLOCKED", "Job does not require reconciliation");
    if (
      active &&
      (active.pending.size || (active.child && !active.workerClosed))
    )
      fail(
        "WORKER_PENDING",
        "Owned worker or broker RPC is still pending; no probe sent",
      );
    if (!instance)
      fail(
        "INSTANCE_UNAVAILABLE",
        "Original pinned instance record unavailable; no probe sent",
      );
    const directory = privateDirectory(jobDir(id));
    const optional = <T>(name: string) =>
      fs.existsSync(path.join(directory, name))
        ? readJson<T>(path.join(directory, name))
        : null;
    const worker = optional<P.WorkerResult>("worker-result.json");
    if (worker && worker.jobId !== id)
      fail("RECEIPT_MISMATCH", "Worker result belongs to a different job");
    if (worker?.nonterminal || workflowNonterminal(worker?.workflowOutcome)) {
      fail(
        "WORKFLOW_RECONCILIATION_REQUIRED",
        "Typed workflow outcome is unknown/nonterminal; a generic synchronous script receipt does not prove workflow completion. No probe sent",
      );
    }
    const adapter = optional<P.AdapterOutcome>("adapter-outcome.json");
    if (adapter) {
      if (adapter.jobId !== id || adapter.buildHash !== codeHash)
        fail(
          "RECEIPT_MISMATCH",
          "Adapter evidence belongs to a different job/build",
        );
    }
    const workerIdentityFile = path.join(directory, "worker-identity.json");
    if (!active && fs.existsSync(workerIdentityFile)) {
      const workerIdentity = readJson<{ pid: number; birth: string }>(
        workerIdentityFile,
      );
      try {
        if (processBirth(workerIdentity.pid) === workerIdentity.birth)
          fail(
            "WORKER_PENDING",
            "Original local worker is still alive; no probe sent",
          );
      } catch (cause) {
        const error = errorInfo(cause);
        if (!["ENOENT", "ESRCH"].includes(error.code ?? "")) throw error;
      }
    } else if (!active && optional("worker-start.json")) {
      fail(
        "WORKER_IDENTITY_UNAVAILABLE",
        "Worker spawn was prepared without a durable process identity; absence of a live worker is unproven",
      );
    }
    const records = fs
      .readdirSync(directory)
      .filter(
        (name) => /^rpc-.*\.json$/.test(name) && name !== "rpc-result.json",
      )
      .map((name) => readJson<P.RecordEvidence>(path.join(directory, name)));
    if (
      records.some(
        (record) =>
          record.binding?.jobId !== id ||
          record.binding?.buildHash !== codeHash ||
          !sameInstance(record.instance, instance),
      )
    ) {
      fail(
        "RECEIPT_MISMATCH",
        "Dispatch journal belongs to a different job, build, or Fusion instance; no probe sent",
      );
    }
    const count = job.dispatch?.rpcCount || 0;
    const notDispatched = count === 0;
    if (adapter?.unknown && (notDispatched || !adapter.rpcId)) {
      fail(
        "ADAPTER_RECONCILIATION_REQUIRED",
        "Unbound adapter uncertainty cannot be certified by generic receipts. No probe sent",
      );
    }
    const receipts = [];
    const nativeEnds = [];
    // Every new probe is itself a physical call. Earlier SDK turns being settled
    // must never hide an unfinished probe of the current turn.
    for (const stage of ["preflight", "postflight"]) {
      const started = optional<P.ProbeRecord>(stage + "-start.json");
      if (!started) continue; // Older settled jobs did not record postflight starts.
      if (
        started.jobId !== id ||
        started.buildHash !== codeHash ||
        !sameInstance(started.instance, instance) ||
        started.binding?.jobId !== id ||
        started.binding.buildHash !== codeHash ||
        !/^[a-f0-9-]{36}$/.test(started.binding.rpcId || "") ||
        started.binding.requestHash !==
          hash(stage + ":" + id + ":" + started.binding.rpcId) ||
        started.receipt !==
          path.join(
            directory,
            stage + "-" + started.binding.rpcId + ".receipt.json",
          )
      ) {
        fail(
          "RECEIPT_MISMATCH",
          stage + " probe binding/path mismatch; no new probe sent",
        );
      }
      remoteReceipt(
        {
          receipt: started.receipt,
          binding: started.binding,
          instance: started.instance,
        },
        false,
      );
    }
    if (notDispatched) {
      if (records.some((record) => record.terminal))
        fail(
          "RECEIPT_MISMATCH",
          "Terminal RPC journal conflicts with the undispatched state",
        );
      const started = optional<P.ProbeRecord>("preflight-start.json");
      const completed = optional<P.ProbeRecord>("preflight.json");
      for (const receipt of [started, completed].filter(
        (value): value is P.ProbeRecord => value !== null,
      )) {
        if (
          receipt.jobId !== id ||
          receipt.buildHash !== codeHash ||
          !sameInstance(receipt.instance, instance)
        )
          fail(
            "RECEIPT_MISMATCH",
            "Preflight evidence is not bound to this job/instance/build",
          );
      }
      let observation =
        completed?.completed === true ? completed.instance : null;
      if (started && !observation && started.receipt && started.binding) {
        if (
          started.binding.jobId !== id ||
          started.binding.buildHash !== codeHash ||
          !/^[a-f0-9-]{36}$/.test(started.binding.rpcId || "") ||
          started.binding.requestHash !==
            hash("preflight:" + id + ":" + started.binding.rpcId) ||
          started.receipt !==
            path.join(
              directory,
              "preflight-" + started.binding.rpcId + ".receipt.json",
            )
        ) {
          fail(
            "RECEIPT_MISMATCH",
            "Preflight probe binding/path mismatch; no new probe sent",
          );
        }
        observation = remoteReceipt(
          {
            receipt: started.receipt,
            binding: started.binding,
            instance: started.instance,
          },
          false,
        ).instance;
      }
      if (started && !observation)
        fail(
          "PREFLIGHT_PENDING",
          "Previous preflight started but its completion is unproven; no probe sent",
        );
      const outcome = {
        state: "failed",
        code:
          observation && !idle(observation) ? "FUSION_BUSY" : "NOT_DISPATCHED",
        executionOutcome: "not_started",
        userScriptSubmitted: false,
        mayHaveMutated: false,
        preflightCompleted: !!observation,
        source: "durable-preflight-evidence",
      };
      durable(path.join(directory, "outcome.json"), outcome);
      const result = state.resolve(id, outcome);
      held = null;
      active = null;
      diagnostics();
      return result; // No new probe is needed to settle a product request never sent.
    } else {
      if (records.length !== count)
        fail(
          "RECEIPT_UNAVAILABLE",
          "Complete original dispatch journal is unavailable; no probe sent",
        );
      for (const record of records) {
        const declared = nativeReceipts.start(record);
        const ended = declared
          ? nativeReceipts.completion(record, declared)
          : null;
        if (declared && !ended)
          fail(
            "NATIVE_WORKFLOW_PENDING",
            "Declared native command has no matching terminal lifecycle receipt; no probe sent",
          );
        if (record.nonterminal && !ended)
          fail(
            "WORKFLOW_RECONCILIATION_REQUIRED",
            "RPC returned a typed nonterminal workflow outcome; no generic reconciliation or probe",
          );
        if (ended) nativeEnds.push(ended);
        if (record.terminal) {
          if (!record.request || record.request.method !== record.method)
            fail(
              "RECEIPT_MISMATCH",
              "Terminal RPC has no original reply identity",
            );
          matching(
            client,
            record.response,
            record.wireRequest || record.request,
          );
          if (record.receipt) {
            receipts.push(remoteReceipt(record, true, record.remoteReceipt));
            if (record.remoteReceipt && fs.existsSync(record.receipt)) {
              const current = remoteReceipt(record);
              if (current.outcome !== record.remoteReceipt.outcome)
                fail(
                  "RECEIPT_MISMATCH",
                  "Remote receipt changed after terminal publication",
                );
            }
          }
        } else {
          if (!record.receipt)
            fail(
              "RECEIPT_UNAVAILABLE",
              "Unsettled non-script RPC has no remote completion evidence; no probe sent",
            );
          receipts.push(remoteReceipt(record));
        }
      }
      if (
        optional<{ code: string }>("outcome.json")?.code ===
          "WORKFLOW_NONTERMINAL" &&
        !nativeEnds.length
      ) {
        fail(
          "WORKFLOW_RECONCILIATION_REQUIRED",
          "Persisted typed workflow fence cannot be cleared by a generic synchronous receipt",
        );
      }
    }
    if (
      adapter?.unknown &&
      !nativeEnds.some((proof) => proof.rpcId === adapter.rpcId)
    ) {
      fail(
        "ADAPTER_RECONCILIATION_REQUIRED",
        "Adapter result was malformed/unvalidated; generic RPC completion cannot certify it. No probe sent",
      );
    }
    const context = active;
    active = null;
    try {
      // A reset during the recovery probe must not cause stacked SDK probes.
      // Its filesystem receipt proves completion even if the transport reply was lost.
      let previous = optional<P.ProbeRecord>("reconcile-probe.json");
      let actual;
      if (previous) {
        if (
          previous.binding?.jobId !== id ||
          previous.binding?.buildHash !== codeHash ||
          !sameInstance(previous.instance, instance)
        )
          fail("RECEIPT_MISMATCH", "Recovery probe identity mismatch");
        const receipt = remoteReceipt(previous);
        if (receipt.outcome === "succeeded") actual = receipt.instance;
        else {
          // All original RPCs and this read-only probe have proven completion.
          // Preserve the failed attempt, then permit a fresh *observation*, never
          // a replay of the user's operation. Missing/mismatched/busy receipts
          // still fail above and cannot reach this branch.
          durable(
            path.join(
              directory,
              `reconcile-probe-${previous.binding.rpcId}.json`,
            ),
            previous,
          );
          previous = null;
        }
      }
      if (!previous) {
        const rpcId = randomUUID();
        const record = {
          binding: {
            jobId: id,
            rpcId,
            requestHash: hash("reconcile:" + id + ":" + rpcId),
            buildHash: codeHash,
          },
          instance,
          receipt: path.join(directory, `reconcile-${rpcId}.receipt.json`),
        };
        durable(path.join(directory, "reconcile-probe.json"), record);
        actual = await checkInstance({
          receiptPath: record.receipt,
          binding: record.binding,
          diagnosticPath: path.join(
            directory,
            `reconcile-${rpcId}.result.json`,
          ),
        });
      }
      durable(path.join(directory, "reconcile-postflight.json"), actual);
    } finally {
      active = context;
    }
    let rawFile = load("./queue-response-files").responsePath(
      dir,
      job,
      "rpc-result.json",
    );
    let raw =
      job.kind === "rpc" && fs.existsSync(rawFile)
        ? readJson<P.Response>(rawFile)
        : null;
    const soleRecord = records.length === 1 ? records[0] : undefined;
    if (!raw && job.kind === "rpc" && soleRecord?.terminal) {
      const response = required(soleRecord.response);
      raw = soleRecord.wireRequest
        ? responseForCaller(
            response,
            required(soleRecord.request),
            matching(client, response, soleRecord.wireRequest),
          )
        : response;
      rawFile = load("./queue-response-files").responsePath(
        dir,
        job,
        "rpc-result.json",
        true,
      );
      durable(rawFile, raw);
    }
    const rawReply = raw && object(client._parse(raw.raw));
    const successfulOutput =
      !adapter?.unknown &&
      (job.kind === "rpc"
        ? rawReply &&
          !rawReply["error"] &&
          !object(rawReply["result"])["isError"]
        : worker?.terminal === true &&
          worker.jobId === id &&
          worker.code === 0);
    const details = {
      state: load("./dist/core/application/execution").reconciledExecution({
        outputAvailable: !!successfulOutput && !notDispatched,
        adapterUnknown: !!adapter?.unknown,
        receipts,
        records,
        nativeEnds,
      }),
      code: notDispatched
        ? "NOT_DISPATCHED"
        : worker?.terminal || raw
          ? "RECONCILED"
          : "RESULT_UNAVAILABLE",
      mayHaveMutated: !notDispatched,
      sdkSettled: true,
      publicationOutcome: successfulOutput ? "published" : "unavailable",
      limitations:
        "Synchronous receipts alone do not prove native background completion or model/physical validation.",
      ...(nativeEnds.length
        ? {
            nativeCompletion: nativeEnds.map((proof) => ({
              kind: proof.native.kind,
              commandId: proof.native.identity.commandId,
              ...proof.native.state,
            })),
          }
        : {}),
    };
    durable(path.join(directory, "outcome.json"), details);
    const result = state.resolve(id, details);
    endNativeActivity(context);
    held = null;
    active = null;
    diagnostics();
    return result;
  }

  async function dispatch(input: unknown): Promise<unknown> {
    const envelope = decodeEnvelope(input);
    const successorAction =
      successorControl &&
      (envelope.action === "observe-successor" ||
        (envelope.action === "create-isolated-scratch" &&
          successorControl.ownsCreation(envelope["requestId"])));
    if (
      epochProcessUnavailable &&
      !successorAction &&
      ![
        "register",
        "control-status",
        "queue-summary",
        "find-request",
        "status",
        "result",
      ].includes(envelope.action)
    )
      fail(
        "EPOCH_PROCESS_UNAVAILABLE",
        "Only authenticated metadata and existing receipts are available for this lost epoch; no SDK, lifecycle change or replacement",
      );
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
          envelope.action,
        );
    }
    // Process/history fences precede payload validation, as in the ordinary
    // broker. A malformed request cannot replace EPOCH_PROCESS_UNAVAILABLE.
    const message = decodeMessage(envelope);
    if (message.action === "backend") {
      const workerMessage = message as P.WorkerMessage;
      if (state.data.jobs[workerMessage.jobId]?.request.phased)
        return phased.enqueue(workerMessage);
      return backend(workerMessage);
    }
    if (message.action === "worker-status") {
      if (
        !active ||
        message.jobId !== active.job.id ||
        !equal(message.workerToken, active.token)
      ) {
        phased.authorize({
          jobId: required(message.jobId),
          workerToken: required(message.workerToken),
        });
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
        return {
          remainingMs: job.sdkRemainingMs ?? job.timeoutMs,
          phase: job.state,
          control: gate.snapshot(),
        };
      }
      if (active.unknown || state.summary().blocked)
        fail("RECONCILIATION_REQUIRED", "SDK outcome remains unresolved");
      return {
        remainingMs: required(active.budget).remaining(),
        waitingForPause: !!active.waitingForPause,
        control: gate.snapshot(),
      };
    }
    if (message.action === "register") {
      if (!identifier(message.clientId) || !identifier(message.clientToken))
        fail(
          "INVALID_CLIENT",
          "Nonempty clientId and private clientToken required",
        );
      const tokenHash = hash(message.clientToken);
      if (
        own(clients, message.clientId) &&
        !equal(clients[message.clientId], tokenHash)
      )
        fail(
          "CLIENT_EXISTS",
          "Client id already registered with another token",
        );
      if (epochProcessUnavailable) {
        if (!own(clients, message.clientId))
          fail(
            "EPOCH_PROCESS_UNAVAILABLE",
            "A lost epoch cannot register new clients or grant authority",
          );
        return { clientId: message.clientId };
      }
      const updated = { ...clients, [message.clientId]: tokenHash };
      durable(clientsFile, updated);
      clients = updated;
      return { clientId: message.clientId };
    }
    const clientId = auth(message);
    if (
      state.epoch &&
      (lifecycleControl.accepts(message.action) ||
        ["stop", "pause", "resume", "drain"].includes(message.action)) &&
      (clientId !== state.epoch.ownerClientId ||
        clients[clientId] !== state.epoch.ownerTokenHash)
    )
      fail(
        "NOT_OWNER",
        "A modeling grant is not epoch or broker administration authority",
      );
    if (
      state.epoch &&
      message.jobId &&
      state.isHistorical(message.jobId) &&
      ["cancel", "reconcile", "observe-atomic"].includes(message.action)
    )
      fail(
        "INSTANCE_HISTORY_QUARANTINED",
        "Historical unknown work is immutable; no replay, acceptance or cleanup",
      );
    if (lifecycleControl.accepts(message.action))
      return lifecycleControl.handle(message, clientId);
    switch (message.action) {
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
            clients: () => clients,
            assertControl: assertScratchControl,
            fence() {
              assertResetSubmissionOpen(dir);
              if (
                stopping ||
                closed ||
                busy ||
                active ||
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
            runtime: resolveRuntimePaths({ anchor: __filename }).installation,
            clients: () => clients,
            assertControl: assertScratchControl,
            fence() {
              assertResetSubmissionOpen(dir);
              if (
                fs.existsSync(path.join(dir, "recovery.lock")) ||
                fs.existsSync(path.join(dir, "atomic-migration.lock")) ||
                stopping ||
                closed ||
                busy ||
                active ||
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
        if (stopping) fail("BROKER_STOPPING", "Broker is stopping");
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
        const request = { ...r, clientId, ownerToken: clients[clientId] };
        if (state.epoch) {
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
          epochAdmission(state, request, clients);
          request.isolatedEpoch = state.epoch.epochId;
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
                K in keyof import("../packages/core/src/domain/queue-model").AtomicWorkflowObservation
              ]: import("../packages/core/src/domain/queue-model").AtomicWorkflowObservation[K];
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
            request.backend !== (pinned.backend || "mcp") ||
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
          const originalActiveIds =
            active?.nativeActivityId && gate.active.has(active.nativeActivityId)
              ? [active.nativeActivityId]
              : [];
          if (
            busy ||
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
          if (
            busy ||
            gate.resuming ||
            (active && active.job?.id !== blockedJob.id) ||
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
          validateRaw(rpcPayload(request.payload));
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
        if (request.backend && request.backend !== (pinned.backend || "mcp"))
          fail(
            "BACKEND_MISMATCH",
            "Job backend differs from the broker; no fallback",
          );
        // Preserve old request hashes; historical retries must not invent original
        // bytes by capturing their current source files.
        const existing = Object.values(state.data.jobs).some(
          (job) => job.requestId === request.requestId,
        );
        let rawPrepared: P.Prepared | undefined;
        let preparedId: string | undefined;
        let flights: Awaited<ReturnType<typeof prepareJobFlights>>;
        try {
          if (!existing && request.kind === "rpc") {
            preparedId = randomUUID();
            rawPreparations++;
            rawPrepared = await prepareOwnedPost(rpcPayload(request.payload), {
              id: preparedId,
            });
            resetFence();
            flights = await prepareJobFlights({
              id: preparedId,
              request,
              kind: "rpc",
              sequenceMode: request.sequence?.mode,
            });
          }
          // Offline raw preparation can outlive a stop/reset/build transition.
          // Recheck ownership before publishing an accepted job, not just at SDK send.
          const verifyAcceptance = () => {
            if (stopping || closed || closing)
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
          const accept = () => {
            verifyAcceptance();
            if (state.epoch) epochAdmission(state, request, clients);
            if (!existing)
              load(
                "./dist/node-adapters/persistence/accepted-inputs",
              ).retainAdmission(dir, request);
            const job = state.submit(request, preparedId);
            if (workflowObservation) {
              workflowObservation.observerJobHash = required(
                state.data.jobs[job.id],
              ).hash;
              state.armWorkflowObservation(job.id, workflowObservation);
            }
            if (rawPrepared && job.id === preparedId)
              rawPreparedPosts.set(job.id, rawPrepared);
            if (flights && job.id === preparedId)
              flightPlans.set(job.id, flights);
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
          if (stopping) setImmediate(drain);
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
          held,
          stopping,
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
          const id = load(
            "./dist/core/domain/queue-request-identity",
          ).matchAdmittedRequest(
            state.data.jobs,
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
        if (state.epoch)
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
              held,
              stopping,
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
      case "result": {
        if (!message.jobId)
          return {
            ...state.status(),
            held,
            stopping,
            recovery,
            buildHash: codeHash,
          };
        return {
          job: owned(message.jobId, clientId),
          ...outputs(message.jobId),
        };
      }
      case "cancel":
        return state.cancel(required(message.jobId), clientId);
      case "release":
        return state.release(required(message.sequenceId), clientId);
      case "reconcile":
        if (busy) fail("BROKER_BUSY", "Original execution has not settled");
        busy = true;
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
          busy = false;
          diagnostics();
          if (stopping) setImmediate(drain);
        }
      case "stop":
        if (message.onlyIfQuiescent === true) {
          if (
            message.expectedBuildHash !== codeHash ||
            message.expectedRevision !== state.summary().revision
          )
            fail("STATE_CONFLICT", "Broker changed before idle reload");
          if (
            held ||
            active ||
            busy ||
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
        if (held || state.summary().blocked || active?.unknown)
          fail(
            "RECONCILIATION_REQUIRED",
            "Cannot stop an unknown/blocked queue",
          );
        stopping = true;
        setImmediate(() =>
          close().catch((error) => {
            stopping = false;
            held ||= error.code || "CLOSE_FAILED";
          }),
        );
        return { stopping: true, draining: !!state.summary().active };
      default:
        fail("INVALID_ACTION", "Unknown broker action");
    }
  }

  async function executeAtomicObservation(observerJob: P.Job) {
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

    const originalContext = active;
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
    active = context;
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
      state.finish(observerJob.id, details);
      recovery = {
        jobId: targetJob.id,
        observationJobId: observerJob.id,
        status: "atomic_status_observed",
        at: Date.now(),
      };
      active = originalContext;
      diagnostics();
    } catch (cause) {
      const error = errorInfo(cause);
      if (
        scope.toolStarted ||
        (state.status(observerJob.id).dispatch?.rpcCount || 0) > 0
      ) {
        if (state.status(observerJob.id).state !== "needs_reconciliation")
          hold(
            observerJob,
            "Atomic status observation outcome is unknown; no replay",
          );
        active = context;
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
        state.finish(observerJob.id, details);
        active = originalContext;
      }
      diagnostics();
      throw error;
    }
  }

  async function execute(job: P.Job) {
    const directory = privateDirectory(jobDir(job.id));
    const flights = flightPlans.get(job.id);
    flightPlans.delete(job.id);
    let localContextChanged = false;
    try {
      flights?.preflight.send.fence();
      flights?.postflight.send.fence();
      if (job.request.phased) {
        const pending = phased.pending(job.id);
        if (pending) preparedCalls.get(pending.message)?.fence();
      }
      if (job.kind === "rpc") {
        const prepared = rawPreparedPosts.get(job.id);
        rawPreparedPosts.delete(job.id);
        if (!prepared)
          fail(
            "PREPARED_RPC_UNAVAILABLE",
            "The original checked RPC is unavailable; it is never reconstructed for replay",
          );
        prepared.pythonCertificate.fence(prepared.outgoing);
        localContextChanged =
          !prepared.metadataOnly &&
          prepared.contextEpoch !== (state.data.contextEpoch || 0);
        preparedPosts.set(rpcPayload(job.request.payload), prepared);
      }
    } catch (cause) {
      const error = errorInfo(cause);
      if (error.code === "DOCUMENT_CHANGED") {
        // Observe the fresh target with the already checked read-only probe,
        // then return its state. Never release the stale product operation.
        localContextChanged = true;
      } else {
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
        state.finish(job.id, details);
        if (job.request.phased)
          phased.reject(job.id, Object.assign(error, { notStarted: true }));
        return;
      }
    }
    if (job.workflowObservation) return executeAtomicObservation(job);
    const notStartedDetails = {
      executionOutcome: job.physicalTurns
        ? "previous_turns_complete_current_not_started"
        : "not_started",
      userScriptSubmitted: !!job.dispatch?.rpcCount,
      mayHaveMutated: !!job.dispatch?.rpcCount,
      currentTurnSubmitted: false,
    };
    const previousTurn =
      job.request.phased && job.physicalTurns
        ? readJson<P.Instance>(path.join(directory, "postflight.json"))
            .documentState
        : null;
    if (job.request.phased && job.physicalTurns) {
      const archive = privateDirectory(
        path.join(directory, "turns", String(job.physicalTurns)),
      );
      for (const name of [
        "preflight-start.json",
        "preflight.json",
        "preflight-result.json",
        "postflight-start.json",
        "postflight.json",
        "postflight-result.json",
        "outcome.json",
      ]) {
        const file = path.join(directory, name);
        if (fs.existsSync(file)) {
          durable(path.join(archive, name), readJson(file), true);
          fs.unlinkSync(file);
        }
      }
    }
    let inputFailure;
    if (
      job.request.buildHash !== undefined &&
      job.request.buildHash !== codeHash
    )
      inputFailure = "BUILD_CHANGED_BEFORE_EXECUTION";
    try {
      for (const input of job.request.inputFiles || []) {
        if (
          hash(
            fs.readFileSync(
              path.resolve(required(job.request.cwd), input.path),
            ),
          ) !== input.sha256
        )
          inputFailure = "INPUT_CHANGED";
      }
    } catch {
      inputFailure = "INPUT_UNAVAILABLE";
    }
    if (inputFailure) {
      const details = {
        state: "failed",
        code: inputFailure,
        ...notStartedDetails,
      };
      durable(path.join(directory, "outcome.json"), details);
      state.finish(job.id, details);
      if (job.request.phased)
        phased.reject(
          job.id,
          Object.assign(new Error(inputFailure), {
            code: inputFailure,
            notStarted: true,
          }),
        );
      return;
    }
    const entry =
      job.kind === "command" ? commandEntry(required(job.request.argv)) : null;
    const protocolOnly =
      job.kind === "rpc"
        ? [
            "initialize",
            "notifications/initialized",
            "ping",
            "tools/list",
          ].includes(rpcPayload(job.request.payload).method)
        : ["tools", "doctor"].includes(entry?.kind ?? "");
    const allowsBusy =
      protocolOnly ||
      ["ui.inspect", "ui.respond", "ui.resolve"].includes(entry?.target ?? "");
    const allowsBusyAfter = protocolOnly || entry?.target === "ui.inspect";
    const guardSelector =
      job.request.phased ||
      job.sequenceMode === "automatic" ||
      job.contextRefreshRequired ||
      load("./composition/stage-dependencies").requiresPhysicalStageOwner(
        job.request.payload,
      )
        ? documentSelector(job)
        : undefined;
    let observed: P.Instance | undefined;
    // Record actual completion before applying the idle policy. Even a lost
    // transport response has a bound remote receipt for later observation.
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
    durable(
      path.join(directory, "preflight-start.json"),
      {
        version: 2,
        jobId: job.id,
        buildHash: codeHash,
        instance,
        at: Date.now(),
        binding,
        receipt,
      },
      true,
    );
    try {
      await checkInstance({
        prepared: flights?.preflight,
        receiptPath: receipt,
        binding,
        requireIdle: !allowsBusy,
        diagnosticPath: path.join(directory, "preflight-result.json"),
        documentSelector: guardSelector,
        onObservation: (observation) => {
          observed = observation;
          durable(
            path.join(directory, "preflight.json"),
            {
              version: 2,
              jobId: job.id,
              buildHash: codeHash,
              completed: true,
              instance: observation,
              idle: idle(observation),
              requiresIdle: !allowsBusy,
            },
            true,
          );
        },
      });
    } catch (cause) {
      const error = errorInfo(cause);
      if (error.code === "BUILD_CHANGED" && error.probeNotSubmitted === true) {
        const outcome = {
          state: "failed",
          code: "BUILD_CHANGED_BEFORE_EXECUTION",
          ...notStartedDetails,
          preflightCompleted: false,
        };
        durable(path.join(directory, "outcome.json"), outcome);
        state.finish(job.id, outcome);
        if (job.request.phased)
          phased.reject(
            job.id,
            Object.assign(new Error(error.message), {
              code: outcome.code,
              notStarted: true,
            }),
          );
        return;
      }
      if (
        error.code !== "FUSION_BUSY" ||
        error.probeCompleted !== true ||
        !sameInstance(error.observation, instance)
      )
        throw error;
      const outcome = {
        state: "failed",
        code: "FUSION_BUSY",
        ...notStartedDetails,
        preflightCompleted: true,
        activeCommand: required(error.observation).activeCommand,
      };
      durable(path.join(directory, "outcome.json"), outcome);
      state.finish(job.id, outcome);
      if (job.request.phased)
        phased.reject(
          job.id,
          Object.assign(new Error(error.message), {
            code: error.code,
            notStarted: true,
          }),
        );
      return;
    }
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
        state.finish(job.id, {
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
        return;
      }
    }
    const context: P.Context = {
      job,
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
            job,
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
    active = context;
    let code: number | undefined,
      publicationError = false,
      adapted:
        { value: unknown; properties: Record<string, unknown> } | undefined;
    if (job.request.phased) {
      const pending = phased.pending(job.id);
      if (!pending)
        fail(
          "WORKER_CLOSED",
          "No prepared SDK request exists for the admitted turn",
        );
      try {
        adapted = await backend(pending.message);
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
        const rawPayload = rpcPayload(job.request.payload);
        const physicalCatalogRead = [
          "resources/list",
          "resources/templates/list",
        ].includes(rawPayload.method);
        const headers = Object.fromEntries(
          Object.entries(client.server.headers || {}).filter(
            ([name]) => name.toLowerCase() !== "mcp-protocol-version",
          ),
        );
        const operation = (async () => {
          const sessionId = physicalCatalogRead
            ? await client._openSession()
            : job.request.sessionId;
          const protocolVersion = physicalCatalogRead
            ? client.negotiatedProtocolVersion
            : job.request.protocolVersion;
          if (protocolVersion)
            headers["MCP-Protocol-Version"] = protocolVersion;
          return withRequest(
            { headers, timeoutMs: job.timeoutMs, protocolVersion },
            () => client._post(rawPayload, sessionId),
          );
        })();
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
        backend: pinned.backend || "mcp",
        tool: pinned.tool,
        transport: pinned.transport,
        timeoutMs: job.timeoutMs,
        protocolVersion: pinned.protocolVersion,
        url: "http://queue.invalid",
        headers: {},
      };
      durable(
        path.join(directory, "request.json"),
        {
          id: job.id,
          request: job.request,
          buildHash: codeHash,
          properties: clientProperties(),
          deadline: context.deadline,
        },
        true,
      );
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
              resolveRuntimePaths({ anchor: __filename }),
              "queue-worker",
            ),
            path.join(directory, "request.json"),
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
                hold(job, "Local worker identity could not be persisted");
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
          await settleNative(context);
        } catch (cause) {
          const error = errorInfo(cause);
          context.unknown = true;
          hold(job, error.code || "NATIVE_RECEIPT_UNAVAILABLE");
        }
        required(context.budget).close();
        if (context.pending.size) {
          hold(
            job,
            "Worker exited while a broker RPC is still pending; no postflight sent",
          );
          if (job.request.phased)
            phased.reject(
              job.id,
              Object.assign(
                new Error("SDK RPC remains pending; not cancelled or replayed"),
                { code: "RECONCILIATION_REQUIRED" },
              ),
            );
          return;
        }
        const workerFile = path.join(directory, "worker-result.json");
        const worker = fs.existsSync(workerFile)
          ? readJson<P.WorkerResult>(workerFile)
          : null;
        if (
          context.workflowUnknown ||
          (!job.request.phased &&
            (worker?.nonterminal ||
              workflowNonterminal(worker?.workflowOutcome)))
        ) {
          durable(path.join(directory, "outcome.json"), {
            state: "needs_reconciliation",
            code: "WORKFLOW_NONTERMINAL",
            workflowOutcome: worker?.workflowOutcome || null,
            nonterminal: true,
          });
          hold(
            job,
            "Typed workflow result is unknown/nonterminal; a synchronous script receipt is insufficient",
          );
          if (job.request.phased)
            phased.reject(
              job.id,
              Object.assign(
                new Error("Typed SDK workflow remains unknown; no replay"),
                { code: "WORKFLOW_NONTERMINAL" },
              ),
            );
          return;
        }
        if (
          context.unknown ||
          (context.timedOut && context.dispatched) ||
          state.summary().blocked
        ) {
          if (job.request.phased)
            phased.reject(
              job.id,
              Object.assign(
                new Error(
                  "SDK outcome requires reconciliation; not cancelled or replayed",
                ),
                { code: "RECONCILIATION_REQUIRED" },
              ),
            );
          return;
        }
        if (
          job.kind === "command" &&
          !job.request.phased &&
          context.dispatched &&
          (!worker?.terminal || worker.jobId !== job.id)
        ) {
          hold(
            job,
            "Worker exited after dispatch without its own durable terminal result",
          );
          return;
        }
        if (
          job.kind === "command" &&
          !job.request.phased &&
          code === 0 &&
          (!worker?.terminal || worker.jobId !== job.id)
        )
          publicationError = true;
        return true;
      },
      async postflight(settled) {
        if (!settled) return false;
        active = null;
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
        durable(
          path.join(directory, "postflight-start.json"),
          {
            version: 2,
            jobId: job.id,
            buildHash: codeHash,
            instance,
            at: Date.now(),
            binding: postBinding,
            receipt: postReceipt,
          },
          true,
        );
        try {
          durable(
            path.join(directory, "postflight.json"),
            await checkInstance({
              prepared: flights?.postflight,
              requireIdle: !allowsBusyAfter,
              receiptPath: postReceipt,
              binding: postBinding,
              diagnosticPath: path.join(directory, "postflight-result.json"),
              documentSelector: guardSelector,
            }),
            true,
          );
        } catch (cause) {
          const error = errorInfo(cause);
          active = context;
          if (
            error.code === "BUILD_CHANGED" &&
            error.probeNotSubmitted === true &&
            !context.unknown &&
            !context.pending.size
          ) {
            let settled = false;
            try {
              const records = fs
                .readdirSync(directory)
                .filter(
                  (name) =>
                    /^rpc-.*\.json$/.test(name) && name !== "rpc-result.json",
                )
                .map((name) =>
                  readJson<P.RecordEvidence>(path.join(directory, name)),
                );
              const count = state.status(job.id).dispatch?.rpcCount || 0;
              if (records.length !== count)
                fail("RECEIPT_UNAVAILABLE", "Original SDK journals incomplete");
              for (const record of records) {
                if (
                  !record.terminal ||
                  record.nonterminal ||
                  record.binding?.jobId !== job.id ||
                  record.binding.buildHash !== codeHash ||
                  !sameInstance(record.instance, instance)
                )
                  fail("RECEIPT_UNAVAILABLE", "SDK completion unproven");
                matching(
                  client,
                  record.response,
                  required(record.wireRequest || record.request),
                );
                if (record.receipt)
                  remoteReceipt(record, true, record.remoteReceipt);
                else if (
                  ![
                    "initialize",
                    "notifications/initialized",
                    "ping",
                    "tools/list",
                  ].includes(record.method)
                )
                  fail(
                    "NATIVE_RECEIPT_REQUIRED",
                    "Native idle completion needs a script receipt",
                  );
              }
              settled = true;
            } catch {
              /* Incomplete evidence retains the original unknown hold. */
            }
            if (settled) {
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
              const details = {
                state: "failed",
                code: "SDK_COMPLETE_BUILD_CHANGED",
                executionOutcome: "completed_postflight_not_submitted",
                userScriptSubmitted: !!state.status(job.id).dispatch?.rpcCount,
                mayHaveMutated: !!state.status(job.id).dispatch?.rpcCount,
                sdkSettled: true,
                postflightSubmitted: false,
                modelValidated: false,
              };
              durable(path.join(directory, "outcome.json"), details);
              state.finish(job.id, details);
              active = null;
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
          }
          hold(job, error.code || "POSTFLIGHT_FAILED");
          if (job.request.phased) phased.reject(job.id, error);
          return false;
        }
        return;
      },
      release() {
        if (job.request.phased) {
          const details = {
            state: "processing",
            code: context.phaseError?.code || "SDK_TURN_COMPLETE",
            exitCode: code,
            sdkSettled: true,
          };
          durable(path.join(directory, "outcome.json"), details);
          state.releaseTurn(
            job.id,
            Math.max(0, Math.floor(required(context.budget).remaining())),
          );
          active = null;
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
        state.finish(job.id, details);
        active = null;
      },
    });
  }

  async function tick() {
    // Retire only unused local plans for terminal jobs. This never settles,
    // cancels or releases an active/unknown physical operation.
    for (const id of new Set([
      ...rawPreparedPosts.keys(),
      ...flightPlans.keys(),
    ])) {
      const job = state.data.jobs[id];
      if (
        job &&
        !["succeeded", "failed", "cancelled", "expired"].includes(job.state)
      )
        continue;
      rawPreparedPosts.delete(id);
      flightPlans.delete(id);
      const pending = phased.pending(id);
      if (pending) preparedCalls.delete(pending.message);
    }
    if (busy || closed || stopping || epochProcessUnavailable) return;
    if (held) {
      // Queue deadlines continue to expire while a blocked job holds the physical instance.
      if (state.summary().blocked) {
        let observationJob;
        try {
          observationJob = state.next();
        } catch {
          /* The held storage fault is already visible to callers. */
        }
        if (observationJob?.workflowObservation) {
          busy = true;
          try {
            await execute(observationJob);
          } catch (cause) {
            const error = errorInfo(cause);
            const current = state.status(observationJob.id);
            if (current.state === "running") {
              if ((current.dispatch?.rpcCount || 0) > 0)
                hold(
                  observationJob,
                  error.code || "ATOMIC_OBSERVATION_UNKNOWN",
                );
              else {
                state.finish(observationJob.id, {
                  state: "failed",
                  code: error.code || "ATOMIC_OBSERVATION_NOT_STARTED",
                  executionOutcome: "not_started",
                  mayHaveMutated: false,
                  reason: error.message,
                });
              }
            }
          } finally {
            busy = false;
            if (stopping) setImmediate(drain);
          }
          diagnostics();
          return;
        }
        // Missing receipts/pending RPCs fail locally before any probe. Recheck
        // promptly so a caller's short timeout does not add a 30-second queue
        // stall after the original operation has demonstrably finished.
        const block = state.summary().blocked;
        const blockedJob = block && state.data.jobs[block.id];
        const scopedAtomicCandidate =
          blockedJob &&
          isAtomicObservationCandidate(
            blockedJob,
            blockedJob.request.buildHash,
            observationScopeConfig,
          );
        if (
          !atomicObservationOnly &&
          !scopedAtomicCandidate &&
          options.autoReconcile === true &&
          Date.now() - lastRecoveryCheck >= 1000
        ) {
          lastRecoveryCheck = Date.now();
          busy = true;
          const id = required(state.summary().blocked).id;
          try {
            await gate.administrative(() =>
              reconcile(id, state.status(id).clientId),
            );
            recovery = { jobId: id, status: "resolved", at: Date.now() };
          } catch (cause) {
            const error = errorInfo(cause);
            recovery = {
              jobId: id,
              status: "waiting_for_evidence",
              code: error.code || "RECOVERY_ERROR",
              at: Date.now(),
            };
          } finally {
            busy = false;
          }
          diagnostics();
        }
      }
      return;
    }
    busy = true;
    let job;
    try {
      job = state.next();
      if (job) await execute(job);
    } catch (cause) {
      const error = errorInfo(cause);
      if (
        job?.workflowObservation &&
        (state.status(job.id).dispatch?.rpcCount || 0) === 0 &&
        state.status(job.id).state === "running"
      ) {
        state.finish(job.id, {
          state: "failed",
          code: error.code || "ATOMIC_OBSERVATION_NOT_STARTED",
          executionOutcome: "not_started",
          mayHaveMutated: false,
          reason: error.message,
        });
      } else if (job) {
        hold(job, error.code || "BROKER_EXECUTION_FAILED");
        if (job.request.phased) phased.reject(job.id, error);
      } else held = error.code || "BROKER_STORAGE_FAILED";
      diagnostics();
    } finally {
      busy = false;
      if (stopping) setImmediate(drain);
    }
  }

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(30000, () => socket.destroy());
    let buffer = Buffer.alloc(0),
      consumed = false;
    function respond(value: unknown) {
      if (socket.destroyed) return;
      let text = JSON.stringify(value);
      if (Buffer.byteLength(text) > MAX)
        text = JSON.stringify({
          ok: false,
          error: {
            code: "RESPONSE_TOO_LARGE",
            message: "Response exceeds 16 MiB; use output file metadata",
          },
        });
      socket.end(text + "\n");
    }
    socket.on("data", (chunk) => {
      if (consumed) return;
      if (buffer.length + chunk.length > MAX) {
        consumed = true;
        respond({
          ok: false,
          error: {
            code: "MESSAGE_TOO_LARGE",
            message: "Request exceeds 16 MiB",
          },
        });
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      consumed = true;
      socket.setTimeout(0); // Client disconnects never cancel accepted jobs or backend operations.
      let message: unknown;
      try {
        message = JSON.parse(
          buffer.subarray(0, newline).toString("utf8"),
        ) as unknown;
      } catch {
        respond({
          ok: false,
          error: { code: "INVALID_JSON", message: "Invalid JSON request" },
        });
        return;
      }
      Promise.resolve()
        .then(() => dispatch(message))
        .then(
          (result) => respond({ ok: true, result }),
          (error) =>
            respond({
              ok: false,
              error: {
                code: error.code || "BROKER_ERROR",
                message: error.code
                  ? error.message
                  : "Broker operation failed; inspect private durable records",
                ...(error.pythonCheck
                  ? { pythonCheck: error.pythonCheck }
                  : {}),
                ...(error.notStarted === true ? { notStarted: true } : {}),
              },
            }),
        );
    });
  });
  const socket = queueSocket(dir);
  // A stale Unix socket may be removed only after exclusive lock ownership was acquired.
  if (process.platform !== "win32" && fs.existsSync(socket))
    fs.unlinkSync(socket);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  if (process.platform !== "win32") fs.chmodSync(socket, 0o600);
  try {
    durable(lifecycleFile, { ...lifecycle, stage: "ready" });
  } catch (error) {
    server.close();
    client.reqOpts?.agent?.destroy();
    throw error;
  }
  server.on("error", () => {
    held = "IPC_SERVER_ERROR";
  });
  diagnostics();
  const timer = setInterval(tick, options.pollMs || 100);

  async function close() {
    if (closed) return;
    if (
      held ||
      state.summary().blocked ||
      state.data.controlBlocked ||
      active?.unknown
    )
      fail(
        "RECONCILIATION_REQUIRED",
        "Cannot release broker ownership with an unknown/blocked job",
      );
    if (gate.resuming || gate.active.size)
      fail("BROKER_BUSY", "An admitted physical operation is still active");
    stopping = true;
    if (!closeTask)
      closeTask = new Promise((resolve, reject) => {
        closeResolve = resolve;
        closeReject = reject;
      });
    setImmediate(drain);
    return closeTask;
  }
  async function drain() {
    if (!stopping || closed || closing || !closeTask) return;
    if (held || state.summary().blocked || active?.unknown) {
      stopping = false;
      closeReject(
        Object.assign(
          new Error(
            "Drain became unknown/blocked; broker ownership is retained",
          ),
          { code: "RECONCILIATION_REQUIRED" },
        ),
      );
      closeTask = null;
      return;
    }
    if (
      busy ||
      active ||
      rawPreparations ||
      state.summary().active ||
      gate.active.size ||
      gate.resuming
    )
      return;
    closing = true;
    try {
      await phased.close();
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
      clearInterval(timer);
      for (const connection of sockets) connection.end();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (readJson<P.Owner>(lock).nonce !== marker.nonce)
        fail("LOCK_CHANGED", "Broker ownership marker changed");
      fs.unlinkSync(lock);
      const fd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      client.reqOpts?.agent?.destroy();
      closed = true;
      closeResolve();
    } catch (cause) {
      const error = errorInfo(cause);
      held = error.code || "CLOSE_FAILED";
      closeReject(error);
    }
  }
  return {
    close,
    dir,
    socket,
    buildHash: codeHash,
    status: () => ({ ...state.status(), held, stopping, buildHash: codeHash }),
  };
}

export { reclaim, brokerConfigHash };
