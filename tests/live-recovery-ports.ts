import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

export interface Job {
  readonly id: string;
  readonly requestId: string;
  readonly clientId: string;
  readonly state: string;
  readonly code?: string;
  readonly dispatch?: { readonly rpcCount?: number };
}
export interface Result {
  readonly job: Job;
  readonly stdout: string;
  readonly execution: {
    readonly sdkSettled?: boolean;
    readonly mayHaveMutated?: boolean;
  };
}
export interface Queue {
  readonly auth: { readonly clientId: string };
  register(options: { autoStart: false }): Promise<unknown>;
  call(action: string, values?: Record<string, unknown>): Promise<unknown>;
  submit(input: Record<string, unknown>): Promise<Job>;
  wait(id: string): Promise<Result>;
  dispose(): void;
}
export interface ClientModule {
  QueueClient: new (id: string, options: Record<string, unknown>) => Queue;
  final(state: string): boolean;
  inputFiles(argv: string[], cwd: string): unknown;
}
export interface Broker {
  readonly buildHash: string;
  readonly admissionScope: string;
  readonly isolatedScratchScope?: { readonly admission: string };
}
export interface OwnedDocument {
  readonly name: string;
  readonly creationId: string;
  readonly previous?: string | null;
}
export interface NativeState {
  readonly active: string | null;
  readonly documents: readonly {
    readonly id: string;
    readonly name: string;
    readonly saved: boolean;
    readonly modified: boolean;
  }[];
}
export interface PhaseReceipt {
  requestId: string;
  phase: string;
  clientId?: string;
  job?: Job;
  result?: Result;
}
export interface LiveReport {
  runId: string;
  buildHash: string;
  status: string;
  receipts: PhaseReceipt[];
  documents: OwnedDocument[];
  broker?: Broker;
  before?: NativeState;
  after?: NativeState;
  continues?: string;
  writes?: unknown[];
  readbacks?: unknown[];
  cleanup?: unknown[];
  error?: string;
  finishedAt?: string;
  executorObservations?: {
    clientId: string;
    at: string;
    activeOperations: number;
  }[];
  sdkIntervals?: { creationId: string; started: number; finished: number }[];
  maxOwnScriptConcurrency?: number;
  failureCleanup?: unknown[];
  cleanupDeferredReason?: string;
  cleanupError?: string;
}

/** Settlement is necessary, but callers still fence identity and shared state. */
export function knownSettlement(
  results: readonly (Result | undefined)[],
): boolean {
  return (
    results.length > 0 &&
    results.every(
      (result) =>
        result !== undefined &&
        ["succeeded", "failed"].includes(result.job.state) &&
        result.execution.sdkSettled === true,
    )
  );
}

/** Only callers with recorded creation and known settled work use this body. */
export function ownedCleanupSource(
  document: OwnedDocument,
  restore: string | null,
  prefix: "" | "FMCAD_RESULT ",
): string {
  const previous = restore === null ? "None" : JSON.stringify(restore);
  return `a=adsk.core.Application.get()
owned=[d for d in a.documents if d.creationId==${JSON.stringify(document.creationId)}]
assert len(owned)<=1
if owned:
    d=owned[0]
    assert d.name==${JSON.stringify(document.name)} and not d.isSaved
    assert d.close(False)
previous=[d for d in a.documents if d.creationId==${previous}]
if previous: assert previous[0].activate()
print(${JSON.stringify(prefix)}+json.dumps(dict(closed=True,creationId=${JSON.stringify(document.creationId)},alreadyAbsent=not bool(owned),active=a.activeDocument.creationId if a.activeDocument else None)))`;
}
export const runtime = path.resolve(
  process.env["FMCAD_LIVE_RUNTIME"] || path.join(__dirname, "../.."),
);
export const runtimeRequire = createRequire(
  path.join(runtime, "src/queue-client.js"),
);
export const clientModule = runtimeRequire("./queue-client") as ClientModule;
export const config = runtimeRequire("./config") as {
  loadConfig(options: { routing: "queue" }): {
    cfg: { backend: string; queue?: Record<string, unknown> };
  };
};
export const identity = runtimeRequire("./queue-instance") as {
  buildHash(): string;
};
export function object(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected JSON object",
  );
  return value as Record<string, unknown>;
}
export function parse(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  return object(value);
}
export function owned(value: unknown): OwnedDocument {
  const data = object(value);
  assert.equal(typeof data["name"], "string");
  assert.equal(typeof data["creationId"], "string");
  return {
    name: String(data["name"]),
    creationId: String(data["creationId"]),
    ...(data["previous"] === null || typeof data["previous"] === "string"
      ? { previous: data["previous"] }
      : {}),
  };
}
export function broker(value: unknown): Broker {
  const data = object(value);
  assert.equal(typeof data["buildHash"], "string");
  assert.equal(typeof data["admissionScope"], "string");
  return {
    buildHash: String(data["buildHash"]),
    admissionScope: String(data["admissionScope"]),
  };
}
export function result(value: unknown): Result {
  const data = object(value),
    job = object(data["job"]);
  for (const key of ["id", "requestId", "clientId", "state"])
    assert.equal(typeof job[key], "string");
  assert.equal(typeof data["stdout"], "string");
  object(data["execution"]);
  return value as Result;
}
export function nativeState(value: unknown): NativeState {
  const data = object(value);
  assert.ok(data["active"] === null || typeof data["active"] === "string");
  assert.ok(Array.isArray(data["documents"]));
  for (const item of data["documents"]) {
    const row = object(item);
    assert.equal(typeof row["id"], "string");
    assert.equal(typeof row["name"], "string");
    assert.equal(typeof row["saved"], "boolean");
    assert.equal(typeof row["modified"], "boolean");
  }
  return value as NativeState;
}
