import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import {
  decodePublicResult,
  type CatalogInvocation,
  type JsonValue,
  type OperationContract,
  type OperationResult,
} from "@fmcad/core";

type JsonRecord = Record<string, JsonValue>;
type Operation =
  | "sketch.dimension-plan"
  | "sketch.dimension-apply"
  | "sketch.mirror"
  | "sketch.offset"
  | "sketch.pattern"
  | "sketch.project"
  | "sketch.transform"
  | "sketch.coordinate-check"
  | "sketch.check";
type SketchReference = JsonRecord & { token: string };
type DocumentRow = {
  raw: string;
  name: string | null;
  id: string | null;
  creationId: string | null;
  active: boolean | null;
};
type OwnedDocument = { name: string; creationId: string };
type QueueReceipt = {
  requestId: string;
  jobId: string;
  clientId: string;
  state: string;
  operationResult: OperationResult;
};
type CommandEvidence = {
  args: string[];
  exitCode: number | null;
  signal?: string;
  error?: string;
  stdoutBytes: number;
  stdoutSha256: string;
  stdout: string;
  stderr: string;
  status: string;
  queue?: QueueReceipt;
};
type MethodEvidence = {
  operation: string;
  status: "invoked" | "pass";
  supportOnly: boolean;
  service: string;
  sdk: string;
  readOnly: boolean;
  creationId: string | null;
  queue: QueueReceipt;
  result: JsonRecord;
  assertions?: string[];
  evidence?: string;
  offsetParameter?: string | null;
};
type AssertionEvidence = {
  operation: string;
  label: string;
  actual: JsonValue;
  expected: JsonValue;
  tolerance: number;
  status: "pass" | "fail";
};
type InventorySnapshot = {
  count: number;
  stableSha256: string;
  activeSha256: string | null;
  ownDocumentCount: number;
};
type TestEvidence = { name: string; status: string; error?: string };
type Contract = Pick<
  OperationContract,
  "operation" | "service" | "readOnlyRequested" | "cli"
> & {
  declaration: JsonRecord;
  requirements: Pick<OperationContract["requirements"], "sdk" | "document">;
};
type InstalledCatalog = {
  contracts: Readonly<Record<string, Contract>>;
  catalog: Readonly<Record<string, JsonRecord>>;
  localInvocation(input: {
    operation: string;
    data: JsonRecord;
    preview: false;
  }): boolean;
  validateCad(operation: string, data: JsonRecord): unknown;
};
type InstalledCommandRoute = { key: string; target: string; kind: string };
type InstalledCommandRegistry = {
  findCommand(argv: string[]): InstalledCommandRoute | undefined;
};
type LiveReport = {
  suite: string;
  sourceCommit: string;
  startedAt: string;
  clientId: string;
  runtime: { root: string; buildHash: string; catalogCount: number };
  document: {
    name: string;
    creationId?: string;
    savedBefore?: boolean;
    modifiedBefore?: boolean;
    fileIdBefore?: string | null;
  };
  scope: string;
  operations: readonly Operation[];
  supportOnly: readonly string[];
  commands: CommandEvidence[];
  supportResults: MethodEvidence[];
  methodResults: MethodEvidence[];
  assertions: AssertionEvidence[];
  tests: TestEvidence[];
  inventory: {
    before?: InventorySnapshot;
    afterCreate?: InventorySnapshot;
    after?: InventorySnapshot;
    userDocumentsUnchanged?: boolean;
  };
  fixtureClosed: boolean;
  cleanup: string;
  cleanupError?: string;
  limitations: string[];
  sketchNames?: Record<string, string>;
  fixtureRefs?: string[];
  operationCoverage?: Array<Record<string, JsonValue>>;
  finishedAt?: string;
};
type CliResult = {
  row: CommandEvidence;
  stdout: string;
  stderr: string;
  receipt: QueueReceipt;
};
type SketchSuite = {
  sketchNames: {
    dimension: string;
    operations: string;
    projectSource: string;
    projectTarget: string;
  };
  refs: Record<string, SketchReference>;
};
class PreDispatchError extends Error {}
class UnknownExecutionError extends Error {}

const operations: readonly Operation[] = [
  "sketch.dimension-plan",
  "sketch.dimension-apply",
  "sketch.mirror",
  "sketch.offset",
  "sketch.pattern",
  "sketch.project",
  "sketch.transform",
  "sketch.coordinate-check",
  "sketch.check",
];
const operationSet: ReadonlySet<string> = new Set(operations);
const readOnlyOperations = new Set<Operation>([
  "sketch.dimension-plan",
  "sketch.coordinate-check",
  "sketch.check",
]);
const terminalStates = new Set(["succeeded", "failed", "cancelled", "expired"]);
const runId = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
const documentName = `FMCAD_SKETCH_OPS_${runId}`;
const fixturePrefix = `NQSKETCHOPS${runId}`;
const reportTag = createHash("sha256")
  .update(process.env["FMCAD_LIVE_CLIENT"] ?? runId)
  .digest("hex")
  .slice(0, 12);
const projectRoot = path.resolve(__dirname, "../..");
const reportPath = path.join(
  projectRoot,
  "tests",
  `live-sketch-operations-${reportTag}-${runId}-report.json`,
);
const report: LiveReport = {
  suite: "sketch-operations",
  sourceCommit: "not-read",
  startedAt: new Date().toISOString(),
  clientId: process.env["FMCAD_LIVE_CLIENT"] ?? "",
  runtime: { root: "not-loaded", buildHash: "not-loaded", catalogCount: 0 },
  document: { name: documentName },
  scope:
    "One newly created unsaved document owned by this suite; no save, cloud writes, existing-document edits, or preference changes.",
  operations,
  supportOnly: [
    "active",
    "doc list",
    "doc new",
    "document.status",
    "sketch.create",
    "sketch.geometry",
    "sketch.inspect",
    "doc close --discard",
  ],
  commands: [],
  supportResults: [],
  methodResults: [],
  assertions: [],
  tests: [],
  inventory: {},
  fixtureClosed: false,
  cleanup: "not-started",
  limitations: [
    "Readbacks cover native sketch entities and solver state, not BRep creation or physical certification.",
  ],
};

let runtimeRoot = "";
let cliPath = "";
let installedCatalog: InstalledCatalog | undefined;
let installedCommands: InstalledCommandRegistry | undefined;
let baselineStable: string[] = [];
let baselineActive: string | null = null;
let identity: OwnedDocument | undefined;
let unknownExecution = false;
let blockedReason: string | undefined;
let failure: Error | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), `${label} must be an object`);
  return value;
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, label));
  assert.ok(isRecord(value), `${label} must contain JSON values`);
  const result: JsonRecord = {};
  for (const [key, child] of Object.entries(value))
    result[key] = jsonValue(child, `${label}.${key}`);
  return result;
}

function jsonRecord(value: unknown, label: string): JsonRecord {
  const source = record(value, label);
  const result: JsonRecord = {};
  for (const [key, child] of Object.entries(source))
    result[key] = jsonValue(child, `${label}.${key}`);
  return result;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a string`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new TypeError(`${label} must be a finite number`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new TypeError(`${label} must be boolean`);
  return value;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function fieldRecord(
  value: Record<string, unknown>,
  key: string,
  label = key,
): Record<string, unknown> {
  return record(value[key], label);
}

function fieldString(
  value: Record<string, unknown>,
  key: string,
  label = key,
): string {
  return stringValue(value[key], label);
}

function fieldNumber(
  value: Record<string, unknown>,
  key: string,
  label = key,
): number {
  return numberValue(value[key], label);
}

function fieldBoolean(
  value: Record<string, unknown>,
  key: string,
  label = key,
): boolean {
  return booleanValue(value[key], label);
}

function fieldArray(
  value: Record<string, unknown>,
  key: string,
  label = key,
): unknown[] {
  return arrayValue(value[key], label);
}

function fieldOptionalString(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const item = value[key];
  if (item === null || item === undefined) return null;
  return stringValue(item, key);
}

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value?.trim())
    throw new Error(`${key} is required; no live test starts without it.`);
  return value;
}

function parseJsonRecord(text: string, label: string): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
  return jsonRecord(value, label);
}

function gitText(args: string[]): string {
  const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    result.stderr || `git ${args.join(" ")} failed`,
  );
  return result.stdout.trim();
}

function loadInstalledRuntime(): void {
  runtimeRoot = fs.realpathSync(requiredEnv("FMCAD_LIVE_RUNTIME_ROOT"));
  cliPath = path.join(runtimeRoot, "dist/bin/fmcad.js");
  assert.equal(
    fs.realpathSync(cliPath),
    cliPath,
    "CLI must resolve from the selected installed runtime.",
  );
  const distRoot = fs.realpathSync(path.join(runtimeRoot, "dist"));
  const runtimeRequire = createRequire(__filename);
  const runtimeModule = record(
    runtimeRequire(path.join(distRoot, "src/queue-instance.js")) as unknown,
    "installed queue runtime",
  );
  const buildHashFunction = runtimeModule["buildHash"];
  assert.ok(
    typeof buildHashFunction === "function",
    "Installed runtime has no buildHash function.",
  );
  const buildHash = stringValue(buildHashFunction(), "installed build hash");
  const installedIdentity = parseJsonRecord(
    fs.readFileSync(path.join(distRoot, "runtime-build.json"), "utf8"),
    "installed runtime identity",
  );
  assert.equal(buildHash, fieldString(installedIdentity, "fingerprint"));

  const catalogModule = record(
    runtimeRequire(path.join(distRoot, "src/catalog/index.js")) as unknown,
    "installed catalog",
  );
  const catalog = record(catalogModule["catalog"], "installed declarations");
  const contracts = record(catalogModule["contracts"], "installed contracts");
  const localInvocationFunction = catalogModule["localInvocation"];
  const validateCadFunction = catalogModule["validateCad"];
  assert.ok(typeof localInvocationFunction === "function");
  assert.ok(typeof validateCadFunction === "function");
  installedCatalog = {
    catalog: Object.fromEntries(
      Object.entries(catalog).map(([key, value]) => [
        key,
        jsonRecord(value, `catalog ${key}`),
      ]),
    ),
    contracts: Object.fromEntries(
      Object.entries(contracts).map(([key, value]) => [
        key,
        parseContract(key, value),
      ]),
    ),
    localInvocation: (input) =>
      Boolean(
        localInvocationFunction({
          operation: input.operation,
          data: input.data,
          preview: input.preview,
        }),
      ),
    validateCad: (operation, data) => validateCadFunction(operation, data),
  };
  const commandModule = record(
    runtimeRequire(path.join(distRoot, "src/commands.js")) as unknown,
    "installed command registry",
  );
  const findCommandFunction = commandModule["findCommand"];
  assert.ok(typeof findCommandFunction === "function");
  installedCommands = {
    findCommand: (argv) => {
      const route: unknown = findCommandFunction(argv);
      if (route === undefined) return undefined;
      const value = record(route, "installed command route");
      return {
        key: fieldString(value, "key"),
        target: fieldString(value, "target"),
        kind: fieldString(value, "kind"),
      };
    },
  };
  report.sourceCommit = gitText(["rev-parse", "HEAD"]);
  report.clientId = process.env["FMCAD_LIVE_CLIENT"] ?? "";
  report.runtime = {
    root: runtimeRoot,
    buildHash,
    catalogCount: Object.keys(catalog).length,
  };
  validateInstalledContracts();
}

function parseContract(operation: string, value: unknown): Contract {
  const source = record(value, `contract ${operation}`);
  const service = fieldRecord(source, "service", `${operation} service`);
  const requirements = fieldRecord(
    source,
    "requirements",
    `${operation} requirements`,
  );
  const cli = fieldRecord(source, "cli", `${operation} CLI route`);
  return {
    operation: fieldString(source, "operation"),
    declaration: jsonRecord(source["declaration"], `${operation} declaration`),
    service: {
      kind: enumValue(
        fieldString(service, "kind"),
        ["local", "coordinator", "python"],
        `${operation} service kind`,
      ),
      handler: fieldString(service, "handler"),
    },
    requirements: {
      sdk: enumValue(
        fieldString(requirements, "sdk"),
        ["none", "required", "conditional"],
        `${operation} SDK requirement`,
      ),
      document: fieldBoolean(requirements, "document"),
    },
    readOnlyRequested: fieldBoolean(source, "readOnlyRequested"),
    cli: {
      key: fieldString(cli, "key"),
      aliases: fieldArray(cli, "aliases").map((value) =>
        stringValue(value, `${operation} CLI alias`),
      ),
    },
  };
}

function enumValue<const Values extends readonly string[]>(
  value: string,
  allowed: Values,
  label: string,
): Values[number] {
  const selected = allowed.find((candidate) => candidate === value);
  if (selected === undefined)
    throw new Error(`${label} is not in the installed DTO union.`);
  return selected;
}

function isSketchOperation(value: string): value is Operation {
  return operationSet.has(value);
}

function validateInstalledContracts(): void {
  const runtimeCatalog = installedCatalog;
  if (!runtimeCatalog) throw new Error("Installed catalog is not loaded.");
  for (const operation of operations) {
    const contract: Contract | undefined = runtimeCatalog.contracts[operation];
    const declaration: JsonRecord | undefined =
      runtimeCatalog.catalog[operation];
    assert.ok(
      contract && declaration,
      `Installed runtime is missing ${operation}.`,
    );
    commandRoute(contract.cli.key, operation);
    assert.equal(
      contract.service.kind,
      "python",
      `${operation} must use the Fusion Python service.`,
    );
    assert.equal(
      contract.requirements.sdk,
      "required",
      `${operation} must require the SDK.`,
    );
    assert.equal(
      contract.requirements.document,
      true,
      `${operation} must be document-scoped.`,
    );
    assert.equal(
      contract.readOnlyRequested,
      readOnlyOperations.has(operation),
      operation,
    );
    const example = jsonRecord(declaration["example"], `${operation} example`);
    assert.equal(
      runtimeCatalog.localInvocation({
        operation,
        data: example,
        preview: false,
      }),
      false,
      `${operation} must not use a local/offline path.`,
    );
    runtimeCatalog.validateCad(operation, example);
  }
  for (const [key, target] of [
    ["active", "activeCmd"],
    ["doc list", "docListCmd"],
    ["doc new", "docNewCmd"],
    ["doc close", "docCloseCmd"],
  ] as const)
    commandRoute(key, target);
}

function persist(): void {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
    flag: "w",
  });
}

function markerRecords(stderr: string, prefix: string): JsonRecord[] {
  return stderr
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .map((line) => parseJsonRecord(line.slice(prefix.length), prefix));
}

function parseQueueReceipt(stderr: string): QueueReceipt | null {
  const requests = markerRecords(stderr, "FMCAD_QUEUE_REQUEST ");
  const jobs = markerRecords(stderr, "FMCAD_QUEUE_JOB ");
  const results = markerRecords(stderr, "FMCAD_QUEUE_RESULT ");
  if (requests.length === 0 && jobs.length === 0 && results.length === 0)
    return null;
  if (requests.length !== 1 || jobs.length !== 1 || results.length !== 1) {
    unknownExecution =
      requests.length > 0 || jobs.length > 0 || results.length > 0;
    throw new Error(
      "Queue request/job/result receipt set is incomplete; inspect, never retry.",
    );
  }
  const request = requests[0];
  const jobNotice = jobs[0];
  const result = results[0];
  assert.ok(request && jobNotice && result);
  const requestId = fieldString(request, "requestId");
  const clientId = fieldString(request, "clientId");
  const jobRequestId = fieldString(jobNotice, "requestId");
  const jobId = fieldString(jobNotice, "jobId");
  const resultId = fieldString(result, "id");
  const resultRequestId = fieldString(result, "requestId");
  const resultClientId = fieldString(result, "clientId");
  const expectedClientId = requiredEnv("FMCAD_LIVE_CLIENT");
  if (
    requestId !== jobRequestId ||
    jobId !== resultId ||
    requestId !== resultRequestId ||
    clientId !== expectedClientId ||
    resultClientId !== expectedClientId
  ) {
    unknownExecution = true;
    throw new Error(
      "Queue receipt identity mismatch; inspect the original request, never retry.",
    );
  }
  const state = fieldString(result, "state");
  if (!terminalStates.has(state)) {
    unknownExecution = true;
    throw new UnknownExecutionError(
      `Queue state ${state} is not terminal; inspect, never retry.`,
    );
  }
  let operationResult: OperationResult;
  try {
    operationResult = decodePublicResult(result["operationResult"]);
  } catch {
    unknownExecution = true;
    throw new UnknownExecutionError(
      "Queue terminal result has no valid typed operationResult; inspect, never retry.",
    );
  }
  if (
    operationResult.requestId !== requestId ||
    operationResult.jobId !== jobId
  ) {
    unknownExecution = true;
    throw new UnknownExecutionError(
      "Typed operationResult is not bound to the exact request/job; inspect, never retry.",
    );
  }
  if (
    operationResult.executionOutcome === "unknown" ||
    operationResult.executionOutcome === "active" ||
    operationResult.executionOutcome === "partial"
  ) {
    unknownExecution = true;
    throw new UnknownExecutionError(
      "Queue execution outcome is unknown or partial; inspect, never retry.",
    );
  }
  return { requestId, jobId, clientId, state, operationResult };
}

function command(
  commandKey: string,
  commandArgs: string[] = [],
  redactStdout = false,
  expectedTarget?: string,
): CliResult {
  const clientId = requiredEnv("FMCAD_LIVE_CLIENT");
  const route = commandRoute(commandKey, expectedTarget);
  const args = [...route.key.split(" "), ...commandArgs];
  const child = spawnSync(
    process.execPath,
    [
      cliPath,
      "--routing",
      "queue",
      "--client",
      clientId,
      ...args,
      "--timeout",
      "60000",
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 0,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        FMCAD_ROUTING: "queue",
        FMCAD_CLIENT: clientId,
        FMCAD_LIVE_ROUTING: "queue",
        FMCAD_LIVE_CLIENT: clientId,
        FMCAD_LIVE_SUITE: "sketch-operations",
      },
    },
  );
  const stdout = child.stdout ?? "";
  const stderr = child.stderr ?? "";
  const row: CommandEvidence = {
    args,
    exitCode: child.status,
    stdoutBytes: Buffer.byteLength(stdout),
    stdoutSha256: createHash("sha256").update(stdout).digest("hex"),
    stdout: redactStdout ? "[redacted document inventory]" : stdout,
    stderr,
    status: "not-validated",
  };
  if (child.signal) row.signal = child.signal;
  if (child.error) row.error = child.error.message;
  report.commands.push(row);
  persist();
  if (child.error || child.signal || child.status === null) {
    unknownExecution = true;
    row.status = "unknown";
    persist();
    throw new UnknownExecutionError(
      "CLI process outcome is indeterminate; inspect, never retry.",
    );
  }
  if (
    /EPOCH_CLIENT_NOT_GRANTED|NATIVE_FIXTURE_SCOPE_REQUIRED|BUILD_CHANGED|NATIVE_FIXTURE_CHANGED/u.test(
      stderr,
    )
  ) {
    blockedReason = stderr.trim();
    row.status = "blocked-before-dispatch";
    persist();
    throw new PreDispatchError(
      "Shared broker refused before a sketch method ran.",
    );
  }
  let receipt: QueueReceipt | null;
  try {
    receipt = parseQueueReceipt(stderr);
  } catch (error) {
    row.status = unknownExecution ? "unknown" : "invalid-receipt";
    persist();
    throw error;
  }
  if (!receipt) {
    row.status = "preflight-failed";
    persist();
    throw new PreDispatchError(
      child.status === 0
        ? "CLI returned without a shared-queue receipt; this is not native evidence."
        : stderr || stdout || "CLI failed before queue submission.",
    );
  }
  row.queue = receipt;
  if (receipt.operationResult.executionOutcome === "not_started") {
    blockedReason =
      receipt.operationResult.code ??
      "The original queue request did not start execution.";
    row.status = "not-dispatched";
    persist();
    throw new PreDispatchError(blockedReason);
  }
  if (
    receipt.state === "succeeded" &&
    receipt.operationResult.executionOutcome !== "succeeded"
  ) {
    unknownExecution = true;
    row.status = "unknown";
    persist();
    throw new UnknownExecutionError(
      "Successful queue state conflicts with its typed execution outcome; inspect, never retry.",
    );
  }
  if (
    receipt.state !== "succeeded" &&
    receipt.operationResult.executionOutcome === "succeeded"
  ) {
    unknownExecution = true;
    row.status = "unknown";
    persist();
    throw new UnknownExecutionError(
      "Failed queue state conflicts with successful operationResult; inspect, never retry.",
    );
  }
  if (
    receipt.operationResult.executionOutcome === "failed" &&
    receipt.operationResult.mayHaveMutated !== false
  ) {
    unknownExecution = true;
    row.status = "unknown";
    persist();
    throw new UnknownExecutionError(
      "Terminal failed execution may have mutated the owned document; inspect, never retry.",
    );
  }
  row.status =
    receipt.state === "succeeded" ? "terminal-success" : "terminal-failure";
  persist();
  return { row, stdout, stderr, receipt };
}

function commandRoute(
  commandKey: string,
  expectedTarget?: string,
): InstalledCommandRoute {
  if (!installedCommands)
    throw new Error("Installed command registry is not loaded.");
  const route = installedCommands.findCommand(commandKey.split(" "));
  if (!route)
    throw new Error(`Installed CLI does not generate route ${commandKey}.`);
  assert.equal(
    route.key,
    commandKey,
    `Installed CLI resolved an unexpected route for ${commandKey}.`,
  );
  if (expectedTarget !== undefined)
    assert.equal(
      route.target,
      expectedTarget,
      `Installed CLI route ${commandKey} targets the wrong operation.`,
    );
  return route;
}

function readDocumentList(): DocumentRow[] {
  const run = command("doc list", [], true, "docListCmd");
  assert.equal(run.row.exitCode, 0, run.stderr || run.stdout);
  assert.equal(run.receipt.state, "succeeded", run.stderr || run.stdout);
  assert.match(run.stdout, /(?:^|\r?\n)DONE(?:\r?\n|$)/u);
  return run.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("DOC "))
    .map((raw) => ({
      raw,
      name: fieldValue(raw, "name"),
      id: fieldValue(raw, "id"),
      creationId: fieldValue(raw, "creationId"),
      active:
        fieldValue(raw, "isActive") === null
          ? null
          : fieldValue(raw, "isActive") === "true",
    }));
}

function fieldValue(line: string, key: string): string | null {
  const pattern = new RegExp(
    `(?:^|\\s)${key}=(.*?)(?=\\s+(?:name|id|creationId|isActive|isModified|isSaved)=|$)`,
    "u",
  );
  return line.match(pattern)?.[1]?.trim() ?? null;
}

function stableDocument(row: DocumentRow): string {
  return row.raw
    .replace(/\s+isActive=(?:true|false)(?=\s|$)/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function stableRows(rows: readonly DocumentRow[]): string[] {
  return rows.map(stableDocument).sort();
}

function activeDocumentKey(rows: readonly DocumentRow[]): string | null {
  const active = rows.filter((row) => row.active === true);
  assert.ok(active.length <= 1, "Fusion listed multiple active documents.");
  if (rows.length > 0 && active.length !== 1)
    throw new Error(
      "Document inventory did not expose the active document; safe restore cannot be verified.",
    );
  const row = active[0];
  return row
    ? createHash("sha256").update(stableDocument(row)).digest("hex")
    : null;
}

function ownRows(rows: readonly DocumentRow[]): DocumentRow[] {
  return rows.filter(
    (row) =>
      row.name === documentName ||
      row.raw.startsWith(`DOC name=${documentName} `),
  );
}

function assertFusionIdle(): void {
  const run = command("active", [], false, "activeCmd");
  assert.equal(run.row.exitCode, 0, run.stderr || run.stdout);
  assert.equal(run.receipt.state, "succeeded", run.stderr || run.stdout);
  if (run.stdout.trim() === "NONE") return;
  const value = parseJsonRecord(run.stdout.trim(), "active command response");
  const active = value["activeCommand"];
  const commandId = isRecord(active) ? active["id"] : active;
  assert.ok(
    commandId === null ||
      commandId === undefined ||
      commandId === "" ||
      commandId === "SelectCommand",
    "Fusion has an interactive command active; stop before mutation or close.",
  );
}

function sketchReference(value: unknown, label: string): SketchReference {
  const ref = jsonRecord(value, label);
  assert.ok(
    fieldString(ref, "token", `${label}.token`).length > 0,
    `${label} token must not be empty.`,
  );
  return { ...ref, token: fieldString(ref, "token", `${label}.token`) };
}

function assertReadOnlyDispatch(operation: string): Contract {
  const runtimeCatalog = installedCatalog;
  if (!runtimeCatalog) throw new Error("Installed catalog is not loaded.");
  const contract: Contract | undefined = runtimeCatalog.contracts[operation];
  if (!contract)
    throw new Error(`Installed runtime does not expose ${operation}.`);
  return contract;
}

function invokeCad(
  operation: string,
  data: JsonRecord,
  options: { supportOnly?: boolean; docName?: string; pin?: boolean } = {},
): { result: JsonRecord; evidence: MethodEvidence } {
  const contract = assertReadOnlyDispatch(operation);
  const docName = options.docName ?? identity?.name ?? documentName;
  const pin = options.pin ?? true;
  assert.equal(
    contract.service.kind,
    "python",
    `${operation} must dispatch to Fusion Python.`,
  );
  assert.equal(
    contract.requirements.sdk,
    "required",
    `${operation} requires SDK dispatch.`,
  );
  assert.equal(
    contract.requirements.document,
    true,
    `${operation} must have a document scope.`,
  );
  if (isSketchOperation(operation)) {
    assert.equal(
      contract.readOnlyRequested,
      readOnlyOperations.has(operation),
      operation,
    );
  }
  const runtimeCatalog = installedCatalog;
  if (!runtimeCatalog) throw new Error("Installed catalog is not loaded.");
  assert.equal(
    runtimeCatalog.localInvocation({ operation, data, preview: false }),
    false,
    operation,
  );
  runtimeCatalog.validateCad(operation, data);
  if (pin && !identity)
    throw new Error(`${operation} requires the exact owned creationId.`);
  const invocation: CatalogInvocation = {
    version: 1,
    kind: "cad",
    operation,
    data,
    doc: docName,
    ...(pin && identity ? { docId: identity.creationId } : {}),
  };
  const commandArgs = ["--doc", invocation.doc ?? docName];
  if (invocation.docId) commandArgs.push("--doc-id", invocation.docId);
  commandArgs.push("--data", JSON.stringify(invocation.data), "--json");
  const run = command(contract.cli.key, commandArgs, false, operation);
  const execution = run.receipt.operationResult;
  if (execution.executionOutcome === "not_started") {
    blockedReason = execution.code ?? `${operation} did not start in Fusion.`;
    throw new PreDispatchError(blockedReason);
  }
  if (execution.executionOutcome === "failed") {
    if (execution.mayHaveMutated !== false) {
      unknownExecution = true;
      throw new UnknownExecutionError(
        `${operation} failed after possible mutation; inspect the owned document and never retry.`,
      );
    }
    throw new Error(
      `${operation} terminated without mutation: ${execution.code ?? "unspecified failure"}`,
    );
  }
  if (execution.executionOutcome !== "succeeded") {
    unknownExecution = true;
    throw new UnknownExecutionError(
      `${operation} has no settled successful execution result; inspect, never retry.`,
    );
  }
  let output: JsonRecord;
  try {
    output = parseJsonRecord(run.stdout, `${operation} response`);
  } catch {
    unknownExecution = true;
    throw new UnknownExecutionError(
      `${operation} has a settled queue receipt but no parseable method result; inspect, never retry.`,
    );
  }
  const responseOperation = fieldString(output, "operation");
  const responseDocument = fieldString(output, "document");
  const success = fieldBoolean(output, "success");
  const result = jsonRecord(output["result"], `${operation} result`);
  const evidence: MethodEvidence = {
    operation,
    status: "invoked",
    supportOnly: options.supportOnly ?? false,
    service: contract.service.kind,
    sdk: contract.requirements.sdk,
    readOnly: contract.readOnlyRequested,
    creationId: identity?.creationId ?? null,
    queue: run.receipt,
    result,
  };
  if (options.supportOnly) report.supportResults.push(evidence);
  else report.methodResults.push(evidence);
  persist();
  assert.equal(responseOperation, operation);
  assert.equal(responseDocument, docName);
  assert.equal(run.row.exitCode, 0, run.stderr || run.stdout);
  assert.equal(run.receipt.state, "succeeded", run.stderr || run.stdout);
  assert.equal(success, true, run.stdout);
  return { result, evidence };
}

function assertion(
  operation: string,
  label: string,
  actual: unknown,
  expected: unknown,
): void {
  const actualJson = jsonValue(actual, `${label} actual`);
  const expectedJson = jsonValue(expected, `${label} expected`);
  const passed = isDeepStrictEqual(actualJson, expectedJson);
  report.assertions.push({
    operation,
    label,
    actual: actualJson,
    expected: expectedJson,
    tolerance: 0,
    status: passed ? "pass" : "fail",
  });
  const method = [...report.methodResults]
    .reverse()
    .find((row) => row.operation === operation && row.status === "invoked");
  if (method) method.assertions = [...(method.assertions ?? []), label];
  persist();
  assert.ok(
    passed,
    `${label}: ${JSON.stringify({ actual: actualJson, expected: expectedJson })}`,
  );
}

function near(
  operation: string,
  label: string,
  actual: number,
  expected: number,
  tolerance = 1e-8,
): void {
  const passed =
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  const row: AssertionEvidence = {
    operation,
    label,
    actual,
    expected,
    tolerance,
    status: passed ? "pass" : "fail",
  };
  report.assertions.push(row);
  const method = [...report.methodResults]
    .reverse()
    .find((item) => item.operation === operation && item.status === "invoked");
  if (method) method.assertions = [...(method.assertions ?? []), label];
  persist();
  assert.ok(passed, JSON.stringify(row));
}

function validated(evidence: MethodEvidence, note: string): void {
  assert.ok(evidence, "Invocation evidence must exist before validation.");
  evidence.status = "pass";
  evidence.evidence = note;
  persist();
}

function group(name: string, action: () => void): boolean {
  try {
    action();
    report.tests.push({ name, status: "pass" });
    persist();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failure ??= error instanceof Error ? error : new Error(message);
    report.tests.push({
      name,
      status: unknownExecution ? "unknown" : blockedReason ? "blocked" : "fail",
      error: message,
    });
    persist();
    if (unknownExecution) throw error;
    return false;
  }
}

function createSketch(sketchName: string): void {
  const { result } = invokeCad(
    "sketch.create",
    { name: sketchName, plane: "XY" },
    { supportOnly: true },
  );
  const reference = sketchReference(result["sketch"], "created sketch");
  assertion(
    "sketch.create",
    "created sketch name is exact",
    reference["name"],
    sketchName,
  );
}

function addGeometry(
  sketchName: string,
  specs: JsonValue[],
): Record<string, SketchReference> {
  const { result } = invokeCad(
    "sketch.geometry",
    { sketch: sketchName, frame: "sketch", geometry: specs },
    { supportOnly: true },
  );
  const entities = fieldArray(result, "entities");
  assertion(
    "sketch.geometry",
    "native geometry entity count",
    entities.length,
    specs.length,
  );
  const refsRecord = record(result["refs"], "sketch geometry named refs");
  const refs: Record<string, SketchReference> = {};
  for (const spec of specs) {
    const specRecord = record(spec, "geometry specification");
    if (typeof specRecord["name"] === "string") {
      const key = specRecord["name"];
      refs[key] = sketchReference(refsRecord[key], `geometry ref ${key}`);
    }
  }
  return refs;
}

function inspectSketch(sketchName: string): JsonRecord {
  const { result } = invokeCad(
    "sketch.inspect",
    { sketch: sketchName },
    { supportOnly: true },
  );
  fieldArray(result, "curves");
  fieldArray(result, "points");
  fieldArray(result, "dimensions");
  return result;
}

function curveByToken(sketchName: string, ref: SketchReference): JsonRecord {
  const curves = fieldArray(inspectSketch(sketchName), "curves")
    .map((item) => record(item, "sketch curve"))
    .filter((curve) => curve["token"] === ref["token"]);
  assert.equal(
    curves.length,
    1,
    "sketch.inspect must return exactly the selected native curve.",
  );
  const curve = curves[0];
  assert.ok(curve);
  return jsonRecord(curve, "selected sketch curve");
}

function coordinateCheck(
  sketchName: string,
  expectations: JsonValue[],
  label: string,
): void {
  const { result, evidence } = invokeCad("sketch.coordinate-check", {
    schemaVersion: 1,
    sketch: sketchName,
    tolerance: "0.001 mm",
    expectations,
  });
  assertion(
    "sketch.coordinate-check",
    `${label} overall status`,
    result["status"],
    "pass",
  );
  assertion(
    "sketch.coordinate-check",
    `${label} geometry status`,
    result["geometryStatus"],
    "pass",
  );
  const analytic = fieldRecord(result, "analytic");
  const entities = fieldArray(analytic, "entities");
  assertion(
    "sketch.coordinate-check",
    `${label} expectation count`,
    entities.length,
    expectations.length,
  );
  for (const [index, value] of entities.entries()) {
    const entity = record(value, `${label} entity ${index}`);
    assertion(
      "sketch.coordinate-check",
      `${label} entity status`,
      entity["status"],
      "pass",
    );
    const checks = fieldArray(entity, "checks");
    assert.ok(
      checks.length > 0,
      `${label} must return native coordinate checks.`,
    );
    for (const checkValue of checks) {
      const check = record(checkValue, `${label} check`);
      assertion(
        "sketch.coordinate-check",
        `${label} ${fieldString(check, "check")} status`,
        check["status"],
        "pass",
      );
    }
  }
  validated(
    evidence,
    "Native sketch/model/world coordinates and model-to-sketch roundtrip passed.",
  );
}

function dimensionGroup(
  sketchNames: SketchSuite["sketchNames"],
  refs: Record<string, SketchReference>,
): void {
  const before = inspectSketch(sketchNames.dimension);
  const circleRef = refs["dimensionCircle"];
  const ellipseRef = refs["dimensionEllipse"];
  assert.ok(circleRef && ellipseRef);
  const { result: plan, evidence: planEvidence } = invokeCad(
    "sketch.dimension-plan",
    {
      schemaVersion: 1,
      sketch: sketchNames.dimension,
      entities: [circleRef, ellipseRef],
      maxEntities: 20,
    },
  );
  assertion(
    "sketch.dimension-plan",
    "read-only mutation flag",
    plan["mutation"],
    false,
  );
  assertion(
    "sketch.dimension-plan",
    "recognized circle and ellipse",
    fieldArray(plan, "recognized").length,
    2,
  );
  const planRecord = fieldRecord(plan, "plan");
  const proposals = fieldArray(planRecord, "proposals").map((value) =>
    record(value, "dimension proposal"),
  );
  assertion(
    "sketch.dimension-plan",
    "circle and ellipse size proposals",
    proposals.length,
    3,
  );
  const circleProposal = proposals.find((proposal) => {
    const data = fieldRecord(proposal, "data");
    const entities = fieldArray(data, "entities").map((value) =>
      record(value, "proposal entity"),
    );
    return (
      data["type"] === "radius" &&
      entities.some((entity) => entity["token"] === circleRef.token)
    );
  });
  assert.ok(
    circleProposal,
    "dimension-plan must include the circle radius proposal.",
  );
  const ellipseProposals = proposals.filter((proposal) => {
    const data = fieldRecord(proposal, "data");
    const entities = fieldArray(data, "entities").map((value) =>
      record(value, "proposal entity"),
    );
    return entities.some((entity) => entity["token"] === ellipseRef.token);
  });
  const ellipseTypes = ellipseProposals
    .map((proposal) => fieldString(fieldRecord(proposal, "data"), "type"))
    .sort();
  assertion(
    "sketch.dimension-plan",
    "ellipse major/minor radius proposals",
    ellipseTypes,
    ["majorRadius", "minorRadius"],
  );
  assertion(
    "sketch.dimension-plan",
    "proposal has explicit ID",
    typeof circleProposal["id"],
    "string",
  );

  const afterPlan = inspectSketch(sketchNames.dimension);
  assertion(
    "sketch.dimension-plan",
    "read-only curves unchanged",
    afterPlan["curves"],
    before["curves"],
  );
  assertion(
    "sketch.dimension-plan",
    "read-only points unchanged",
    afterPlan["points"],
    before["points"],
  );
  assertion(
    "sketch.dimension-plan",
    "read-only dimensions unchanged",
    afterPlan["dimensions"],
    before["dimensions"],
  );
  assertion(
    "sketch.dimension-plan",
    "plan added no dimensions",
    fieldArray(afterPlan, "dimensions").length,
    0,
  );
  validated(
    planEvidence,
    "Read-only native circle/ellipse recognition; no dimensions were added.",
  );

  const proposalId = fieldString(circleProposal, "id");
  const { result: applied, evidence: applyEvidence } = invokeCad(
    "sketch.dimension-apply",
    {
      sketch: sketchNames.dimension,
      plan: jsonRecord(planRecord, "dimension plan payload"),
      accept: [proposalId],
    },
  );
  assertion(
    "sketch.dimension-apply",
    "apply status",
    applied["status"],
    "pass",
  );
  const completed = fieldArray(applied, "completed").map((value) =>
    record(value, "completed dimension"),
  );
  assertion(
    "sketch.dimension-apply",
    "one reviewed proposal completed",
    completed.length,
    1,
  );
  const completion = completed[0];
  assert.ok(completion);
  assertion(
    "sketch.dimension-apply",
    "completed proposal ID",
    completion["id"],
    proposalId,
  );
  assertion(
    "sketch.dimension-apply",
    "solver conflicts",
    fieldArray(applied, "conflicts").length,
    0,
  );
  assertion(
    "sketch.dimension-apply",
    "accepted IDs left unapplied",
    fieldArray(applied, "notApplied").length,
    0,
  );
  const dimensionResult = fieldRecord(completion, "result");
  const proposalData = fieldRecord(circleProposal, "data");
  assertion(
    "sketch.dimension-apply",
    "native expression",
    dimensionResult["expression"],
    proposalData["expression"],
  );
  assert.ok(
    typeof dimensionResult["parameter"] === "string" &&
      dimensionResult["parameter"].length > 0,
  );
  const afterApply = inspectSketch(sketchNames.dimension);
  const dimensions = fieldArray(afterApply, "dimensions").map((value) =>
    record(value, "native dimension"),
  );
  assertion(
    "sketch.dimension-apply",
    "one driving dimension read back",
    dimensions.length,
    1,
  );
  const dimension = dimensions[0];
  assert.ok(dimension);
  assertion(
    "sketch.dimension-apply",
    "dimension expression readback",
    dimension["expression"],
    dimensionResult["expression"],
  );
  assertion(
    "sketch.dimension-apply",
    "dimension is driving",
    dimension["isDriving"],
    true,
  );
  validated(
    applyEvidence,
    "Only the selected circle radius proposal became a native driving dimension.",
  );

  const { result: replanned, evidence: replanEvidence } = invokeCad(
    "sketch.dimension-plan",
    {
      schemaVersion: 1,
      sketch: sketchNames.dimension,
      entities: [circleRef, ellipseRef],
      maxEntities: 20,
    },
  );
  const replan = fieldRecord(replanned, "plan");
  const remaining = fieldArray(replan, "proposals").map((value) =>
    record(value, "replanned proposal"),
  );
  const duplicateRadius = remaining.some((proposal) => {
    const data = fieldRecord(proposal, "data");
    return (
      data["type"] === "radius" &&
      fieldArray(data, "entities")
        .map((value) => record(value, "replanned entity"))
        .some((entity) => entity["token"] === circleRef.token)
    );
  });
  assertion(
    "sketch.dimension-plan",
    "applied radius is no longer proposed",
    duplicateRadius,
    false,
  );
  assertion(
    "sketch.dimension-plan",
    "remaining ellipse proposals",
    remaining.length,
    2,
  );
  validated(
    replanEvidence,
    "Replan recognized the applied native dimension without duplication.",
  );

  coordinateCheck(
    sketchNames.dimension,
    [
      {
        entity: circleRef,
        frame: "sketch",
        center: ["-20 mm", "0 mm", "0 mm"],
        radius: "5 mm",
      },
      {
        entity: circleRef,
        frame: "model",
        center: ["-20 mm", "0 mm", "0 mm"],
        diameter: "10 mm",
      },
      {
        entity: ellipseRef,
        frame: "sketch",
        center: ["20 mm", "0 mm", "0 mm"],
      },
    ],
    "dimension local/model coordinates",
  );
  const inspected = inspectSketch(sketchNames.dimension);
  const ellipse = fieldArray(inspected, "curves")
    .map((value) => record(value, "inspected curve"))
    .find((curve) => curve["token"] === ellipseRef.token);
  assert.ok(ellipse, "Ellipse must remain in native inspection.");
  const ellipseGeometry = fieldRecord(ellipse, "geometry");
  near(
    "sketch.dimension-apply",
    "ellipse major radius mm",
    fieldNumber(ellipseGeometry, "majorRadius") * 10,
    8,
    0.001,
  );
  near(
    "sketch.dimension-apply",
    "ellipse minor radius mm",
    fieldNumber(ellipseGeometry, "minorRadius") * 10,
    4,
    0.001,
  );
}

function mirrorGroup(
  sketchNames: SketchSuite["sketchNames"],
  refs: Record<string, SketchReference>,
): void {
  const mirrorSeed = refs["mirrorSeed"];
  const mirrorAxis = refs["mirrorAxis"];
  assert.ok(mirrorSeed && mirrorAxis);
  const { result, evidence } = invokeCad("sketch.mirror", {
    sketch: sketchNames.operations,
    entities: [mirrorSeed],
    line: mirrorAxis,
  });
  const entities = fieldArray(result, "entities");
  assertion(
    "sketch.mirror",
    "one native mirrored primitive",
    entities.length,
    1,
  );
  assertion(
    "sketch.mirror",
    "one native symmetry constraint",
    fieldArray(result, "constraints").length,
    1,
  );
  const mirroredValue = entities[0];
  assert.ok(mirroredValue);
  const mirrored = sketchReference(mirroredValue, "mirrored entity");
  coordinateCheck(
    sketchNames.operations,
    [
      {
        entity: mirrorSeed,
        frame: "sketch",
        center: ["5 mm", "15 mm", "0 mm"],
        radius: "2 mm",
      },
      {
        entity: mirrored,
        frame: "model",
        center: ["-5 mm", "15 mm", "0 mm"],
        radius: "2 mm",
      },
    ],
    "mirror source/reflected geometry",
  );
  const curve = curveByToken(sketchNames.operations, mirrored);
  const geometry = fieldRecord(curve, "geometry");
  assertion(
    "sketch.mirror",
    "mirrored analytic type",
    geometry["type"],
    "Circle3D",
  );
  near(
    "sketch.mirror",
    "mirrored circle radius mm",
    fieldNumber(geometry, "radius") * 10,
    2,
    0.001,
  );
  validated(
    evidence,
    "Reflected center/radius and native symmetry relation read back.",
  );
}

function offsetGroup(
  sketchNames: SketchSuite["sketchNames"],
  refs: Record<string, SketchReference>,
): void {
  const offsetSeed = refs["offsetSeed"];
  assert.ok(offsetSeed);
  const { result, evidence } = invokeCad("sketch.offset", {
    sketch: sketchNames.operations,
    entities: [offsetSeed],
    distance: "2 mm",
  });
  const entities = fieldArray(result, "entities");
  assertion("sketch.offset", "one native child curve", entities.length, 1);
  assert.ok(isRecord(result["constraint"]));
  const parameter = result["offsetParameter"];
  evidence.offsetParameter = typeof parameter === "string" ? parameter : null;
  const childValue = entities[0];
  assert.ok(childValue);
  const child = curveByToken(
    sketchNames.operations,
    sketchReference(childValue, "offset child"),
  );
  const geometry = fieldRecord(child, "geometry");
  assertion("sketch.offset", "child analytic type", geometry["type"], "Line3D");
  const endpoints: Array<[number, number, number]> = [
    toMillimetreVector(geometry["startPoint"], "offset start point"),
    toMillimetreVector(geometry["endPoint"], "offset end point"),
  ].sort((a, b) => a[1] - b[1]);
  const expected: ReadonlyArray<readonly [number, number, number]> = [
    [22, 10, 0],
    [22, 20, 0],
  ];
  for (const [index, point] of endpoints.entries()) {
    const target = expected[index];
    assert.ok(target);
    for (const axis of [0, 1, 2] as const)
      near(
        "sketch.offset",
        `positive right-side endpoint ${index} ${"xyz"[axis]} mm`,
        point[axis],
        target[axis],
        0.001,
      );
  }
  validated(
    evidence,
    "Positive offset moved the upward source line to its right; native child endpoints read back.",
  );
}

function patternGroup(
  sketchNames: SketchSuite["sketchNames"],
  refs: Record<string, SketchReference>,
): void {
  const circularSeed = refs["patternCircularSeed"];
  const patternCenter = refs["patternCenter"];
  const rectangularSeed = refs["patternRectSeed"];
  const direction = refs["patternDirection"];
  assert.ok(circularSeed && patternCenter && rectangularSeed && direction);
  const circular = invokeCad("sketch.pattern", {
    sketch: sketchNames.operations,
    type: "circular",
    entities: [circularSeed],
    center: patternCenter,
    quantity: 4,
    angle: "360 deg",
  });
  assert.ok(isRecord(circular.result["constraint"]));
  const rectangular = invokeCad("sketch.pattern", {
    sketch: sketchNames.operations,
    type: "rectangular",
    entities: [rectangularSeed],
    direction,
    quantity: 3,
    distance: "10 mm",
    distanceType: "spacing",
  });
  assert.ok(isRecord(rectangular.result["constraint"]));
  const inspected = inspectSketch(sketchNames.operations);
  const circles = fieldArray(inspected, "curves")
    .map((value) => record(value, "pattern curve"))
    .map((curve) => ({
      curve,
      geometry: isRecord(curve["geometry"]) ? curve["geometry"] : {},
    }))
    .filter(
      ({ geometry }) =>
        typeof geometry["radius"] === "number" &&
        Math.abs(geometry["radius"] - 0.1) <= 1e-8,
    );
  assertion(
    "sketch.pattern",
    "circular and rectangular native instance count",
    circles.length,
    7,
  );
  const expected = [
    [5, 45, 0],
    [-35, 5, 0],
    [5, -35, 0],
    [45, 5, 0],
    [55, 45, 0],
    [65, 45, 0],
    [75, 45, 0],
  ];
  const remaining = circles.map(({ geometry }) =>
    vector3(geometry["center"], "pattern center").map((value) => value * 10),
  );
  for (const wanted of expected) {
    const index = remaining.findIndex((actual) =>
      actual.every((value, axis) => Math.abs(value - wanted[axis]!) <= 0.001),
    );
    assert.notEqual(
      index,
      -1,
      `Pattern is missing expected native center ${JSON.stringify(wanted)}.`,
    );
    const found = remaining.splice(index, 1)[0];
    assert.ok(found);
    assertion("sketch.pattern", "native pattern center xyz mm", found, wanted);
  }
  assertion(
    "sketch.pattern",
    "no unexpected pattern instances",
    remaining.length,
    0,
  );
  validated(
    circular.evidence,
    "Native circular pattern constraint and generated instances read back.",
  );
  validated(
    rectangular.evidence,
    "Native rectangular pattern constraint and generated instances read back.",
  );
}

function projectGroup(
  sketchNames: SketchSuite["sketchNames"],
  refs: Record<string, SketchReference>,
): void {
  const sourceCircle = refs["projectSourceCircle"];
  assert.ok(sourceCircle);
  const { result, evidence } = invokeCad("sketch.project", {
    sketch: sketchNames.projectTarget,
    entities: [sourceCircle],
    linked: true,
  });
  const entities = fieldArray(result, "entities");
  assertion(
    "sketch.project",
    "one projected native entity",
    entities.length,
    1,
  );
  const projectedValue = entities[0];
  assert.ok(projectedValue);
  const projected = sketchReference(projectedValue, "projected entity");
  coordinateCheck(
    sketchNames.projectTarget,
    [
      {
        entity: projected,
        frame: "sketch",
        center: ["-30 mm", "-25 mm", "0 mm"],
        radius: "3 mm",
      },
      {
        entity: projected,
        frame: "world",
        center: ["-30 mm", "-25 mm", "0 mm"],
      },
    ],
    "linked projection local/world geometry",
  );
  const curve = curveByToken(sketchNames.projectTarget, projected);
  const geometry = fieldRecord(curve, "geometry");
  assertion(
    "sketch.project",
    "projected analytic type",
    geometry["type"],
    "Circle3D",
  );
  near(
    "sketch.project",
    "projected circle radius mm",
    fieldNumber(geometry, "radius") * 10,
    3,
    0.001,
  );
  validated(
    evidence,
    "Linked projected circle center/radius read back in target sketch and world frame.",
  );
}

function transformGroup(
  sketchNames: SketchSuite["sketchNames"],
  refs: Record<string, SketchReference>,
): void {
  const transformSeed = refs["transformSeed"];
  assert.ok(transformSeed);
  const { result, evidence } = invokeCad("sketch.transform", {
    sketch: sketchNames.operations,
    entities: [transformSeed],
    frame: "sketch",
    rotate: { angle: "90 deg", center: ["0 mm", "0 mm", "0 mm"] },
    translate: ["-5 mm", "5 mm", "0 mm"],
  });
  assertion(
    "sketch.transform",
    "solver transform status",
    result["status"],
    "pass",
  );
  assertion(
    "sketch.transform",
    "native transform success",
    result["success"],
    true,
  );
  const before = fieldRecord(result, "before");
  const after = fieldRecord(result, "after");
  assert.ok(Array.isArray(before["points"]) && Array.isArray(after["points"]));
  assert.notDeepEqual(
    before["points"],
    after["points"],
    "Transform must move native sketch points.",
  );
  coordinateCheck(
    sketchNames.operations,
    [
      {
        entity: transformSeed,
        frame: "sketch",
        center: ["-15 mm", "90 mm", "0 mm"],
        radius: "2 mm",
      },
      {
        entity: transformSeed,
        frame: "model",
        center: ["-15 mm", "90 mm", "0 mm"],
      },
    ],
    "rotation-then-translation local/model geometry",
  );
  const transformed = curveByToken(sketchNames.operations, transformSeed);
  const geometry = fieldRecord(transformed, "geometry");
  const center = vector3(geometry["center"], "transformed circle center");
  near("sketch.transform", "transformed x mm", center[0] * 10, -15, 0.001);
  near("sketch.transform", "transformed y mm", center[1] * 10, 90, 0.001);
  validated(
    evidence,
    "Before/after solver state and independent sketch/model coordinate readback passed.",
  );
}

function checkGroup(sketchNames: SketchSuite["sketchNames"]): void {
  const { result, evidence } = invokeCad("sketch.check", {
    sketch: sketchNames.operations,
  });
  assertion("sketch.check", "native check status", result["status"], "pass");
  assertion("sketch.check", "native solver health", result["healthState"], 0);
  assertion("sketch.check", "closed profile count", result["profileCount"], 10);
  assertion(
    "sketch.check",
    "underconstraint list is disclosed",
    Array.isArray(result["underconstrainedPoints"]),
    true,
  );
  validated(
    evidence,
    "Fusion solver health, ten closed profiles, and underconstraint read back.",
  );
}

function vector3(value: unknown, label: string): [number, number, number] {
  const values = arrayValue(value, label);
  assert.equal(values.length, 3, `${label} must contain xyz.`);
  return [
    numberValue(values[0], `${label}.x`),
    numberValue(values[1], `${label}.y`),
    numberValue(values[2], `${label}.z`),
  ];
}

function toMillimetreVector(
  value: unknown,
  label: string,
): [number, number, number] {
  const [x, y, z] = vector3(value, label);
  return [x * 10, y * 10, z * 10];
}

function inventory(rows: readonly DocumentRow[]): InventorySnapshot {
  const stable = stableRows(rows);
  return {
    count: rows.length,
    stableSha256: createHash("sha256").update(stable.join("\n")).digest("hex"),
    activeSha256: activeDocumentKey(rows),
    ownDocumentCount: ownRows(rows).length,
  };
}

function createOwnedDocument(): void {
  const before = readDocumentList();
  baselineStable = stableRows(before);
  baselineActive = activeDocumentKey(before);
  report.inventory.before = inventory(before);
  assert.equal(
    ownRows(before).length,
    0,
    "Random synthetic document name already exists.",
  );
  assertFusionIdle();

  const created = command(
    "doc new",
    ["--name", documentName],
    false,
    "docNewCmd",
  );
  assert.equal(created.row.exitCode, 0, created.stderr || created.stdout);
  assert.equal(created.receipt.state, "succeeded");
  const afterCreate = readDocumentList();
  assertOtherDocumentsPreserved(afterCreate);
  const own = ownRows(afterCreate);
  assert.equal(
    own.length,
    1,
    "doc new must create exactly one synthetic document.",
  );
  assert.equal(own[0]?.active, true, "New synthetic document must be active.");

  const { result: status } = invokeCad(
    "document.status",
    {},
    { supportOnly: true, docName: documentName, pin: false },
  );
  assert.equal(fieldString(status, "name"), documentName);
  const creationId = fieldString(status, "creationId");
  assert.match(creationId, /^[0-9a-f-]{36}$/iu);
  const saved = fieldBoolean(status, "saved");
  const modified = fieldBoolean(status, "modified");
  const fileId = fieldOptionalString(status, "fileId");
  assert.equal(saved, false);
  assert.equal(modified, false);
  assert.equal(fileId, null);
  identity = { name: documentName, creationId };
  report.document = {
    name: identity.name,
    creationId,
    savedBefore: saved,
    modifiedBefore: modified,
    fileIdBefore: fileId,
  };
  report.inventory.afterCreate = inventory(afterCreate);
  persist();
}

function guardOwned(): JsonRecord {
  assert.ok(identity, "No exact test document identity.");
  const { result: status } = invokeCad(
    "document.status",
    {},
    { supportOnly: true },
  );
  assertion(
    "document.status",
    "name remains the owned name",
    status["name"],
    identity.name,
  );
  assertion(
    "document.status",
    "creationId remains exact",
    status["creationId"],
    identity.creationId,
  );
  assertion(
    "document.status",
    "owned document remains unsaved",
    status["saved"],
    false,
  );
  assertion(
    "document.status",
    "owned document has no cloud file",
    status["fileId"],
    null,
  );
  const rows = readDocumentList();
  assertOtherDocumentsPreserved(rows);
  const own = ownRows(rows);
  assert.equal(own.length, 1, "Exact test document must be uniquely open.");
  if (own[0]?.creationId !== null && own[0]?.creationId !== undefined)
    assert.equal(own[0].creationId, identity.creationId);
  assert.equal(
    own[0]?.active,
    true,
    "Test document must be active before CAD work or close.",
  );
  return status;
}

function assertOtherDocumentsPreserved(rows: readonly DocumentRow[]): void {
  const remaining = stableRows(rows.filter((row) => !ownRows([row]).length));
  for (const expected of baselineStable) {
    const index = remaining.indexOf(expected);
    assert.notEqual(
      index,
      -1,
      "A pre-existing document changed or disappeared.",
    );
    remaining.splice(index, 1);
  }
}

function setupSketches(): SketchSuite {
  guardOwned();
  const sketchNames = {
    dimension: `${fixturePrefix}_Dimension`,
    operations: `${fixturePrefix}_Operations`,
    projectSource: `${fixturePrefix}_ProjectSource`,
    projectTarget: `${fixturePrefix}_ProjectTarget`,
  };
  for (const sketchName of Object.values(sketchNames)) createSketch(sketchName);
  const refs = {
    ...addGeometry(sketchNames.dimension, [
      {
        type: "circle",
        name: "dimensionCircle",
        center: ["-20 mm", "0 mm", "0 mm"],
        radius: "5 mm",
      },
      {
        type: "ellipse",
        name: "dimensionEllipse",
        center: ["20 mm", "0 mm", "0 mm"],
        majorRadius: "8 mm",
        minorRadius: "4 mm",
      },
    ]),
    ...addGeometry(sketchNames.operations, [
      {
        type: "line",
        name: "mirrorAxis",
        start: ["0 mm", "10 mm", "0 mm"],
        end: ["0 mm", "20 mm", "0 mm"],
      },
      {
        type: "circle",
        name: "mirrorSeed",
        center: ["5 mm", "15 mm", "0 mm"],
        radius: "2 mm",
      },
      {
        type: "line",
        name: "offsetSeed",
        start: ["20 mm", "10 mm", "0 mm"],
        end: ["20 mm", "20 mm", "0 mm"],
      },
      { type: "point", name: "patternCenter", point: ["5 mm", "5 mm", "0 mm"] },
      {
        type: "circle",
        name: "patternCircularSeed",
        center: ["5 mm", "45 mm", "0 mm"],
        radius: "1 mm",
      },
      {
        type: "circle",
        name: "patternRectSeed",
        center: ["55 mm", "45 mm", "0 mm"],
        radius: "1 mm",
      },
      {
        type: "line",
        name: "patternDirection",
        start: ["0 mm", "70 mm", "0 mm"],
        end: ["10 mm", "70 mm", "0 mm"],
      },
      {
        type: "circle",
        name: "transformSeed",
        center: ["85 mm", "10 mm", "0 mm"],
        radius: "2 mm",
      },
    ]),
    ...addGeometry(sketchNames.projectSource, [
      {
        type: "circle",
        name: "projectSourceCircle",
        center: ["-30 mm", "-25 mm", "0 mm"],
        radius: "3 mm",
      },
    ]),
  };
  report.sketchNames = sketchNames;
  report.fixtureRefs = Object.keys(refs);
  persist();
  return { sketchNames, refs };
}

function cleanupOwnedDocument(): void {
  if (!identity || unknownExecution) return;
  guardOwned();
  assertFusionIdle();
  const closed = command("doc close", ["--discard"], false, "docCloseCmd");
  assert.equal(closed.row.exitCode, 0, closed.stderr || closed.stdout);
  assert.equal(
    closed.receipt.state,
    "succeeded",
    closed.stderr || closed.stdout,
  );
  report.fixtureClosed = true;
  report.cleanup =
    "Closed only the exact new unsaved test document with --discard; no save/cloud operation.";
  const after = readDocumentList();
  assert.equal(
    ownRows(after).length,
    0,
    "Owned synthetic document remains open after close.",
  );
  assertOtherDocumentsPreserved(after);
  assert.equal(
    activeDocumentKey(after),
    baselineActive,
    "Original active document was not restored.",
  );
  report.inventory.after = inventory(after);
  report.inventory.userDocumentsUnchanged = true;
  persist();
}

function runOperations(suite: SketchSuite): void {
  guardOwned();
  group("dimension-plan/apply", () =>
    dimensionGroup(suite.sketchNames, suite.refs),
  );
  if (!unknownExecution && !blockedReason)
    group("mirror", () => mirrorGroup(suite.sketchNames, suite.refs));
  if (!unknownExecution && !blockedReason)
    group("offset", () => offsetGroup(suite.sketchNames, suite.refs));
  if (!unknownExecution && !blockedReason)
    group("pattern", () => patternGroup(suite.sketchNames, suite.refs));
  if (!unknownExecution && !blockedReason)
    group("project", () => projectGroup(suite.sketchNames, suite.refs));
  if (!unknownExecution && !blockedReason)
    group("transform", () => transformGroup(suite.sketchNames, suite.refs));
  if (!unknownExecution && !blockedReason)
    group("check", () => checkGroup(suite.sketchNames));
}

function finalize(): void {
  if (!unknownExecution && identity) {
    try {
      cleanupOwnedDocument();
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error));
      report.cleanup =
        "cleanup-failed; inspect only the exact owned document; do not close another document";
      report.cleanupError = failure.message;
    }
  }
  report.operationCoverage = operations.map((operation) => {
    const rows = report.methodResults.filter(
      (item) => item.operation === operation,
    );
    const contract = installedCatalog?.contracts[operation];
    return {
      operation,
      canonical: true,
      test: "tests/live-sketch-operations.ts",
      service: contract?.service.kind ?? "python",
      sdk: contract?.requirements.sdk ?? "required",
      invocations: rows.length,
      status:
        rows.length > 0 && rows.every((item) => item.status === "pass")
          ? "pass"
          : unknownExecution
            ? "unknown"
            : blockedReason
              ? "blocked"
              : "not-passed",
      evidence: rows.map((item) => item.evidence ?? null),
    };
  });
  const complete = report.operationCoverage.every(
    (entry) => entry["status"] === "pass",
  );
  report.tests.push({
    name: "all-existing-sketch-operations",
    status:
      complete && !failure && report.fixtureClosed
        ? "pass"
        : unknownExecution
          ? "unknown"
          : blockedReason
            ? "blocked"
            : "fail",
  });
  report.finishedAt = new Date().toISOString();
  persist();
  console.log(`REPORT ${reportPath}`);
  if (!complete || failure || !report.fixtureClosed) {
    console.error(
      `FAIL sketch live suite: ${failure?.message ?? blockedReason ?? "native coverage or owned-document cleanup is incomplete"}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`PASS native sketch operations: ${operations.join(", ")}`);
  }
}

function localCheck(): void {
  loadInstalledRuntime();
  console.log(
    "OFFLINE CHECK PASS; nine installed operations require Fusion SDK; no broker request was sent.",
  );
}

function runLive(): void {
  assert.ok(
    process.argv.includes("--run"),
    "Explicit --run is required; no document is created otherwise.",
  );
  requiredEnv("FMCAD_LIVE_CLIENT");
  assert.equal(
    fs.existsSync(reportPath),
    false,
    "Report path already exists; preserve it and do not replay this suite.",
  );
  persist();
  try {
    loadInstalledRuntime();
    assertFusionIdle();
    createOwnedDocument();
    runOperations(setupSketches());
  } catch (error) {
    failure ??= error instanceof Error ? error : new Error(String(error));
    report.tests.push({
      name: "sketch-operations-initialization",
      status: unknownExecution ? "unknown" : blockedReason ? "blocked" : "fail",
      error: failure.message,
    });
  }
  finalize();
}

if (process.argv.includes("--check")) localCheck();
else runLive();
