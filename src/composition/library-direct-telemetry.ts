import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { EventSink, InvocationContext } from "@fmcad/core";
const load = createRequire(__filename);
const core = load("../core") as typeof import("@fmcad/core");
const { resolveProject } = load("../../console-project") as {
  resolveProject(options: { cwd: string }): string | null;
};
const { durable, processBirth } = load("../../queue-instance") as {
  durable(file: string, value: unknown): void;
  processBirth(): string | null;
};
const { createProjectPresencePort } = load(
  "../node-adapters/telemetry/client-presence",
) as typeof import("../../packages/node-adapters/src/telemetry/client-presence");
export interface TelemetryOptions {
  cwd?: string;
  now?: () => number;
  intervalMs?: number;
  invocation?: InvocationContext;
  events?: EventSink;
}
export interface TelemetryCall {
  requestId?: string | null;
  sessionId?: string | null;
  purpose?: string | null;
  metadata?: {
    label?: string;
    document?: string;
    sourcePath?: string;
    sourceHash?: string;
  };
}
interface DirectOperation extends Omit<
  InvocationContext,
  "version" | "purpose"
> {
  id: InvocationContext["requestId"];
  state: "running" | "completed" | "unknown";
  label: string;
  description?: string;
  document?: string;
  sourcePath?: string;
  sourceHash?: string;
  startedAt: number;
  finishedAt?: number;
  outcomeScope: "transport";
  httpStatus?: number | undefined;
}
interface DirectSnapshot {
  version: 1;
  id: string;
  instanceId: string;
  pid: number;
  birth: string | null;
  project: string;
  source: "direct-transport";
  observedAt: number;
  sequence: number;
  operations: DirectOperation[];
}
// Transport observations only: never persist RPC arguments, output or credentials.
export function createTelemetry({
  cwd = process.cwd(),
  now = Date.now,
  intervalMs = 5000,
  invocation: suppliedInvocation,
  events: suppliedEvents,
}: TelemetryOptions = {}) {
  const root = resolveProject({ cwd }) || fs.realpathSync(cwd);
  const dir = path.join(root, ".cad", "telemetry", "direct");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const instanceId = suppliedInvocation?.instanceId || randomUUID();
  let birth: string | null = null;
  try {
    birth = processBirth();
  } catch {
    /* Unsupported host: presence remains unknown. */
  }
  const file = path.join(
    dir,
    createHash("sha256").update(instanceId).digest("hex") + ".json",
  );
  const baseInvocation =
    suppliedInvocation ||
    core.createInvocationContext({ instanceId, source: "mcp" });
  const observedAt = () => {
    try {
      const value = now();
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  };
  const snapshot: DirectSnapshot = {
    version: 1,
    id: instanceId,
    instanceId,
    pid: process.pid,
    birth,
    project: root,
    source: "direct-transport",
    observedAt: observedAt(),
    sequence: 0,
    operations: [],
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let eventSink: EventSink;
  try {
    eventSink =
      suppliedEvents ||
      (
        load("../../opencode/project-logger.cjs") as {
          createEventSink(root: string): EventSink;
        }
      ).createEventSink(root);
  } catch {
    eventSink = { async publish() {}, dispose() {} };
  }
  const publisher = core.createObservationPublisher(eventSink, { nowMs: now });
  const observationScope = core.createObservationScope({
    invocation: baseInvocation,
    events: eventSink,
    presence: createProjectPresencePort(root, core),
    clock: { nowMs: now },
  });
  void observationScope.heartbeat();

  const unsettled = (item: DirectOperation) =>
    ["running", "unknown"].includes(item.state);
  const retain = () => {
    const active = snapshot.operations.filter(unsettled);
    snapshot.operations = [
      ...active.slice(-256),
      ...snapshot.operations.filter((item) => !unsettled(item)).slice(-500),
    ];
  };
  const publish = () => {
    if (disposed) return;
    try {
      snapshot.observedAt = observedAt();
      snapshot.sequence++;
      durable(file, snapshot);
    } catch {
      /* Telemetry failure cannot change an execution result or encourage replay. */
    }
  };
  async function track<T extends { status?: number }>(
    payload: { method: string },
    send: () => Promise<T>,
    call: TelemetryCall = {},
  ): Promise<T> {
    if (disposed) return send();
    let callInvocation: InvocationContext;
    try {
      callInvocation = core.createInvocationContext({
        ...baseInvocation,
        requestId: call.requestId || randomUUID(),
        sessionId: call.sessionId ?? baseInvocation.sessionId,
        purpose: call.purpose ?? baseInvocation.purpose,
      });
    } catch {
      callInvocation = core.createInvocationContext({
        ...baseInvocation,
        requestId: randomUUID(),
      });
    }
    const operation: DirectOperation = {
      id: callInvocation.requestId,
      requestId: callInvocation.requestId,
      clientId: callInvocation.clientId,
      jobId: callInvocation.jobId,
      projectId: callInvocation.projectId,
      documentId: callInvocation.documentId,
      sessionId: callInvocation.sessionId,
      turnId: callInvocation.turnId,
      instanceId: callInvocation.instanceId,
      source: callInvocation.source,
      state: "running",
      label: [
        "initialize",
        "notifications/initialized",
        "ping",
        "tools/list",
        "tools/call",
      ].includes(payload.method)
        ? payload.method
        : "rpc",
      ...(callInvocation.purpose
        ? { description: callInvocation.purpose }
        : {}),
      startedAt: observedAt(),
      outcomeScope: "transport",
    };
    const metadata = call.metadata || {};
    for (const key of [
      "label",
      "document",
      "sourcePath",
      "sourceHash",
    ] as const) {
      if (typeof metadata[key] === "string" && metadata[key])
        operation[key] = metadata[key];
    }
    if (metadata.label) operation.label = metadata.label;
    snapshot.operations.push(operation);
    retain();
    publish();
    void publisher.publish(callInvocation, "transport.started", {
      method: operation.label,
    });
    if (!timer) {
      timer = setInterval(publish, intervalMs);
      timer.unref();
    }
    try {
      const result = await send();
      operation.state = "completed";
      operation.httpStatus = result.status;
      void publisher.publish(callInvocation, "transport.completed", {
        status: "completed",
        method: operation.label,
      });
      return result;
    } catch (error) {
      operation.state = "unknown"; // A transport error cannot prove remote termination.
      void publisher.publish(callInvocation, "transport.unknown", {
        status: "unknown",
        method: operation.label,
      });
      throw error;
    } finally {
      operation.finishedAt = observedAt();
      retain();
      publish();
      if (!snapshot.operations.some((item) => item.state === "running")) {
        if (timer) clearInterval(timer);
        timer = null;
      }
    }
  }
  async function dispose() {
    if (disposed) return;
    disposed = true;
    if (exitHandler) process.removeListener("exit", exitHandler);
    if (timer) clearInterval(timer);
    timer = null;
    await observationScope.dispose();
  }
  const exitHandler = () => {
    void dispose();
  };
  process.once("exit", exitHandler);
  return { track, file, instanceId, dispose };
}
