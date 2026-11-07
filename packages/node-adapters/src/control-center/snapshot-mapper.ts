import { basename } from "node:path";
import type {
  ConsoleArtifactKind,
  ConsoleArtifactOutputProvenance,
  ConsoleOwnedArtifactReference,
  ConsoleOverviewRecord,
  ConsoleQueryDataSnapshot,
  ConsoleQueryRecord,
  ConsoleQueryScope,
  ConsoleRevision,
  ConsoleSourceStatus,
  ConsoleTaskArtifacts,
} from "@fmcad/control-center/server";
import type {
  ConsoleTelemetryEvent,
  ConsoleTelemetryFileReference,
  ConsoleTelemetrySnapshot,
  ConsoleTelemetryValue,
} from "@fmcad/core";
import type { ProjectHistoryReadSnapshot } from "../../../core/src/domain/project-history.js";
import type { ProjectRegistryEntry } from "../../../core/src/domain/project-registry.js";
import type { OwnedResultReference } from "../../../core/src/ports/execution-store.js";
import type { ConsoleArtifactLocator } from "./artifact-reader.js";
import { consoleLogTimestamp } from "./log-timestamp.js";

type Data = Record<string, unknown>;
type HistorySnapshot = ProjectHistoryReadSnapshot<ConsoleTelemetryEvent>;
type TelemetryState = ConsoleTelemetryValue<unknown>["availability"];
type OutputChannelField = "stdout" | "stderr" | "rpc";
type TelemetryFileReferenceWithOwnedResult = ConsoleTelemetryFileReference & {
  readonly ownedResult?: ConsoleTelemetryValue<OwnedResultReference>;
};
const HASH = /^[a-f0-9]{64}$/u;

interface OutputObservation {
  readonly state: TelemetryState;
  readonly names: ReadonlySet<string>;
  readonly reason: string | null;
}

export interface ConsoleProjectHistoryRead {
  readonly project: ProjectRegistryEntry;
  readonly snapshot: HistorySnapshot | null;
  readonly error?: string;
}

function asRecord(value: unknown): Data | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : null;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function metric<T>(value: ConsoleTelemetryValue<T>): T | null {
  return value.value;
}

function observedAtMs(value: number | null): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function sourceState(
  state: TelemetryState | HistorySnapshot["availability"],
): ConsoleSourceStatus["state"] {
  switch (state) {
    case "available":
      return "available";
    case "stale":
      return "stale";
    case "partial":
    case "unknown":
      return "partial";
    case "no-data":
      return "no-data";
    case "missing":
    case "unsupported":
    case "unavailable":
    case "error":
      return "unavailable";
  }
}

function combinedSource(
  values: readonly (ConsoleSourceStatus | null)[],
  source: string,
): ConsoleSourceStatus {
  const present = values.filter(
    (value): value is ConsoleSourceStatus => value !== null,
  );
  if (!present.length)
    return {
      state: "unavailable",
      source,
      observedAt: null,
      reason: "No retained source status was available.",
    };
  const observed = present.flatMap((value) =>
    observedAtMs(value.observedAt) === null
      ? []
      : [observedAtMs(value.observedAt)!],
  );
  const state: ConsoleSourceStatus["state"] = present.every(
    (value) => value.state === "no-data",
  )
    ? "no-data"
    : present.every((value) => value.state === "unavailable")
      ? "unavailable"
      : present.some((value) =>
            ["unavailable", "partial"].includes(value.state),
          )
        ? "partial"
        : present.some((value) => value.state === "stale")
          ? "stale"
          : "available";
  const reasons = [
    ...new Set(
      present.flatMap((value) => (value.reason ? [value.reason] : [])),
    ),
  ];
  return {
    state,
    source,
    observedAt: observed.length ? Math.min(...observed) : null,
    ...(reasons.length ? { reason: reasons.join("; ").slice(0, 2048) } : {}),
  };
}

function telemetrySource<T>(
  value: ConsoleTelemetryValue<T>,
  fallback: string,
): ConsoleSourceStatus {
  return {
    state: sourceState(value.availability),
    source: nonempty(value.source) ? value.source : fallback,
    observedAt: observedAtMs(value.observedAtMs),
    ...(value.reason ? { reason: value.reason } : {}),
  };
}

function historySource(
  value: ConsoleProjectHistoryRead,
  collection: string,
): ConsoleSourceStatus {
  const snapshot = value.snapshot;
  if (!snapshot)
    return {
      state: "unavailable",
      source: `project-history:${collection}`,
      observedAt: null,
      reason: value.error ?? "Project history snapshot is unavailable.",
    };
  return {
    state: sourceState(snapshot.availability),
    source: `project-history:${collection}`,
    observedAt: snapshot.capturedAtMs,
    ...(snapshot.availability === "partial"
      ? {
          reason:
            "Retained history has source gaps or incomplete availability.",
        }
      : {}),
  };
}

function eventProjectId(
  event: ConsoleTelemetryEvent,
  fallback: string,
): string {
  const value = event.identity.projectId.value;
  return nonempty(value) ? value : fallback;
}

function isStageEvent(event: ConsoleTelemetryEvent): boolean {
  return ["fmcad.stage.plan", "fmcad.stage.started"].includes(
    event.eventName.value ?? "",
  );
}

function stageEntryHash(
  event: ConsoleTelemetryEvent,
  project: ProjectRegistryEntry,
  taskId: string,
): string | null {
  if (!isStageEvent(event)) return null;
  const expectedEventKeys = [
    "actor",
    "eventName",
    "eventType",
    "fusion",
    "identity",
    "metadata",
    "outputFiles",
    "phase",
    "phaseIntervalKind",
    "physicalTurnOrdinal",
    "physicalTurns",
    "sourceFiles",
    "state",
    "timings",
    "version",
    "worker",
  ];
  if (
    Object.keys(event).sort().join(",") !== expectedEventKeys.sort().join(",")
  )
    return null;
  const kind =
    event.eventName.value === "fmcad.stage.plan" ? "plan" : "started";
  const sequence = event.metadata.sequence.value;
  const eventId = event.metadata.eventId.value;
  const sourceId = event.metadata.sourceId.value;
  const epoch = event.metadata.epoch.value;
  const references = event.sourceFiles.value ?? [];
  const hashes = new Set(
    references.map((reference) => reference.artifactId.value),
  );
  if (
    event.eventType !== "observation.event" ||
    event.identity.projectId.value !== project.projectId ||
    event.identity.jobId.value !== taskId ||
    !Number.isSafeInteger(sequence) ||
    (sequence as number) < 0 ||
    sourceId !== `stage-journal:${taskId}` ||
    !epoch ||
    !HASH.test(epoch) ||
    references.length === 0 ||
    hashes.size !== 1 ||
    ![...hashes].every((hash) => typeof hash === "string" && HASH.test(hash))
  )
    return null;
  const hash = [...hashes][0]!;
  if (
    eventId !== `stage-event:${taskId}:${sequence}:${hash}` ||
    event.metadata.revision.value !== null ||
    event.metadata.observedAtMs.value !== null ||
    event.state.value !== null ||
    event.phase.value !== null ||
    event.outputFiles.value !== null ||
    event.actor.transport.value !== "retained-stage-journal" ||
    references.some(
      (reference) =>
        reference.kind !== "source" ||
        reference.path.value !== null ||
        reference.fileId.value === null ||
        !reference.fileId.value.startsWith(`${sequence}:`) ||
        reference.artifactId.value !== hash ||
        reference.sha256.value !== hash ||
        reference.provenance.value !== `retained-stage-journal:${kind}`,
    )
  )
    return null;
  const content = JSON.stringify(event);
  if (
    content.includes(project.path) ||
    /"(?:receipt|sourcePath)"/u.test(content)
  )
    return null;
  return hash;
}

function taskFromEvent(
  event: ConsoleTelemetryEvent,
  projectId: string,
  idFallback?: string,
): ConsoleQueryRecord | null {
  const id = event.identity.jobId.value ?? idFallback;
  const state = event.state.value;
  if (!nonempty(id) || !nonempty(state)) return null;
  return {
    id,
    projectId,
    state,
    ...(event.phase.value ? { phase: event.phase.value } : {}),
    requestId: event.identity.requestId.value,
    clientId: event.identity.clientId.value,
    sessionId: event.identity.sessionId.value,
    agentId: event.actor.agentId.value,
    ...(event.actor.agent.value ? { agent: event.actor.agent.value } : {}),
    transport: event.actor.transport.value,
  };
}

function taskKey(projectId: string, taskId: string): string {
  return JSON.stringify([projectId, taskId]);
}

function exactAgentAlias(
  snapshot: HistorySnapshot | null | undefined,
  identities: {
    readonly agentId?: string | null;
    readonly clientId?: string | null;
    readonly sessionId?: string | null;
  },
): string | undefined {
  if (!snapshot) return undefined;
  const candidates = [
    ...(identities.agentId
      ? [{ kind: "agent" as const, id: identities.agentId }]
      : []),
    ...(identities.clientId
      ? [{ kind: "client" as const, id: identities.clientId }]
      : []),
    ...(identities.sessionId
      ? [{ kind: "session" as const, id: identities.sessionId }]
      : []),
  ];
  for (const identity of candidates) {
    const alias = snapshot.agentAliases.find(
      (item) => item.kind === identity.kind && item.id === identity.id,
    );
    if (alias) return alias.alias;
  }
  return undefined;
}

function outputObservation(event: ConsoleTelemetryEvent): OutputObservation {
  const value = event.outputFiles;
  const names = new Set<string>();
  for (const rawFile of value.value ?? []) {
    const file = rawFile as TelemetryFileReferenceWithOwnedResult;
    const name =
      file.ownedResult?.value?.name ??
      (file.path.value ? basename(file.path.value) : null);
    if (name) names.add(name);
  }
  return { state: value.availability, names, reason: value.reason };
}

function channelOutputName(field: OutputChannelField): string {
  return field === "stdout"
    ? "stdout.txt"
    : field === "stderr"
      ? "stderr.txt"
      : "rpc-result.json";
}

function historyAvailability(
  histories: readonly ConsoleProjectHistoryRead[],
  collection: string,
): ConsoleSourceStatus {
  if (histories.length === 0)
    return {
      state: "no-data",
      source: `project-history:${collection}`,
      observedAt: null,
    };
  return combinedSource(
    histories.map((history) => historySource(history, collection)),
    `project-history:${collection}`,
  );
}

function telemetryData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(telemetryData);
  const current = asRecord(value);
  if (!current) return value;
  if ("value" in current && "availability" in current)
    return telemetryData(current["value"]);
  return Object.fromEntries(
    Object.entries(current).map(([key, item]) => [key, telemetryData(item)]),
  );
}

function systemRecord(snapshot: ConsoleTelemetrySnapshot): ConsoleQueryRecord {
  const host = snapshot.host;
  return {
    id: snapshot.projectId.value ?? "global-system",
    projectId: snapshot.projectId.value,
    hostname: host.hostname.value,
    cpuPercent: host.cpuPercent.value,
    ramUsedBytes: host.ramUsedBytes.value,
    ramTotalBytes: host.ramTotalBytes.value,
    swapUsedBytes: host.swapUsedBytes.value,
    swapTotalBytes: host.swapTotalBytes.value,
    load: host.load.value,
    diskUsedBytes: host.diskUsedBytes.value,
    diskTotalBytes: host.diskTotalBytes.value,
    networkInterface: host.networkInterface.value,
    rxBytesPerSecond: host.rxBytesPerSecond.value,
    txBytesPerSecond: host.txBytesPerSecond.value,
    uptimeSeconds: host.uptimeSeconds.value,
    processCount: host.processCount.value,
    panelProcess: telemetryData(snapshot.processes.panel),
    brokerProcess: telemetryData(snapshot.processes.broker),
    workers: telemetryData(snapshot.processes.workers.value),
    locks: telemetryData(snapshot.locks),
  };
}

function systemSource(snapshot: ConsoleTelemetrySnapshot): ConsoleSourceStatus {
  const values = [
    ...Object.values(snapshot.host),
    ...Object.values(snapshot.processes.panel),
    ...Object.values(snapshot.processes.broker),
    snapshot.processes.workers,
    ...Object.values(snapshot.locks),
  ];
  return combinedSource(
    values.map((value) => telemetrySource(value, "system-metric")),
    "passive-console-system-telemetry",
  );
}

function fileId(reference: HistorySnapshot["fileReferences"][number]): string {
  return reference.artifactId ?? reference.fileId ?? reference.id;
}

function matchingTelemetryFile(
  reference: HistorySnapshot["fileReferences"][number],
): TelemetryFileReferenceWithOwnedResult | null {
  const sourceFiles = reference.event.sourceFiles.value ?? [];
  const outputFiles = reference.event.outputFiles.value ?? [];
  const candidates = [...sourceFiles, ...outputFiles];
  const matched = candidates.find(
    (candidate) =>
      (reference.artifactId !== null &&
        candidate.artifactId.value === reference.artifactId) ||
      (reference.fileId !== null &&
        candidate.fileId.value === reference.fileId) ||
      (reference.path !== null && candidate.path.value === reference.path),
  );
  if (matched) return matched as TelemetryFileReferenceWithOwnedResult;
  const index = Number(reference.id.slice(reference.id.lastIndexOf(":") + 1));
  if (!Number.isSafeInteger(index) || index < 0) return null;
  const indexed = candidates[index];
  if (!indexed) return null;
  return indexed.kind === reference.kind ? indexed : null;
}

function fileLocator(
  projectId: string,
  reference: HistorySnapshot["fileReferences"][number],
): { locator: ConsoleArtifactLocator; sourceHash: string | null } {
  const matched = matchingTelemetryFile(reference);
  const ownedResult = matched?.ownedResult?.value;
  const artifactId = reference.artifactId ?? matched?.artifactId.value;
  const path = reference.path ?? matched?.path.value;
  const sha256 =
    reference.sha256 ?? matched?.sha256.value ?? ownedResult?.sha256 ?? null;
  if (
    ownedResult &&
    ownedResult.jobId === reference.jobId &&
    ownedResult.version === 1
  )
    return {
      locator: { type: "owned-result", reference: ownedResult },
      sourceHash: ownedResult.sha256,
    };
  if (path !== null && path !== undefined)
    return {
      locator: {
        type: "project-file",
        path,
        bytes: null,
        sha256,
      },
      sourceHash: sha256,
    };
  const identity = reference.event.identity;
  const documentId = identity.documentId.value;
  const clientId = identity.clientId.value;
  const requestId = identity.requestId.value;
  const fileHash = sha256;
  if (artifactId && documentId && clientId && requestId && fileHash)
    return {
      locator: {
        type: "artifact-store",
        context: {
          clientId,
          requestId,
          sessionId: identity.sessionId.value,
          projectId,
          documentId,
          instanceId: null,
          purpose: identity.purpose.value,
        },
        sha256: fileHash,
      },
      sourceHash: fileHash,
    };
  return {
    locator: { type: "missing" },
    sourceHash: fileHash,
  };
}

type ArtifactTarget = {
  readonly taskKey: string;
  readonly field:
    | "originalSource"
    | "sentSource"
    | "currentFile"
    | "response"
    | "stdout"
    | "stderr"
    | "rpc";
  readonly kind: ConsoleArtifactKind;
  readonly artifactId: string;
  readonly sourceHash: string | null;
  readonly locator: ConsoleArtifactLocator;
  readonly provenance: string | null;
};

function artifactTarget(
  projectId: string,
  reference: HistorySnapshot["fileReferences"][number],
): ArtifactTarget | null {
  if (!reference.jobId) return null;
  const matched = matchingTelemetryFile(reference);
  const provenance = reference.provenance ?? matched?.provenance.value ?? null;
  let field: ArtifactTarget["field"] | null = null;
  let kind: ConsoleArtifactKind | null = null;
  if (reference.kind === "source") {
    if (provenance === "queue-state.job.sourceReferences") {
      field = "originalSource";
      kind = "original-source";
    } else if (provenance === "queue-state.job.request.inputFiles") {
      field = "sentSource";
      kind = "sent-source";
    } else if (provenance === "queue-state.job.currentFile") {
      field = "currentFile";
      kind = "current-file";
    }
  } else if (reference.kind === "output") {
    const resultName = matched?.ownedResult?.value?.name;
    const path = reference.path ?? matched?.path.value ?? null;
    const name = resultName ?? (path ? basename(path) : null);
    if (name === "stdout.txt") {
      field = "stdout";
      kind = "stdout";
    } else if (name === "stderr.txt") {
      field = "stderr";
      kind = "stderr";
    } else if (name === "rpc-result.json") {
      field = "rpc";
      kind = "rpc";
    } else if (reference.artifactId) {
      field = "response";
      kind = "response";
    }
  }
  if (!field || !kind) return null;
  const { locator, sourceHash } = fileLocator(projectId, reference);
  return {
    taskKey: taskKey(projectId, reference.jobId),
    field,
    kind,
    artifactId:
      reference.artifactId ??
      matched?.artifactId.value ??
      reference.fileId ??
      reference.id,
    sourceHash,
    locator,
    provenance: reference.provenance,
  };
}

function outputHash(locator: ConsoleArtifactLocator): string | null {
  if (locator.type === "project-file") return locator.sha256;
  if (locator.type === "owned-result") return locator.reference.sha256;
  if (locator.type === "artifact-store") return locator.sha256;
  return null;
}

function outputProvenance(
  locator: ConsoleArtifactLocator,
): ConsoleArtifactOutputProvenance | null {
  if (locator.type === "project-file") return "retained-project-file";
  if (locator.type === "owned-result") return "retained-owned-result";
  if (locator.type === "artifact-store") return "retained-artifact-store";
  return null;
}

function attachArtifacts(
  tasks: Map<string, ConsoleQueryRecord>,
  histories: readonly ConsoleProjectHistoryRead[],
  outputObservations: ReadonlyMap<string, OutputObservation>,
  stageHashes: ReadonlyMap<string, string>,
): ConsoleOwnedArtifactReference[] {
  const targets = new Map<
    string,
    Map<ArtifactTarget["field"], ArtifactTarget[]>
  >();
  const refs: ConsoleOwnedArtifactReference[] = [];
  for (const read of histories) {
    const snapshot = read.snapshot;
    if (!snapshot) continue;
    for (const file of snapshot.fileReferences) {
      const target = artifactTarget(read.project.projectId, file);
      if (!target || !tasks.has(target.taskKey)) continue;
      const list = targets.get(target.taskKey) ?? new Map();
      const fieldRefs = list.get(target.field) ?? [];
      fieldRefs.push(target);
      list.set(target.field, fieldRefs);
      targets.set(target.taskKey, list);
    }
    for (const record of snapshot.events) {
      const event = record.event;
      const taskId = event.identity.jobId.value;
      if (!taskId) continue;
      const taskKeyValue = taskKey(read.project.projectId, taskId);
      if (!tasks.has(taskKeyValue)) continue;
      const eventId =
        event.metadata.eventId.value ??
        `history-${snapshot.databaseId}-${record.rowId}`;
      const stageHash = stageHashes.get(
        JSON.stringify([read.project.projectId, eventId]),
      );
      if (isStageEvent(event) && !stageHash) continue;
      const content = JSON.stringify(event);
      refs.push({
        projectId: read.project.projectId,
        taskId,
        artifactId: eventId,
        kind: "event",
        locator:
          Buffer.byteLength(content, "utf8") <= 256 * 1024
            ? { type: "inline-event", content }
            : { type: "error" },
      });
      const task = tasks.get(taskKeyValue)!;
      const artifacts = asRecord(task.artifacts) as ConsoleTaskArtifacts | null;
      const links = [...(artifacts?.events ?? [])];
      if (!links.some((link) => link.artifactId === eventId))
        links.push({
          artifactId: eventId,
          ...(stageHash ? { sourceHash: stageHash } : {}),
        });
      tasks.set(taskKeyValue, {
        ...task,
        artifacts: { ...artifacts, events: links },
      });
    }
  }

  for (const [key, fields] of targets) {
    const task = tasks.get(key);
    if (!task) continue;
    const [projectId, taskId] = JSON.parse(key) as [string, string];
    const existing = asRecord(task.artifacts) as ConsoleTaskArtifacts | null;
    const artifacts: Data = { ...existing };
    for (const field of [
      "originalSource",
      "sentSource",
      "currentFile",
      "response",
      "stdout",
      "stderr",
      "rpc",
    ] as const) {
      const candidates = fields.get(field) ?? [];
      const uniqueByIdentity = new Map<string, ArtifactTarget>();
      for (const candidate of candidates) {
        const identity = JSON.stringify([
          candidate.artifactId,
          candidate.sourceHash,
          candidate.kind,
        ]);
        const existing = uniqueByIdentity.get(identity);
        if (!existing || candidate.locator.type === "owned-result")
          uniqueByIdentity.set(identity, candidate);
      }
      const unique = [...uniqueByIdentity.values()];
      if (unique.length !== 1) {
        if (candidates.length)
          artifacts[field] =
            field === "stdout" || field === "stderr" || field === "rpc"
              ? {
                  state: "unavailable",
                  reason: "MULTIPLE_RETAINED_ARTIFACT_VERSIONS",
                }
              : undefined;
        continue;
      }
      const candidate = unique[0]!;
      refs.push({
        projectId,
        taskId,
        artifactId: candidate.artifactId,
        kind: candidate.kind,
        locator: candidate.locator,
      });
      const hash = outputHash(candidate.locator);
      const provenance = outputProvenance(candidate.locator);
      const usable = !!hash && !!provenance && hash === candidate.sourceHash;
      if (field === "stdout" || field === "stderr" || field === "rpc") {
        artifacts[field] = usable
          ? {
              state: "available",
              artifactId: candidate.artifactId,
              sourceHash: hash,
              provenance,
            }
          : {
              state: "unavailable",
              reason: "RETAINED_OUTPUT_HASH_OR_LOCATION_UNAVAILABLE",
            };
      } else if (usable) {
        artifacts[field] = {
          artifactId: candidate.artifactId,
          sourceHash: hash,
        };
      }
      if (field === "rpc" && usable) {
        artifacts["response"] = {
          artifactId: candidate.artifactId,
          sourceHash: hash,
        };
        refs.push({
          projectId,
          taskId,
          artifactId: candidate.artifactId,
          kind: "response",
          locator: candidate.locator,
        });
      }
    }
    tasks.set(key, { ...task, artifacts: artifacts as ConsoleTaskArtifacts });
  }
  for (const [key, observation] of outputObservations) {
    const task = tasks.get(key);
    if (!task) continue;
    const artifacts = {
      ...(asRecord(task.artifacts) ?? {}),
    } as Data;
    for (const field of ["stdout", "stderr", "rpc"] as const) {
      if (artifacts[field] !== undefined) continue;
      if (
        observation.state === "available" &&
        !observation.names.has(channelOutputName(field))
      )
        artifacts[field] = {
          state: "missing",
          reason: "OUTPUT_CHANNEL_NOT_RETAINED",
        };
      else if (
        observation.state !== "available" &&
        observation.state !== "stale"
      )
        artifacts[field] = {
          state: "unavailable",
          reason:
            observation.reason ??
            `OUTPUT_SOURCE_${observation.state.toUpperCase()}`,
        };
      else if (observation.state === "stale")
        artifacts[field] = {
          state: "unavailable",
          reason: "OUTPUT_SOURCE_STALE",
        };
    }
    tasks.set(key, { ...task, artifacts: artifacts as ConsoleTaskArtifacts });
  }
  return refs;
}

export function mapConsoleQuerySnapshot(input: {
  readonly scope: ConsoleQueryScope;
  readonly revision: ConsoleRevision;
  readonly capturedAt: number;
  readonly registry: {
    readonly revision: number;
    readonly projects: readonly ProjectRegistryEntry[];
  };
  readonly histories: readonly ConsoleProjectHistoryRead[];
  readonly telemetry: ConsoleTelemetrySnapshot;
}): ConsoleQueryDataSnapshot {
  const projectIds = new Set(
    input.registry.projects.map((entry) => entry.projectId),
  );
  const historiesByProject = new Map(
    input.histories.map((history) => [history.project.projectId, history]),
  );
  const tasks = new Map<string, ConsoleQueryRecord>();
  const outputObservations = new Map<string, OutputObservation>();
  const sessions = new Map<string, ConsoleQueryRecord>();
  const agents = new Map<string, ConsoleQueryRecord>();
  const logs: ConsoleQueryRecord[] = [];
  const files: ConsoleQueryRecord[] = [];
  const stageHashes = new Map<string, string>();
  let invalidStageReference = false;
  let missingTaskIdentity = false;
  let missingLogTime = false;

  for (const read of input.histories) {
    const snapshot = read.snapshot;
    if (!snapshot) continue;
    for (const job of snapshot.jobs) {
      const row = taskFromEvent(job.event, read.project.projectId, job.jobId);
      outputObservations.set(
        taskKey(read.project.projectId, job.jobId),
        outputObservation(job.event),
      );
      if (!row) {
        missingTaskIdentity = true;
        continue;
      }
      tasks.set(taskKey(read.project.projectId, job.jobId), row);
    }
    for (const session of snapshot.sessions) {
      const row = {
        id: session.sessionId,
        projectId: read.project.projectId,
        sessionId: session.sessionId,
        clientId: session.clientId,
        agentId: session.agentId,
        presence: session.presence,
        timestamp: session.observedAtMs,
        ...(exactAgentAlias(snapshot, {
          agentId: session.agentId,
          clientId: session.clientId,
          sessionId: session.sessionId,
        })
          ? {
              alias: exactAgentAlias(snapshot, {
                agentId: session.agentId,
                clientId: session.clientId,
                sessionId: session.sessionId,
              }),
            }
          : {}),
      };
      sessions.set(taskKey(read.project.projectId, session.sessionId), row);
      if (session.agentId)
        agents.set(taskKey(read.project.projectId, session.agentId), {
          id: session.agentId,
          projectId: read.project.projectId,
          agentId: session.agentId,
          clientId: session.clientId,
          sessionId: session.sessionId,
          ...(exactAgentAlias(snapshot, {
            agentId: session.agentId,
            clientId: session.clientId,
            sessionId: session.sessionId,
          })
            ? {
                alias: exactAgentAlias(snapshot, {
                  agentId: session.agentId,
                  clientId: session.clientId,
                  sessionId: session.sessionId,
                }),
              }
            : {}),
          ...(session.event.actor.agent.value
            ? { name: session.event.actor.agent.value }
            : {}),
          presence: session.presence,
        });
    }
    for (const eventRecord of snapshot.events) {
      const event = eventRecord.event;
      const eventProject = eventProjectId(event, read.project.projectId);
      if (eventProject !== read.project.projectId) continue;
      const eventTime = consoleLogTimestamp(event);
      if (eventTime.timestamp === null) missingLogTime = true;
      const rowId =
        event.metadata.eventId.value ??
        `history-${snapshot.databaseId}-${eventRecord.rowId}`;
      if (isStageEvent(event)) {
        const taskId = event.identity.jobId.value;
        const hash = taskId
          ? stageEntryHash(event, read.project, taskId)
          : null;
        if (hash)
          stageHashes.set(
            JSON.stringify([read.project.projectId, rowId]),
            hash,
          );
        else invalidStageReference = true;
      }
      const eventName = event.eventName.value ?? event.eventType;
      logs.push({
        id: rowId,
        projectId: read.project.projectId,
        taskId: event.identity.jobId.value,
        requestId: event.identity.requestId.value,
        clientId: event.identity.clientId.value,
        timestamp: eventTime.timestamp,
        ...(eventTime.timestampRaw === undefined
          ? {}
          : { timestampRaw: eventTime.timestampRaw }),
        ...(event.eventType ? { level: event.eventType } : {}),
        ...(eventName ? { message: eventName } : {}),
      });
    }
    for (const reference of snapshot.fileReferences) {
      files.push({
        id: reference.id,
        projectId: read.project.projectId,
        taskId: reference.jobId,
        artifactId: fileId(reference),
        fileId: reference.fileId,
        kind: reference.kind,
        sha256: reference.sha256,
        provenance: reference.provenance,
        timestamp: reference.observedAtMs,
      });
    }
  }

  const telemetryState = sourceState(input.telemetry.events.availability);
  const latestTelemetryEvents = input.telemetry.events.value ?? [];
  for (const event of latestTelemetryEvents) {
    const projectId = event.identity.projectId.value;
    const id = event.identity.jobId.value;
    if (!projectId || !id || !projectIds.has(projectId)) {
      missingTaskIdentity = true;
      continue;
    }
    if (event.eventType !== "queue.job-snapshot") continue;
    const row = taskFromEvent(event, projectId);
    if (!row) {
      missingTaskIdentity = true;
      continue;
    }
    const key = taskKey(projectId, id);
    outputObservations.set(key, outputObservation(event));
    const previous = tasks.get(key);
    tasks.set(key, previous ? { ...previous, ...row } : row);
  }

  for (const presence of input.telemetry.presenceObservations.records) {
    const projectId = presence.projectId;
    if (!projectId || !projectIds.has(projectId)) continue;
    if (presence.sessionId) {
      const key = taskKey(projectId, presence.sessionId);
      const previous = sessions.get(key);
      const previousClientId = previous?.["clientId"];
      const previousAgentId = previous?.["agentId"];
      const previousPresence = previous?.["presence"];
      const clientId =
        presence.clientId ??
        (typeof previousClientId === "string" || previousClientId === null
          ? previousClientId
          : undefined);
      const agentId =
        presence.agentId ??
        (typeof previousAgentId === "string" || previousAgentId === null
          ? previousAgentId
          : undefined);
      const currentPresence =
        presence.presence ??
        (typeof previousPresence === "string" || previousPresence === null
          ? previousPresence
          : undefined);
      sessions.set(key, {
        ...previous,
        id: presence.sessionId,
        projectId,
        sessionId: presence.sessionId,
        ...(clientId === undefined ? {} : { clientId }),
        ...(agentId === undefined ? {} : { agentId }),
        ...(currentPresence === undefined ? {} : { presence: currentPresence }),
        timestamp: presence.observedAtMs,
        ...(exactAgentAlias(historiesByProject.get(projectId)?.snapshot, {
          agentId: agentId ?? null,
          clientId: clientId ?? null,
          sessionId: presence.sessionId,
        })
          ? {
              alias: exactAgentAlias(
                historiesByProject.get(projectId)?.snapshot,
                {
                  agentId: agentId ?? null,
                  clientId: clientId ?? null,
                  sessionId: presence.sessionId,
                },
              ),
            }
          : {}),
      });
    }
    if (presence.agentId) {
      const key = taskKey(projectId, presence.agentId);
      agents.set(key, {
        ...agents.get(key),
        id: presence.agentId,
        projectId,
        agentId: presence.agentId,
        clientId: presence.clientId ?? agents.get(key)?.["clientId"] ?? null,
        sessionId: presence.sessionId ?? null,
        ...(exactAgentAlias(historiesByProject.get(projectId)?.snapshot, {
          agentId: presence.agentId,
          clientId: presence.clientId ?? agents.get(key)?.["clientId"] ?? null,
          sessionId: presence.sessionId ?? null,
        })
          ? {
              alias: exactAgentAlias(
                historiesByProject.get(projectId)?.snapshot,
                {
                  agentId: presence.agentId,
                  clientId:
                    presence.clientId ?? agents.get(key)?.["clientId"] ?? null,
                  sessionId: presence.sessionId ?? null,
                },
              ),
            }
          : {}),
        ...(presence.agent ? { name: presence.agent } : {}),
        ...(presence.model ? { model: presence.model } : {}),
        ...(presence.role ? { role: presence.role } : {}),
        presence: presence.presence ?? "unknown",
      });
    }
  }

  const artifactRefs = attachArtifacts(
    tasks,
    input.histories,
    outputObservations,
    stageHashes,
  );
  const finalTasks = [...tasks.values()];

  const projectRows = input.registry.projects
    .filter(
      (project) =>
        input.scope.kind === "global" ||
        project.projectId === input.scope.projectId,
    )
    .map((project) => ({
      id: project.projectId,
      name:
        (historiesByProject.get(project.projectId)?.snapshot?.aliases[0] ??
          basename(project.path)) ||
        project.projectId,
      monitoring: project.monitoring,
      archivedAtMs: project.archivedAtMs,
    }));
  const telemetryOverview = input.telemetry.overview;
  const overview: ConsoleOverviewRecord = {
    id: "overview",
    pendingProject: metric(telemetryOverview.pendingProject),
    running: metric(telemetryOverview.running),
    unresolved: metric(telemetryOverview.unresolved),
    samples: metric(telemetryOverview.samples),
    failedExecutions: metric(telemetryOverview.failedExecutions),
    waitMedianMs: metric(telemetryOverview.waitMedianMs),
    waitP95Ms: metric(telemetryOverview.waitP95Ms),
    liveReportingSessions: metric(telemetryOverview.liveReportingSessions),
    sampleWindow: metric(telemetryOverview.sampleWindow),
  };
  const hosts = [systemRecord(input.telemetry)];
  const historyFor = (collection: string) =>
    historyAvailability(input.histories, collection);
  const presenceSources = [
    telemetrySource(input.telemetry.presence.clientCount, "presence.clients"),
    telemetrySource(input.telemetry.presence.sessionCount, "presence.sessions"),
    telemetrySource(
      input.telemetry.presence.declaredAgentCount,
      "presence.agents",
    ),
  ];
  const sources: Record<string, ConsoleSourceStatus> = {
    projects: {
      state: input.registry.projects.length ? "available" : "no-data",
      source: "registered-projects",
      observedAt: input.registry.projects.length
        ? Math.max(
            ...input.registry.projects.map((project) => project.updatedAtMs),
          )
        : null,
    },
    overview: combinedSource(
      [
        telemetrySource(
          telemetryOverview.pendingProject,
          "overview.pendingProject",
        ),
        telemetrySource(telemetryOverview.running, "overview.running"),
        telemetrySource(telemetryOverview.unresolved, "overview.unresolved"),
        telemetrySource(telemetryOverview.samples, "overview.samples"),
        telemetrySource(
          telemetryOverview.failedExecutions,
          "overview.failedExecutions",
        ),
        telemetrySource(
          telemetryOverview.waitMedianMs,
          "overview.waitMedianMs",
        ),
        telemetrySource(telemetryOverview.waitP95Ms, "overview.waitP95Ms"),
        telemetrySource(
          telemetryOverview.liveReportingSessions,
          "overview.liveReportingSessions",
        ),
        telemetrySource(
          telemetryOverview.sampleWindow,
          "overview.sampleWindow",
        ),
      ],
      "canonical-console-telemetry-overview",
    ),
    tasks: combinedSource(
      [
        {
          state: telemetryState,
          source: input.telemetry.events.source,
          observedAt: input.telemetry.events.observedAtMs,
        },
        historyFor("tasks"),
        missingTaskIdentity
          ? {
              state: "partial",
              source: "task-identity-joins",
              observedAt: null,
              reason:
                "Some retained job rows lack a stable project/job identity.",
            }
          : null,
        invalidStageReference
          ? {
              state: "partial",
              source: "retained-stage-journal-references",
              observedAt: null,
              reason:
                "A retained stage event has no exact hash-bound stage reference.",
            }
          : null,
      ],
      "project-history-and-passive-queue-source",
    ),
    agents: combinedSource(presenceSources, "passive-presence-agents"),
    sessions: combinedSource(presenceSources, "passive-presence-sessions"),
    files: historyFor("files"),
    logs: combinedSource(
      [
        historyFor("logs"),
        missingLogTime
          ? {
              state: "partial",
              source: "event-occurrence-timestamps",
              observedAt: null,
              reason: "Some retained events have no valid occurred-at time.",
            }
          : null,
        invalidStageReference
          ? {
              state: "partial",
              source: "retained-stage-journal-references",
              observedAt: null,
              reason:
                "A retained stage event has no exact hash-bound stage reference.",
            }
          : null,
      ],
      "retained-project-history-events",
    ),
    system: systemSource(input.telemetry),
  };
  const capturedAtCandidates = [
    ...input.histories.flatMap((history) =>
      history.snapshot ? [history.snapshot.capturedAtMs] : [],
    ),
    telemetryOverview.sampleWindow.value?.to,
    input.telemetry.overview.running.readAtMs,
  ].filter(
    (value): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
  );
  const capturedAt = input.capturedAt ?? Math.max(...capturedAtCandidates);
  if (!Number.isSafeInteger(capturedAt) || capturedAt < 0)
    throw new Error("Query snapshot has no source-reported capture time");
  const revision = input.revision;
  if (!Number.isSafeInteger(revision.revision) || !revision.epoch)
    throw new Error("Query snapshot revision is invalid");

  return {
    scope: input.scope,
    revision,
    capturedAt,
    collections: {
      projects: projectRows,
      overview: [overview],
      tasks: finalTasks,
      agents: [...agents.values()],
      sessions: [...sessions.values()],
      files,
      logs,
      system: hosts,
    },
    sources,
    artifacts: artifactRefs,
  };
}
