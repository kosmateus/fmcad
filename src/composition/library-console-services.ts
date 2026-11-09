import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import * as fileSystem from "node:fs";
import { createRequire } from "node:module";
import type {
  BrokerAction,
  BrokerControlSnapshot,
  BrokerControlFence,
} from "../../packages/core/src";
const load = createRequire(__filename);
const { createBrokerControl } = load(
  "../core/application/broker-control",
) as typeof import("../../packages/core/src/application/broker-control");
const { createBrokerControlPort } = load(
  "../node-adapters/broker-ipc/control",
) as typeof import("../../packages/node-adapters/src/broker-ipc/control");
interface ServiceClient {
  dir?: string;
  auth?: Readonly<Record<string, unknown>>;
  call(
    action: string,
    values?: { control: BrokerControlFence },
  ): Promise<unknown>;
}
export interface ServiceConfiguration {
  routing?: string;
  queue?: Readonly<Record<string, unknown>>;
  [key: string]: unknown;
}
interface ServiceControl {
  current: unknown;
  client?: ServiceClient | undefined;
  read(): Promise<Partial<BrokerControlSnapshot> | null | undefined>;
}
export interface ServiceOptions {
  cfg: ServiceConfiguration;
  control: ServiceControl;
  fs?: Pick<typeof fileSystem, "lstatSync">;
  readJson?: (file: string, maxBytes?: number) => unknown;
  ensureBroker?: (
    cfg: ServiceConfiguration,
    auth: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  requestID?: () => string;
  timeoutMs?: number;
}
const { readJson: defaultReadJson } = load("../../queue-instance") as {
  readJson: NonNullable<ServiceOptions["readJson"]>;
};
const { ensureBroker: defaultEnsureBroker } = load("../../queue-autostart") as {
  ensureBroker: NonNullable<ServiceOptions["ensureBroker"]>;
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const errorCode = (error: unknown): unknown =>
  error !== null && typeof error === "object" && "code" in error
    ? error.code
    : null;
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
const missing = (error: unknown) =>
  ["ENOENT", "ECONNREFUSED", "QUEUE_NOT_RUNNING"].includes(
    String(errorCode(error)),
  );
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 256;

export function createServices({
  cfg,
  control,
  fs = fileSystem,
  readJson = defaultReadJson,
  ensureBroker = defaultEnsureBroker,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  requestID = randomUUID,
  timeoutMs = 30000,
}: ServiceOptions) {
  let pending = false;
  const optional = (file: string, maxBytes?: number) => {
    try {
      return readJson(file, maxBytes);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  };
  function fences(
    before: Partial<BrokerControlSnapshot> | null | undefined,
    capability: BrokerAction | "restart",
  ) {
    if (
      !before ||
      before.protocol !== 1 ||
      !identifier(before.instanceId) ||
      !identifier(before.buildHash) ||
      typeof before.generation !== "number" ||
      !Number.isSafeInteger(before.generation) ||
      before.generation < 0 ||
      before.capabilities?.[capability] !== true
    ) {
      fail(
        "UNSUPPORTED_BROKER",
        "Broker does not expose compatible explicit console actions",
      );
    }
    const requestId = requestID();
    if (!identifier(requestId))
      fail("INVALID_REQUEST", "Invalid console request ID");
    return {
      requestId,
      instanceId: before.instanceId,
      expectedGeneration: before.generation,
    };
  }
  async function observeError(error: unknown): Promise<never> {
    control.current = null;
    try {
      await control.read();
    } catch {
      /* Observe status only; never retry the action. */
    }
    throw error;
  }
  function clearOwnership(dir: string) {
    // lstat detects malformed files and dangling symlinks as ownership conflicts too.
    for (const name of ["broker.lock", "autostart.lock", "recovery.lock"]) {
      try {
        fs.lstatSync(path.join(dir, name));
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      fail(
        "OWNERSHIP_CONFLICT",
        "An ownership marker is present; no startup or recovery was attempted",
      );
    }
    const saved = optional(
      path.join(dir, "queue-state.json"),
      128 * 1024 * 1024,
    );
    if (
      saved &&
      (!isRecord(saved) ||
        saved["version"] !== 1 ||
        typeof saved["paused"] !== "boolean" ||
        !saved["jobs"] ||
        typeof saved["jobs"] !== "object" ||
        Array.isArray(saved["jobs"]) ||
        saved["active"] !== null ||
        saved["blocked"] != null ||
        saved["lease"] != null ||
        saved["controlBlocked"] != null ||
        saved["localUnknown"] != null ||
        Object.values(saved["jobs"]).some(
          (job) =>
            !isRecord(job) ||
            !["queued", "succeeded", "failed", "cancelled", "expired"].includes(
              String(job["state"]),
            ),
        ))
    ) {
      fail(
        "RECONCILIATION_REQUIRED",
        "Persisted queue ownership or unfinished execution is uncertain",
      );
    }
  }
  async function exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (cfg.routing !== "queue")
      fail(
        "UNSUPPORTED_ROUTING",
        "Explicit console service actions require queue routing",
      );
    if (pending)
      fail("STATE_CONFLICT", "A console service action is already pending");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
      fail("INVALID_TIMEOUT", "Console action deadline must be 1..600000 ms");
    pending = true;
    try {
      return await run();
    } finally {
      pending = false;
    }
  }
  async function shared(action: "pause" | "drain" | "resume" | "stop") {
    return exclusive(async () => {
      const before = await control.read();
      const fence = fences(before, action);
      if (!control.client)
        fail("CLIENT_UNAVAILABLE", "Queue client is unavailable");
      const ipc = createBrokerControlPort(control.client);
      try {
        return await createBrokerControl(ipc).execute(action, fence);
      } catch (error) {
        return observeError(error);
      }
    });
  }
  const services = {
    pause: () => shared("pause"),
    drain: () => shared("drain"),
    resume: () => shared("resume"),
    stop: () => shared("stop"),
    inspect() {
      return exclusive(async () => {
        const before = await control.read();
        const request = fences(before, "inspect");
        if (!control.client)
          fail("CLIENT_UNAVAILABLE", "Queue client is unavailable");
        try {
          return await control.client.call("console-inspect", {
            control: request,
          });
        } catch (error) {
          return observeError(error);
        }
      });
    },
    restart({
      action = "restart",
      requireStopped = false,
    }: { action?: "restart" | "reload"; requireStopped?: boolean } = {}) {
      return exclusive(async () => {
        let before: Partial<BrokerControlSnapshot> | null | undefined;
        try {
          before = await control.read();
        } catch (error) {
          if (!missing(error)) throw error;
        }
        const client = control.client;
        if (!client || typeof client.dir !== "string" || !client.auth)
          fail(
            "CLIENT_UNAVAILABLE",
            "Queue client authentication and state directory are required",
          );
        if (before) {
          if (requireStopped)
            fail(
              "BROKER_ALREADY_RUNNING",
              "Start is only valid for an absent broker; resume is separate",
            );
          const request = fences(before, action);
          if (
            before.unresolved ||
            before.activeOperations !== 0 ||
            before.phase === "RESUMING"
          )
            fail(
              "RECONCILIATION_REQUIRED",
              "Broker must have no active or unresolved calls",
            );
          let ack;
          try {
            ack = await client.call("console-" + action, { control: request });
          } catch (error) {
            return observeError(error);
          }
          const digest = createHash("sha256")
            .update(request.requestId)
            .digest("hex");
          const releaseFile = path.join(
            client.dir,
            "console-release-" + digest + ".json",
          );
          if (
            !isRecord(ack) ||
            ack["acknowledged"] !== true ||
            ack["requestId"] !== request.requestId ||
            ack["instanceId"] !== before.instanceId ||
            ack["buildHash"] !== before.buildHash ||
            ack["releaseFile"] !== releaseFile
          ) {
            fail(
              "RECEIPT_MISMATCH",
              "Restart acknowledgement is not bound to this request and broker",
            );
          }
          const deadline = now() + timeoutMs;
          for (;;) {
            const receipt = optional(releaseFile);
            if (receipt) {
              if (
                !isRecord(receipt) ||
                receipt["terminal"] !== true ||
                receipt["requestId"] !== request.requestId ||
                receipt["instanceId"] !== before.instanceId ||
                receipt["buildHash"] !== before.buildHash
              )
                fail("RECEIPT_MISMATCH", "Release receipt binding is invalid");
              if (receipt["outcome"] !== "released")
                fail(
                  "BROKER_RETAINED",
                  "Broker did not prove release; no replacement was started",
                );
              break;
            }
            if (now() >= deadline)
              fail(
                "RELEASE_UNKNOWN",
                "Original broker release is unproven; no restart request was replayed",
              );
            await sleep(Math.min(50, Math.max(1, deadline - now())));
          }
        }
        clearOwnership(client.dir);
        // ensureBroker atomically claims startup and refuses a racing foreign owner.
        await ensureBroker(
          {
            ...cfg,
            queue: {
              ...cfg.queue,
              autoStart: true,
              autoRecover: false,
              startPaused: true,
              exclusiveStart: true,
            },
          },
          client.auth,
        );
        const after = await control.read();
        if (
          !after ||
          after.protocol !== 1 ||
          !identifier(after.instanceId) ||
          !identifier(after.buildHash) ||
          typeof after.generation !== "number" ||
          !Number.isSafeInteger(after.generation) ||
          after.generation < 0 ||
          (before && after.instanceId === before.instanceId)
        )
          fail(
            "INSTANCE_CHANGED",
            "A new compatible broker instance/build identity was not observed",
          );
        if (after.phase === "RECOVERY_BLOCKED" || after.unresolved)
          fail(
            "RECONCILIATION_REQUIRED",
            "New broker remains recovery-blocked",
          );
        if (
          after.phase !== "PAUSED" ||
          after.gateClosed !== true ||
          after.activeOperations !== 0
        )
          fail("START_NOT_PAUSED", "New broker did not confirm paused startup");
        return { restarted: !!before, started: true, control: after };
      });
    },
  };
  return {
    ...services,
    start: () => services.restart({ requireStopped: true }),
    reload: () => services.restart({ action: "reload" }),
  };
}
