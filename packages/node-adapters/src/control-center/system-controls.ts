import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createBrokerControlPort } from "../broker-ipc/control.js";
import { durable, readJson } from "../persistence/records.js";
import { isBrokerControlSnapshot } from "@fmcad/core";
import type {
  BrokerControlFence,
  BrokerControlPort,
  BrokerControlSnapshot,
} from "@fmcad/core";
import type {
  SystemControlReceiptReadRequest,
  SystemControlReceiptRecord,
} from "@fmcad/control-center/server";
import {
  createSystemControls,
  createSystemControlsRoute,
} from "@fmcad/control-center/server";
import type {
  ConsoleQueryPrincipal,
  ConsoleQueryScope,
} from "@fmcad/control-center/server";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const terminal = new Set(["succeeded", "failed", "cancelled", "expired"]);
const markerNames = [
  "broker.lock",
  "autostart.lock",
  "recovery.lock",
  "fusion-reset.lock",
] as const;

export interface SystemControlQueueClient {
  readonly dir: string;
  readonly auth: { readonly clientId: string; readonly clientToken: string };
  call(action: string, values?: unknown): Promise<unknown>;
  register?(options?: { readonly autoStart?: boolean }): Promise<unknown>;
  dispose?(): void;
}

export interface SystemControlRuntimeOptions {
  readonly client: SystemControlQueueClient | (() => SystemControlQueueClient);
  readonly buildHash: () => string;
  /** Must reuse the existing explicit start-paused service; this is not restart. */
  readonly startStopped?: (
    fence: BrokerControlFence,
    client: SystemControlQueueClient,
  ) => Promise<unknown>;
  readonly fs?: typeof fs;
}

export interface SystemControlRuntime {
  readonly control: BrokerControlPort;
  readReceipt(
    request: SystemControlReceiptReadRequest,
  ): Promise<SystemControlReceiptRecord | null>;
  hasUnresolvedControl(): boolean;
  close(): void;
}

export interface CreateControlCenterSystemControlsOptions extends Omit<
  SystemControlRuntimeOptions,
  "client"
> {
  readonly client: SystemControlRuntimeOptions["client"];
  readonly authorize: (
    principal: ConsoleQueryPrincipal,
    scope: ConsoleQueryScope,
    operation: "read" | "control" | "receipt",
  ) => boolean | Promise<boolean>;
}

function markerExists(file: string, io: typeof fs): boolean {
  try {
    io.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function emptyQueueState(): Record<string, unknown> {
  return {
    version: 1,
    paused: true,
    revision: 0,
    epoch: 0,
    blocked: null,
    active: null,
    lease: null,
    jobs: {},
    lastClient: null,
    controlGeneration: 0,
    contextEpoch: 0,
  };
}

function readQueueState(dir: string, io: typeof fs): Record<string, unknown> {
  const pending = path.join(dir, "queue-state.pending.json");
  if (markerExists(pending, io))
    throw Object.assign(new Error("Queue snapshot durability is unresolved"), {
      code: "STORAGE_UNAVAILABLE",
    });
  const file = path.join(dir, "queue-state.json");
  let value: unknown;
  try {
    value = readJson(file, 128 * 1024 * 1024, io);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return emptyQueueState();
    throw error;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>)["version"] !== 1 ||
    !Object.hasOwn(value, "jobs") ||
    !(value as Record<string, unknown>)["jobs"] ||
    typeof (value as Record<string, unknown>)["jobs"] !== "object" ||
    Array.isArray((value as Record<string, unknown>)["jobs"])
  )
    throw Object.assign(new Error("Queue snapshot is not a supported state"), {
      code: "CORRUPT_STATE",
    });
  return value as Record<string, unknown>;
}

function unresolvedQueueState(state: Record<string, unknown>): boolean {
  const jobs = state["jobs"] as Record<string, unknown>;
  return (
    state["active"] != null ||
    state["blocked"] != null ||
    state["lease"] != null ||
    state["controlBlocked"] != null ||
    state["localUnknown"] != null ||
    Object.values(jobs).some(
      (value) =>
        !value ||
        typeof value !== "object" ||
        !terminal.has(String((value as Record<string, unknown>)["state"])),
    )
  );
}

function stoppedSnapshot(
  client: SystemControlQueueClient,
  buildHash: () => string,
  io: typeof fs,
): BrokerControlSnapshot {
  if (process.platform !== "linux")
    throw Object.assign(
      new Error(
        "Stopped broker ownership cannot be proven on this host platform",
      ),
      { code: "UNSUPPORTED_HOST" },
    );
  const directoryStat = io.lstatSync(client.dir);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (typeof process.getuid === "function" &&
      directoryStat.uid !== process.getuid())
  )
    throw Object.assign(
      new Error("Broker state directory is not safely owned"),
      {
        code: "UNSAFE_DIRECTORY",
      },
    );
  for (const name of markerNames)
    if (markerExists(path.join(client.dir, name), io))
      throw Object.assign(
        new Error("A broker or recovery ownership marker is present"),
        { code: "BROKER_STATE_UNKNOWN" },
      );
  if (markerExists(path.join(client.dir, "broker.sock"), io))
    throw Object.assign(
      new Error("A broker socket remains without a proven owner"),
      {
        code: "BROKER_STATE_UNKNOWN",
      },
    );
  const state = readQueueState(client.dir, io);
  const generation = state["controlGeneration"] ?? 0;
  const build = buildHash();
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    typeof build !== "string" ||
    !/^[a-f0-9]{64}$/.test(build)
  )
    throw Object.assign(new Error("Stopped broker identity is unavailable"), {
      code: "BROKER_STATE_UNKNOWN",
    });
  const unresolved = unresolvedQueueState(state);
  const stateIdentity = hash(
    JSON.stringify({
      build,
      generation,
      epoch: state["epoch"] ?? null,
      revision: state["revision"] ?? null,
      lastInstanceTransitionId: state["lastInstanceTransitionId"] ?? null,
    }),
  );
  return {
    protocol: 1,
    instanceId: `stopped-${stateIdentity}`,
    generation,
    phase: "STOPPED",
    buildHash: build,
    activeOperations: 0,
    unresolved,
    gateClosed: true,
    capabilities: { start: !unresolved },
  };
}

function startReceiptFile(dir: string, requestId: string): string {
  return path.join(dir, `lifecycle-control-${hash(requestId)}.json`);
}

function optionalRecord(file: string): SystemControlReceiptRecord | null {
  try {
    const value = readJson(file, 1024 * 1024);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !("binding" in value) ||
      !("status" in value) ||
      !value.binding ||
      typeof value.binding !== "object"
    )
      throw Object.assign(new Error("Lifecycle receipt is malformed"), {
        code: "CORRUPT_RECEIPT",
      });
    return value as SystemControlReceiptRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function matchesStartBinding(
  record: SystemControlReceiptRecord,
  clientId: string,
  fence: BrokerControlFence,
): boolean {
  const binding = record.binding as SystemControlReceiptRecord["binding"] & {
    readonly clientId?: string;
  };
  return (
    binding.action === "start" &&
    binding.clientId === clientId &&
    binding.requestId === fence.requestId &&
    binding.instanceId === fence.instanceId &&
    binding.expectedGeneration === fence.expectedGeneration
  );
}

function verifiedTerminalReceipt(
  record: SystemControlReceiptRecord,
  filename: string,
): boolean {
  const binding = record.binding as SystemControlReceiptRecord["binding"] & {
    readonly clientId?: string;
  };
  if (
    record.status !== "completed" ||
    !binding ||
    typeof binding.clientId !== "string" ||
    !binding.clientId ||
    typeof binding.action !== "string" ||
    typeof binding.requestId !== "string" ||
    hash(binding.requestId) !==
      filename.slice("lifecycle-control-".length, -".json".length) ||
    typeof binding.instanceId !== "string" ||
    !Number.isSafeInteger(binding.expectedGeneration)
  )
    return false;
  const result = record.result;
  if (!result || typeof result !== "object" || Array.isArray(result))
    return false;
  const resultObject = result as Record<string, unknown>;
  if (
    "requestId" in resultObject &&
    resultObject["requestId"] !== binding.requestId
  )
    return false;
  const snapshot = isBrokerControlSnapshot(resultObject)
    ? resultObject
    : startResultSnapshot(result);
  if (!snapshot || snapshot.unresolved) return false;
  if (binding.action === "pause" || binding.action === "drain")
    return (
      snapshot.instanceId === binding.instanceId &&
      snapshot.gateClosed &&
      ["PAUSED", "PAUSING"].includes(snapshot.phase)
    );
  if (binding.action === "resume")
    return (
      snapshot.instanceId === binding.instanceId &&
      !snapshot.gateClosed &&
      snapshot.phase === "RUNNING"
    );
  if (binding.action === "start")
    return (
      snapshot.instanceId !== binding.instanceId &&
      snapshot.gateClosed &&
      snapshot.phase === "PAUSED" &&
      snapshot.activeOperations === 0
    );
  return false;
}

function startResultSnapshot(value: unknown): BrokerControlSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = (value as Record<string, unknown>)["control"];
  return isBrokerControlSnapshot(snapshot) ? snapshot : null;
}

export function createSystemControlRuntime(
  options: SystemControlRuntimeOptions,
): SystemControlRuntime {
  const createClient =
    typeof options.client === "function"
      ? options.client
      : () => options.client as SystemControlQueueClient;
  let clientValue: SystemControlQueueClient | null = null;
  const getClient = (): SystemControlQueueClient =>
    (clientValue ??= createClient());
  const io = options.fs ?? fs;
  let registered = false;
  let registration: Promise<void> | null = null;
  let starting = false;
  const startStopped = options.startStopped;

  const ipcClient = {
    async call(action: string, values?: unknown) {
      const client = getClient();
      if (!registered && client.register) {
        if (!registration) {
          registration = client
            .register({ autoStart: false })
            .then(() => {
              registered = true;
            })
            .finally(() => {
              registration = null;
            });
        }
        await registration;
      }
      return client.call(action, values);
    },
  };
  const start = startStopped
    ? async (fence: BrokerControlFence): Promise<unknown> => {
        if (starting)
          throw Object.assign(new Error("A broker start is already pending"), {
            code: "STATE_CONFLICT",
          });
        starting = true;
        try {
          const client = getClient();
          const file = startReceiptFile(client.dir, fence.requestId);
          const binding = {
            action: "start" as const,
            ...fence,
            clientId: client.auth.clientId,
          };
          const prior = optionalRecord(file);
          if (prior) {
            if (!matchesStartBinding(prior, client.auth.clientId, fence))
              throw Object.assign(
                new Error("The start request ID belongs to another intent"),
                { code: "REQUEST_CONFLICT" },
              );
            if (prior.status === "completed") return prior.result;
            throw Object.assign(
              new Error(
                "The original start receipt is pending; it will not be replayed",
              ),
              { code: "REQUEST_PENDING" },
            );
          }
          const before = stoppedSnapshot(client, options.buildHash, io);
          if (
            before.phase !== "STOPPED" ||
            before.unresolved ||
            before.capabilities.start !== true
          )
            throw Object.assign(
              new Error("Broker start requires a clean, stopped queue"),
              { code: "RECONCILIATION_REQUIRED" },
            );
          if (before.instanceId !== fence.instanceId)
            throw Object.assign(new Error("Stopped queue identity changed"), {
              code: "INSTANCE_CHANGED",
            });
          if (before.generation !== fence.expectedGeneration)
            throw Object.assign(new Error("Stopped queue generation changed"), {
              code: "STATE_CONFLICT",
            });
          durable(file, { binding, status: "prepared" }, true);
          try {
            const result = await startStopped(fence, client);
            const snapshot = startResultSnapshot(result);
            if (
              !snapshot ||
              snapshot.instanceId === fence.instanceId ||
              snapshot.buildHash !== options.buildHash() ||
              snapshot.phase !== "PAUSED" ||
              !snapshot.gateClosed ||
              snapshot.activeOperations !== 0 ||
              snapshot.unresolved
            )
              throw Object.assign(
                new Error(
                  "Broker start did not prove a distinct paused instance",
                ),
                { code: "START_NOT_PAUSED" },
              );
            durable(file, { binding, status: "completed", result });
            return result;
          } catch (error) {
            try {
              durable(file, {
                binding,
                status: "unresolved",
                error: {
                  code:
                    error && typeof error === "object" && "code" in error
                      ? String(error.code)
                      : "START_OUTCOME_UNKNOWN",
                },
              });
            } catch {
              // The prepared receipt remains the no-replay fence.
            }
            throw error;
          }
        } finally {
          starting = false;
        }
      }
    : undefined;

  const local = {
    stopped: async () => stoppedSnapshot(getClient(), options.buildHash, io),
    ...(start ? { start } : {}),
  };
  const control = createBrokerControlPort(ipcClient, local);

  return {
    control,
    readReceipt({ requestId, principal }: SystemControlReceiptReadRequest) {
      if (!principal.globalRead) return Promise.resolve(null);
      const client = getClient();
      const names = [`lifecycle-control-${hash(requestId)}.json`];
      for (const name of names) {
        const record = optionalRecord(path.join(client.dir, name));
        if (!record) continue;
        const binding =
          record.binding as SystemControlReceiptRecord["binding"] & {
            readonly clientId?: string;
          };
        if (binding.clientId !== client.auth.clientId)
          return Promise.resolve(null);
        return Promise.resolve(record);
      }
      return Promise.resolve(null);
    },
    hasUnresolvedControl() {
      const client = getClient();
      const files = io
        .readdirSync(client.dir)
        .filter((name) => /^lifecycle-control-[a-f0-9]{64}\.json$/.test(name));
      if (files.length > 10_000)
        throw Object.assign(
          new Error("Control receipt scan exceeded its bound"),
          {
            code: "RECEIPT_SCAN_LIMIT",
          },
        );
      for (const name of files) {
        const record = optionalRecord(path.join(client.dir, name));
        if (record && !verifiedTerminalReceipt(record, name)) return true;
      }
      return false;
    },
    close() {
      clientValue?.dispose?.();
    },
  };
}

/** Production factory for the existing authenticated Control Center HTTP server. */
export function createControlCenterSystemControls(
  options: CreateControlCenterSystemControlsOptions,
) {
  const runtime = createSystemControlRuntime(options);
  const application = createSystemControls({
    control: runtime.control,
    readReceipt: (request) => runtime.readReceipt(request),
    hasUnresolvedControl: () => runtime.hasUnresolvedControl(),
    authorize: options.authorize,
  });
  return {
    handle: createSystemControlsRoute(application),
    close: () => runtime.close(),
  };
}
