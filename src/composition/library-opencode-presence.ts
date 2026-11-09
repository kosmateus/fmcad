import { createEventSink } from "./library-project-events";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  createInvocationContext,
  createObservationPublisher,
} from "@fmcad/core";
import type { EventSink } from "../../packages/core/src/ports/event-sink";
import type { OpenCodePresenceReporter } from "../../packages/node-adapters/src/telemetry/opencode-presence";
const hostRequire = createRequire(__filename);
const { createOpenCodePresence, defaultOpenCodePresenceDirectory } =
  hostRequire(
    "../node-adapters/telemetry/opencode-presence",
  ) as typeof import("../../packages/node-adapters/src/telemetry/opencode-presence");
type Data = Record<string, unknown>;
interface SessionInfo {
  id?: unknown;
  title?: unknown;
  directory?: unknown;
  turnID?: unknown;
  turnId?: unknown;
  documentID?: unknown;
  documentId?: unknown;
}
interface HostEvent {
  type?: string;
  properties?: {
    info?: SessionInfo;
    turnID?: unknown;
    turnId?: unknown;
    requestID?: unknown;
    requestId?: unknown;
    jobID?: unknown;
    jobId?: unknown;
    documentID?: unknown;
    documentId?: unknown;
    sessionID?: unknown;
    status?: { type?: unknown };
  };
}
interface HookEvent {
  sessionID?: unknown;
  agent?: unknown;
  tool?: unknown;
  turnID?: unknown;
  turnId?: unknown;
  requestID?: unknown;
  requestId?: unknown;
  jobID?: unknown;
  jobId?: unknown;
  documentID?: unknown;
  documentId?: unknown;
}
export interface PresenceV1Host {
  directory: string;
  client: {
    session: {
      get(input: { path: { id: string } }): Promise<{ data?: SessionInfo }>;
    };
  };
}
export interface PresenceV2Host {
  location: { directory: string };
  session: {
    get(input: { sessionID: string }): Promise<SessionInfo | undefined>;
    hook(name: string, callback: (event: HookEvent) => void): Promise<unknown>;
  };
  tool: {
    hook(name: string, callback: (event: HookEvent) => void): Promise<unknown>;
  };
  event: { subscribe(input: { signal: AbortSignal }): AsyncIterable<unknown> };
}
const text = (value: unknown) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 250);
const hash = (value: unknown) =>
  createHash("sha256").update(String(value)).digest("hex");

export function createReporter(
  project: string,
  directory = defaultOpenCodePresenceDirectory(),
  eventsOverride?: EventSink,
): OpenCodePresenceReporter | null {
  const candidate = createOpenCodePresence(project, directory);
  if (!candidate) return null;
  const reporter = candidate;
  let events = eventsOverride;
  try {
    events ||= createEventSink(project);
  } catch {
    events = { async publish() {}, dispose() {} };
  }
  const publisher = createObservationPublisher(events, { nowMs: Date.now });

  function publish(sessionID: unknown, name: string, data: Data = {}) {
    if (typeof sessionID !== "string" || !sessionID) return;
    const agent =
      typeof data["agent"] === "string" && data["agent"]
        ? text(data["agent"])
        : null;
    const invocation = createInvocationContext({
      clientId: agent
        ? "opencode:" + hash(sessionID + ":" + agent).slice(0, 40)
        : null,
      requestId:
        typeof data["requestId"] === "string" ? data["requestId"] : null,
      jobId: typeof data["jobId"] === "string" ? data["jobId"] : null,
      projectId: "project:" + hash(project).slice(0, 40),
      documentId:
        typeof data["documentId"] === "string" ? data["documentId"] : null,
      sessionId: "opencode-session:" + hash(sessionID).slice(0, 40),
      turnId: typeof data["turnId"] === "string" ? data["turnId"] : null,
      instanceId: reporter.instanceId,
      source: "opencode",
    });
    const safe: Record<string, string> = {};
    if (typeof data["status"] === "string")
      safe["status"] = text(data["status"]);
    if (typeof data["method"] === "string")
      safe["method"] = text(data["method"]);
    for (const field of ["requestId", "jobId", "documentId", "turnId"]) {
      if (typeof data[field] === "string") safe[field] = data[field];
    }
    void publisher.publish(invocation, "opencode." + name, safe);
  }

  function touch(sessionID: string, data: Data = {}) {
    try {
      reporter.touch(sessionID, data);
      const observation: Data = {
        agent: data["agent"],
        status: typeof data["status"] === "string" ? data["status"] : "active",
      };
      for (const field of ["requestId", "jobId", "documentId", "turnId"]) {
        if (typeof data[field] === "string") observation[field] = data[field];
      }
      publish(sessionID, "session.activity", observation);
    } catch {
      /* Presence is best-effort and cannot fail a host hook. */
    }
  }

  function event(input: unknown) {
    try {
      const value = input as HostEvent | null | undefined;
      reporter.event(value);
      const properties = value?.properties || {};
      const info = properties.info;
      const turnId =
        properties.turnID || properties.turnId || info?.turnID || info?.turnId;
      if (
        ["session.created", "session.updated", "session.deleted"].includes(
          value?.type ?? "",
        ) &&
        info?.id
      ) {
        publish(info.id, "session." + value!.type!.slice("session.".length), {
          status: value!.type!.slice("session.".length),
          ...(typeof turnId === "string" ? { turnId } : {}),
          ...(typeof (info?.documentID || info?.documentId) === "string"
            ? { documentId: info.documentID || info.documentId }
            : {}),
          ...(typeof (properties.requestID || properties.requestId) === "string"
            ? { requestId: properties.requestID || properties.requestId }
            : {}),
          ...(typeof (properties.jobID || properties.jobId) === "string"
            ? { jobId: properties.jobID || properties.jobId }
            : {}),
        });
      } else if (value?.type === "session.status" && properties.sessionID) {
        publish(properties.sessionID, "session.status", {
          status: properties.status?.type || "unknown",
          ...(typeof turnId === "string" ? { turnId } : {}),
          ...(typeof (properties.documentID || properties.documentId) ===
          "string"
            ? { documentId: properties.documentID || properties.documentId }
            : {}),
          ...(typeof (properties.requestID || properties.requestId) === "string"
            ? { requestId: properties.requestID || properties.requestId }
            : {}),
          ...(typeof (properties.jobID || properties.jobId) === "string"
            ? { jobId: properties.jobID || properties.jobId }
            : {}),
        });
      } else if (value?.type === "session.idle" && properties.sessionID) {
        publish(properties.sessionID, "session.idle", {
          status: "idle",
          ...(typeof turnId === "string" ? { turnId } : {}),
        });
      }
    } catch {
      /* Host event payloads are passive observations only. */
    }
  }

  return {
    file: reporter.file,
    instanceId: reporter.instanceId,
    touch,
    event,
    async close() {
      try {
        await reporter.close();
      } catch {
        /* Best-effort cleanup. */
      }
      try {
        await events.dispose?.();
      } catch {
        /* Event sink cleanup is independent. */
      }
    },
  };
}

function createTouch(
  reporter: OpenCodePresenceReporter,
  directory: string,
  getSession?: (sessionId: string) => Promise<SessionInfo | undefined>,
) {
  const titles = new Set<string>();
  return (sessionID: unknown, values: Data = {}) => {
    if (typeof sessionID !== "string" || !sessionID) return;
    try {
      reporter.touch(sessionID, values);
      if (!getSession || titles.has(sessionID)) return;
      titles.add(sessionID);
      if (titles.size > 512) titles.delete(titles.values().next().value!);
      void getSession(sessionID)
        .then((session) => {
          if (session)
            reporter.touch(sessionID, {
              title: session.title,
              project: session.directory || directory,
            });
        })
        .catch(() => {});
    } catch {
      /* Diagnostics must never fail a tool or model request. */
    }
  };
}

export async function setupV1(input: PresenceV1Host) {
  let reporter;
  try {
    reporter = createReporter(input.directory);
  } catch {
    return {};
  }
  if (!reporter) return {};
  const touch = createTouch(reporter, input.directory, async (sessionID) => {
    const result = await input.client.session.get({ path: { id: sessionID } });
    return result.data;
  });
  return {
    event: async ({ event }: { event: unknown }) => reporter.event(event),
    "chat.message": (event: HookEvent) =>
      touch(event.sessionID, {
        agent: event.agent,
        turnId: event.turnID || event.turnId,
        requestId: event.requestID || event.requestId,
        jobId: event.jobID || event.jobId,
        documentId: event.documentID || event.documentId,
      }),
    "chat.params": (event: HookEvent) =>
      touch(event.sessionID, {
        agent: event.agent,
        turnId: event.turnID || event.turnId,
        requestId: event.requestID || event.requestId,
        jobId: event.jobID || event.jobId,
        documentId: event.documentID || event.documentId,
      }),
    "tool.execute.before": (event: HookEvent) =>
      touch(event.sessionID, {
        lastTool: event.tool,
        turnId: event.turnID || event.turnId,
        requestId: event.requestID || event.requestId,
        jobId: event.jobID || event.jobId,
        documentId: event.documentID || event.documentId,
      }),
    dispose: async () => reporter.close(),
  };
}

export async function setupV2(ctx: PresenceV2Host) {
  let reporter;
  try {
    reporter = createReporter(ctx.location.directory);
  } catch {
    return async () => {};
  }
  if (!reporter) return async () => {};
  const touch = createTouch(
    reporter,
    ctx.location.directory,
    async (sessionID) => ctx.session.get({ sessionID }),
  );
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
      }))
        reporter.event(event);
    } catch {
      /* Diagnostics are best-effort. */
    }
  })();
  try {
    await ctx.session.hook("prompt", (event) =>
      touch(event.sessionID, {
        agent: event.agent,
        turnId: event.turnID || event.turnId,
        requestId: event.requestID || event.requestId,
        jobId: event.jobID || event.jobId,
        documentId: event.documentID || event.documentId,
      }),
    );
  } catch {}
  try {
    await ctx.session.hook("context", (event) =>
      touch(event.sessionID, {
        agent: event.agent,
        turnId: event.turnID || event.turnId,
        requestId: event.requestID || event.requestId,
        jobId: event.jobID || event.jobId,
        documentId: event.documentID || event.documentId,
      }),
    );
  } catch {}
  try {
    await ctx.tool.hook("execute.before", (event) =>
      touch(event.sessionID, {
        lastTool: event.tool,
        turnId: event.turnID || event.turnId,
        requestId: event.requestID || event.requestId,
        jobId: event.jobID || event.jobId,
        documentId: event.documentID || event.documentId,
      }),
    );
  } catch {}
  return async () => {
    controller.abort();
    await reporter.close();
  };
}
