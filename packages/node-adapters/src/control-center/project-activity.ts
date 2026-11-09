import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  ProjectActionFreshContext,
  ProjectActionFreshPresence,
  ProjectActionFreshSource,
  ProjectActionFreshState,
  ProjectActionFreshTask,
  ProjectActionsOptions,
} from "@fmcad/control-center/server";
import type { ProjectRegistryStore } from "../../../core/src/ports/project-registry";
import { readBytes } from "../persistence/records";
import { clientProcessAlive } from "../telemetry/client-presence";
import { defaultOpenCodePresenceDirectory } from "../telemetry/opencode-presence";

type Data = Record<string, unknown>;
const terminal = new Set([
  "success",
  "succeeded",
  "failed",
  "unsuccessful",
  "cancelled",
  "canceled",
  "expired",
  "completed",
  "rejected",
]);
function record(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid project activity record");
  return value as Data;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096)
    throw new Error("Invalid activity identity");
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error("Invalid activity revision");
  return Number(value);
}
function json(file: string, maxBytes = 256 * 1024): Data {
  return record(
    JSON.parse(readBytes(file, maxBytes, fs, file).toString("utf8")),
  );
}
function files(directory: string, limit: number): readonly string[] {
  try {
    // Check every component before resolving: a broken directory symlink is
    // unavailable evidence, not an empty presence directory.
    let component = path.parse(directory).root;
    for (const part of directory.slice(component.length).split(path.sep)) {
      component = path.join(component, part);
      const stat = fs.lstatSync(component);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Activity directory is not canonical");
    }
    if (fs.realpathSync(directory) !== directory)
      throw new Error("Activity directory is not canonical");
    const names = fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort();
    if (names.length > limit)
      throw new Error("Activity observation is incomplete");
    return names.map((name) => path.join(directory, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
function alive(value: Data): boolean | null {
  if (
    !Number.isSafeInteger(value["pid"]) ||
    Number(value["pid"]) <= 0 ||
    typeof value["birth"] !== "string" ||
    !value["birth"]
  )
    return null;
  return clientProcessAlive({
    pid: Number(value["pid"]),
    birth: value["birth"],
  });
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}
function belongs(root: string, cwd: string): boolean {
  return cwd === root || cwd.startsWith(root + path.sep);
}
export interface ProjectActivityReaderOptions {
  readonly registry: ProjectRegistryStore;
  readonly queueDirectory: string;
  readonly openCodePresenceDirectory?: string;
  readonly projectRevision: ProjectActionsOptions["projectRevision"];
}

/**
 * Full passive observations while createProjectActions holds the project's
 * existing SQLite writer fence. Producers must use that same fence. This is a
 * current disk/process observation, not a heartbeat inferred from diagnostic at.
 */
export function createProjectActivityReader(
  options: ProjectActivityReaderOptions,
): ProjectActionsOptions["readFreshState"] {
  return (
    projectId,
    { snapshot, history }: ProjectActionFreshContext,
  ): ProjectActionFreshState => {
    const project = options.registry.lookup(projectId);
    if (
      !project ||
      project.databaseId !== snapshot.databaseId ||
      projectId !== snapshot.projectId ||
      history.databaseId !== snapshot.databaseId
    )
      throw new Error("Project activity scope changed");
    const root = fs.realpathSync(project.path);
    if (root !== project.path) throw new Error("Project root changed");
    const queueRoot = fs.realpathSync(options.queueDirectory);
    if (queueRoot !== path.resolve(options.queueDirectory))
      throw new Error("Queue directory changed");
    try {
      fs.lstatSync(path.join(queueRoot, "queue-state.pending.json"));
      throw new Error("Queue commit is unresolved");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const owner = json(path.join(queueRoot, "broker.lock"));
    const saved = json(
      path.join(queueRoot, "queue-state.json"),
      128 * 1024 * 1024,
    );
    const control = json(path.join(queueRoot, "console-state.json"));
    const capability = record(control["projectActivityFence"]);
    const controlOwner = record(control["owner"]);
    const nonce = text(owner["nonce"]);
    if (
      alive(owner) !== true ||
      controlOwner["pid"] !== owner["pid"] ||
      controlOwner["birth"] !== owner["birth"] ||
      controlOwner["nonce"] !== nonce ||
      control["instanceId"] !== nonce ||
      control["protocol"] !== 1 ||
      capability["version"] !== 1 ||
      capability["queueAdmission"] !== "project-history" ||
      capability["registryPath"] !== options.registry.readonlyPath ||
      saved["version"] !== 1 ||
      typeof saved["paused"] !== "boolean" ||
      control["generation"] !== (saved["controlGeneration"] ?? 0) ||
      control["gateClosed"] !== saved["paused"] ||
      typeof control["held"] !== "boolean" ||
      typeof control["unresolved"] !== "boolean" ||
      !Array.isArray(control["activeIds"]) ||
      integer(control["activeOperations"]) !== control["activeIds"].length
    )
      throw new Error("Live broker activity fence cannot be verified");
    const queueRevision = integer(saved["revision"]);
    const retained = history.readSnapshot();
    if (
      retained.projectId !== projectId ||
      retained.databaseId !== snapshot.databaseId ||
      retained.revision.epoch !== snapshot.revision.epoch ||
      retained.revision.revision !== snapshot.revision.revision
    )
      throw new Error("Retained activity changed");
    const tasks: ProjectActionFreshTask[] = retained.jobs.map((job) => ({
      projectId,
      id: job.jobId,
      state: job.state,
      phase: job.phase,
      mayHaveMutated: null,
    }));
    const queueJobs = Object.entries(record(saved["jobs"]));
    const openPhases: string[] = [];
    for (const [id, raw] of queueJobs) {
      const job = record(raw);
      if (job["id"] !== id) throw new Error("Queue job identity mismatch");
      const state = text(job["state"]);
      const request = record(job["request"]);
      const cwd = request["cwd"];
      let scoped = false;
      if (typeof cwd === "string" && path.isAbsolute(cwd)) {
        try {
          scoped = belongs(root, fs.realpathSync(cwd));
        } catch {
          if (!terminal.has(state))
            throw new Error("Active project scope unavailable");
        }
      } else if (!terminal.has(state))
        throw new Error("Active project scope unknown");
      // Unscoped activity and the instance gate remain conservative global guards.
      if (!terminal.has(state)) openPhases.push(state);
      if (scoped)
        tasks.push({
          projectId,
          id,
          state,
          phase: terminal.has(state) ? "terminal" : state,
          mayHaveMutated: null,
        });
    }
    const presence: ProjectActionFreshPresence[] = [];
    let managed = true;
    const proofMatches = (value: unknown): boolean => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
      const proof = value as Data;
      return (
        proof["version"] === 1 &&
        proof["projectId"] === projectId &&
        proof["databaseId"] === snapshot.databaseId &&
        proof["projectRoot"] === root
      );
    };
    const observe = (
      value: Data,
      id: string,
      fenced: boolean,
      closed: boolean,
    ): void => {
      const processState = alive(value);
      if (processState !== false && !fenced) managed = false;
      presence.push({
        projectId,
        id,
        presence:
          processState === false || (processState === true && fenced && closed)
            ? "history"
            : processState === true
              ? "active"
              : "unknown",
        // A dead identity / fenced closed writer cannot resume. A new writer
        // must acquire the project fence; old heartbeat age is not liveness.
        observedAtMs: null,
      });
    };
    const clients = files(
      path.join(root, ".cad", "telemetry", "clients"),
      4096,
    ).map((file) => json(file, 16384));
    for (const value of clients) {
      if (value["version"] !== 1 || value["project"] !== root)
        throw new Error("Client presence scope is unverified");
      observe(
        value,
        text(value["instanceId"]),
        proofMatches(value["activityFence"]),
        value["closed"] === true,
      );
    }
    const openCode = files(
      path.resolve(
        options.openCodePresenceDirectory ?? defaultOpenCodePresenceDirectory(),
      ),
      1024,
    ).map((file) => json(file));
    const registrations = options.registry.read().projects;
    for (const value of openCode) {
      if (value["schemaVersion"] !== 1 || !Array.isArray(value["sessions"]))
        throw new Error("OpenCode presence is incomplete");
      for (const raw of value["sessions"]) {
        const session = record(raw);
        const directory = text(
          session["projectDirectory"] ?? session["project"],
        );
        if (!path.isAbsolute(directory))
          throw new Error("OpenCode scope is unknown");
        let canonical: string;
        try {
          canonical = fs.realpathSync(directory);
        } catch {
          throw new Error("OpenCode scope cannot be verified");
        }
        const bound = registrations
          .filter((entry) => belongs(entry.path, canonical))
          .sort((a, b) => b.path.length - a.path.length)[0];
        if (bound?.projectId !== projectId) continue;
        const fenced =
          typeof session["projectDirectory"] === "string" &&
          Array.isArray(value["activityFences"]) &&
          value["activityFences"].some(proofMatches);
        // Ended UI sessions do not terminate the writer process. Live reporters
        // must still block archival because they can publish more activity.
        observe(value, text(session["id"]), fenced, false);
      }
    }
    const direct = files(
      path.join(root, ".cad", "telemetry", "direct"),
      4096,
    ).map((file) => json(file));
    for (const value of direct) {
      if (
        value["version"] !== 1 ||
        value["project"] !== root ||
        !Array.isArray(value["operations"])
      )
        throw new Error("Legacy direct activity is incomplete");
      observe(value, text(value["id"]), false, false);
      for (const raw of value["operations"]) {
        const operation = record(raw);
        tasks.push({
          projectId,
          id: text(operation["id"]),
          state: text(operation["state"]),
          phase: null,
          mayHaveMutated: null,
        });
      }
    }
    const source = (
      id: string,
      epoch: string,
      revision: number,
      complete = true,
    ): ProjectActionFreshSource => ({
      state: complete ? "available" : "partial",
      complete,
      sourceId: id,
      epoch,
      revision,
      observedAtMs: snapshot.capturedAtMs,
    });
    const unresolved =
      saved["blocked"] !== null ||
      saved["active"] !== null ||
      saved["lease"] !== null ||
      !!saved["localUnknown"] ||
      !!saved["controlBlocked"] ||
      control["held"] === true ||
      control["unresolved"] === true ||
      control["activeOperations"] !== 0;
    const phase = control["phase"];
    return {
      projectId,
      activityFence: {
        projectId,
        databaseId: snapshot.databaseId,
        queueAdmission: "project-history",
        presenceWriters: managed ? "project-history" : "unmanaged",
      },
      revision: options.projectRevision(snapshot),
      capturedAtMs: snapshot.capturedAtMs,
      sources: {
        tasks: source(
          "project-history-activity",
          snapshot.revision.epoch,
          snapshot.revision.revision,
          retained.availability !== "partial" &&
            retained.availability !== "unavailable" &&
            retained.sources.every((s) => !s.gaps.length && !s.gapsTruncated),
        ),
        queue: source("broker-activity", nonce, queueRevision),
        presence: source(
          "project-presence-activity",
          hash([clients, openCode, direct]),
          0,
        ),
      },
      queue: {
        state:
          phase === "RUNNING" && !unresolved && !openPhases.length
            ? "idle"
            : phase === "PAUSED"
              ? "paused"
              : typeof phase === "string"
                ? phase
                : null,
        unresolved,
        openPhases,
      },
      tasks,
      presence,
    };
  };
}
