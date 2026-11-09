import * as path from "node:path";
import { consoleTelemetryEventCursor } from "@fmcad/core";
import { createConsoleTelemetrySource } from "../../telemetry/telemetry-source.js";
import type {
  ConsoleTelemetryEvent,
  ConsoleTelemetryEventSink,
  ConsoleTelemetryGap,
} from "@fmcad/core";
import type { ProjectRegistryStore } from "../../../../core/src/ports/project-registry.js";
import { readAdmission } from "../accepted-inputs.js";

const MAX_PENDING_GAPS = 256;
const GAP_OVERFLOW_REASON = "TELEMETRY_GAP_PERSIST_QUEUE_OVERFLOW";

export interface CreateProjectHistoryTelemetryRuntimeOptions {
  /** One explicitly registered project per producer; no project discovery. */
  readonly projectId: string;
  /** Stable producer identity from the actual MCP/runtime composition. */
  readonly sourceId: string;
  /** Existing queue root that contains the producer's retained admission records. */
  readonly queueDirectory: string;
  /** Borrowed; the runtime never registers, closes, or mutates the registry. */
  readonly registry: ProjectRegistryStore;
  /** Borrowed sink from the shared createConsoleQueryNodeAdapter instance. */
  readonly eventSink: ConsoleTelemetryEventSink;
  /** Borrowed gap writer from that same adapter, bound below to projectId. */
  readonly recordGap: (projectId: string, gap: ConsoleTelemetryGap) => void;
  readonly epoch?: string;
  readonly now?: () => number;
  readonly maxPendingEvents?: number;
  readonly onError?: (error: Error) => void;
}

export interface ProjectHistoryTelemetryRuntime {
  readonly projectId: string;
  readonly source: ReturnType<typeof createConsoleTelemetrySource>;
  /** Drain producer events and persisted gap notifications without closing. */
  flush(): Promise<void>;
  /** Stop this producer, flush its queues, and leave borrowed adapters open. */
  close(): Promise<void>;
}

interface ProjectPin {
  readonly projectId: string;
  readonly path: string;
  readonly databaseId: string;
  readonly monitoring: boolean;
  readonly archivedAtMs: number | null;
}

function safeError(error: unknown): Error {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : null;
  const stableCode =
    typeof code === "string" && /^[A-Z0-9_]{1,128}$/u.test(code)
      ? code
      : "HISTORY_TELEMETRY_WRITE_FAILED";
  return Object.assign(new Error("Project history telemetry write failed"), {
    code: stableCode,
  });
}

function report(
  options: CreateProjectHistoryTelemetryRuntimeOptions,
  error: unknown,
): void {
  try {
    options.onError?.(safeError(error));
  } catch {
    // Diagnostics are passive and never escape into the MCP/CAD operation.
  }
}

function defer(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function validText(value: string | null): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !/[\x00-\x1f\x7f]/u.test(value)
  );
}

function eventJobBinding(event: ConsoleTelemetryEvent): {
  jobId: string | null;
  clientId: string | null;
  requestId: string | null;
} {
  return {
    jobId: event.identity.jobId.value,
    clientId:
      event.identity.clientId.value ?? event.identity.reportedClientId.value,
    requestId: event.identity.requestId.value,
  };
}

function jobBoundEvent(event: ConsoleTelemetryEvent): boolean {
  return (
    event.eventType === "queue.job-snapshot" ||
    event.eventType === "queue.phase-interval" ||
    event.eventType === "queue.owned-result" ||
    event.identity.jobId.value !== null ||
    event.identity.requestId.value !== null
  );
}

function gapsMatch(
  gap: ConsoleTelemetryGap,
  sourceId: string,
  epoch: string,
): boolean {
  return (
    gap.sourceId === sourceId &&
    gap.epoch === epoch &&
    gap.positionKind === "sequence" &&
    Number.isSafeInteger(gap.fromPosition) &&
    gap.fromPosition >= 0 &&
    Number.isSafeInteger(gap.toPosition) &&
    gap.toPosition >= gap.fromPosition &&
    Number.isSafeInteger(gap.detectedAtMs) &&
    gap.detectedAtMs >= 0 &&
    typeof gap.reason === "string" &&
    gap.reason.length > 0 &&
    gap.reason.length <= 256 &&
    !/[\x00-\x1f\x7f]/u.test(gap.reason)
  );
}

function mergeOverflowGaps(
  prior: ConsoleTelemetryGap | null,
  next: ConsoleTelemetryGap,
): ConsoleTelemetryGap {
  if (!prior)
    return {
      ...next,
      reason: GAP_OVERFLOW_REASON,
    };
  return {
    ...prior,
    fromPosition: Math.min(prior.fromPosition, next.fromPosition),
    toPosition: Math.max(prior.toPosition, next.toPosition),
    detectedAtMs: Math.max(prior.detectedAtMs, next.detectedAtMs),
    reason: GAP_OVERFLOW_REASON,
  };
}

/**
 * Bind the existing passive producer to one registered project's shared
 * history/query sink. The source is long-lived for one project/process pair;
 * it does not own the registry, query adapter, SQLite connection, or MCP root.
 */
export function createProjectHistoryTelemetryRuntime(
  options: CreateProjectHistoryTelemetryRuntimeOptions,
): ProjectHistoryTelemetryRuntime {
  if (
    !validText(options.projectId) ||
    !validText(options.sourceId) ||
    !path.isAbsolute(options.queueDirectory) ||
    (options.epoch !== undefined && !validText(options.epoch))
  )
    throw new Error("Project history telemetry runtime identity is invalid");
  const registered = options.registry.lookup(options.projectId);
  if (!registered)
    throw Object.assign(new Error("Project is not in the explicit registry"), {
      code: "PROJECT_NOT_REGISTERED",
    });
  if (!registered.monitoring || registered.archivedAtMs !== null)
    throw Object.assign(
      new Error("Project history is not active for this registered project"),
      { code: "HISTORY_MONITORING_DISABLED" },
    );
  const pin: ProjectPin = {
    projectId: registered.projectId,
    path: registered.path,
    databaseId: registered.databaseId,
    monitoring: registered.monitoring,
    archivedAtMs: registered.archivedAtMs,
  };
  const assertPinnedProject = (): void => {
    const current = options.registry.lookup(pin.projectId);
    if (
      !current ||
      current.path !== pin.path ||
      current.databaseId !== pin.databaseId ||
      current.monitoring !== pin.monitoring ||
      current.archivedAtMs !== pin.archivedAtMs ||
      !current.monitoring ||
      current.archivedAtMs !== null
    )
      throw Object.assign(
        new Error(
          "Registered project changed during telemetry source lifetime",
        ),
        { code: "HISTORY_PROJECT_BINDING_CHANGED" },
      );
  };

  let sourceEpoch: string | null = options.epoch ?? null;
  let closed = false;
  let closeTask: Promise<void> | null = null;
  let gapDrainTask: Promise<void> | null = null;
  let gapOverflow: ConsoleTelemetryGap | null = null;
  let gapWriteFailures = 0;
  const gapQueue: ConsoleTelemetryGap[] = [];

  const sink: ConsoleTelemetryEventSink = {
    async append(event) {
      // createConsoleTelemetrySource starts its drain in publish(); yield before
      // any registry/admission/SQLite operation so publish never gates CAD work.
      await defer();
      if (closed)
        throw Object.assign(new Error("Project history telemetry is closed"), {
          code: "HISTORY_TELEMETRY_CLOSED",
        });
      assertPinnedProject();
      const cursor = consoleTelemetryEventCursor(event);
      if (
        event.identity.projectId.value !== pin.projectId ||
        event.metadata.sourceId.value !== options.sourceId ||
        event.metadata.epoch.value !== sourceEpoch ||
        !cursor ||
        cursor.positionKind !== "sequence"
      )
        throw Object.assign(
          new Error(
            "Canonical telemetry event is outside its project/source binding",
          ),
          { code: "HISTORY_TELEMETRY_SOURCE_MISMATCH" },
        );

      const binding = eventJobBinding(event);
      if (jobBoundEvent(event)) {
        if (
          ((event.eventType === "queue.job-snapshot" ||
            event.eventType === "queue.phase-interval" ||
            event.eventType === "queue.owned-result" ||
            event.identity.jobId.value !== null) &&
            !validText(binding.jobId)) ||
          !validText(binding.clientId) ||
          !validText(binding.requestId)
        )
          throw Object.assign(
            new Error("Job telemetry is missing its accepted request identity"),
            { code: "HISTORY_TELEMETRY_JOB_BINDING_MISSING" },
          );
        const admission = readAdmission(options.queueDirectory, {
          clientId: binding.clientId,
          requestId: binding.requestId,
        });
        if (admission.status !== "available")
          throw Object.assign(
            new Error("Job telemetry has no retained admission record"),
            { code: "HISTORY_TELEMETRY_ADMISSION_MISSING" },
          );
      }

      await options.eventSink.append(event);
    },
  };

  function persistGap(gap: ConsoleTelemetryGap): void {
    if (!sourceEpoch || !gapsMatch(gap, options.sourceId, sourceEpoch)) {
      report(
        options,
        new Error("Telemetry producer returned an invalid source gap"),
      );
      gapWriteFailures++;
      return;
    }
    if (gapQueue.length < MAX_PENDING_GAPS) gapQueue.push(gap);
    else gapOverflow = mergeOverflowGaps(gapOverflow, gap);
    scheduleGapDrain();
  }

  function scheduleGapDrain(): void {
    if (gapDrainTask) return;
    gapDrainTask = (async () => {
      try {
        while (gapQueue.length || gapOverflow) {
          await defer();
          const gap = gapQueue.shift() ?? gapOverflow;
          if (!gap) continue;
          if (gap === gapOverflow) gapOverflow = null;
          try {
            if (closed)
              throw Object.assign(
                new Error("Project history telemetry is closed"),
                { code: "HISTORY_TELEMETRY_CLOSED" },
              );
            assertPinnedProject();
            options.recordGap(pin.projectId, gap);
          } catch (error) {
            gapWriteFailures++;
            report(options, error);
          }
        }
      } finally {
        gapDrainTask = null;
      }
    })();
  }

  const source = createConsoleTelemetrySource({
    sourceId: options.sourceId,
    ...(options.epoch === undefined ? {} : { epoch: options.epoch }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxPendingEvents === undefined
      ? {}
      : { maxPendingEvents: options.maxPendingEvents }),
    sink,
    onGap: persistGap,
    onError(error) {
      report(options, error);
    },
  });
  sourceEpoch = source.epoch;

  async function flushGaps(): Promise<void> {
    while (gapQueue.length || gapOverflow || gapDrainTask) {
      if (!gapDrainTask) scheduleGapDrain();
      await gapDrainTask;
    }
    if (gapWriteFailures > 0)
      throw Object.assign(
        new Error("Some project history telemetry gaps were not persisted"),
        { code: "HISTORY_TELEMETRY_GAP_PERSIST_FAILED" },
      );
  }

  return {
    projectId: pin.projectId,
    source,
    async flush() {
      await source.flush();
      await flushGaps();
    },
    close() {
      if (closeTask) return closeTask;
      closeTask = (async () => {
        try {
          await source.close();
          await flushGaps();
        } finally {
          closed = true;
        }
      })();
      return closeTask;
    },
  };
}
