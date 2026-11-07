import { randomUUID } from "node:crypto";
import {
  consoleTelemetryEventCursor,
  normalizeConsoleObservation,
  normalizeConsoleTelemetryJob,
} from "@fmcad/core";
import type {
  ConsoleTelemetryEventSink,
  ConsoleTelemetryCursor,
  ConsoleTelemetryEvent,
  ConsoleTelemetryPhaseKind,
  ConsoleTelemetryGap,
} from "@fmcad/core";
import type { ObservationEvent } from "@fmcad/core";
import type { OwnedResultReference } from "../../../core/src/ports/execution-store.js";

export interface ConsoleTelemetrySourceOptions {
  /** Stable per independently replayed source stream and storage scope. */
  readonly sourceId: string;
  /** Use the actual producer-instance identity when available; otherwise a new epoch is generated. */
  readonly epoch?: string;
  readonly now?: () => number;
  readonly maxPendingEvents?: number;
  readonly sink: ConsoleTelemetryEventSink;
  readonly onError?: (
    error: unknown,
    event: ConsoleTelemetryEvent | null,
  ) => void;
  /** Synchronous bounded enqueue for durable gap recording; never performs I/O. */
  readonly onGap: (gap: ConsoleTelemetryGap) => void;
}

export interface ConsoleTelemetryPublishResult {
  readonly event: ConsoleTelemetryEvent | null;
  readonly status: "queued" | "dropped";
  readonly gap?: ConsoleTelemetryGap;
}

export interface ConsoleTelemetryPhaseJob {
  readonly id: string;
  readonly requestId: string | null;
  readonly clientId: string | null;
  readonly projectId: string | null;
  readonly turnId: string | null;
  readonly sessionId: string | null;
  readonly documentId: string | null;
  readonly documentFileId: string | null;
  readonly purpose: string | null;
  readonly state: string;
  readonly transport: string | null;
  readonly agentId: string | null;
  readonly agent: string | null;
  readonly model: string | null;
  readonly role: string | null;
  readonly physicalTurns: number | null;
  readonly physicalTurnOrdinal: number | null;
  readonly revision?: number | null;
}

export interface ConsoleTelemetryPhaseIntervalInput {
  readonly phase: ConsoleTelemetryPhaseKind;
  readonly job: ConsoleTelemetryPhaseJob;
  /** Millisecond boundaries from the same actual source clock; only their duration is derived. */
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly observedAtMs?: number | null;
}

export interface ConsoleTelemetryOwnedResultInput {
  readonly job: ConsoleTelemetryPhaseJob;
  readonly reference: OwnedResultReference;
  /** Observation time from the actual writer/producer clock, if reported. */
  readonly observedAtMs?: number | null;
}

/** Per-process event identity and passive sink; failures never gate CAD work. */
export function createConsoleTelemetrySource(
  options: ConsoleTelemetrySourceOptions,
) {
  if (!options.sourceId.trim())
    throw new Error("Telemetry source ID must be nonempty");
  const epoch = options.epoch ?? randomUUID();
  const now = options.now ?? Date.now;
  const maxPendingEvents = options.maxPendingEvents ?? 256;
  if (
    !Number.isSafeInteger(maxPendingEvents) ||
    maxPendingEvents <= 0 ||
    maxPendingEvents > 10_000
  )
    throw new Error("Telemetry pending-event bound must be 1..10000");
  let sequence = 0;
  let lastPersisted: ConsoleTelemetryCursor | null = null;
  const queue: {
    readonly position: number;
    readonly event: ConsoleTelemetryEvent;
  }[] = [];
  let pendingCount = 0;
  let draining = false;
  let drainTask: Promise<void> = Promise.resolve();
  const gaps: ConsoleTelemetryGap[] = [];
  let gapsTruncated = false;
  let truncatedThroughPosition: number | null = null;
  let closed = false;

  function recordGap(
    position: number,
    detectedAtMs: number,
    reason: string,
  ): ConsoleTelemetryGap {
    const gap: ConsoleTelemetryGap = {
      sourceId: options.sourceId,
      epoch,
      fromPosition: position,
      toPosition: position,
      positionKind: "sequence",
      detectedAtMs,
      reason,
    };
    if (gaps.length < maxPendingEvents) gaps.push(gap);
    else {
      gapsTruncated = true;
      truncatedThroughPosition = Math.max(
        truncatedThroughPosition ?? 0,
        position,
      );
    }
    try {
      options.onGap(gap);
    } catch (error) {
      reportError(error, null);
    }
    return gap;
  }

  function scheduleDrain(): void {
    if (draining || !queue.length) return;
    draining = true;
    drainTask = (async () => {
      try {
        while (queue.length) {
          const item = queue.shift()!;
          try {
            await options.sink.append(item.event);
            lastPersisted = {
              sourceId: options.sourceId,
              epoch,
              position: item.position,
              positionKind: "sequence",
              eventId: item.event.metadata.eventId.value,
            };
          } catch (error) {
            let detectedAtMs: number | null = null;
            try {
              const value = now();
              if (Number.isSafeInteger(value) && value >= 0)
                detectedAtMs = value;
            } catch {
              // Keep the loss visible as a truncated gap record below.
            }
            if (detectedAtMs !== null)
              recordGap(
                item.position,
                detectedAtMs,
                "TELEMETRY_SINK_APPEND_FAILED",
              );
            else {
              gapsTruncated = true;
              truncatedThroughPosition = Math.max(
                truncatedThroughPosition ?? 0,
                item.position,
              );
            }
            reportError(error, item.event);
          } finally {
            pendingCount--;
          }
        }
      } finally {
        draining = false;
        if (queue.length) scheduleDrain();
      }
    })();
  }

  function publish(
    create: (sequence: number, readAtMs: number) => ConsoleTelemetryEvent,
  ): ConsoleTelemetryPublishResult {
    if (closed) return { event: null, status: "dropped" };
    let readAtMs: number;
    try {
      readAtMs = now();
      if (!Number.isSafeInteger(readAtMs) || readAtMs < 0)
        throw new Error("Telemetry clock returned an invalid timestamp");
    } catch (error) {
      reportError(error, null);
      return { event: null, status: "dropped" };
    }
    if (sequence >= Number.MAX_SAFE_INTEGER) {
      reportError(
        new Error("Telemetry source sequence exhausted; start a new epoch"),
        null,
      );
      return { event: null, status: "dropped" };
    }
    const position = ++sequence;
    let event: ConsoleTelemetryEvent;
    try {
      event = create(position, readAtMs);
    } catch (error) {
      reportError(error, null);
      return {
        event: null,
        status: "dropped",
        gap: recordGap(
          position,
          readAtMs,
          "TELEMETRY_EVENT_NORMALIZATION_FAILED",
        ),
      };
    }
    if (pendingCount >= maxPendingEvents)
      return {
        event,
        status: "dropped",
        gap: recordGap(position, readAtMs, "TELEMETRY_EVENT_QUEUE_FULL"),
      };
    queue.push({ position, event });
    pendingCount++;
    scheduleDrain();
    return { event, status: "queued" };
  }

  function reportError(error: unknown, event: ConsoleTelemetryEvent | null) {
    try {
      options.onError?.(error, event);
    } catch {
      // Diagnostic failure remains separate from execution and telemetry.
    }
  }

  return {
    sourceId: options.sourceId,
    epoch,
    publishJob(
      job: unknown,
      context: {
        readonly projectId?: string | null;
        readonly revision?: number | null;
        readonly observedAtMs?: number | null;
        readonly transport?: string | null;
        readonly worker?: {
          readonly pid?: number | null;
          readonly birth?: string | null;
          readonly alive?: boolean | null;
        } | null;
      } = {},
    ): ConsoleTelemetryPublishResult {
      return publish((position, readAtMs) =>
        normalizeConsoleTelemetryJob(job, {
          sourceId: options.sourceId,
          epoch,
          sequence: position,
          revision: context.revision,
          observedAtMs: context.observedAtMs,
          readAtMs,
          projectId: context.projectId,
          transport: context.transport,
          worker: context.worker,
        }),
      );
    },
    /** Hook only at already-owned phase boundaries; telemetry failure never gates the operation. */
    publishPhaseInterval(
      input: ConsoleTelemetryPhaseIntervalInput,
    ): ConsoleTelemetryPublishResult {
      const interval = {
        startedAtMs: input.startedAtMs,
        finishedAtMs: input.finishedAtMs,
      };
      const timing =
        input.phase === "prepare"
          ? { prepareIntervals: [interval] }
          : input.phase === "queueWait"
            ? { queueWaitIntervals: [interval] }
            : input.phase === "sdkActive"
              ? {
                  turnTimings: [
                    {
                      sdkStartedAtMs: input.startedAtMs,
                      sdkFinishedAtMs: input.finishedAtMs,
                    },
                  ],
                }
              : input.phase === "pause"
                ? { pauseIntervals: [interval] }
                : { finalizeIntervals: [interval] };
      const job = input.job;
      return publish((position, readAtMs) =>
        normalizeConsoleTelemetryJob(
          {
            id: job.id,
            requestId: job.requestId,
            clientId: job.clientId,
            turnId: job.turnId,
            physicalTurns: job.physicalTurns,
            physicalTurnOrdinal: job.physicalTurnOrdinal,
            state: job.state,
            phaseIntervalKind: input.phase,
            ...timing,
            request: {
              requestId: job.requestId,
              clientId: job.clientId,
              phased: true,
              transport: job.transport,
              clientContext: {
                projectId: job.projectId,
                sessionId: job.sessionId,
                docId: job.documentId,
                docFileId: job.documentFileId,
                purpose: job.purpose,
                agentId: job.agentId,
                agent: job.agent,
                model: job.model,
                role: job.role,
              },
            },
          },
          {
            sourceId: options.sourceId,
            epoch,
            sequence: position,
            revision: job.revision,
            observedAtMs: input.observedAtMs,
            readAtMs,
            projectId: job.projectId,
            transport: job.transport,
            eventName: `queue.phase.${input.phase}`,
            eventType: "queue.phase-interval",
          },
        ),
      );
    },
    /** Called only after an existing owned-result writer returns its exact reference. */
    publishOwnedResult(
      input: ConsoleTelemetryOwnedResultInput,
    ): ConsoleTelemetryPublishResult {
      const { job, reference } = input;
      return publish((position, readAtMs) => {
        if (reference.jobId !== job.id)
          throw new Error("Owned result reference belongs to another job");
        const event = normalizeConsoleTelemetryJob(
          {
            id: job.id,
            requestId: job.requestId,
            clientId: job.clientId,
            turnId: job.turnId,
            physicalTurns: job.physicalTurns,
            physicalTurnOrdinal: job.physicalTurnOrdinal,
            state: job.state,
            outputFiles: [
              {
                ownedResult: reference,
                sha256: reference.sha256,
                provenance: "owned-mcp-response-writer",
              },
            ],
            request: {
              requestId: job.requestId,
              clientId: job.clientId,
              transport: job.transport,
              clientContext: {
                projectId: job.projectId,
                sessionId: job.sessionId,
                docId: job.documentId,
                docFileId: job.documentFileId,
                purpose: job.purpose,
                agentId: job.agentId,
                agent: job.agent,
                model: job.model,
                role: job.role,
              },
            },
          },
          {
            sourceId: options.sourceId,
            epoch,
            sequence: position,
            revision: job.revision,
            observedAtMs: input.observedAtMs,
            readAtMs,
            projectId: job.projectId,
            transport: job.transport,
            eventName: "queue.owned-result",
            eventType: "queue.owned-result",
          },
        );
        const retained = event.outputFiles.value?.[0]?.ownedResult;
        if (
          retained?.availability !== "available" ||
          retained.value?.jobId !== job.id ||
          JSON.stringify(retained.value) !== JSON.stringify(reference)
        )
          throw new Error("Owned result reference failed canonical validation");
        return event;
      });
    },
    publishObservation(
      event: ObservationEvent,
      context: { readonly revision?: number | null } = {},
    ): ConsoleTelemetryPublishResult {
      return publish((position, readAtMs) =>
        normalizeConsoleObservation(event, {
          sourceId: options.sourceId,
          epoch,
          sequence: position,
          revision: context.revision,
          observedAtMs: event.atMs,
          readAtMs,
        }),
      );
    },
    cursor(): ConsoleTelemetryCursor | null {
      return lastPersisted;
    },
    flush(): Promise<void> {
      scheduleDrain();
      return drainTask;
    },
    close(): Promise<void> {
      closed = true;
      scheduleDrain();
      return drainTask;
    },
    readGaps(): {
      readonly gaps: readonly ConsoleTelemetryGap[];
      readonly truncated: boolean;
    } {
      return { gaps: [...gaps], truncated: gapsTruncated };
    },
    acknowledgeGaps(throughPosition: number): void {
      if (!Number.isSafeInteger(throughPosition) || throughPosition < 0)
        throw new Error("Acknowledged telemetry position must be nonnegative");
      for (let index = gaps.length - 1; index >= 0; index--)
        if (gaps[index]!.toPosition <= throughPosition) gaps.splice(index, 1);
      if (
        gapsTruncated &&
        truncatedThroughPosition !== null &&
        throughPosition >= truncatedThroughPosition
      ) {
        gapsTruncated = false;
        truncatedThroughPosition = null;
      }
    },
  };
}

export function telemetrySourceCursor(
  event: ConsoleTelemetryEvent,
): ConsoleTelemetryCursor | null {
  return consoleTelemetryEventCursor(event);
}
