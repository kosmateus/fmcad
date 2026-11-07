import type { ObservationEvent } from "../domain/observation";
import type { OwnedResultReference } from "../ports/execution-store";
import type {
  ConsoleTelemetryActor,
  ConsoleTelemetryAvailability,
  ConsoleTelemetryCursor,
  ConsoleTelemetryEvent,
  ConsoleTelemetryEventType,
  ConsoleTelemetryExecutionRecord,
  ConsoleTelemetryFileReference,
  ConsoleTelemetryFusionObservation,
  ConsoleTelemetryGap,
  ConsoleTelemetryHostMetrics,
  ConsoleTelemetryIdentity,
  ConsoleTelemetryLocks,
  ConsoleTelemetryOverview,
  ConsoleTelemetryPhase,
  ConsoleTelemetryPhaseKind,
  ConsoleTelemetryPercentiles,
  ConsoleTelemetryPresenceInput,
  ConsoleTelemetryPresenceCompleteness,
  ConsoleTelemetryPresenceSummary,
  ConsoleTelemetryProcess,
  ConsoleTelemetryReplayBatch,
  ConsoleTelemetrySnapshot,
  ConsoleTelemetryTimings,
  ConsoleTelemetryValue,
} from "../domain/console-telemetry";

type RecordValue = Record<string, unknown>;

function ownedResultReference(
  input: unknown,
  expectedJobId: string | null,
): OwnedResultReference | null {
  const candidate = record(input);
  if (
    !candidate ||
    Object.keys(candidate).sort().join(",") !==
      "bytes,jobId,name,scope,sha256,storage,version" ||
    candidate["version"] !== 1 ||
    text(candidate["jobId"]) === null ||
    text(candidate["jobId"]) !== expectedJobId ||
    !["stdout.txt", "stderr.txt", "rpc-result.json"].includes(
      String(candidate["name"]),
    ) ||
    typeof candidate["scope"] !== "string" ||
    !/^[a-f0-9]{64}$/iu.test(candidate["scope"]) ||
    !["project", "legacy"].includes(String(candidate["storage"])) ||
    !Number.isSafeInteger(candidate["bytes"]) ||
    (candidate["bytes"] as number) < 0 ||
    (candidate["bytes"] as number) > 128 * 1024 * 1024 ||
    typeof candidate["sha256"] !== "string" ||
    !/^[a-f0-9]{64}$/iu.test(candidate["sha256"])
  )
    return null;
  return candidate as unknown as OwnedResultReference;
}

export interface ConsoleTelemetrySource {
  readonly sourceId?: string | null | undefined;
  readonly epoch?: string | null | undefined;
  readonly sequence?: number | null | undefined;
  readonly revision?: number | null | undefined;
  readonly observedAtMs?: number | null | undefined;
  readonly readAtMs: number;
  readonly projectId?: string | null | undefined;
  readonly transport?: string | null | undefined;
  readonly freshness?: ConsoleTelemetryAvailability | undefined;
  readonly worker?:
    | {
        readonly pid?: number | null | undefined;
        readonly birth?: string | null | undefined;
        readonly alive?: boolean | null | undefined;
      }
    | null
    | undefined;
  readonly fusion?:
    | {
        readonly source?: "preflight" | "postflight" | undefined;
        readonly state?: string | null | undefined;
        readonly idle?: boolean | null | undefined;
        readonly documentId?: string | null | undefined;
        readonly documentFileId?: string | null | undefined;
        readonly observedAtMs?: number | null | undefined;
      }
    | null
    | undefined;
}

export interface ConsoleTelemetryJobSource extends ConsoleTelemetrySource {
  readonly eventId?: string | null | undefined;
  readonly eventName?: string | undefined;
  readonly eventType?: ConsoleTelemetryEventType | undefined;
}

export interface ConsoleTelemetryTimingSample {
  /** Only completed, source-reported queue-wait durations feed Overview percentiles. */
  readonly kind: "queueWait";
  readonly valueMs: number;
  readonly observedAtMs: number;
}

export interface ConsoleTelemetrySnapshotInput {
  readonly projectId?: string | null | undefined;
  readonly sourceId?: string | null | undefined;
  readonly readAtMs: number;
  readonly previousCursor?: ConsoleTelemetryCursor | null | undefined;
  readonly sourceCursor?: ConsoleTelemetryCursor | null | undefined;
  /** Must be the complete current-state set, not a history/query page. */
  readonly jobs: readonly unknown[] | null;
  readonly jobsComplete: boolean;
  readonly jobsScope: "project" | "broker";
  readonly registeredProjectIds?: readonly string[] | null;
  readonly registeredProjectsComplete?: boolean;
  readonly jobSource: Omit<ConsoleTelemetryJobSource, "readAtMs">;
  readonly presenceSources: readonly ConsoleTelemetryPresenceInput[] | null;
  readonly presenceScope?: "project" | "broker";
  readonly presenceComplete: boolean | ConsoleTelemetryPresenceCompleteness;
  readonly systemMetrics?: unknown;
  readonly systemAvailability?: ConsoleTelemetryAvailability | undefined;
  readonly panelProcess?: unknown;
  readonly workerProcesses?: readonly unknown[] | null;
  readonly workersComplete?: boolean;
  readonly workersScope?: "project" | "broker";
  readonly locks?: unknown;
  readonly locksAvailability?: ConsoleTelemetryAvailability | undefined;
  readonly timingSamples: readonly ConsoleTelemetryTimingSample[] | null;
  readonly timingAvailability?: ConsoleTelemetryAvailability | undefined;
  readonly executions?: readonly ConsoleTelemetryExecutionRecord[] | null;
  readonly executionsAvailability?: ConsoleTelemetryAvailability | undefined;
  readonly timingWindowMs: number;
  readonly timingScope: "project" | "broker";
}

const ZERO_PHASES: Readonly<Record<ConsoleTelemetryPhase, number>> = {
  preparing: 0,
  queued: 0,
  sending: 0,
  running: 0,
  processing: 0,
  terminal: 0,
  unresolved: 0,
};

const TERMINAL = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "completed",
]);

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function child(value: unknown, key: string): unknown {
  return record(value)?.[key];
}

function first(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function sourceName(
  value: string | null | undefined,
  fallback: string,
): string {
  return text(value) ?? fallback;
}

function rawMetric(
  raw: unknown,
  input: {
    source: string;
    unit: ConsoleTelemetryValue<unknown>["unit"];
    readAtMs: number;
    observedAtMs: number | null;
    scope?: "host" | "process";
    present: boolean;
    availability?: ConsoleTelemetryAvailability | undefined;
  },
): ConsoleTelemetryValue<never> {
  const valid =
    typeof raw === "string"
      ? text(raw)
      : typeof raw === "number"
        ? Number.isFinite(raw) && raw >= 0
          ? raw
          : null
        : null;
  return value(valid as never, {
    source: input.source,
    unit: input.unit,
    scope: input.scope ?? "host",
    readAtMs: input.readAtMs,
    observedAtMs: input.observedAtMs,
    ...(!input.present
      ? {
          availability: "missing" as const,
          reason: "SYSTEM_SOURCE_NOT_AVAILABLE",
        }
      : input.availability &&
          !["available", "stale"].includes(input.availability)
        ? {
            availability: input.availability,
            reason: `SYSTEM_SOURCE_${input.availability.toUpperCase()}`,
          }
        : valid === null
          ? {
              availability: "unknown" as const,
              reason: "SOURCE_VALUE_NULL_OR_INVALID",
            }
          : input.availability === "stale"
            ? { availability: "stale" as const, reason: "SYSTEM_SOURCE_STALE" }
            : {}),
  });
}

function rawNumber(
  raw: unknown,
  source: string,
  unit: ConsoleTelemetryValue<number>["unit"],
  readAtMs: number,
  observedAtMs: number | null,
  scope: "host" | "process" = "host",
  present = true,
  sourceAvailability: ConsoleTelemetryAvailability = "available",
): ConsoleTelemetryValue<number> {
  const number =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
  return value(number, {
    source,
    unit,
    scope,
    readAtMs,
    observedAtMs,
    ...(!present
      ? {
          availability: "missing" as const,
          reason: "SYSTEM_SOURCE_NOT_AVAILABLE",
        }
      : !["available", "stale"].includes(sourceAvailability)
        ? {
            availability: sourceAvailability,
            reason: `SYSTEM_SOURCE_${sourceAvailability.toUpperCase()}`,
          }
        : number === null
          ? {
              availability: "unknown" as const,
              reason: "SOURCE_VALUE_NULL_OR_INVALID",
            }
          : sourceAvailability === "stale"
            ? { availability: "stale" as const, reason: "SYSTEM_SOURCE_STALE" }
            : {}),
  });
}

export function normalizeConsoleHostMetrics(
  system: unknown,
  readAtMs: number,
  sourceAvailability: ConsoleTelemetryAvailability = "available",
): ConsoleTelemetryHostMetrics {
  const root = record(system);
  const host = record(root?.["host"]);
  const disk = record(host?.["disk"]);
  const network = record(host?.["network"]);
  const observedAtMs = nonnegative(root?.["readAt"]);
  const present = !!host;
  const textMetric = (raw: unknown, source: string) =>
    rawMetric(raw, {
      source,
      unit: "text",
      readAtMs,
      observedAtMs,
      present,
      availability: sourceAvailability,
    }) as ConsoleTelemetryValue<string>;
  const numberMetric = (
    raw: unknown,
    source: string,
    unit: ConsoleTelemetryValue<number>["unit"],
  ) =>
    rawNumber(
      raw,
      source,
      unit,
      readAtMs,
      observedAtMs,
      "host",
      present,
      sourceAvailability,
    );
  const loadRaw = host?.["load"];
  const loadValues =
    Array.isArray(loadRaw) &&
    loadRaw.every(
      (item) => typeof item === "number" && Number.isFinite(item) && item >= 0,
    )
      ? loadRaw
      : null;
  return {
    hostname: textMetric(host?.["hostname"], "node:os.hostname"),
    cpuPercent: numberMetric(
      host?.["cpuPercent"],
      "node:os.cpus.delta",
      "percent",
    ),
    ramUsedBytes: numberMetric(
      host?.["ramUsedBytes"],
      "node:os.freemem+totalmem",
      "bytes",
    ),
    ramTotalBytes: numberMetric(
      host?.["ramTotalBytes"],
      "node:os.totalmem",
      "bytes",
    ),
    swapUsedBytes: numberMetric(
      host?.["swapUsedBytes"],
      "procfs:/proc/meminfo",
      "bytes",
    ),
    swapTotalBytes: numberMetric(
      host?.["swapTotalBytes"],
      "procfs:/proc/meminfo",
      "bytes",
    ),
    load: value(loadValues, {
      source: "node:os.loadavg",
      unit: "load-average",
      scope: "host",
      readAtMs,
      observedAtMs,
      ...(!present
        ? {
            availability: "missing" as const,
            reason: "SYSTEM_SOURCE_NOT_AVAILABLE",
          }
        : !["available", "stale"].includes(sourceAvailability)
          ? {
              availability: sourceAvailability,
              reason: `SYSTEM_SOURCE_${sourceAvailability.toUpperCase()}`,
            }
          : loadValues === null
            ? {
                availability: "unknown" as const,
                reason: "SOURCE_VALUE_NULL_OR_UNSUPPORTED",
              }
            : sourceAvailability === "stale"
              ? {
                  availability: "stale" as const,
                  reason: "SYSTEM_SOURCE_STALE",
                }
              : {}),
    }),
    diskUsedBytes: numberMetric(
      disk?.["usedBytes"],
      "node:fs.statfs.project",
      "bytes",
    ),
    diskTotalBytes: numberMetric(
      disk?.["totalBytes"],
      "node:fs.statfs.project",
      "bytes",
    ),
    diskPath: textMetric(disk?.["path"], "node:fs.realpath.project"),
    networkInterface: textMetric(
      network?.["interface"],
      "procfs:/proc/net/route",
    ),
    rxBytesPerSecond: numberMetric(
      network?.["rxBytesPerSecond"],
      "procfs:/proc/net/dev.delta",
      "bytes-per-second",
    ),
    txBytesPerSecond: numberMetric(
      network?.["txBytesPerSecond"],
      "procfs:/proc/net/dev.delta",
      "bytes-per-second",
    ),
    uptimeSeconds: numberMetric(
      host?.["uptimeSeconds"],
      "node:os.uptime",
      "seconds",
    ),
    processCount: numberMetric(host?.["processCount"], "procfs:/proc", "count"),
  };
}

export function normalizeConsoleProcess(
  kind: ConsoleTelemetryProcess["kind"],
  processValue: unknown,
  readAtMs: number,
  source: string,
  observedAtMs: number | null = null,
  availability: ConsoleTelemetryAvailability = "available",
): ConsoleTelemetryProcess {
  const processRecord = record(processValue);
  const identitySource = `${source}.identity`;
  return {
    kind,
    identity: {
      pid: rawNumber(
        processRecord?.["pid"],
        identitySource + ".pid",
        "identity",
        readAtMs,
        observedAtMs,
        "process",
        !!processRecord,
        availability,
      ),
      birth: textValue(
        processRecord?.["birth"],
        identitySource + ".birth",
        "process",
        { readAtMs, observedAtMs },
      ),
      alive: value(
        typeof processRecord?.["alive"] === "boolean"
          ? processRecord["alive"]
          : null,
        {
          source: source + ".passive-liveness",
          unit: null,
          scope: "process",
          readAtMs,
          observedAtMs,
          ...(!processRecord || typeof processRecord["alive"] !== "boolean"
            ? {
                availability: "unknown" as const,
                reason: "PROCESS_LIVENESS_UNCONFIRMED",
              }
            : {}),
        },
      ),
    },
    rssBytes: rawNumber(
      processRecord?.["rssBytes"],
      source + ".rssBytes",
      "bytes",
      readAtMs,
      observedAtMs,
      "process",
      !!processRecord,
      availability,
    ),
    uptimeSeconds: rawNumber(
      processRecord?.["uptimeSeconds"],
      source + ".uptimeSeconds",
      "seconds",
      readAtMs,
      observedAtMs,
      "process",
      !!processRecord,
      availability,
    ),
    cpuPercent: rawNumber(
      processRecord?.["cpuPercent"],
      source + ".cpuPercent",
      "percent",
      readAtMs,
      observedAtMs,
      "process",
      !!processRecord,
      availability,
    ),
  };
}

export function normalizeConsoleLocks(
  locks: unknown,
  readAtMs: number,
  sourceAvailability: ConsoleTelemetryAvailability = "available",
): ConsoleTelemetryLocks {
  const valueRecord = record(locks);
  const rawStatus = valueRecord?.["status"];
  const source = text(valueRecord?.["source"]) ?? "console-locks-read-only";
  const observedAtMs = nonnegative(valueRecord?.["readAt"]);
  const status: "active" | "unknown" | "unsupported" =
    rawStatus === "active"
      ? "active"
      : rawStatus === "unsupported"
        ? "unsupported"
        : "unknown";
  const owners = Array.isArray(valueRecord?.["entries"])
    ? valueRecord["entries"].flatMap((entry) => {
        const row = record(entry);
        return Array.isArray(row?.["owners"]) ? row["owners"] : [];
      }).length
    : null;
  const reason = text(valueRecord?.["reason"]);
  return {
    status: value(status, {
      source,
      unit: "text",
      scope: "host",
      readAtMs,
      observedAtMs,
      ...(!valueRecord
        ? {
            availability:
              sourceAvailability === "available"
                ? ("missing" as const)
                : sourceAvailability,
            reason:
              sourceAvailability === "available"
                ? "LOCK_SOURCE_NOT_AVAILABLE"
                : `LOCK_SOURCE_${sourceAvailability.toUpperCase()}`,
          }
        : sourceAvailability !== "available" && sourceAvailability !== "stale"
          ? {
              availability: sourceAvailability,
              reason: `LOCK_SOURCE_${sourceAvailability.toUpperCase()}`,
            }
          : valueRecord
            ? {}
            : {}),
      ...(status === "unknown" && valueRecord
        ? {
            reason: reason
              ? `${reason}; ABSENCE_IS_NOT_UNLOCKED`
              : "NO_VERIFIED_LOCK_OWNER; ABSENCE_IS_NOT_UNLOCKED",
          }
        : status === "unsupported"
          ? { reason: reason ?? "LOCK_OBSERVATION_UNSUPPORTED" }
          : {}),
    }),
    evidenceCount: rawNumber(
      owners,
      source + ".verified-owner-count",
      "count",
      readAtMs,
      observedAtMs,
      "host",
      !!valueRecord,
    ),
    reason: textValue(reason, source + ".reason", "host", {
      readAtMs,
      observedAtMs,
    }),
  };
}

function value<T>(
  raw: T | null,
  input: {
    source: string;
    unit: ConsoleTelemetryValue<T>["unit"];
    scope: ConsoleTelemetryValue<T>["scope"];
    readAtMs: number;
    observedAtMs?: number | null | undefined;
    availability?: ConsoleTelemetryAvailability | undefined;
    reason?: string | null | undefined;
  },
): ConsoleTelemetryValue<T> {
  const requested = input.availability;
  const availability =
    raw === null && (requested === "available" || requested === "stale")
      ? "missing"
      : (requested ?? (raw === null ? "missing" : "available"));
  return {
    value:
      availability === "available" || availability === "stale" ? raw : null,
    availability,
    source: input.source,
    unit: input.unit,
    scope: input.scope,
    observedAtMs: input.observedAtMs ?? null,
    readAtMs: input.readAtMs,
    reason:
      input.reason ??
      (availability === "missing" ? "SOURCE_DID_NOT_REPORT_VALUE" : null),
  };
}

function textValue(
  raw: unknown,
  source: string,
  scope: ConsoleTelemetryValue<string>["scope"],
  context: ConsoleTelemetrySource,
): ConsoleTelemetryValue<string> {
  return value(text(raw), {
    source,
    unit: "identity",
    scope,
    readAtMs: context.readAtMs,
    observedAtMs: context.observedAtMs,
    ...(context.freshness ? { availability: context.freshness } : {}),
  });
}

function numberValue(
  raw: unknown,
  source: string,
  scope: ConsoleTelemetryValue<number>["scope"],
  context: ConsoleTelemetrySource,
): ConsoleTelemetryValue<number> {
  return value(nonnegative(raw), {
    source,
    unit: "count",
    scope,
    readAtMs: context.readAtMs,
    observedAtMs: context.observedAtMs,
    ...(context.freshness ? { availability: context.freshness } : {}),
  });
}

function metadataValue<T>(
  raw: T | null,
  source: string,
  unit: ConsoleTelemetryValue<T>["unit"],
  context: ConsoleTelemetrySource,
): ConsoleTelemetryValue<T> {
  return value(raw, {
    source,
    unit,
    scope: "event",
    readAtMs: context.readAtMs,
    observedAtMs: context.observedAtMs,
  });
}

function elapsed(
  start: unknown,
  end: unknown,
  source: string,
  scope: "job" | "turn",
  context: ConsoleTelemetrySource,
  reason: string,
): ConsoleTelemetryValue<number> {
  const from = nonnegative(start);
  const to = nonnegative(end);
  const duration =
    from !== null && to !== null && to >= from ? to - from : null;
  return value(duration, {
    source,
    unit: "ms",
    scope,
    readAtMs: context.readAtMs,
    observedAtMs: context.observedAtMs,
    ...(context.freshness ? { availability: context.freshness } : {}),
    ...(duration === null ? { reason } : {}),
  });
}

function sumIntervals(
  intervals: unknown,
  startKey: string,
  endKey: string,
  source: string,
  scope: "job" | "turn",
  context: ConsoleTelemetrySource,
  missingReason: string,
): ConsoleTelemetryValue<number> {
  if (!Array.isArray(intervals))
    return value<number>(null, {
      source,
      unit: "ms",
      scope,
      readAtMs: context.readAtMs,
      observedAtMs: context.observedAtMs,
      availability: "missing",
      reason: missingReason,
    });
  let total = 0;
  for (const interval of intervals) {
    const start = nonnegative(child(interval, startKey));
    const end = nonnegative(child(interval, endKey));
    if (start === null || end === null || end < start)
      return value<number>(null, {
        source,
        unit: "ms",
        scope,
        readAtMs: context.readAtMs,
        observedAtMs: context.observedAtMs,
        availability: "unknown",
        reason: "INTERVAL_BOUNDARY_NOT_REPORTED_OR_INVALID",
      });
    total += end - start;
  }
  return value(total, {
    source,
    unit: "ms",
    scope,
    readAtMs: context.readAtMs,
    observedAtMs: context.observedAtMs,
    ...(context.freshness ? { availability: context.freshness } : {}),
  });
}

function phaseFor(state: unknown): ConsoleTelemetryPhase | null {
  if (state === "preparing") return "preparing";
  if (state === "queued") return "queued";
  if (state === "sending") return "sending";
  if (state === "running") return "running";
  if (state === "processing") return "processing";
  if (typeof state === "string" && TERMINAL.has(state)) return "terminal";
  if (
    typeof state === "string" &&
    ["unknown", "unresolved", "needs_reconciliation", "blocked"].includes(state)
  )
    return "unresolved";
  return typeof state === "string" && state ? "unresolved" : null;
}

function knownState(state: unknown): boolean {
  return (
    ["preparing", "queued", "sending", "running", "processing"].includes(
      String(state),
    ) ||
    TERMINAL.has(String(state)) ||
    ["unknown", "unresolved", "needs_reconciliation", "blocked"].includes(
      String(state),
    )
  );
}

function phaseIntervalKind(input: unknown): ConsoleTelemetryPhaseKind | null {
  return ["prepare", "queueWait", "sdkActive", "pause", "finalize"].includes(
    String(input),
  )
    ? (input as ConsoleTelemetryPhaseKind)
    : null;
}

function fileReferences(
  job: unknown,
  context: ConsoleTelemetrySource,
): {
  sourceFiles: ConsoleTelemetryValue<readonly ConsoleTelemetryFileReference[]>;
  outputFiles: ConsoleTelemetryValue<readonly ConsoleTelemetryFileReference[]>;
} {
  const request = child(job, "request");
  const details = child(job, "details");
  const sources = [
    {
      items: child(request, "inputFiles"),
      provenance: "queue-state.job.request.inputFiles",
    },
    {
      items: child(job, "sourceReferences"),
      provenance: "queue-state.job.sourceReferences",
    },
  ];
  const outputItems = first(
    child(job, "outputFiles"),
    child(details, "outputFiles"),
    child(job, "outputReferences"),
    child(details, "outputReferences"),
  );
  const outputSource =
    child(job, "outputFiles") !== undefined
      ? "queue-state.job.outputFiles"
      : child(details, "outputFiles") !== undefined
        ? "queue-state.job.details.outputFiles"
        : child(job, "outputReferences") !== undefined
          ? "queue-state.job.outputReferences"
          : "queue-state.job.details.outputReferences";
  const outputs = [{ items: outputItems, provenance: outputSource }];
  const project = (
    entries: readonly {
      readonly items: unknown;
      readonly provenance: string;
    }[],
    kind: "source" | "output",
    defaultSource: string,
    missingReason: string,
  ): ConsoleTelemetryValue<readonly ConsoleTelemetryFileReference[]> => {
    const known = entries.flatMap((entry) => {
      const items = Array.isArray(entry.items)
        ? entry.items
        : kind === "output" && record(entry.items)
          ? Object.values(record(entry.items)!)
          : null;
      return items === null ? [] : [{ ...entry, items }];
    });
    const refs: ConsoleTelemetryFileReference[] = [];
    for (const entry of known) {
      for (const item of entry.items as unknown[]) {
        const itemRecord = record(item);
        if (!itemRecord) continue;
        const source = text(itemRecord["provenance"]) ?? entry.provenance;
        const rawOwnedResult = first(
          kind === "output" ? itemRecord["ownedResult"] : undefined,
          kind === "output" ? itemRecord["artifact"] : undefined,
        );
        const ownedResult = ownedResultReference(
          rawOwnedResult,
          text(child(job, "id")),
        );
        refs.push({
          kind,
          path: textValue(itemRecord["path"], source + ".path", "job", context),
          fileId: textValue(
            first(itemRecord["fileId"], itemRecord["documentFileId"]),
            source + ".fileId",
            "job",
            context,
          ),
          artifactId: textValue(
            itemRecord["artifactId"],
            source + ".artifactId",
            "job",
            context,
          ),
          sha256: value(
            typeof itemRecord["sha256"] === "string" &&
              /^[a-f0-9]{64}$/iu.test(itemRecord["sha256"] as string)
              ? (itemRecord["sha256"] as string).toLowerCase()
              : (ownedResult?.sha256 ?? null),
            {
              source: source + ".sha256",
              unit: "text",
              scope: "job",
              readAtMs: context.readAtMs,
              observedAtMs: context.observedAtMs,
            },
          ),
          provenance: textValue(
            first(itemRecord["provenance"], source),
            source + ".provenance",
            "job",
            context,
          ),
          ownedResult: value(ownedResult, {
            source: source + ".ownedResult",
            unit: "identity",
            scope: "job",
            readAtMs: context.readAtMs,
            observedAtMs: context.observedAtMs,
            ...(ownedResult
              ? {}
              : {
                  availability:
                    rawOwnedResult === undefined || rawOwnedResult === null
                      ? ("missing" as const)
                      : ("error" as const),
                  reason:
                    rawOwnedResult === undefined || rawOwnedResult === null
                      ? "OWNED_RESULT_DESCRIPTOR_NOT_REPORTED"
                      : "OWNED_RESULT_DESCRIPTOR_INVALID_OR_FOREIGN_JOB",
                }),
          }),
        });
      }
    }
    const unique = [
      ...new Map(
        refs.map((ref) => [
          JSON.stringify([
            ref.kind,
            ref.path.value,
            ref.fileId.value,
            ref.artifactId.value,
            ref.sha256.value,
            ref.ownedResult?.value ?? null,
          ]),
          ref,
        ]),
      ).values(),
    ];
    const reportedSources = [
      ...new Set(
        known.flatMap((entry) =>
          (entry.items as unknown[]).flatMap((item) => {
            const itemRecord = record(item);
            return itemRecord
              ? [text(itemRecord["provenance"]) ?? entry.provenance]
              : [];
          }),
        ),
      ),
    ];
    return value(known.length ? unique : null, {
      source: reportedSources.join("+") || defaultSource,
      unit: "count",
      scope: "job",
      readAtMs: context.readAtMs,
      observedAtMs: context.observedAtMs,
      ...(!known.length
        ? { availability: "missing" as const, reason: missingReason }
        : context.freshness
          ? { availability: context.freshness }
          : {}),
    });
  };
  return {
    sourceFiles: project(
      sources,
      "source",
      "queue-state.job.request.source-files",
      "SOURCE_FILE_REFERENCES_NOT_REPORTED",
    ),
    outputFiles: project(
      outputs,
      "output",
      "queue-state.job.output-files",
      "OUTPUT_FILE_REFERENCES_NOT_REPORTED",
    ),
  };
}

function workerObservation(
  context: ConsoleTelemetrySource,
): ConsoleTelemetryEvent["worker"] {
  const worker = context.worker;
  const workerSource = "existing-worker-identity-receipt";
  return {
    pid: value(
      worker && Number.isSafeInteger(worker.pid) && (worker.pid ?? 0) > 0
        ? worker.pid!
        : null,
      {
        source: workerSource + ".pid",
        unit: "count",
        scope: "process",
        readAtMs: context.readAtMs,
        observedAtMs: context.observedAtMs,
        ...(worker ? {} : { reason: "WORKER_IDENTITY_NOT_OBSERVED" }),
      },
    ),
    birth: value(text(worker?.birth ?? null), {
      source: workerSource + ".birth",
      unit: "identity",
      scope: "process",
      readAtMs: context.readAtMs,
      observedAtMs: context.observedAtMs,
      ...(worker ? {} : { reason: "WORKER_IDENTITY_NOT_OBSERVED" }),
    }),
    alive: value(typeof worker?.alive === "boolean" ? worker.alive : null, {
      source: "passive-process-identity-check",
      unit: null,
      scope: "process",
      readAtMs: context.readAtMs,
      observedAtMs: context.observedAtMs,
      ...(worker?.alive === null || worker?.alive === undefined
        ? {
            availability: "unknown" as const,
            reason: "PROCESS_LIVENESS_UNCONFIRMED",
          }
        : {}),
    }),
  };
}

function fusionObservation(
  context: ConsoleTelemetrySource,
): ConsoleTelemetryFusionObservation {
  const fusion = context.fusion;
  const source = "existing-fusion-preflight-postflight-receipt";
  const receiptSource = fusion?.source ?? null;
  const readContext = fusion?.observedAtMs
    ? { ...context, observedAtMs: fusion.observedAtMs }
    : context;
  return {
    state: textValue(fusion?.state, source + ".state", "job", readContext),
    idle: value(typeof fusion?.idle === "boolean" ? fusion.idle : null, {
      source: source + ".idle",
      unit: null,
      scope: "job",
      readAtMs: context.readAtMs,
      observedAtMs: fusion?.observedAtMs ?? null,
      ...(typeof fusion?.idle === "boolean"
        ? {}
        : {
            availability: "missing" as const,
            reason: "NO_EXISTING_IDLE_RECEIPT",
          }),
    }),
    documentId: textValue(
      fusion?.documentId,
      source + ".documentId",
      "job",
      readContext,
    ),
    documentFileId: textValue(
      fusion?.documentFileId,
      source + ".documentFileId",
      "job",
      readContext,
    ),
    source: value(receiptSource, {
      source,
      unit: "text",
      scope: "job",
      readAtMs: context.readAtMs,
      observedAtMs: fusion?.observedAtMs ?? null,
      ...(receiptSource === null
        ? { availability: "missing" as const, reason: "NO_EXISTING_RECEIPT" }
        : {}),
    }),
  };
}

function makeIdentity(
  job: unknown,
  context: ConsoleTelemetryJobSource,
): ConsoleTelemetryIdentity {
  const request = child(job, "request");
  const clientContext = child(request, "clientContext");
  const reportedClientId = first(
    child(job, "clientId"),
    child(request, "clientId"),
  );
  const reportedSessionId = first(
    child(request, "sessionId"),
    child(clientContext, "sessionId"),
  );
  const canonicalClientId =
    context.transport === "opencode" &&
    typeof reportedClientId === "string" &&
    reportedClientId.startsWith("opencode:")
      ? null
      : typeof reportedClientId === "string"
        ? reportedClientId
        : null;
  const canonicalSessionId =
    context.transport === "opencode" &&
    typeof reportedSessionId === "string" &&
    reportedSessionId.startsWith("opencode-session:")
      ? null
      : typeof reportedSessionId === "string"
        ? reportedSessionId
        : null;
  const scoped = {
    ...context,
    freshness: context.freshness,
  };
  const identitySource = "queue-state.job";
  return {
    projectId: textValue(
      first(
        child(clientContext, "projectId"),
        child(job, "projectId"),
        context.projectId,
      ),
      "canonical-project-registry-or-source.projectId",
      "project",
      scoped,
    ),
    requestId: textValue(
      first(child(job, "requestId"), child(request, "requestId")),
      identitySource + ".requestId",
      "job",
      scoped,
    ),
    jobId: textValue(child(job, "id"), identitySource + ".id", "job", scoped),
    turnId: textValue(
      first(child(job, "turnId"), child(request, "turnId")),
      identitySource + ".turnId",
      "turn",
      scoped,
    ),
    clientId:
      canonicalClientId === null && typeof reportedClientId === "string"
        ? value<string>(null, {
            source: identitySource + ".clientId",
            unit: "identity",
            scope: "process",
            readAtMs: context.readAtMs,
            observedAtMs: context.observedAtMs,
            availability: "unknown",
            reason: "OPENCODE_CLIENT_ID_IS_A_SOURCE_ALIAS_NOT_CANONICAL_ID",
          })
        : textValue(
            canonicalClientId,
            identitySource + ".clientId",
            "process",
            scoped,
          ),
    sessionId:
      canonicalSessionId === null && typeof reportedSessionId === "string"
        ? value<string>(null, {
            source: identitySource + ".clientContext.sessionId",
            unit: "identity",
            scope: "process",
            readAtMs: context.readAtMs,
            observedAtMs: context.observedAtMs,
            availability: "unknown",
            reason: "OPENCODE_SESSION_ID_IS_A_SOURCE_ALIAS_NOT_CANONICAL_ID",
          })
        : textValue(
            canonicalSessionId,
            identitySource + ".clientContext.sessionId",
            "process",
            scoped,
          ),
    documentId: textValue(
      first(
        child(job, "documentId"),
        child(request, "docId"),
        child(clientContext, "docId"),
      ),
      identitySource + ".clientContext.docId",
      "job",
      scoped,
    ),
    documentFileId: textValue(
      first(
        child(job, "documentFileId"),
        child(request, "docFileId"),
        child(clientContext, "docFileId"),
      ),
      identitySource + ".clientContext.docFileId",
      "job",
      scoped,
    ),
    purpose: textValue(
      first(child(request, "purpose"), child(clientContext, "purpose")),
      identitySource + ".clientContext.purpose",
      "job",
      scoped,
    ),
    reportedClientId: textValue(
      reportedClientId,
      identitySource + ".clientId-reported",
      "process",
      scoped,
    ),
    reportedSessionId: textValue(
      reportedSessionId,
      identitySource + ".clientContext.sessionId-reported",
      "process",
      scoped,
    ),
  };
}

function makeActor(
  job: unknown,
  context: ConsoleTelemetryJobSource,
): ConsoleTelemetryActor {
  const request = child(job, "request");
  const clientContext = child(request, "clientContext");
  const source = "queue-state.job.declared-actor";
  const scoped = context;
  return {
    transport: textValue(
      first(
        context.transport,
        child(request, "transport"),
        child(job, "transport"),
      ),
      "source-declared-transport",
      "job",
      scoped,
    ),
    agentId: textValue(
      first(
        child(job, "agentId"),
        child(request, "agentId"),
        child(clientContext, "agentId"),
      ),
      source + ".agentId",
      "job",
      scoped,
    ),
    agent: textValue(
      first(
        child(job, "agent"),
        child(request, "agent"),
        child(clientContext, "agent"),
      ),
      source + ".agent",
      "job",
      scoped,
    ),
    model: textValue(
      first(
        child(job, "model"),
        child(request, "model"),
        child(clientContext, "model"),
      ),
      source + ".model",
      "job",
      scoped,
    ),
    role: textValue(
      first(
        child(job, "role"),
        child(request, "role"),
        child(clientContext, "role"),
      ),
      source + ".role",
      "job",
      scoped,
    ),
  };
}

function makeTimings(
  job: unknown,
  state: string | null,
  context: ConsoleTelemetrySource,
): ConsoleTelemetryTimings {
  const submittedAt = child(job, "submittedAt");
  const finishedAt = child(job, "finishedAt");
  const physicalTurns = nonnegative(child(job, "physicalTurns"));
  const turns = child(job, "turnTimings");
  const intervalKind = phaseIntervalKind(child(job, "phaseIntervalKind"));
  if (intervalKind !== null) {
    const intervalSource = `telemetry-phase-interval.${intervalKind}`;
    const interval = (source: string, scope: "job" | "turn") =>
      sumIntervals(
        child(job, source),
        source === "turnTimings" ? "sdkStartedAtMs" : "startedAtMs",
        source === "turnTimings" ? "sdkFinishedAtMs" : "finishedAtMs",
        intervalSource,
        scope,
        context,
        "PHASE_INTERVAL_BOUNDARIES_NOT_REPORTED",
      );
    const notThisPhase = (name: string, scope: "job" | "turn") =>
      value<number>(null, {
        source: intervalSource,
        unit: "ms",
        scope,
        readAtMs: context.readAtMs,
        observedAtMs: context.observedAtMs,
        availability: "missing",
        reason: `${name.toUpperCase()}_NOT_THIS_PHASE_EVENT`,
      });
    return {
      prepareMs:
        intervalKind === "prepare"
          ? interval("prepareIntervals", "job")
          : notThisPhase("prepare", "job"),
      queueWaitMs:
        intervalKind === "queueWait"
          ? interval("queueWaitIntervals", "turn")
          : notThisPhase("queueWait", "turn"),
      sdkActiveMs:
        intervalKind === "sdkActive"
          ? interval("turnTimings", "turn")
          : notThisPhase("sdkActive", "turn"),
      pauseMs:
        intervalKind === "pause"
          ? interval("pauseIntervals", "job")
          : notThisPhase("pause", "job"),
      finalizeMs:
        intervalKind === "finalize"
          ? interval("finalizeIntervals", "job")
          : notThisPhase("finalize", "job"),
      totalWorkflowMs: value<number>(null, {
        source: "telemetry-phase-interval.workflow-total",
        unit: "ms",
        scope: "job",
        readAtMs: context.readAtMs,
        observedAtMs: context.observedAtMs,
        availability: "unknown",
        reason: "ONE_PHASE_INTERVAL_IS_NOT_TOTAL_WORKFLOW_TIME",
      }),
    };
  }
  const queueWait = sumIntervals(
    child(job, "queueWaitIntervals"),
    "startedAtMs",
    "finishedAtMs",
    "queue-state.job.queueWaitIntervals",
    "turn",
    context,
    "QUEUE_WAIT_INTERVALS_NOT_RECORDED",
  );
  const hasCompleteTurns =
    Array.isArray(turns) &&
    turns.length > 0 &&
    turns.length === physicalTurns &&
    turns.every(
      (turn) =>
        nonnegative(child(turn, "sdkStartedAtMs")) !== null &&
        nonnegative(child(turn, "sdkFinishedAtMs")) !== null &&
        (child(turn, "sdkFinishedAtMs") as number) >=
          (child(turn, "sdkStartedAtMs") as number),
    );
  const sdkActive =
    physicalTurns === 0
      ? value(0, {
          source: "queue-state.job.physicalTurns",
          unit: "ms",
          scope: "job",
          readAtMs: context.readAtMs,
          observedAtMs: context.observedAtMs,
        })
      : hasCompleteTurns
        ? sumIntervals(
            turns,
            "sdkStartedAtMs",
            "sdkFinishedAtMs",
            "queue-state.job.turnTimings",
            "turn",
            context,
            "SDK_TURN_INTERVALS_NOT_RECORDED",
          )
        : value<number>(null, {
            source: "queue-state.job.physicalTurns",
            unit: "ms",
            scope: "job",
            readAtMs: context.readAtMs,
            observedAtMs: context.observedAtMs,
            availability: physicalTurns === null ? "unknown" : "missing",
            reason:
              physicalTurns === null
                ? "PHYSICAL_TURN_COUNT_NOT_REPORTED"
                : "SDK_TURN_INTERVALS_NOT_RECORDED",
          });
  const terminal = typeof state === "string" && TERMINAL.has(state);
  return {
    prepareMs: sumIntervals(
      child(job, "prepareIntervals"),
      "startedAtMs",
      "finishedAtMs",
      "queue-state.job.prepareIntervals",
      "job",
      context,
      "PREPARATION_INTERVAL_NOT_RECORDED",
    ),
    queueWaitMs: queueWait,
    sdkActiveMs: sdkActive,
    pauseMs: sumIntervals(
      child(job, "pauseIntervals"),
      "startedAtMs",
      "finishedAtMs",
      "queue-state.job.pauseIntervals",
      "job",
      context,
      "JOB_ATTRIBUTED_PAUSE_INTERVALS_NOT_RECORDED",
    ),
    finalizeMs: sumIntervals(
      child(job, "finalizeIntervals"),
      "startedAtMs",
      "finishedAtMs",
      "queue-state.job.finalizeIntervals",
      "job",
      context,
      "FINALIZATION_INTERVAL_NOT_RECORDED",
    ),
    totalWorkflowMs: terminal
      ? elapsed(
          submittedAt,
          finishedAt,
          "queue-state.job.submittedAt-and-finishedAt",
          "job",
          context,
          "WORKFLOW_TERMINAL_BOUNDARIES_NOT_RECORDED",
        )
      : value<number>(null, {
          source: "queue-state.job.submittedAt-and-finishedAt",
          unit: "ms",
          scope: "job",
          readAtMs: context.readAtMs,
          observedAtMs: context.observedAtMs,
          availability: "unknown",
          reason: "WORKFLOW_NOT_TERMINAL",
        }),
  };
}

/** Normalize one job without treating missing legacy fields as zero or inference. */
export function normalizeConsoleTelemetryJob(
  input: unknown,
  context: ConsoleTelemetryJobSource,
): ConsoleTelemetryEvent {
  if (!Number.isSafeInteger(context.readAtMs) || context.readAtMs < 0)
    throw new Error("Telemetry read timestamp must be a nonnegative integer");
  const job = record(input);
  const rawState = text(job?.["state"]);
  const phase = phaseFor(rawState);
  const sourceId = text(context.sourceId);
  const epoch = text(context.epoch);
  const sequence = nonnegative(context.sequence);
  const revision = nonnegative(context.revision);
  const jobId = text(job?.["id"]);
  const eventDiscriminator =
    jobId ??
    text(child(job, "requestId")) ??
    text(child(job, "turnId")) ??
    text(context.eventName) ??
    "source-event";
  const position = sequence ?? revision;
  const positionKind = sequence !== null ? "sequence" : "revision";
  const eventId =
    text(context.eventId) ??
    (sourceId && epoch && position !== null
      ? `${sourceId}:${epoch}:${positionKind}:${position}:${eventDiscriminator}`
      : null);
  const common: ConsoleTelemetrySource = context;
  const stateValue = textValue(
    rawState,
    "queue-state.job.state",
    "job",
    common,
  );
  const phaseValue = value(phase, {
    source: "queue-state.job.state",
    unit: "text",
    scope: "job",
    readAtMs: context.readAtMs,
    observedAtMs: context.observedAtMs,
    ...(!knownState(rawState)
      ? { availability: "unknown" as const, reason: "JOB_PHASE_NOT_RECOGNIZED" }
      : context.freshness
        ? { availability: context.freshness }
        : {}),
  });
  const eventName = context.eventName ?? "queue.job-snapshot";
  const rawPhaseIntervalKind = phaseIntervalKind(
    child(job, "phaseIntervalKind"),
  );
  return {
    version: 1,
    eventType: context.eventType ?? "queue.job-snapshot",
    eventName: textValue(
      eventName,
      "console-telemetry-producer.eventName",
      "event",
      common,
    ),
    metadata: {
      eventId: metadataValue(
        eventId,
        eventId
          ? "stable-source-position-and-job-identity"
          : "source-event-identity",
        "identity",
        common,
      ),
      sourceId: metadataValue(
        sourceId,
        "telemetry-source.sourceId",
        "identity",
        common,
      ),
      epoch: metadataValue(epoch, "telemetry-source.epoch", "identity", common),
      sequence: metadataValue(
        sequence,
        "telemetry-source.sequence",
        "count",
        common,
      ),
      revision: metadataValue(
        revision,
        "source-snapshot.revision",
        "count",
        common,
      ),
      observedAtMs: metadataValue(
        nonnegative(context.observedAtMs),
        sourceId
          ? sourceId + ".observedAtMs"
          : "source-observation.observedAtMs",
        "unix-ms",
        common,
      ),
      readAtMs: value(context.readAtMs, {
        source: "console-telemetry-collector.clock",
        unit: "unix-ms",
        scope: "event",
        readAtMs: context.readAtMs,
        observedAtMs: context.observedAtMs,
      }),
    },
    identity: makeIdentity(input, context),
    actor: makeActor(input, context),
    state: stateValue,
    phase: phaseValue,
    phaseIntervalKind: value(rawPhaseIntervalKind, {
      source: "console-telemetry-producer.phaseIntervalKind",
      unit: "text",
      scope: "turn",
      readAtMs: context.readAtMs,
      observedAtMs: context.observedAtMs,
      ...(rawPhaseIntervalKind === null
        ? {
            availability: "missing" as const,
            reason: "EVENT_IS_NOT_A_REPORTED_PHASE_INTERVAL",
          }
        : {}),
    }),
    physicalTurns: numberValue(
      child(job, "physicalTurns"),
      "queue-state.job.physicalTurns",
      "job",
      common,
    ),
    physicalTurnOrdinal: numberValue(
      child(job, "physicalTurnOrdinal"),
      "queue-event.physicalTurnOrdinal",
      "turn",
      common,
    ),
    ...fileReferences(input, common),
    timings: makeTimings(input, rawState, common),
    worker: workerObservation(common),
    fusion: fusionObservation(common),
  };
}

/** Existing observation events retain their declared IDs and purpose verbatim. */
export function normalizeConsoleObservation(
  event: ObservationEvent,
  context: ConsoleTelemetryJobSource,
): ConsoleTelemetryEvent {
  if (!Number.isSafeInteger(context.readAtMs) || context.readAtMs < 0)
    throw new Error("Telemetry read timestamp must be a nonnegative integer");
  const invocation = event.invocation;
  const data = event.data as Record<string, unknown>;
  const source = invocation.source;
  const reportedClientId = invocation.clientId;
  const reportedSessionId = invocation.sessionId;
  const canonicalClientId =
    source === "opencode" && reportedClientId?.startsWith("opencode:")
      ? null
      : reportedClientId;
  const canonicalSessionId =
    source === "opencode" && reportedSessionId?.startsWith("opencode-session:")
      ? null
      : reportedSessionId;
  const observedAtMs = nonnegative(event.atMs);
  const common: ConsoleTelemetrySource = {
    ...context,
    sourceId: context.sourceId ?? `observation:${source}`,
    epoch: context.epoch ?? invocation.instanceId,
    observedAtMs: context.observedAtMs ?? observedAtMs,
    projectId: context.projectId ?? invocation.projectId,
    transport: source,
  };
  const missingJob = {
    id: invocation.jobId,
    request: {
      requestId: invocation.requestId,
      clientId: canonicalClientId,
      sessionId: canonicalSessionId,
      docId: invocation.documentId,
      purpose: invocation.purpose,
      agent: text(data["agent"]),
      agentId: text(data["agentId"]),
      model: text(data["model"]),
      role: text(data["role"]),
    },
    state: text(data["status"]),
    turnId: invocation.turnId,
    clientId: canonicalClientId,
    sessionId: canonicalSessionId,
    physicalTurns: null,
  };
  const normalized = normalizeConsoleTelemetryJob(missingJob, {
    ...common,
    sequence: context.sequence,
    revision: context.revision,
    eventId: context.eventId,
    eventName: event.name,
    eventType: "observation.event",
  });
  return {
    ...normalized,
    identity: {
      ...normalized.identity,
      projectId: textValue(
        invocation.projectId,
        "observation.invocation.projectId",
        "project",
        common,
      ),
      requestId: textValue(
        invocation.requestId,
        "observation.invocation.requestId",
        "job",
        common,
      ),
      turnId: textValue(
        invocation.turnId,
        "observation.invocation.turnId",
        "turn",
        common,
      ),
      clientId:
        canonicalClientId === null && reportedClientId !== null
          ? value<string>(null, {
              source: "observation.invocation.clientId",
              unit: "identity",
              scope: "process",
              readAtMs: common.readAtMs,
              observedAtMs: common.observedAtMs,
              availability: "unknown",
              reason: "OPENCODE_CLIENT_ID_IS_A_SOURCE_ALIAS_NOT_CANONICAL_ID",
            })
          : textValue(
              canonicalClientId,
              "observation.invocation.clientId",
              "process",
              common,
            ),
      sessionId:
        canonicalSessionId === null && reportedSessionId !== null
          ? value<string>(null, {
              source: "observation.invocation.sessionId",
              unit: "identity",
              scope: "process",
              readAtMs: common.readAtMs,
              observedAtMs: common.observedAtMs,
              availability: "unknown",
              reason: "OPENCODE_SESSION_ID_IS_A_SOURCE_ALIAS_NOT_CANONICAL_ID",
            })
          : textValue(
              canonicalSessionId,
              "observation.invocation.sessionId",
              "process",
              common,
            ),
      documentId: textValue(
        invocation.documentId,
        "observation.invocation.documentId",
        "job",
        common,
      ),
      purpose: textValue(
        invocation.purpose,
        "observation.invocation.purpose",
        "job",
        common,
      ),
      reportedClientId: textValue(
        reportedClientId,
        "observation.invocation.clientId-reported",
        "process",
        common,
      ),
      reportedSessionId: textValue(
        reportedSessionId,
        "observation.invocation.sessionId-reported",
        "process",
        common,
      ),
    },
  };
}

/** Convert gaps only when both source positions prove the skipped interval. */
export function detectConsoleTelemetryGap(
  previous: ConsoleTelemetryCursor,
  current: ConsoleTelemetryCursor,
  detectedAtMs: number,
): ConsoleTelemetryGap | null {
  if (
    previous.sourceId !== current.sourceId ||
    previous.epoch !== current.epoch ||
    previous.positionKind !== current.positionKind ||
    !Number.isSafeInteger(detectedAtMs) ||
    detectedAtMs < 0 ||
    current.position <= previous.position + 1
  )
    return null;
  return {
    sourceId: current.sourceId,
    epoch: current.epoch,
    fromPosition: previous.position + 1,
    toPosition: current.position - 1,
    positionKind: current.positionKind,
    detectedAtMs,
    reason: "SOURCE_POSITION_ADVANCED_WITHOUT_REPLAYED_RECORDS",
  };
}

/** Current counts require the complete source state, never a bounded history page. */
export function currentConsoleTelemetryCounts(
  jobs: readonly unknown[] | null,
  complete: boolean,
  scope: "project" | "broker",
  readAtMs: number,
  source: string,
  observedAtMs: number | null = null,
  freshness: ConsoleTelemetryAvailability = "available",
): ConsoleTelemetryValue<Readonly<Record<ConsoleTelemetryPhase, number>>> {
  if (!jobs || !complete || !["available", "stale"].includes(freshness)) {
    return value<Readonly<Record<ConsoleTelemetryPhase, number>>>(null, {
      source,
      unit: "count",
      scope,
      readAtMs,
      observedAtMs,
      availability:
        freshness === "error" || freshness === "unsupported"
          ? freshness
          : jobs
            ? "unknown"
            : "missing",
      reason: jobs
        ? freshness !== "available" && freshness !== "stale"
          ? `CURRENT_STATE_SOURCE_${freshness.toUpperCase()}`
          : "CURRENT_STATE_SOURCE_IS_INCOMPLETE"
        : "CURRENT_STATE_SOURCE_NOT_AVAILABLE",
    });
  }
  const counts: Record<ConsoleTelemetryPhase, number> = { ...ZERO_PHASES };
  for (const job of jobs) {
    const phase = phaseFor(child(job, "state"));
    counts[phase ?? "unresolved"]++;
  }
  return value(counts, {
    source,
    unit: "count",
    scope,
    readAtMs,
    observedAtMs,
    ...(freshness === "stale"
      ? {
          availability: "stale" as const,
          reason: "CURRENT_STATE_SNAPSHOT_IS_STALE",
        }
      : {}),
  });
}

function projectIdForJob(job: unknown): string | null {
  const request = child(job, "request");
  return text(
    first(
      child(child(request, "clientContext"), "projectId"),
      child(job, "projectId"),
    ),
  );
}

function overviewUnavailable<T>(
  source: string,
  unit: ConsoleTelemetryValue<T>["unit"],
  scope: "project" | "broker",
  readAtMs: number,
  availability: ConsoleTelemetryAvailability,
  reason: string,
  observedAtMs: number | null,
): ConsoleTelemetryValue<T> {
  return value<T>(null, {
    source,
    unit,
    scope,
    readAtMs,
    observedAtMs,
    availability,
    reason,
  });
}

function currentOverview(
  input: ConsoleTelemetrySnapshotInput,
  percentiles: ConsoleTelemetryPercentiles,
  presence: ConsoleTelemetryPresenceSummary,
): ConsoleTelemetryOverview {
  const source = sourceName(input.sourceId, "complete-current-job-source");
  const observedAtMs = input.jobSource.observedAtMs ?? null;
  const sourceAvailability = input.jobSource.freshness ?? "available";
  const currentStateAvailability = !input.jobs
    ? sourceAvailability === "error" || sourceAvailability === "unsupported"
      ? sourceAvailability
      : "missing"
    : !input.jobsComplete
      ? "unknown"
      : sourceAvailability;
  const jobs = input.jobs ?? [];
  const unknownState = jobs.some((job) => !knownState(child(job, "state")));
  const activeJobs = jobs.filter((job) => {
    const state = text(child(job, "state"));
    return state !== null && !TERMINAL.has(state);
  });
  let pendingProject: ConsoleTelemetryValue<number>;
  if (
    currentStateAvailability !== "available" &&
    currentStateAvailability !== "stale"
  ) {
    pendingProject = overviewUnavailable(
      source,
      "count",
      input.jobsScope,
      input.readAtMs,
      currentStateAvailability,
      "COMPLETE_JOB_STATE_REQUIRED_FOR_PENDING_PROJECTS",
      observedAtMs,
    );
  } else if (input.jobsScope === "project" && !input.projectId) {
    pendingProject = overviewUnavailable(
      source,
      "count",
      "project",
      input.readAtMs,
      "missing",
      "PROJECT_SCOPE_NOT_AVAILABLE",
      observedAtMs,
    );
  } else if (unknownState) {
    pendingProject = overviewUnavailable(
      source,
      "count",
      input.jobsScope,
      input.readAtMs,
      "unknown",
      "UNRECOGNIZED_JOB_STATE_MAY_CHANGE_PENDING_PROJECT_COUNT",
      observedAtMs,
    );
  } else if (input.jobsScope === "project") {
    const count = activeJobs.length ? 1 : 0;
    pendingProject = value(count, {
      source: `${source}.active-project-presence`,
      unit: "count",
      scope: "project",
      readAtMs: input.readAtMs,
      observedAtMs,
      ...(currentStateAvailability === "stale"
        ? { availability: "stale" as const, reason: "CURRENT_JOB_STATE_STALE" }
        : {}),
    });
  } else if (
    !input.registeredProjectIds ||
    input.registeredProjectsComplete !== true
  ) {
    pendingProject = overviewUnavailable(
      "project-registry-and-complete-global-job-state",
      "count",
      "broker",
      input.readAtMs,
      input.registeredProjectIds ? "unknown" : "missing",
      "COMPLETE_REGISTERED_PROJECT_SCOPE_REQUIRED",
      observedAtMs,
    );
  } else {
    const registered = new Set(input.registeredProjectIds);
    const pendingIds = activeJobs.map(projectIdForJob);
    const foreignOrUnknown = pendingIds.some(
      (id) => id === null || !registered.has(id),
    );
    pendingProject = foreignOrUnknown
      ? overviewUnavailable(
          "project-registry-and-complete-global-job-state",
          "count",
          "broker",
          input.readAtMs,
          "unknown",
          "PENDING_JOB_PROJECT_SCOPE_NOT_RESOLVED",
          observedAtMs,
        )
      : value(new Set(pendingIds).size, {
          source: "project-registry-and-complete-global-job-state",
          unit: "count",
          scope: "broker",
          readAtMs: input.readAtMs,
          observedAtMs,
          ...(currentStateAvailability === "stale"
            ? {
                availability: "stale" as const,
                reason: "CURRENT_JOB_STATE_STALE",
              }
            : {}),
        });
  }

  const countState = (
    matches: (state: string) => boolean,
    label: string,
  ): ConsoleTelemetryValue<number> => {
    if (
      currentStateAvailability !== "available" &&
      currentStateAvailability !== "stale"
    )
      return overviewUnavailable(
        source,
        "count",
        input.jobsScope,
        input.readAtMs,
        currentStateAvailability,
        "COMPLETE_JOB_STATE_REQUIRED_FOR_OVERVIEW_COUNT",
        observedAtMs,
      );
    if (unknownState)
      return overviewUnavailable(
        source,
        "count",
        input.jobsScope,
        input.readAtMs,
        "unknown",
        `UNRECOGNIZED_JOB_STATE_MAY_CHANGE_${label.toUpperCase()}_COUNT`,
        observedAtMs,
      );
    const count = jobs.filter((job) => {
      const state = text(child(job, "state"));
      return state !== null && matches(state);
    }).length;
    return value(count, {
      source: `${source}.${label}`,
      unit: "count",
      scope: input.jobsScope,
      readAtMs: input.readAtMs,
      observedAtMs,
      ...(currentStateAvailability === "stale"
        ? { availability: "stale" as const, reason: "CURRENT_JOB_STATE_STALE" }
        : {}),
    });
  };

  const from = Math.max(0, input.readAtMs - input.timingWindowMs);
  const unknownExecutionState =
    input.executions?.some(
      (execution) => execution.state === null || !TERMINAL.has(execution.state),
    ) ?? false;
  const reportedExecutionAvailability =
    input.executionsAvailability ??
    (input.executions ? "available" : "missing");
  const failedStateAvailability =
    unknownExecutionState &&
    ["available", "stale"].includes(reportedExecutionAvailability)
      ? "unknown"
      : reportedExecutionAvailability;
  const failedSource = "retained-terminal-execution-events";
  let failedCount = 0;
  let failedBoundaryMissing = false;
  for (const execution of input.executions ?? []) {
    if (execution.state !== "failed") continue;
    const finishedAt = nonnegative(execution.finishedAtMs);
    if (finishedAt === null) {
      failedBoundaryMissing = true;
      break;
    }
    if (finishedAt >= from && finishedAt <= input.readAtMs) failedCount++;
  }
  const failedExecutions: ConsoleTelemetryValue<number> =
    failedStateAvailability !== "available" &&
    failedStateAvailability !== "stale"
      ? overviewUnavailable(
          failedSource,
          "count",
          input.jobsScope,
          input.readAtMs,
          failedStateAvailability,
          "COMPLETE_FAILED_EXECUTION_TIMESTAMPS_REQUIRED",
          observedAtMs,
        )
      : failedBoundaryMissing
        ? overviewUnavailable(
            failedSource,
            "count",
            input.jobsScope,
            input.readAtMs,
            "unknown",
            "FAILED_EXECUTION_FINISH_TIME_NOT_REPORTED",
            observedAtMs,
          )
        : value(failedCount, {
            source: `${failedSource}.failedWithinWindow`,
            unit: "count",
            scope: input.jobsScope,
            readAtMs: input.readAtMs,
            observedAtMs,
            ...(failedStateAvailability === "stale"
              ? {
                  availability: "stale" as const,
                  reason: "TERMINAL_EXECUTION_SOURCE_STALE",
                }
              : {}),
          });

  const windowStatus = input.timingAvailability ?? "available";
  const sampleWindow: ConsoleTelemetryValue<{
    readonly from: number;
    readonly to: number;
  }> =
    windowStatus === "available" || windowStatus === "stale"
      ? value(
          { from, to: input.readAtMs },
          {
            source: "overview.sampleWindow-policy",
            unit: "unix-ms",
            scope: input.timingScope,
            readAtMs: input.readAtMs,
            observedAtMs: input.readAtMs,
            ...(windowStatus === "stale"
              ? {
                  availability: "stale" as const,
                  reason: "TIMING_SOURCE_STALE",
                }
              : {}),
          },
        )
      : overviewUnavailable<{ readonly from: number; readonly to: number }>(
          "overview.sampleWindow-policy",
          "unix-ms",
          input.timingScope,
          input.readAtMs,
          windowStatus,
          "TIMING_WINDOW_SOURCE_UNAVAILABLE",
          null,
        );

  const failedSourceUnavailable: ConsoleTelemetryValue<number> | null =
    input.executions === undefined
      ? overviewUnavailable<number>(
          "retained-execution-events",
          "count",
          input.jobsScope,
          input.readAtMs,
          "missing",
          "RETAINED_TERMINAL_EXECUTION_EVENTS_NOT_PROVIDED",
          observedAtMs,
        )
      : input.executions === null
        ? overviewUnavailable<number>(
            "retained-execution-events",
            "count",
            input.jobsScope,
            input.readAtMs,
            input.executionsAvailability ?? "missing",
            "RETAINED_TERMINAL_EXECUTION_SOURCE_NOT_AVAILABLE",
            observedAtMs,
          )
        : null;

  return {
    pendingProject,
    running: countState((state) => state === "running", "running"),
    unresolved: countState(
      (state) =>
        ["needs_reconciliation", "unresolved", "unknown", "blocked"].includes(
          state,
        ),
      "unresolved",
    ),
    samples: percentiles.sampleCount,
    failedExecutions: failedSourceUnavailable ?? failedExecutions,
    waitMedianMs: percentiles.p50Ms,
    waitP95Ms: percentiles.p95Ms,
    liveReportingSessions: presence.sessionCount,
    sampleWindow,
  };
}

function quantile(
  samples: readonly number[],
  percentile: number,
): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)] ?? null;
}

function median(samples: readonly number[]): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Queue-wait percentiles use every reported queue-wait sample in the full window. */
export function consoleTelemetryPercentiles(
  samples: readonly ConsoleTelemetryTimingSample[] | null,
  readAtMs: number,
  windowMs: number,
  scope: "project" | "broker",
  source: string,
  sourceAvailability: ConsoleTelemetryAvailability = "available",
): ConsoleTelemetrySnapshot["timingPercentiles"] {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0)
    throw new Error("Telemetry percentile window must be a positive integer");
  const available = samples?.filter(
    (sample) =>
      sample.kind === "queueWait" &&
      Number.isFinite(sample.valueMs) &&
      sample.valueMs >= 0 &&
      Number.isSafeInteger(sample.observedAtMs) &&
      sample.observedAtMs <= readAtMs &&
      sample.observedAtMs >= readAtMs - windowMs,
  );
  const sampleValues = available?.map((sample) => sample.valueMs) ?? [];
  const percentileAvailability = !["available", "stale"].includes(
    sourceAvailability,
  )
    ? sourceAvailability
    : samples === null || !sampleValues.length
      ? "missing"
      : sourceAvailability;
  const missingReason = !["available", "stale"].includes(sourceAvailability)
    ? `TIMING_SOURCE_${sourceAvailability.toUpperCase()}`
    : samples === null
      ? "TIMING_SAMPLES_NOT_AVAILABLE"
      : "NO_SAMPLES_IN_WINDOW";
  const common = {
    source,
    unit: "ms" as const,
    scope,
    readAtMs,
  };
  return {
    windowMs,
    sampleCount: value(samples === null ? null : sampleValues.length, {
      ...common,
      unit: "count",
      ...(samples === null ||
      !["available", "stale"].includes(sourceAvailability)
        ? { availability: percentileAvailability, reason: missingReason }
        : sourceAvailability === "stale"
          ? { availability: "stale" as const, reason: "TIMING_SOURCE_STALE" }
          : {}),
    }),
    p50Ms: value<number>(median(sampleValues), {
      ...common,
      ...(percentileAvailability !== "available"
        ? {
            availability: percentileAvailability,
            reason:
              percentileAvailability === "stale"
                ? "TIMING_SOURCE_STALE"
                : missingReason,
          }
        : {}),
    }),
    p95Ms: value<number>(quantile(sampleValues, 0.95), {
      ...common,
      ...(percentileAvailability !== "available"
        ? {
            availability: percentileAvailability,
            reason:
              percentileAvailability === "stale"
                ? "TIMING_SOURCE_STALE"
                : missingReason,
          }
        : {}),
    }),
  };
}

/** Dedupe process observations only by PID plus birth identity, never by PID alone. */
export function summarizeConsolePresence(
  projectId: string | null,
  sources: readonly ConsoleTelemetryPresenceInput[] | null,
  complete: boolean | ConsoleTelemetryPresenceCompleteness,
  readAtMs: number,
  freshnessMs = 15_000,
  scope: "project" | "broker" = "project",
): ConsoleTelemetryPresenceSummary {
  const matched =
    scope === "broker"
      ? (sources ?? null)
      : projectId === null
        ? null
        : (sources?.filter((item) => item.projectId === projectId) ?? null);
  const clientStatus =
    typeof complete === "boolean"
      ? complete
        ? "available"
        : "unknown"
      : complete.clients;
  const openCodeStatus =
    typeof complete === "boolean"
      ? complete
        ? "available"
        : "unknown"
      : complete.openCode;
  const common = {
    readAtMs,
    observedAtMs: null,
  };
  const processes = new Set<string>();
  const clients = new Set<string>();
  const sessions = new Set<string>();
  const agents = new Set<string>();
  const sourceNames = new Set<string>();
  const clientRecords = (matched ?? []).filter(
    (item) => item.source === "project-client-process-heartbeat",
  );
  const openCodeRecords = (matched ?? []).filter(
    (item) => item.source === "opencode-diagnostic-presence",
  );
  const presenceState = (
    item: ConsoleTelemetryPresenceInput,
  ): "observed" | "stale" | "unknown" | "offline" => {
    if (item.presence) return item.presence;
    if (item.alive === false) return "offline";
    if (item.alive !== true || item.observedAtMs === null) return "unknown";
    const age = readAtMs - item.observedAtMs;
    return age < 0 ? "unknown" : age > freshnessMs ? "stale" : "observed";
  };
  for (const item of matched ?? []) {
    sourceNames.add(item.source);
    if (presenceState(item) === "offline") continue;
    if (Number.isSafeInteger(item.pid) && item.pid! > 0 && item.birth) {
      processes.add(`${item.pid}:${item.birth}`);
    }
    if (item.clientId) clients.add(item.clientId);
    if (item.sessionId) sessions.add(`canonical:${item.sessionId}`);
    else if (item.reportedSessionId)
      sessions.add(`reported:${item.source}:${item.reportedSessionId}`);
    if (item.agentId) agents.add(`id:${item.agentId}`);
    else if (item.agent) agents.add(`declared:${item.agent}`);
  }
  const statusFor = (
    status: ConsoleTelemetryAvailability,
    items: readonly ConsoleTelemetryPresenceInput[],
  ): { availability: ConsoleTelemetryAvailability; reason: string | null } => {
    if (projectId === null && scope === "project")
      return { availability: "missing", reason: "PROJECT_SCOPE_NOT_AVAILABLE" };
    if (!sources)
      return {
        availability: "missing",
        reason: "PRESENCE_SOURCES_NOT_AVAILABLE",
      };
    if (!["available", "stale"].includes(status))
      return {
        availability:
          status === "error" || status === "unsupported" || status === "missing"
            ? status
            : "unknown",
        reason: `PRESENCE_SOURCE_${status.toUpperCase()}`,
      };
    if (items.some((item) => presenceState(item) === "unknown"))
      return {
        availability: "unknown",
        reason: "PROCESS_LIVENESS_OR_FRESHNESS_UNCONFIRMED",
      };
    const stale =
      status === "stale" ||
      items.some((item) => presenceState(item) === "stale");
    return stale
      ? { availability: "stale", reason: "PRESENCE_HEARTBEAT_STALE" }
      : { availability: "available", reason: null };
  };
  const processStatus =
    clientStatus === "missing" && openCodeStatus === "missing"
      ? "missing"
      : clientStatus === "error" || openCodeStatus === "error"
        ? "error"
        : clientStatus === "unsupported" || openCodeStatus === "unsupported"
          ? "unsupported"
          : clientStatus === "stale" || openCodeStatus === "stale"
            ? "stale"
            : clientStatus === "available" && openCodeStatus === "available"
              ? "available"
              : "unknown";
  const processAvailability = statusFor(processStatus, [
    ...clientRecords,
    ...openCodeRecords,
  ]);
  const clientAvailability = statusFor(clientStatus, clientRecords);
  const openCodeAvailability = statusFor(openCodeStatus, openCodeRecords);
  const measuredCount = (
    count: number,
    availability: ConsoleTelemetryAvailability,
    reason: string | null,
    source: string,
  ): ConsoleTelemetryValue<number> =>
    value(["available", "stale"].includes(availability) ? count : null, {
      source,
      unit: "count",
      scope,
      ...common,
      ...(availability !== "available" ? { availability, reason } : {}),
    });
  return {
    projectId: value(projectId, {
      source: "selected-project-context",
      unit: "identity",
      scope,
      ...common,
      ...(projectId === null
        ? { availability: "missing" as const, reason: "PROJECT_NOT_SELECTED" }
        : {}),
    }),
    clientSource: value(
      projectId === null && scope === "project" ? "missing" : clientStatus,
      {
        source: "project-client-process-heartbeats",
        unit: "text",
        scope,
        ...common,
      },
    ),
    openCodeSource: value(
      projectId === null && scope === "project" ? "missing" : openCodeStatus,
      {
        source: "opencode-diagnostic-presence",
        unit: "text",
        scope,
        ...common,
      },
    ),
    processCount: measuredCount(
      processes.size,
      processAvailability.availability,
      processAvailability.reason,
      "project-client-and-opencode-process-identities",
    ),
    clientCount: measuredCount(
      clients.size,
      clientAvailability.availability,
      clientAvailability.reason,
      "project-client-process-heartbeats",
    ),
    sessionCount: measuredCount(
      sessions.size,
      openCodeAvailability.availability,
      openCodeAvailability.reason,
      "opencode-diagnostic-presence.sessions",
    ),
    declaredAgentCount: measuredCount(
      agents.size,
      openCodeAvailability.availability,
      openCodeAvailability.reason,
      "opencode-diagnostic-presence.declared-agents",
    ),
    sources: [...sourceNames].sort(),
  };
}

/** Builds the passive read model from already-read sources; no probes or writes. */
export function collectConsoleTelemetry(
  input: ConsoleTelemetrySnapshotInput,
): ConsoleTelemetrySnapshot {
  if (!Number.isSafeInteger(input.readAtMs) || input.readAtMs < 0)
    throw new Error("Telemetry read timestamp must be a nonnegative integer");
  if (!Number.isSafeInteger(input.timingWindowMs) || input.timingWindowMs <= 0)
    throw new Error("Telemetry percentile window must be a positive integer");
  const eventProjectFallback =
    input.jobsScope === "project"
      ? (input.projectId ?? input.jobSource.projectId)
      : input.jobSource.projectId;
  const events = (input.jobs ?? []).map((job) =>
    normalizeConsoleTelemetryJob(job, {
      ...input.jobSource,
      projectId: eventProjectFallback,
      readAtMs: input.readAtMs,
    }),
  );
  const sourceId = text(input.jobSource.sourceId);
  const epoch = text(input.jobSource.epoch);
  const sequence = nonnegative(input.jobSource.sequence);
  const revision = nonnegative(input.jobSource.revision);
  const position = sequence ?? revision;
  const cursor =
    input.sourceCursor ??
    (sourceId && epoch && position !== null
      ? {
          sourceId,
          epoch,
          position,
          positionKind:
            sequence !== null ? ("sequence" as const) : ("revision" as const),
          eventId:
            events
              .map((event) => event.metadata.eventId.value)
              .filter((eventId): eventId is string => eventId !== null)
              .sort((left, right) => left.localeCompare(right))
              .at(-1) ?? null,
        }
      : null);
  const gap =
    input.previousCursor && cursor
      ? detectConsoleTelemetryGap(input.previousCursor, cursor, input.readAtMs)
      : null;
  const sourceAvailability = input.jobSource.freshness ?? "available";
  const eventAvailability = ["error", "unsupported"].includes(
    sourceAvailability,
  )
    ? sourceAvailability
    : !input.jobs
      ? "missing"
      : !input.jobsComplete
        ? "unknown"
        : sourceAvailability;
  const eventReason =
    eventAvailability === "missing"
      ? "CURRENT_JOB_SOURCE_NOT_AVAILABLE"
      : eventAvailability === "unknown"
        ? "CURRENT_JOB_SOURCE_INCOMPLETE"
        : eventAvailability === "stale"
          ? "CURRENT_JOB_SOURCE_STALE"
          : eventAvailability === "error" || eventAvailability === "unsupported"
            ? `CURRENT_JOB_SOURCE_${eventAvailability.toUpperCase()}`
            : null;
  const presenceSources =
    typeof input.presenceComplete === "boolean"
      ? {
          clients: input.presenceComplete
            ? ("available" as const)
            : ("unknown" as const),
          openCode: input.presenceComplete
            ? ("available" as const)
            : ("unknown" as const),
        }
      : input.presenceComplete;
  const presence = summarizeConsolePresence(
    input.projectId ?? null,
    input.presenceSources,
    input.presenceComplete,
    input.readAtMs,
  );
  const timingPercentiles = consoleTelemetryPercentiles(
    input.timingSamples,
    input.readAtMs,
    input.timingWindowMs,
    input.timingScope,
    sourceName(input.sourceId, "retained-queue-wait-samples"),
    input.timingAvailability ?? "available",
  );
  const overview = currentOverview(input, timingPercentiles, presence);
  return {
    version: 1,
    projectId: value(input.projectId ?? null, {
      source: "selected-project-context",
      unit: "identity",
      scope: "project",
      readAtMs: input.readAtMs,
      observedAtMs: input.jobSource.observedAtMs ?? null,
      ...(input.projectId ? {} : { reason: "PROJECT_NOT_SELECTED" }),
    }),
    currentCounts: currentConsoleTelemetryCounts(
      input.jobs,
      input.jobsComplete,
      input.jobsScope,
      input.readAtMs,
      sourceName(input.sourceId, "current-queue-snapshot"),
      input.jobSource.observedAtMs ?? null,
      input.jobSource.freshness ?? "available",
    ),
    events: value(
      ["available", "stale"].includes(eventAvailability) ? events : null,
      {
        source: sourceName(input.sourceId, "complete-current-job-source"),
        unit: "count",
        scope: input.jobsScope,
        readAtMs: input.readAtMs,
        observedAtMs: input.jobSource.observedAtMs ?? null,
        ...(eventAvailability === "available"
          ? {}
          : { availability: eventAvailability, reason: eventReason }),
      },
    ),
    cursor: value(cursor, {
      source: "source-sequence-or-snapshot-revision",
      unit: "identity",
      scope: "event",
      readAtMs: input.readAtMs,
      observedAtMs: input.jobSource.observedAtMs ?? null,
      ...(cursor === null
        ? {
            availability: "unknown" as const,
            reason: "SOURCE_CURSOR_NOT_REPORTED",
          }
        : {}),
    }),
    gaps: value(input.previousCursor && cursor ? (gap ? [gap] : []) : null, {
      source: "source-cursor-gap-detection",
      unit: "count",
      scope: "event",
      readAtMs: input.readAtMs,
      observedAtMs: input.jobSource.observedAtMs ?? null,
      ...(input.previousCursor && cursor
        ? {}
        : {
            availability: "unknown" as const,
            reason: "GAP_BASELINE_OR_CURRENT_CURSOR_NOT_AVAILABLE",
          }),
    }),
    presence,
    presenceObservations: {
      sources: presenceSources,
      records: input.presenceSources ?? [],
    },
    host: normalizeConsoleHostMetrics(
      input.systemMetrics ?? null,
      input.readAtMs,
      input.systemAvailability ?? "available",
    ),
    processes: {
      panel: normalizeConsoleProcess(
        "panel",
        input.panelProcess ?? child(input.systemMetrics, "panel"),
        input.readAtMs,
        "node:http-panel-process",
        nonnegative(child(input.systemMetrics, "readAt")),
        input.systemAvailability ?? "available",
      ),
      broker: normalizeConsoleProcess(
        "broker",
        child(input.systemMetrics, "broker"),
        input.readAtMs,
        "existing-broker-process-identity-and-procfs",
        nonnegative(child(input.systemMetrics, "readAt")),
        input.systemAvailability ?? "available",
      ),
      workers: value(
        input.workerProcesses === null
          ? null
          : (input.workerProcesses ?? []).map((processValue) =>
              normalizeConsoleProcess(
                "worker",
                processValue,
                input.readAtMs,
                "existing-worker-identity-receipt-and-passive-process-check",
                nonnegative(child(processValue, "observedAtMs")),
              ),
            ),
        {
          source: "existing-worker-identity-receipts",
          unit: "count",
          scope: input.workersScope ?? "project",
          readAtMs: input.readAtMs,
          observedAtMs: input.jobSource.observedAtMs ?? null,
          ...(input.workerProcesses === null
            ? {
                availability: "missing" as const,
                reason: "WORKER_SOURCE_NOT_AVAILABLE",
              }
            : input.workersComplete === false
              ? {
                  availability: "unknown" as const,
                  reason: "WORKER_IDENTITY_SET_INCOMPLETE",
                }
              : {}),
        },
      ),
    },
    locks: normalizeConsoleLocks(
      input.locks ?? null,
      input.readAtMs,
      input.locksAvailability ?? "available",
    ),
    timingPercentiles,
    overview,
  };
}

/** Helper for explicit unavailable receipts; absence never implies unlocked/idle. */
export function unavailableConsoleTelemetryValue<T>(input: {
  readonly availability: "missing" | "unsupported" | "unknown" | "error";
  readonly source: string;
  readonly unit: ConsoleTelemetryValue<T>["unit"];
  readonly scope: ConsoleTelemetryValue<T>["scope"];
  readonly readAtMs: number;
  readonly reason: string;
  readonly observedAtMs?: number | null | undefined;
}): ConsoleTelemetryValue<T> {
  return value<T>(null, input);
}

export function consoleTelemetryEventCursor(
  event: ConsoleTelemetryEvent,
): ConsoleTelemetryCursor | null {
  const sourceId = event.metadata.sourceId.value;
  const epoch = event.metadata.epoch.value;
  const sequence = event.metadata.sequence.value;
  const revision = event.metadata.revision.value;
  const eventId = event.metadata.eventId.value;
  if (!sourceId || !epoch) return null;
  if (sequence !== null)
    return {
      sourceId,
      epoch,
      position: sequence,
      positionKind: "sequence",
      eventId,
    };
  if (revision !== null)
    return {
      sourceId,
      epoch,
      position: revision,
      positionKind: "revision",
      eventId,
    };
  return null;
}

/** Replay is source-local, bounded, and reports a skipped source position. */
export function boundedConsoleTelemetryReplay(
  sourceEvents: readonly ConsoleTelemetryEvent[],
  after: ConsoleTelemetryCursor | null,
  limit: number,
  readAtMs: number,
): ConsoleTelemetryReplayBatch {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000)
    throw new Error("Telemetry replay limit must be 1..10000");
  if (!Number.isSafeInteger(readAtMs) || readAtMs < 0)
    throw new Error("Telemetry read timestamp must be a nonnegative integer");
  if (
    after &&
    sourceEvents.some((event) => {
      const cursor = consoleTelemetryEventCursor(event);
      return (
        cursor?.sourceId === after.sourceId && cursor.epoch !== after.epoch
      );
    })
  )
    throw new Error(
      "Telemetry source epoch changed; replay requires a fresh cursor",
    );
  const ordered = sourceEvents
    .map((event) => ({ event, cursor: consoleTelemetryEventCursor(event) }))
    .filter(
      (
        entry,
      ): entry is {
        event: ConsoleTelemetryEvent;
        cursor: ConsoleTelemetryCursor;
      } => entry.cursor !== null,
    )
    .filter(({ cursor }) =>
      after
        ? cursor.sourceId === after.sourceId &&
          cursor.epoch === after.epoch &&
          cursor.positionKind === after.positionKind &&
          (cursor.position > after.position ||
            (cursor.position === after.position &&
              cursor.eventId !== null &&
              after.eventId !== null &&
              cursor.eventId > after.eventId))
        : true,
    );
  const streamIds = new Set(
    ordered.map(({ cursor }) => `${cursor.sourceId}\u0000${cursor.epoch}`),
  );
  if (streamIds.size > 1)
    throw new Error("Telemetry replay must contain one source epoch");
  ordered.sort(
    (left, right) =>
      left.cursor.position - right.cursor.position ||
      (left.cursor.eventId ?? "").localeCompare(right.cursor.eventId ?? ""),
  );
  if (
    ordered.some(
      (entry, index) =>
        index > 0 &&
        entry.cursor.positionKind === "sequence" &&
        ordered[index - 1]!.cursor.position === entry.cursor.position,
    )
  )
    throw new Error(
      "Telemetry replay has ambiguous duplicate source positions",
    );
  const selected = ordered.slice(0, limit);
  const firstCursor = selected[0]?.cursor ?? null;
  const lastCursor = selected.at(-1)?.cursor ?? after;
  const gap =
    after && firstCursor
      ? detectConsoleTelemetryGap(after, firstCursor, readAtMs)
      : !after &&
          firstCursor?.positionKind === "sequence" &&
          firstCursor.position > 1
        ? {
            sourceId: firstCursor.sourceId,
            epoch: firstCursor.epoch,
            fromPosition: 1,
            toPosition: firstCursor.position - 1,
            positionKind: "sequence" as const,
            detectedAtMs: readAtMs,
            reason: "SOURCE_PREFIX_NOT_REPLAYED",
          }
        : null;
  return {
    events: value(
      selected.map(({ event }) => event),
      {
        source: "bounded-telemetry-event-replay",
        unit: "count",
        scope: "event",
        readAtMs,
        observedAtMs:
          selected.at(-1)?.event.metadata.observedAtMs.value ?? null,
      },
    ),
    cursor: value(lastCursor, {
      source: "bounded-telemetry-event-replay",
      unit: "identity",
      scope: "event",
      readAtMs,
      observedAtMs: selected.at(-1)?.event.metadata.observedAtMs.value ?? null,
      ...(lastCursor === null
        ? {
            availability: "missing" as const,
            reason: "NO_REPLAYABLE_EVENT_CURSOR",
          }
        : {}),
    }),
    gaps: value(gap ? [gap] : after && firstCursor ? [] : null, {
      source: "bounded-telemetry-event-replay",
      unit: "count",
      scope: "event",
      readAtMs,
      observedAtMs: selected.at(-1)?.event.metadata.observedAtMs.value ?? null,
      ...((after && firstCursor) ||
      (firstCursor?.positionKind === "sequence" && firstCursor.position > 1)
        ? {}
        : {
            availability: "unknown" as const,
            reason: "GAP_BASELINE_OR_REPLAY_WINDOW_NOT_AVAILABLE",
          }),
    }),
    limit,
    truncated: ordered.length > limit,
  };
}

export function consoleTelemetryEventAvailability(
  event: ConsoleTelemetryEvent,
): ConsoleTelemetryAvailability {
  const metadata = event.metadata;
  return metadata.eventId.availability === "available" &&
    consoleTelemetryEventCursor(event) !== null
    ? "available"
    : "unknown";
}

export function normalizeConsoleFusionReceipt(
  receipt: unknown,
  sourceKind: "preflight" | "postflight",
  context: ConsoleTelemetrySource,
): ConsoleTelemetryFusionObservation {
  const envelope = record(receipt);
  const raw = record(envelope?.["receipt"]) ?? envelope;
  const instance = record(raw?.["instance"]);
  const documentState = record(instance?.["documentState"]);
  const stateIdentity =
    documentState?.["status"] === "complete"
      ? record(record(documentState["state"])?.["identity"])
      : null;
  const observedAtMs = nonnegative(
    envelope?.["observedAtMs"] ?? raw?.["observedAtMs"] ?? raw?.["at"],
  );
  const scoped = {
    ...context,
    observedAtMs: observedAtMs ?? context.observedAtMs,
  };
  const knownSource = sourceName(context.sourceId, "existing-fusion-receipt");
  const completed = raw?.["completed"] === true;
  const receiptState = text(
    first(
      raw?.["state"],
      raw?.["status"],
      raw?.["connectivity"],
      completed ? "observed" : null,
      raw?.["completed"] === false ? "incomplete" : null,
    ),
  );
  const idle =
    typeof raw?.["idle"] === "boolean"
      ? raw["idle"]
      : typeof instance?.["activeCommand"] === "string"
        ? ["", "SelectCommand"].includes(instance["activeCommand"])
        : null;
  return {
    state: textValue(
      receiptState,
      `${knownSource}.${sourceKind}.state`,
      "job",
      scoped,
    ),
    idle: value(idle, {
      source: `${knownSource}.${sourceKind}.idle`,
      unit: null,
      scope: "job",
      readAtMs: context.readAtMs,
      observedAtMs,
      ...(idle === null
        ? {
            availability: "missing" as const,
            reason: "RECEIPT_DID_NOT_REPORT_IDLE_STATE",
          }
        : {}),
    }),
    documentId: textValue(
      first(raw?.["documentId"], raw?.["docId"], stateIdentity?.["creationId"]),
      `${knownSource}.${sourceKind}.documentId`,
      "job",
      scoped,
    ),
    documentFileId: textValue(
      first(
        raw?.["documentFileId"],
        raw?.["docFileId"],
        stateIdentity?.["fileId"],
      ),
      `${knownSource}.${sourceKind}.documentFileId`,
      "job",
      scoped,
    ),
    source: value(sourceKind, {
      source: `${knownSource}.${sourceKind}-receipt`,
      unit: "text",
      scope: "job",
      readAtMs: context.readAtMs,
      observedAtMs,
    }),
  };
}
