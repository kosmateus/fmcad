import type { JsonValue } from "../domain/contracts";
import type {
  ProjectHistoryEvent,
  ProjectHistoryIngestBatch,
  ProjectHistoryIngestResult,
  ProjectHistoryReplayCursor,
} from "../domain/project-history";
import type {
  ProjectHistorySourceReader,
  ProjectHistoryStore,
} from "../ports/project-history";

export const PROJECT_HISTORY_MAX_EVENT_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 16;

function assertJson(value: unknown, depth: number): asserts value is JsonValue {
  if (depth > MAX_JSON_DEPTH)
    throw new Error("Event JSON is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item, depth + 1);
    return;
  }
  if (typeof value !== "object")
    throw new Error("Event contains non-JSON data");
  for (const [key, item] of Object.entries(value)) {
    if (
      /^(stdout|stderr|stdoutText|stderrText|rpcResult|response|responseText|sourceText|sentSource|outputText)$/iu.test(
        key,
      )
    ) {
      throw Object.assign(
        new Error(
          "Large result content must remain in the project artifact store",
        ),
        { code: "LARGE_ARTIFACT_INLINE" },
      );
    }
    assertJson(item, depth + 1);
  }
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function validateProjectHistoryEvent<
  TSourceEvent extends ProjectHistoryEvent,
>(
  value: ProjectHistoryEvent<TSourceEvent>,
  expectedProjectId?: string,
): string {
  const event = value as unknown;
  const root = record(event);
  if (!root || root["version"] !== 1)
    throw new Error("Unsupported project history event version");
  if (
    typeof root["eventType"] !== "string" ||
    !/^[a-z][a-z0-9_.-]{0,127}$/u.test(root["eventType"])
  )
    throw new Error("Project history event type is invalid");
  const metadata = record(root["metadata"]);
  const identity = record(root["identity"]);
  const unwrap = (input: unknown): unknown => {
    const wrapper = record(input);
    return wrapper && Object.hasOwn(wrapper, "value")
      ? wrapper["value"]
      : input;
  };
  const projectId = unwrap(identity?.["projectId"]);
  if (
    projectId !== null &&
    projectId !== undefined &&
    (typeof projectId !== "string" ||
      !projectId.trim() ||
      projectId.length > 256 ||
      /[\x00-\x1f\x7f]/u.test(projectId))
  )
    throw new Error("Project history event project identity is invalid");
  if (expectedProjectId && (projectId === null || projectId === undefined))
    throw Object.assign(
      new Error("Project history event has no canonical project identity"),
      { code: "HISTORY_PROJECT_ID_MISSING" },
    );
  if (
    expectedProjectId &&
    projectId !== null &&
    projectId !== undefined &&
    projectId !== expectedProjectId
  )
    throw Object.assign(
      new Error("Project history event belongs to another project"),
      { code: "PROJECT_ID_MISMATCH" },
    );
  const readAt = unwrap(metadata?.["readAtMs"]);
  if (typeof readAt !== "number" || !Number.isFinite(readAt) || readAt < 0)
    throw new Error("Source event must carry a non-negative readAtMs value");
  assertJson(event, 0);
  const serialized = JSON.stringify(event);
  if (utf8ByteLength(serialized) > PROJECT_HISTORY_MAX_EVENT_BYTES)
    throw Object.assign(new Error("Project history event exceeds size limit"), {
      code: "EVENT_TOO_LARGE",
    });
  return serialized;
}

/** Ingest a bounded source batch without manufacturing source identities/cursors. */
export function ingestProjectHistory<TSourceEvent extends ProjectHistoryEvent>(
  store: ProjectHistoryStore<TSourceEvent>,
  events: readonly ProjectHistoryEvent<TSourceEvent>[],
): ProjectHistoryIngestResult {
  return ingestProjectHistoryBatch(store, { events });
}

/** Persist events and producer-reported replay progress/gaps in one store transaction. */
export function ingestProjectHistoryBatch<
  TSourceEvent extends ProjectHistoryEvent,
>(
  store: ProjectHistoryStore<TSourceEvent>,
  batch: ProjectHistoryIngestBatch<TSourceEvent>,
): ProjectHistoryIngestResult {
  const { events } = batch;
  if (!Array.isArray(events))
    throw new Error("History events must be an array");
  if (events.length > 10_000)
    throw new Error("Project history batch exceeds the event limit");
  if (
    batch.readAtMs !== undefined &&
    (!Number.isFinite(batch.readAtMs) || batch.readAtMs < 0)
  )
    throw new Error(
      "Source cursor read timestamp must be non-negative and finite",
    );
  if (
    batch.observedAtMs !== undefined &&
    batch.observedAtMs !== null &&
    (!Number.isFinite(batch.observedAtMs) || batch.observedAtMs < 0)
  )
    throw new Error(
      "Source observation timestamp must be non-negative and finite",
    );
  if (
    batch.reason !== undefined &&
    batch.reason !== null &&
    (typeof batch.reason !== "string" ||
      batch.reason.length > 1024 ||
      /[\x00-\x1f\x7f]/u.test(batch.reason))
  )
    throw new Error("Source availability reason is invalid");
  if (
    batch.availability !== undefined &&
    !["available", "partial", "unavailable", "no-data"].includes(
      batch.availability,
    )
  )
    throw new Error("Source replay availability is invalid");
  for (const [label, value] of [
    ["source ID", batch.sourceId],
    ["epoch", batch.epoch],
  ] as const) {
    if (
      value !== undefined &&
      value !== null &&
      (!value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/u.test(value))
    )
      throw new Error(`Replay batch ${label} is invalid`);
  }
  if (batch.cursor) {
    const cursor = batch.cursor;
    for (const [label, value] of [
      ["source ID", cursor.sourceId],
      ["epoch", cursor.epoch],
    ] as const) {
      if (!value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/u.test(value))
        throw new Error(`Source cursor ${label} is invalid`);
    }
    if (
      !Number.isSafeInteger(cursor.position) ||
      cursor.position < 0 ||
      !["sequence", "revision"].includes(cursor.positionKind)
    )
      throw new Error("Source cursor position is invalid");
    if (
      cursor.eventId !== null &&
      (!cursor.eventId.trim() ||
        cursor.eventId.length > 512 ||
        /[\x00-\x1f\x7f]/u.test(cursor.eventId))
    )
      throw new Error("Source cursor event ID is invalid");
  }
  if ((batch.gaps?.length ?? 0) > 256)
    throw new Error("Source replay batch exceeds the gap limit");
  for (const gap of batch.gaps ?? []) {
    if (
      !gap.sourceId.trim() ||
      gap.sourceId.length > 256 ||
      /[\x00-\x1f\x7f]/u.test(gap.sourceId) ||
      !gap.epoch.trim() ||
      gap.epoch.length > 256 ||
      /[\x00-\x1f\x7f]/u.test(gap.epoch) ||
      gap.fromPosition === null ||
      !Number.isSafeInteger(gap.fromPosition) ||
      gap.fromPosition < 0 ||
      gap.toPosition === null ||
      !Number.isSafeInteger(gap.toPosition) ||
      gap.toPosition < gap.fromPosition ||
      !Number.isFinite(gap.detectedAtMs) ||
      gap.detectedAtMs < 0 ||
      typeof gap.reason !== "string" ||
      !gap.reason.trim()
    )
      throw new Error("Source replay gap is invalid");
  }
  for (const event of events)
    validateProjectHistoryEvent(event, store.projectId);
  return store.ingestBatch(batch);
}

/** One bounded pull from a retained producer; no polling, retries or synthesized cursor. */
export async function ingestRetainedProjectHistory<
  TSourceEvent extends ProjectHistoryEvent,
>(
  store: ProjectHistoryStore<TSourceEvent>,
  source: ProjectHistorySourceReader<TSourceEvent>,
  after: ProjectHistoryReplayCursor | null,
  limit = 256,
): Promise<ProjectHistoryIngestResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
    throw new Error(
      "Retained source read limit must be between 1 and 10000 events",
    );
  const batch = await source.read({ projectId: store.projectId, after, limit });
  if (!batch || !Array.isArray(batch.events) || batch.events.length > limit)
    throw new Error(
      "Retained source returned an invalid or oversized replay batch",
    );
  return ingestProjectHistoryBatch(store, batch);
}

export function setProjectHistoryAlias(
  store: ProjectHistoryStore,
  alias: string,
  nowMs: number,
) {
  if (!Number.isFinite(nowMs) || nowMs < 0)
    throw new Error("Alias timestamp must be a non-negative finite number");
  return store.setAlias(alias, nowMs);
}

export function setProjectHistoryLifecycle(
  store: ProjectHistoryStore,
  monitoring: boolean,
  archivedAtMs: number | null,
  nowMs: number,
) {
  if (typeof monitoring !== "boolean")
    throw new Error("Monitoring state must be boolean");
  if (
    !Number.isFinite(nowMs) ||
    nowMs < 0 ||
    (archivedAtMs !== null &&
      (!Number.isFinite(archivedAtMs) || archivedAtMs < 0))
  ) {
    throw new Error("Lifecycle timestamps must be non-negative and finite");
  }
  if (archivedAtMs !== null && monitoring)
    throw new Error("Archived projects cannot be monitored");
  return store.setLifecycle({ monitoring, archivedAtMs, updatedAtMs: nowMs });
}
