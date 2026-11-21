import { createHash, timingSafeEqual } from "node:crypto";

interface Message {
  action: string;
  clientId?: string;
  clientToken?: string;
  jobId?: string;
  auth?: { clientId: string; clientToken: string } | undefined;
}

interface DispatchPorts<Input extends Message, Job extends { clientId: string }> {
  persistClients(clients: Record<string, string>): void;
  processUnavailable(): boolean;
  ownsSuccessorCreation(requestId: unknown): boolean;
  hasSuccessor(): boolean;
  assertMigrationAdmission(action: string): void;
  readEpochOwner(): { ownerClientId: string; ownerTokenHash: string } | undefined;
  isHistorical(jobId: string): boolean;
  acceptsLifecycle(action: string): boolean;
  lifecycle(message: Input, owner: string): unknown;
  backend(message: Input): unknown;
  workerStatus(message: Input): unknown;
  readJob(jobId: string): Job;
  result(owner: string, job: Job | undefined): unknown;
  command(message: Input, owner: string, successorAction: boolean): unknown;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function equalHash(first: string | undefined, second: string): boolean {
  return typeof first === "string" &&
    Buffer.byteLength(first) === Buffer.byteLength(second) &&
    timingSafeEqual(Buffer.from(first), Buffer.from(second));
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function decodeEnvelope(value: unknown): Record<string, unknown> & { action: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_MESSAGE", "Expected a JSON object");
  const fields = object(value);
  if (typeof fields["action"] !== "string")
    fail("INVALID_ACTION", "Unknown broker action");
  return fields as Record<string, unknown> & { action: string };
}

function decodeMessage<Input extends Message>(
  message: Record<string, unknown> & { action: string },
): Input {
  for (const key of [
    "clientId",
    "clientToken",
    "jobId",
    "debugTraceMessageId",
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
  if (
    message.action === "backend" &&
    (!["callTool", "listTools", "executeUiGuardedScript"].includes(String(message["method"])) ||
      !Array.isArray(message["args"]))
  )
    fail("INVALID_BACKEND_METHOD", "Unsupported worker backend method");
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
  return message as Input;
}

/** Own the registration table and authorize each envelope before routing it. */
export function createBrokerIpcDispatch<
  Input extends Message,
  Job extends { clientId: string },
>(
  registrations: Readonly<Record<string, string>>,
  ports: DispatchPorts<Input, Job>,
): {
  clientHashes(): Record<string, string>;
  dispatch(input: unknown): Promise<unknown>;
} {
  let clients = { ...registrations };

  function register(message: Input) {
    const { clientId, clientToken } = message;
    if (!identifier(clientId) || !identifier(clientToken))
      fail("INVALID_CLIENT", "Nonempty clientId and private clientToken required");
    const hash = tokenHash(clientToken);
    const exists = Object.hasOwn(clients, clientId);
    if (exists && !equalHash(clients[clientId], hash))
      fail("CLIENT_EXISTS", "Client id already registered with another token");
    if (ports.processUnavailable()) {
      if (!exists)
        fail("EPOCH_PROCESS_UNAVAILABLE", "A lost epoch cannot register new clients or grant authority");
    } else {
      const updated = { ...clients, [clientId]: hash };
      ports.persistClients(updated);
      clients = updated;
    }
    return { clientId };
  }

  function authenticate(message: Input) {
    const auth = message.auth;
    if (
      !auth ||
      !identifier(auth.clientId) ||
      !identifier(auth.clientToken) ||
      !Object.hasOwn(clients, auth.clientId) ||
      !equalHash(clients[auth.clientId], tokenHash(auth.clientToken))
    )
      fail("UNAUTHORIZED", "Valid registered client credentials required");
    return auth.clientId;
  }

  return {
    clientHashes: () => ({ ...clients }),
    async dispatch(input: unknown): Promise<unknown> {
      const envelope = decodeEnvelope(input);
      const action = envelope.action;
      const successorAction = ports.hasSuccessor() &&
        (action === "observe-successor" ||
          (action === "create-isolated-scratch" &&
            ports.ownsSuccessorCreation(envelope["requestId"])));
      if (
        ports.processUnavailable() &&
        !successorAction &&
        !["register", "control-status", "queue-summary", "find-request", "status", "result"].includes(action)
      )
        fail(
          "EPOCH_PROCESS_UNAVAILABLE",
          "Only authenticated metadata and existing receipts are available for this lost epoch; no SDK, lifecycle change or replacement",
        );
      ports.assertMigrationAdmission(action);
      // Process/history fences outrank malformed action payloads.
      const message = decodeMessage<Input>(envelope);
      if (action === "backend") return ports.backend(message);
      if (action === "worker-status") return ports.workerStatus(message);
      if (action === "register") return register(message);
      const owner = authenticate(message);
      const epoch = ports.readEpochOwner();
      const lifecycle = ports.acceptsLifecycle(action);
      if (
        epoch &&
        (lifecycle || ["stop", "pause", "resume", "drain"].includes(action)) &&
        (owner !== epoch.ownerClientId || clients[owner] !== epoch.ownerTokenHash)
      )
        fail("NOT_OWNER", "A modeling grant is not epoch or broker administration authority");
      if (
        epoch &&
        message.jobId &&
        ports.isHistorical(message.jobId) &&
        ["cancel", "reconcile", "observe-atomic"].includes(action)
      )
        fail("INSTANCE_HISTORY_QUARANTINED", "Historical unknown work is immutable; no replay, acceptance or cleanup");
      if (lifecycle) return ports.lifecycle(message, owner);
      if (action === "result") {
        const job = message.jobId ? ports.readJob(message.jobId) : undefined;
        if (job && job.clientId !== owner)
          fail("NOT_OWNER", "Only the submitting client may access this job result");
        return ports.result(owner, job);
      }
      return ports.command(message, owner, successorAction);
    },
  };
}
