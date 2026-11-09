import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import { withProjectActivitiesFence } from "../persistence/project-history/activity";
import os from "node:os";
import path from "node:path";
import { currentProcessIdentity } from "./client-presence";

interface OpenCodeSession {
  readonly id: string;
  readonly clientId?: string;
  readonly agent?: string;
  readonly title?: string;
  readonly project?: string;
  readonly projectDirectory?: string;
  readonly lastTool?: string;
  readonly status: string;
  readonly lastActivityAt: number;
}

export interface OpenCodePresenceReporter {
  readonly file: string;
  readonly instanceId: string;
  readonly touch: (sessionId: string, data?: Record<string, unknown>) => void;
  readonly event: (event: unknown) => void;
  readonly close: () => Promise<void>;
}

export function defaultOpenCodePresenceDirectory(): string {
  return path.join(
    process.env["XDG_STATE_HOME"] || path.join(os.homedir(), ".local", "state"),
    "fmcad",
    "diagnostic-presence",
  );
}

export function createOpenCodePresence(
  project: string,
  directory = defaultOpenCodePresenceDirectory(),
  now: () => number = Date.now,
): OpenCodePresenceReporter | null {
  const owner = currentProcessIdentity(process.pid);
  if (!owner) return null;
  const ownerPid = owner.pid;
  const ownerBirth = owner.birth;
  const instanceId = randomUUID();
  const file = path.join(directory, `${ownerPid}-${instanceId}.json`);
  const sessions = new Map<string, OpenCodeSession>();
  const sessionProjects = new Map<string, string>();
  let writing = false;
  let closed = false;
  let scheduled: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;

  async function flush(): Promise<void> {
    if (closed || writing || !sessions.size) return;
    writing = true;
    const temp = `${file}.${randomUUID()}.tmp`;
    const snapshot = {
      schemaVersion: 1,
      nonce: instanceId,
      instanceId,
      pid: ownerPid,
      birth: ownerBirth,
      updatedAt: now(),
      sessions: [...sessions.values()],
    };
    inFlight = (async () => {
      try {
        await privateDirectory(directory);
        if (!closed)
          withProjectActivitiesFence(
            snapshot.sessions.map((session) => session.projectDirectory ?? ""),
            (proofs) => {
              syncFs.writeFileSync(
                temp,
                JSON.stringify({
                  ...snapshot,
                  ...(proofs.length ? { activityFences: proofs } : {}),
                }),
                { flag: "wx", mode: 0o600 },
              );
              syncFs.renameSync(temp, file);
            },
          );
      } catch {
        await fs.unlink(temp).catch(() => {});
      } finally {
        writing = false;
        inFlight = undefined;
      }
    })();
    await inFlight;
  }

  function touch(sessionId: string, data: Record<string, unknown> = {}): void {
    if (closed || typeof sessionId !== "string" || !sessionId) return;
    const key = createHash("sha256")
      .update(sessionId)
      .digest("hex")
      .slice(0, 24);
    const old = sessions.get(key) ?? {
      id: key,
      project: safeText(project),
      status: "unknown",
      lastActivityAt: now(),
    };
    const agent =
      typeof data["agent"] === "string" && data["agent"]
        ? safeText(data["agent"])
        : old.agent;
    const session: OpenCodeSession = {
      ...old,
      id: key,
      ...(agent ? { agent } : {}),
      lastActivityAt: now(),
    };
    for (const field of ["title", "project", "lastTool", "status"] as const) {
      const value = data[field];
      if (typeof value === "string")
        Object.assign(session, { [field]: safeText(value) });
    }
    if (agent)
      Object.assign(session, {
        clientId:
          "opencode:" +
          createHash("sha256")
            .update(`${sessionId}:${agent}`)
            .digest("hex")
            .slice(0, 40),
      });
    const rawProject =
      typeof data["project"] === "string"
        ? data["project"]
        : (sessionProjects.get(key) ?? project);
    let projectDirectory = rawProject;
    try {
      projectDirectory = syncFs.realpathSync(rawProject);
    } catch {
      /* Unavailable paths remain explicitly unqualified to readers. */
    }
    sessions.set(key, { ...session, projectDirectory });
    sessionProjects.set(key, projectDirectory);
    if (sessions.size > 200) {
      const oldest = sessions.keys().next().value!;
      sessions.delete(oldest);
      sessionProjects.delete(oldest);
    }
    if (!scheduled) {
      scheduled = setTimeout(() => {
        scheduled = undefined;
        void flush();
      }, 100);
      scheduled.unref();
    }
  }

  function event(value: unknown): void {
    const eventRecord = asRecord(value);
    const properties = asRecord(eventRecord?.["properties"]);
    const info = asRecord(properties?.["info"]);
    const type = eventRecord?.["type"];
    if (
      (type === "session.created" ||
        type === "session.updated" ||
        type === "session.deleted") &&
      typeof info?.["id"] === "string"
    ) {
      touch(info["id"], {
        ...(typeof info["title"] === "string" ? { title: info["title"] } : {}),
        ...(typeof info["directory"] === "string"
          ? { project: info["directory"] }
          : { project }),
        ...(type === "session.deleted" ? { status: "ended" } : {}),
      });
    } else if (
      type === "session.status" &&
      typeof properties?.["sessionID"] === "string"
    ) {
      const status = asRecord(properties["status"])?.["type"];
      touch(properties["sessionID"], {
        status: typeof status === "string" ? status : "unknown",
      });
    } else if (
      type === "session.idle" &&
      typeof properties?.["sessionID"] === "string"
    ) {
      touch(properties["sessionID"], { status: "idle" });
    }
  }

  const timer = setInterval(() => {
    void flush();
  }, 10_000);
  timer.unref();
  async function close(): Promise<void> {
    if (!closed) {
      closed = true;
      clearInterval(timer);
      if (scheduled) clearTimeout(scheduled);
      scheduled = undefined;
    }
    await inFlight;
    await fs.unlink(file).catch(() => {});
  }
  return { file, instanceId, touch, event, close };
}

function safeText(value: string): string {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, 250);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function privateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw Object.assign(new Error("Unsafe presence directory"), {
      code: "UNSAFE_DIRECTORY",
    });
  }
  await fs.chmod(directory, 0o700);
}
