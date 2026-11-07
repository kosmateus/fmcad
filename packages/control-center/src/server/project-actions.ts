import type {
  ConsoleQueryPrincipal,
  ConsoleRevision,
} from "../contracts/query.js";
import type {
  ProjectActionReason,
  ProjectActionRequest,
  ProjectActionResponse,
  AgentAliasIdentity,
} from "../web/agents-projects.js";
import type { ProjectHistorySnapshot } from "../../../core/src/domain/project-history.js";
import type { ProjectHistoryStore } from "../../../core/src/ports/project-history.js";
import type { ProjectRegistryEntry } from "../../../core/src/domain/project-registry.js";
import type { ProjectRegistryStore } from "../../../core/src/ports/project-registry.js";

const FRESHNESS_MS = 15_000;
const MAX_ALIAS_LENGTH = 128;
const TERMINAL_STATES = new Set([
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
const INACTIVE_PRESENCE = new Set([
  "offline",
  "disconnected",
  "history",
  "ended",
  "expired",
]);
const QUIET_QUEUES = new Set(["free", "idle", "empty", "paused", "stopped"]);
const OPEN_WORK = new Set([
  "queued",
  "pending",
  "active",
  "running",
  "preparing",
  "processing",
  "sending",
  "unresolved",
  "busy",
]);
const TERMINAL_PHASES = new Set([
  "terminal",
  "complete",
  "completed",
  "finished",
]);

export type ProjectActionSourceState =
  "available" | "partial" | "stale" | "unavailable" | "no-data" | "unknown";

export interface ProjectActionFreshSource {
  readonly state: ProjectActionSourceState;
  readonly complete: boolean;
  readonly sourceId: string | null;
  readonly epoch: string | null;
  readonly revision: number | null;
  readonly observedAtMs: number | null;
}

export interface ProjectActionFreshTask {
  readonly projectId: string;
  readonly id: string | null;
  readonly state: string | null;
  readonly phase: string | null;
  readonly mayHaveMutated: boolean | null;
}

export interface ProjectActionFreshPresence {
  readonly projectId: string;
  readonly id: string | null;
  readonly presence: string | null;
  readonly observedAtMs: number | null;
}

export interface ProjectActionActivityFence {
  readonly projectId: string;
  readonly databaseId: string;
  readonly queueAdmission: "project-history" | "unavailable";
  readonly presenceWriters: "project-history" | "unmanaged" | "unknown";
}

/**
 * Synchronous full-state observation used only to decide whether monitoring
 * may be disabled. It must be assembled from current queue and presence
 * observations, never from a caller's frozen snapshot or a history-only view.
 * `revision` is the current project Console Query revision checked against the
 * caller's expectedRevision. Queue/presence retain their own source cursors,
 * while the project-history writer fence spans fresh reads and the lifecycle
 * CAS.
 */
export interface ProjectActionFreshState {
  readonly projectId: string;
  readonly activityFence: ProjectActionActivityFence;
  readonly revision: ConsoleRevision;
  readonly capturedAtMs: number;
  readonly sources: {
    readonly tasks: ProjectActionFreshSource;
    readonly queue: ProjectActionFreshSource;
    readonly presence: ProjectActionFreshSource;
  };
  readonly queue: {
    readonly state: string | null;
    readonly unresolved: boolean | null;
    readonly openPhases: readonly (string | null)[] | null;
  };
  readonly tasks: readonly ProjectActionFreshTask[] | null;
  readonly presence: readonly ProjectActionFreshPresence[] | null;
}

export interface ProjectActionsOptions {
  readonly registry: ProjectRegistryStore;
  /** Must use openRegisteredProjectHistoryStore; missing databases stay missing. */
  readonly openHistory: (project: ProjectRegistryEntry) => ProjectHistoryStore;
  /** Passive synchronous read; it must not start, probe, or resume the broker. */
  readonly readFreshState: (projectId: string) => ProjectActionFreshState;
  readonly projectRevision: (
    snapshot: ProjectHistorySnapshot,
  ) => ConsoleRevision;
  /** Publish the changed retained snapshot to the existing query revision/read model. */
  readonly publishProjectChange: (snapshot: ProjectHistorySnapshot) => void;
  readonly authorizeProjectWrite: (
    principal: ConsoleQueryPrincipal,
    projectId: string,
  ) => boolean;
  readonly now?: () => number;
}

export interface ProjectActionsHandler {
  execute(
    principal: ConsoleQueryPrincipal,
    input: unknown,
  ): ProjectActionResponse;
}

export type ProjectActionsExecutor = ProjectActionsHandler["execute"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !/[\x00-\x1f\x7f]/u.test(value)
  );
}

function validRevision(value: unknown): value is ConsoleRevision {
  return (
    isRecord(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join(",") === "epoch,revision" &&
    typeof value["epoch"] === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(value["epoch"]) &&
    Number.isSafeInteger(value["revision"]) &&
    (value["revision"] as number) >= 0
  );
}

function validIdentity(value: unknown): value is AgentAliasIdentity {
  return (
    isRecord(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join(",") === "id,kind" &&
    validId(value["id"]) &&
    ["agent", "client", "session"].includes(String(value["kind"]))
  );
}

function sameRevision(left: ConsoleRevision, right: ConsoleRevision): boolean {
  return left.epoch === right.epoch && left.revision === right.revision;
}

function isRequest(value: unknown): value is ProjectActionRequest {
  if (
    !isRecord(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    value["version"] !== 1 ||
    !validId(value["projectId"]) ||
    !validRevision(value["expectedRevision"])
  )
    return false;
  const keys = Object.keys(value).sort().join(",");
  if (value["action"] === "set-alias")
    return (
      keys === "action,alias,expectedRevision,projectId,version" &&
      typeof value["alias"] === "string"
    );
  return value["action"] === "set-agent-alias"
    ? keys === "action,alias,expectedRevision,identity,projectId,version" &&
        typeof value["alias"] === "string" &&
        validIdentity(value["identity"])
    : value["action"] === "reset-agent-alias"
      ? keys === "action,expectedRevision,identity,projectId,version" &&
        validIdentity(value["identity"])
      : ["reset-alias", "archive", "restore"].includes(
          String(value["action"]),
        ) && keys === "action,expectedRevision,projectId,version";
}

function response(
  request: Pick<ProjectActionRequest, "projectId">,
  state: ProjectActionResponse["state"],
  code: string,
  input: Partial<
    Pick<
      ProjectActionResponse,
      | "revision"
      | "monitoring"
      | "archivedAtMs"
      | "alias"
      | "identity"
      | "reasons"
    >
  > = {},
): ProjectActionResponse {
  return {
    version: 1,
    state,
    code,
    projectId: request.projectId,
    revision: input.revision ?? null,
    monitoring: input.monitoring ?? null,
    archivedAtMs: input.archivedAtMs ?? null,
    alias: input.alias ?? null,
    ...(input.identity ? { identity: input.identity } : {}),
    reasons: input.reasons ?? [],
  };
}

function isFreshSource(
  source: ProjectActionFreshSource,
  nowMs: number,
): boolean {
  return (
    source.state === "available" &&
    source.complete === true &&
    validId(source.sourceId) &&
    validId(source.epoch) &&
    Number.isSafeInteger(source.revision) &&
    (source.revision as number) >= 0 &&
    typeof source.observedAtMs === "number" &&
    Number.isFinite(source.observedAtMs) &&
    source.observedAtMs <= nowMs &&
    nowMs - source.observedAtMs <= FRESHNESS_MS
  );
}

function isFreshState(value: unknown): value is ProjectActionFreshState {
  if (
    !isRecord(value) ||
    !validId(value["projectId"]) ||
    !isRecord(value["activityFence"]) ||
    !validRevision(value["revision"]) ||
    !Number.isFinite(value["capturedAtMs"]) ||
    !isRecord(value["sources"]) ||
    !isRecord(value["queue"]) ||
    !Array.isArray(value["tasks"]) ||
    !Array.isArray(value["presence"])
  )
    return false;
  const activityFence = value["activityFence"];
  if (
    !validId(activityFence["projectId"]) ||
    !validId(activityFence["databaseId"]) ||
    !["project-history", "unavailable"].includes(
      String(activityFence["queueAdmission"]),
    ) ||
    !["project-history", "unmanaged", "unknown"].includes(
      String(activityFence["presenceWriters"]),
    )
  )
    return false;
  for (const name of ["tasks", "queue", "presence"] as const) {
    const source = value["sources"][name];
    if (
      !isRecord(source) ||
      ![
        "available",
        "partial",
        "stale",
        "unavailable",
        "no-data",
        "unknown",
      ].includes(String(source["state"])) ||
      typeof source["complete"] !== "boolean" ||
      !(source["sourceId"] === null || validId(source["sourceId"])) ||
      !(source["epoch"] === null || validId(source["epoch"])) ||
      !(
        source["revision"] === null ||
        (Number.isSafeInteger(source["revision"]) &&
          (source["revision"] as number) >= 0)
      ) ||
      !(
        source["observedAtMs"] === null ||
        (typeof source["observedAtMs"] === "number" &&
          Number.isFinite(source["observedAtMs"]))
      )
    )
      return false;
  }
  if (
    !(
      value["queue"]["state"] === null ||
      typeof value["queue"]["state"] === "string"
    ) ||
    !(
      value["queue"]["unresolved"] === null ||
      typeof value["queue"]["unresolved"] === "boolean"
    ) ||
    !Array.isArray(value["queue"]["openPhases"]) ||
    value["queue"]["openPhases"].some(
      (phase) => phase !== null && typeof phase !== "string",
    )
  )
    return false;
  return (
    value["tasks"].every(
      (task) =>
        isRecord(task) &&
        validId(task["projectId"]) &&
        validId(task["id"]) &&
        (task["state"] === null || typeof task["state"] === "string") &&
        (task["phase"] === null || typeof task["phase"] === "string") &&
        (task["mayHaveMutated"] === null ||
          typeof task["mayHaveMutated"] === "boolean"),
    ) &&
    value["presence"].every(
      (presence) =>
        isRecord(presence) &&
        validId(presence["projectId"]) &&
        validId(presence["id"]) &&
        (presence["presence"] === null ||
          typeof presence["presence"] === "string") &&
        (presence["observedAtMs"] === null ||
          (typeof presence["observedAtMs"] === "number" &&
            Number.isFinite(presence["observedAtMs"]))),
    )
  );
}

function freshStateFingerprint(state: ProjectActionFreshState): string {
  return JSON.stringify({
    projectId: state.projectId,
    activityFence: state.activityFence,
    revision: state.revision,
    sources: state.sources,
    queue: state.queue,
    tasks: state.tasks,
    presence: state.presence,
  });
}

function hasProjectActivityFence(
  state: ProjectActionFreshState,
  projectId: string,
  databaseId: string,
): boolean {
  return (
    state.activityFence.projectId === projectId &&
    state.activityFence.databaseId === databaseId &&
    state.activityFence.queueAdmission === "project-history" &&
    state.activityFence.presenceWriters === "project-history"
  );
}

function safetyReasons(
  projectId: string,
  databaseId: string,
  expectedRevision: ConsoleRevision,
  state: ProjectActionFreshState,
  nowMs: number,
): readonly ProjectActionReason[] {
  const reasons: ProjectActionReason[] = [];
  const add = (key: ProjectActionReason["key"]): void => {
    if (!reasons.some((reason) => reason.key === key)) reasons.push({ key });
  };
  const staleObservation = (source: ProjectActionFreshSource): boolean =>
    source.state === "stale" ||
    (typeof source.observedAtMs === "number" &&
      Number.isFinite(source.observedAtMs) &&
      (source.observedAtMs > nowMs ||
        nowMs - source.observedAtMs > FRESHNESS_MS));
  if (
    state.projectId !== projectId ||
    state.activityFence.projectId !== projectId ||
    state.activityFence.databaseId !== databaseId ||
    state.activityFence.queueAdmission !== "project-history" ||
    state.activityFence.presenceWriters !== "project-history" ||
    !validRevision(state.revision) ||
    !Number.isFinite(state.capturedAtMs) ||
    state.capturedAtMs > nowMs ||
    nowMs - state.capturedAtMs > FRESHNESS_MS ||
    !sameRevision(state.revision, expectedRevision)
  )
    add("projects.archive.blocked.stale");
  if (
    state.sources &&
    [state.sources.tasks, state.sources.queue, state.sources.presence].some(
      staleObservation,
    )
  )
    add("projects.archive.blocked.stale");
  if (
    !isFreshSource(state.sources?.tasks, nowMs) ||
    !isFreshSource(state.sources?.queue, nowMs) ||
    !isFreshSource(state.sources?.presence, nowMs) ||
    !Array.isArray(state.tasks) ||
    !Array.isArray(state.presence) ||
    !state.queue ||
    !validQueueState(state.queue.state) ||
    state.queue.unresolved !== false ||
    !Array.isArray(state.queue.openPhases)
  )
    add("projects.archive.blocked.unknown");

  if (!QUIET_QUEUES.has(String(state.queue?.state).toLowerCase()))
    add("projects.archive.blocked.activity");
  if (state.queue?.unresolved !== false)
    add("projects.archive.blocked.activity");
  if (state.queue?.openPhases?.some((phase) => isOpenWork(phase)))
    add("projects.archive.blocked.activity");
  if (
    state.queue?.openPhases?.some(
      (phase) =>
        typeof phase !== "string" ||
        (!isOpenWork(phase) && !TERMINAL_PHASES.has(phase.toLowerCase())),
    )
  )
    add("projects.archive.blocked.unknown");

  if (state.tasks) {
    for (const task of state.tasks) {
      if (task.projectId !== projectId) {
        add("projects.archive.blocked.unknown");
        continue;
      }
      const taskState =
        typeof task.state === "string" ? task.state.toLowerCase() : "";
      const phase =
        typeof task.phase === "string" ? task.phase.toLowerCase() : null;
      if (OPEN_WORK.has(taskState) || (phase !== null && isOpenWork(phase)))
        add("projects.archive.blocked.activity");
      else if (
        !TERMINAL_STATES.has(taskState) ||
        (phase !== null && !TERMINAL_PHASES.has(phase))
      )
        add("projects.archive.blocked.unknown");
    }
  }

  if (state.presence) {
    for (const observation of state.presence) {
      if (observation.projectId !== projectId) {
        add("projects.archive.blocked.unknown");
        continue;
      }
      const presence =
        typeof observation.presence === "string"
          ? observation.presence.toLowerCase()
          : "";
      if (
        presence !== "history" &&
        observation.observedAtMs !== null &&
        (!Number.isFinite(observation.observedAtMs) ||
          observation.observedAtMs > nowMs ||
          nowMs - observation.observedAtMs > FRESHNESS_MS)
      )
        add("projects.archive.blocked.stale");
      if (!INACTIVE_PRESENCE.has(presence)) {
        add(
          ["active", "working", "busy", "observed", "idle"].includes(presence)
            ? "projects.archive.blocked.presence"
            : "projects.archive.blocked.unknown",
        );
        continue;
      }
      if (
        observation.observedAtMs !== null &&
        (!Number.isFinite(observation.observedAtMs) ||
          observation.observedAtMs > nowMs ||
          nowMs - observation.observedAtMs > FRESHNESS_MS)
      )
        add("projects.archive.blocked.stale");
    }
  }
  return reasons;
}

function validQueueState(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOpenWork(value: string | null): boolean {
  return value !== null && OPEN_WORK.has(value.toLowerCase());
}

function validAlias(value: string): string | null {
  const alias = value.trim();
  if (
    !alias ||
    Array.from(alias).length > MAX_ALIAS_LENGTH ||
    /[\x00-\x1f\x7f-\x9f]/u.test(alias)
  )
    return null;
  return alias;
}

function findProjectAlias(snapshot: ProjectHistorySnapshot): string | null {
  return snapshot.aliases[0] ?? null;
}

function syncLifecycle(
  project: ProjectRegistryEntry,
  history: ProjectHistorySnapshot,
): boolean {
  return (
    project.monitoring === history.lifecycle.monitoring &&
    project.archivedAtMs === history.lifecycle.archivedAtMs
  );
}

function sameRegistryProject(
  left: ProjectRegistryEntry | null,
  right: ProjectRegistryEntry,
): boolean {
  return (
    left !== null &&
    left.projectId === right.projectId &&
    left.path === right.path &&
    left.databaseId === right.databaseId &&
    left.monitoring === right.monitoring &&
    left.archivedAtMs === right.archivedAtMs &&
    left.updatedAtMs === right.updatedAtMs &&
    left.lastResetAtMs === right.lastResetAtMs
  );
}

/** Server-side mutations over the existing registry and per-project history store. */
export function createProjectActions(options: ProjectActionsOptions) {
  const now = options.now ?? Date.now;

  function execute(
    principal: ConsoleQueryPrincipal,
    input: unknown,
  ): ProjectActionResponse {
    if (!isRequest(input))
      return response(
        {
          projectId:
            isRecord(input) && typeof input["projectId"] === "string"
              ? input["projectId"]
              : "unknown",
        },
        "error",
        "INVALID_REQUEST",
        {
          reasons: [{ key: "projects.action.failed" }],
        },
      );
    const request = input;
    if (!options.authorizeProjectWrite(principal, request.projectId))
      return response(request, "forbidden", "PROJECT_WRITE_FORBIDDEN", {
        reasons: [{ key: "projects.action.accessDenied" }],
      });

    const checkedAt = now();
    if (!Number.isFinite(checkedAt) || checkedAt < 0)
      return response(request, "unavailable", "CLOCK_UNAVAILABLE", {
        reasons: [{ key: "projects.action.failed" }],
      });

    let project: ProjectRegistryEntry | null;
    let history: ProjectHistoryStore | null = null;
    let initial: ProjectHistorySnapshot;
    try {
      project = options.registry.lookup(request.projectId);
      if (!project)
        return response(request, "unavailable", "PROJECT_NOT_REGISTERED", {
          reasons: [{ key: "projects.archive.blocked.missing" }],
        });
      history = options.openHistory(project);
      initial = history.snapshot(checkedAt);
    } catch {
      try {
        history?.close();
      } catch {
        // Preserve the primary open/read failure.
      }
      return response(request, "unavailable", "PROJECT_HISTORY_UNAVAILABLE", {
        reasons: [{ key: "projects.archive.blocked.missing" }],
      });
    }
    const projectHistory = history;

    try {
      const restoringPrepared =
        request.action === "restore" &&
        !project.monitoring &&
        project.archivedAtMs !== null &&
        initial.lifecycle.monitoring &&
        initial.lifecycle.archivedAtMs === null;
      if (
        initial.projectId !== project.projectId ||
        initial.databaseId !== project.databaseId ||
        (!syncLifecycle(project, initial) && !restoringPrepared)
      )
        return response(request, "unavailable", "LIFECYCLE_STATE_MISMATCH", {
          revision: options.projectRevision(initial),
          monitoring: project.monitoring,
          archivedAtMs: project.archivedAtMs,
          alias: findProjectAlias(initial),
          reasons: [{ key: "projects.archive.blocked.lifecycleMismatch" }],
        });

      const currentRevision = options.projectRevision(initial);
      if (!sameRevision(currentRevision, request.expectedRevision))
        return response(request, "stale", "EXPECTED_REVISION_MISMATCH", {
          revision: currentRevision,
          monitoring: project.monitoring,
          archivedAtMs: project.archivedAtMs,
          alias: findProjectAlias(initial),
          reasons: [{ key: "projects.archive.blocked.revision" }],
        });

      if (
        request.action === "set-alias" ||
        request.action === "reset-alias" ||
        request.action === "set-agent-alias" ||
        request.action === "reset-agent-alias"
      ) {
        if (!project.monitoring || project.archivedAtMs !== null)
          return response(request, "blocked", "ARCHIVED_PROJECT_READ_ONLY", {
            revision: currentRevision,
            monitoring: project.monitoring,
            archivedAtMs: project.archivedAtMs,
            alias: findProjectAlias(initial),
            reasons: [
              {
                key:
                  request.action === "set-agent-alias" ||
                  request.action === "reset-agent-alias"
                    ? "agents.alias.archivedReadOnly"
                    : "projects.alias.archivedReadOnly",
              },
            ],
          });
        const settingAgentAlias =
          request.action === "set-agent-alias" ||
          request.action === "reset-agent-alias";
        const settingAlias =
          request.action === "set-alias" ||
          request.action === "set-agent-alias";
        if (settingAlias && validAlias(request.alias) === null)
          return response(request, "error", "INVALID_ALIAS", {
            revision: currentRevision,
            monitoring: project.monitoring,
            archivedAtMs: project.archivedAtMs,
            alias: findProjectAlias(initial),
            reasons: [
              {
                key:
                  request.action === "set-agent-alias"
                    ? request.alias.trim()
                      ? "agents.alias.validation.tooLong"
                      : "agents.alias.validation.required"
                    : request.alias.trim()
                      ? "projects.alias.validation.tooLong"
                      : "projects.alias.validation.required",
                ...(request.alias.trim()
                  ? { params: { maxLength: MAX_ALIAS_LENGTH } }
                  : {}),
              },
            ],
          });
        if (
          !sameRegistryProject(
            options.registry.lookup(request.projectId),
            project,
          )
        )
          return response(request, "stale", "PROJECT_LIFECYCLE_CHANGED", {
            revision: currentRevision,
            monitoring: project.monitoring,
            archivedAtMs: project.archivedAtMs,
            alias: findProjectAlias(initial),
            reasons: [{ key: "projects.archive.blocked.revision" }],
          });
        const alias = settingAlias ? validAlias(request.alias)! : null;
        let changed: ProjectHistorySnapshot;
        try {
          if (settingAgentAlias) {
            changed = projectHistory.setAgentAlias(
              request.identity,
              alias,
              initial.revision,
              checkedAt,
            );
          } else {
            changed = projectHistory.setProjectAlias(
              alias,
              initial.revision,
              checkedAt,
            );
          }
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error
              ? String(error.code)
              : "";
          const stale = code === "HISTORY_REVISION_CONFLICT";
          return response(
            request,
            stale ? "stale" : "unavailable",
            stale ? code : "PROJECT_LABEL_STORE_UNAVAILABLE",
            {
              revision: currentRevision,
              monitoring: project.monitoring,
              archivedAtMs: project.archivedAtMs,
              alias: findProjectAlias(initial),
              ...(settingAgentAlias && request.action === "set-agent-alias"
                ? { identity: request.identity }
                : settingAgentAlias && request.action === "reset-agent-alias"
                  ? { identity: request.identity }
                  : {}),
              reasons: [
                {
                  key: stale
                    ? "projects.archive.blocked.revision"
                    : settingAgentAlias
                      ? "agents.alias.validation.unavailable"
                      : "projects.alias.validation.unavailable",
                },
              ],
            },
          );
        }
        try {
          options.publishProjectChange(changed);
        } catch {
          // A subsequent fresh query reconciles the committed revision.
        }
        const finalRevision = options.projectRevision(changed);
        return response(
          request,
          "ok",
          settingAgentAlias ? "AGENT_ALIAS_UPDATED" : "PROJECT_ALIAS_UPDATED",
          {
            revision: finalRevision,
            monitoring: project.monitoring,
            archivedAtMs: project.archivedAtMs,
            alias,
            ...(settingAgentAlias && request.action === "set-agent-alias"
              ? { identity: request.identity }
              : settingAgentAlias && request.action === "reset-agent-alias"
                ? { identity: request.identity }
                : {}),
          },
        );
      }

      if (request.action === "archive") {
        if (project.archivedAtMs !== null || !project.monitoring)
          return response(request, "blocked", "PROJECT_ALREADY_ARCHIVED", {
            revision: currentRevision,
            monitoring: project.monitoring,
            archivedAtMs: project.archivedAtMs,
            alias: findProjectAlias(initial),
            reasons: [{ key: "projects.archive.blocked.alreadyArchived" }],
          });
        try {
          let archivedSnapshot: ProjectHistorySnapshot | null = null;
          const archiveResponse = projectHistory.withActivityFence((fence) => {
            if (
              fence.projectId !== project.projectId ||
              fence.databaseId !== project.databaseId
            )
              return response(
                request,
                "unavailable",
                "ACTIVITY_FENCE_SCOPE_MISMATCH",
                {
                  revision: currentRevision,
                  monitoring: project.monitoring,
                  archivedAtMs: project.archivedAtMs,
                  alias: findProjectAlias(initial),
                  reasons: [{ key: "projects.archive.blocked.unknown" }],
                },
              );
            const lockedSnapshot = fence.snapshot(checkedAt);
            const lockedRevision = options.projectRevision(lockedSnapshot);
            if (
              !sameRevision(lockedRevision, request.expectedRevision) ||
              !sameRevision(lockedSnapshot.revision, initial.revision) ||
              !syncLifecycle(project, lockedSnapshot)
            )
              return response(request, "stale", "EXPECTED_REVISION_MISMATCH", {
                revision: lockedRevision,
                monitoring: project.monitoring,
                archivedAtMs: project.archivedAtMs,
                alias: findProjectAlias(lockedSnapshot),
                reasons: [{ key: "projects.archive.blocked.revision" }],
              });
            let fresh: ProjectActionFreshState;
            try {
              fresh = options.readFreshState(request.projectId);
            } catch {
              return response(
                request,
                "unavailable",
                "FRESH_STATE_UNAVAILABLE",
                {
                  revision: currentRevision,
                  monitoring: project.monitoring,
                  archivedAtMs: project.archivedAtMs,
                  alias: findProjectAlias(initial),
                  reasons: [{ key: "projects.archive.blocked.unknown" }],
                },
              );
            }
            if (!isFreshState(fresh) || fresh.projectId !== request.projectId)
              return response(request, "unavailable", "FRESH_STATE_INVALID", {
                revision: currentRevision,
                monitoring: project.monitoring,
                archivedAtMs: project.archivedAtMs,
                alias: findProjectAlias(initial),
                reasons: [{ key: "projects.archive.blocked.unknown" }],
              });
            if (
              !hasProjectActivityFence(
                fresh,
                request.projectId,
                fence.databaseId,
              )
            )
              return response(
                request,
                "unavailable",
                "ACTIVITY_FENCE_UNAVAILABLE",
                {
                  revision: currentRevision,
                  monitoring: project.monitoring,
                  archivedAtMs: project.archivedAtMs,
                  alias: findProjectAlias(initial),
                  reasons: [{ key: "projects.archive.blocked.unknown" }],
                },
              );
            if (!sameRevision(fresh.revision, request.expectedRevision))
              return response(request, "stale", "EXPECTED_REVISION_MISMATCH", {
                revision: currentRevision,
                monitoring: project.monitoring,
                archivedAtMs: project.archivedAtMs,
                alias: findProjectAlias(initial),
                reasons: [{ key: "projects.archive.blocked.revision" }],
              });
            const reasons = safetyReasons(
              request.projectId,
              fence.databaseId,
              request.expectedRevision,
              fresh,
              checkedAt,
            );
            if (reasons.length)
              return response(
                request,
                reasons.some(
                  (reason) => reason.key === "projects.archive.blocked.stale",
                )
                  ? "stale"
                  : "blocked",
                "PROJECT_ARCHIVE_GUARD",
                {
                  revision: currentRevision,
                  monitoring: project.monitoring,
                  archivedAtMs: project.archivedAtMs,
                  alias: findProjectAlias(initial),
                  reasons,
                },
              );

            let finalFresh: ProjectActionFreshState;
            try {
              finalFresh = options.readFreshState(request.projectId);
            } catch {
              return response(
                request,
                "unavailable",
                "FRESH_STATE_UNAVAILABLE",
                {
                  revision: currentRevision,
                  monitoring: project.monitoring,
                  archivedAtMs: project.archivedAtMs,
                  alias: findProjectAlias(initial),
                  reasons: [{ key: "projects.archive.blocked.unknown" }],
                },
              );
            }
            if (
              !isFreshState(finalFresh) ||
              finalFresh.projectId !== request.projectId
            )
              return response(request, "unavailable", "FRESH_STATE_INVALID", {
                revision: currentRevision,
                monitoring: project.monitoring,
                archivedAtMs: project.archivedAtMs,
                alias: findProjectAlias(initial),
                reasons: [{ key: "projects.archive.blocked.unknown" }],
              });
            if (
              !hasProjectActivityFence(
                finalFresh,
                request.projectId,
                fence.databaseId,
              )
            )
              return response(
                request,
                "unavailable",
                "ACTIVITY_FENCE_UNAVAILABLE",
                {
                  revision: currentRevision,
                  monitoring: project.monitoring,
                  archivedAtMs: project.archivedAtMs,
                  alias: findProjectAlias(initial),
                  reasons: [{ key: "projects.archive.blocked.unknown" }],
                },
              );
            if (
              !sameRevision(finalFresh.revision, request.expectedRevision) ||
              freshStateFingerprint(finalFresh) !== freshStateFingerprint(fresh)
            )
              return response(
                request,
                "stale",
                "ACTIVITY_CHANGED_DURING_ARCHIVE",
                {
                  revision: options.projectRevision(
                    projectHistory.snapshot(checkedAt),
                  ),
                  monitoring: project.monitoring,
                  archivedAtMs: project.archivedAtMs,
                  alias: findProjectAlias(initial),
                  reasons: [{ key: "projects.archive.blocked.revision" }],
                },
              );
            const finalReasons = safetyReasons(
              request.projectId,
              fence.databaseId,
              request.expectedRevision,
              finalFresh,
              checkedAt,
            );
            if (finalReasons.length)
              return response(request, "blocked", "PROJECT_ARCHIVE_GUARD", {
                revision: currentRevision,
                monitoring: project.monitoring,
                archivedAtMs: project.archivedAtMs,
                alias: findProjectAlias(initial),
                reasons: finalReasons,
              });
            if (
              !sameRegistryProject(
                options.registry.lookup(request.projectId),
                project,
              )
            )
              return response(request, "stale", "PROJECT_LIFECYCLE_CHANGED", {
                revision: currentRevision,
                monitoring: project.monitoring,
                archivedAtMs: project.archivedAtMs,
                alias: findProjectAlias(initial),
                reasons: [{ key: "projects.archive.blocked.revision" }],
              });

            const archivedAtMs = checkedAt;
            let registryAfterArchive: ProjectRegistryEntry | null = null;
            let changed: ProjectHistorySnapshot;
            try {
              // Disable the registry gate first; passive telemetry writers recheck it
              // before accepting their next event. The project store is never deleted.
              const registry = options.registry.setLifecycle(
                request.projectId,
                { monitoring: false, archivedAtMs, nowMs: checkedAt },
                project,
              );
              registryAfterArchive =
                registry.projects.find(
                  (entry) => entry.projectId === request.projectId,
                ) ?? null;
              if (!registryAfterArchive)
                throw new Error("Project registry update omitted the project");
              changed = fence.setLifecycleIfRevision(
                {
                  monitoring: false,
                  archivedAtMs,
                  updatedAtMs: checkedAt,
                },
                initial.revision,
              );
            } catch (error) {
              try {
                if (registryAfterArchive)
                  options.registry.setLifecycle(
                    request.projectId,
                    {
                      monitoring: project.monitoring,
                      archivedAtMs: project.archivedAtMs,
                      nowMs: checkedAt,
                    },
                    registryAfterArchive,
                  );
              } catch {
                // A failed compensation keeps monitoring disabled rather than claiming success.
              }
              let registryAfterFailure: ProjectRegistryEntry | null = null;
              try {
                registryAfterFailure = options.registry.lookup(
                  request.projectId,
                );
              } catch {
                // The lifecycle is explicitly unavailable if registry readback fails.
              }
              const code =
                error && typeof error === "object" && "code" in error
                  ? String(error.code)
                  : "";
              const stale = [
                "HISTORY_REVISION_CONFLICT",
                "REGISTRY_REVISION_CONFLICT",
              ].includes(code);
              return response(
                request,
                stale ? "stale" : "unavailable",
                stale ? code : "LIFECYCLE_UPDATE_INCOMPLETE",
                {
                  revision: currentRevision,
                  monitoring: registryAfterFailure?.monitoring ?? null,
                  archivedAtMs: registryAfterFailure?.archivedAtMs ?? null,
                  alias: findProjectAlias(initial),
                  reasons: [
                    {
                      key: stale
                        ? "projects.archive.blocked.revision"
                        : "projects.action.failed",
                    },
                  ],
                },
              );
            }
            archivedSnapshot = changed;
            return response(request, "ok", "PROJECT_ARCHIVED", {
              revision: options.projectRevision(changed),
              monitoring: false,
              archivedAtMs,
              alias: findProjectAlias(changed),
            });
          });
          if (archivedSnapshot) {
            try {
              options.publishProjectChange(archivedSnapshot);
            } catch {
              // A subsequent fresh query reconciles the committed revision.
            }
          }
          return archiveResponse;
        } catch {
          let fenceFailureRegistry: ProjectRegistryEntry | null = null;
          try {
            fenceFailureRegistry = options.registry.lookup(request.projectId);
          } catch {
            // A failed registry read is not interpreted as a successful archive.
          }
          return response(
            request,
            "unavailable",
            "ACTIVITY_FENCE_UNAVAILABLE",
            {
              revision: currentRevision,
              monitoring: fenceFailureRegistry?.monitoring ?? null,
              archivedAtMs: fenceFailureRegistry?.archivedAtMs ?? null,
              alias: findProjectAlias(initial),
              reasons: [{ key: "projects.archive.blocked.unknown" }],
            },
          );
        }
      }

      if (project.archivedAtMs === null || project.monitoring)
        return response(request, "blocked", "PROJECT_NOT_ARCHIVED", {
          revision: currentRevision,
          monitoring: project.monitoring,
          archivedAtMs: project.archivedAtMs,
          alias: findProjectAlias(initial),
          reasons: [{ key: "projects.restore.blocked.notArchived" }],
        });
      let restoredSnapshot: ProjectHistorySnapshot | null = null;
      try {
        // This also completes a previous restore whose SQLite commit succeeded
        // before the registry CAS. No queue or scheduler API is available here.
        const changed = restoringPrepared
          ? initial
          : projectHistory.setLifecycleIfRevision(
              {
                monitoring: true,
                archivedAtMs: null,
                updatedAtMs: checkedAt,
              },
              initial.revision,
            );
        restoredSnapshot = changed;
        options.registry.setLifecycle(
          request.projectId,
          { monitoring: true, archivedAtMs: null, nowMs: checkedAt },
          project,
        );
        try {
          options.publishProjectChange(changed);
        } catch {
          // A subsequent fresh query reconciles the committed revision.
        }
        return response(request, "ok", "PROJECT_RESTORED", {
          revision: options.projectRevision(changed),
          monitoring: true,
          archivedAtMs: null,
          alias: findProjectAlias(changed),
        });
      } catch (error) {
        let registryAfterFailure: ProjectRegistryEntry | null = null;
        try {
          registryAfterFailure = options.registry.lookup(request.projectId);
        } catch {
          // Keep the lifecycle explicitly unavailable below.
        }
        let historyAfterFailure = restoredSnapshot;
        if (
          restoredSnapshot &&
          registryAfterFailure &&
          !syncLifecycle(registryAfterFailure, restoredSnapshot)
        ) {
          try {
            historyAfterFailure = projectHistory.setLifecycleIfRevision(
              {
                monitoring: registryAfterFailure.monitoring,
                archivedAtMs: registryAfterFailure.archivedAtMs,
                updatedAtMs: checkedAt,
              },
              restoredSnapshot.revision,
            );
          } catch {
            // Preserve the original restore failure; report the observed registry state.
          }
        }
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "";
        const stale = [
          "HISTORY_REVISION_CONFLICT",
          "REGISTRY_REVISION_CONFLICT",
        ].includes(code);
        if (
          historyAfterFailure &&
          registryAfterFailure &&
          syncLifecycle(registryAfterFailure, historyAfterFailure) &&
          registryAfterFailure.monitoring &&
          registryAfterFailure.archivedAtMs === null
        )
          return response(request, "ok", "PROJECT_RESTORED", {
            revision: options.projectRevision(historyAfterFailure),
            monitoring: true,
            archivedAtMs: null,
            alias: findProjectAlias(historyAfterFailure),
          });
        return response(
          request,
          stale ? "stale" : "unavailable",
          stale ? code : "LIFECYCLE_UPDATE_INCOMPLETE",
          {
            revision: historyAfterFailure
              ? options.projectRevision(historyAfterFailure)
              : currentRevision,
            monitoring: registryAfterFailure?.monitoring ?? null,
            archivedAtMs: registryAfterFailure?.archivedAtMs ?? null,
            alias: findProjectAlias(initial),
            reasons: [
              {
                key: stale
                  ? "projects.archive.blocked.revision"
                  : "projects.action.failed",
              },
            ],
          },
        );
      }
    } finally {
      projectHistory.close();
    }
  }

  return { execute };
}
