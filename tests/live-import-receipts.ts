import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { childProcessIdentity, writeHandoff } from "./scenarios/legacy-handoff";

export interface NativeInvocationBinding {
  requestId: string;
  clientId: string;
  document: { name: string; creationId: string };
  runtimeRoot: string;
  buildHash: string;
  fixtureId: string;
  manifestSha256: string;
  scriptSha256: string;
  command: readonly string[];
}
export interface NativeInvocationIntent {
  version: 1;
  binding: NativeInvocationBinding;
  commandSha256: string;
  driver: { pid: number; birth: string };
  state: "prepared" | "terminal-observed" | "settled";
  terminal?: PublicQueueJob;
}

/** Persist the exact caller-owned fixed invocation before spawning. Never overwrites a request. */
export function prepareNativeInvocation(
  directory: string,
  binding: NativeInvocationBinding,
): string {
  for (const value of [
    binding.requestId,
    binding.clientId,
    binding.document.name,
    binding.document.creationId,
    binding.runtimeRoot,
    binding.buildHash,
    binding.fixtureId,
    binding.manifestSha256,
    binding.scriptSha256,
  ])
    assert.ok(
      typeof value === "string" && value.length > 0,
      "Incomplete fixed native invocation identity",
    );
  assert.ok(
    path.isAbsolute(binding.runtimeRoot),
    "Fixed runtime root must be absolute",
  );
  for (const key of ["manifestSha256", "scriptSha256"] as const)
    assert.match(binding[key], /^[a-f0-9]{64}$/u);
  const pin = (flag: string, expected: string) => {
    const indices = binding.command.flatMap((word, index) =>
      word === flag ? [index] : [],
    );
    assert.equal(indices.length, 1, "Fixed invocation requires one " + flag);
    assert.equal(
      binding.command[indices[0]! + 1],
      expected,
      "Foreign fixed invocation " + flag,
    );
  };
  pin("--request-id", binding.requestId);
  pin("--doc", binding.document.name);
  pin("--doc-id", binding.document.creationId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assert.ok(
    fs.lstatSync(directory).isDirectory() &&
      !fs.lstatSync(directory).isSymbolicLink(),
  );
  const filename = path.join(
    directory,
    createHash("sha256").update(binding.requestId).digest("hex") + ".json",
  );
  const intent: NativeInvocationIntent = {
    version: 1,
    binding: structuredClone(binding),
    commandSha256: createHash("sha256")
      .update(JSON.stringify(binding.command))
      .digest("hex"),
    driver: { pid: process.pid, birth: childProcessIdentity.processBirth() },
    state: "prepared",
  };
  assert.ok(
    intent.driver.birth,
    "No verified driver process birth; refuse native admission",
  );
  // A new request ID or a restarted caller must not replay an uncertain fixed
  // mutation against the same scratch. Keep the claim even after settlement:
  // these pristine-fixture programs are one-shot, and recovery only reads.
  const claims = path.join(directory, "claims");
  fs.mkdirSync(claims, { recursive: true, mode: 0o700 });
  assert.ok(
    fs.lstatSync(claims).isDirectory() &&
      !fs.lstatSync(claims).isSymbolicLink(),
  );
  writeHandoff(
    path.join(
      claims,
      createHash("sha256")
        .update(binding.fixtureId + "\0" + binding.document.creationId)
        .digest("hex") + ".json",
    ),
    {
      version: 1,
      requestId: binding.requestId,
      clientId: binding.clientId,
      document: binding.document,
      fixtureId: binding.fixtureId,
      intent: filename,
    },
    true,
  );
  writeHandoff(filename, intent, true);
  return filename;
}

export function readNativeInvocation(filename: string): NativeInvocationIntent {
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  let raw: unknown;
  try {
    const stat = fs.fstatSync(descriptor);
    assert.ok(
      stat.isFile() && stat.size < 1024 * 1024,
      "Invalid native invocation record",
    );
    raw = JSON.parse(fs.readFileSync(descriptor, "utf8")) as unknown;
  } finally {
    fs.closeSync(descriptor);
  }
  const value = asRecord(raw, "Native invocation intent"),
    binding = asRecord(value["binding"], "Invocation binding");
  const document = asRecord(binding.document, "Invocation document"),
    driver = asRecord(value["driver"], "Invocation driver");
  assert.equal(value["version"], 1);
  for (const key of [
    "requestId",
    "clientId",
    "runtimeRoot",
    "buildHash",
    "fixtureId",
    "manifestSha256",
    "scriptSha256",
  ])
    assert.ok(
      typeof binding[key] === "string" && binding[key].length > 0,
      "Invalid invocation " + key,
    );
  for (const key of ["name", "creationId"])
    assert.ok(typeof document[key] === "string" && document[key].length > 0);
  assert.ok(
    Array.isArray(binding["command"]) &&
      binding["command"].every((word: unknown) => typeof word === "string"),
  );
  assert.equal(
    value["commandSha256"],
    createHash("sha256")
      .update(JSON.stringify(binding["command"]))
      .digest("hex"),
  );
  assert.equal(
    path.basename(filename),
    createHash("sha256").update(String(binding.requestId)).digest("hex") +
      ".json",
  );
  assert.ok(Number.isSafeInteger(driver["pid"]) && Number(driver["pid"]) > 0);
  assert.ok(typeof driver["birth"] === "string" && driver["birth"].length > 0);
  assert.ok(
    ["prepared", "terminal-observed", "settled"].includes(
      String(value["state"]),
    ),
  );
  if (value["terminal"] !== undefined)
    parsePublicQueueJob(value["terminal"], "Stored terminal receipt");
  return value as unknown as NativeInvocationIntent;
}

/** A CLI receipt is recorded separately from independent original-worker recovery. */
export function observeNativeInvocation(
  filename: string,
  acceptedValue: unknown,
  terminalValue: unknown,
): PublicQueueJob {
  const intent = readNativeInvocation(filename),
    accepted = asRecord(acceptedValue, "Accepted native invocation");
  const terminal = parsePublicQueueJob(
    terminalValue,
    "Native invocation terminal receipt",
  );
  assert.equal(accepted.requestId, intent.binding.requestId);
  assert.equal(accepted["jobId"], terminal.id);
  assert.equal(terminal.requestId, intent.binding.requestId);
  assert.equal(terminal.clientId, intent.binding.clientId);
  assert.ok(["succeeded", "failed"].includes(terminal.state));
  assert.equal(terminal.executionOutcome, terminal.state);
  assert.equal(terminal.operationResult["executionOutcome"], terminal.state);
  if (intent.terminal)
    assertWorkerMatchesCli(
      terminal,
      intent.terminal,
      "Repeated terminal observation",
    );
  writeHandoff(filename, { ...intent, state: "terminal-observed", terminal });
  return terminal;
}

/** Recovery only looks up the exact original request. It never submits, retries or closes a document. */
export async function recoverNativeInvocation(
  filename: string,
  lookup: (binding: NativeInvocationBinding) => Promise<unknown>,
  alive: (identity: {
    pid: number;
    birth: string;
  }) => boolean | null = childProcessIdentity.priorProcessAlive,
): Promise<PublicQueueJob> {
  const intent = readNativeInvocation(filename);
  assert.equal(
    alive(intent.driver),
    false,
    "Original native driver may still submit; defer recovery and cleanup",
  );
  const value = asRecord(
    await lookup(structuredClone(intent.binding)),
    "Original native worker result",
  );
  const execution = asRecord(
    value["execution"],
    "Original native SDK execution evidence",
  );
  assert.equal(
    execution["sdkSettled"],
    true,
    "Original SDK execution remains unsettled; never replay",
  );
  const job = parsePublicQueueJob(
    value["job"],
    "Original native worker receipt",
  );
  assert.equal(job.requestId, intent.binding.requestId);
  assert.equal(job.clientId, intent.binding.clientId);
  assert.ok(
    ["succeeded", "failed"].includes(job.state),
    "Original execution remains unsettled; never replay",
  );
  assert.equal(job.executionOutcome, job.state);
  assert.equal(job.operationResult["executionOutcome"], job.state);
  if (intent.terminal)
    assertWorkerMatchesCli(
      job,
      intent.terminal,
      "Recovered original native invocation",
    );
  writeHandoff(filename, { ...intent, state: "settled", terminal: job });
  return job;
}

export interface JsonRecord {
  [key: string]: unknown;
  id?: unknown;
  requestId?: unknown;
  clientId?: unknown;
  state?: unknown;
  code?: unknown;
  executionOutcome?: unknown;
  operationResult?: unknown;
  job?: unknown;
  outputs?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  artifact?: unknown;
  name?: unknown;
  cfg?: unknown;
  backend?: unknown;
  transport?: unknown;
  timeoutMs?: unknown;
  documents?: unknown;
  creationId?: unknown;
  saved?: unknown;
  modified?: unknown;
  activeCreationId?: unknown;
  success?: unknown;
  result?: unknown;
  document?: unknown;
  documentIdentity?: unknown;
  status?: unknown;
  method?: unknown;
  modelValidated?: unknown;
  mutation?: unknown;
  kind?: unknown;
  occurrencePath?: unknown;
  jobId?: unknown;
}

export interface LiveDocumentState {
  creationId: string;
  name: string;
  saved: boolean;
  modified: boolean;
  fileId: string | null;
}

export interface LiveDocumentSnapshot {
  documents: LiveDocumentState[];
  activeCreationId: string | null;
}

export function assertProtectedBaselineDocuments(
  baseline: LiveDocumentSnapshot,
  current: LiveDocumentSnapshot,
  label: string,
): void {
  const byId = new Map(
    current.documents.map((document) => [document.creationId, document]),
  );
  for (const original of baseline.documents) {
    assert.deepEqual(
      byId.get(original.creationId),
      original,
      `${label}: pre-existing document ${original.creationId} changed or disappeared`,
    );
  }
}

export function assertActiveDocumentRestored(
  baseline: LiveDocumentSnapshot,
  current: LiveDocumentSnapshot,
  label: string,
): void {
  assert.equal(
    current.activeCreationId,
    baseline.activeCreationId,
    `${label}: previously active document was not restored`,
  );
}

export interface PublicQueueJob {
  id: string;
  requestId: string;
  clientId: string;
  state: string;
  code?: string;
  executionOutcome?: string;
  operationResult: JsonRecord;
}

export interface QueueOutputDescriptor {
  name?: string;
  artifact?: JsonRecord;
}

export interface WorkerResultReadback {
  job: PublicQueueJob;
  outputs?: Record<string, QueueOutputDescriptor>;
  stdout?: string;
  stderr?: string;
}

export function asRecord(value: unknown, label: string): JsonRecord {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as JsonRecord;
}

export function asArray(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

export function parsePublicQueueJob(
  value: unknown,
  label: string,
): PublicQueueJob {
  const row = asRecord(value, label);
  assert.equal(typeof row.id, "string", `${label}.id must be a string`);
  assert.equal(
    typeof row.requestId,
    "string",
    `${label}.requestId must be a string`,
  );
  assert.equal(
    typeof row.clientId,
    "string",
    `${label}.clientId must be a string`,
  );
  assert.equal(typeof row.state, "string", `${label}.state must be a string`);
  assert.ok(
    row.code === undefined || typeof row.code === "string",
    `${label}.code must be a string when present`,
  );
  assert.ok(
    row.executionOutcome === undefined ||
      typeof row.executionOutcome === "string",
    `${label}.executionOutcome must be a string when present`,
  );
  const operationResult = asRecord(
    row.operationResult,
    `${label}.operationResult`,
  );
  assert.ok(
    operationResult["code"] === undefined ||
      typeof operationResult["code"] === "string",
    `${label}.operationResult.code must be a string when present`,
  );
  assert.ok(
    operationResult["executionOutcome"] === undefined ||
      typeof operationResult["executionOutcome"] === "string",
    `${label}.operationResult.executionOutcome must be a string when present`,
  );
  return {
    id: row.id as string,
    requestId: row.requestId as string,
    clientId: row.clientId as string,
    state: row.state as string,
    ...(typeof row.code === "string" ? { code: row.code } : {}),
    ...(typeof row.executionOutcome === "string"
      ? { executionOutcome: row.executionOutcome }
      : {}),
    operationResult,
  };
}

export function parseWorkerResultReadback(
  value: unknown,
  label: string,
): WorkerResultReadback {
  const row = asRecord(value, label);
  const job = parsePublicQueueJob(row.job, `${label}.job`);
  let outputs: Record<string, QueueOutputDescriptor> | undefined;
  if (row.outputs !== undefined) {
    const rawOutputs = asRecord(row.outputs, `${label}.outputs`);
    outputs = {};
    for (const [key, descriptor] of Object.entries(rawOutputs)) {
      const output = asRecord(descriptor, `${label}.outputs.${key}`);
      let artifact: QueueOutputDescriptor["artifact"];
      if (output.artifact !== undefined) {
        const artifactRecord = asRecord(
          output.artifact,
          `${label}.outputs.${key}.artifact`,
        );
        artifact = { ...artifactRecord };
      }
      assert.ok(
        output.name === undefined || typeof output.name === "string",
        `${label}.outputs.${key}.name must be a string when present`,
      );
      outputs[key] = {
        ...(typeof output.name === "string" ? { name: output.name } : {}),
        ...(artifact ? { artifact } : {}),
      };
    }
  }
  assert.ok(
    row.stdout === undefined || typeof row.stdout === "string",
    `${label}.stdout must be a string when present`,
  );
  assert.ok(
    row.stderr === undefined || typeof row.stderr === "string",
    `${label}.stderr must be a string when present`,
  );
  return {
    job,
    ...(outputs ? { outputs } : {}),
    ...(typeof row.stdout === "string" ? { stdout: row.stdout } : {}),
    ...(typeof row.stderr === "string" ? { stderr: row.stderr } : {}),
  };
}

export function assertWorkerMatchesCli(
  workerValue: unknown,
  cliValue: unknown,
  label: string,
): void {
  const worker = parsePublicQueueJob(workerValue, `${label} worker job`);
  const cli = parsePublicQueueJob(cliValue, `${label} CLI terminal projection`);
  assert.equal(worker.id, cli.id);
  assert.equal(worker.requestId, cli.requestId);
  assert.equal(worker.clientId, cli.clientId);
  assert.equal(worker.state, cli.state);
  assert.equal(worker.code, cli.code);
  assert.equal(worker.executionOutcome, cli.executionOutcome);
  assert.deepEqual(worker.operationResult, cli.operationResult);
}
