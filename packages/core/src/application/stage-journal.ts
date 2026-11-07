import { canonical, hash } from "./cad/json";

export interface StageScope {
  owner: string;
  clientId: string;
  project: string;
  jobId: string;
  sequence: string;
  requestId: string;
  requestHash: string;
  build: string;
  document: string;
  inputIdentity: string;
}
export interface StageDefinition {
  id: string;
  requestHash: string;
  mutates: boolean;
}
export interface StageEntry {
  version: 1;
  sequence: number;
  previous: string | null;
  scope: StageScope;
  event:
    | { kind: "plan"; stages: StageDefinition[] }
    | { kind: "started"; stage: string; receipt: string };
  sha256: string;
}
/** The owning receipt reader must validate its original build/document/request
 * binding and terminal settlement, not just a script's success flag. */
export interface StageEvidencePort {
  accepted(scope: StageScope): "available" | "missing";
  ownerReady?(scope: StageScope): { ready: boolean; reason?: string };
  receipt(
    scope: StageScope,
    stage: StageDefinition,
    reference: string,
  ): StageReceiptEvidence;
}
export interface StageReceiptEvidence {
  status: "completed" | "unknown" | "missing" | "corrupt";
  sha256?: string;
  ownerTerminalSha256?: string;
  nativeTerminalSha256?: string;
  postflightSha256?: string;
  reason?: string;
}
export interface StageJournalPort {
  read(): StageEntry[];
  append(entry: StageEntry): void;
}
export function bindStageEntry(
  scope: StageScope,
  previous: StageEntry | undefined,
  event: StageEntry["event"],
): StageEntry {
  const body = {
    version: 1 as const,
    sequence: previous ? previous.sequence + 1 : 0,
    previous: previous?.sha256 ?? null,
    scope,
    event,
  };
  return JSON.parse(canonical({ ...body, sha256: hash(body) })) as StageEntry;
}

export function validateStageJournal(
  entries: StageEntry[],
  scope: StageScope,
): void {
  const requiredScope = [
    "owner",
    "clientId",
    "project",
    "jobId",
    "sequence",
    "requestId",
    "requestHash",
    "build",
    "document",
    "inputIdentity",
  ] as const;
  if (
    requiredScope.some(
      (key) => typeof scope[key] !== "string" || !scope[key],
    )
  )
    throw new Error("Stage scope requires every identity binding");
  const started = new Set<string>();
  let definitions: StageDefinition[] = [];
  entries.forEach((entry, index) => {
    const { sha256, ...body } = entry;
    if (
      entry.version !== 1 ||
      entry.sequence !== index ||
      entry.previous !== (entries[index - 1]?.sha256 ?? null) ||
      canonical(entry.scope) !== canonical(scope) ||
      hash(body) !== sha256
    )
      throw new Error("Stage journal gap, corruption or foreign scope");
    if (index === 0) {
      if (
        entry.event.kind !== "plan" ||
        !Array.isArray(entry.event.stages) ||
        !entry.event.stages.length
      )
        throw new Error("Stage journal requires an immutable plan");
      definitions = entry.event.stages;
      if (
        definitions.some(
          (stage) =>
            !stage.id ||
            !stage.requestHash ||
            typeof stage.mutates !== "boolean",
        ) ||
        new Set(definitions.map((stage) => stage.id)).size !==
          definitions.length
      )
        throw new Error("Invalid stage definitions");
    } else {
      if (
        entry.event.kind !== "started" ||
        !entry.event.receipt ||
        definitions[started.size]?.id !== entry.event.stage ||
        started.has(entry.event.stage)
      )
        throw new Error("Invalid or repeated stage intent");
      started.add(entry.event.stage);
    }
  });
}

/** Persist before the owner's physical send. There is deliberately no execute,
 * complete, retry, lease, scheduler or unknown-to-safe override method. */
export function createStageApi(journal: StageJournalPort, scope: StageScope) {
  const append = (event: StageEntry["event"]): void => {
    const entries = journal.read();
    validateStageJournal(entries, scope);
    const entry = bindStageEntry(scope, entries.at(-1), event);
    validateStageJournal([...entries, entry], scope);
    journal.append(entry);
  };
  return {
    plan: (stages: StageDefinition[]) => append({ kind: "plan", stages }),
    started: (stage: string, receipt: string) =>
      append({ kind: "started", stage, receipt }),
  };
}

export interface StageInspection {
  status: "valid" | "missing" | "reconciliationRequired";
  head: string | null;
  stages: { id: string; status: "completed" | "notStarted" | "unknown" }[];
  reasons: string[];
  receipts: {
    stage: string;
    reference: string;
    sha256: string | null;
    ownerTerminalSha256: string | null;
    nativeTerminalSha256: string | null;
    postflightSha256: string | null;
  }[];
  automaticResume: false;
  replayAllowed: false;
}
export function inspectStageJournal(
  journal: StageJournalPort,
  scope: StageScope,
  evidence: StageEvidencePort,
  expectedHead?: string,
): StageInspection {
  const result: StageInspection = {
    status: "reconciliationRequired",
    head: null,
    stages: [],
    reasons: [],
    receipts: [],
    automaticResume: false,
    replayAllowed: false,
  };
  try {
    const entries = journal.read();
    validateStageJournal(entries, scope);
    if (!entries.length)
      return {
        ...result,
        status: "missing",
        reasons: ["Journal missing; absence is not proof of no execution"],
      };
    result.head = entries.at(-1)!.sha256;
    if (expectedHead !== undefined && result.head !== expectedHead)
      throw new Error("Stage journal head changed or trailing record missing");
    if (evidence.accepted(scope) !== "available")
      result.reasons.push("Original accepted bytes missing");
    const owner = evidence.ownerReady?.(scope);
    if (owner && !owner.ready)
      result.reasons.push(owner.reason ?? "Owning job requires reconciliation");
    const plan = entries[0]!.event;
    if (plan.kind !== "plan") throw new Error("Missing plan");
    let blocked = false;
    for (const stage of plan.stages) {
      const intent = entries.find(
        (entry) =>
          entry.event.kind === "started" && entry.event.stage === stage.id,
      )?.event;
      let status: "completed" | "notStarted" | "unknown" = "notStarted";
      if (intent?.kind === "started") {
        let receipt: ReturnType<StageEvidencePort["receipt"]>;
        try {
          receipt = evidence.receipt(scope, stage, intent.receipt);
        } catch (error) {
          receipt = { status: "corrupt" };
          result.reasons.push(`${stage.id}: ${(error as Error).message}`);
        }
        result.receipts.push({
          stage: stage.id,
          reference: intent.receipt,
          sha256: receipt.sha256 ?? null,
          ownerTerminalSha256: receipt.ownerTerminalSha256 ?? null,
          nativeTerminalSha256: receipt.nativeTerminalSha256 ?? null,
          postflightSha256: receipt.postflightSha256 ?? null,
        });
        status =
          receipt.status === "completed" &&
          /^[a-f0-9]{64}$/.test(receipt.sha256 ?? "")
            ? "completed"
            : "unknown";
        if (status !== "completed")
          result.reasons.push(
            `${stage.id}: ${receipt.reason ?? `receipt ${receipt.status}; reconcile with owner`}`,
          );
        if (blocked) {
          status = "unknown";
          result.reasons.push(`${stage.id}: predecessor unresolved`);
        }
        blocked ||= status !== "completed";
      }
      result.stages.push({ id: stage.id, status });
    }
    result.status = result.reasons.length ? "reconciliationRequired" : "valid";
  } catch (error) {
    result.reasons.push((error as Error).message);
  }
  return result;
}

/** A plan is read-only advice, never authority to execute. Recompute immediately
 * before use; the owner must still perform normal broker admission/send fences. */
export function resumeStagePlan(
  journal: StageJournalPort,
  scope: StageScope,
  evidence: StageEvidencePort,
  expectedHead?: string,
) {
  const inspection = inspectStageJournal(
    journal,
    scope,
    evidence,
    expectedHead,
  );
  return {
    ...inspection,
    revalidate: [
      "journal head and all receipt hashes",
      "original accepted bytes",
      "owner/client/project/job/request",
      "current executable build and pinned document",
      "normal broker admission and final send fences",
    ],
    nextStage:
      inspection.status === "valid"
        ? (inspection.stages.find((stage) => stage.status === "notStarted")
            ?.id ?? null)
        : null,
  };
}

export function revalidateStagePlan(
  previous: ReturnType<typeof resumeStagePlan>,
  journal: StageJournalPort,
  scope: StageScope,
  evidence: StageEvidencePort,
) {
  const plan = resumeStagePlan(
    journal,
    scope,
    evidence,
    previous.head ?? undefined,
  );
  return {
    valid: plan.status === "valid" && canonical(plan) === canonical(previous),
    plan,
  };
}
