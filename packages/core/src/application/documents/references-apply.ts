import { clone, hash } from "./json";
import type {
  ReferenceInput,
  ReferencePlan,
  ReferenceJournal,
  ReferenceReport,
} from "./references";

export interface ReferenceDocument extends Record<string, unknown> {
  fileId: string;
  projectId: string;
  name: string;
  version: number;
  latestVersion?: number;
  openedByRequest?: boolean;
  ownedCreationId?: unknown;
  parameters?: unknown[];
  userParameters?: unknown[];
  metadata?: unknown;
  identityAfter?: unknown;
  checks?: ReferenceChecks;
  status?: string;
  saveStatus?: string;
  coldVerified?: boolean | null;
  resultingVersion?: number;
  method?: string;
  metadataCoverage?: unknown;
}
export interface ReferenceEdge extends Record<string, unknown> {
  edgeId: string;
  ownerFileId: string;
  sourceFileId: string;
  selfReference?: boolean;
  explicitPin?: boolean;
  targetVersion?: number;
  effectiveTargetVersion?: number;
  targetVersionSource?: string;
  latestVersion?: number;
  baselineVersion?: number;
  observedAfter?: number;
  status?: string;
}
export interface ReferenceUpdate {
  fileId: string;
  method?: string;
  fallback?: string;
  edgeIds?: string[];
}
export interface ReferenceApplyPlan extends ReferencePlan {
  documents: ReferenceDocument[];
  edges: ReferenceEdge[];
  order: string[];
  updates: ReferenceUpdate[];
  lifecycleEffects: unknown[];
  environment: Record<string, unknown>;
  allIntendedReferencesCurrent: boolean | null;
  allReferencesLatest: boolean | null;
}
export interface ReferenceDiagnostic extends Record<string, unknown> {
  fileId?: string;
  reason?: string;
}
export interface ReferenceChecks extends Record<string, unknown> {
  bindingsPass?: boolean;
  healthPass?: boolean;
  scopePass?: boolean;
  metadataPass?: boolean;
  localParametersPreserved?: boolean;
  consumedBodiesVerified?: boolean;
  getterState?: string;
  metadataCoverage?: unknown;
  health?: unknown;
}
export interface ReferenceStep extends Record<string, unknown> {
  status?: string;
  outcome?: string;
  environment?: Record<string, unknown>;
  lifecycleEffects?: unknown[];
  identity?: { creationId?: unknown };
  identityAfter?: unknown;
  openedByRequest?: boolean;
  document?: { creationId?: unknown; modified?: boolean };
  notStarted?: boolean;
  modified?: boolean;
  error?: unknown;
  reason?: string;
  checks?: ReferenceChecks;
  after?: { edges?: ReferenceEdge[] };
  operationOutcome?: string;
  actionSubmitted?: boolean;
  changed?: boolean;
  resultingVersion?: number;
  parameters?: unknown[];
  coldVerified?: boolean | null;
  metadataCoverage?: unknown;
  edges?: ReferenceEdge[];
  graphComplete?: boolean;
}
export interface ReferenceApplyResult extends ReferenceReport {
  operation: string;
  schemaVersion: number;
  requestId: string;
  planId: string | undefined;
  root: unknown;
  scope: string;
  invocationStatus: string;
  success: boolean;
  modelValidated: boolean;
  graphComplete: boolean;
  allIntendedReferencesCurrent: boolean | null;
  allReferencesLatest: boolean | null;
  documents: ReferenceDocument[];
  edges: ReferenceEdge[];
  order: string[];
  completed: ReferenceDiagnostic[];
  skipped: ReferenceDiagnostic[];
  blocked: ReferenceDiagnostic[];
  failed: ReferenceDiagnostic[];
  notProcessed: unknown[];
  inProgress: Record<string, unknown> | null;
  budgetExceeded: boolean;
  continuation: { reason: string } | null;
  lifecycleEffects: unknown[];
  environment: Record<string, unknown>;
  errors: ReferenceDiagnostic[];
  actualElapsedMs?: number;
}
interface UiLease {
  target: {
    name: string;
    fileId: string;
    creationId?: unknown;
    commandId?: unknown;
  };
  lease: unknown;
}
interface UiState {
  status?: string;
  identityVerified?: boolean;
  activeCommand?: { id?: string | null };
  unavailableEvidence?: unknown;
  process?: { fusionVersion?: unknown; osBuild?: unknown; locale?: unknown };
}
interface Watcher {
  status?: string;
  evidence?: Record<string, unknown>;
  disarm(): Promise<unknown>;
  complete(): Promise<{ status?: string; actionSubmitted?: boolean } | null>;
}
export interface ReferenceApplyServices {
  backend: string | null;
  initialBlockers?: ReferenceDiagnostic[];
  initialSnapshot?: { lifecycleEffects?: unknown[] };
  journal(input: ReferenceInput): Promise<ReferenceJournal>;
  acquire(
    input: ReferenceInput,
    plan: ReferenceApplyPlan,
    requestHash: string,
  ): Promise<null | {
    append(value: Record<string, unknown>): Promise<void>;
    release(): Promise<void>;
  }>;
  step(
    action: string,
    data: Record<string, unknown>,
    input: ReferenceInput,
    context: Record<string, unknown>,
  ): Promise<ReferenceStep>;
  stale(
    plan: ReferenceApplyPlan,
    before: ReferenceStep,
    fileId: string,
    targets: Record<string, number | undefined>,
  ): string | ReferenceDiagnostic | null;
  inspectUi?: (
    data: Record<string, unknown>,
    context: Record<string, unknown>,
  ) => Promise<UiState>;
  armWatcher(data: Record<string, unknown>): Promise<Watcher>;
  now(): number;
}
function contextFor(
  plan: ReferenceApplyPlan,
  fileId: string,
): Record<string, unknown> {
  const doc =
    plan.documents.find((row) => row.fileId === fileId) ?? plan.documents[0];
  return doc
    ? {
        doc: doc.name,
        docId: doc["creationId"],
        docFileId: doc.fileId,
        projectId: doc.projectId,
      }
    : {};
}
function allocation(remainingMs: number): {
  nativeUpdateMs: number;
  nativeRpcTimeoutMs: number;
  watcherMs: number;
} | null {
  if (!Number.isFinite(remainingMs)) return null;
  const remaining = Math.floor(remainingMs),
    nativeUpdateMs = Math.min(114000, remaining - 6000);
  return nativeUpdateMs <= 0
    ? null
    : {
        nativeUpdateMs,
        nativeRpcTimeoutMs: nativeUpdateMs + 1000,
        watcherMs: Math.min(120000, remaining),
      };
}
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** SDK/cloud/UI effects are ports. A submitted or unknown update/save is never replayed. */
export async function applyReferences(
  input: ReferenceInput,
  plan: ReferenceApplyPlan,
  services: ReferenceApplyServices,
): Promise<ReferenceReport> {
  const started = services.now(),
    deadline = started + input.timeBudgetMs!;
  const result: ReferenceApplyResult = {
    operation: "references.refresh",
    schemaVersion: 1,
    requestId: input.requestId,
    planId: input.planId,
    root: plan.root,
    scope: plan.scopeFileId,
    invocationStatus: "complete",
    success: false,
    modelValidated: false,
    graphComplete: plan.graphComplete,
    allIntendedReferencesCurrent: plan.allIntendedReferencesCurrent,
    allReferencesLatest: plan.allReferencesLatest,
    documents: clone(plan.documents),
    edges: clone(plan.edges),
    order: [...plan.order],
    completed: [],
    skipped: clone(plan.skipped) as ReferenceDiagnostic[],
    blocked: clone(plan.blocked) as ReferenceDiagnostic[],
    failed: [],
    notProcessed: [...(plan.notPlanned ?? [])],
    inProgress: null,
    budgetExceeded: false,
    continuation: null,
    lifecycleEffects: [
      ...plan.lifecycleEffects,
      ...(services.initialSnapshot?.lifecycleEffects ?? []),
    ],
    environment: plan.environment,
    errors: [],
  };
  const document = (fileId: string): ReferenceDocument => {
    const doc = result.documents.find((row) => row.fileId === fileId);
    if (!doc) throw new Error("Missing planned document: " + fileId);
    return doc;
  };
  const mark = (fileId: string, values: Record<string, unknown>): void => {
    Object.assign(document(fileId), values);
  };
  const requestHash = hash({
    request: { ...input, phase: "apply", confirm: true },
    planId: input.planId,
  });
  const prior = await services.journal(input);
  if (prior.writerActive)
    return {
      ...result,
      invocationStatus: "unknown",
      errors: [
        {
          stage: "journal",
          message: "existing request writer is active; no replay or lock theft",
        },
      ],
    };
  if (prior.report) {
    if (prior.report.requestHash !== requestHash)
      throw new Error(
        "requestId already belongs to another immutable apply request",
      );
    result.invocationStatus =
      prior.report.invocationStatus === "unknown" ? "unknown" : "blocked";
    result["replayedReceipt"] = true;
    result["priorReceipt"] = prior.report;
    return result;
  }
  if (input.requestId === plan.requestId)
    throw new Error(
      "apply needs a new requestId distinct from the immutable plan request",
    );
  const journal = await services.acquire(input, plan, requestHash);
  if (!journal)
    return {
      ...result,
      invocationStatus: "unknown",
      errors: [
        {
          stage: "journal",
          message:
            "request writer is active or outcome is unresolved; no replay",
        },
      ],
    };
  const persist = async (
    event: string,
    fields: Record<string, unknown> = {},
  ): Promise<void> => {
    const now = services.now();
    result.actualElapsedMs = Math.max(0, now - started);
    result.budgetExceeded ||= now > deadline;
    await journal.append({
      event,
      invocationStatus: result.invocationStatus,
      planId: input.planId,
      inProgress: result.inProgress,
      result: clone(result),
      ...fields,
    });
  };
  try {
    await persist("apply_authorized");
    if (services.initialBlockers?.length) {
      result.invocationStatus = "blocked";
      result.blocked.push(...services.initialBlockers);
      for (const blocker of services.initialBlockers)
        if (blocker.fileId)
          mark(blocker.fileId, {
            status: "blocked",
            blockedReason: blocker.reason,
          });
      await persist("preflight_blocked", {
        blockers: services.initialBlockers,
      });
      return result;
    }
    if (
      input["durability"] === "cold" &&
      input["lifecycle"] !== "openOwned" &&
      plan.updates.length
    ) {
      result.invocationStatus = "blocked";
      for (const update of plan.updates) {
        result.blocked.push({
          fileId: update.fileId,
          reason: "coldRequiresOpenOwnedLifecycle",
        });
        mark(update.fileId, {
          status: "blocked",
          blockedReason: "coldRequiresOpenOwnedLifecycle",
        });
      }
      await persist("preflight_blocked");
      return result;
    }
    const effectiveTargets: Record<string, number | undefined> = {},
      saved: Record<string, unknown> = {};
    for (const doc of result.documents) {
      doc.openedByRequest = false;
      doc.ownedCreationId = null;
    }
    for (const fileId of plan.order) {
      const update = plan.updates.find((row) => row.fileId === fileId);
      if (!update || result.blocked.some((row) => row.fileId === fileId))
        continue;
      const unsettled = new Set(
        [...result.blocked, ...result.failed]
          .map((row) => row.fileId)
          .filter(Boolean),
      );
      const dependencies = plan.edges.filter(
        (edge) =>
          edge.ownerFileId === fileId &&
          !edge.selfReference &&
          unsettled.has(edge.sourceFileId),
      );
      if (dependencies.length) {
        const diagnostic = {
          fileId,
          reason: "blockedDependencyAfterUnsettledChild",
          dependencies: dependencies.map((edge) => ({
            edgeId: edge.edgeId,
            sourceFileId: edge.sourceFileId,
          })),
        };
        result.blocked.push(diagnostic);
        mark(fileId, { status: "blocked", blockedReason: diagnostic.reason });
        result.invocationStatus = "blocked";
        await persist("dependent_blocked", diagnostic);
        continue;
      }
      const remaining = (after = false): string[] =>
        plan.order
          .slice(plan.order.indexOf(fileId) + Number(after))
          .filter((id) => plan.updates.some((row) => row.fileId === id));
      const budgetStop = async (
        event: string,
        progress: Record<string, unknown> | null,
        fields: Record<string, unknown> = {},
      ): Promise<ReferenceReport> => {
        result.budgetExceeded ||= services.now() > deadline;
        result.invocationStatus = "partial";
        result.inProgress = progress;
        result.notProcessed.push(...remaining());
        result.continuation = { reason: "budgetExhausted" };
        await persist(event, fields);
        return result;
      };
      if (services.now() >= deadline) {
        result.budgetExceeded ||= services.now() > deadline;
        result.invocationStatus = "partial";
        result.inProgress = null;
        result.notProcessed.push(
          ...plan.order
            .slice(plan.order.indexOf(fileId))
            .filter((id) => !result.skipped.some((row) => row.fileId === id)),
        );
        result.continuation = { reason: "budgetExhausted" };
        await persist("budget_exhausted");
        return result;
      }
      const node = document(fileId),
        context = contextFor(plan, fileId);
      const before = await services.step(
        "preflight",
        {
          fileId,
          projectId: node.projectId,
          version: node.version,
          allowedProjectIds: plan.options?.["allowedProjectIds"] ?? [
            plan.root.projectId,
          ],
          lifecycle: input["lifecycle"],
          openedByRequest: false,
          requestId: input.requestId,
          root: plan.root,
        },
        input,
        context,
      );
      result.lifecycleEffects.push(...(before.lifecycleEffects ?? []));
      const drift = services.stale(plan, before, fileId, effectiveTargets);
      if (drift) {
        const blocker = typeof drift === "string" ? { reason: drift } : drift;
        result.blocked.push({ fileId, ...blocker });
        mark(fileId, { status: "blocked", blockedReason: blocker.reason });
        result.invocationStatus = "blocked";
        await persist("step_blocked", {
          fileId,
          ...blocker,
          preflight: before,
        });
        continue;
      }
      if (services.now() >= deadline)
        return budgetStop("budget_exhausted_after_preflight", null);
      if (before.identity?.creationId ?? before.document?.creationId)
        node.ownedCreationId =
          before.identity?.creationId ?? before.document?.creationId;
      if (before.openedByRequest === true) node.openedByRequest = true;
      const direct = update.method === "UpdateAllLatestCmd";
      if (
        direct &&
        (input.nativeFallback !== "qualifiedOnce" || update.fallback)
      ) {
        result.invocationStatus = "blocked";
        result.blocked.push({
          fileId,
          stage: "nativeUpdate",
          reason: "directNativeMethodNotAuthorizedByPlan",
        });
        mark(fileId, {
          status: "blocked",
          blockedReason: "directNativeMethodNotAuthorizedByPlan",
        });
        result.inProgress = null;
        await persist("native_direct_blocked", { fileId });
        continue;
      }
      const stepData = {
        plan,
        update,
        fileId,
        projectId: node.projectId,
        version: node.version,
        latestVersion: node.latestVersion,
        allowedProjectIds: plan.options?.["allowedProjectIds"] ?? [
          plan.root.projectId,
        ],
        nativeFallback: plan.nativeFallback,
        method: update.method,
        lifecycle: input["lifecycle"],
        ownedCreationId: node.ownedCreationId,
        openedByRequest: node.openedByRequest === true,
        edgeIds: update.edgeIds,
        planEdges: plan.edges,
        effectiveTargets,
        parameterBindings: input["parameterBindings"],
        expectedSourceParameters: Object.fromEntries(
          plan.documents.map((doc) => [
            doc.fileId,
            saved[doc.fileId + ":parameters"] ?? doc.parameters ?? [],
          ]),
        ),
        baselineMetadata: node.metadata ?? {},
        baselineUserParameters: node.userParameters ?? [],
        confirm: true,
        requestId: input.requestId,
        timeBudgetMs: input.timeBudgetMs,
      };
      let step: ReferenceStep = {};
      if (!direct) {
        mark(fileId, { status: "updating" });
        result.inProgress = {
          fileId,
          stage: "sdkUpdate",
          method: update.method,
        };
        await persist("sdk_update_uncertain", {
          fileId,
          method: update.method,
        });
        try {
          step = await services.step("sdkUpdate", stepData, input, context);
        } catch (error) {
          result.invocationStatus = "unknown";
          mark(fileId, { status: "unknown" });
          result.inProgress = {
            fileId,
            stage: "sdkUpdate",
            outcome: "unknown",
          };
          result.errors.push({
            fileId,
            stage: "sdkUpdate",
            message: message(error),
          });
          await persist("sdk_update_unknown", {
            fileId,
            message: message(error),
          });
          return result;
        }
        result.environment = {
          ...result.environment,
          ...(step.environment ?? {}),
        };
        result.lifecycleEffects.push(...(step.lifecycleEffects ?? []));
        if (step.identity?.creationId)
          node.ownedCreationId = step.identity.creationId;
        if (step.openedByRequest === true) node.openedByRequest = true;
        if (step.notStarted === true || step.status === "notStarted") {
          result.invocationStatus = "blocked";
          result.blocked.push({
            fileId,
            stage: "sdkUpdate",
            reason: "requestNotSubmitted",
            error: step.error ?? null,
          });
          mark(fileId, {
            status: "blocked",
            blockedReason: "requestNotSubmitted",
          });
          result.inProgress = null;
          await persist("sdk_update_not_started", { fileId, stepResult: step });
          continue;
        }
        if (step.status === "unknown" || step.outcome === "unknown") {
          result.invocationStatus = "unknown";
          mark(fileId, { status: "unknown" });
          result.inProgress = {
            fileId,
            stage: "sdkUpdate",
            outcome: "unknown",
          };
          result.errors.push({
            fileId,
            stage: "sdkUpdate",
            message: step.error ?? "SDK update outcome unknown",
          });
          await persist("sdk_update_unknown", { fileId, stepResult: step });
          return result;
        }
      }
      let check = step.checks,
        usedNative = false,
        nativeModified = false,
        settledEdges = step.after?.edges;
      if (
        direct ||
        (step.status === "knownStale" &&
          update.fallback === "UpdateAllLatestCmd" &&
          input.nativeFallback === "qualifiedOnce")
      ) {
        const priorSdkEffect = direct
            ? "notAttemptedPlannedDirect"
            : "knownSettledStale",
          mayBeModified = direct
            ? before.document?.modified === true
            : step.modified === true;
        const nativeProgress = {
          fileId,
          stage: direct ? "directNative" : "nativeFallback",
          nativeCommandNotSubmitted: true,
          priorSdkEffect,
          documentMayBeModified: mayBeModified,
        };
        const nativeFields = {
          fileId,
          ...(direct
            ? { plannedMethod: update.method }
            : { priorSdkResult: step }),
        };
        if (services.now() >= deadline)
          return budgetStop(
            "budget_exhausted_before_native_fallback",
            nativeProgress,
            nativeFields,
          );
        const lease = input.uiLeases?.[fileId] as UiLease | undefined;
        const blockNative = async (
          reason: string,
          fields: Record<string, unknown> = {},
        ): Promise<void> => {
          result.invocationStatus = "blocked";
          result.blocked.push({
            fileId,
            stage: "nativeFallback",
            reason,
            ...fields,
          });
          mark(fileId, { status: "blocked", blockedReason: reason });
          result.inProgress = null;
          await persist("native_fallback_blocked", {
            fileId,
            reason,
            ...fields,
          });
        };
        if (!lease) {
          result.invocationStatus = "blocked";
          result.failed.push({
            fileId,
            stage: "nativeFallback",
            reason: "authorizedUiLeaseRequired",
          });
          mark(fileId, {
            status: "blocked",
            blockedReason: "authorizedUiLeaseRequired",
          });
          result.inProgress = null;
          await persist("native_fallback_blocked", {
            ...nativeFields,
            reason: "authorizedUiLeaseRequired",
          });
          continue;
        }
        const target = lease.target;
        if (
          target.name !== node.name ||
          target.fileId !== fileId ||
          (target.creationId !== undefined &&
            target.creationId !== node.ownedCreationId)
        ) {
          await blockNative("uiLeaseTargetDoesNotMatchResolvedOwnedEditor");
          continue;
        }
        if (!services.inspectUi) {
          await blockNative("shippedUiInspectUnavailable");
          continue;
        }
        const uiState = await services.inspectUi(
          {
            requestId: input.requestId,
            lease: lease.lease,
            target,
            intent: "confirmRequestedUpdate",
            maxControls: 256,
          },
          {
            doc: target.name,
            ...(target.creationId ? { docId: target.creationId } : {}),
            docFileId: fileId,
            projectId: node.projectId,
          },
        );
        const commandId = uiState.activeCommand?.id;
        const qualified =
          uiState.status === "nothingToDo" &&
          uiState.identityVerified === true &&
          (commandId === "" ||
            commandId === "SelectCommand" ||
            commandId === null);
        result.environment = {
          ...result.environment,
          backend: services.backend,
          fusionVersion: uiState.process?.fusionVersion ?? null,
          osBuild: uiState.process?.osBuild ?? null,
          uiLocale: uiState.process?.locale ?? null,
          adapterQualification: qualified
            ? "update-all-latest:qualified-by-.11-on-this-host"
            : "update-all-latest:not-qualified",
        };
        if (!qualified) {
          result.invocationStatus = "blocked";
          result.blocked.push({
            fileId,
            stage: "nativeFallback",
            reason: "UIHostNotIdleOrTargetUnverified",
            uiStatus: uiState.status,
            activeCommand: uiState.activeCommand,
            unavailableEvidence: uiState.unavailableEvidence,
          });
          mark(fileId, {
            status: "blocked",
            blockedReason: "UIHostNotIdleOrTargetUnverified",
          });
          result.inProgress = null;
          await persist("native_fallback_blocked", { fileId, uiState });
          continue;
        }
        const initialAllocation = allocation(deadline - services.now());
        if (!initialAllocation)
          return budgetStop(
            "budget_exhausted_before_native_watcher",
            nativeProgress,
            nativeFields,
          );
        const armStarted = services.now();
        const watcher = await services.armWatcher({
          requestId: input.requestId,
          lease: lease.lease,
          expectedIdentity: {
            name: target.name,
            creationId: target.creationId ?? null,
            fileId,
            commandId: target.commandId,
          },
          intent: "confirmRequestedUpdate",
          profileId: "update-all-latest",
          timeBudgetMs: initialAllocation.watcherMs,
        });
        if (watcher.status !== "armed") {
          result.invocationStatus = "blocked";
          result.blocked.push({
            fileId,
            stage: "nativeFallback",
            reason: watcher.status ?? "watcherNotArmed",
          });
          mark(fileId, {
            status: "blocked",
            blockedReason: watcher.status ?? "watcherNotArmed",
          });
          result.inProgress = null;
          await persist("native_fallback_blocked", {
            fileId,
            watcher: watcher.evidence ?? { status: watcher.status },
          });
          continue;
        }
        const afterArm = services.now(),
          window = Math.max(
            0,
            initialAllocation.watcherMs - (afterArm - armStarted),
          );
        const nativeAllocation = allocation(
          Math.min(deadline - afterArm, window),
        );
        if (!nativeAllocation) {
          await watcher.disarm().catch(() => {});
          return budgetStop(
            "budget_exhausted_before_native_submit",
            nativeProgress,
            nativeFields,
          );
        }
        result.inProgress = {
          fileId,
          stage: "UpdateAllLatestCmd",
          outcome: "pending",
        };
        await persist("native_submit_uncertain", {
          fileId,
          command: "UpdateAllLatestCmd",
          route: direct ? "plannedDirect" : "sdkFallback",
        });
        let native: ReferenceStep,
          keepWatcher = false;
        try {
          native = await services.step(
            "nativeUpdate",
            {
              ...stepData,
              command: "UpdateAllLatestCmd",
              planEdges: plan.edges,
              plannedMethod: update.method,
              nativeRoute: direct ? "directPlanned" : "sdkFallback",
              ...(direct ? {} : { priorSdkResult: step }),
              lease: lease.lease,
              timeBudgetMs: nativeAllocation.nativeUpdateMs,
              nativeRpcTimeoutMs: nativeAllocation.nativeRpcTimeoutMs,
            },
            input,
            context,
          );
          nativeModified = native.modified === true;
          if (native.status === "unknown" || native.outcome === "unknown")
            keepWatcher = true;
          else {
            const uiReceipt = await watcher.complete();
            result.lifecycleEffects.push({
              fileId,
              type: "nativeUi",
              command: "UpdateAllLatestCmd",
              receipt: uiReceipt,
            });
            if (uiReceipt?.status === "unknown") {
              result.invocationStatus = "unknown";
              mark(fileId, { status: "unknown" });
              result.inProgress = {
                fileId,
                stage: "UpdateAllLatestCmd",
                outcome: "unknown",
              };
              await persist("native_ui_receipt_unknown", {
                fileId,
                nativeResult: native,
                uiReceipt,
              });
              return result;
            }
            if (
              uiReceipt?.status !== "actionSubmitted" ||
              uiReceipt.actionSubmitted !== true
            ) {
              if (
                native.actionSubmitted === false ||
                native.notStarted === true
              )
                native = {
                  ...native,
                  status: "blocked",
                  operationOutcome: "notEvaluated",
                  uiActionObserved: false,
                  uiReceipt,
                  reason:
                    native.reason ??
                    "native command was not submitted or its preflight blocked it",
                };
              else {
                result.invocationStatus = "unknown";
                mark(fileId, { status: "unknown" });
                result.inProgress = {
                  fileId,
                  stage: "UpdateAllLatestCmd",
                  outcome: "unknown",
                  reason:
                    "native command submitted without a qualified one-shot UI action receipt",
                };
                result.errors.push({
                  fileId,
                  stage: "nativeUi",
                  evidence: { nativeResult: native, uiReceipt },
                });
                await persist("native_ui_action_unknown", {
                  fileId,
                  nativeResult: native,
                  uiReceipt,
                });
                return result;
              }
            }
          }
        } catch (error) {
          keepWatcher = true;
          result.invocationStatus = "unknown";
          mark(fileId, { status: "unknown", nativeCommandStatus: "unknown" });
          result.inProgress = {
            fileId,
            stage: "UpdateAllLatestCmd",
            outcome: "unknown",
          };
          result.errors.push({
            fileId,
            stage: "nativeUpdate",
            message: message(error),
          });
          await persist("native_update_unknown", {
            fileId,
            message: message(error),
          });
          return result;
        } finally {
          if (!keepWatcher) await watcher.disarm().catch(() => {});
        }
        if (
          native.reason === "nativeUpdateBudgetInsufficientBeforeCommand" &&
          native.notStarted === true
        ) {
          mark(fileId, {
            status: "partial",
            nativeCommandStatus: "notSubmitted",
          });
          return budgetStop(
            "budget_exhausted_before_native_submit",
            {
              fileId,
              stage: "nativeFallback",
              nativeCommandNotSubmitted: true,
              priorSdkEffect,
              documentMayBeModified: mayBeModified,
              reason: native.reason,
            },
            { ...nativeFields, nativeResult: native },
          );
        }
        if (
          native.status !== "complete" ||
          native.operationOutcome !== "pass"
        ) {
          result.invocationStatus =
            native.status === "unknown" ? "unknown" : "failed";
          mark(fileId, {
            status: result.invocationStatus,
            nativeCommandStatus: native.status,
          });
          result.inProgress =
            native.status === "unknown"
              ? { fileId, stage: "UpdateAllLatestCmd", outcome: "unknown" }
              : null;
          result.errors.push({
            fileId,
            stage: "nativeUpdate",
            evidence: native,
          });
          await persist(
            native.status === "unknown"
              ? "native_update_unknown"
              : "native_update_failed",
            { fileId, nativeResult: native },
          );
          if (native.status === "unknown") return result;
          continue;
        }
        check = native.checks;
        settledEdges = native.after?.edges;
        usedNative = true;
      }
      if (!direct && step.status !== "complete" && !usedNative) {
        result.invocationStatus =
          step.status === "blocked" ? "blocked" : "failed";
        result.failed.push({ fileId, stage: "sdkUpdate", result: step });
        mark(fileId, {
          status: result.invocationStatus,
          sdkUpdateStatus: step.status,
        });
        result.inProgress = null;
        await persist("sdk_update_failed", { fileId, stepResult: step });
        continue;
      }
      if (
        !check?.bindingsPass ||
        !check.healthPass ||
        !check.scopePass ||
        !check.metadataPass ||
        check.localParametersPreserved !== true ||
        check.consumedBodiesVerified !== true ||
        check.getterState === "unresolved"
      ) {
        result.invocationStatus = "failed";
        result.failed.push({
          fileId,
          stage: "postUpdateChecks",
          checks: check,
        });
        mark(fileId, { status: "failed", checks: check });
        result.inProgress = null;
        await persist("postcheck_failed", { fileId, checks: check });
        continue;
      }
      if (services.now() >= deadline) {
        result.budgetExceeded ||= services.now() > deadline;
        result.invocationStatus = "partial";
        result.inProgress = {
          fileId,
          stage: "saveRequired",
          modelMutation: "knownSettled",
          documentMayBeModified:
            nativeModified || (!direct && step.modified === true),
        };
        mark(fileId, { status: "partial", checks: check });
        result.notProcessed.push(...remaining(true));
        result.continuation = { reason: "budgetExhausted" };
        await persist("budget_exhausted_before_save", {
          fileId,
          checks: check,
        });
        return result;
      }
      result.inProgress = { fileId, stage: "save", outcome: "pending" };
      await persist("save_uncertain", { fileId, checks: check });
      let save: ReferenceStep;
      try {
        save = await services.step(
          "save",
          {
            ...stepData,
            ownedCreationId: node.ownedCreationId,
            openedByRequest: node.openedByRequest === true,
            checks: check,
            postUpdateEdges: settledEdges,
          },
          input,
          context,
        );
      } catch (error) {
        result.invocationStatus = "unknown";
        result.inProgress = { fileId, stage: "save", outcome: "unknown" };
        mark(fileId, { status: "unknown", saveStatus: "unknown" });
        result.errors.push({ fileId, stage: "save", message: message(error) });
        await persist("save_unknown", { fileId, message: message(error) });
        return result;
      }
      if (save.status === "unknown" || save.outcome === "unknown") {
        result.invocationStatus = "unknown";
        result.inProgress = { fileId, stage: "save", outcome: "unknown" };
        mark(fileId, { status: "unknown", saveStatus: "unknown" });
        await persist("save_unknown", { fileId, save });
        return result;
      }
      if (save.status !== "complete") {
        result.invocationStatus = "failed";
        result.failed.push({ fileId, stage: "save", result: save });
        mark(fileId, { status: "failed", saveStatus: save.status ?? "failed" });
        result.inProgress = null;
        await persist("save_failed", { fileId, save });
        continue;
      }
      saved[fileId] = save.resultingVersion;
      if (Array.isArray(save.parameters))
        saved[fileId + ":parameters"] = save.parameters;
      if (save.changed === true)
        for (const edge of plan.edges)
          if (edge.sourceFileId === fileId && !edge.explicitPin) {
            effectiveTargets[edge.edgeId] = save.resultingVersion;
            edge.targetVersionSource = "dependencyReceipt";
            if (save.resultingVersion !== undefined) {
              edge.targetVersion = save.resultingVersion;
              edge.effectiveTargetVersion = save.resultingVersion;
            }
          }
      if (input["durability"] === "cold") {
        if (services.now() >= deadline) {
          result.budgetExceeded ||= services.now() > deadline;
          result.invocationStatus = "partial";
          result.inProgress = null;
          result.notProcessed.push("coldVerification:" + fileId);
          result.continuation = { reason: "budgetExhausted" };
          node.status = "partial";
          node.saveStatus = "complete";
          node.coldVerified = false;
          await persist("budget_exhausted_before_cold_verify", {
            fileId,
            save,
          });
          return result;
        }
        result.inProgress = { fileId, stage: "coldReopen", outcome: "pending" };
        await persist("cold_read_uncertain", { fileId, save });
        let cold: ReferenceStep;
        try {
          cold = await services.step(
            "coldVerify",
            {
              ...stepData,
              version: save.resultingVersion,
              ownedCreationId: node.ownedCreationId,
              openedByRequest: node.openedByRequest === true,
              plan,
              update,
              fileId,
              save,
              resultingVersion: save.resultingVersion,
              effectiveTargets,
            },
            input,
            context,
          );
        } catch (error) {
          result.invocationStatus = "unknown";
          result.inProgress = {
            fileId,
            stage: "coldReopen",
            outcome: "unknown",
          };
          mark(fileId, {
            status: "unknown",
            saveStatus: "complete",
            coldVerified: null,
          });
          result.errors.push({
            fileId,
            stage: "coldVerify",
            message: message(error),
          });
          await persist("cold_verify_unknown", {
            fileId,
            message: message(error),
          });
          return result;
        }
        if (cold.status !== "complete" || cold.coldVerified !== true) {
          result.invocationStatus =
            cold.status === "unknown" ? "unknown" : "failed";
          result.inProgress =
            cold.status === "unknown"
              ? { fileId, stage: "coldReopen", outcome: "unknown" }
              : null;
          result.failed.push({ fileId, stage: "coldVerify", result: cold });
          mark(fileId, {
            status: result.invocationStatus,
            saveStatus: "complete",
            coldVerified: cold.coldVerified ?? false,
          });
          await persist(
            cold.status === "unknown"
              ? "cold_verify_unknown"
              : "cold_verify_failed",
            { fileId, cold },
          );
          if (cold.status === "unknown") return result;
          continue;
        }
        if (save.resultingVersion !== undefined)
          node.resultingVersion = save.resultingVersion;
        node.coldVerified = true;
        node.identityAfter = cold.identity ?? {
          projectId: node.projectId,
          fileId,
          version: save.resultingVersion,
        };
        if (Array.isArray(cold.parameters))
          saved[fileId + ":parameters"] = cold.parameters;
      } else {
        if (save.resultingVersion !== undefined)
          node.resultingVersion = save.resultingVersion;
        node.coldVerified = false;
      }
      const method = usedNative ? "UpdateAllLatestCmd" : update.method;
      if (method !== undefined) node.method = method;
      node.saveStatus = "complete";
      node.status = "complete";
      if (input["durability"] !== "cold") node.coldVerified = false;
      node.identityAfter = save.identityAfter ??
        node.identityAfter ?? {
          projectId: node.projectId,
          fileId,
          version: save.resultingVersion,
        };
      node.checks = check;
      node.metadataCoverage =
        save.metadataCoverage ?? check.metadataCoverage ?? null;
      result.completed.push({
        fileId,
        baselineVersion: node.version,
        resultingVersion: save.resultingVersion,
        method: node.method,
        commandReceipt: usedNative ? "UpdateAllLatestCmd" : null,
        saveStatus: "complete",
        coldVerified: node.coldVerified,
        health: check.health ?? null,
        checks: check,
        metadataCoverage: node.metadataCoverage,
      });
      result.inProgress = null;
      result.lifecycleEffects.push(...(save.lifecycleEffects ?? []));
      await persist("document_completed", {
        fileId,
        resultingVersion: save.resultingVersion,
      });
      if (services.now() > deadline) {
        result.budgetExceeded = true;
        const rest = remaining(true);
        if (rest.length) {
          result.invocationStatus = "partial";
          result.notProcessed.push(...rest);
          result.continuation = { reason: "budgetExhausted" };
          await persist("budget_overrun_settled", { notProcessed: rest });
          return result;
        }
      }
    }
    if (
      result.blocked.length ||
      result.failed.length ||
      result.notProcessed.length
    )
      result.invocationStatus =
        result.notProcessed.length || result.completed.length
          ? "partial"
          : result.blocked.length
            ? "blocked"
            : "failed";
    const finalRoot = {
      ...input.root,
      version: saved[input.root.fileId] ?? input.root.version,
    };
    const finalSnapshot = await services.step(
      "graph",
      {
        ...input,
        root: finalRoot,
        policy: plan.policy,
        phase: "audit",
        effectiveTargets,
        savedVersions: saved,
      },
      input,
      contextFor(plan, plan.scopeFileId),
    );
    result.edges = plan.edges.map((edge) => {
      const fresh = (finalSnapshot.edges ?? []).find(
          (row) => row.edgeId === edge.edgeId,
        ),
        target = effectiveTargets[edge.edgeId] ?? edge.targetVersion;
      return {
        ...edge,
        ...(fresh
          ? {
              ...(fresh.baselineVersion === undefined
                ? {}
                : { observedAfter: fresh.baselineVersion }),
              status:
                fresh.baselineVersion === target
                  ? edge.explicitPin
                    ? "pinned"
                    : "current"
                  : "outdated",
            }
          : { status: "unresolved" }),
      };
    });
    const unresolved = result.edges.some(
      (edge) => edge.status === "unresolved",
    );
    result.allIntendedReferencesCurrent = unresolved
      ? null
      : result.edges.every(
          (edge) =>
            edge.selfReference ||
            edge.observedAfter ===
              (effectiveTargets[edge.edgeId] ?? edge.targetVersion),
        );
    result.allReferencesLatest = unresolved
      ? null
      : result.edges.every(
          (edge) =>
            edge.selfReference || edge.observedAfter === edge.latestVersion,
        );
    result.graphComplete = finalSnapshot.graphComplete === true;
    if (
      !["unknown", "failed", "blocked", "partial"].includes(
        result.invocationStatus,
      )
    )
      result.invocationStatus =
        result.graphComplete && result.allIntendedReferencesCurrent === true
          ? "complete"
          : "partial";
    result.success = result.invocationStatus === "complete";
    result.modelValidated = result.success;
    await persist("apply_settled");
    return result;
  } finally {
    await journal.release();
  }
}
