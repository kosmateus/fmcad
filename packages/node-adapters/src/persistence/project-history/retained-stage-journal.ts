import * as path from "node:path";
import { boundedConsoleTelemetryReplay } from "@fmcad/core";
import type { ConsoleTelemetryEvent } from "@fmcad/core";
import type { ProjectHistoryIngestBatch } from "../../../../core/src/domain/project-history";
import type { ProjectHistorySourceReader } from "../../../../core/src/ports/project-history";
import type { ProjectRegistryStore } from "../../../../core/src/ports/project-registry";
import type {
  StageEntry,
  StageScope,
} from "../../../../core/src/application/stage-journal";
import { readAdmission } from "../accepted-inputs";
import { regularDirectory } from "../owned-results";
import { openStageJournal } from "../stage-journal";

export interface RetainedStageJournalJob {
  readonly jobId: string;
  readonly clientId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly requestHash: string;
  readonly buildHash: string;
  readonly sequence?: string;
  /** Exact scope supplied by the existing scoped execution-source job record. */
  readonly scope: StageScope;
  /** Only jobs explicitly marked phased by the retained execution source qualify. */
  readonly phased: boolean;
}

export interface RetainedStageJournalOptions {
  readonly projectId: string;
  readonly queueDirectory: string;
  readonly registry: ProjectRegistryStore;
  readonly job: RetainedStageJournalJob;
  readonly validateStageJournal: (
    entries: StageEntry[],
    scope: StageScope,
  ) => void;
  readonly toTelemetryEvent: (
    entry: StageEntry,
    cursor: StageEventIdentity,
  ) => ConsoleTelemetryEvent;
  readonly now?: () => number;
  readonly maxEntries?: number;
  readonly maxDirectoryEntries?: number;
  readonly maxEntryBytes?: number;
  readonly maxTotalBytes?: number;
}

export interface RetainedStageJournalReader extends ProjectHistorySourceReader {
  readonly sourceId: string;
  readonly epoch: string;
}

export interface StageEventIdentity {
  readonly projectId: string;
  readonly sourceId: string;
  readonly epoch: string;
  readonly position: number;
  readonly positionKind: "sequence";
  readonly eventId: string;
  readonly readAtMs: number;
  readonly observedAtMs: null;
}

const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_ENTRIES = 256;
const MAX_DIRECTORY_ENTRIES = 272;
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

function stageEventId(jobId: string, entry: StageEntry): string {
  return `stage-event:${jobId}:${entry.sequence}:${entry.sha256}`;
}

function assertJobScope(
  scope: StageScope,
  job: RetainedStageJournalJob,
  projectRoot: string,
): void {
  if (
    scope.project !== projectRoot ||
    scope.jobId !== job.jobId ||
    scope.owner !== job.clientId ||
    scope.clientId !== job.clientId ||
    scope.requestId !== job.requestId ||
    scope.requestHash !== job.requestHash ||
    scope.build !== job.buildHash ||
    (job.sequence !== undefined && scope.sequence !== job.sequence)
  )
    throw Object.assign(
      new Error(
        "Retained stage journal does not match the registered project/job identity",
      ),
      { code: "STAGE_SCOPE_MISMATCH" },
    );
}

function telemetryEvent(
  entry: StageEntry,
  cursor: StageEventIdentity,
  job: RetainedStageJournalJob,
  map: RetainedStageJournalOptions["toTelemetryEvent"],
): ConsoleTelemetryEvent {
  let event: ConsoleTelemetryEvent;
  try {
    event = map(entry, cursor);
  } catch {
    throw Object.assign(new Error("Stage event mapper failed"), {
      code: "STAGE_EVENT_MAPPING_INVALID",
    });
  }
  const stageIds =
    entry.event.kind === "plan"
      ? entry.event.stages.map((stage) => stage.id)
      : [entry.event.stage];
  const references = event.sourceFiles.value ?? [];
  const eventName =
    entry.event.kind === "plan" ? "fmcad.stage.plan" : "fmcad.stage.started";
  const referencesMatch =
    references.length === stageIds.length &&
    stageIds.every((stageId) =>
      references.some(
        (reference) =>
          reference.kind === "source" &&
          reference.path.value === null &&
          reference.fileId.value === `${entry.sequence}:${stageId}` &&
          reference.artifactId.value === entry.sha256 &&
          reference.sha256.value === entry.sha256 &&
          reference.provenance.value ===
            `retained-stage-journal:${entry.event.kind}`,
      ),
    );
  if (
    event.version !== 1 ||
    event.eventType !== "observation.event" ||
    event.eventName.value !== eventName ||
    event.metadata.eventId.value !== cursor.eventId ||
    event.metadata.sourceId.value !== cursor.sourceId ||
    event.metadata.epoch.value !== cursor.epoch ||
    event.metadata.sequence.value !== cursor.position ||
    event.metadata.revision.value !== null ||
    event.metadata.observedAtMs.value !== null ||
    event.metadata.readAtMs.value !== cursor.readAtMs ||
    event.identity.projectId.value !== cursor.projectId ||
    event.identity.jobId.value !== job.jobId ||
    event.identity.clientId.value !== job.clientId ||
    event.identity.requestId.value !== job.requestId ||
    event.state.value !== null ||
    event.phase.value !== null ||
    event.outputFiles.value !== null ||
    !referencesMatch ||
    event.fusion.state.value !== null ||
    event.fusion.idle.value !== null ||
    event.fusion.documentId.value !== null ||
    event.fusion.documentFileId.value !== null ||
    event.timings.prepareMs.value !== null ||
    event.timings.queueWaitMs.value !== null ||
    event.timings.sdkActiveMs.value !== null ||
    event.timings.pauseMs.value !== null ||
    event.timings.finalizeMs.value !== null ||
    event.timings.totalWorkflowMs.value !== null
  )
    throw Object.assign(
      new Error(
        "Stage event mapper changed canonical source identity or unknown time",
      ),
      { code: "STAGE_EVENT_MAPPING_INVALID" },
    );
  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024)
    throw Object.assign(
      new Error("Canonical stage event exceeds the history event limit"),
      { code: "STAGE_EVENT_TOO_LARGE" },
    );
  if (
    (entry.event.kind === "started" &&
      serialized.includes(entry.event.receipt)) ||
    serialized.includes(entry.scope.project)
  )
    throw Object.assign(
      new Error(
        "Stage event mapper exposed a receipt reference or client path",
      ),
      { code: "STAGE_EVENT_MAPPING_INVALID" },
    );
  return event;
}

function unavailableBatch(
  sourceId: string,
  epoch: string,
  readAtMs: number,
  reason: string,
  availability: "unavailable" | "partial" = "unavailable",
): ProjectHistoryIngestBatch {
  return {
    events: [],
    sourceId,
    epoch,
    availability,
    reason,
    readAtMs,
  };
}

/** Bounded read-only adapter over an existing per-job stage journal. */
export function createRetainedStageJournalReader(
  options: RetainedStageJournalOptions,
): RetainedStageJournalReader {
  const job = options.job;
  if (
    !options.projectId.trim() ||
    options.projectId.length > 256 ||
    /[\x00-\x1f\x7f]/u.test(options.projectId) ||
    !path.isAbsolute(options.queueDirectory) ||
    job.projectId !== options.projectId ||
    !JOB_ID.test(job.jobId) ||
    !job.clientId.trim() ||
    job.clientId.length > 256 ||
    /[\x00-\x1f\x7f]/u.test(job.clientId) ||
    !job.requestId.trim() ||
    job.requestId.length > 256 ||
    /[\x00-\x1f\x7f]/u.test(job.requestId) ||
    !HASH.test(job.requestHash) ||
    !job.scope ||
    typeof job.scope !== "object" ||
    !HASH.test(job.buildHash) ||
    typeof job.phased !== "boolean"
  )
    throw new Error(
      "Retained stage reader requires a canonical, scoped job record",
    );
  if (!job.phased)
    throw Object.assign(new Error("Job has no retained stage-journal source"), {
      code: "STAGE_JOURNAL_NOT_EXPECTED",
    });
  const sourceId = `stage-journal:${job.jobId}`;
  const epoch = job.requestHash;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const maxDirectoryEntries =
    options.maxDirectoryEntries ??
    Math.min(MAX_DIRECTORY_ENTRIES, maxEntries + 16);
  const maxEntryBytes = options.maxEntryBytes ?? MAX_ENTRY_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const now = options.now ?? Date.now;
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > MAX_ENTRIES ||
    !Number.isSafeInteger(maxDirectoryEntries) ||
    maxDirectoryEntries < maxEntries ||
    maxDirectoryEntries > MAX_DIRECTORY_ENTRIES ||
    !Number.isSafeInteger(maxEntryBytes) ||
    maxEntryBytes < 1 ||
    maxEntryBytes > MAX_ENTRY_BYTES ||
    !Number.isSafeInteger(maxTotalBytes) ||
    maxTotalBytes < maxEntryBytes ||
    maxTotalBytes > MAX_TOTAL_BYTES
  )
    throw new Error("Retained stage journal bounds are invalid");

  return {
    sourceId,
    epoch,
    async read(input) {
      if (input.projectId !== options.projectId)
        throw Object.assign(
          new Error("Retained stage read requested another project"),
          {
            code: "PROJECT_ID_MISMATCH",
          },
        );
      const registered = options.registry.lookup(input.projectId);
      if (!registered)
        throw Object.assign(
          new Error("Project is not in the explicit registry"),
          {
            code: "PROJECT_NOT_REGISTERED",
          },
        );
      const projectRoot = registered.path;
      const readAtMs = now();
      if (!Number.isSafeInteger(readAtMs) || readAtMs < 0)
        throw new Error("Retained stage reader clock is invalid");
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > maxEntries
      )
        throw new Error(`Retained stage replay limit must be 1..${maxEntries}`);
      if (
        input.after &&
        (input.after.sourceId !== sourceId ||
          input.after.epoch !== epoch ||
          input.after.positionKind !== "sequence")
      )
        throw Object.assign(
          new Error("Retained stage cursor belongs to another source"),
          {
            code: "HISTORY_CURSOR_MISMATCH",
          },
        );
      try {
        const operationDirectory = regularDirectory(options.queueDirectory, [
          "jobs",
          job.jobId,
        ]);
        const scope = job.scope;
        assertJobScope(scope, job, projectRoot);
        const admission = readAdmission(options.queueDirectory, {
          clientId: job.clientId,
          requestId: job.requestId,
        });
        if (
          admission.status !== "available" ||
          admission.inputIdentity !== scope.inputIdentity
        )
          return unavailableBatch(
            sourceId,
            epoch,
            readAtMs,
            "STAGE_ADMISSION_BINDING_UNAVAILABLE",
          );

        const entries = openStageJournal(
          operationDirectory,
          scope,
          (validatedEntries, journalScope) => {
            try {
              options.validateStageJournal(validatedEntries, journalScope);
            } catch {
              throw Object.assign(
                new Error(
                  "Retained stage journal failed hash-chain validation",
                ),
                { code: "STAGE_JOURNAL_CORRUPT" },
              );
            }
          },
          {
            maxEntries,
            maxDirectoryEntries,
            maxEntryBytes,
            maxTotalBytes,
          },
        ).read();
        if (!entries.length)
          return {
            events: [],
            sourceId,
            epoch,
            availability: "partial",
            reason: "STAGE_JOURNAL_HAS_NO_ENTRIES",
            readAtMs,
          };
        const afterIndex = input.after
          ? entries.findIndex(
              (entry) =>
                entry.sequence === input.after?.position &&
                stageEventId(job.jobId, entry) === input.after.eventId,
            )
          : -1;
        if (input.after && afterIndex < 0)
          return unavailableBatch(
            sourceId,
            epoch,
            readAtMs,
            "STAGE_JOURNAL_CURSOR_NOT_RETAINED",
            "partial",
          );
        const pageEntries = entries.slice(
          afterIndex + 1,
          afterIndex + input.limit + 1,
        );
        const hasMore = entries.length > afterIndex + input.limit + 1;
        const sourceEvents = pageEntries.map((entry) =>
          telemetryEvent(
            entry,
            {
              projectId: job.projectId,
              sourceId,
              epoch,
              position: entry.sequence,
              positionKind: "sequence",
              eventId: stageEventId(job.jobId, entry),
              readAtMs,
              observedAtMs: null,
            },
            job,
            options.toTelemetryEvent,
          ),
        );
        const replay = boundedConsoleTelemetryReplay(
          sourceEvents,
          input.after,
          input.limit,
          readAtMs,
        );
        const replayEvents = replay.events.value ?? [];
        const sourceGaps = replay.gaps.value ?? [];
        // The validated stage journal proves sequence zero and a contiguous hash chain.
        const completeFromOrigin =
          entries[0]?.sequence === 0 && sourceGaps.length === 0;
        const availability =
          replay.truncated || hasMore
            ? "partial"
            : sourceGaps.length
              ? "partial"
              : "available";
        const cursor = replay.cursor.value;
        return {
          events: replayEvents,
          sourceId,
          epoch,
          cursor,
          gaps: completeFromOrigin && sourceGaps.length === 0 ? [] : sourceGaps,
          availability,
          reason:
            replay.truncated || hasMore
              ? "STAGE_JOURNAL_REPLAY_PAGE_TRUNCATED"
              : availability === "partial"
                ? "STAGE_JOURNAL_REPLAY_GAP_OR_BASELINE_UNKNOWN"
                : null,
          observedAtMs: null,
          readAtMs,
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "STAGE_JOURNAL_SEQUENCE_GAP") {
          const gapError = error as Error & {
            fromPosition?: number;
            toPosition?: number;
          };
          const fromPosition = gapError.fromPosition;
          const toPosition = gapError.toPosition;
          return {
            ...unavailableBatch(
              sourceId,
              epoch,
              readAtMs,
              "STAGE_JOURNAL_SEQUENCE_GAP",
              "partial",
            ),
            gaps:
              Number.isSafeInteger(fromPosition) &&
              fromPosition! >= 0 &&
              Number.isSafeInteger(toPosition) &&
              toPosition! >= fromPosition!
                ? [
                    {
                      sourceId,
                      epoch,
                      fromPosition: fromPosition!,
                      toPosition: toPosition!,
                      positionKind: "sequence",
                      detectedAtMs: readAtMs,
                      reason: "STAGE_JOURNAL_SEQUENCE_GAP",
                    },
                  ]
                : [],
          };
        }
        const reason =
          code === "STAGE_JOURNAL_BOUND_EXCEEDED"
            ? "STAGE_JOURNAL_BOUND_EXCEEDED"
            : code === "STAGE_EVENT_TOO_LARGE"
              ? "STAGE_EVENT_TOO_LARGE"
              : code === "ENOENT"
                ? "STAGE_JOURNAL_MISSING"
                : code === "STAGE_SCOPE_MISMATCH"
                  ? "STAGE_JOURNAL_FOREIGN_SCOPE"
                  : code === "CORRUPT_STATE" ||
                      code === "INVALID_ARTIFACT" ||
                      code === "STAGE_JOURNAL_CORRUPT"
                    ? "STAGE_JOURNAL_CORRUPT"
                    : code === "STAGE_EVENT_MAPPING_INVALID"
                      ? "STAGE_EVENT_MAPPING_INVALID"
                      : "STAGE_JOURNAL_UNAVAILABLE";
        return unavailableBatch(
          sourceId,
          epoch,
          readAtMs,
          reason,
          code === "STAGE_JOURNAL_BOUND_EXCEEDED" ||
            code === "STAGE_EVENT_TOO_LARGE"
            ? "partial"
            : "unavailable",
        );
      }
    },
  };
}
