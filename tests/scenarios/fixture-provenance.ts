import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { childProcessIdentity } from "./legacy-handoff";
import { record, text } from "./contracts";
import type { Document, ScenarioBackend } from "./contracts";
import { marker } from "./programs";

export interface ProcessIdentity {
  readonly pid: number;
  readonly birth: string;
}

export function currentProcessIdentity(): ProcessIdentity {
  return {
    pid: process.pid,
    birth: childProcessIdentity.processBirth(),
  };
}

function readJson(filename: string): Record<string, unknown> {
  const fd = fs.openSync(
    filename,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("Invalid scenario provenance record");
    return record(JSON.parse(fs.readFileSync(fd, "utf8")) as unknown);
  } finally {
    fs.closeSync(fd);
  }
}

function activeProcess(index: Record<string, unknown>): boolean {
  const value = record(index["processIdentity"]);
  if (
    !Number.isSafeInteger(value["pid"]) ||
    typeof value["birth"] !== "string" ||
    !value["birth"]
  )
    return false;
  return (
    childProcessIdentity.priorProcessAlive({
      pid: value["pid"] as number,
      birth: value["birth"],
    }) === true
  );
}

function verifiedFixture(
  runRoot: string,
  scenarioId: string,
  backend: Pick<
    ScenarioBackend,
    "identity" | "mode" | "qualification" | "protocol"
  >,
): Document | undefined {
  try {
    const runId = path.basename(runRoot),
      directory = path.join(runRoot, scenarioId),
      index = readJson(path.join(runRoot, "index.json"));
    if (
      !/^[a-f0-9-]{36}$/u.test(runId) ||
      index["runId"] !== runId ||
      index["status"] !== "running" ||
      index["mode"] !== backend.mode ||
      index["qualification"] !== backend.qualification ||
      index["protocol"] !== backend.protocol ||
      index["backendIdentity"] !== backend.identity ||
      !Array.isArray(index["scenarioIds"]) ||
      !index["scenarioIds"].includes(scenarioId) ||
      !activeProcess(index)
    )
      return undefined;

    const report = readJson(path.join(directory, "report.json")),
      owner = record(report["owner"]),
      requests = report["requests"];
    if (
      path.resolve(text(report["directory"])) !== path.resolve(directory) ||
      owner["runId"] !== runId ||
      owner["scenarioId"] !== scenarioId ||
      typeof owner["clientId"] !== "string" ||
      !owner["clientId"] ||
      !["running", "passed", "failed"].includes(String(report["status"])) ||
      report["cleanup"] !== "pending" ||
      report["cleanupHold"] !== undefined ||
      !["owned-document", "exclusive-instance"].includes(
        String(report["scope"]),
      ) ||
      report["mode"] !== backend.mode ||
      report["qualification"] !== backend.qualification ||
      report["protocol"] !== backend.protocol ||
      report["backendIdentity"] !== backend.identity ||
      !Array.isArray(requests)
    )
      return undefined;

    const creates = requests
      .map(record)
      .filter((entry) => entry["phase"] === "create");
    if (creates.length !== 1) return undefined;
    const create = creates[0]!,
      requestId = text(create["requestId"]),
      result = record(create["result"]),
      receipt = record(result["brokerReceipt"]);
    if (
      !requestId.startsWith(text(owner["clientId"]) + ":") ||
      record(create["intent"])["kind"] !== "script" ||
      result["requestId"] !== requestId ||
      result["state"] !== "succeeded" ||
      result["sdkSettled"] !== true ||
      result["mayHaveMutated"] !== true ||
      receipt["requestId"] !== requestId ||
      receipt["clientId"] !== owner["clientId"] ||
      receipt["state"] !== "succeeded" ||
      typeof receipt["jobId"] !== "string" ||
      !receipt["jobId"]
    )
      return undefined;

    const lines = text(result["stdout"])
      .split(/\r?\n/u)
      .filter((line) => line.startsWith(marker));
    if (lines.length !== 1) return undefined;
    const identity = record(
      JSON.parse(lines[0]!.slice(marker.length)) as unknown,
    );
    const document: Document = {
      creationId: text(identity["creationId"]),
      name: text(identity["name"]),
    };
    const documentValue = record(report["document"]),
      creation = readJson(path.join(directory, "creation.json")),
      baseline = record(index["before"]);
    if (
      identity["requestId"] !== requestId ||
      identity["clientId"] !== owner["clientId"] ||
      identity["activeCreationId"] !== document.creationId ||
      documentValue["creationId"] !== document.creationId ||
      documentValue["name"] !== document.name ||
      documentValue["file"] !== undefined ||
      creation["creationId"] !== document.creationId ||
      creation["name"] !== document.name ||
      creation["requestId"] !== requestId ||
      creation["clientId"] !== owner["clientId"] ||
      !Array.isArray(baseline["documents"]) ||
      baseline["documents"].some(
        (value: unknown) => record(value)["creationId"] === document.creationId,
      )
    )
      return undefined;
    if (!activeProcess(index)) return undefined;
    return Object.freeze(document);
  } catch {
    return undefined;
  }
}

/** Read only currently running, receipt-bound unsaved fixtures from existing run reports. */
export function discoverOwnedUnsavedFixtures(
  root: string,
  backend: Pick<
    ScenarioBackend,
    "identity" | "mode" | "qualification" | "protocol"
  >,
): ReadonlyMap<string, Document> {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Expected a regular scenario artifact root");
  const fixtures = new Map<string, Document>(),
    ambiguous = new Set<string>();
  for (const runId of fs.readdirSync(root)) {
    if (!/^[a-f0-9-]{36}$/u.test(runId)) continue;
    const runRoot = path.join(root, runId),
      runStat = fs.lstatSync(runRoot);
    if (!runStat.isDirectory() || runStat.isSymbolicLink()) continue;
    let index: Record<string, unknown>;
    try {
      index = readJson(path.join(runRoot, "index.json"));
    } catch {
      continue;
    }
    if (
      !Array.isArray(index["scenarioIds"]) ||
      index["backendIdentity"] !== backend.identity
    )
      continue;
    for (const scenarioId of index["scenarioIds"]) {
      if (
        typeof scenarioId !== "string" ||
        !/^[a-z0-9][a-z0-9_-]{0,100}$/u.test(scenarioId)
      )
        continue;
      const document = verifiedFixture(runRoot, scenarioId, backend);
      if (!document || ambiguous.has(document.creationId)) continue;
      if (fixtures.has(document.creationId)) {
        fixtures.delete(document.creationId);
        ambiguous.add(document.creationId);
      } else fixtures.set(document.creationId, document);
    }
  }
  return fixtures;
}

function documentRows(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), "Missing document inventory");
  const documents = value.map(record),
    ids = documents.map((document) => text(document["creationId"]));
  assert.equal(new Set(ids).size, ids.length, "Duplicate document identity");
  return documents;
}

export function assertOwnedUnsavedDocument(
  value: unknown,
  expected: Document,
  requireActive = false,
): void {
  const matches = documentRows(value).filter(
    (document) => document["creationId"] === expected.creationId,
  );
  assert.equal(
    matches.length,
    1,
    "Exact fixture identity is missing or duplicated",
  );
  assert.equal(
    matches[0]!["name"],
    expected.name,
    "Fixture identity now refers to another document name",
  );
  assert.equal(matches[0]!["saved"], false, "Fixture unexpectedly saved");
  assert.equal(matches[0]!["fileId"], null, "Fixture acquired a cloud file");
  if (requireActive)
    assert.equal(matches[0]!["active"], true, "Fixture is not active");
}

export function originalActiveDocument(
  activeCreationId: unknown,
  baselineValue: unknown,
  owned: ReadonlyMap<string, Document>,
): Document | undefined {
  const baseline = documentRows(baselineValue);
  if (activeCreationId === null || activeCreationId === undefined)
    return undefined;
  const creationId = text(activeCreationId);
  if (owned.has(creationId)) return undefined;
  const matches = baseline.filter(
    (document) => document["creationId"] === creationId,
  );
  assert.equal(
    matches.length,
    1,
    "Original active document is not part of the verified baseline",
  );
  return Object.freeze({
    creationId,
    name: text(matches[0]!["name"]),
  });
}

export function assertPreservedDocumentInventory(
  beforeValue: unknown,
  currentValue: unknown,
  owned: ReadonlyMap<string, Document>,
  message: string,
): void {
  const before = documentRows(beforeValue),
    current = documentRows(currentValue);
  for (const document of current) {
    const creationId = text(document["creationId"]),
      expected = owned.get(creationId);
    if (!expected) continue;
    assert.equal(document["name"], expected.name, "Owned fixture name changed");
    assert.equal(document["saved"], false, "Owned fixture unexpectedly saved");
    assert.equal(
      document["fileId"],
      null,
      "Owned fixture acquired a cloud file",
    );
  }
  const comparable = (documents: Record<string, unknown>[]) =>
    documents
      .filter((document) => !owned.has(text(document["creationId"])))
      .map((document) => {
        const stable = { ...document };
        delete stable["active"];
        return stable;
      })
      .sort((left, right) =>
        text(left["creationId"]).localeCompare(text(right["creationId"])),
      );
  assert.deepEqual(comparable(current), comparable(before), message);
}
