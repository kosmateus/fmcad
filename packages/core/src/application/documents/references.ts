import { clone, hash } from "./json";

export interface ReferenceRoot {
  projectId: string;
  fileId: string;
  version: number;
}
export interface ReferenceInput {
  [key: string]: unknown;
  phase: string;
  requestId: string;
  reportPath: string;
  root: ReferenceRoot;
  planId?: string;
  scopeFileId?: string;
  timeBudgetMs?: number;
  nativeFallback?: string;
  uiLeases?: Record<string, unknown>;
}
export interface ReferencePlan {
  [key: string]: unknown;
  requestId: string;
  root: ReferenceRoot;
  scopeFileId: string;
  options?: Record<string, unknown> & { timeBudgetMs?: number };
  timeBudgetMs?: number;
  policy: string;
  lifecycle: string;
  nativeFallback: string;
  durability: string;
  updates: { fileId: string; method?: string; fallback?: string | null }[];
  blocked: unknown[];
  skipped: unknown[];
  notPlanned: unknown[];
  graphComplete: boolean;
}
export interface ReferenceReport {
  [key: string]: unknown;
}
export interface ReferenceJournal {
  writerActive?: boolean;
  report?: {
    requestHash: string;
    inProgress?: unknown;
    invocationStatus?: string;
    result?: ReferenceReport;
  } | null;
}
export interface ReferenceServices {
  validate(data: unknown): ReferenceInput;
  inspect(input: ReferenceInput): Promise<ReferenceReport>;
  readPlan(input: ReferenceInput): Promise<ReferencePlan>;
  journal(input: ReferenceInput): Promise<ReferenceJournal>;
  graph(input: ReferenceInput, request: ReferenceInput): Promise<unknown>;
  plan(snapshot: unknown, input: ReferenceInput): ReferencePlan;
  freshness(plan: ReferencePlan, snapshot: unknown): unknown[];
  apply(
    input: ReferenceInput,
    plan: ReferencePlan,
    preflight: { initialBlockers: unknown[]; initialSnapshot?: unknown },
  ): Promise<ReferenceReport>;
  publishPlan(input: ReferenceInput, plan: ReferencePlan): Promise<string>;
  finishRead(
    input: ReferenceInput,
    result: ReferenceReport,
  ): Promise<ReferenceReport>;
}
export interface ReferenceReadServices {
  journal(
    input: ReferenceInput,
  ): Promise<ReferenceJournal & { records?: unknown[] }>;
  readPlan(input: ReferenceInput): Promise<ReferencePlan>;
  acquire(
    input: ReferenceInput,
    requestHash: string,
    result: ReferenceReport,
  ): Promise<{
    append(value: Record<string, unknown>): Promise<void>;
    release(): Promise<void>;
  }>;
}
export async function inspectReferences(
  input: ReferenceInput,
  services: ReferenceReadServices,
): Promise<ReferenceReport> {
  const result: ReferenceReport = {
    operation: "references.refresh",
    schemaVersion: 1,
    phase: "inspect",
    requestId: input.requestId,
    planId: input.planId,
    root: input.root,
    invocationStatus: "complete",
    success: true,
    modelValidated: false,
    lifecycleEffects: [],
    errors: [],
  };
  if (input.planId) {
    try {
      result["plan"] = await services.readPlan(input);
    } catch (error) {
      result["planStatus"] = "unavailable";
      result["errors"] = [
        {
          stage: "planRead",
          message: error instanceof Error ? error.message : String(error),
        },
      ];
    }
  }
  const journal = await services.journal(input);
  result["receipts"] = journal.records;
  result["latestReceipt"] = journal.report ?? null;
  result["writerActive"] = journal.writerActive;
  if (journal.writerActive) {
    result["invocationStatus"] = "unknown";
    result["success"] = false;
  }
  return result;
}
export async function finishReferenceRead(
  input: ReferenceInput,
  result: ReferenceReport,
  services: ReferenceReadServices,
): Promise<ReferenceReport> {
  const prior = await services.journal(input),
    requestHash = hash({
      operation: "references.refresh",
      request: { ...input, phase: result["phase"] },
    });
  if (prior.report) {
    if (prior.report.requestHash !== requestHash)
      throw new Error(
        "requestId already belongs to a different immutable request",
      );
    return { ...prior.report.result, replayedReceipt: true };
  }
  const journal = await services.acquire(input, requestHash, result);
  try {
    await journal.append({
      event: String(result["phase"]) + "_settled",
      phase: result["phase"],
      invocationStatus: result["invocationStatus"],
      planId: result["planId"] ?? null,
      result,
    });
  } finally {
    await journal.release();
  }
  return result;
}
/** Shared phase entry; immutable request checks precede graph reads and all mutations. */
export async function executeReferences(
  data: Record<string, unknown>,
  services: ReferenceServices,
): Promise<ReferenceReport> {
  let input = services.validate(data);
  if (input.phase === "inspect") return services.inspect(input);
  if (input.phase === "apply") {
    const plan = await services.readPlan(input);
    if (plan.requestId === input.requestId)
      throw new Error(
        "apply requires a new requestId distinct from its immutable plan request",
      );
    if (
      plan.root.projectId !== input.root.projectId ||
      plan.root.fileId !== input.root.fileId ||
      plan.root.version !== input.root.version ||
      plan.scopeFileId !== (input.scopeFileId ?? input.root.fileId)
    )
      throw new Error("apply root/scope differs from the immutable plan");
    for (const key of [
      "policy",
      "pins",
      "allowedProjectIds",
      "scopeFileId",
      "lifecycle",
      "nativeFallback",
      "durability",
      "parameterBindings",
      "callerNamespaces",
      "maxFiles",
      "maxUpdates",
    ]) {
      if (
        Object.hasOwn(data, key) &&
        hash(data[key]) !==
          hash(
            key === "scopeFileId"
              ? plan.scopeFileId
              : [
                    "policy",
                    "lifecycle",
                    "nativeFallback",
                    "durability",
                  ].includes(key)
                ? plan[key]
                : plan.options?.[key],
          )
      )
        throw new Error(`apply ${key} differs from the immutable plan`);
    }
    if (
      typeof data["timeBudgetMs"] === "number" &&
      data["timeBudgetMs"] >
        Number(plan.options?.timeBudgetMs ?? plan.timeBudgetMs)
    )
      throw new Error("apply cannot expand the immutable plan timeBudgetMs");
    input = services.validate({
      ...data,
      ...clone(plan.options ?? {}),
      phase: "apply",
      root: plan.root,
      policy: plan.policy,
      scopeFileId: plan.scopeFileId,
      lifecycle: plan.lifecycle,
      nativeFallback: plan.nativeFallback,
      durability: plan.durability,
      planId: input.planId,
      confirm: true,
      ...(data["timeBudgetMs"] !== undefined
        ? { timeBudgetMs: data["timeBudgetMs"] }
        : {}),
      ...(data["uiLeases"] !== undefined ? { uiLeases: data["uiLeases"] } : {}),
    });
    const requestHash = hash({
      request: { ...input, phase: "apply", confirm: true },
      planId: input.planId,
    });
    const prior = await services.journal(input);
    if (prior.writerActive)
      return {
        operation: "references.refresh",
        schemaVersion: 1,
        requestId: input.requestId,
        planId: input.planId,
        invocationStatus: "unknown",
        success: false,
        modelValidated: false,
        inProgress: prior.report?.inProgress ?? null,
        unavailableEvidence: [
          "existing request writer is active; no replay or lock theft",
        ],
      };
    if (prior.report) {
      if (prior.report.requestHash !== requestHash)
        throw new Error(
          "requestId already belongs to a different immutable apply request",
        );
      return prior.report.result
        ? { ...prior.report.result, replayedReceipt: true }
        : {
            operation: "references.refresh",
            schemaVersion: 1,
            requestId: input.requestId,
            planId: input.planId,
            invocationStatus: "unknown",
            inProgress: prior.report.inProgress ?? null,
            replayedReceipt: true,
            unavailableEvidence: [
              "existing immutable request receipt has no settled result",
            ],
          };
    }
    if (input.nativeFallback === "qualifiedOnce") {
      const missing = plan.updates.filter(
        (update) =>
          (update.method === "UpdateAllLatestCmd" ||
            update.fallback === "UpdateAllLatestCmd") &&
          !input.uiLeases?.[update.fileId],
      );
      if (missing.length)
        return services.apply(input, plan, {
          initialBlockers: missing.map((row) => ({
            fileId: row.fileId,
            reason: "authorizedUiLeaseRequired",
          })),
        });
    }
    const snapshot = await services.graph(
      { ...input, phase: "audit", policy: plan.policy },
      input,
    );
    return services.apply(input, plan, {
      initialSnapshot: snapshot,
      initialBlockers: services.freshness(plan, snapshot),
    });
  }
  const readRequestHash = hash({
    operation: "references.refresh",
    request: { ...input, phase: input.phase },
  });
  const previous = await services.journal(input);
  if (previous.writerActive)
    return {
      operation: "references.refresh",
      schemaVersion: 1,
      requestId: input.requestId,
      root: input.root,
      invocationStatus: "unknown",
      success: false,
      modelValidated: false,
      unavailableEvidence: [
        "existing request writer is active; no replay or lock theft",
      ],
    };
  if (previous.report) {
    if (previous.report.requestHash !== readRequestHash)
      throw new Error(
        "requestId already belongs to a different immutable read/plan request",
      );
    return { ...previous.report.result, replayedReceipt: true };
  }
  const snapshot = await services.graph(input, input),
    plan = services.plan(snapshot, input);
  if (input.phase === "audit") {
    let invocationStatus = plan.blocked.length ? "blocked" : "complete";
    if (
      (plan.notPlanned.length || !plan.graphComplete) &&
      invocationStatus === "complete"
    )
      invocationStatus = "partial";
    return services.finishRead(input, {
      ...plan,
      invocationStatus,
      completed: [],
      skipped: plan.skipped,
      failed: [],
      notProcessed: [],
      inProgress: null,
      budgetExceeded: false,
      continuation: null,
      errors: [],
      success: invocationStatus === "complete",
      modelValidated: true,
    });
  }
  if (input.phase === "plan") {
    const planId = await services.publishPlan(input, plan);
    const invocationStatus = plan.blocked.length
      ? "blocked"
      : plan.notPlanned.length
        ? "partial"
        : "complete";
    return services.finishRead(input, {
      ...plan,
      phase: "plan",
      planId,
      invocationStatus,
      success: invocationStatus === "complete",
      modelValidated: true,
    });
  }
  throw new Error("Unsupported references.refresh phase");
}
