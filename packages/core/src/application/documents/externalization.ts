import { clone } from "./json";

export interface ExternalizationItem {
  itemId: string;
  [key: string]: unknown;
}
export interface ExternalizationRequest {
  operationId: string;
  reportPath: string;
  phase: string;
  mode: string;
  resume: boolean;
  timeBudgetMs: number;
  maxItems: number;
  maxChecks: number;
  verificationScope?: string;
  itemIds?: string[];
  items: ExternalizationItem[];
  source: unknown;
  [key: string]: unknown;
}
export interface ExternalizationCheck {
  checkId: string;
  [key: string]: unknown;
}
export interface ExternalizationReceipt {
  cursor?: number;
  checks?: ExternalizationCheck[];
  remainingCheckIds?: string[];
  awaitingItems?: string[];
  localStaged?: boolean;
  refreshRequest?: Record<string, unknown>;
  refreshReceipt?: Record<string, unknown>;
  stopReason?: string;
  [key: string]: unknown;
}
export interface ExternalizationState {
  status: string;
  receipt: ExternalizationReceipt | null;
  lifecycleEffects?: unknown[];
  uploadStatus?: string;
  rawUploadState?: unknown;
  completedChecks?: number;
  stopReason?: string;
  defer?: boolean;
  waitingPublication?: boolean;
  [key: string]: unknown;
}
export interface ExternalizationEntry {
  itemId: string;
  uploadStatus: string;
  rawUploadState: unknown;
  phaseResults: {
    copy: ExternalizationState;
    verify: { sources: ExternalizationState; assembly: ExternalizationState };
    stage: ExternalizationState;
    retire: ExternalizationState;
    finalize: ExternalizationState;
  };
}
export interface ExternalizationPending {
  stepId: string;
  phase: string;
  itemId: string;
  refreshRequest?: Record<string, unknown>;
  copyIntent?: unknown;
}
export interface ExternalizationResult {
  schemaVersion: number;
  operation: string;
  operationId: string;
  invocationStatus: string;
  migrationComplete: boolean;
  budgetExceeded: boolean;
  actualElapsedMs: number;
  byItem: Record<string, ExternalizationEntry>;
  lifecycleEffects: unknown[];
  pending: ExternalizationPending | null;
  continuation: null | {
    operationId: string;
    reportPath: string;
    remainingItemIds: string[];
    remainingCheckIds: string[];
    nextPhase?: string | null;
    canResume: boolean;
    reason: string;
  };
  error?: string;
  reconciledErrors?: { stepId: string; error: string }[];
  consideredItems?: number;
  completedChecks?: number;
  [key: string]: unknown;
}
export interface ExternalizationStored {
  manifest: unknown;
  requestHash: string;
  operationId: string;
  sessionNonce: string;
  [key: string]: unknown;
}
export interface ExternalizationRecord {
  result: ExternalizationResult;
}
export interface ExternalizationJournal {
  stored: ExternalizationStored;
  records: ExternalizationRecord[];
  writerActive(): Promise<boolean>;
  acquire(): Promise<null | (() => Promise<void>)>;
  persist(event: string, result: ExternalizationResult): Promise<void>;
}
export interface ExternalizationServices {
  validate(input: unknown): ExternalizationRequest;
  requestHash(data: ExternalizationRequest): string;
  open(data: ExternalizationRequest): Promise<ExternalizationJournal | null>;
  restore(
    result: ExternalizationResult,
    records: ExternalizationRecord[],
  ): void;
  copyIntent(
    stored: ExternalizationStored,
    item: ExternalizationItem,
    state: ExternalizationState,
    result: ExternalizationResult,
  ): unknown;
  preserveCursor(
    state: ExternalizationState,
    output: ExternalizationState,
  ): void;
  inspect(
    stored: ExternalizationStored,
    result: ExternalizationResult,
  ): Promise<
    Record<string, unknown> & {
      stepId?: string;
      terminal?: boolean;
      result?: ExternalizationState;
    }
  >;
  perform(request: {
    stored: ExternalizationStored;
    result: ExternalizationResult;
    phase: string;
    itemId: string;
    stepId: string;
    remainingMs: number;
    outerReadOnly: boolean;
    copyIntent?: unknown;
  }): Promise<ExternalizationState>;
  refresh(request: Record<string, unknown>): Promise<
    Record<string, unknown> & {
      invocationStatus?: string;
      lifecycleEffects?: unknown[];
      writerActive?: boolean;
      latestReceipt?: { result?: Record<string, unknown> };
    }
  >;
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const phaseOrder = [
  "copy",
  "verify:sources",
  "stage",
  "verify:assembly",
  "retire",
  "finalize",
] as const;
export function slot(
  item: ExternalizationEntry,
  phase: string,
): ExternalizationState {
  switch (phase) {
    case "copy":
      return item.phaseResults.copy;
    case "verify:sources":
      return item.phaseResults.verify.sources;
    case "stage":
      return item.phaseResults.stage;
    case "verify:assembly":
      return item.phaseResults.verify.assembly;
    case "retire":
      return item.phaseResults.retire;
    case "finalize":
      return item.phaseResults.finalize;
    default:
      throw new Error("Invalid externalization phase: " + phase);
  }
}
const done = (state: ExternalizationState): boolean =>
  ["complete", "notApplicable"].includes(state.status);
export function completeMigration(result: ExternalizationResult): boolean {
  return Object.values(result.byItem).every((item) =>
    phaseOrder.every((phase) => done(slot(item, phase))),
  );
}
export function initial(data: ExternalizationRequest): ExternalizationResult {
  const blank = (): ExternalizationState => ({
    status: "notStarted",
    receipt: null,
  });
  return {
    schemaVersion: 1,
    operation: "component.externalize",
    operationId: data.operationId,
    invocationStatus: "partial",
    migrationComplete: false,
    budgetExceeded: false,
    actualElapsedMs: 0,
    byItem: Object.fromEntries(
      data.items.map((item) => [
        item.itemId,
        {
          itemId: item.itemId,
          uploadStatus: "notStarted",
          rawUploadState: null,
          phaseResults: {
            copy: blank(),
            verify: { sources: blank(), assembly: blank() },
            stage: blank(),
            retire: blank(),
            finalize: blank(),
          },
        },
      ]),
    ),
    lifecycleEffects: [],
    pending: null,
    continuation: null,
  };
}
const requireThat = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Every phase intent is durable before its effect; unresolved phases are inspected, never replayed. */
export async function executeExternalization(
  input: unknown,
  readOnly: boolean,
  services: ExternalizationServices,
): Promise<ExternalizationResult> {
  const data = services.validate(input),
    started = services.now(),
    deadline = started + data.timeBudgetMs;
  const journal = await services.open(data);
  if (!journal)
    return {
      ...initial(data),
      requestHash: services.requestHash(data),
      byItem: {},
      actualElapsedMs: services.now() - started,
      invocationStatus: "unknown",
      inspection: {
        status: "unavailable",
        reason: "No immutable externalization manifest exists",
      },
      writerActive: false,
    };
  const stored = journal.stored,
    records = journal.records;
  const result = records.length ? clone(records.at(-1)!.result) : initial(data);
  services.restore(result, records);
  const persist = async (event: string): Promise<void> => {
    result.actualElapsedMs = services.now() - started;
    result.budgetExceeded = services.now() > deadline;
    await journal.persist(event, clone(result));
  };
  if (data.phase === "inspect") {
    if (await journal.writerActive())
      return {
        ...result,
        invocationStatus: "unknown",
        writerActive: true,
        inspection: { status: "writerActive", lifecycleEffects: [] },
      };
    return {
      ...result,
      inspection: await services.inspect(stored, result),
      writerActive: false,
    };
  }
  requireThat(
    !records.length || data.resume,
    "Existing operation requires resume:true; never starts a second migration",
  );
  const release = await journal.acquire();
  if (!release)
    return { ...result, invocationStatus: "unknown", writerActive: true };
  let checks = 0;
  const entry = (id: string): ExternalizationEntry => {
    const item = result.byItem[id];
    if (!item) throw new Error("Unknown externalization item: " + id);
    return item;
  };
  try {
    if (result.pending) {
      const pending = result.pending;
      let receipt:
        Awaited<ReturnType<ExternalizationServices["inspect"]>> | undefined;
      if (pending.refreshRequest) {
        const refreshed = await services.refresh({
          ...pending.refreshRequest,
          phase: "inspect",
        });
        const observed = refreshed.latestReceipt?.result;
        if (
          refreshed.writerActive !== true &&
          observed?.["invocationStatus"] === "complete" &&
          observed["success"] === true &&
          observed["inProgress"] === null
        ) {
          const prior = slot(entry(pending.itemId), pending.phase);
          receipt = {
            stepId: pending.stepId,
            terminal: true,
            result: {
              ...prior,
              receipt: { ...prior.receipt, refreshReceipt: observed },
            },
          };
        }
      } else receipt = await services.inspect(stored, result);
      if (
        receipt?.stepId !== pending.stepId ||
        !receipt?.terminal ||
        !receipt.result
      ) {
        result.invocationStatus = "unknown";
        result.continuation = {
          operationId: data.operationId,
          reportPath: data.reportPath,
          remainingItemIds: [],
          remainingCheckIds: [],
          canResume: false,
          reason: "unknownExecution",
        };
        await persist("unresolved");
        return result;
      }
      Object.assign(slot(entry(pending.itemId), pending.phase), receipt.result);
      if (result.error) {
        result.reconciledErrors = [
          ...(result.reconciledErrors ?? []),
          { stepId: pending.stepId, error: result.error },
        ];
        delete result.error;
      }
      result.pending = null;
      await persist("reconciledOriginal");
    }
    if (
      Object.values(result.byItem).some((item) =>
        phaseOrder.some((phase) =>
          ["failed", "unknown"].includes(slot(item, phase).status),
        ),
      )
    ) {
      result.invocationStatus = "blocked";
      result.continuation = {
        operationId: data.operationId,
        reportPath: data.reportPath,
        remainingItemIds: [],
        remainingCheckIds: [],
        canResume: false,
        reason: "unsupported",
      };
      await persist("failedEffectRequiresExplicitReconciliation");
      return result;
    }
    const selected = data.items.filter(
      (item) => !data.itemIds || data.itemIds.includes(item.itemId),
    );
    const order =
      data.phase === "run"
        ? phaseOrder
        : [
            data.phase === "verify"
              ? "verify:" + data.verificationScope
              : data.phase,
          ];
    const stop = (reason: string, phase: string, itemId: string): void => {
      result.invocationStatus =
        reason === "unknownExecution" ? "unknown" : "partial";
      result.continuation = {
        operationId: data.operationId,
        reportPath: data.reportPath,
        remainingItemIds: selected
          .filter(
            (item) => !order.every((p) => done(slot(entry(item.itemId), p))),
          )
          .map((item) => item.itemId),
        remainingCheckIds:
          slot(entry(itemId), phase).receipt?.remainingCheckIds ?? [],
        nextPhase: phase,
        canResume: ["budgetExhausted", "pendingPublication"].includes(reason),
        reason,
      };
    };
    const ready = selected.filter(
      (item) => !order.every((phase) => done(slot(entry(item.itemId), phase))),
    );
    const awaiting = (item: ExternalizationItem): number =>
      Number(
        !!slot(entry(item.itemId), "stage").receipt?.awaitingItems?.some(
          (id) => !slot(entry(id), "stage").receipt?.localStaged,
        ),
      );
    ready.sort((a, b) => awaiting(a) - awaiting(b));
    const admitted = ready.slice(0, data.maxItems);
    for (const phase of order) {
      const phaseItems = [...admitted];
      for (const item of phaseItems) {
        const currentEntry = entry(item.itemId),
          state = slot(currentEntry, phase);
        if (done(state)) continue;
        if (
          phase === "retire" &&
          ["composeNew", "replaceExternal"].includes(data.mode)
        ) {
          Object.assign(state, {
            status: "notApplicable",
            receipt: { reason: "notApplicable" },
          });
          await persist("retireNotApplicable");
          continue;
        }
        const prerequisites =
          phase === "verify:sources"
            ? ["copy"]
            : phase === "stage"
              ? ["copy", "verify:sources"]
              : phase === "verify:assembly"
                ? ["stage"]
                : phase === "retire"
                  ? ["stage", "verify:sources", "verify:assembly"]
                  : phase === "finalize"
                    ? [
                        "stage",
                        "verify:sources",
                        "verify:assembly",
                        ...(["composeNew", "replaceExternal"].includes(
                          data.mode,
                        )
                          ? []
                          : ["retire"]),
                      ]
                    : [];
        if (prerequisites.some((p) => !done(slot(currentEntry, p)))) {
          state.status = "blocked";
          state.receipt = { reason: "phasePrerequisite" };
          result.invocationStatus = "blocked";
          await persist("blocked");
          return result;
        }
        while (!done(state)) {
          if (services.now() >= deadline || checks >= data.maxChecks) {
            stop("budgetExhausted", phase, item.itemId);
            await persist("boundedStop");
            return result;
          }
          const stepId =
            phase +
            ":" +
            item.itemId +
            ":" +
            (state.receipt?.cursor ?? 0) +
            ":" +
            journal.records.length;
          const intent =
            phase === "copy"
              ? services.copyIntent(stored, item, state, result)
              : undefined;
          result.pending = {
            stepId,
            phase,
            itemId: item.itemId,
            ...(intent ? { copyIntent: intent } : {}),
          };
          await persist("preSubmit");
          let output: ExternalizationState;
          try {
            output = await services.perform({
              stored,
              result: clone(result),
              phase,
              itemId: item.itemId,
              stepId,
              remainingMs: deadline - services.now(),
              outerReadOnly: readOnly,
              ...(intent ? { copyIntent: intent } : {}),
            });
          } catch (error) {
            result.error = errorMessage(error);
            stop("unknownExecution", phase, item.itemId);
            await persist("unknown");
            return result;
          }
          if (output.status === "unknown") {
            state.status = "unknown";
            state.receipt = output.receipt ?? null;
            stop("unknownExecution", phase, item.itemId);
            await persist("unknown");
            return result;
          }
          requireThat(
            [
              "pending",
              "complete",
              "notApplicable",
              "failed",
              "blocked",
            ].includes(output.status),
            "Invalid native phase status",
          );
          const refreshRequested = !!output.receipt?.refreshRequest;
          if (output.receipt?.checks) {
            const prior = state.receipt?.checks ?? [],
              added = output.receipt.checks;
            requireThat(
              !added.some((check) =>
                prior.some((old) => old.checkId === check.checkId),
              ),
              "Duplicate completed verification check",
            );
            output.receipt.checks = [...prior, ...added];
          }
          if (output.receipt)
            output.receipt = { ...(state.receipt ?? {}), ...output.receipt };
          services.preserveCursor(state, output);
          Object.assign(state, output);
          result.pending = null;
          result.lifecycleEffects.push(...(output.lifecycleEffects ?? []));
          if (output.uploadStatus)
            currentEntry.uploadStatus = ["queued", "accepted"].includes(
              output.uploadStatus,
            )
              ? "pending"
              : output.uploadStatus;
          if (output.rawUploadState !== undefined)
            currentEntry.rawUploadState = output.rawUploadState;
          checks += output.completedChecks ?? 0;
          await persist("observed");
          const stopReason = output.stopReason ?? output.receipt?.stopReason;
          if (stopReason !== undefined) {
            requireThat(
              stopReason === "budgetExhausted",
              "Invalid native externalization stop reason",
            );
            stop(stopReason, phase, item.itemId);
            await persist("boundedStop");
            return result;
          }
          if (output.defer === true) {
            if (
              output.receipt?.awaitingItems?.some(
                (id) => !admitted.some((row) => row.itemId === id),
              )
            ) {
              stop("budgetExhausted", phase, item.itemId);
              await persist("boundedDependencyStop");
              return result;
            }
            phaseItems.push(item);
            break;
          }
          if (refreshRequested) {
            const refreshRequest = output.receipt!.refreshRequest!;
            result.pending = {
              stepId: stepId + ":refresh",
              phase,
              itemId: item.itemId,
              refreshRequest,
            };
            await persist("consumerRefreshPreSubmit");
            let refresh: Awaited<
              ReturnType<ExternalizationServices["refresh"]>
            >;
            try {
              refresh = await services.refresh(refreshRequest);
            } catch (error) {
              result.error = errorMessage(error);
              if (
                error !== null &&
                typeof error === "object" &&
                "fmcadReadOnlyFailure" in error &&
                error.fmcadReadOnlyFailure ===
                  "references.refresh graph result shape"
              ) {
                state.status = "failed";
                state.receipt!.refreshReceipt = {
                  phase: refreshRequest["phase"],
                  invocationStatus: "failed",
                  success: false,
                  modelValidated: false,
                  failureStage: error.fmcadReadOnlyFailure,
                  error: result.error,
                };
                result.pending = null;
                result.invocationStatus = "failed";
                await persist("consumerRefreshNotComplete");
                return result;
              }
              stop("unknownExecution", phase, item.itemId);
              await persist("consumerRefreshUnknown");
              return result;
            }
            result.lifecycleEffects.push(...(refresh.lifecycleEffects ?? []));
            if (refresh.invocationStatus !== "complete") {
              state.status =
                refresh.invocationStatus === "unknown" ? "unknown" : "failed";
              state.receipt!.refreshReceipt = refresh;
              result.invocationStatus = state.status;
              if (state.status !== "unknown") result.pending = null;
              await persist("consumerRefreshNotComplete");
              return result;
            }
            state.receipt!.refreshReceipt = refresh;
            result.pending = null;
            await persist("consumerRefreshComplete");
          }
          if (["failed", "blocked"].includes(output.status)) {
            result.invocationStatus = output.status;
            await persist("stopped");
            return result;
          }
          if (output.waitingPublication) {
            if (services.now() + 200 >= deadline) {
              stop("pendingPublication", phase, item.itemId);
              await persist("publicationPending");
              return result;
            }
            await services.sleep(200);
          }
          if (!done(state) && output.receipt?.cursor === undefined)
            throw new Error("Native pending step omitted its durable cursor");
        }
      }
    }
    result.migrationComplete = completeMigration(result);
    result.invocationStatus = selected.every((item) =>
      order.every((phase) => done(slot(entry(item.itemId), phase))),
    )
      ? "complete"
      : "partial";
    const remaining = data.items.filter(
      (item) =>
        !phaseOrder.every((phase) => done(slot(entry(item.itemId), phase))),
    );
    const nextPhase =
      remaining
        .map((item) =>
          phaseOrder.find((phase) => !done(slot(entry(item.itemId), phase))),
        )
        .find(Boolean) ?? null;
    result.continuation = {
      operationId: data.operationId,
      reportPath: data.reportPath,
      remainingItemIds: remaining.map((item) => item.itemId),
      remainingCheckIds: [],
      nextPhase,
      canResume: result.invocationStatus !== "unknown",
      reason:
        result.invocationStatus === "complete" ? "complete" : "budgetExhausted",
    };
    result.consideredItems = admitted.length;
    result.completedChecks = checks;
    await persist("settled");
    return result;
  } finally {
    await release();
  }
}
