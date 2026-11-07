import {
  boundedConsoleTelemetryReplay,
  detectConsoleTelemetryGap,
  normalizeConsoleTelemetryJob,
} from "@fmcad/core";
import type { ConsoleTelemetryCursor } from "@fmcad/core";
import type {
  ProjectHistoryAvailability,
  ProjectHistoryIngestBatch,
} from "../../../../core/src/domain/project-history";
import type { ProjectHistorySourceReader } from "../../../../core/src/ports/project-history";
import type { ProjectRegistryStore } from "../../../../core/src/ports/project-registry";
import type {
  ConsoleTelemetryRead,
  QueueTelemetryRead,
} from "../../telemetry/console-telemetry.js";

export interface RetainedTelemetrySnapshotOptions {
  readonly projectId: string;
  readonly sourceId: string;
  readonly registry: ProjectRegistryStore;
  /** Existing scoped queue/job metadata reader only; no broad telemetry snapshot. */
  readonly read: (request: {
    readonly projectId: string;
    readonly projectDirectory: string;
  }) => ConsoleTelemetryRead<QueueTelemetryRead>;
  readonly now?: () => number;
  readonly maxEvents?: number;
}

function availability(
  result: ConsoleTelemetryRead<QueueTelemetryRead>,
): ProjectHistoryAvailability {
  if (result.status === "available")
    return result.value?.complete ? "available" : "partial";
  if (result.status === "stale" || result.status === "unknown")
    return "partial";
  return "unavailable";
}

function stableReason(
  result: ConsoleTelemetryRead<QueueTelemetryRead>,
): string {
  return typeof result.reason === "string" &&
    /^[A-Z0-9_]{1,128}$/u.test(result.reason)
    ? result.reason
    : "RETAINED_QUEUE_SOURCE_INCOMPLETE";
}

function validEpoch(value: string | null | undefined): string | null {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !/[\x00-\x1f\x7f]/u.test(value)
    ? value
    : null;
}

function validPosition(value: number | null | undefined): number | null {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasForeignProject(job: unknown, projectId: string): boolean {
  const record = isRecord(job) ? job : null;
  const request = isRecord(record?.["request"]) ? record["request"] : null;
  const context = isRecord(request?.["clientContext"])
    ? request["clientContext"]
    : null;
  return [
    record?.["projectId"],
    request?.["projectId"],
    context?.["projectId"],
  ].some((value) => typeof value === "string" && value !== projectId);
}

function hasStableJobIdentity(job: unknown): boolean {
  if (!isRecord(job)) return false;
  return [job["id"], job["requestId"], job["turnId"]].some(
    (value) =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= 256 &&
      !/[\x00-\x1f\x7f]/u.test(value),
  );
}

function unavailable(
  sourceId: string,
  epoch: string | null,
  readAtMs: number,
  reason: string,
  state: ProjectHistoryAvailability = "unavailable",
): ProjectHistoryIngestBatch {
  return { events: [], sourceId, epoch, availability: state, reason, readAtMs };
}

/** Reads only the existing project-scoped retained queue/job metadata source. */
export function createRetainedTelemetrySnapshotReader(
  options: RetainedTelemetrySnapshotOptions,
): ProjectHistorySourceReader {
  if (!options.projectId.trim() || options.projectId.length > 256)
    throw new Error("Retained telemetry project ID is invalid");
  if (
    !options.sourceId.trim() ||
    options.sourceId.length > 256 ||
    /[\x00-\x1f\x7f]/u.test(options.sourceId)
  )
    throw new Error("Retained telemetry source ID is invalid");
  const maxEvents = options.maxEvents ?? 512;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 10_000)
    throw new Error(
      "Retained telemetry event bound must be between 1 and 10000",
    );

  return {
    async read(input): Promise<ProjectHistoryIngestBatch> {
      if (input.projectId !== options.projectId)
        throw Object.assign(new Error("Retained telemetry project mismatch"), {
          code: "PROJECT_ID_MISMATCH",
        });
      const project = options.registry.lookup(options.projectId);
      if (!project)
        throw Object.assign(
          new Error("Project is not in the explicit registry"),
          {
            code: "PROJECT_NOT_REGISTERED",
          },
        );
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > maxEvents
      )
        throw new Error(
          `Retained telemetry page bound must be between 1 and ${maxEvents}`,
        );
      const readAtMs = now();
      if (!Number.isSafeInteger(readAtMs) || readAtMs < 0)
        throw new Error("Retained telemetry reader clock is invalid");

      let source: ConsoleTelemetryRead<QueueTelemetryRead>;
      try {
        source = options.read({
          projectId: options.projectId,
          projectDirectory: project.path,
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return unavailable(
          options.sourceId,
          null,
          readAtMs,
          typeof code === "string" && /^[A-Z0-9_]{1,128}$/u.test(code)
            ? code
            : "RETAINED_QUEUE_SOURCE_READ_FAILED",
        );
      }

      const epoch = validEpoch(source.epoch);
      const reportedSourceId = source.sourceId;
      if (reportedSourceId !== options.sourceId)
        return unavailable(
          options.sourceId,
          epoch,
          readAtMs,
          reportedSourceId === null || reportedSourceId === undefined
            ? "RETAINED_QUEUE_SOURCE_ID_UNKNOWN"
            : "RETAINED_QUEUE_SOURCE_ID_MISMATCH",
          reportedSourceId === null || reportedSourceId === undefined
            ? "partial"
            : "unavailable",
        );
      if (input.after !== null && input.after.sourceId !== options.sourceId)
        return unavailable(
          options.sourceId,
          epoch,
          readAtMs,
          "RETAINED_QUEUE_SOURCE_ID_MISMATCH",
        );
      if (input.after && epoch !== null && input.after.epoch !== epoch)
        return unavailable(
          options.sourceId,
          epoch,
          readAtMs,
          "RETAINED_QUEUE_SOURCE_EPOCH_CHANGED",
          "partial",
        );
      if (input.after && epoch === null)
        return unavailable(
          options.sourceId,
          null,
          readAtMs,
          "RETAINED_QUEUE_SOURCE_EPOCH_UNKNOWN",
          "partial",
        );

      const state = availability(source);
      const queue = source.value;
      if (!queue)
        return unavailable(
          options.sourceId,
          epoch,
          readAtMs,
          stableReason(source),
          state,
        );
      if (
        !Array.isArray(queue.jobs) ||
        typeof queue.complete !== "boolean" ||
        queue.scope !== "project"
      )
        return unavailable(
          options.sourceId,
          epoch,
          readAtMs,
          "RETAINED_QUEUE_SCOPE_NOT_PROJECT",
        );
      if (queue.jobs.some((job) => hasForeignProject(job, options.projectId)))
        return unavailable(
          options.sourceId,
          epoch,
          readAtMs,
          "RETAINED_QUEUE_JOB_PROJECT_MISMATCH",
        );
      if (queue.jobs.some((job) => !hasStableJobIdentity(job)))
        return unavailable(
          options.sourceId,
          epoch,
          readAtMs,
          "RETAINED_QUEUE_JOB_IDENTITY_UNAVAILABLE",
          "partial",
        );
      if (queue.jobs.length > maxEvents)
        return unavailable(
          options.sourceId,
          epoch,
          readAtMs,
          "RETAINED_QUEUE_JOB_BOUND_EXCEEDED",
          "partial",
        );

      const sequence = validPosition(source.sequence);
      const revision =
        sequence === null ? validPosition(source.revision) : null;
      const position = sequence ?? revision;
      const positionKind = sequence === null ? "revision" : "sequence";
      if (epoch === null || position === null)
        return unavailable(
          options.sourceId,
          epoch,
          readAtMs,
          "RETAINED_QUEUE_SOURCE_CURSOR_UNKNOWN",
          "partial",
        );
      if (
        input.after &&
        (position === null || input.after.positionKind !== positionKind)
      )
        return unavailable(
          options.sourceId,
          epoch,
          readAtMs,
          "RETAINED_QUEUE_CURSOR_UNAVAILABLE",
          "partial",
        );
      if (input.after && position !== null && input.after.position > position)
        return unavailable(
          options.sourceId,
          epoch,
          readAtMs,
          "RETAINED_QUEUE_CURSOR_REGRESSED",
          "partial",
        );

      const freshness = source.status;
      const events = queue.jobs.map((job) =>
        normalizeConsoleTelemetryJob(job, {
          projectId: options.projectId,
          sourceId: options.sourceId,
          epoch,
          sequence,
          revision,
          observedAtMs: validPosition(source.observedAtMs),
          readAtMs,
          transport: null,
          freshness,
          eventType: "queue.job-snapshot",
        }),
      );
      if (
        events.some(
          (event) => event.identity.projectId.value !== options.projectId,
        )
      )
        return unavailable(
          options.sourceId,
          epoch,
          readAtMs,
          "RETAINED_QUEUE_EVENT_PROJECT_MISMATCH",
        );

      const highWater: ConsoleTelemetryCursor = {
        sourceId: options.sourceId,
        epoch,
        position,
        positionKind,
        eventId:
          events
            .map((event) => event.metadata.eventId.value)
            .filter((eventId): eventId is string => eventId !== null)
            .sort((left, right) => left.localeCompare(right))
            .at(-1) ?? null,
      };

      const replay = boundedConsoleTelemetryReplay(
        events,
        input.after as ConsoleTelemetryCursor | null,
        input.limit,
        readAtMs,
      );
      const replayEvents = replay.events.value ?? [];
      const replayCursor = replayEvents.length
        ? replay.cursor.value
        : highWater;
      const detectedGap = input.after
        ? detectConsoleTelemetryGap(input.after, highWater, readAtMs)
        : null;
      const gaps = detectedGap ? [detectedGap] : [];
      const availabilityState =
        state === "unavailable"
          ? "unavailable"
          : state === "partial" ||
              replay.truncated ||
              gaps.length > 0 ||
              (!input.after && highWater.position > 0)
            ? "partial"
            : events.length === 0
              ? "no-data"
              : "available";
      return {
        events: replayEvents,
        sourceId: options.sourceId,
        epoch,
        cursor: replayCursor,
        gaps,
        availability: availabilityState,
        reason:
          state === "partial" || state === "unavailable"
            ? stableReason(source)
            : replay.truncated
              ? "RETAINED_QUEUE_REPLAY_TRUNCATED"
              : gaps.length
                ? "RETAINED_QUEUE_REPLAY_GAP"
                : !input.after && highWater.position > 0
                  ? "RETAINED_QUEUE_BASELINE_UNANCHORED"
                  : null,
        observedAtMs: validPosition(source.observedAtMs),
        readAtMs,
      };
    },
  };
}
