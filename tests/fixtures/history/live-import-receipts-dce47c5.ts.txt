import assert from "node:assert/strict";

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
