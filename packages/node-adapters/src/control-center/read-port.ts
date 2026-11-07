import { Buffer } from "node:buffer";
import { lstatSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  openRegisteredProjectHistoryStore,
  projectHistoryDatabasePath,
} from "../persistence/project-history/sqlite.js";
import type { ConsoleQueryReadPort } from "@fmcad/control-center/server";
import type {
  ConsoleTelemetryEvent,
  ConsoleTelemetryEventSink,
  ConsoleTelemetryGap,
  ConsoleTelemetrySnapshot,
} from "@fmcad/core";
import type {
  ProjectHistoryAvailability,
  ProjectHistoryReadSnapshot,
  ProjectHistorySnapshot,
} from "../../../core/src/domain/project-history.js";
import type { ProjectRegistryEntry } from "../../../core/src/domain/project-registry.js";
import type { ProjectHistoryStore } from "../../../core/src/ports/project-history.js";
import type { ProjectRegistryStore } from "../../../core/src/ports/project-registry.js";
import { createConsoleArtifactReader } from "./artifact-reader.js";
import {
  mapConsoleQuerySnapshot,
  type ConsoleProjectHistoryRead,
} from "./snapshot-mapper.js";
import {
  createConsoleQueryRevisionAdapter,
  type ConsoleQueryRevisionAdapter,
} from "./revisions.js";
import type { ConsoleTelemetryReadRequest } from "../telemetry/console-telemetry.js";

const MAX_HISTORY_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_GLOBAL_PROJECTS = 256;

export interface ConsoleTelemetrySnapshotReader {
  read(request: ConsoleTelemetryReadRequest): ConsoleTelemetrySnapshot;
}

export interface ConsoleQueryNodeAdapterOptions {
  readonly registry: ProjectRegistryStore;
  readonly telemetry: ConsoleTelemetrySnapshotReader;
  readonly queueDirectory: string;
  /** Total serialized project history permitted in a global read snapshot. */
  readonly maxGlobalHistoryBytes?: number;
  /** Serialized history permitted for one project read snapshot. */
  readonly maxProjectHistoryBytes?: number;
  readonly maxRevisionListeners?: number;
}

export interface ConsoleQueryNodeAdapter {
  readonly readPort: ConsoleQueryReadPort;
  readonly eventSink: ConsoleTelemetryEventSink;
  readonly revisions: ConsoleQueryRevisionAdapter;
  readonly revisionWatchAvailable: boolean;
  /** Persist a producer-reported drop/gap; publish invalidation only after commit. */
  recordGap(projectId: string, gap: ConsoleTelemetryGap): void;
  close(): void;
}

interface CachedWriter {
  readonly projectRoot: string;
  readonly databaseId: string;
  readonly store: ProjectHistoryStore<ConsoleTelemetryEvent>;
}

interface ProjectRevisionWatch {
  readonly key: string;
  readonly watcher: FSWatcher;
}

function boundedPositive(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${name} must be a positive bounded integer`);
  return value;
}

function historyStoreRead(
  registry: ProjectRegistryStore,
  project: ProjectRegistryEntry,
  maxBytes: number,
): ProjectHistoryReadSnapshot<ConsoleTelemetryEvent> {
  const store = openRegisteredProjectHistoryStore<ConsoleTelemetryEvent>(
    registry,
    {
      projectId: project.projectId,
      projectRoot: project.path,
      readOnly: true,
    },
  );
  try {
    return store.readSnapshot(maxBytes);
  } finally {
    store.close();
  }
}

function historyStoreSummary(
  registry: ProjectRegistryStore,
  project: ProjectRegistryEntry,
): ProjectHistorySnapshot {
  const store = openRegisteredProjectHistoryStore<ConsoleTelemetryEvent>(
    registry,
    {
      projectId: project.projectId,
      projectRoot: project.path,
      readOnly: true,
    },
  );
  try {
    return store.snapshot();
  } finally {
    store.close();
  }
}

function realDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function projectHistoryDirectory(project: ProjectRegistryEntry): string | null {
  if (!realDirectory(project.path)) return null;
  const cadDirectory = join(project.path, ".cad");
  const historyDirectory = join(cadDirectory, "control-center");
  return realDirectory(cadDirectory) && realDirectory(historyDirectory)
    ? historyDirectory
    : null;
}

function serializeBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function historySummary(
  snapshot: ProjectHistorySnapshot,
): ProjectHistorySnapshot {
  return {
    projectId: snapshot.projectId,
    databaseId: snapshot.databaseId,
    version: snapshot.version,
    revision: snapshot.revision,
    capturedAtMs: snapshot.capturedAtMs,
    availability: snapshot.availability,
    lifecycle: snapshot.lifecycle,
    aliases: snapshot.aliases,
    agentAliases: snapshot.agentAliases,
    sources: snapshot.sources,
    eventCount: snapshot.eventCount,
    jobCount: snapshot.jobCount,
    sessionCount: snapshot.sessionCount,
    fileReferenceCount: snapshot.fileReferenceCount,
  };
}

function registryEntry(
  registry: ProjectRegistryStore,
  projectId: string,
): ProjectRegistryEntry {
  const entry = registry.lookup(projectId);
  if (!entry)
    throw new Error("Requested project is not in the explicit registry");
  return entry;
}

export function createConsoleQueryNodeAdapter(
  options: ConsoleQueryNodeAdapterOptions,
): ConsoleQueryNodeAdapter {
  const maxProjectHistoryBytes = boundedPositive(
    options.maxProjectHistoryBytes ?? 8 * 1024 * 1024,
    MAX_HISTORY_SNAPSHOT_BYTES,
    "Project history read limit",
  );
  const maxGlobalHistoryBytes = boundedPositive(
    options.maxGlobalHistoryBytes ?? 12 * 1024 * 1024,
    MAX_HISTORY_SNAPSHOT_BYTES,
    "Global history read limit",
  );
  const revisionAdapter = createConsoleQueryRevisionAdapter(
    options.maxRevisionListeners,
  );
  const projectWatchers = new Map<string, ProjectRevisionWatch>();
  const registryDirectory = dirname(options.registry.readonlyPath);
  let registryWatcher: FSWatcher | null = null;
  let registryRefreshQueued = false;
  const projectRefreshQueued = new Set<string>();
  let watcherFailed = false;
  const writerStores = new Map<string, CachedWriter>();
  const knownSnapshots = new Map<string, ProjectHistorySnapshot>();
  let disposed = false;

  function markWatcherFailed(watcher: FSWatcher): void {
    watcherFailed = true;
    if (registryWatcher === watcher) registryWatcher = null;
    for (const [projectId, entry] of projectWatchers) {
      if (entry.watcher === watcher) projectWatchers.delete(projectId);
    }
    watcher.close();
  }

  function watchRegistry(): void {
    if (registryWatcher || !realDirectory(registryDirectory)) return;
    try {
      const watcher = watch(registryDirectory, { persistent: false }, () => {
        if (disposed || registryRefreshQueued) return;
        registryRefreshQueued = true;
        setImmediate(() => {
          registryRefreshQueued = false;
          if (disposed) return;
          try {
            refreshRegistry();
          } catch {
            watcherFailed = true;
          }
        });
      });
      registryWatcher = watcher;
      watcher.on("error", () => markWatcherFailed(watcher));
    } catch {
      watcherFailed = true;
    }
  }

  function syncProjectWatchers(
    projects: readonly ProjectRegistryEntry[],
  ): void {
    const desired = new Map(
      projects.map((project) => [
        project.projectId,
        {
          project,
          key: JSON.stringify([project.path, project.databaseId]),
        },
      ]),
    );
    for (const [projectId, current] of projectWatchers) {
      if (desired.get(projectId)?.key === current.key) continue;
      current.watcher.close();
      projectWatchers.delete(projectId);
    }
    for (const [projectId, item] of desired) {
      if (projectWatchers.has(projectId)) continue;
      const directory = projectHistoryDirectory(item.project);
      if (!directory) continue;
      try {
        const watcher = watch(
          directory,
          { persistent: false },
          (_event, filename) => {
            if (
              filename !== null &&
              ![
                basename(projectHistoryDatabasePath(item.project.path)),
                `${basename(projectHistoryDatabasePath(item.project.path))}-wal`,
                `${basename(projectHistoryDatabasePath(item.project.path))}-shm`,
                `${basename(projectHistoryDatabasePath(item.project.path))}-journal`,
              ].includes(String(filename))
            )
              return;
            if (disposed || projectRefreshQueued.has(projectId)) return;
            projectRefreshQueued.add(projectId);
            setImmediate(() => {
              projectRefreshQueued.delete(projectId);
              if (disposed) return;
              try {
                refreshProject(projectId, item.key);
              } catch {
                watcherFailed = true;
              }
            });
          },
        );
        projectWatchers.set(projectId, { key: item.key, watcher });
        watcher.on("error", () => markWatcherFailed(watcher));
      } catch {
        watcherFailed = true;
      }
    }
  }

  function revisionWatchAvailable(): boolean {
    if (disposed || watcherFailed) return false;
    try {
      watchRegistry();
      const projects = options.registry.read().projects;
      syncProjectWatchers(projects);
      return (
        !!registryWatcher &&
        projects.every((project) => {
          const current = projectWatchers.get(project.projectId);
          return (
            current?.key === JSON.stringify([project.path, project.databaseId])
          );
        })
      );
    } catch {
      return false;
    }
  }

  function refreshProject(projectId: string, expectedKey: string): void {
    const registry = options.registry.read();
    const project = registry.projects.find(
      (entry) => entry.projectId === projectId,
    );
    if (
      !project ||
      JSON.stringify([project.path, project.databaseId]) !== expectedKey
    ) {
      refreshRegistry();
      return;
    }
    try {
      const snapshot = historyStoreSummary(options.registry, project);
      knownSnapshots.set(projectId, snapshot);
      revisionAdapter.publishProjectCommit(snapshot);
    } catch {
      refreshRegistry();
    }
  }

  function refreshRegistry(): void {
    const registry = options.registry.read();
    const projects: ProjectHistorySnapshot[] = [];
    const unavailableProjectIds: string[] = [];
    for (const project of registry.projects) {
      try {
        const snapshot = historyStoreSummary(options.registry, project);
        knownSnapshots.set(project.projectId, snapshot);
        projects.push(snapshot);
      } catch {
        knownSnapshots.delete(project.projectId);
        unavailableProjectIds.push(project.projectId);
      }
    }
    for (const projectId of knownSnapshots.keys())
      if (!registry.projects.some((project) => project.projectId === projectId))
        knownSnapshots.delete(projectId);
    syncProjectWatchers(registry.projects);
    revisionAdapter.publishGlobalCommit({
      registry,
      registryPath: options.registry.readonlyPath,
      projects,
      ...(unavailableProjectIds.length ? { unavailableProjectIds } : {}),
    });
  }

  watchRegistry();
  try {
    syncProjectWatchers(options.registry.read().projects);
  } catch {
    watcherFailed = true;
  }

  function openWriter(
    projectId: string,
  ): ProjectHistoryStore<ConsoleTelemetryEvent> {
    if (disposed) throw new Error("Console query adapter is closed");
    const entry = registryEntry(options.registry, projectId);
    const cached = writerStores.get(projectId);
    if (
      cached &&
      cached.projectRoot === entry.path &&
      cached.databaseId === entry.databaseId
    )
      return cached.store;
    cached?.store.close();
    const store = openRegisteredProjectHistoryStore<ConsoleTelemetryEvent>(
      options.registry,
      {
        projectId,
        projectRoot: entry.path,
        readOnly: false,
      },
    );
    writerStores.set(projectId, {
      projectRoot: entry.path,
      databaseId: entry.databaseId,
      store,
    });
    return store;
  }

  function publishGlobalIfComplete(registry = options.registry.read()): void {
    const projects: ProjectHistorySnapshot[] = [];
    const unavailableProjectIds: string[] = [];
    for (const entry of registry.projects) {
      const snapshot = knownSnapshots.get(entry.projectId);
      if (snapshot && snapshot.databaseId === entry.databaseId)
        projects.push(snapshot);
      else unavailableProjectIds.push(entry.projectId);
    }
    revisionAdapter.publishGlobalCommit({
      registry,
      registryPath: options.registry.readonlyPath,
      projects,
      ...(unavailableProjectIds.length ? { unavailableProjectIds } : {}),
    });
  }

  function committed(projectId: string): ProjectHistorySnapshot {
    const store = openWriter(projectId);
    const snapshot = historySummary(store.snapshot());
    knownSnapshots.set(projectId, snapshot);
    revisionAdapter.publishProjectCommit(snapshot);
    publishGlobalIfComplete();
    return snapshot;
  }

  const eventSink: ConsoleTelemetryEventSink = {
    async append(event) {
      const projectId = event.identity.projectId.value;
      if (!projectId)
        throw new Error(
          "Project history cannot retain telemetry without a canonical project ID",
        );
      const store = openWriter(projectId);
      store.ingest([event]);
      committed(projectId);
    },
  };

  const artifactReader = createConsoleArtifactReader({
    queueDirectory: options.queueDirectory,
    projectRoot(projectId) {
      try {
        return options.registry.lookup(projectId)?.path ?? null;
      } catch {
        return null;
      }
    },
  });

  const readPort: ConsoleQueryReadPort = {
    async readSnapshot(scope) {
      if (disposed) throw new Error("Console query adapter is closed");
      watchRegistry();
      const registry = options.registry.read();
      let projects: readonly ProjectRegistryEntry[];
      if (scope.kind === "project") {
        const project = registry.projects.find(
          (entry) => entry.projectId === scope.projectId,
        );
        if (!project)
          throw new Error("Requested project is not in the explicit registry");
        projects = [project];
      } else {
        if (registry.projects.length > MAX_GLOBAL_PROJECTS)
          throw new Error(
            "Registered project set exceeds the global snapshot limit",
          );
        projects = registry.projects;
      }
      syncProjectWatchers(registry.projects);

      const historyLimit =
        scope.kind === "project"
          ? maxProjectHistoryBytes
          : maxGlobalHistoryBytes;
      let remaining = historyLimit;
      const histories: ConsoleProjectHistoryRead[] = [];
      const snapshots: ProjectHistoryReadSnapshot<ConsoleTelemetryEvent>[] = [];
      const unavailableProjectIds: string[] = [];
      for (const project of projects) {
        if (remaining < 1)
          throw new Error(
            "Global project history exceeds the retained snapshot budget",
          );
        try {
          const snapshot = historyStoreRead(
            options.registry,
            project,
            Math.min(maxProjectHistoryBytes, remaining),
          );
          const bytes = serializeBytes(snapshot);
          remaining -= bytes;
          snapshots.push(snapshot);
          knownSnapshots.set(project.projectId, historySummary(snapshot));
          histories.push({ project, snapshot });
        } catch (error) {
          if (scope.kind === "project") throw error;
          knownSnapshots.delete(project.projectId);
          unavailableProjectIds.push(project.projectId);
          histories.push({
            project,
            snapshot: null,
            error:
              error instanceof Error
                ? error.message.slice(0, 1024)
                : "Project history snapshot is unavailable.",
          });
        }
      }
      const registryAfter = options.registry.read();
      if (
        registryAfter.revision !== registry.revision ||
        registryAfter.projects.length !== registry.projects.length ||
        registryAfter.projects.some((entry, index) => {
          const before = registry.projects[index];
          return (
            !before ||
            entry.projectId !== before.projectId ||
            entry.path !== before.path ||
            entry.databaseId !== before.databaseId
          );
        })
      )
        throw new Error(
          "Project registry changed during query snapshot capture",
        );

      const telemetryRequest: ConsoleTelemetryReadRequest =
        scope.kind === "project"
          ? {
              scope: {
                kind: "project",
                projectId: scope.projectId,
                projectDirectory: projects[0]!.path,
              },
            }
          : { scope: { kind: "global" } };
      const telemetry = options.telemetry.read(telemetryRequest);

      let revision;
      if (scope.kind === "project") {
        const projectHistory = snapshots[0];
        if (!projectHistory)
          throw new Error("Project history did not return a retained snapshot");
        revision = revisionAdapter.observeProject(projectHistory);
      } else {
        const input = {
          registry,
          registryPath: options.registry.readonlyPath,
          projects: snapshots,
          ...(unavailableProjectIds.length ? { unavailableProjectIds } : {}),
        };
        revision = revisionAdapter.observeGlobal(input);
      }

      const capturedAtCandidates = [
        ...snapshots.map((snapshot) => snapshot.capturedAtMs),
        telemetry.overview.sampleWindow.value?.to,
        telemetry.overview.running.readAtMs,
      ].filter(
        (value): value is number =>
          typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0,
      );
      const capturedAt = Math.max(...capturedAtCandidates);
      return mapConsoleQuerySnapshot({
        scope,
        revision,
        capturedAt,
        registry,
        histories,
        telemetry,
      });
    },
    readArtifact: artifactReader.readArtifact,
  };

  function recordGap(projectId: string, gap: ConsoleTelemetryGap): void {
    const store = openWriter(projectId);
    store.ingestBatch({
      events: [],
      sourceId: gap.sourceId,
      epoch: gap.epoch,
      cursor: {
        sourceId: gap.sourceId,
        epoch: gap.epoch,
        position: gap.toPosition,
        positionKind: gap.positionKind,
        eventId: null,
      },
      gaps: [
        {
          sourceId: gap.sourceId,
          epoch: gap.epoch,
          fromPosition: gap.fromPosition,
          toPosition: gap.toPosition,
          positionKind: gap.positionKind,
          detectedAtMs: gap.detectedAtMs,
          reason: gap.reason,
        },
      ],
      availability: "partial" satisfies ProjectHistoryAvailability,
      reason: gap.reason,
      observedAtMs: null,
      readAtMs: gap.detectedAtMs,
    });
    committed(projectId);
  }

  function close(): void {
    if (disposed) return;
    disposed = true;
    registryWatcher?.close();
    registryWatcher = null;
    for (const current of projectWatchers.values()) current.watcher.close();
    projectWatchers.clear();
    for (const cached of writerStores.values()) cached.store.close();
    writerStores.clear();
    knownSnapshots.clear();
  }

  return {
    readPort,
    eventSink,
    revisions: {
      ...revisionAdapter,
      subscribe(listener) {
        if (!revisionWatchAvailable()) return null;
        return revisionAdapter.subscribe(listener);
      },
    },
    get revisionWatchAvailable() {
      return revisionWatchAvailable();
    },
    recordGap,
    close,
  };
}
