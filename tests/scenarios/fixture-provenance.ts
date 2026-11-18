import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { childProcessIdentity } from "./legacy-handoff";
import { record, text } from "./contracts";
import type { Document, Owner, SavedFile, ScenarioBackend } from "./contracts";
import { marker } from "./programs";
import { savedIdentityTransition } from "./saved-identity";
import {
  recoveredFile,
  resultValue,
  saveIntent,
  type RequestEvidence,
} from "./saved-files";

export interface ProcessIdentity {
  readonly pid: number;
  readonly birth: string;
}

type FixtureState = "open" | "closed" | "unsettled";
export type OwnedUnsavedFixtureProof =
  | { readonly document: Document; readonly state: FixtureState }
  | {
      readonly document: Document;
      readonly state: "saved";
      readonly savedDocument: Document & { readonly file: SavedFile };
      readonly savedState: FixtureState;
    };

export function currentProcessIdentity(): ProcessIdentity {
  return {
    pid: process.pid,
    birth: childProcessIdentity.processBirth(),
  };
}

export function exactScenarioRequestId(
  requestId: string,
  clientId: string,
): boolean {
  const sequence = requestId.slice(clientId.length + 1),
    number = Number(sequence);
  return (
    requestId === clientId + ":" + sequence &&
    /^(0|[1-9]\d*)$/u.test(sequence) &&
    Number.isSafeInteger(number) &&
    String(number) === sequence
  );
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
): OwnedUnsavedFixtureProof | undefined {
  try {
    const runId = path.basename(runRoot),
      directory = path.join(runRoot, scenarioId),
      index = readJson(path.join(runRoot, "index.json"));
    if (
      !/^[a-f0-9-]{36}$/u.test(runId) ||
      index["runId"] !== runId ||
      index["mode"] !== backend.mode ||
      index["qualification"] !== backend.qualification ||
      index["protocol"] !== backend.protocol ||
      index["backendIdentity"] !== backend.identity ||
      !Array.isArray(index["scenarioIds"]) ||
      !index["scenarioIds"].includes(scenarioId)
    )
      return undefined;

    const report = readJson(path.join(directory, "report.json")),
      owner = record(report["owner"]),
      requests = report["requests"];
    if (
      path.resolve(text(report["directory"])) !== path.resolve(directory) ||
      owner["runId"] !== runId ||
      owner["scenarioId"] !== scenarioId ||
      owner["clientId"] !== "scenario:" + runId + ":" + scenarioId ||
      !["running", "passed", "failed"].includes(String(report["status"])) ||
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
    const requestIds = requests.map((value: unknown) =>
      text(record(value)["requestId"]),
    );
    if (
      new Set(requestIds).size !== requestIds.length ||
      requestIds.some(
        (requestId) =>
          !exactScenarioRequestId(requestId, text(owner["clientId"])),
      )
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
      requestId !== owner["clientId"] + ":0" ||
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
    const typedOwner: Owner = {
        runId,
        scenarioId,
        clientId: text(owner["clientId"]),
      },
      evidence = requests as readonly RequestEvidence[],
      transition = savedIdentityTransition(
        directory,
        document,
        typedOwner,
        evidence,
      );
    if (transition) {
      assert.deepEqual(report["savedIdentityTransition"], transition);
      assert.equal(documentValue["creationId"], transition.creationId);
      assert.equal(documentValue["name"], transition.name);
      assert.ok(
        !baseline["documents"].some(
          (value: unknown) =>
            record(value)["creationId"] === transition.creationId,
        ),
        "Saved successor already belonged to the creator baseline",
      );
      return savedFixtureProof(
        directory,
        index,
        report,
        document,
        typedOwner,
        evidence,
        text(receipt["jobId"]),
      );
    }
    if (
      report["savedIdentityTransition"] !== undefined ||
      documentValue["creationId"] !== document.creationId ||
      documentValue["name"] !== document.name ||
      documentValue["file"] !== undefined
    )
      return undefined;
    if (requests.some((entry) => entry["phase"] === "save"))
      return Object.freeze({
        document: Object.freeze(document),
        state: "unsettled",
      });
    const cleanupEntries = requests
      .map(record)
      .filter((entry) => entry["phase"] === "cleanup");
    let state: FixtureState;
    if (
      report["cleanupHold"] === undefined &&
      cleanupEntries.length === 1 &&
      exactClosedFixtureReceipt(
        cleanupEntries[0]!,
        owner,
        document.creationId,
        text(receipt["jobId"]),
      )
    ) {
      state = "closed";
    } else if (
      report["cleanup"] === "pending" &&
      report["cleanupHold"] === undefined &&
      index["status"] === "running" &&
      activeProcess(index) &&
      (cleanupEntries.length === 0 ||
        (cleanupEntries.length === 1 &&
          exactPendingCleanupIntent(cleanupEntries[0]!, owner)))
    ) {
      state = "open";
    } else {
      state = "unsettled";
    }
    return Object.freeze({ document: Object.freeze(document), state });
  } catch {
    return undefined;
  }
}

function savedFixtureProof(
  directory: string,
  index: Record<string, unknown>,
  report: Record<string, unknown>,
  original: Document,
  owner: Owner,
  requests: readonly RequestEvidence[],
  creationJobId: string,
): OwnedUnsavedFixtureProof {
  const partial = (): OwnedUnsavedFixtureProof =>
    Object.freeze({ document: Object.freeze(original), state: "unsettled" });
  const declared = record(report["document"]);
  if (declared["file"] === undefined) return partial();
  const document = {
      creationId: text(declared["creationId"]),
      name: text(declared["name"]),
    },
    folder = saveIntent(directory, original, owner, requests);
  assert.ok(folder, "Saved successor lacks its original save intent");
  assert.deepEqual(report["fixture"], folder);
  const save = requests.find((entry) => entry.phase === "save");
  assert.ok(save?.result?.brokerReceipt);
  const jobs = new Set([creationJobId, save.result.brokerReceipt.jobId]),
    readbacks = requests.filter((entry) => entry.phase === "save-observe");
  assert.equal(jobs.size, 2, "Save reused the original creation job");
  if (!readbacks.length) return partial();
  for (const entry of readbacks) {
    const result = entry.result;
    if (!result?.sdkSettled || result.state !== "succeeded") return partial();
    assert.equal(result.requestId, entry.requestId);
    assert.ok(exactScenarioRequestId(entry.requestId, owner.clientId));
    assert.ok(
      Number(entry.requestId.slice(owner.clientId.length + 1)) >
        Number(save.requestId.slice(owner.clientId.length + 1)),
    );
    assert.equal(record(record(entry)["intent"])["kind"], "script");
    const receipt = record(result.brokerReceipt);
    assert.equal(receipt["requestId"], entry.requestId);
    assert.equal(receipt["clientId"], owner.clientId);
    assert.equal(receipt["state"], "succeeded");
    const jobId = text(receipt["jobId"]);
    assert.ok(!jobs.has(jobId), "Saved readback reused another lifecycle job");
    jobs.add(jobId);
    const value = resultValue(entry);
    assert.ok(value);
    assert.equal(value["creationId"], document.creationId);
    if (value["fileId"] !== undefined || value["complete"] === true)
      assert.equal(value["saved"], true);
  }
  const file = recoveredFile(document, folder, requests);
  if (!file) return partial();
  // Version is pinned by the producer readback, not re-measured by inventory.
  assert.deepEqual(declared["file"], file);
  const savedDocument = Object.freeze({ ...document, file }),
    closeEntries = requests.filter((entry) => entry.phase === "cleanup-close");
  let savedState: FixtureState;
  if (
    report["cleanupHold"] === undefined &&
    closeEntries.length === 1 &&
    exactClosedFixtureReceipt(
      record(closeEntries[0]),
      record(owner),
      savedDocument.creationId,
      creationJobId,
      "cleanup-close",
    )
  ) {
    assert.ok(!jobs.has(text(closeEntries[0]!.result?.brokerReceipt?.jobId)));
    savedState = "closed";
  } else if (
    report["cleanup"] === "pending" &&
    report["cleanupHold"] === undefined &&
    index["status"] === "running" &&
    activeProcess(index) &&
    (closeEntries.length === 0 ||
      (closeEntries.length === 1 &&
        exactPendingCleanupIntent(
          record(closeEntries[0]),
          record(owner),
          "cleanup-close",
        )))
  ) {
    savedState = "open";
  } else savedState = "unsettled";
  return Object.freeze({
    document: Object.freeze(original),
    state: "saved",
    savedDocument,
    savedState,
  });
}

function exactClosedFixtureReceipt(
  entry: Record<string, unknown>,
  owner: Record<string, unknown>,
  creationId: string,
  creationJobId: string,
  phase: "cleanup" | "cleanup-close" = "cleanup",
): boolean {
  try {
    const clientId = text(owner["clientId"]),
      requestId = text(entry["requestId"]),
      sequence = requestId.slice(clientId.length + 1),
      result = record(entry["result"]),
      receipt = record(result["brokerReceipt"]),
      lines = text(result["stdout"])
        .split(/\r?\n/u)
        .filter((line) => line.startsWith(marker));
    if (
      !exactScenarioRequestId(requestId, clientId) ||
      requestId !== clientId + ":" + sequence ||
      requestId === clientId + ":0" ||
      entry["phase"] !== phase ||
      record(entry["intent"])["kind"] !== "script" ||
      result["requestId"] !== requestId ||
      result["state"] !== "succeeded" ||
      result["sdkSettled"] !== true ||
      result["mayHaveMutated"] !== true ||
      receipt["requestId"] !== requestId ||
      receipt["clientId"] !== clientId ||
      receipt["state"] !== "succeeded" ||
      typeof receipt["jobId"] !== "string" ||
      !receipt["jobId"] ||
      receipt["jobId"] === creationJobId ||
      lines.length !== 1
    )
      return false;
    const closed = record(
      JSON.parse(lines[0]!.slice(marker.length)) as unknown,
    );
    return closed["creationId"] === creationId && closed["closed"] === true;
  } catch {
    return false;
  }
}

function exactPendingCleanupIntent(
  entry: Record<string, unknown>,
  owner: Record<string, unknown>,
  phase: "cleanup" | "cleanup-close" = "cleanup",
): boolean {
  try {
    const clientId = text(owner["clientId"]),
      requestId = text(entry["requestId"]);
    return (
      entry["phase"] === phase &&
      record(entry["intent"])["kind"] === "script" &&
      entry["result"] === undefined &&
      exactScenarioRequestId(requestId, clientId) &&
      requestId !== clientId + ":0"
    );
  } catch {
    return false;
  }
}

/** Read exact creation and cleanup receipts from existing scenario reports. */
export function discoverOwnedUnsavedFixtureProofs(
  root: string,
  backend: Pick<
    ScenarioBackend,
    "identity" | "mode" | "qualification" | "protocol"
  >,
): ReadonlyMap<string, OwnedUnsavedFixtureProof> {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Expected a regular scenario artifact root");
  const fixtures = new Map<string, OwnedUnsavedFixtureProof>(),
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
      if (!document || ambiguous.has(document.document.creationId)) continue;
      if (fixtures.has(document.document.creationId)) {
        fixtures.delete(document.document.creationId);
        ambiguous.add(document.document.creationId);
      } else fixtures.set(document.document.creationId, document);
    }
  }
  return fixtures;
}

/** Read currently open, receipt-bound fixtures for callers that need live peers. */
export function discoverOwnedUnsavedFixtures(
  root: string,
  backend: Pick<
    ScenarioBackend,
    "identity" | "mode" | "qualification" | "protocol"
  >,
): ReadonlyMap<string, Document> {
  return new Map(
    [...discoverOwnedUnsavedFixtureProofs(root, backend)]
      .filter(([, proof]) => proof.state === "open")
      .map(([creationId, proof]) => [creationId, proof.document]),
  );
}

function documentRows(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), "Missing document inventory");
  const documents = value.map(record),
    ids = documents.map((document) => text(document["creationId"]));
  assert.equal(new Set(ids).size, ids.length, "Duplicate document identity");
  return documents;
}

function stableDocuments(documents: Record<string, unknown>[]) {
  return documents
    .map((document) => {
      const stable = { ...document };
      delete stable["active"];
      return stable;
    })
    .sort((left, right) =>
      text(left["creationId"]).localeCompare(text(right["creationId"])),
    );
}

function assertSavedDocument(
  current: Record<string, unknown>[],
  expected: Document & { readonly file: SavedFile },
): void {
  const matches = current.filter(
    (document) => document["creationId"] === expected.creationId,
  );
  assert.equal(
    matches.length,
    1,
    "Exact saved successor is missing or duplicated",
  );
  assert.equal(matches[0]!["name"], expected.name);
  assert.equal(matches[0]!["saved"], true);
  assert.equal(matches[0]!["fileId"], expected.file.fileId);
}

function observedTransfer(
  creationId: string,
  current: Record<string, unknown>[],
  proofs: ReadonlyMap<string, OwnedUnsavedFixtureProof>,
  allowUnsettled: boolean,
): boolean {
  const proof = [...proofs.values()].find(
    (candidate) =>
      candidate.state === "saved" &&
      (candidate.document.creationId === creationId ||
        candidate.savedDocument.creationId === creationId),
  );
  if (proof?.state !== "saved") return false;
  if (proof.savedState === "closed")
    return !current.some(
      (document) =>
        document["creationId"] === proof.document.creationId ||
        document["creationId"] === proof.savedDocument.creationId,
    );
  if (
    creationId !== proof.document.creationId ||
    creationId === proof.savedDocument.creationId ||
    (proof.savedState !== "open" && !allowUnsettled)
  )
    return false;
  assertSavedDocument(current, proof.savedDocument);
  return true;
}

/** Check causality inside one SDK turn while retaining baseline and target identity. */
export function assertFencedDocumentInventory(
  beforeValue: unknown,
  afterValue: unknown,
  target: Document,
  baselineValue: unknown,
  verifiedPeers: ReadonlyMap<string, OwnedUnsavedFixtureProof>,
  message: string,
): void {
  const before = documentRows(beforeValue),
    after = documentRows(afterValue),
    proofs = new Map(verifiedPeers),
    peerTarget = proofs.get(target.creationId);
  if (peerTarget) {
    assert.deepEqual(
      peerTarget.document,
      target,
      "Owned target conflicts with peer receipt",
    );
    assert.equal(peerTarget.state, "open", "Owned target has a close receipt");
  }
  proofs.set(target.creationId, { document: target, state: "open" });
  assertOwnedUnsavedDocument(before, target);
  assertOwnedUnsavedDocument(after, target);
  assertReceiptBoundDocumentInventory(baselineValue, before, proofs, message);
  assertReceiptBoundDocumentInventory(baselineValue, after, proofs, message);
  assert.deepEqual(
    stableDocuments(
      before.filter((document) => document["creationId"] !== target.creationId),
    ),
    stableDocuments(
      after.filter((document) => document["creationId"] !== target.creationId),
    ),
    message,
  );
}

/** Check an unsaved owned close against the same-turn pre/post inventory fence. */
export function assertFencedClosedDocumentInventory(
  beforeValue: unknown,
  afterValue: unknown,
  target: Document,
  message: string,
): void {
  const before = documentRows(beforeValue),
    after = documentRows(afterValue);
  assertOwnedUnsavedDocument(before, target);
  assert.equal(
    after.some((document) => document["creationId"] === target.creationId),
    false,
    "Owned fixture remains open after cleanup",
  );
  const beforeOthers = before.filter(
    (document) => document["creationId"] !== target.creationId,
  );
  assert.deepEqual(
    stableDocuments(beforeOthers),
    stableDocuments(after),
    message,
  );
}

/** Admit only exact live peer fixtures or fixtures closed by their exact receipt. */
export function assertReceiptBoundDocumentInventory(
  beforeValue: unknown,
  currentValue: unknown,
  proofs: ReadonlyMap<string, OwnedUnsavedFixtureProof>,
  message: string,
  allowVisibleUnsettledPeers = false,
  observedCreationIds: ReadonlySet<string> = new Set(),
): void {
  const before = documentRows(beforeValue),
    current = documentRows(currentValue);
  for (const creationId of observedCreationIds) {
    if (
      !current.some((document) => document["creationId"] === creationId) &&
      !observedTransfer(creationId, current, proofs, allowVisibleUnsettledPeers)
    )
      assert.equal(
        proofs.get(creationId)?.state,
        "closed",
        "An observed fixture disappeared without its exact close receipt",
      );
  }
  const admittedPeers = new Set<string>();
  for (const [creationId, proof] of proofs) {
    assert.equal(proof.document.creationId, creationId);
    if (proof.state === "saved") {
      const successorId = proof.savedDocument.creationId;
      if (creationId !== successorId)
        assert.equal(
          current.some((document) => document["creationId"] === creationId),
          false,
          "Both original and saved successor identities remain visible",
        );
      if (proof.savedState === "closed") {
        assert.equal(
          current.some((document) => document["creationId"] === successorId),
          false,
          "The receipt-closed saved successor remains visible",
        );
      } else if (
        proof.savedState === "unsettled" &&
        (!allowVisibleUnsettledPeers ||
          !current.some((document) => document["creationId"] === successorId))
      ) {
        continue;
      } else assertSavedDocument(current, proof.savedDocument);
      admittedPeers.add(creationId);
      admittedPeers.add(successorId);
      continue;
    }
    // An unresolved baseline fixture has no ownership exemption. A read-only
    // observer may admit a new peer only while its exact identity is visible.
    if (proof.state === "unsettled") {
      if (
        !allowVisibleUnsettledPeers ||
        before.some((document) => document["creationId"] === creationId)
      )
        continue;
      // Historical creation receipts are not evidence that a fixture was ever
      // visible in this run. Prior observations above still fence disappearance.
      if (!current.some((document) => document["creationId"] === creationId))
        continue;
      assert.equal(
        current.filter((document) => document["creationId"] === creationId)
          .length,
        1,
        "An unsettled peer disappeared without its exact close receipt",
      );
      assertOwnedUnsavedDocument(current, proof.document);
      admittedPeers.add(creationId);
      continue;
    }
    if (proof.state !== "open" && proof.state !== "closed") continue;
    admittedPeers.add(creationId);
    const matches = current.filter(
      (document) => document["creationId"] === creationId,
    );
    if (proof.state === "closed") {
      assert.equal(matches.length, 0, "A closed peer fixture remains open");
      continue;
    }
    assert.equal(matches.length, 1, "A live receipt-proven fixture is missing");
    assertOwnedUnsavedDocument(current, proof.document);
  }
  assert.deepEqual(
    stableDocuments(
      current.filter(
        (document) => !admittedPeers.has(text(document["creationId"])),
      ),
    ),
    stableDocuments(
      before.filter(
        (document) => !admittedPeers.has(text(document["creationId"])),
      ),
    ),
    message,
  );
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
  assert.deepEqual(
    stableDocuments(
      current.filter((document) => !owned.has(text(document["creationId"]))),
    ),
    stableDocuments(
      before.filter((document) => !owned.has(text(document["creationId"]))),
    ),
    message,
  );
}
