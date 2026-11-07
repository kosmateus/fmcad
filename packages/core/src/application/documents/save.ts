import { hash } from "../cad/json";
import type { DocumentSaveStages } from "./stages";

export type SaveOperation = "document.save.once" | "document.save.observe";
export interface SaveRequest {
  requestId: string;
  operationId: string;
  projectId: string;
  fileId: string;
  creationId: string;
  expectedVersion: number;
  reportPath: string;
  confirm?: boolean;
  description?: string;
  timeBudgetMs?: number;
}
export interface SaveContext {
  doc?: string | null;
  docId?: string | null;
  docFileId?: string | null;
  projectId?: string | null;
}
export interface SaveTarget {
  creationId: string;
  fileId: string;
  projectId: string;
  version: number;
}
export interface SaveBinding {
  operation: "document.save.once";
  requestId: string;
  operationId: string;
  requestHash: string;
  target: SaveTarget;
}
export type SaveStatus =
  | "submit_uncertain"
  | "accepted"
  | "pending"
  | "complete"
  | "failed"
  | "blocked"
  | "unknown"
  | "noop";
export interface SaveEvidence {
  stageJournalHead?: string;
  status: SaveStatus;
  accepted?: boolean | null;
  changed?: boolean | null;
  baselineVersion?: number;
  resultingVersion?: number | null;
  cloudComplete?: boolean | null;
  unavailableEvidence?: string[];
}
export interface SaveResult extends SaveEvidence {
  success: boolean;
  operation: SaveOperation;
  requestId: string;
  operationId: string;
  requestHash: string;
  target: SaveTarget;
  receipt: SaveEvidence | null;
  replayedReceipt: boolean;
}
export interface SaveSnapshot {
  name?: unknown;
  creationId?: unknown;
  fileId?: unknown;
  projectId?: unknown;
  version?: unknown;
  saved?: unknown;
  modified?: unknown;
  isComplete?: unknown;
  isReadOnly?: unknown;
}
export interface NativeSaveResult {
  status?: unknown;
  accepted?: boolean | null;
  cloudComplete?: boolean | null;
  reason?: string;
}
export interface SaveRecord {
  result: SaveEvidence;
}
export interface SaveJournal {
  load(): Promise<{ records: SaveRecord[]; binding: SaveBinding }>;
  /** Exclusive ownership survives process failure; never steal an unresolved lock. */
  acquireSubmission(): Promise<null | (() => Promise<void>)>;
  submissionExists(): Promise<boolean>;
  append(
    binding: SaveBinding,
    records: SaveRecord[],
    evidence: SaveEvidence,
  ): Promise<void>;
}
export interface SaveServices {
  stages?: DocumentSaveStages;
  open(
    request: SaveRequest,
    binding: SaveBinding,
    create: boolean,
  ): Promise<SaveJournal>;
  status(context: SaveContext): Promise<SaveSnapshot>;
  save(
    request: SaveRequest,
    target: SaveTarget,
    context: SaveContext,
  ): Promise<NativeSaveResult | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const OPERATIONS: readonly SaveOperation[] = [
  "document.save.once",
  "document.save.observe",
];
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
class SavePersistenceError extends Error {
  constructor(
    readonly evidence: SaveEvidence,
    error: unknown,
  ) {
    super(message(error));
  }
}
async function persist(
  journal: SaveJournal,
  binding: SaveBinding,
  records: SaveRecord[],
  value: SaveEvidence,
): Promise<void> {
  try {
    await journal.append(binding, records, value);
  } catch (error) {
    throw new SavePersistenceError(value, error);
  }
}

/** The only public validator, shared by catalog and direct service callers. */
export function validate(operation: string, data: unknown): void {
  if (!OPERATIONS.includes(operation as SaveOperation)) return;
  if (!object(data)) throw new Error(operation + " data must be an object");
  const required = [
    "requestId",
    "operationId",
    "projectId",
    "fileId",
    "creationId",
    "expectedVersion",
    "reportPath",
  ];
  if (operation === "document.save.once") required.push("confirm");
  const allowed = [
    ...required,
    "timeBudgetMs",
    ...(operation === "document.save.once" ? ["description"] : []),
  ];
  for (const key of Object.keys(data))
    if (!allowed.includes(key))
      throw new Error("Unknown " + operation + " input: " + key);
  for (const key of required)
    if (!Object.hasOwn(data, key))
      throw new Error(operation + " requires " + key);
  for (const key of ["requestId", "operationId"]) {
    if (
      typeof data[key] !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(data[key])
    )
      throw new Error(
        key + " must contain 1..128 letters, digits, underscores or hyphens",
      );
  }
  for (const key of ["projectId", "fileId", "creationId", "reportPath"]) {
    if (typeof data[key] !== "string" || !data[key].trim())
      throw new Error(key + " must be a nonempty exact value");
  }
  if (
    !Number.isSafeInteger(data["expectedVersion"]) ||
    Number(data["expectedVersion"]) <= 0
  )
    throw new Error("expectedVersion must be a positive safe integer");
  if (operation === "document.save.once" && data["confirm"] !== true)
    throw new Error("confirm must be boolean true");
  if (
    data["description"] !== undefined &&
    typeof data["description"] !== "string"
  )
    throw new Error("description must be a string");
  const budget = data["timeBudgetMs"];
  if (
    budget !== undefined &&
    (!Number.isSafeInteger(budget) ||
      Number(budget) < 1 ||
      Number(budget) > 120000)
  )
    throw new Error("timeBudgetMs must be an integer in 1..120000");
}
export function bindingFor(data: SaveRequest): SaveBinding {
  const target = {
    creationId: data.creationId,
    fileId: data.fileId,
    projectId: data.projectId,
    version: data.expectedVersion,
  };
  return {
    operation: "document.save.once",
    requestId: data.requestId,
    operationId: data.operationId,
    requestHash: hash({
      requestId: data.requestId,
      operationId: data.operationId,
      target,
    }),
    target,
  };
}
export function receiptResult(
  operation: SaveOperation,
  binding: SaveBinding,
  value: SaveEvidence,
  replayedReceipt = false,
  receipt: SaveEvidence | null = value,
): SaveResult {
  return {
    success: ["complete", "noop"].includes(value.status),
    operation,
    requestId: binding.requestId,
    operationId: binding.operationId,
    requestHash: binding.requestHash,
    target: binding.target,
    ...value,
    accepted: value.accepted ?? null,
    changed: value.changed ?? null,
    baselineVersion: value.baselineVersion ?? binding.target.version,
    resultingVersion: value.resultingVersion ?? null,
    cloudComplete: value.cloudComplete ?? null,
    receipt,
    replayedReceipt,
    unavailableEvidence: value.unavailableEvidence ?? [],
  };
}
export function observedPublication(
  snapshot: SaveSnapshot,
  binding: SaveBinding,
  accepted: boolean | null,
): SaveEvidence {
  const target = binding.target;
  if (
    snapshot.creationId !== target.creationId ||
    snapshot.fileId !== target.fileId ||
    snapshot.projectId !== target.projectId
  )
    return {
      status: "unknown",
      accepted,
      changed: true,
      unavailableEvidence: [
        "current document identity no longer matches the original save target",
      ],
    };
  if (
    typeof snapshot.version !== "number" ||
    !Number.isSafeInteger(snapshot.version) ||
    snapshot.version < target.version
  )
    return {
      status: "unknown",
      accepted,
      changed: true,
      unavailableEvidence: [
        "current version is unavailable or precedes the saved baseline",
      ],
    };
  if (
    snapshot.version > target.version &&
    snapshot.saved === true &&
    snapshot.modified === false &&
    snapshot.isComplete === true
  )
    return {
      status: "complete",
      accepted,
      changed: true,
      resultingVersion: snapshot.version,
      cloudComplete: true,
    };
  if (snapshot.modified === true && snapshot.version > target.version)
    return {
      status: "unknown",
      accepted,
      changed: true,
      unavailableEvidence: [
        "target became modified after the submitted save; publication attribution is ambiguous",
      ],
    };
  return {
    status: "pending",
    accepted,
    changed: true,
    resultingVersion: snapshot.version,
    cloudComplete: snapshot.isComplete === true ? true : null,
  };
}
async function observe(
  operation: SaveOperation,
  data: SaveRequest,
  context: SaveContext,
  binding: SaveBinding,
  journal: SaveJournal,
  records: SaveRecord[],
  recordBinding: SaveBinding,
  accepted: boolean | null,
  services: SaveServices,
): Promise<SaveResult> {
  const deadline = services.now() + (data.timeBudgetMs ?? 30000);
  let last: SaveEvidence | undefined;
  while (services.now() < deadline) {
    try {
      last = observedPublication(
        await services.status(context),
        binding,
        accepted,
      );
    } catch (error) {
      last = {
        status: "unknown",
        accepted,
        changed: true,
        unavailableEvidence: [
          "document.status readback failed: " + message(error),
        ],
      };
      break;
    }
    if (last.status !== "pending" || services.now() >= deadline) break;
    await services.sleep(Math.min(100, Math.max(1, deadline - services.now())));
  }
  last ??= {
    status: accepted === true ? "accepted" : "unknown",
    accepted,
    changed: true,
    unavailableEvidence: [
      "observation budget expired before a publication status read",
    ],
  };
  if (last.status === "pending" && services.now() >= deadline)
    last.unavailableEvidence = [
      "publication remains pending at the bounded observation deadline",
    ];
  const stageJournalHead = records.at(-1)?.result.stageJournalHead;
  if (stageJournalHead) last.stageJournalHead = stageJournalHead;
  await persist(journal, recordBinding, records, last);
  return receiptResult(
    operation,
    operation === "document.save.observe" ? recordBinding : binding,
    last,
  );
}
async function run(
  operation: SaveOperation,
  data: SaveRequest,
  context: SaveContext,
  binding: SaveBinding,
  services: SaveServices,
): Promise<SaveResult> {
  const journal = await services.open(
    data,
    binding,
    operation === "document.save.once",
  );
  let loaded: Awaited<ReturnType<SaveJournal["load"]>>;
  try {
    loaded = await journal.load();
  } catch (error) {
    if (operation !== "document.save.observe") throw error;
    return receiptResult(
      operation,
      binding,
      {
        status: "blocked",
        unavailableEvidence: [
          "receipt identity or journal is invalid: " + message(error),
        ],
      },
      false,
      null,
    );
  }
  let records = loaded.records;
  if (operation === "document.save.observe") {
    const last = records.at(-1);
    if (!last)
      return receiptResult(
        operation,
        binding,
        {
          status: "unknown",
          unavailableEvidence: [
            (await journal.submissionExists())
              ? "an interrupted submission lock exists without a complete receipt; save is not replayed"
              : "original save receipt is missing; no submission outcome can be inferred and no save is issued",
          ],
        },
        false,
        null,
      );
    if (["noop", "complete", "failed", "blocked"].includes(last.result.status))
      return receiptResult(operation, loaded.binding, last.result, true);
    return observe(
      operation,
      data,
      context,
      binding,
      journal,
      records,
      loaded.binding,
      last.result.accepted ?? null,
      services,
    );
  }
  if (records.length)
    return receiptResult(operation, binding, records.at(-1)!.result, true);
  const release = await journal.acquireSubmission();
  if (!release)
    return receiptResult(
      operation,
      binding,
      {
        status: "unknown",
        unavailableEvidence: [
          "another submission owns this request identity; no second save was sent",
        ],
      },
      false,
      null,
    );
  try {
    loaded = await journal.load();
    records = loaded.records;
    if (records.length)
      return receiptResult(operation, binding, records.at(-1)!.result, true);
    let before: SaveSnapshot;
    try {
      before = await services.status(context);
    } catch (error) {
      return receiptResult(
        operation,
        binding,
        {
          status: "blocked",
          accepted: false,
          changed: false,
          unavailableEvidence: [
            "exact target preflight status unavailable: " + message(error),
          ],
        },
        false,
        null,
      );
    }
    const target = binding.target;
    let reason: string | undefined;
    if (
      before.name !== context.doc ||
      before.creationId !== target.creationId ||
      before.fileId !== target.fileId ||
      before.projectId !== target.projectId ||
      before.version !== target.version
    )
      reason =
        "name/creationId/fileId/projectId/version differs from requested target";
    else if (before.saved !== true) reason = "target must already be saved";
    else if (
      before.modified !== false &&
      (before.isComplete !== true || before.isReadOnly !== false)
    )
      reason =
        "changed target must be cloud complete and writable before saving";
    if (reason)
      return receiptResult(
        operation,
        binding,
        {
          status: "blocked",
          accepted: false,
          changed: false,
          unavailableEvidence: [reason],
        },
        false,
        null,
      );
    let stageJournalHead: string | undefined;
    const settle = async (value: SaveEvidence): Promise<SaveResult> => {
      if (stageJournalHead) value.stageJournalHead = stageJournalHead;
      await persist(journal, loaded.binding, records, value);
      return receiptResult(operation, binding, value);
    };
    if (before.modified === false)
      return settle({
        status: "noop",
        accepted: false,
        changed: false,
        resultingVersion: target.version,
        cloudComplete:
          before.isComplete === true
            ? true
            : before.isComplete === false
              ? false
              : null,
      });
    // Durable intent precedes the only save call. Missing acknowledgement never authorizes replay.
    try {
      stageJournalHead = await services.stages?.plan(binding);
    } catch (error) {
      throw new SavePersistenceError(
        { status: "blocked", accepted: false, changed: false },
        error,
      );
    }
    try {
      await journal.append(loaded.binding, records, {
        status: "submit_uncertain",
        accepted: null,
        changed: true,
        baselineVersion: target.version,
        ...(stageJournalHead ? { stageJournalHead } : {}),
      });
    } catch (error) {
      throw new SavePersistenceError(
        { status: "blocked", accepted: false, changed: false },
        error,
      );
    }
    try {
      stageJournalHead = await services.stages?.started(binding);
    } catch (error) {
      throw new SavePersistenceError(
        {
          status: "blocked",
          accepted: false,
          changed: false,
          ...(stageJournalHead ? { stageJournalHead } : {}),
        },
        error,
      );
    }
    let outcome: NativeSaveResult | null;
    try {
      outcome = await services.save(data, target, context);
    } catch (error) {
      return settle({
        status: "unknown",
        accepted: null,
        changed: true,
        unavailableEvidence: ["save RPC outcome is unknown: " + message(error)],
      });
    }
    if (!outcome)
      return settle({
        status: "unknown",
        accepted: null,
        changed: true,
        unavailableEvidence: ["save RPC returned no structured native result"],
      });
    if (outcome.status === "noop")
      return settle({
        status: "noop",
        accepted: false,
        changed: false,
        resultingVersion: target.version,
        cloudComplete: outcome.cloudComplete ?? null,
      });
    if (outcome.status === "blocked")
      return settle({
        status: "blocked",
        accepted: false,
        changed: false,
        unavailableEvidence: [
          outcome.reason ?? "native pre-save guard refused the target",
        ],
      });
    if (outcome.status === "failed" && outcome.accepted === false)
      return settle({
        status: "failed",
        accepted: false,
        changed: true,
        unavailableEvidence: [
          outcome.reason ?? "Fusion did not accept the save",
        ],
      });
    if (outcome.status !== "accepted" || outcome.accepted !== true)
      return settle({
        status: "unknown",
        accepted: outcome.accepted ?? null,
        changed: true,
        unavailableEvidence: [
          outcome.reason ??
            "native save result is not a known accepted/no-op/failed result",
        ],
      });
    await persist(journal, loaded.binding, records, {
      status: "accepted",
      accepted: true,
      changed: true,
      baselineVersion: target.version,
      ...(stageJournalHead ? { stageJournalHead } : {}),
    });
    return observe(
      operation,
      data,
      context,
      binding,
      journal,
      records,
      loaded.binding,
      true,
      services,
    );
  } finally {
    try {
      await release();
    } catch (error) {
      throw new SavePersistenceError(
        records.at(-1)?.result ?? { status: "unknown" },
        error,
      );
    }
  }
}
export async function execute(
  operation: SaveOperation,
  input: unknown,
  context: SaveContext,
  services: SaveServices,
): Promise<SaveResult> {
  validate(operation, input);
  const data = { ...(input as SaveRequest) },
    binding = bindingFor(data);
  context = { ...context };
  if (
    !context.doc ||
    context.docId !== data.creationId ||
    context.docFileId !== data.fileId ||
    context.projectId !== data.projectId
  )
    return receiptResult(
      operation,
      binding,
      {
        status: "blocked",
        accepted: false,
        changed: false,
        unavailableEvidence: [
          "document save target requires matching --doc, --doc-id, --doc-file-id and --project-id context",
        ],
      },
      false,
      null,
    );
  try {
    return await run(operation, data, context, binding, services);
  } catch (error) {
    if (error instanceof SavePersistenceError)
      return receiptResult(
        operation,
        binding,
        {
          ...error.evidence,
          status:
            error.evidence.accepted === false &&
            error.evidence.changed === false
              ? "blocked"
              : "unknown",
          unavailableEvidence: [
            "receipt publication failed: " + message(error),
            "inspect the original request; no second save is authorized",
          ],
        },
        false,
        null,
      );
    return receiptResult(
      operation,
      binding,
      { status: "unknown", unavailableEvidence: [message(error)] },
      false,
      null,
    );
  }
}
