// Opt-in live coverage for the existing versioned data-import operations.
// All writes are confined to one exact, unsaved document created by this run.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";
import {
  assertActiveDocumentRestored,
  assertProtectedBaselineDocuments,
  asArray,
  asRecord,
  parsePublicQueueJob,
  parseWorkerResultReadback,
  type LiveDocumentSnapshot,
  type LiveDocumentState,
  type JsonRecord,
  type PublicQueueJob,
  type QueueOutputDescriptor,
  type WorkerResultReadback,
} from "./live-import-receipts.js";

interface DocumentIdentity extends LiveDocumentState {}
interface ToolResponse {
  failed: boolean;
  text: string;
}
interface BackendPort {
  callTool(request: JsonRecord): Promise<ToolResponse>;
}
interface QueueClientPort {
  call(name: string, input: JsonRecord): Promise<unknown>;
  dispose(): void;
  dir: string;
}
interface LiveBrokerModule {
  spawnSync(
    command: string,
    args: string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ): SpawnSyncReturns<string>;
  createBackend(
    config: JsonRecord,
    dependencies: { command: boolean },
  ): BackendPort;
  disposeBackend(client: BackendPort): void;
  fixture(name: string, creationId?: string): void;
}
interface RuntimeConfig extends JsonRecord {
  backend: string;
  transport: string;
  timeoutMs: number;
}
interface QueueClientModule {
  QueueClient: new (
    clientId: string | undefined,
    options: { cfg: RuntimeConfig; existingCredentialsOnly?: boolean },
  ) => QueueClientPort;
  inputFiles(argv: string[], cwd: string): string[];
}
interface RuntimeConfigModule {
  loadConfig(options: { routing: "queue" }): unknown;
}
interface QueueResponseFilesModule {
  readOwnedResult(
    root: string,
    binding: { jobId: string; cwd: string },
    artifact: JsonRecord,
    limit: number,
  ): Buffer;
}
interface ParameterReadback extends JsonRecord {
  name: string;
  expression: string;
  unit?: string;
  value: number;
}
interface CatalogInstance extends JsonRecord {
  id: string;
  occurrence: EntityReference;
  item?: string;
  parent?: string | null;
  componentName?: string;
}
interface EntityReference extends JsonRecord {
  path?: string;
}
interface PlacementPose extends JsonRecord {
  status: string;
  actual: number[];
}
interface FailureResult extends JsonRecord {
  error: string;
  mutationMayHaveOccurred?: boolean;
}
interface ParameterResult extends JsonRecord {
  parameters: ParameterReadback[];
}
interface CatalogImportResult extends JsonRecord {
  instances: CatalogInstance[];
  idMap: Record<string, CatalogIdMapEntry>;
}
interface CatalogCheckResult extends JsonRecord {
  differences: unknown[];
  instances: CatalogInstance[];
}
interface PlacementResult extends JsonRecord {
  poses: PlacementPose[];
}
interface CotsReplacementResult extends JsonRecord {
  replacements: Array<
    { before: EntityReference; after: EntityReference } & JsonRecord
  >;
  datumChecks: Array<{ status: string } & JsonRecord>;
  unresolved: Array<{ id: string; field: string; status: string } & JsonRecord>;
}
interface EntityInspectResult extends JsonRecord {
  kind: string;
  occurrencePath: string;
}
interface ComponentResult extends JsonRecord {
  component: { name: string } & JsonRecord;
  bodies: EntityReference[];
}
interface ComponentCreateResult extends JsonRecord {
  component: { name: string } & JsonRecord;
}
interface ShapeResult extends JsonRecord {
  bodies: EntityReference[];
}
interface VolumeResult extends JsonRecord {
  value: number;
}
interface ExportResult extends JsonRecord {
  exists: boolean;
  bytes: number;
}
interface EntityListResult extends JsonRecord {
  entities: Array<{ path: string } & JsonRecord>;
}
interface GenericResult extends JsonRecord {}
interface OperationResultMap {
  "param.import": ParameterResult;
  "param.inspect": ParameterResult;
  "catalog.import": CatalogImportResult;
  "catalog.check": CatalogCheckResult;
  "placement.import": PlacementResult;
  "placement.check": PlacementResult;
  "cots.replace": CotsReplacementResult;
  "entity.inspect": EntityInspectResult;
  "component.inspect": ComponentResult;
  "component.create": ComponentCreateResult;
  "shape.box": ShapeResult;
  "measure.volume": VolumeResult;
  "export.step": ExportResult;
  "entity.list": EntityListResult;
  "document.status": GenericResult;
}
type DataOperationResult =
  OperationResultMap[Operation] | FailureResult | GenericResult;
interface CadCliOutput<
  T extends JsonRecord = DataOperationResult & JsonRecord,
> extends JsonRecord {
  success: boolean;
  status?: string;
  result: T;
  document?: string;
  documentIdentity?: { creationId?: string } | null;
  method?: string;
  modelValidated?: boolean;
  mutation?: boolean;
  error?: string;
  workerEvidence?: { receipt: PublicQueueJob; workerOutput: WorkerOutput };
}
interface WorkerOutput {
  stdout: string | null;
  stderr: string | null;
  descriptors: Record<string, QueueOutputDescriptor> | null;
}
interface CatalogIdMapEntry extends JsonRecord {
  definition: string;
}
interface CallReport extends JsonRecord {
  label: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  stdout: string;
  stderr: string;
  queueSummary?: PublicQueueJob;
  workerReceipt?: PublicQueueJob;
  workerReadback?: WorkerResultReadback;
  workerOutput?: WorkerOutput;
  receiptStatus?: string;
  methodOutput?: CadCliOutput;
  output?: JsonRecord;
  negativeEvidence?: JsonRecord;
}
interface CliInvocation {
  process: SpawnSyncReturns<string>;
  call: CallReport;
  receipt?: WorkerResultReadback;
}
interface NegativeCase extends JsonRecord {
  id: string;
  operation: string;
  status: string;
  expectedWorker: string;
  expectedAfterState: string;
  workerReceipt?: PublicQueueJob;
  workerOutput?: WorkerOutput;
  methodOutput?: DataOperationResult;
  afterReadback?: unknown;
  mutationMayHaveOccurred?: boolean | null;
}
interface ReportTest extends JsonRecord {
  name: string;
  status: string;
  evidence?: unknown;
  error?: string;
}
interface LiveReport extends JsonRecord {
  suite: string;
  startedAt: string;
  name: string;
  owner: string;
  artifactRoot: string;
  status: string;
  scope: string;
  tests: ReportTest[];
  calls: CallReport[];
  nativeNegativeCases: NegativeCase[];
  syntheticCatalog?: string;
  runtimeRoot?: string;
  runtimeBuildHash?: string;
  backend?: string;
  transport?: string;
  clientId?: string;
  before?: LiveDocumentSnapshot;
  afterCreation?: LiveDocumentSnapshot;
  owned?: DocumentIdentity;
  after?: LiveDocumentSnapshot;
  cleanup?: JsonRecord;
  error?: string;
  cleanupError?: string;
  finishedAt?: string;
}
const operationNames = [
  "param.import",
  "param.inspect",
  "catalog.import",
  "catalog.check",
  "placement.import",
  "placement.check",
  "cots.replace",
  "entity.inspect",
  "component.inspect",
  "component.create",
  "shape.box",
  "measure.volume",
  "export.step",
  "entity.list",
  "document.status",
] as const;
type Operation = (typeof operationNames)[number];
interface OperationMetadata {
  readOnly: boolean;
  dataImport?: boolean;
}
interface CadOptions {
  component?: string;
  native?: boolean;
  expect?: "pass" | "blocked" | "unknown" | "local-pass" | "local-unknown";
}
interface CliOptions {
  queue?: boolean;
}
interface AcceptedJobSummary {
  jobId: string;
  requestId: string;
}

const root = path.resolve(__dirname, "..", "..");
const runtimeRequire = createRequire(__filename);
const liveBroker = runtimeRequire(
  path.join(root, "tests/helpers/live-broker.js"),
) as LiveBrokerModule;
const runtimeConfigModule = runtimeRequire(
  path.join(root, "src/config.js"),
) as RuntimeConfigModule;
const queueClientModule = runtimeRequire(
  path.join(root, "src/queue-client.js"),
) as QueueClientModule;
const queueResponseFiles = runtimeRequire(
  path.join(root, "src/queue-response-files.js"),
) as QueueResponseFilesModule;
const cadModule = runtimeRequire(path.join(root, "src/cad.js")) as unknown;
const publicCatalog = asRecord(
  asRecord(cadModule, "CAD module")["catalog"],
  "Public CAD operation catalog",
);
const operationMeta = Object.fromEntries(
  operationNames.map((operation) => {
    const entry = asRecord(
      publicCatalog[operation],
      `Public operation ${operation}`,
    );
    assert.equal(
      typeof entry["readOnly"],
      "boolean",
      `${operation}.readOnly must be boolean`,
    );
    assert.ok(
      entry["dataImport"] === undefined ||
        typeof entry["dataImport"] === "boolean",
      `${operation}.dataImport must be boolean when present`,
    );
    return [
      operation,
      {
        readOnly: entry["readOnly"] as boolean,
        ...(entry["dataImport"] === true ? { dataImport: true } : {}),
      },
    ];
  }),
) as Record<Operation, OperationMetadata>;
if (!process.argv.includes("--run"))
  throw new Error(
    "Explicit --run is required; this suite creates and mutates one owned scratch document.",
  );
const clientId = requiredEnvironment("FMCAD_LIVE_CLIENT");
const selectedRuntime = selectInstalledRuntime();
const suffix = randomUUID().replaceAll("-", "_");
const name = "FMCAD_DATA_IMPORT_" + suffix;
const owner = "fmcad-live-data-import-" + suffix;
const artifactParent = path.join(root, ".test-artifacts");
fs.mkdirSync(artifactParent, { recursive: true });
const artifactRoot = fs.mkdtempSync(
  path.join(artifactParent, "live-data-import-"),
);
const stepPath = path.join(artifactRoot, "synthetic-replacement.step");
const reportPath = path.join(artifactRoot, "report.json");
const report: LiveReport = {
  suite: "data-import",
  startedAt: new Date().toISOString(),
  name,
  owner,
  artifactRoot,
  status: "running",
  scope:
    "One new unsaved test document and synthetic JSON/STEP only under its owned artifact root; no user/vendor files, cloud saves, or preference changes.",
  tests: [],
  calls: [],
  nativeNegativeCases: [
    {
      id: "param-invalid-dependency",
      operation: "param.import",
      status: "NOTRUN",
      expectedWorker: "failed/failed/LOCAL_EXECUTION_FAILED",
      expectedAfterState:
        "Complete native user-parameter readback equals the pre-call snapshot; candidate and invalid parameter are absent.",
    },
    {
      id: "catalog-duplicate-import",
      operation: "catalog.import",
      status: "NOTRUN",
      expectedWorker: "failed/failed/LOCAL_EXECUTION_FAILED",
      expectedAfterState:
        "Native catalog.check remains pass with no differences and the three occurrence references are unchanged.",
    },
    {
      id: "placement-duplicate-path",
      operation: "placement.import",
      status: "NOTRUN",
      expectedWorker: "failed/failed/LOCAL_EXECUTION_FAILED",
      expectedAfterState:
        "Native placement.check remains pass and the assembly root transform is unchanged at 25 mm.",
    },
    {
      id: "cots-wrong-revision",
      operation: "cots.replace",
      status: "NOTRUN",
      expectedWorker: "failed/failed/LOCAL_EXECUTION_FAILED",
      expectedAfterState:
        "The exact old occurrence path and native component body list are unchanged.",
    },
  ],
};
let client: BackendPort | undefined;
let receiptClient: QueueClientPort | undefined;
let identity: DocumentIdentity | null = null;
let baseline: LiveDocumentSnapshot | null = null;
let unsafe = false;
let importedCatalogInstances: CatalogInstance[] | null = null;
let importedCatalogIdMap: Record<string, CatalogIdMapEntry> | null = null;

function saveReport() {
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
}

function ownedDocument(): DocumentIdentity {
  assert.ok(identity, "No verified owned document identity");
  return identity;
}

function originalDocuments(): LiveDocumentSnapshot {
  assert.ok(baseline, "Protected document baseline has not been captured");
  return baseline;
}

function isOperation(value: string): value is Operation {
  return Object.hasOwn(operationMeta, value);
}

function requiredItem<T>(
  values: readonly T[],
  index: number,
  label: string,
): T {
  const value = values[index];
  assert.ok(value, `${label}[${index}] is missing`);
  return value;
}

function workerEvidenceFor(output: CadCliOutput): {
  receipt: PublicQueueJob;
  workerOutput: WorkerOutput;
} {
  assert.ok(
    output.workerEvidence,
    "Method result has no retained worker evidence",
  );
  return output.workerEvidence;
}

function importedInstances(): CatalogInstance[] {
  assert.ok(importedCatalogInstances, "Catalog import has not been read back");
  return importedCatalogInstances;
}

function importedIdMap(): Record<string, CatalogIdMapEntry> {
  assert.ok(importedCatalogIdMap, "Catalog import has not returned an id map");
  return importedCatalogIdMap;
}

function parseJsonOutput(
  result: Pick<SpawnSyncReturns<string>, "stdout" | "stderr" | "error">,
  label: string,
): CadCliOutput {
  const text = (result.stdout || "").trim();
  try {
    return parseCadCliOutput(JSON.parse(text) as unknown, label);
  } catch (_) {
    for (const line of text.split(/\r?\n/).reverse()) {
      if (!line.startsWith("{")) continue;
      try {
        return parseCadCliOutput(JSON.parse(line) as unknown, label);
      } catch (_) {
        /* try the preceding output line */
      }
    }
  }
  throw new Error(
    `${label} did not return JSON: ${result.stderr || text || result.error?.message}`,
  );
}

function parseCadCliOutput(value: unknown, label: string): CadCliOutput {
  const row = asRecord(value, `${label} output`);
  assert.equal(
    typeof row["success"],
    "boolean",
    `${label}.success must be boolean`,
  );
  const result =
    row["result"] === undefined
      ? {}
      : asRecord(row["result"], `${label}.result`);
  let documentIdentity: { creationId?: string } | null | undefined;
  if (row["documentIdentity"] === null) documentIdentity = null;
  else if (row["documentIdentity"] !== undefined) {
    const identityRow = asRecord(
      row["documentIdentity"],
      `${label}.documentIdentity`,
    );
    assert.ok(
      identityRow["creationId"] === undefined ||
        typeof identityRow["creationId"] === "string",
    );
    documentIdentity =
      typeof identityRow["creationId"] === "string"
        ? { creationId: identityRow["creationId"] }
        : {};
  }
  return {
    success: row["success"] as boolean,
    ...(typeof row["status"] === "string" ? { status: row["status"] } : {}),
    result: result as DataOperationResult,
    ...(typeof row["document"] === "string"
      ? { document: row["document"] }
      : {}),
    ...(documentIdentity === null
      ? { documentIdentity: null }
      : documentIdentity
        ? { documentIdentity }
        : {}),
    ...(typeof row["method"] === "string" ? { method: row["method"] } : {}),
    ...(typeof row["modelValidated"] === "boolean"
      ? { modelValidated: row["modelValidated"] }
      : {}),
    ...(typeof row["mutation"] === "boolean"
      ? { mutation: row["mutation"] }
      : {}),
    ...(typeof row["error"] === "string" ? { error: row["error"] } : {}),
  };
}

function requireArray(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

function validateOperationResult(
  operation: Operation,
  expectation: CadOptions["expect"],
  result: JsonRecord,
): void {
  if (expectation === "blocked") {
    assert.equal(
      typeof result["error"],
      "string",
      `${operation} failure must include its native error`,
    );
    return;
  }
  if (expectation === "local-pass" || expectation === "local-unknown") return;

  if (operation === "param.import" || operation === "param.inspect") {
    for (const [index, value] of requireArray(
      result["parameters"],
      `${operation}.parameters`,
    ).entries()) {
      const row = asRecord(value, `${operation}.parameters[${index}]`);
      assert.equal(typeof row["name"], "string");
      assert.equal(typeof row["expression"], "string");
      assert.equal(typeof row["value"], "number");
    }
  } else if (operation === "catalog.import" || operation === "catalog.check") {
    const instances = requireArray(
      result["instances"],
      `${operation}.instances`,
    );
    for (const [index, value] of instances.entries()) {
      const row = asRecord(value, `${operation}.instances[${index}]`);
      assert.equal(typeof row["id"], "string");
      asRecord(
        row["occurrence"],
        `${operation}.instances[${index}].occurrence`,
      );
    }
    if (operation === "catalog.import") {
      const idMap = asRecord(result["idMap"], "catalog.import.idMap");
      for (const [id, value] of Object.entries(idMap)) {
        const entry = asRecord(value, `catalog.import.idMap.${id}`);
        assert.equal(typeof entry["definition"], "string");
      }
    } else requireArray(result["differences"], "catalog.check.differences");
  } else if (
    operation === "placement.import" ||
    operation === "placement.check"
  ) {
    for (const [index, value] of requireArray(
      result["poses"],
      `${operation}.poses`,
    ).entries()) {
      const row = asRecord(value, `${operation}.poses[${index}]`);
      assert.equal(typeof row["status"], "string");
      const actual = requireArray(
        row["actual"],
        `${operation}.poses[${index}].actual`,
      );
      assert.ok(
        actual.every(
          (value) => typeof value === "number" && Number.isFinite(value),
        ),
        `${operation}.poses[${index}].actual must contain finite numbers`,
      );
    }
  } else if (operation === "cots.replace") {
    for (const [index, value] of requireArray(
      result["replacements"],
      "cots.replace.replacements",
    ).entries()) {
      const row = asRecord(value, `cots.replace.replacements[${index}]`);
      asRecord(row["before"], `cots.replace.replacements[${index}].before`);
      asRecord(row["after"], `cots.replace.replacements[${index}].after`);
    }
    requireArray(result["datumChecks"], "cots.replace.datumChecks");
    requireArray(result["unresolved"], "cots.replace.unresolved");
  } else if (operation === "entity.inspect") {
    assert.equal(typeof result["kind"], "string");
    assert.equal(typeof result["occurrencePath"], "string");
  } else if (operation === "component.inspect") {
    const component = asRecord(
      result["component"],
      "component.inspect.component",
    );
    assert.equal(typeof component["name"], "string");
    requireArray(result["bodies"], "component.inspect.bodies");
  } else if (operation === "component.create") {
    const component = asRecord(
      result["component"],
      "component.create.component",
    );
    assert.equal(typeof component["name"], "string");
  } else if (operation === "shape.box")
    requireArray(result["bodies"], "shape.box.bodies");
  else if (operation === "measure.volume") {
    const value = result["value"];
    assert.equal(typeof value, "number");
    assert.ok(Number.isFinite(value));
  } else if (operation === "export.step") {
    assert.equal(typeof result["exists"], "boolean");
    assert.equal(typeof result["bytes"], "number");
  } else if (operation === "entity.list") {
    for (const [index, value] of requireArray(
      result["entities"],
      "entity.list.entities",
    ).entries()) {
      assert.equal(
        typeof asRecord(value, `entity.list.entities[${index}]`)["path"],
        "string",
      );
    }
  }
}

function parseDocumentSnapshot(
  value: unknown,
  label: string,
): LiveDocumentSnapshot {
  const row = asRecord(value, label);
  const documents = asArray(row["documents"], `${label}.documents`).map(
    (entry, index) => {
      const document = asRecord(entry, `${label}.documents[${index}]`);
      assert.equal(typeof document["creationId"], "string");
      assert.equal(typeof document["name"], "string");
      assert.equal(typeof document["saved"], "boolean");
      assert.equal(typeof document["modified"], "boolean");
      assert.ok(
        document["fileId"] === null || typeof document["fileId"] === "string",
      );
      return {
        creationId: document["creationId"] as string,
        name: document["name"] as string,
        saved: document["saved"] as boolean,
        modified: document["modified"] as boolean,
        fileId: document["fileId"] as string | null,
      };
    },
  );
  const identities = new Set<string>();
  for (const document of documents) {
    assert.ok(
      !identities.has(document.creationId),
      `${label} contains duplicate creationId ${document.creationId}`,
    );
    identities.add(document.creationId);
  }
  assert.ok(
    row["activeCreationId"] === null ||
      typeof row["activeCreationId"] === "string",
    `${label}.activeCreationId must be a creationId or null`,
  );
  if (typeof row["activeCreationId"] === "string")
    assert.ok(
      identities.has(row["activeCreationId"]),
      `${label}.activeCreationId does not identify an open document`,
    );
  return {
    documents,
    activeCreationId: row["activeCreationId"] as string | null,
  };
}

function parseRuntimeConfig(value: unknown): RuntimeConfig {
  const loaded = asRecord(value, "Runtime configuration result");
  const cfg = asRecord(loaded["cfg"], "Runtime configuration cfg");
  assert.equal(typeof cfg["backend"], "string");
  assert.equal(typeof cfg["transport"], "string");
  assert.equal(typeof cfg["timeoutMs"], "number");
  return cfg as RuntimeConfig;
}

function selectInstalledRuntime(): {
  root: string;
  buildHash: string;
  cliPath: string;
} {
  const selected = requiredEnvironment("FMCAD_LIVE_RUNTIME_ROOT");
  const runtimeRoot = fs.realpathSync(selected);
  const manifestPath = path.join(runtimeRoot, "dist/runtime-build.json");
  const manifest = asRecord(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown,
    "Installed runtime build manifest",
  );
  const buildHash = manifest["fingerprint"];
  assert.ok(typeof buildHash === "string");
  assert.match(buildHash, /^[a-f0-9]{64}$/);
  const cliPath = path.join(runtimeRoot, "dist/bin/fmcad.js");
  assert.equal(
    fs.realpathSync(cliPath),
    cliPath,
    "Installed CLI path must be canonical",
  );
  return { root: runtimeRoot, buildHash, cliPath };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

async function script(body: string, readOnly = true): Promise<JsonRecord> {
  const request = {
    featureType: "script",
    object: {
      readOnly,
      script:
        "import adsk.core, json\ndef run(_context: str):\n" +
        body
          .split("\n")
          .map((line) => "    " + line)
          .join("\n"),
    },
  };
  assert.ok(client, "Backend client is not initialized");
  let out: ToolResponse;
  try {
    out = await client.callTool(request);
  } catch (error) {
    unsafe = true;
    throw error;
  }
  if (out.failed) {
    unsafe = true;
    throw new Error(out.text || "Read-only Fusion observation failed");
  }
  try {
    return asRecord(JSON.parse(out.text) as unknown, "Fusion observation");
  } catch (error) {
    unsafe = true;
    throw new Error(
      `Fusion observation was not JSON: ${errorMessage(error)}; ${out.text}`,
    );
  }
}

async function state() {
  const current = await script(`app = adsk.core.Application.get()
documents = [dict(creationId=d.creationId, name=d.name, saved=d.isSaved, modified=d.isModified,
                  fileId=d.dataFile.id if d.isSaved and d.dataFile else None)
             for d in app.documents]
print(json.dumps(dict(documents=sorted(documents, key=lambda d: d['creationId']),
                      activeCreationId=app.activeDocument.creationId if app.activeDocument else None)))`);
  return parseDocumentSnapshot(current, "Fusion document inventory");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required`);
  return value;
}

async function ownedState(): Promise<LiveDocumentSnapshot> {
  const own = ownedDocument();
  const current = await state();
  const owned = current.documents.filter(
    (doc) => doc.creationId === own.creationId,
  );
  assert.equal(
    owned.length,
    1,
    "Owned document disappeared or became ambiguous",
  );
  const found = owned[0];
  assert.ok(found);
  assert.equal(found.name, name, "Owned document name changed");
  assert.equal(found.saved, false, "Owned document was unexpectedly saved");
  assert.equal(
    found.fileId,
    null,
    "Owned document unexpectedly acquired a cloud file identity",
  );
  assert.equal(
    current.activeCreationId,
    own.creationId,
    "The exact owned document is not active",
  );
  return current;
}

async function guard(): Promise<LiveDocumentSnapshot> {
  const current = await ownedState();
  assertProtectedBaselineDocuments(
    originalDocuments(),
    current,
    "During the owned fixture lifecycle",
  );
  return current;
}

async function cli(
  args: string[],
  label: string,
  options: CliOptions = {},
): Promise<CliInvocation> {
  const result = liveBroker.spawnSync(
    process.execPath,
    [selectedRuntime.cliPath, ...args],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 75000,
    },
  );
  const call: CallReport = {
    label,
    args,
    exitCode: result.status,
    signal: result.signal,
    ...(result.error?.message ? { error: result.error.message } : {}),
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
  report.calls.push(call);
  saveReport();
  if (result.error || result.signal || result.status === null) unsafe = true;
  if (options.queue === false) return { process: result, call };

  const jobLines = call.stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith("FMCAD_QUEUE_JOB "));
  const terminalLines = call.stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith("FMCAD_QUEUE_RESULT "));
  if (jobLines.length !== 1 || terminalLines.length !== 1 || !receiptClient) {
    unsafe = true;
    call.receiptStatus = "missing-or-ambiguous-terminal-receipt";
    saveReport();
    throw new Error(
      `${label} did not produce exactly one terminal shared-broker receipt.`,
    );
  }
  let jobSummary: AcceptedJobSummary;
  let terminalSummary: PublicQueueJob;
  try {
    const acceptedLine = jobLines[0];
    const terminalLine = terminalLines[0];
    assert.ok(acceptedLine && terminalLine);
    const acceptedValue = asRecord(
      JSON.parse(acceptedLine.slice("FMCAD_QUEUE_JOB ".length)) as unknown,
      `${label} accepted job`,
    );
    assert.equal(typeof acceptedValue["jobId"], "string");
    assert.equal(typeof acceptedValue["requestId"], "string");
    jobSummary = {
      jobId: acceptedValue["jobId"] as string,
      requestId: acceptedValue["requestId"] as string,
    };
    terminalSummary = parsePublicQueueJob(
      JSON.parse(terminalLine.slice("FMCAD_QUEUE_RESULT ".length)) as unknown,
      `${label} terminal receipt`,
    );
  } catch (error) {
    unsafe = true;
    throw new Error(
      `${label} returned a malformed broker receipt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    jobSummary.jobId !== terminalSummary.id ||
    jobSummary.requestId !== terminalSummary.requestId
  ) {
    unsafe = true;
    throw new Error(
      `${label} terminal receipt does not match its accepted job/request identity.`,
    );
  }
  let workerReadback: WorkerResultReadback;
  try {
    workerReadback = parseWorkerResultReadback(
      await receiptClient.call("result", { jobId: jobSummary.jobId }),
      `${label} worker result`,
    );
  } catch (error) {
    unsafe = true;
    throw new Error(
      `${label} original worker receipt cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const worker = workerReadback.job;
  if (
    !worker ||
    worker.id !== jobSummary.jobId ||
    worker.requestId !== jobSummary.requestId ||
    worker.clientId !== process.env["FMCAD_LIVE_CLIENT"] ||
    worker.state !== terminalSummary.state ||
    worker.executionOutcome !== terminalSummary.executionOutcome ||
    !isDeepStrictEqual(worker.operationResult, terminalSummary.operationResult)
  ) {
    unsafe = true;
    throw new Error(
      `${label} public broker receipt differs from the CLI terminal receipt.`,
    );
  }
  if (
    !["succeeded", "failed"].includes(worker.state) ||
    worker.executionOutcome !== worker.state ||
    worker.operationResult["executionOutcome"] !== worker.state
  ) {
    unsafe = true;
    call.receiptStatus = "execution-outcome-not-settled";
    saveReport();
    throw new Error(
      `${label} did not produce a known terminal execution outcome.`,
    );
  }
  call.queueSummary = terminalSummary;
  call.workerReceipt = worker;
  call.workerReadback = workerReadback;
  const workerText = (key: "stdout" | "stderr"): string | null => {
    if (typeof workerReadback[key] === "string") return workerReadback[key];
    const descriptor = workerReadback.outputs?.[key];
    if (!descriptor) return null;
    const artifact = asRecord(
      descriptor.artifact ?? descriptor,
      `${label} ${key} output artifact`,
    );
    if (artifact.name !== `${key}.txt`)
      throw new Error(`${label} returned an unexpected ${key} artifact name.`);
    assert.ok(receiptClient);
    return queueResponseFiles
      .readOwnedResult(
        receiptClient.dir,
        { jobId: worker.id, cwd: root },
        artifact,
        128 * 1024 * 1024,
      )
      .toString("utf8");
  };
  call.workerOutput = {
    stdout: workerText("stdout"),
    stderr: workerText("stderr"),
    descriptors: workerReadback.outputs ?? null,
  };
  const workerOutput = call.workerOutput;
  assert.ok(workerOutput);
  if (
    label !== "doc new" &&
    !workerOutput.stdout &&
    !workerOutput.descriptors?.["stdout"]
  ) {
    unsafe = true;
    call.receiptStatus = "terminal-receipt-has-no-worker-output";
    saveReport();
    throw new Error(`${label} terminal receipt has no retained worker output.`);
  }
  saveReport();
  return { process: result, call, receipt: workerReadback };
}

function cad<O extends Operation>(
  operation: O,
  data: JsonRecord,
  options: CadOptions & { expect: "blocked" },
): Promise<CadCliOutput<FailureResult>>;
function cad<O extends Operation>(
  operation: O,
  data: JsonRecord,
  options: CadOptions & { expect: "local-pass" | "local-unknown" },
): Promise<CadCliOutput<GenericResult>>;
function cad<O extends Operation>(
  operation: O,
  data: JsonRecord,
  options: CadOptions & { expect: "pass" | "unknown" },
): Promise<CadCliOutput<OperationResultMap[O]>>;
function cad<O extends Operation>(
  operation: O,
  data?: JsonRecord,
  options?: CadOptions,
): Promise<CadCliOutput<OperationResultMap[O]>>;
async function cad(
  operation: Operation,
  data: JsonRecord = {},
  options: CadOptions = {},
): Promise<CadCliOutput> {
  const metadata = operationMeta[operation];
  if (metadata.readOnly !== true) await guard();
  const own = ownedDocument();
  const args = [
    ...operation.split("."),
    "--doc",
    name,
    "--doc-id",
    own.creationId,
    "--data",
    JSON.stringify(data),
    "--json",
    "--timeout",
    "60000",
  ];
  if (options.component) args.push("--component", options.component);
  const invocation = await cli(args, operation, {
    queue: options.native !== false,
  });
  const result = invocation.process;
  const output = parseJsonOutput(result, operation);
  validateOperationResult(
    operation,
    options.expect,
    asRecord(output.result, `${operation} result`),
  );
  invocation.call.methodOutput = output;
  invocation.call.output = {
    success: output.success,
    status: output.status ?? output.result["status"],
    document: output.document,
    documentIdentity: output.documentIdentity,
    error: output.result["error"] || output["error"],
  };
  const status = output.status ?? output.result["status"];
  saveReport();

  if (options.expect === "pass") {
    assert.equal(
      result.status,
      0,
      `${operation}: ${result.stderr || result.stdout}`,
    );
    assert.equal(
      output.success,
      true,
      `${operation} wrapper did not report success`,
    );
    assert.equal(status, "pass", `${operation} returned ${status}, not pass`);
    assertWorkerState(invocation.call, "succeeded", "succeeded");
  } else if (options.expect === "blocked") {
    assert.equal(
      result.status,
      1,
      `${operation} rejection must return a determinate CLI failure`,
    );
    assert.equal(result.signal, null, `${operation} rejection ended by signal`);
    assert.equal(
      output.success,
      false,
      `${operation} rejection was represented as success`,
    );
    assert.equal(
      status,
      "blocked",
      `${operation} expected a blocked result, got ${status}`,
    );
    assert.ok(
      output.result["error"],
      `${operation} blocked result has no reason`,
    );
    assertExpectedFailedWorker(invocation.call, operation);
  } else if (options.expect === "unknown") {
    assert.equal(
      result.status,
      1,
      `${operation} unknown result must not exit as success`,
    );
    assert.equal(
      result.signal,
      null,
      `${operation} unknown result ended by signal`,
    );
    assert.equal(
      output.success,
      false,
      `${operation} unknown outcome was represented as success`,
    );
    assert.equal(
      status,
      "unknown",
      `${operation} expected an explicit unknown result, got ${status}`,
    );
    assertWorkerTerminal(invocation.call);
  } else if (options.expect === "local-pass") {
    assert.equal(
      result.status,
      0,
      `${operation} local preflight failed: ${result.stderr || result.stdout}`,
    );
    assert.equal(output.success, true);
    assert.equal(status, "pass");
    assert.equal(
      output.documentIdentity,
      null,
      "Local preflight unexpectedly claimed a live document identity",
    );
    assert.equal(output.method, "CLI data preflight");
    assert.equal(
      output.modelValidated,
      false,
      "Local preflight claimed native model validation",
    );
    assert.equal(output.mutation, false);
  } else if (options.expect === "local-unknown") {
    assert.equal(
      result.status,
      1,
      `${operation} unknown local check must not exit as success`,
    );
    assert.equal(
      result.signal,
      null,
      `${operation} local check ended by signal`,
    );
    assert.equal(
      output.success,
      true,
      `${operation} local result should not claim a native failure`,
    );
    assert.equal(
      status,
      "unknown",
      `${operation} without observations must remain unknown`,
    );
    assert.equal(
      output.documentIdentity,
      null,
      "Local preflight unexpectedly claimed a live document identity",
    );
    assert.equal(output.method, "CLI data preflight");
    assert.equal(
      output.modelValidated,
      false,
      "Local preflight claimed native model validation",
    );
    assert.equal(output.mutation, false);
  } else {
    assert.equal(
      result.status,
      0,
      `${operation}: ${result.stderr || result.stdout}`,
    );
    assert.equal(
      output.success,
      true,
      `${operation} wrapper did not report success`,
    );
    if (options.native !== false)
      assertWorkerState(invocation.call, "succeeded", "succeeded");
  }
  if (options.native !== false)
    assert.equal(
      output.document,
      name,
      `${operation} ran against the wrong document`,
    );
  if (options.native !== false && metadata.dataImport) {
    assert.equal(
      output.documentIdentity?.creationId,
      own.creationId,
      `${operation} returned evidence for the wrong document identity`,
    );
  }
  if (invocation.call.workerReceipt) {
    assert.ok(invocation.call.workerOutput);
    output.workerEvidence = {
      receipt: invocation.call.workerReceipt,
      workerOutput: invocation.call.workerOutput,
    };
  }
  return output;
}

function assertWorkerTerminal(call: CallReport): PublicQueueJob {
  const receipt = call.workerReceipt;
  assert.ok(receipt, `${call.label} has no retained original worker receipt`);
  assert.ok(
    ["succeeded", "failed"].includes(receipt.state),
    `${call.label} worker outcome is not terminal: ${receipt.state}`,
  );
  assert.equal(
    receipt.executionOutcome,
    receipt.state,
    `${call.label} worker execution outcome differs from its terminal state`,
  );
  assert.equal(
    receipt.operationResult["executionOutcome"],
    receipt.state,
    `${call.label} public operationResult does not identify the terminal worker outcome`,
  );
  assert.equal(
    receipt.operationResult["code"],
    receipt.code,
    `${call.label} public operationResult code differs from the terminal worker DTO`,
  );
  const workerOutput = call.workerOutput;
  assert.ok(
    workerOutput?.stdout || workerOutput?.descriptors?.["stdout"],
    `${call.label} original broker-owned worker output was not retained`,
  );
  return receipt;
}

function assertWorkerState(
  call: CallReport,
  state: string,
  executionOutcome: string,
): PublicQueueJob {
  const receipt = assertWorkerTerminal(call);
  assert.equal(receipt.state, state, `${call.label} worker state`);
  assert.equal(
    receipt.executionOutcome,
    executionOutcome,
    `${call.label} worker execution outcome`,
  );
  return receipt;
}

function assertExpectedFailedWorker(
  call: CallReport,
  operation: Operation,
): void {
  const receipt = assertWorkerState(call, "failed", "failed");
  assert.equal(
    receipt.code,
    "LOCAL_EXECUTION_FAILED",
    `${operation} negative must be the terminal operation failure, not an unrelated pipeline error`,
  );
  assert.ok(call.workerOutput);
  const output = call.workerOutput;
  const workerOutput = parseJsonOutput(
    { stdout: output.stdout || "", stderr: output.stderr || "" },
    operation + " original worker output",
  );
  assert.deepEqual(
    workerOutput,
    call.methodOutput,
    `${operation} wrapper result differs from the original broker-owned worker output`,
  );
  call.negativeEvidence = {
    status: "terminal-failed-worker-receipt",
    jobId: receipt.id,
    requestId: receipt.requestId,
    code: receipt.code,
    workerOutput: call.workerOutput,
  };
  saveReport();
}

function recordNegativeAfterState(
  id: string,
  failedResult: CadCliOutput,
  afterReadback: unknown,
): void {
  const negative = report.nativeNegativeCases.find((row) => row.id === id);
  assert.ok(negative, `Unregistered native negative case: ${id}`);
  assert.equal(
    negative.status,
    "NOTRUN",
    `${id} was already recorded; do not replay it`,
  );
  assert.equal(failedResult.workerEvidence?.receipt?.state, "failed");
  assert.equal(
    failedResult.workerEvidence?.receipt?.executionOutcome,
    "failed",
  );
  assert.ok(failedResult.workerEvidence);
  negative.status = "verified-terminal-failed-worker-plus-readback";
  negative.workerReceipt = failedResult.workerEvidence.receipt;
  negative.workerOutput = failedResult.workerEvidence.workerOutput;
  negative.methodOutput = failedResult.result;
  negative.afterReadback = afterReadback;
  negative.mutationMayHaveOccurred =
    failedResult.result["mutationMayHaveOccurred"] === true
      ? true
      : failedResult.result["mutationMayHaveOccurred"] === false
        ? false
        : null;
  saveReport();
}

async function test(
  label: string,
  fn: () => Promise<unknown>,
  status = "passed",
): Promise<void> {
  const row: ReportTest = { name: label, status: "running" };
  report.tests.push(row);
  saveReport();
  try {
    row.evidence = await fn();
    row.status = status;
  } catch (error) {
    row.status = "failed";
    row.error = errorStack(error);
    saveReport();
    throw error;
  }
  saveReport();
  console.log(`${row.status.toUpperCase()} ${label}`);
}

const identityRotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const pose = (frame: string, x = 0) => ({
  frame,
  translation: [`${x} mm`, "0 mm", "0 mm"],
  rotation: identityRotation,
});
const source = "Owned synthetic Fusion fixture";
const topId = "synthetic-assembly";
const childId = "synthetic-part";
const sensorId = "synthetic-cots";
const topName = "FMCAD_DI_" + suffix + "_Assembly";
const childName = "FMCAD_DI_" + suffix + "_Part";
const sensorName = "FMCAD_DI_" + suffix + "_Sensor";
const replacementName = sensorName + " [cots-r2]";
const parameterA = "di_" + suffix + "_width";
const parameterB = "di_" + suffix + "_double";
const parameterCandidate = "di_" + suffix + "_preflight_candidate";
const parameterBad = "di_" + suffix + "_bad_dependency";
const catalogData = {
  version: 1,
  owner,
  revision: "catalog-r1",
  records: [
    {
      id: topId,
      name: topName,
      kind: "assembly",
      quantity: 1,
      parent: null,
      placement: pose("parent", 10),
      status: "CONFIRMED",
      source,
    },
    {
      id: childId,
      name: childName,
      kind: "part",
      quantity: 1,
      parent: topId,
      placement: pose("parent", 0),
      status: "CONFIRMED",
      source,
    },
    {
      id: sensorId,
      name: sensorName,
      kind: "purchased",
      quantity: 1,
      parent: null,
      placement: pose("parent", 0),
      mass: { value: 3, unit: "g", status: "ESTIMATED", source },
      status: "CONFIRMED",
      source,
    },
  ],
};
const catalogPath = path.join(artifactRoot, "synthetic-catalog.json");
fs.writeFileSync(
  catalogPath,
  JSON.stringify({ records: catalogData.records }, null, 2) + "\n",
  { flag: "wx", mode: 0o600 },
);
const catalogFileData = {
  version: 1,
  owner,
  revision: catalogData.revision,
  source: catalogPath,
  schema: { recordsPath: "records" },
};
report.syntheticCatalog = catalogPath;

async function main(): Promise<void> {
  try {
    const cfg = parseRuntimeConfig(
      runtimeConfigModule.loadConfig({ routing: "queue" }),
    );
    client = liveBroker.createBackend(
      { ...cfg, timeoutMs: 60000 },
      { command: cfg.backend === "addin" },
    );
    receiptClient = new queueClientModule.QueueClient(clientId, {
      cfg,
      existingCredentialsOnly: true,
    });
    const brokerStatus = asRecord(
      await receiptClient.call("status", {}),
      "Shared broker status",
    );
    assert.equal(
      brokerStatus["buildHash"],
      selectedRuntime.buildHash,
      "The selected installed runtime must match the active shared broker build",
    );
    report.backend = cfg.backend;
    report.transport = cfg.transport;
    report.clientId = clientId;
    report.runtimeRoot = selectedRuntime.root;
    report.runtimeBuildHash = selectedRuntime.buildHash;
    liveBroker.fixture(name);
    baseline = await state();
    report.before = baseline;
    assert.ok(
      !baseline.documents.some((doc) => doc.name === name),
      "Test document name already exists",
    );
    const creation = await cli(
      ["doc", "new", "--name", name, "--json", "--timeout", "60000"],
      "doc new",
    );
    const created = creation.process;
    assert.equal(
      created.status,
      0,
      created.stderr || created.stdout || created.error?.message,
    );
    assert.equal(
      creation.call.workerReceipt?.state,
      "succeeded",
      "Owned document creation lacks a terminal worker receipt",
    );
    assert.equal(creation.call.workerReceipt?.executionOutcome, "succeeded");
    const afterCreation = await state();
    report.afterCreation = afterCreation;
    saveReport();
    const added = afterCreation.documents.filter(
      (doc) =>
        !originalDocuments().documents.some(
          (old) => old.creationId === doc.creationId,
        ),
    );
    assert.equal(
      added.length,
      1,
      "Creating the owned fixture must add exactly one document",
    );
    const createdDocument = added[0];
    assert.ok(createdDocument);
    identity = createdDocument;
    assert.equal(identity.name, name);
    assert.equal(identity.saved, false, "Test document must remain unsaved");
    assert.equal(
      identity.fileId,
      null,
      "Test document must not be cloud-saved",
    );
    report.owned = identity;
    liveBroker.fixture(name, identity.creationId);
    await guard();
    saveReport();

    await test(
      "local preflight is reported separately from native effect",
      async () => {
        const offlineCatalog = await cad("catalog.check", catalogFileData, {
          expect: "local-pass",
          native: false,
        });
        const offlinePlacement = await cad(
          "placement.check",
          {
            version: 1,
            owner,
            revision: "placement-offline",
            records: [
              {
                id: "offline-pose",
                occurrence: "not-resolved-offline",
                placement: pose("root", 1),
                status: "CONFIRMED",
                source,
              },
            ],
          },
          { expect: "local-unknown", native: false },
        );
        return {
          catalog: {
            status: offlineCatalog.status,
            method: offlineCatalog.method,
            modelValidated: offlineCatalog.modelValidated,
          },
          placement: {
            status: offlinePlacement.status,
            method: offlinePlacement.method,
            modelValidated: offlinePlacement.modelValidated,
          },
          distinction:
            "Neither output is native import or live readback evidence.",
        };
      },
      "local-only",
    );

    await test("param.import creates native expression parameters; invalid dependency leaves no partial writes", async () => {
      const imported = await cad(
        "param.import",
        {
          version: 1,
          owner,
          revision: "parameters-r1",
          records: [
            {
              name: parameterA,
              expression: "5",
              unit: "mm",
              comment: "Synthetic live import",
              status: "CONFIRMED",
              source,
            },
            {
              name: parameterB,
              expression: parameterA + " * 2",
              unit: "mm",
              status: "CONFIRMED",
              source,
            },
          ],
        },
        { expect: "pass" },
      );
      const importedParameters = imported.result.parameters;
      assert.equal(importedParameters.length, 2);
      const readback = await cad("param.inspect", {
        names: [parameterA, parameterB],
      });
      const rows = readback.result.parameters;
      assert.deepEqual(
        rows.map((row) => row.name),
        [parameterA, parameterB],
      );
      const first = requiredItem(rows, 0, "Native parameter readback");
      const second = requiredItem(rows, 1, "Native parameter readback");
      assert.equal(first.expression, "5 mm");
      assert.equal(first.unit, "mm");
      assert.ok(
        Math.abs(first.value - 0.5) < 1e-9,
        `Native parameter value was ${first.value} cm`,
      );
      assert.equal(second.expression, parameterA + " * 2");
      assert.ok(
        Math.abs(second.value - 1) < 1e-9,
        `Native dependent value was ${second.value} cm`,
      );

      const before = await cad("param.inspect", {});
      const rejected = await cad(
        "param.import",
        {
          version: 1,
          owner,
          revision: "parameters-invalid",
          records: [
            {
              name: parameterCandidate,
              expression: "7",
              unit: "mm",
              status: "CONFIRMED",
              source,
            },
            {
              name: parameterBad,
              expression: "missing_" + suffix + " * 2 mm",
              unit: "mm",
              status: "CONFIRMED",
              source,
            },
          ],
        },
        { expect: "blocked" },
      );
      const after = await cad("param.inspect", {});
      assert.deepEqual(
        after.result.parameters,
        before.result.parameters,
        "Native param preflight must reject the full dependency set before adding the valid candidate",
      );
      assert.match(
        rejected.result.error,
        /expression|parameter|depend|invalid|unit/i,
      );
      recordNegativeAfterState("param-invalid-dependency", rejected, {
        before: before.result.parameters,
        after: after.result.parameters,
        unchanged: true,
      });
      const workerEvidence = workerEvidenceFor(rejected);
      return {
        imported: imported.result.parameters,
        nativeReadback: rows,
        negative: {
          status: rejected.status,
          error: rejected.result.error,
          workerReceipt: workerEvidence.receipt,
          afterState: after.result.parameters,
          stateUnchanged: true,
        },
      };
    });

    await test("catalog.import creates owned native definitions and occurrences; duplicate import is rejected unchanged", async () => {
      const imported = await cad("catalog.import", catalogFileData, {
        expect: "pass",
      });
      assert.equal(imported.result.instances.length, 3);
      importedCatalogInstances = imported.result.instances;
      importedCatalogIdMap = imported.result.idMap;
      const byId = Object.fromEntries(
        imported.result.instances.map((row) => [row.id, row]),
      );
      for (const id of [
        "synthetic-assembly:1",
        "synthetic-assembly:1/synthetic-part:1",
        "synthetic-cots:1",
      ]) {
        assert.ok(byId[id], `Missing native catalog occurrence ${id}`);
        const observed = await cad("entity.inspect", {
          ref: byId[id].occurrence,
          frame: "root",
        });
        assert.equal(observed.result.kind, "occurrence");
        assert.ok(observed.result.occurrencePath);
      }
      for (const [id, expectedName] of [
        [topId, topName],
        [childId, childName],
        [sensorId, sensorName],
      ] as const) {
        const entry = imported.result.idMap[id];
        assert.ok(entry, `Catalog has no native id map entry for ${id}`);
        const definition = entry.definition;
        assert.ok(
          definition,
          `Catalog did not return native definition ref for ${id}`,
        );
        const actual = await cad("component.inspect", {
          component: definition,
        });
        assert.equal(actual.result.component.name, expectedName);
        assert.equal(
          actual.result.bodies.length,
          0,
          "Catalog item without a model must not invent geometry",
        );
      }
      const checked = await cad(
        "catalog.check",
        { ...catalogFileData, inspectModel: true },
        { expect: "pass" },
      );
      assert.deepEqual(checked.result.differences, []);
      assert.equal(checked.result.instances.length, 3);

      const rejected = await cad("catalog.import", catalogFileData, {
        expect: "blocked",
      });
      assert.match(rejected.result.error, /already exists|onExisting/i);
      const afterReject = await cad(
        "catalog.check",
        { ...catalogFileData, inspectModel: true },
        { expect: "pass" },
      );
      assert.deepEqual(afterReject.result.differences, []);
      assert.deepEqual(
        afterReject.result.instances,
        checked.result.instances,
        "Terminal duplicate-import failure must preserve the exact native catalog readback",
      );
      recordNegativeAfterState("catalog-duplicate-import", rejected, {
        before: {
          status: checked.status,
          differences: checked.result.differences,
          instances: checked.result.instances,
        },
        after: {
          status: afterReject.status,
          differences: afterReject.result.differences,
          instances: afterReject.result.instances,
        },
        unchanged: true,
      });
      const workerEvidence = workerEvidenceFor(rejected);
      return {
        importedInstances: checked.result.instances.map((row) => ({
          id: row.id,
          item: row.item,
          parent: row.parent,
          componentName: row.componentName,
        })),
        negative: {
          status: rejected.status,
          error: rejected.result.error,
          workerReceipt: workerEvidence.receipt,
          followupCheck: afterReject.status,
          afterInstances: afterReject.result.instances,
        },
      };
    });

    await test("placement.import changes a native occurrence and placement.check measures it; duplicate target is rejected unchanged", async () => {
      const occurrence = importedInstances().find(
        (row) => row.id === "synthetic-assembly:1",
      )?.occurrence;
      assert.ok(
        occurrence,
        "Catalog import did not return the assembly occurrence ref",
      );
      const placementData = {
        version: 1,
        owner,
        revision: "placement-r1",
        records: [
          {
            id: "synthetic-assembly:1",
            occurrence,
            placement: pose("root", 25),
            status: "CONFIRMED",
            source,
          },
        ],
      };
      const imported = await cad("placement.import", placementData, {
        expect: "pass",
      });
      assert.equal(imported.result.poses.length, 1);
      const checked = await cad(
        "placement.check",
        { ...placementData, inspectModel: true },
        { expect: "pass" },
      );
      const checkedPose = requiredItem(
        checked.result.poses,
        0,
        "Native placement check",
      );
      assert.equal(checkedPose.status, "pass");
      const initialPose = requiredItem(
        checked.result.poses,
        0,
        "Native placement readback",
      );
      const initialX = requiredItem(
        initialPose.actual,
        3,
        "Native placement transform",
      );
      assert.ok(
        Math.abs(initialX - 2.5) < 1e-9,
        `Native root X translation was ${initialX} cm, expected 2.5 cm`,
      );

      const rejected = await cad(
        "placement.import",
        {
          ...placementData,
          revision: "placement-duplicate",
          records: [
            { ...placementData.records[0], id: "duplicate-a" },
            { ...placementData.records[0], id: "duplicate-b" },
          ],
        },
        { expect: "blocked" },
      );
      assert.match(
        rejected.result.error,
        /Duplicate resolved occurrence path/i,
      );
      const afterReject = await cad(
        "placement.check",
        { ...placementData, inspectModel: true },
        { expect: "pass" },
      );
      const restoredPose = requiredItem(
        afterReject.result.poses,
        0,
        "Placement after negative request",
      );
      assert.equal(restoredPose.status, "pass");
      assert.ok(
        Math.abs(
          requiredItem(
            restoredPose.actual,
            3,
            "Placement after negative request",
          ) - 2.5,
        ) < 1e-9,
        "Rejected duplicate placement changed the native pose",
      );
      assert.deepEqual(
        afterReject.result.poses,
        checked.result.poses,
        "Terminal duplicate-placement failure must preserve the complete measured world pose",
      );
      recordNegativeAfterState("placement-duplicate-path", rejected, {
        before: { status: checked.status, poses: checked.result.poses },
        after: { status: afterReject.status, poses: afterReject.result.poses },
        unchanged: true,
      });
      const workerEvidence = workerEvidenceFor(rejected);
      return {
        requestedRootXmm: 25,
        actualRootXcm: initialX,
        negative: {
          status: rejected.status,
          error: rejected.result.error,
          workerReceipt: workerEvidence.receipt,
          followupStatus: afterReject.status,
          afterPoses: afterReject.result.poses,
        },
      };
    });

    await test(
      "cots.replace imports the owned STEP body and replaces only the synthetic occurrence",
      async () => {
        const sourceComponent = await cad("component.create", {
          name: "FMCAD_DI_" + suffix + "_StepSource",
        });
        const sourceName = "FMCAD_DI_" + suffix + "_StepSource";
        const box = await cad(
          "shape.box",
          {
            name: "SyntheticReplacementSolid",
            width: "11 mm",
            depth: "7 mm",
            height: "5 mm",
          },
          { component: sourceName },
        );
        assert.equal(box.result.bodies.length, 1);
        const sourceState = await cad("component.inspect", {
          component: sourceComponent.result.component,
        });
        assert.equal(
          sourceState.result.bodies.length,
          1,
          "Synthetic STEP source must contain one native body",
        );
        const sourceBody = requiredItem(
          sourceState.result.bodies,
          0,
          "Synthetic STEP source body",
        );
        const sourceVolume = await cad("measure.volume", {
          ref: sourceBody,
          units: "mm3",
        });
        assert.ok(
          Math.abs(sourceVolume.result.value - 385) < 0.01,
          `Synthetic source volume was ${sourceVolume.result.value} mm^3`,
        );
        const exported = await cad("export.step", {
          path: stepPath,
          ref: sourceComponent.result.component,
        });
        assert.equal(exported.result.exists, true);
        assert.ok(exported.result.bytes > 0);
        assert.equal(
          fs.statSync(stepPath).size,
          exported.result.bytes,
          "Exported STEP is not present in the owned local fixture root",
        );

        const old = importedInstances().find(
          (row) => row.id === "synthetic-cots:1",
        );
        assert.ok(
          old?.occurrence?.path,
          "Catalog check did not return the old native occurrence path",
        );
        const oldOccurrence = old.occurrence;
        const oldPath = oldOccurrence.path;
        assert.ok(oldPath);
        const oldOccurrenceBefore = await cad("entity.inspect", {
          ref: oldOccurrence,
          frame: "root",
        });
        const sensorEntry = importedIdMap()[sensorId];
        assert.ok(sensorEntry);
        const oldComponentBefore = await cad("component.inspect", {
          component: sensorEntry.definition,
        });
        assert.equal(oldOccurrenceBefore.result.occurrencePath, oldPath);
        assert.equal(oldComponentBefore.result.bodies.length, 0);
        const rejected = await cad(
          "cots.replace",
          {
            version: 1,
            owner,
            revision: "cots-r2",
            expectedRevision: "wrong-revision",
            target: sensorId,
            model: {
              path: stepPath,
              representation: "envelope",
              source,
              status: "ESTIMATED",
            },
            occurrencePolicy: "all",
            datumMap: [
              { name: "mount", old: pose("component"), new: pose("component") },
            ],
            impacts: Object.fromEntries(
              ["matingParts", "routings", "refs", "mass"].map((key) => [
                key,
                {
                  status: "known",
                  items: [],
                  source: "Isolated synthetic fixture inventory",
                },
              ]),
            ),
            mass: { value: 3, unit: "g", status: "ESTIMATED", source },
            acceptInvalidation: true,
          },
          { expect: "blocked" },
        );
        assert.ok(rejected.result.error);
        const unchangedOccurrence = await cad("entity.inspect", {
          ref: oldOccurrence,
          frame: "root",
        });
        const unchangedComponent = await cad("component.inspect", {
          component: oldComponentBefore.result.component,
        });
        assert.equal(
          unchangedOccurrence.result.occurrencePath,
          oldOccurrenceBefore.result.occurrencePath,
          "Wrong expectedRevision removed or replaced the existing occurrence",
        );
        assert.deepEqual(
          unchangedComponent.result.bodies,
          oldComponentBefore.result.bodies,
          "Wrong expectedRevision changed the existing native definition",
        );
        recordNegativeAfterState("cots-wrong-revision", rejected, {
          before: {
            occurrence: oldOccurrenceBefore.result,
            component: oldComponentBefore.result,
          },
          after: {
            occurrence: unchangedOccurrence.result,
            component: unchangedComponent.result,
          },
          unchanged: true,
        });

        const replaced = await cad(
          "cots.replace",
          {
            version: 1,
            owner,
            revision: "cots-r2",
            expectedRevision: "catalog-r1",
            target: sensorId,
            model: {
              path: stepPath,
              representation: "envelope",
              source,
              status: "ESTIMATED",
            },
            occurrencePolicy: "all",
            datumMap: [
              { name: "mount", old: pose("component"), new: pose("component") },
            ],
            impacts: Object.fromEntries(
              ["matingParts", "routings", "refs", "mass"].map((key) => [
                key,
                {
                  status: "known",
                  items: [],
                  source: "Isolated synthetic fixture inventory",
                },
              ]),
            ),
            mass: { value: 3, unit: "g", status: "ESTIMATED", source },
            acceptInvalidation: true,
          },
          { expect: "unknown" },
        );
        assert.equal(replaced.result.replacements.length, 1);
        assert.equal(replaced.result.datumChecks.length, 1);
        const datumCheck = requiredItem(
          replaced.result.datumChecks,
          0,
          "COTS datum check",
        );
        assert.equal(datumCheck.status, "pass");
        assert.deepEqual(
          replaced.result.unresolved,
          [{ id: sensorId, field: "replacement.material", status: "unknown" }],
          "The method must preserve the explicit unknown material limitation",
        );
        const actualReplacement = requiredItem(
          replaced.result.replacements,
          0,
          "COTS replacement result",
        );
        assert.equal(actualReplacement.before.path, oldPath);
        assert.ok(actualReplacement.after.path);
        assert.notEqual(
          actualReplacement.before.path,
          actualReplacement.after.path,
        );
        const rootOccurrences = await cad("entity.list", {
          kind: "occurrence",
          component: "root",
        });
        const paths = rootOccurrences.result.entities.map((row) => row.path);
        assert.ok(
          !paths.includes(actualReplacement.before.path),
          "Old COTS occurrence still exists in the native assembly",
        );
        assert.ok(
          paths.includes(actualReplacement.after.path),
          "Replacement occurrence is absent from the native assembly",
        );
        const replacement = await cad("component.inspect", {
          component: replacementName,
        });
        assert.equal(replacement.result.component.name, replacementName);
        assert.equal(
          replacement.result.bodies.length,
          1,
          "Imported STEP did not create one native BRep body",
        );
        const replacementBody = requiredItem(
          replacement.result.bodies,
          0,
          "COTS replacement body",
        );
        const volume = await cad("measure.volume", {
          ref: replacementBody,
          units: "mm3",
        });
        assert.ok(
          Math.abs(volume.result.value - sourceVolume.result.value) < 0.05,
          `Imported BRep volume ${volume.result.value} mm^3 differs from source ${sourceVolume.result.value} mm^3`,
        );
        const observed = await cad("entity.inspect", {
          ref: actualReplacement.after,
          frame: "root",
        });
        assert.equal(observed.result.kind, "occurrence");
        assert.equal(
          observed.result.occurrencePath,
          actualReplacement.after.path,
        );
        const workerEvidence = workerEvidenceFor(rejected);
        return {
          productStatus: replaced.status,
          effect:
            "native replacement occurrence observed; old occurrence absent; imported BRep measured",
          oldPath: actualReplacement.before.path,
          newPath: actualReplacement.after.path,
          bodyCount: replacement.result.bodies.length,
          sourceVolumeMm3: sourceVolume.result.value,
          replacementVolumeMm3: volume.result.value,
          datumCheck,
          unresolved: replaced.result.unresolved,
          negative: {
            status: rejected.status,
            error: rejected.result.error,
            workerReceipt: workerEvidence.receipt,
            oldOccurrenceStillPresent:
              unchangedOccurrence.result.occurrencePath ===
              oldOccurrenceBefore.result.occurrencePath,
          },
        };
      },
      "effect-verified; product status remains unknown",
    );

    await test("all native requests remain pinned to the owned document identity", async () => {
      const current = await guard();
      const own = ownedDocument();
      const owned = current.documents.find(
        (doc) => doc.creationId === own.creationId,
      );
      assert.ok(owned);
      assert.equal(owned.saved, false);
      const cadCalls = report.calls.filter((call) => isOperation(call.label));
      for (const call of cadCalls) {
        const docIndex = call.args.indexOf("--doc");
        const idIndex = call.args.indexOf("--doc-id");
        assert.ok(
          docIndex >= 0 && idIndex >= 0,
          `${call.label} omitted a document identity pin`,
        );
        assert.equal(call.args[docIndex + 1], own.name);
        assert.equal(call.args[idIndex + 1], own.creationId);
      }
      assert.deepEqual(
        report.nativeNegativeCases.map((row) => row.status),
        Array(4).fill("verified-terminal-failed-worker-plus-readback"),
        "Every expected negative needs its own terminal failed worker receipt and independent after-readback",
      );
      return { owned: own, allCadRequestsPinned: true, unsaved: true };
    });
    report.status =
      "native-positives-and-expected-negatives-verified-cots-material-unknown";
  } catch (error) {
    report.status = "failed";
    report.error = errorStack(error);
    process.exitCode = 1;
    console.error(errorStack(error));
  } finally {
    if (identity && !unsafe) {
      try {
        const own = ownedDocument();
        await ownedState();
        const closed = await script(
          `app = adsk.core.Application.get()
matches = [d for d in app.documents if d.creationId == ${JSON.stringify(own.creationId)} and d.name == ${JSON.stringify(name)}]
assert len(matches) == 1, 'Owned document identity is ambiguous; leaving it open'
doc = matches[0]
assert not doc.isSaved, 'Owned document was saved unexpectedly; leaving it open'
assert doc.close(False), 'Owned document close failed'
documents = [dict(creationId=d.creationId, name=d.name, saved=d.isSaved, modified=d.isModified,
                  fileId=d.dataFile.id if d.isSaved and d.dataFile else None) for d in app.documents]
print(json.dumps(dict(closedCreationId=${JSON.stringify(own.creationId)}, documents=documents,
                      activeCreationId=app.activeDocument.creationId if app.activeDocument else None)))`,
          false,
        );
        assert.equal(closed["closedCreationId"], own.creationId);
        const after = parseDocumentSnapshot(
          closed,
          "Post-cleanup Fusion document inventory",
        );
        liveBroker.fixture(name);
        assert.equal(
          after.documents.some((doc) => doc.creationId === own.creationId),
          false,
          "Close(False) did not remove the exact owned document",
        );
        assertProtectedBaselineDocuments(
          originalDocuments(),
          after,
          "After closing the owned fixture",
        );
        assertActiveDocumentRestored(
          originalDocuments(),
          after,
          "Close(False)",
        );
        report.after = after;
        for (const fixturePath of [catalogPath, stepPath]) {
          if (fs.existsSync(fixturePath)) fs.unlinkSync(fixturePath);
        }
        report.cleanup = {
          closedCreationId: closed["closedCreationId"],
          protectedDocumentsRestored: true,
          activeDocumentRestored: after.activeCreationId,
          syntheticFilesRemoved: true,
        };
      } catch (error) {
        report.status = "failed";
        report.cleanupError = errorStack(error);
        process.exitCode = 1;
      }
    } else {
      report.cleanup = {
        closed: false,
        reason: unsafe
          ? "An SDK/transport result was uncertain; retained the owned fixture for inspection."
          : "Native checks did not all complete; retained the owned fixture for inspection.",
      };
    }
    receiptClient?.dispose();
    if (client) liveBroker.disposeBackend(client);
    report.finishedAt = new Date().toISOString();
    saveReport();
    console.log(
      `Report: ${reportPath}\nSynthetic STEP: ${fs.existsSync(stepPath) ? stepPath : "not created"}\nOverall: ${report.status}`,
    );
  }
}

main().catch((error) => {
  console.error(errorStack(error));
  process.exitCode = 1;
});
