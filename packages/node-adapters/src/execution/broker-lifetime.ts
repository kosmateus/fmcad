import { randomUUID } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import type { Stats } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { listenBrokerIpc } from "../broker-ipc/server";
import {
  durable,
  failure,
  readJson,
  syncDirectory,
} from "../persistence/records";

type Owner = Readonly<{
  pid: number;
  birth: string;
  nonce: string;
  protocol: 2;
}>;
type InstancePin = Readonly<{ pid: number; birth: string; version: string }>;
export interface BrokerStartup {
  binding: Readonly<{
    brokerNonce: string;
    ownerPid: number;
    ownerBirth: string;
    buildHash: string;
    stage: "startup";
    auditExpectedInstance?: InstancePin;
  }>;
  receipt: string;
  diagnosticPath: string;
}

/** A live read, not a second queue or session state machine. Blocked and
 * paused-work refuse drain. Physical and pending work can settle without
 * shutdown granting another turn or resuming the gate. */
export type BrokerDrainState =
  "blocked" | "paused-work" | "physical" | "pending" | "idle";
type Phase =
  | "claimed"
  | "starting"
  | "initialized"
  | "listening"
  | "ready"
  | "draining"
  | "closing"
  | "retained"
  | "closed"
  | "failed";

interface DrainPorts {
  inspectDrain(): BrokerDrainState;
  /** Retire only owned workers, and wait for their close and local cleanup. */
  retireWorkers(): Promise<void>;
  releaseLease(): void;
  /** Record the error without resolving UNKNOWN or releasing a hold. */
  onShutdownError(error: unknown): void;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function brokerError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function sameFile(file: string, original: Stats): boolean {
  try {
    const current = lstatSync(file);
    return current.dev === original.dev && current.ino === original.ino;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** A listener without our lock isn't ours to remove, even if its pathname is. */
async function removeStaleEndpoint(socket: string, assertOwner: () => void) {
  if (process.platform === "win32") return;
  let original;
  try {
    original = lstatSync(socket);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (!original.isSocket() && !original.isFile())
    failure("IPC_ENDPOINT_CHANGED", "Unexpected broker endpoint type");
  if (original.isSocket()) {
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(socket);
      probe.once("connect", () => {
        probe.unref();
        probe.setTimeout(1000, () => probe.destroy());
        probe.resume();
        probe.end();
        reject(
          brokerError("EADDRINUSE", "Broker endpoint is already listening"),
        );
      });
      probe.once("error", (error) =>
        errorCode(error) === "ECONNREFUSED" ? resolve() : reject(error),
      );
    });
  }
  assertOwner();
  if (!sameFile(socket, original))
    failure("IPC_ENDPOINT_CHANGED", "Broker endpoint changed during startup");
  unlinkSync(socket);
}

/** Owns the local broker process lifetime. Existing restart proofs and admission
 * policy are supplied by composition; this module neither reclaims nor replays. */
export function claimBrokerLifetime({
  dir,
  socket,
  buildHash,
  configHash,
  processBirth,
  claimAuthorizedOwner,
  disposeClient,
}: {
  dir: string;
  socket: string;
  buildHash: string;
  configHash: string;
  processBirth(): string;
  /** An existing fenced migration may publish this exact marker itself. */
  claimAuthorizedOwner?(owner: Owner): boolean;
  disposeClient(): void;
}) {
  const owner: Owner = Object.freeze({
    pid: process.pid,
    birth: processBirth(),
    nonce: randomUUID(),
    protocol: 2,
  });
  const lock = join(dir, "broker.lock");
  if (!claimAuthorizedOwner?.(owner)) durable(lock, owner, true);
  const lockFile = lstatSync(lock);
  function assertOwner() {
    if (!sameFile(lock, lockFile) || !isDeepStrictEqual(readJson(lock), owner))
      failure("LOCK_CHANGED", "Broker ownership marker changed");
  }
  assertOwner();

  const lifecycleFile = join(dir, `broker-lifecycle-${owner.nonce}.json`);
  const receipt = join(dir, `broker-startup-${owner.nonce}.receipt.json`);
  const diagnosticPath = join(dir, `broker-startup-${owner.nonce}.result.json`);
  let publishReady: (() => void) | undefined;
  let phase: Phase = "claimed";
  let runtime: Awaited<ReturnType<typeof listenBrokerIpc>> | undefined;
  let endpoint: Stats | undefined;
  let ports: DrainPorts | undefined;
  let timer: NodeJS.Timeout | undefined;
  let handlers = 0;
  let handlersDrained: (() => void) | undefined;
  let retirement: Promise<void> | undefined;
  let closing:
    | {
        task: Promise<void>;
        resolve(): void;
        reject(error: unknown): void;
      }
    | undefined;
  let drainScheduled = false;

  function releaseLock() {
    assertOwner();
    unlinkSync(lock);
    syncDirectory(dir);
  }

  async function initialize<T>(
    {
      recovery,
      auditExpectedInstance,
      startupQuiescent,
    }: {
      recovery: boolean;
      auditExpectedInstance?: InstancePin;
      startupQuiescent(): boolean;
    },
    identify: (startup: BrokerStartup) => T | Promise<T>,
  ): Promise<T> {
    if (phase !== "claimed")
      failure("BROKER_LIFETIME_STATE", "Broker startup may run only once");
    phase = "starting";
    const binding = Object.freeze({
      brokerNonce: owner.nonce,
      ownerPid: owner.pid,
      ownerBirth: owner.birth,
      buildHash,
      stage: "startup" as const,
      ...(auditExpectedInstance
        ? { auditExpectedInstance: Object.freeze({ ...auditExpectedInstance }) }
        : {}),
    });
    const lifecycle = { owner, buildHash, configHash, receipt, binding };
    try {
      assertOwner();
      durable(
        lifecycleFile,
        { ...lifecycle, stage: recovery ? "recovery" : "starting" },
        true,
      );
      const result = await identify({ binding, receipt, diagnosticPath });
      assertOwner();
      publishReady = () =>
        durable(lifecycleFile, { ...lifecycle, stage: "ready" });
      phase = "initialized";
      return result;
    } catch (error) {
      phase = "failed";
      const code = errorCode(error);
      const probeNotSubmitted =
        code === "NORMAL_RESTART_UNPROVEN" &&
        (error as { probeNotSubmitted?: boolean }).probeNotSubmitted === true;
      const knownRejection = [
        "CONFIG_CHANGED",
        "INSTANCE_CHANGED",
        "FUSION_BUSY",
      ].includes(code ?? "");
      try {
        if (probeNotSubmitted || (knownRejection && startupQuiescent())) {
          assertOwner();
          durable(lifecycleFile, {
            ...lifecycle,
            stage: "rejected",
            safeToRecover: !probeNotSubmitted || startupQuiescent(),
            code,
            ...(probeNotSubmitted
              ? { message: (error as Error).message, probeNotSubmitted }
              : {}),
          });
          if (!probeNotSubmitted) {
            disposeClient();
            releaseLock();
          }
        }
      } catch {
        // Preserve the original error; uncertain startup never releases an owner.
      }
      throw error;
    }
  }

  async function listen(
    options: DrainPorts & {
      dispatch(message: unknown): Promise<unknown>;
      observeReply?: Parameters<typeof listenBrokerIpc>[2];
      onTransportError(): void;
      poll(): void | Promise<void>;
      pollMs: number;
    },
  ) {
    if (phase !== "initialized" || !publishReady)
      failure("BROKER_LIFETIME_STATE", "Broker identity must precede listen");
    phase = "listening";
    try {
      assertOwner();
      await removeStaleEndpoint(socket, assertOwner);
      assertOwner();
      runtime = await listenBrokerIpc(
        socket,
        async (message) => {
          if (phase !== "ready" && phase !== "draining" && phase !== "retained")
            failure(
              "BROKER_UNAVAILABLE",
              "Broker cannot admit IPC in this phase",
            );
          handlers++;
          try {
            return await options.dispatch(message);
          } finally {
            handlers--;
            if (handlers === 0) handlersDrained?.();
            progress();
          }
        },
        options.observeReply,
      );
      if (process.platform !== "win32") endpoint = lstatSync(socket);
      assertOwner();
      publishReady();
      ports = options;
      phase = "ready";
      runtime.onError(() => {
        options.onTransportError();
        progress();
      });
      timer = setInterval(options.poll, options.pollMs);
    } catch (error) {
      phase = "failed";
      // Transport cleanup is not broker close. Do not unlink another endpoint.
      try {
        if (
          runtime &&
          (process.platform === "win32" ||
            (endpoint && sameFile(socket, endpoint)))
        )
          runtime.stopListening();
      } catch {
        // Keep the original listen failure.
      }
      try {
        disposeClient();
      } catch {
        // Neither cleanup failure authorizes releasing the lock.
      }
      throw error;
    }
  }

  /** IPC stop may begin draining a live turn; direct close only accepts idle
   * or local pending work. Neither may release physical or unknown work. */
  function beginClose(drainPhysical: boolean): Promise<void> {
    if (phase === "closed") return Promise.resolve();
    if (closing) return closing.task;
    if ((phase !== "ready" && phase !== "retained") || !ports)
      throw brokerError("BROKER_UNAVAILABLE", "Broker is not ready");
    const status = ports.inspectDrain();
    if (status === "blocked") throw blocked();
    if (status === "paused-work") throw pausedWork();
    if (status === "physical" && !drainPhysical)
      throw brokerError(
        "BROKER_BUSY",
        "An admitted physical operation is still active",
      );
    phase = "draining";
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const task = new Promise<void>((onClosed, onError) => {
      resolve = onClosed;
      reject = onError;
    });
    closing = { task, resolve, reject };
    progress();
    return task;
  }

  async function close(): Promise<void> {
    return beginClose(false);
  }

  function blocked() {
    return brokerError(
      "RECONCILIATION_REQUIRED",
      "Cannot release broker ownership with unknown or blocked work",
    );
  }

  function pausedWork() {
    return brokerError(
      "BROKER_BUSY",
      "Cannot drain an unfinished turn that requires explicit resume",
    );
  }

  function progress() {
    if (phase !== "draining" || drainScheduled) return;
    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      void drain();
    });
  }

  async function drain() {
    if (phase !== "draining" || !closing || !ports || !runtime) return;
    const attempt = closing;
    const drainPorts = ports;
    const refuse = (error: unknown) => {
      // Retirement cannot be undone. Leave control/recovery IPC online, but
      // keep the admission fence closed and do not start another scheduler.
      phase = retirement ? "retained" : "ready";
      closing = undefined;
      attempt.reject(error);
    };
    let refusal: Error | undefined;
    const assertIdle = () => {
      const status = drainPorts.inspectDrain();
      if (status === "blocked") throw (refusal = blocked());
      if (status === "paused-work") throw (refusal = pausedWork());
      if (status !== "idle")
        throw (refusal = brokerError(
          "BROKER_BUSY",
          "Broker work changed during shutdown",
        ));
    };
    let transportClosing = false;
    try {
      const status = ports.inspectDrain();
      if (status === "blocked" || status === "paused-work") {
        refuse(status === "blocked" ? blocked() : pausedWork());
        return;
      }
      if (status !== "idle") return;
      assertOwner();
      phase = "closing";
      clearInterval(timer);
      // Share even a rejected retirement attempt; never replay uncertain cleanup.
      retirement ??= Promise.resolve().then(() => drainPorts.retireWorkers());
      await retirement;
      assertIdle();
      // An already admitted worker reply may depend on retireWorkers rejecting
      // its ungranted turn. Wait for its dispatcher after retiring workers;
      // transport owns flushing the actual response.
      if (handlers)
        await new Promise<void>((resolve) => (handlersDrained = resolve));
      assertIdle();
      assertOwner();
      ports.releaseLease();
      assertIdle();
      if (endpoint && !sameFile(socket, endpoint))
        failure(
          "IPC_ENDPOINT_CHANGED",
          "Broker endpoint changed during shutdown",
        );
      transportClosing = true;
      await runtime.close();
      assertIdle();
      disposeClient();
      releaseLock();
      phase = "closed";
      attempt.resolve();
    } catch (error) {
      if (transportClosing || error !== refusal) {
        try {
          ports.onShutdownError(error);
        } catch {
          // Reporting cannot replace the shutdown failure.
        }
      }
      if (!transportClosing && retirement) {
        try {
          assertOwner();
          if (!endpoint || sameFile(socket, endpoint)) {
            refuse(error);
            return;
          }
        } catch {
          // An uncertain owner cannot keep serving requests.
        }
      }
      phase = "failed";
      clearInterval(timer);
      attempt.reject(error);
    }
  }

  return {
    owner,
    lock,
    initialize,
    listen,
    close,
    requestStop: () => beginClose(true),
    progress,
    get closed() {
      return phase === "closed";
    },
    /** Admission stays fenced after retirement, even with control IPC online. */
    get stopping() {
      return (
        phase === "draining" ||
        phase === "closing" ||
        phase === "retained" ||
        phase === "closed" ||
        (phase === "failed" && closing !== undefined)
      );
    },
  };
}
