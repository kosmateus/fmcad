import fs from "node:fs";
import path from "node:path";
import type { ConsoleRow, ConsoleSnapshot, PresenceState } from "@fmcad/core";

interface SnapshotPolicy {
  base(mode: string, project: string, at: number): ConsoleSnapshot;
  contains(root: string, cwd: string, separator: string): boolean;
  presence(
    observedAt: number,
    now: number,
    alive: boolean | null,
  ): PresenceState;
}
export interface SnapshotOptions {
  dir: string;
  now: () => number;
  alive(record: Record<string, unknown>): boolean | null;
  readJson(file: string, limit?: number): unknown;
  operation(record: Record<string, unknown>): ConsoleRow;
  clients(project: string): {
    clients: ConsoleRow[];
    source: string;
    filesRead: number;
    filesOmitted: number;
    errors: number;
  };
}
type Data = Record<string, unknown>;
const record = (value: unknown): Data =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};

/** Bounded persisted observations only. No transport, SDK probe or admission dependency. */
export function createSnapshotReaders(policy: SnapshotPolicy) {
  function brokerSnapshot(
    project: string,
    options: SnapshotOptions,
  ): ConsoleSnapshot {
    const { dir, now, alive, readJson, operation } = options;
    const value = policy.base("broker", project, now());
    const file = path.join(dir, "queue-state.json");
    const saved = record(readJson(file, 128 * 1024 * 1024));
    let marker: Data | null;
    try {
      marker = record(readJson(path.join(dir, "broker.lock")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      marker = null;
    }
    if (
      saved["version"] !== 1 ||
      typeof saved["paused"] !== "boolean" ||
      !saved["jobs"] ||
      typeof saved["jobs"] !== "object" ||
      Array.isArray(saved["jobs"])
    )
      throw new Error("Unsupported broker telemetry snapshot");
    const online = marker ? alive(marker) : false;
    value.available = true;
    value.reason =
      online === true
        ? null
        : marker
          ? "Broker state is last known; process not confirmed"
          : "Broker stopped; showing retained project history";
    value["reasonCode"] = marker
      ? online === true
        ? null
        : "BROKER_UNCONFIRMED"
      : "BROKER_STOPPED";
    value["generation"] = marker?.["nonce"] || null;
    value["source"] = "broker-durable-snapshot";
    value["sequence"] = saved["revision"];
    value.observedAt = fs.statSync(file).mtimeMs;
    value.capabilities = { monitor: true, brokerControl: false };
    let broker: Data = {
      scope: "instance",
      online,
      paused: saved["paused"],
      active: saved["active"],
      unresolved: !!saved["blocked"],
      owner: marker,
      lastKnown: online !== true,
      state: !marker
        ? "STOPPED"
        : online !== true
          ? "UNKNOWN"
          : saved["paused"]
            ? "LEGACY_PAUSE"
            : "RUNNING",
    };
    try {
      const control = record(readJson(path.join(dir, "console-state.json")));
      if (
        marker &&
        control["instanceId"] === marker["nonce"] &&
        control["protocol"] === 1 &&
        control["generation"] === (saved["controlGeneration"] || 0) &&
        control["gateClosed"] === saved["paused"]
      ) {
        broker = {
          ...broker,
          ...control,
          state: online === true ? control["phase"] : "UNKNOWN",
        };
        value.capabilities.brokerControl = online === true;
      }
    } catch {
      /* Legacy brokers remain read-only. */
    }
    value["broker"] = broker;
    const canonicalProject = fs.realpathSync(project);
    value.operations = Object.values(saved["jobs"])
      .map(record)
      .filter((job) => {
        const cwd = record(job["request"])["cwd"];
        if (typeof cwd !== "string") return false;
        try {
          return policy.contains(
            canonicalProject,
            fs.realpathSync(cwd),
            path.sep,
          );
        } catch {
          return false;
        }
      })
      .map((job) => operation(job));
    const agents = new Map<string, ConsoleRow>();
    for (const job of value.operations)
      if (job.clientId)
        agents.set(job.clientId, {
          id: job.clientId,
          presence: "unknown",
          source: "job-history",
          lastSeen: null,
        });
    const presence = options.clients(project);
    for (const client of presence.clients)
      if (client.id) agents.set(client.id, client);
    value.agents = [...agents.values()];
    value["clientPresence"] = {
      source: presence.source,
      filesRead: presence.filesRead,
      filesOmitted: presence.filesOmitted,
      errors: presence.errors,
    };
    return value;
  }
  function directSnapshot(
    project: string,
    options: Omit<SnapshotOptions, "dir" | "clients">,
  ): ConsoleSnapshot {
    const { now, alive, readJson, operation } = options;
    const value = policy.base("direct", project, now());
    const dir = path.join(project, ".cad", "telemetry", "direct");
    let files: string[];
    try {
      files = fs
        .readdirSync(dir)
        .filter((file) => /^[a-f0-9-]+\.json$/.test(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      value.available = true;
      value.reason = "No direct telemetry";
      return value;
    }
    value.operations = [];
    value.agents = [];
    value.available = true;
    value["source"] = "direct-transport-snapshots";
    const sources: Data[] = [];
    value["sources"] = sources;
    value.capabilities = { monitor: true, brokerControl: false };
    value.reason = null;
    value.retention = {
      sessionsRead: Math.min(files.length, 256),
      sessionsTruncated: files.length > 256,
    };
    const recent = files
      .map((file) => ({
        file,
        time: fs.statSync(path.join(dir, file)).mtimeMs,
      }))
      .sort((a, b) => b.time - a.time || a.file.localeCompare(b.file))
      .slice(0, 256);
    for (const { file } of recent) {
      const session = record(readJson(path.join(dir, file)));
      if (
        session["version"] !== 1 ||
        session["project"] !== project ||
        !Array.isArray(session["operations"]) ||
        typeof session["id"] !== "string"
      )
        throw new Error("Invalid direct telemetry snapshot");
      const observedAt =
        typeof session["observedAt"] === "number" ? session["observedAt"] : NaN;
      const presence = policy.presence(observedAt, now(), alive(session));
      sources.push({
        generation: session["id"],
        sequence: session["sequence"],
        observedAt: session["observedAt"],
      });
      if (Number.isFinite(observedAt))
        value.observedAt =
          value.observedAt === null
            ? observedAt
            : Math.max(value.observedAt ?? observedAt, observedAt);
      value.agents.push({
        id: session["id"],
        sessionId: session["id"],
        presence,
        source: "direct-process-heartbeat",
        lastSeen:
          typeof session["observedAt"] === "number"
            ? session["observedAt"]
            : null,
      });
      value.operations.push(
        ...session["operations"].map((item) => {
          const op = record(item);
          return operation({
            ...op,
            state:
              op["state"] === "running" && presence !== "observed"
                ? "unknown"
                : op["state"],
          });
        }),
      );
    }
    if (!files.length) {
      value.agents = null;
      value.operations = null;
      value.reason = "No direct sessions observed";
    }
    return value;
  }
  return { brokerSnapshot, directSnapshot };
}
