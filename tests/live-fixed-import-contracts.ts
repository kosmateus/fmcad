import assert from "node:assert/strict";
import { asArray, asRecord, type JsonRecord } from "./live-import-receipts.js";

/** Pure validation used unchanged by the retained native runner and offline fault cases. */
export interface FixtureContract extends JsonRecord {
  fixtureId: string;
  kind: string;
  helperVersion: string;
  script: string;
  scriptSha256: string;
  manifestSha256: string;
}

export interface RuntimeBuild {
  fingerprint: string;
}

export interface MethodResult extends JsonRecord {
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

export interface NativeCall extends JsonRecord {
  operation: string;
  result: MethodResult;
}

export interface HelperCall extends JsonRecord {
  operation: string;
  status: string;
  effects: string;
}

export interface NativeDocumentStatus extends JsonRecord {
  creationId: string;
  name: string;
  saved: boolean;
  modified: boolean;
  fileId: string | null;
}

export interface ParameterRow extends JsonRecord {
  name: string;
  expression: string;
  value: number;
}

export interface CatalogInstance extends JsonRecord {
  id: string;
}

export interface PlacementRow extends JsonRecord {
  status: string;
  actual: number[];
}

export interface CotsReadback extends JsonRecord {
  materialStatus: string;
  oldPath: string;
  newPath: string;
  sourceVolumeMm3: number;
  replacementVolumeMm3: number;
}

export interface FixedPayload extends JsonRecord {
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

export interface FixedEnvelope {
  success: boolean;
  result: FixedPayload;
  helperCallsOnly: HelperCall[];
}

export function parseFixtureContract(value: unknown): FixtureContract {
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

export function parseRuntimeBuild(value: unknown): RuntimeBuild {
  const row = asRecord(value, "Runtime build manifest");
  assert.equal(typeof row["fingerprint"], "string");
  return { fingerprint: row["fingerprint"] as string };
}

export function parseDocumentStatus(
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

export function parseMethodResult(value: unknown, label: string): MethodResult {
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

export function parseFixedPayload(value: unknown): FixedPayload {
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

export function parseFixedEnvelope(value: unknown): FixedEnvelope {
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

export function methodCall(
  payload: FixedPayload,
  operation: string,
): MethodResult {
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
