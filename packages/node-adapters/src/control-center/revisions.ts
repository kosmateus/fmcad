import { createHash } from "node:crypto";
import type {
  ConsoleQueryScope,
  ConsoleRevision,
  ConsoleRevisionEvent,
  ConsoleRevisionListener,
} from "@fmcad/control-center/server";
import type { ProjectHistorySnapshot } from "../../../core/src/domain/project-history.js";
import type { ProjectRegistrySnapshot } from "../../../core/src/domain/project-registry.js";

const MAX_REVISION_LISTENERS = 256;

interface RevisionState {
  revision: ConsoleRevision;
  signature: string;
}

export interface ConsoleQueryGlobalRevisionInput {
  readonly registry: ProjectRegistrySnapshot;
  readonly registryPath: string;
  readonly projects: readonly ProjectHistorySnapshot[];
  readonly unavailableProjectIds?: readonly string[];
}

export interface ConsoleQueryRevisionAdapter {
  subscribe(listener: ConsoleRevisionListener): (() => void) | null;
  observeProject(snapshot: ProjectHistorySnapshot): ConsoleRevision;
  observeGlobal(input: ConsoleQueryGlobalRevisionInput): ConsoleRevision;
  publishProjectCommit(snapshot: ProjectHistorySnapshot): void;
  publishGlobalCommit(input: ConsoleQueryGlobalRevisionInput): void;
}

function scopeKey(scope: ConsoleQueryScope): string {
  return scope.kind === "global" ? "global" : `project:${scope.projectId}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function sourceEpochVector(snapshot: ProjectHistorySnapshot) {
  return snapshot.sources
    .flatMap((source) =>
      source.cursor
        ? [
            [
              source.cursor.sourceId,
              source.cursor.epoch,
              source.cursor.positionKind,
            ],
          ]
        : [],
    )
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

function hasSourceGap(snapshot: ProjectHistorySnapshot): boolean {
  return (
    snapshot.availability === "partial" ||
    snapshot.availability === "unavailable" ||
    snapshot.sources.some(
      (source) => source.gaps.length > 0 || source.gapsTruncated,
    )
  );
}

function projectRevision(snapshot: ProjectHistorySnapshot): {
  revision: ConsoleRevision;
  signature: string;
  resyncRequired: boolean;
} {
  const sourceEpochs = sourceEpochVector(snapshot);
  const revision = {
    epoch: digest([
      "project-history-v1",
      snapshot.projectId,
      snapshot.databaseId,
      snapshot.revision.epoch,
      sourceEpochs,
    ]),
    revision: snapshot.revision.revision,
  };
  return {
    revision,
    signature: JSON.stringify([
      revision,
      snapshot.availability,
      snapshot.sources.map((source) => [
        source.sourceId,
        source.cursor?.position ?? null,
        source.gaps.length,
        source.gapsTruncated,
      ]),
    ]),
    resyncRequired: hasSourceGap(snapshot),
  };
}

export function consoleProjectRevision(
  snapshot: ProjectHistorySnapshot,
): ConsoleRevision {
  return projectRevision(snapshot).revision;
}

function globalRevision(input: ConsoleQueryGlobalRevisionInput): {
  revision: ConsoleRevision;
  signature: string;
  resyncRequired: boolean;
} {
  const projects = [...input.projects].sort((a, b) =>
    a.projectId.localeCompare(b.projectId),
  );
  const registered = [...input.registry.projects].sort((a, b) =>
    a.projectId.localeCompare(b.projectId),
  );
  const unavailable = [...(input.unavailableProjectIds ?? [])].sort();
  const registeredIds = new Set(registered.map((project) => project.projectId));
  const unexpected = projects.some(
    (project) => !registeredIds.has(project.projectId),
  );
  const projectRevisionSum = projects.reduce(
    (sum, project) => sum + project.revision.revision,
    input.registry.revision,
  );
  if (!Number.isSafeInteger(projectRevisionSum) || projectRevisionSum < 0)
    throw new Error("Global retained revision exceeds the safe integer range");

  const sourceVector = projects.map((project) => [
    project.projectId,
    project.databaseId,
    project.revision.epoch,
    sourceEpochVector(project),
  ]);
  const epoch = digest([
    "global-registry-history-v1",
    input.registryPath,
    input.registry.revision,
    registered.map((project) => [
      project.projectId,
      project.databaseId,
      project.monitoring,
      project.archivedAtMs,
    ]),
    sourceVector,
    unavailable,
  ]);
  const revision = { epoch, revision: projectRevisionSum };
  return {
    revision,
    signature: JSON.stringify([
      revision,
      sourceVector.map(([projectId, , , sources]) => [
        projectId,
        sources,
        projects.find((project) => project.projectId === projectId)?.revision
          .revision,
      ]),
      unavailable,
    ]),
    resyncRequired:
      unexpected ||
      unavailable.length > 0 ||
      projects.some(hasSourceGap) ||
      projects.length !== registered.length,
  };
}

export function consoleGlobalRevision(
  input: ConsoleQueryGlobalRevisionInput,
): ConsoleRevision {
  return globalRevision(input).revision;
}

export function createConsoleQueryRevisionAdapter(
  maxListeners = MAX_REVISION_LISTENERS,
): ConsoleQueryRevisionAdapter {
  if (!Number.isSafeInteger(maxListeners) || maxListeners < 1)
    throw new Error("Query revision listener limit must be positive");
  const states = new Map<string, RevisionState>();
  const projects = new Map<string, ProjectHistorySnapshot>();
  let globalInput: ConsoleQueryGlobalRevisionInput | null = null;
  const listeners = new Map<number, ConsoleRevisionListener>();
  let nextListenerId = 0;

  function emit(event: ConsoleRevisionEvent): void {
    for (const [id, listener] of listeners) {
      try {
        if (listener(event) === false) listeners.delete(id);
      } catch {
        listeners.delete(id);
      }
    }
  }

  function observe(
    scope: ConsoleQueryScope,
    next: ReturnType<typeof projectRevision>,
    emitChanges: boolean,
  ): ConsoleRevision {
    const key = scopeKey(scope);
    const previous = states.get(key);
    if (!previous) {
      states.set(key, {
        revision: next.revision,
        signature: next.signature,
      });
      return next.revision;
    }
    if (previous.signature === next.signature) return previous.revision;
    const epochChanged = previous.revision.epoch !== next.revision.epoch;
    if (!epochChanged && next.revision.revision <= previous.revision.revision)
      throw new Error("Retained source changed without advancing its revision");
    const gap =
      !epochChanged &&
      next.revision.revision !== previous.revision.revision + 1;
    states.set(key, {
      revision: next.revision,
      signature: next.signature,
    });
    if (emitChanges)
      emit({
        scope,
        revision: next.revision,
        resyncRequired: next.resyncRequired || epochChanged || gap,
      });
    return next.revision;
  }

  function observeProject(snapshot: ProjectHistorySnapshot): ConsoleRevision {
    projects.set(snapshot.projectId, snapshot);
    return observe(
      { kind: "project", projectId: snapshot.projectId },
      projectRevision(snapshot),
      false,
    );
  }

  function observeGlobal(
    input: ConsoleQueryGlobalRevisionInput,
  ): ConsoleRevision {
    globalInput = input;
    projects.clear();
    for (const project of input.projects) observeProject(project);
    return observe({ kind: "global" }, globalRevision(input), false);
  }

  function publishProjectCommit(snapshot: ProjectHistorySnapshot): void {
    observe(
      { kind: "project", projectId: snapshot.projectId },
      projectRevision(snapshot),
      true,
    );
    projects.set(snapshot.projectId, snapshot);
    if (globalInput) {
      const input = {
        ...globalInput,
        projects: [...projects.values()].filter((project) =>
          globalInput!.registry.projects.some(
            (entry) => entry.projectId === project.projectId,
          ),
        ),
        ...(globalInput.unavailableProjectIds === undefined
          ? {}
          : {
              unavailableProjectIds: globalInput.unavailableProjectIds.filter(
                (projectId) => projectId !== snapshot.projectId,
              ),
            }),
      };
      globalInput = input;
      observe({ kind: "global" }, globalRevision(input), true);
    }
  }

  function publishGlobalCommit(input: ConsoleQueryGlobalRevisionInput): void {
    globalInput = input;
    projects.clear();
    for (const project of input.projects) {
      projects.set(project.projectId, project);
      observe(
        { kind: "project", projectId: project.projectId },
        projectRevision(project),
        true,
      );
    }
    observe({ kind: "global" }, globalRevision(input), true);
  }

  return {
    subscribe(listener) {
      if (listeners.size >= maxListeners) return null;
      const id = ++nextListenerId;
      listeners.set(id, listener);
      return () => listeners.delete(id);
    },
    observeProject,
    observeGlobal,
    publishProjectCommit,
    publishGlobalCommit,
  };
}
