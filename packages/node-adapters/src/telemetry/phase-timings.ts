import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  QueueSnapshot,
  QueueJob,
} from "../../../core/src/domain/queue-model";
import { durable, readJson } from "../persistence/records";

export type MeasuredPhase =
  "prepare" | "queueWait" | "sdkActive" | "pause" | "finalize";
export interface PhaseTotal {
  durationMs: number;
  intervals: number;
  complete: boolean;
}
export interface PhaseTimingReceipt {
  version: 1;
  jobId: string;
  jobHash: string;
  producerEpoch: string;
  observedAtMs: number;
  totals: Partial<Record<MeasuredPhase, PhaseTotal>>;
  queueWaitSamples: { valueMs: number; observedAtMs: number }[];
  active: { queue: MeasuredPhase | null; local: MeasuredPhase | null };
}
type Channel = "queue" | "local";
interface Tracked {
  receipt: PhaseTimingReceipt;
  starts: Partial<Record<Channel, number>>;
  root: string;
}
const phases: readonly MeasuredPhase[] = [
  "prepare",
  "queueWait",
  "sdkActive",
  "pause",
  "finalize",
];
const MAX_SAMPLES = 64;
const MAX_TRACKED = 4096;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
function receiptPath(root: string, jobId: string): string {
  if (!/^[A-Za-z0-9_-]{1,256}$/u.test(jobId))
    throw new Error("Invalid timing job identity");
  return path.join(root, "jobs", jobId, "phase-timings.json");
}
/** A retained source receipt is useful only for the exact immutable queue job. */
export function readPhaseTimingReceipt(
  root: string,
  job: Pick<QueueJob, "id" | "hash">,
): PhaseTimingReceipt | null {
  let raw: unknown;
  try {
    raw = readJson(receiptPath(root, job.id), 32 * 1024);
  } catch {
    return null;
  }
  if (
    !record(raw) ||
    raw["version"] !== 1 ||
    raw["jobId"] !== job.id ||
    raw["jobHash"] !== job.hash ||
    typeof raw["producerEpoch"] !== "string" ||
    !finite(raw["observedAtMs"]) ||
    !record(raw["totals"]) ||
    !record(raw["active"]) ||
    !Array.isArray(raw["queueWaitSamples"]) ||
    raw["queueWaitSamples"].length > MAX_SAMPLES
  )
    return null;
  for (const [phase, total] of Object.entries(raw["totals"])) {
    if (
      !phases.includes(phase as MeasuredPhase) ||
      !record(total) ||
      !finite(total["durationMs"]) ||
      !Number.isSafeInteger(total["intervals"]) ||
      !finite(total["intervals"]) ||
      typeof total["complete"] !== "boolean"
    )
      return null;
  }
  if (
    raw["queueWaitSamples"].some(
      (sample: unknown) =>
        !record(sample) ||
        !finite(sample["valueMs"]) ||
        !finite(sample["observedAtMs"]),
    )
  )
    return null;
  for (const channel of ["queue", "local"] as const) {
    const phase = raw["active"][channel];
    if (
      phase !== null &&
      (typeof phase !== "string" || !phases.includes(phase as MeasuredPhase))
    )
      return null;
  }
  return raw as unknown as PhaseTimingReceipt;
}

/** Actual transition producer: monotonic durations, bounded metadata, no SDK calls. */
export function createPhaseTimingProducer(
  options: {
    monotonicNow?: () => number;
    wallNow?: () => number;
    epoch?: string;
  } = {},
) {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const wallNow = options.wallNow ?? Date.now;
  const epoch = options.epoch ?? randomUUID();
  const tracked = new Map<string, Tracked>();
  const observedRoots = new Set<string>();
  const key = (root: string, id: string) => root + "\0" + id;
  function obtain(root: string, job: QueueJob): Tracked | null {
    const identity = key(root, job.id);
    const found = tracked.get(identity);
    if (found) return found.receipt.jobHash === job.hash ? found : null;
    if (tracked.size >= MAX_TRACKED) return null;
    const prior = readPhaseTimingReceipt(root, job);
    const receipt: PhaseTimingReceipt = prior ?? {
      version: 1,
      jobId: job.id,
      jobHash: job.hash,
      producerEpoch: epoch,
      observedAtMs: wallNow(),
      totals: {},
      queueWaitSamples: [],
      active: { queue: null, local: null },
    };
    // No clock interval may cross a process restart. Preserve measured closed
    // intervals but explicitly invalidate totals whose last boundary was lost.
    for (const phase of Object.values(receipt.active))
      if (phase !== null) {
        const total = receipt.totals[phase] ?? {
          durationMs: 0,
          intervals: 0,
          complete: false,
        };
        total.complete = false;
        receipt.totals[phase] = total;
      }
    receipt.active = { queue: null, local: null };
    receipt.producerEpoch = epoch;
    const item: Tracked = { receipt, starts: {}, root };
    tracked.set(identity, item);
    return item;
  }
  function save(item: Tracked): void {
    item.receipt.observedAtMs = wallNow();
    const file = receiptPath(item.root, item.receipt.jobId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    durable(file, item.receipt);
  }
  function transition(
    root: string,
    job: QueueJob,
    channel: Channel,
    next: MeasuredPhase | null,
    inherited = false,
    completed = true,
  ): void {
    const item = obtain(root, job);
    if (!item) return;
    const previous = item.receipt.active[channel];
    if (previous === next) return;
    const now = monotonicNow(),
      started = item.starts[channel];
    if (previous !== null) {
      const total = item.receipt.totals[previous] ?? {
        durationMs: 0,
        intervals: 0,
        complete: true,
      };
      if (!completed || started === undefined || !finite(now) || now < started)
        total.complete = false;
      else {
        const durationMs = now - started;
        total.durationMs += durationMs;
        total.intervals++;
        if (previous === "queueWait") {
          item.receipt.queueWaitSamples.push({
            valueMs: durationMs,
            observedAtMs: wallNow(),
          });
          if (item.receipt.queueWaitSamples.length > MAX_SAMPLES)
            item.receipt.queueWaitSamples.shift();
        }
      }
      item.receipt.totals[previous] = total;
    }
    item.receipt.active[channel] = next;
    if (next !== null) {
      if (inherited) delete item.starts[channel];
      else item.starts[channel] = now;
      if (inherited) {
        const total = item.receipt.totals[next] ?? {
          durationMs: 0,
          intervals: 0,
          complete: false,
        };
        total.complete = false;
        item.receipt.totals[next] = total;
      }
    } else delete item.starts[channel];
    save(item);
  }
  return {
    /** Called synchronously after a successful durable queue commit, never by a reader/poll. */
    queueCommitted(snapshot: QueueSnapshot, root: string): void {
      try {
        const initial = !observedRoots.has(root);
        observedRoots.add(root);
        for (const job of Object.values(snapshot.jobs)) {
          const phase =
            job.state === "queued"
              ? snapshot.paused
                ? "pause"
                : "queueWait"
              : job.state === "sending"
                ? "sdkActive"
                : null;
          if (phase !== null || tracked.has(key(root, job.id)))
            transition(
              root,
              job,
              "queue",
              phase,
              initial,
              job.state !== "needs_reconciliation",
            );
          if (
            tracked.has(key(root, job.id)) &&
            [
              "succeeded",
              "failed",
              "cancelled",
              "expired",
              "needs_reconciliation",
            ].includes(job.state)
          ) {
            transition(root, job, "local", null);
            tracked.delete(key(root, job.id));
          }
        }
      } catch {
        /* Telemetry failure never changes admission or execution. */
      }
    },
    localPhase(
      root: string,
      job: QueueJob,
      phase: "prepare" | "finalize" | null,
    ): void {
      try {
        transition(root, job, "local", phase);
      } catch {
        /* Passive metadata only. */
      }
    },
  };
}
