// One opt-in, source-pinned cad-v1 run against an externally prepared exact
// owner scratch. It deliberately does not attempt to satisfy the full native
// negative-case requirement because cad-v1 does not preserve their failed
// helper responses. This never replaces tests/live-data-import.ts.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  asArray,
  asRecord,
  parsePublicQueueJob,
  type JsonRecord,
  type PublicQueueJob,
} from "./live-import-receipts.js";

interface FixedIdentity {
  name: string;
  creationId: string;
}
interface FixtureContract extends JsonRecord {
  fixtureId: string;
  kind: string;
  helperVersion: string;
  script: string;
  scriptSha256: string;
  manifestSha256: string;
}
interface QueueInstanceModule {
  buildHash(): string;
}
interface FixtureApiModule {
  fixtureContract(id: string): unknown;
}
interface RuntimeBuild {
  fingerprint: string;
}
interface FixedRuntime {
  runtimeRoot: string;
  runtime: QueueInstanceModule;
  fixture: FixtureContract;
  scriptPath: string;
  manifestPath: string;
  cliPath: string;
  buildHash: string;
}
interface MethodResult extends JsonRecord {
  status: string;
  operation?: string;
  documentIdentity?: { creationId?: string };
  unresolved?: Array<{ id: string; field: string; status: string }>;
  datumChecks?: Array<{ status: string }>;
  instances?: CatalogInstance[];
  differences?: unknown[];
  component?: { name?: string } & JsonRecord;
  bodies?: unknown[];
}
interface NativeCall extends JsonRecord {
  operation: string;
  result: MethodResult;
}
interface HelperCall extends JsonRecord {
  operation: string;
  status: string;
  effects: string;
}
interface NativeDocumentStatus extends JsonRecord {
  creationId: string;
  name: string;
  saved: boolean;
  modified: boolean;
  fileId: string | null;
}
interface ParameterRow extends JsonRecord {
  name: string;
  expression: string;
  value: number;
}
interface CatalogInstance extends JsonRecord {
  id: string;
}
interface PlacementRow extends JsonRecord {
  status: string;
  actual: number[];
}
interface CotsReadback extends JsonRecord {
  materialStatus: string;
  oldPath: string;
  newPath: string;
  sourceVolumeMm3: number;
  replacementVolumeMm3: number;
}
interface FixedPayload extends JsonRecord {
  version: number;
  document: {
    name: string;
    creationId: string;
    before: NativeDocumentStatus;
    after: NativeDocumentStatus;
  };
  fusionVersion: string;
  fixturePrefix: string;
  modelChangedByFixture: boolean;
  nativeGeometry: boolean;
  designBefore: JsonRecord;
  calls: NativeCall[];
  paramReadback: ParameterRow[];
  catalogInstances: CatalogInstance[];
  catalogDifferences: unknown[];
  placementReadback: PlacementRow[];
  cotsReadback: CotsReadback;
  removedFiles: unknown;
  artifactPaths: string[];
  artifactDirectoryRemoved: boolean;
  artifactDirectory: string;
  negativeCases: string;
  cleanup: unknown;
}
interface FixedEnvelope {
  success: boolean;
  result: FixedPayload;
  helperCallsOnly: HelperCall[];
}
interface FixedAssertion extends JsonRecord {
  label: string;
  actual: unknown;
  expected: unknown;
  status: string;
}
interface FixedMethodResultReport extends JsonRecord {
  operation: string;
  resultStatus: string;
  productAcceptance: string;
  nativeResult: MethodResult;
}
interface OperationCoverage extends JsonRecord {
  operation: string;
  status: string;
  actualReadback: string;
}
interface FixedCommand extends JsonRecord {
  requestId: string;
  clientId: string;
  runtimeRoot: string;
  buildHash: string;
  fixtureId: string;
  manifestSha256: string;
  scriptSha256: string;
  exitCode: number | null;
  status: string;
  signal?: NodeJS.Signals | null;
  error?: string;
  stdout: string;
  stderr: string;
  jobId?: string | null;
  queueResult?: PublicQueueJob;
}
interface FixedReport extends JsonRecord {
  suite: string;
  startedAt: string;
  status: string;
  scope: string;
  reportPath: string;
  nativeNegativeCases: Array<{
    id: string;
    status: string;
    expectedAfterState: string;
    reason?: string;
  }>;
  operations: string[];
  sourcePin: JsonRecord;
  commands: FixedCommand[];
  assertions: FixedAssertion[];
  methodResults: FixedMethodResultReport[];
  operationCoverage: OperationCoverage[];
  document?: JsonRecord;
  parameterReadback?: ParameterRow[];
  catalogReadback?: JsonRecord;
  placementReadback?: PlacementRow[];
  cotsReadback?: JsonRecord;
  cleanup?: JsonRecord;
  fixedResult?: FixedPayload;
  owner?: FixedIdentity;
  runtime?: JsonRecord;
  requestId?: string;
  execution?: JsonRecord;
  runStatus?: string;
  nativeRun?: JsonRecord;
  error?: string;
  blockedReason?: string;
  finishedAt?: string;
}
interface HelperModule {
  isExecutionUnknown(value: unknown): boolean;
}
interface RunScriptModule {
  prepareRunScript(
    file: string,
    args: JsonRecord,
    approved: boolean,
    name: string,
    identity: JsonRecord,
    helpers: string,
    extra: unknown[],
    options: { projectDirectory: string },
  ): { script: string };
}
interface AtomicRecoveryAuditModule {
  prepareRecoveryAuditWire(input: JsonRecord): {
    outgoing: JsonRecord;
    artifact: JsonRecord;
  };
}
interface QueueAdmissionModule {
  createProductionQueueAdmission(runtime: string): {
    admission: {
      check(outgoing: JsonRecord, artifact: JsonRecord): Promise<JsonRecord>;
    };
  };
}
interface ResolvedRuntimePaths {
  runtime: string;
}
interface ConfigPlatformModule {
  resolveRuntimePaths(input: { anchor: string }): ResolvedRuntimePaths;
}

const root = path.resolve(__dirname, "..", "..");
const runtimeRequire = createRequire(__filename);
const helperModule = runtimeRequire(
  path.join(root, "tests/helpers/gm12-fixed-result.js"),
) as HelperModule;
const isExecutionUnknown = helperModule.isExecutionUnknown;
const fixtureId = "data-import-program-v1";
const fixturePrefix = "NQGM07IMPORT01";
// master advanced from the originally announced 0fc1d99 candidate. bb7b68a
// removed expected-throw calls that cad-v1 receipts cannot safely classify.
const fixtureRevision = "bb7b68a87a2eaec77c3aed59e3fb7a085de1f894";
const scriptPathFromRuntime = "assets/native-qualification/data-import.py";
const expectedScriptSha256 =
  "d686403ef51d66e972126841085d269b17fdabebc0fb67b53b7eeb76f2ca98f2";
const expectedManifestSha256 =
  "2c4015ce9221de13680f0dfa5375bc84831f04da946a1d759795001e2ca72cea";
const previousCandidate = {
  commit: "0fc1d992db1a3c7b7c5b3d3944d44aba8bc3fa0d",
  scriptSha256:
    "25b8ca6620d6ff1999ccf38194cd131b42871ca09e283684ca3dbf9f16313005",
  manifestSha256:
    "9bcc0e91a92f78808a8b9604bac49effb39ec9b47ea09508db8d97c5bf68dd75",
};
const operations = [
  "param.import",
  "catalog.import",
  "placement.import",
  "cots.replace",
];
const expectedHelperOperations = [
  "document.status",
  "param.import",
  "param.inspect",
  "catalog.import",
  "entity.inspect",
  "entity.inspect",
  "entity.inspect",
  "component.inspect",
  "component.inspect",
  "component.inspect",
  "catalog.check",
  "placement.import",
  "placement.check",
  "component.create",
  "shape.box",
  "component.inspect",
  "measure.volume",
  "export.step",
  "entity.inspect",
  "cots.replace",
  "entity.list",
  "component.inspect",
  "measure.volume",
  "entity.inspect",
  "document.status",
];
const expectedNegativeLimitation =
  "Expected-throw native preflight cases are not invoked inside this fixed run because cad-v1 records failed helper calls as unknown; they require a separately classified local test.";
const admissionFailure =
  /NATIVE_FIXTURE_(?:SCOPE_REQUIRED|CHANGED|UNSUPPORTED|CLIENT_REQUIRED|FRESH_EPOCH_REQUIRED)|EPOCH_(?:CLIENT_NOT_GRANTED|CLEANUP_PENDING)|SAVED_FIRST_SAVE_PENDING|GRANT_SCOPE_CONFLICT|NOT_OWNER|BUILD_CHANGED/;

process.env["FMCAD_LIVE_ROUTING"] = "queue";
process.env["FMCAD_LIVE_SUITE"] = "data-import-fixed";

const artifactParent = path.join(root, ".test-artifacts");
fs.mkdirSync(artifactParent, { recursive: true });
const artifactRoot = fs.mkdtempSync(
  path.join(artifactParent, "live-data-import-fixed-report-"),
);
const reportPath = path.join(artifactRoot, "report.json");
const report: FixedReport = {
  suite: "data-import-fixed",
  startedAt: new Date().toISOString(),
  status: "not-run",
  scope:
    "One externally prepared, exact owner-bound unsaved scratch. The installed fixed source is the only CAD mutation path; it creates and removes one prefix-owned synthetic STEP file. No user/vendor files, cloud save, new document, or raw SDK script.",
  nativeNegativeCases: [
    {
      id: "param-invalid-dependency",
      status: "NOTRUN",
      expectedAfterState: "Native user parameter snapshot unchanged.",
    },
    {
      id: "catalog-duplicate-import",
      status: "NOTRUN",
      expectedAfterState: "Native catalog.check remains unchanged.",
    },
    {
      id: "placement-duplicate-path",
      status: "NOTRUN",
      expectedAfterState: "Native placement.check remains unchanged.",
    },
    {
      id: "cots-wrong-revision",
      status: "NOTRUN",
      expectedAfterState: "Old native occurrence/component remain unchanged.",
    },
  ],
  operations,
  sourcePin: {
    fixtureId,
    repositoryRevision: fixtureRevision,
    script: scriptPathFromRuntime,
    scriptSha256: expectedScriptSha256,
    manifestSha256: expectedManifestSha256,
    supersededCandidate: previousCandidate,
  },
  commands: [],
  assertions: [],
  methodResults: [],
  operationCoverage: [],
  reportPath,
};
let identity: FixedIdentity | undefined;
let nativeAttempted = false;
let uncertain = false;
let blockedReason: string | undefined;
let failure: Error | undefined;

function persist() {
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  assert.ok(
    typeof value === "string" && value.trim(),
    `${name} must be supplied by the existing owner-scoped fixed-run handoff.`,
  );
  return value;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function canonicalSourceSha256(file: string): string {
  return createHash("sha256")
    .update(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"))
    .digest("hex");
}

function note(
  label: string,
  actual: unknown,
  expected: unknown,
  status = "pass",
): void {
  report.assertions.push({ label, actual, expected, status });
  persist();
  assert.equal(status, "pass", `${label} did not pass.`);
  assert.deepEqual(
    actual,
    expected,
    `${label}: actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}`,
  );
}

function fixedNote(label: string, actual: unknown, expected: unknown): void {
  if (!isDeepStrictEqual(actual, expected)) {
    blockedReason = `Installed fixed-run source pin mismatch: ${label}. No Fusion request was submitted.`;
    throw new Error(blockedReason);
  }
  note(label, actual, expected);
}

function resolveFixedRuntime(): FixedRuntime {
  const runtimeRoot = fs.realpathSync(requiredEnv("FMCAD_LIVE_RUNTIME_ROOT"));
  const runtime = runtimeRequire(
    path.join(runtimeRoot, "dist/src/queue-instance.js"),
  ) as QueueInstanceModule;
  const fixtureApi = runtimeRequire(
    path.join(runtimeRoot, "dist/src/queue-native-fixture-grant.js"),
  ) as FixtureApiModule;
  let fixture: FixtureContract;
  try {
    fixture = parseFixtureContract(fixtureApi.fixtureContract(fixtureId));
  } catch (error) {
    if (
      error instanceof Error &&
      ["NATIVE_FIXTURE_UNSUPPORTED", "NATIVE_FIXTURE_CHANGED"].includes(
        (error as Error & { code?: string }).code || "",
      )
    ) {
      blockedReason = error.message;
    }
    throw error;
  }
  const scriptPath = path.join(runtimeRoot, "dist", fixture.script);
  const manifestPath = path.join(
    runtimeRoot,
    "dist/assets/native-qualification/data-import-program.json",
  );
  const cliPath = path.join(runtimeRoot, "dist/bin/fmcad.js");
  for (const file of [scriptPath, manifestPath, cliPath]) {
    assert.equal(
      fs.realpathSync(file),
      file,
      `Fixed runtime path is not canonical: ${file}`,
    );
  }
  const manifest = asRecord(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown,
    "Fixed fixture manifest",
  );
  const localScript = path.join(root, scriptPathFromRuntime);
  const localManifest = path.join(
    root,
    "assets/native-qualification/data-import-program.json",
  );
  const runtimeBuild = parseRuntimeBuild(
    JSON.parse(
      fs.readFileSync(
        path.join(runtimeRoot, "dist/runtime-build.json"),
        "utf8",
      ),
    ) as unknown,
  );
  const buildHash = runtime.buildHash();

  fixedNote("fixed fixture id", fixture.fixtureId, fixtureId);
  fixedNote("fixed-run kind", fixture.kind, "fixed-run-v1");
  fixedNote("fixed source path", fixture.script, scriptPathFromRuntime);
  fixedNote("fixed helper version", fixture.helperVersion, "cad-v1");
  fixedNote(
    "installed source SHA256",
    sha256(scriptPath),
    expectedScriptSha256,
  );
  fixedNote(
    "installed manifest SHA256",
    sha256(manifestPath),
    expectedManifestSha256,
  );
  fixedNote(
    "runtime registry source SHA256",
    fixture.scriptSha256,
    expectedScriptSha256,
  );
  fixedNote(
    "runtime registry manifest SHA256",
    fixture.manifestSha256,
    expectedManifestSha256,
  );
  fixedNote(
    "worktree canonical source SHA256",
    canonicalSourceSha256(localScript),
    expectedScriptSha256,
  );
  fixedNote(
    "worktree canonical manifest SHA256",
    canonicalSourceSha256(localManifest),
    expectedManifestSha256,
  );
  fixedNote("manifest argument contract", manifest["argumentKeys"], [
    "approved",
    "creationId",
    "expectedFusionVersion",
    "fixturePrefix",
  ]);
  fixedNote(
    "manifest caller cleanup contract",
    manifest["callerCleanupRequired"],
    true,
  );
  assert.equal(typeof manifest["scope"], "string");
  assert.match(
    manifest["scope"] as string,
    /Do not issue expected-throw negative calls through cad-v1/,
  );
  fixedNote("installed build fingerprint", runtimeBuild.fingerprint, buildHash);

  return {
    runtimeRoot,
    runtime,
    fixture,
    scriptPath,
    manifestPath,
    cliPath,
    buildHash,
  };
}

function parseFixtureContract(value: unknown): FixtureContract {
  const row = asRecord(value, "Native fixture contract");
  for (const key of [
    "fixtureId",
    "kind",
    "helperVersion",
    "script",
    "scriptSha256",
    "manifestSha256",
  ])
    assert.equal(
      typeof row[key],
      "string",
      `Native fixture contract ${key} must be a string`,
    );
  return {
    fixtureId: row["fixtureId"] as string,
    kind: row["kind"] as string,
    helperVersion: row["helperVersion"] as string,
    script: row["script"] as string,
    scriptSha256: row["scriptSha256"] as string,
    manifestSha256: row["manifestSha256"] as string,
  };
}

function parseRuntimeBuild(value: unknown): RuntimeBuild {
  const row = asRecord(value, "Runtime build manifest");
  assert.equal(typeof row["fingerprint"], "string");
  return { fingerprint: row["fingerprint"] as string };
}

function parseDocumentStatus(
  value: unknown,
  label: string,
): NativeDocumentStatus {
  const row = asRecord(value, label);
  assert.equal(typeof row["creationId"], "string");
  assert.equal(typeof row["name"], "string");
  assert.equal(typeof row["saved"], "boolean");
  assert.equal(typeof row["modified"], "boolean");
  assert.ok(row["fileId"] === null || typeof row["fileId"] === "string");
  return {
    creationId: row["creationId"] as string,
    name: row["name"] as string,
    saved: row["saved"] as boolean,
    modified: row["modified"] as boolean,
    fileId: row["fileId"] as string | null,
  };
}

function parseMethodResult(value: unknown, label: string): MethodResult {
  const row = asRecord(value, label);
  assert.equal(
    typeof row["status"],
    "string",
    `${label}.status must be a string`,
  );
  let documentIdentity: { creationId?: string } | undefined;
  if (row["documentIdentity"] !== undefined) {
    const identityRow = asRecord(
      row["documentIdentity"],
      `${label}.documentIdentity`,
    );
    assert.equal(typeof identityRow["creationId"], "string");
    documentIdentity = { creationId: identityRow["creationId"] as string };
  }
  let instances: CatalogInstance[] | undefined;
  if (row["instances"] !== undefined) {
    instances = asArray(row["instances"], `${label}.instances`).map(
      (entry, index) => {
        const item = asRecord(entry, `${label}.instances[${index}]`);
        assert.equal(typeof item["id"], "string");
        return { id: item["id"] as string };
      },
    );
  }
  let component: ({ name?: string } & JsonRecord) | undefined;
  if (row["component"] !== undefined) {
    const item = asRecord(row["component"], `${label}.component`);
    assert.ok(item["name"] === undefined || typeof item["name"] === "string");
    component = typeof item["name"] === "string" ? { name: item["name"] } : {};
  }
  const bodies =
    row["bodies"] === undefined
      ? undefined
      : asArray(row["bodies"], `${label}.bodies`);
  const differences =
    row["differences"] === undefined
      ? undefined
      : asArray(row["differences"], `${label}.differences`);
  return {
    status: row["status"] as string,
    ...(typeof row["operation"] === "string"
      ? { operation: row["operation"] }
      : {}),
    ...(documentIdentity ? { documentIdentity } : {}),
    ...(instances ? { instances } : {}),
    ...(component ? { component } : {}),
    ...(bodies ? { bodies } : {}),
    ...(differences ? { differences } : {}),
    ...(Array.isArray(row["unresolved"])
      ? {
          unresolved: row["unresolved"].map((entry, index) => {
            const item = asRecord(entry, `${label}.unresolved[${index}]`);
            assert.equal(typeof item["id"], "string");
            assert.equal(typeof item["field"], "string");
            assert.equal(typeof item["status"], "string");
            return {
              id: item["id"] as string,
              field: item["field"] as string,
              status: item["status"] as string,
            };
          }),
        }
      : {}),
    ...(Array.isArray(row["datumChecks"])
      ? {
          datumChecks: row["datumChecks"].map((entry, index) => {
            const item = asRecord(entry, `${label}.datumChecks[${index}]`);
            assert.equal(typeof item["status"], "string");
            return { status: item["status"] as string };
          }),
        }
      : {}),
  };
}

function parseFixedPayload(value: unknown): FixedPayload {
  const row = asRecord(value, "Fixed-run payload");
  assert.equal(typeof row["version"], "number");
  const rawDocument = asRecord(row["document"], "Fixed-run document");
  assert.equal(typeof rawDocument["name"], "string");
  assert.equal(typeof rawDocument["creationId"], "string");
  const document = {
    name: rawDocument["name"] as string,
    creationId: rawDocument["creationId"] as string,
    before: parseDocumentStatus(
      rawDocument["before"],
      "Fixed-run before status",
    ),
    after: parseDocumentStatus(rawDocument["after"], "Fixed-run after status"),
  };
  assert.equal(typeof row["fusionVersion"], "string");
  assert.equal(typeof row["fixturePrefix"], "string");
  assert.equal(typeof row["modelChangedByFixture"], "boolean");
  assert.equal(typeof row["nativeGeometry"], "boolean");
  const designBefore = asRecord(
    row["designBefore"],
    "Fixed-run design baseline",
  );
  const calls = asArray(row["calls"], "Fixed-run calls").map((entry, index) => {
    const call = asRecord(entry, `Fixed-run calls[${index}]`);
    assert.equal(typeof call["operation"], "string");
    return {
      operation: call["operation"] as string,
      result: parseMethodResult(
        call["result"],
        `Fixed-run calls[${index}].result`,
      ),
    };
  });
  const paramReadback = asArray(
    row["paramReadback"],
    "Fixed-run parameter readback",
  ).map((entry, index) => {
    const item = asRecord(entry, `Fixed-run paramReadback[${index}]`);
    assert.equal(typeof item["name"], "string");
    assert.equal(typeof item["expression"], "string");
    assert.equal(typeof item["value"], "number");
    return {
      name: item["name"] as string,
      expression: item["expression"] as string,
      value: item["value"] as number,
    };
  });
  const catalogInstances = asArray(
    row["catalogInstances"],
    "Fixed-run catalog readback",
  ).map((entry, index) => {
    const item = asRecord(entry, `Fixed-run catalogInstances[${index}]`);
    assert.equal(typeof item["id"], "string");
    return { id: item["id"] as string };
  });
  const catalogDifferences = asArray(
    row["catalogDifferences"],
    "Fixed-run catalog differences",
  );
  const placementReadback = asArray(
    row["placementReadback"],
    "Fixed-run placement readback",
  ).map((entry, index) => {
    const item = asRecord(entry, `Fixed-run placementReadback[${index}]`);
    assert.equal(typeof item["status"], "string");
    const actual = asArray(
      item["actual"],
      `Fixed-run placementReadback[${index}].actual`,
    );
    assert.ok(
      actual.every(
        (number) => typeof number === "number" && Number.isFinite(number),
      ),
    );
    return { status: item["status"] as string, actual: actual as number[] };
  });
  const rawCots = asRecord(row["cotsReadback"], "Fixed-run COTS readback");
  assert.equal(typeof rawCots["materialStatus"], "string");
  assert.equal(typeof rawCots["oldPath"], "string");
  assert.equal(typeof rawCots["newPath"], "string");
  assert.equal(typeof rawCots["sourceVolumeMm3"], "number");
  assert.equal(typeof rawCots["replacementVolumeMm3"], "number");
  const cotsReadback: CotsReadback = {
    materialStatus: rawCots["materialStatus"] as string,
    oldPath: rawCots["oldPath"] as string,
    newPath: rawCots["newPath"] as string,
    sourceVolumeMm3: rawCots["sourceVolumeMm3"] as number,
    replacementVolumeMm3: rawCots["replacementVolumeMm3"] as number,
  };
  assert.ok(Array.isArray(row["artifactPaths"]));
  const artifactPaths = row["artifactPaths"].map((file, index) => {
    assert.equal(
      typeof file,
      "string",
      `Fixed-run artifactPaths[${index}] must be a string`,
    );
    return file as string;
  });
  assert.equal(typeof row["artifactDirectoryRemoved"], "boolean");
  assert.equal(typeof row["artifactDirectory"], "string");
  assert.equal(typeof row["negativeCases"], "string");
  return {
    version: row["version"] as number,
    document,
    fusionVersion: row["fusionVersion"] as string,
    fixturePrefix: row["fixturePrefix"] as string,
    modelChangedByFixture: row["modelChangedByFixture"] as boolean,
    nativeGeometry: row["nativeGeometry"] as boolean,
    designBefore,
    calls,
    paramReadback,
    catalogInstances,
    catalogDifferences,
    placementReadback,
    cotsReadback,
    removedFiles: row["removedFiles"],
    artifactPaths,
    artifactDirectoryRemoved: row["artifactDirectoryRemoved"] as boolean,
    artifactDirectory: row["artifactDirectory"] as string,
    negativeCases: row["negativeCases"] as string,
    cleanup: row["cleanup"],
  };
}

function parseFixedEnvelope(value: unknown): FixedEnvelope {
  const row = asRecord(value, "Fixed-run envelope");
  assert.equal(typeof row["success"], "boolean");
  const helperCallsOnly = asArray(
    row["helperCallsOnly"],
    "Fixed-run helper calls",
  ).map((entry, index) => {
    const call = asRecord(entry, `Fixed-run helperCallsOnly[${index}]`);
    assert.equal(typeof call["operation"], "string");
    assert.equal(typeof call["status"], "string");
    assert.equal(typeof call["effects"], "string");
    return {
      operation: call["operation"] as string,
      status: call["status"] as string,
      effects: call["effects"] as string,
    };
  });
  return {
    success: row["success"] as boolean,
    result: parseFixedPayload(row["result"]),
    helperCallsOnly,
  };
}

function currentIdentity(): FixedIdentity {
  assert.ok(identity, "Fixed run has no verified owner document identity");
  return identity;
}

function methodCall(payload: FixedPayload, operation: string): MethodResult {
  const matches = payload.calls.filter((row) => row.operation === operation);
  assert.equal(
    matches.length,
    1,
    `Fixed source must invoke ${operation} exactly once.`,
  );
  const match = matches[0];
  assert.ok(match, `${operation} call is missing.`);
  assert.ok(
    match.result && typeof match.result === "object",
    `${operation} returned no result record.`,
  );
  return match.result;
}

function assertMethodResult(
  payload: FixedPayload,
  operation: string,
  expectedStatus: string,
  creationId: string,
): MethodResult {
  const result = methodCall(payload, operation);
  note(`${operation} native result status`, result.status, expectedStatus);
  if (result.operation !== undefined)
    note(`${operation} result operation`, result.operation, operation);
  note(
    `${operation} exact document identity`,
    result.documentIdentity?.creationId,
    creationId,
  );
  report.methodResults.push({
    operation,
    resultStatus: result.status,
    productAcceptance: result.status === "unknown" ? "unknown" : result.status,
    nativeResult: result,
  });
  persist();
  return result;
}

function validateFixedResult(
  envelope: FixedEnvelope,
  fusionVersion: string,
): FixedPayload {
  const own = currentIdentity();
  const payload = envelope.result;
  assert.ok(
    payload && typeof payload === "object",
    "Fixed-run report payload is missing.",
  );
  note("fixed-run payload version", payload.version, 1);
  note("fixed-run document name", payload.document.name, own.name);
  note(
    "fixed-run document creationId",
    payload.document.creationId,
    own.creationId,
  );
  note("fixed-run Fusion version", payload.fusionVersion, fusionVersion);
  note(
    "fixed-run source ownership approval",
    payload.fixturePrefix,
    fixturePrefix,
  );
  note(
    "fixed run changed only its declared model",
    payload.modelChangedByFixture,
    true,
  );
  note("fixed run created native geometry", payload.nativeGeometry, true);

  const before = payload.document?.before;
  const after = payload.document?.after;
  assert.ok(before && after, "Exact document status readbacks are required.");
  note("initial document creationId", before.creationId, own.creationId);
  note("initial document name", before.name, own.name);
  note("initial document unsaved", before.saved, false);
  note("initial document unmodified", before.modified, false);
  note("initial document has no cloud file id", before.fileId, null);
  note("final document creationId", after.creationId, own.creationId);
  note("final document name", after.name, own.name);
  note("final document remains unsaved", after.saved, false);
  note("final document has no cloud file id", after.fileId, null);
  report.document = {
    before,
    after,
    lifecycle: "exact caller close/restore remains required",
  };

  const designBefore = payload.designBefore;
  assert.ok(
    designBefore && typeof designBefore === "object",
    "Empty-design baseline is missing.",
  );
  for (const key of [
    "bodyCount",
    "sketchCount",
    "occurrenceCount",
    "parameterCount",
  ]) {
    note(`pristine scratch ${key}`, designBefore[key], 0);
  }

  const calls = payload.calls;
  assert.ok(Array.isArray(calls), "Native helper call readbacks are missing.");
  const operationsRead = calls.map((row) => row.operation);
  note(
    "fixed source helper-call sequence",
    operationsRead,
    expectedHelperOperations,
  );

  const paramImport = assertMethodResult(
    payload,
    "param.import",
    "pass",
    own.creationId,
  );
  const catalogImport = assertMethodResult(
    payload,
    "catalog.import",
    "pass",
    own.creationId,
  );
  const catalogCheck = assertMethodResult(
    payload,
    "catalog.check",
    "pass",
    own.creationId,
  );
  const placementImport = assertMethodResult(
    payload,
    "placement.import",
    "pass",
    own.creationId,
  );
  const placementCheck = assertMethodResult(
    payload,
    "placement.check",
    "pass",
    own.creationId,
  );
  const cotsReplace = assertMethodResult(
    payload,
    "cots.replace",
    "unknown",
    own.creationId,
  );

  const expectedParameters = [
    { name: `di_${fixturePrefix}_width`, expression: "5 mm", value: 0.5 },
    {
      name: `di_${fixturePrefix}_double`,
      expression: `di_${fixturePrefix}_width * 2`,
      value: 1,
    },
  ];
  assert.equal(payload.paramReadback.length, expectedParameters.length);
  for (const [index, expected] of expectedParameters.entries()) {
    const row = payload.paramReadback[index];
    assert.ok(row);
    note(`parameter ${index} exact name`, row.name, expected.name);
    note(
      `parameter ${index} native expression`,
      row.expression,
      expected.expression,
    );
    assert.ok(
      Number.isFinite(row.value),
      `Parameter ${row.name} value is not numeric.`,
    );
    assert.ok(
      Math.abs(row.value - expected.value) <= 1e-9,
      `Parameter ${row.name} value ${row.value} differs from ${expected.value} cm.`,
    );
  }
  report.parameterReadback = payload.paramReadback;

  const expectedInstanceIds = [
    "synthetic-assembly:1",
    "synthetic-assembly:1/synthetic-part:1",
    "synthetic-cots:1",
  ];
  const actualInstanceIds = payload.catalogInstances.map((row) => row.id);
  note("native catalog occurrence IDs", actualInstanceIds, expectedInstanceIds);
  note("native catalog checker differences", payload.catalogDifferences, []);
  assert.equal(catalogImport.instances?.length, 3);
  assert.equal(catalogCheck.instances?.length, 3);
  report.catalogReadback = {
    instances: payload.catalogInstances,
    differences: payload.catalogDifferences,
  };

  const placementRows = payload.placementReadback;
  assert.equal(placementRows.length, 1);
  const placementRow = placementRows[0];
  assert.ok(placementRow);
  const nativeX = placementRow.actual[3];
  assert.ok(typeof nativeX === "number" && Number.isFinite(nativeX));
  note("native placement checker status", placementRow.status, "pass");
  assert.ok(
    Math.abs(nativeX - 2.5) <= 1e-9,
    `Native assembly X translation ${nativeX} cm differs from 25 mm.`,
  );
  report.placementReadback = placementRows;

  const unresolved = cotsReplace.unresolved || [];
  assert.ok(
    unresolved.some(
      (row) =>
        row.id === "synthetic-cots" &&
        row.field === "replacement.material" &&
        row.status === "unknown",
    ),
    "COTS replacement must retain the explicit unknown material limitation.",
  );
  const datumChecks = cotsReplace.datumChecks;
  assert.equal(datumChecks?.length, 1);
  const datumCheck = datumChecks?.[0];
  assert.ok(datumCheck);
  note("COTS native datum preservation", datumCheck.status, "pass");
  const cots = payload.cotsReadback;
  assert.ok(cots && typeof cots === "object");
  note("COTS material product status", cots.materialStatus, "unknown");
  assert.ok(typeof cots.oldPath === "string" && cots.oldPath);
  assert.ok(typeof cots.newPath === "string" && cots.newPath);
  assert.notEqual(cots.oldPath, cots.newPath);
  assert.ok(
    Number.isFinite(cots.sourceVolumeMm3) &&
      Number.isFinite(cots.replacementVolumeMm3),
  );
  assert.ok(Math.abs(cots.sourceVolumeMm3 - 385) <= 0.01);
  assert.ok(Math.abs(cots.replacementVolumeMm3 - cots.sourceVolumeMm3) <= 0.05);
  report.cotsReadback = { ...cots, datumChecks, unresolved };

  const components = calls.filter(
    (row: NativeCall) => row.operation === "component.inspect",
  );
  assert.equal(
    components.length,
    5,
    "Catalog definitions, STEP source, and COTS replacement require native component readbacks.",
  );
  const replacementComponent = components.at(-1);
  assert.ok(replacementComponent);
  assert.equal(
    replacementComponent.result.component?.name,
    `FMCAD_DI_${fixturePrefix}_Sensor [cots-r2]`,
  );
  assert.equal(replacementComponent.result.bodies?.length, 1);

  note(
    "fixed source cleanup removed its exact STEP artifacts",
    payload.removedFiles,
    payload.artifactPaths,
  );
  note(
    "fixed source cleanup removed its owned artifact directory",
    payload.artifactDirectoryRemoved,
    true,
  );
  assert.ok(
    String(payload.artifactDirectory).includes(
      fixturePrefix + "_" + own.creationId.replaceAll("-", ""),
    ),
    "Fixed temporary STEP directory is not bound to the exact document and fixture prefix.",
  );
  assert.equal(payload.artifactPaths.length, 1);
  assert.equal(
    payload.negativeCases,
    expectedNegativeLimitation,
    "Expected-throw native cases must remain explicitly not-run through cad-v1.",
  );
  report.nativeNegativeCases = report.nativeNegativeCases.map((row) => ({
    ...row,
    status: "NOTRUN",
    reason: payload.negativeCases,
  }));
  report.cleanup = {
    sourceArtifactsRemoved: true,
    documentCloseRequired: true,
    documentCloseStatus: "pending exact owner lifecycle handoff",
    documentCreationId: own.creationId,
    limitation: payload.cleanup,
  };
  report.fixedResult = payload;
  report.operationCoverage = [
    {
      operation: "param.import",
      status: paramImport.status,
      actualReadback: "native expressions and values",
    },
    {
      operation: "catalog.import",
      status: catalogImport.status,
      actualReadback: "native definitions and occurrence tree",
    },
    {
      operation: "catalog.check",
      status: catalogCheck.status,
      actualReadback: "native owned manifest and occurrence state",
    },
    {
      operation: "placement.import",
      status: placementImport.status,
      actualReadback: "native transform2 via placement.check",
    },
    {
      operation: "placement.check",
      status: placementCheck.status,
      actualReadback: "native world pose",
    },
    {
      operation: "cots.replace",
      status: "effect-verified; material remains unknown",
      actualReadback: "old/new occurrence paths, datum, BRep body and volume",
    },
  ];
  report.status =
    "positive-effects-verified-with-negative-cases-not-run-and-close-pending";
  return payload;
}

function runFixedProgram(): FixedPayload {
  assert.ok(
    process.argv.includes("--run"),
    "Explicit --run is required for the exact owner-scoped fixed program.",
  );
  note("live route", process.env["FMCAD_LIVE_ROUTING"], "queue");
  const clientId = requiredEnv("FMCAD_LIVE_CLIENT");
  const runtimeRoot = fs.realpathSync(requiredEnv("FMCAD_LIVE_RUNTIME_ROOT"));
  identity = {
    name: requiredEnv("FMCAD_LIVE_DOC_NAME"),
    creationId: requiredEnv("FMCAD_LIVE_DOC_ID"),
  };
  const own = currentIdentity();
  const fusionVersion = requiredEnv("FMCAD_LIVE_FUSION_VERSION");
  assert.match(
    own.creationId,
    /^[0-9a-f-]{36}$/i,
    "An exact owner creationId is required.",
  );

  const installed = resolveFixedRuntime();
  fixedNote("fixed runtime root", installed.runtimeRoot, runtimeRoot);
  const requestId = "data-import-" + randomUUID();
  const args = {
    approved: true,
    creationId: own.creationId,
    expectedFusionVersion: fusionVersion,
    fixturePrefix,
  };
  const command = [
    installed.cliPath,
    "run",
    installed.scriptPath,
    "--helpers",
    "cad-v1",
    "--args",
    JSON.stringify(args),
    "--doc",
    own.name,
    "--doc-id",
    own.creationId,
    "--request-id",
    requestId,
    "--timeout",
    "180000",
  ];
  nativeAttempted = true;
  const result = spawnSync(process.execPath, command, {
    cwd: root,
    encoding: "utf8",
    timeout: 240000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, FMCAD_ROUTING: "queue", FMCAD_CLIENT: clientId },
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const jobLines = stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith("FMCAD_QUEUE_JOB "));
  const terminalLines = stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith("FMCAD_QUEUE_RESULT "));
  const row: FixedCommand = {
    requestId,
    clientId,
    runtimeRoot,
    buildHash: installed.buildHash,
    fixtureId: installed.fixture.fixtureId,
    manifestSha256: installed.fixture.manifestSha256,
    scriptSha256: installed.fixture.scriptSha256,
    exitCode: result.status,
    signal: result.signal,
    ...(result.error ? { error: result.error.message } : {}),
    stdout,
    stderr,
    status: "not-validated",
  };
  report.commands.push(row);
  report.owner = own;
  report.runtime = {
    runtimeRoot,
    buildHash: installed.buildHash,
    fusionVersion,
  };
  report.requestId = requestId;
  persist();

  if (
    result.error ||
    result.signal ||
    result.status === null ||
    (jobLines.length > 0 && terminalLines.length !== 1)
  ) {
    uncertain = true;
    row.status = "unknown";
    persist();
    throw new Error(
      "Broker outcome is indeterminate; inspect this exact scratch and never replay the fixed run.",
    );
  }
  if (terminalLines.length !== 1) {
    if (admissionFailure.test(stderr)) {
      blockedReason = stderr.trim();
      row.status = "blocked-before-native";
      persist();
      throw new Error("Exact fixed-source admission was not accepted.");
    }
    uncertain = true;
    row.status = "unknown";
    persist();
    throw new Error(
      "No terminal broker receipt was returned; inspect and do not retry.",
    );
  }

  let queueResult: PublicQueueJob;
  try {
    const terminalLine = terminalLines[0];
    assert.ok(terminalLine);
    queueResult = parsePublicQueueJob(
      JSON.parse(terminalLine.slice("FMCAD_QUEUE_RESULT ".length)) as unknown,
      "Fixed import terminal queue result",
    );
  } catch (error) {
    uncertain = true;
    row.status = "unknown";
    persist();
    throw new Error(
      "Malformed terminal queue receipt; inspect and do not retry: " +
        errorMessage(error),
    );
  }
  const acceptedLine = jobLines[0];
  if (jobLines.length === 1 && acceptedLine) {
    const accepted = asRecord(
      JSON.parse(acceptedLine.slice("FMCAD_QUEUE_JOB ".length)) as unknown,
      "Accepted fixed import job",
    );
    assert.equal(typeof accepted["jobId"], "string");
    row.jobId = accepted["jobId"] as string;
  } else row.jobId = null;
  row.queueResult = queueResult;
  const terminalFailure =
    queueResult.code || String(queueResult.operationResult["code"] || "");
  if (
    queueResult.state === "failed" &&
    admissionFailure.test(terminalFailure)
  ) {
    blockedReason = terminalFailure;
    row.status = "blocked-before-native";
    persist();
    throw new Error(
      "The exact source lifecycle/grant rejected the fixed run before method execution.",
    );
  }
  // A method-level status=unknown (the known COTS material limit) is not an
  // executionOutcome=unknown. The shared GM12 classifier deliberately checks
  // the receipt/envelope root and ignores nested domain status fields.
  if (isExecutionUnknown(queueResult)) {
    uncertain = true;
    row.status = "unknown";
    persist();
    throw new Error(
      "Queue returned a pending/unknown execution outcome; do not replay.",
    );
  }
  assert.equal(queueResult.state, "succeeded", stderr || stdout);
  const markers = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("FMCAD_RESULT "));
  if (markers.length !== 1) {
    uncertain = true;
    row.status = "unknown";
    persist();
    throw new Error(
      "The fixed run returned no single result marker; inspect and do not replay.",
    );
  }
  const marker = markers[0];
  assert.ok(marker);
  const envelope = parseFixedEnvelope(
    JSON.parse(marker.slice("FMCAD_RESULT ".length)) as unknown,
  );
  if (isExecutionUnknown(envelope)) {
    uncertain = true;
    row.status = "unknown";
    persist();
    throw new Error("Fixed-run execution is pending/unknown; do not replay.");
  }
  assert.equal(result.status, 0, stderr || stdout);
  assert.equal(envelope.success, true, stdout);
  assert.deepEqual(
    envelope.helperCallsOnly.map((call: HelperCall) => call.operation),
    expectedHelperOperations,
  );
  assert.ok(
    envelope.helperCallsOnly.every(
      (call: HelperCall) =>
        call.status === "completed" && call.effects === "observed",
    ),
    "Every fixed helper call requires a settled native observation.",
  );
  row.status = "execution-settled";
  row.jobId = row.jobId || queueResult.id || null;
  report.execution = { queueState: queueResult.state, queueResult, envelope };
  report.runStatus = "execution-succeeded";
  validateFixedResult(envelope, fusionVersion);
  row.status = "native-effects-verified-with-domain-unknown";
  report.nativeRun = {
    requestId,
    jobId: row.jobId,
    queueState: queueResult.state,
    fixtureId: installed.fixture.fixtureId,
    manifestSha256: installed.fixture.manifestSha256,
    scriptSha256: installed.fixture.scriptSha256,
    buildHash: installed.buildHash,
  };
  persist();
  return envelope.result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function main(): void {
  persist();
  try {
    runFixedProgram();
  } catch (error) {
    const caught = error instanceof Error ? error : new Error(String(error));
    failure ||= caught;
    if (!nativeAttempted && !blockedReason) blockedReason = caught.message;
    report.status = uncertain
      ? "execution-unknown"
      : blockedReason
        ? "blocked-before-native"
        : "failed";
    report.error = errorStack(caught);
    if (blockedReason) report.blockedReason = blockedReason;
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  persist();
  console.log(`REPORT ${reportPath}`);
  if (failure)
    console.error(`DATA-IMPORT fixed run ${report.status}: ${failure.message}`);
  else
    console.log(
      "DATA-IMPORT native effects verified; COTS material remains unknown; exact document close/restore is still required.",
    );
}

if (require.main === module) main();
