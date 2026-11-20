import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseDocumentSnapshot } from "../import-result-contracts";
import type {
  LiveDocumentSnapshot,
  LiveDocumentState,
} from "../live-import-receipts";
import { record, text, type Owner } from "./contracts";
import {
  assertOwnedUnsavedDocument,
  discoverOwnedUnsavedFixtureProofs,
  type OwnedUnsavedFixtureProof,
} from "./fixture-provenance";
import { marker } from "./programs";

export interface ImportBaseline {
  readonly original: LiveDocumentSnapshot;
  readonly protectedDocuments: LiveDocumentState[];
}

/** Keep the complete active reference separate from the protected inventory. */
export function parseImportBaseline(
  owner: Owner,
  coordinatorValue: unknown,
  intentValue: unknown,
  resultValue: unknown,
  proofs: ReadonlyMap<string, OwnedUnsavedFixtureProof>,
): ImportBaseline {
  const coordinator = record(coordinatorValue),
    intent = record(intentValue),
    result = record(resultValue),
    before = record(coordinator["before"]),
    clientId = `scenario:${owner.runId}:coordinator`,
    requestId = clientId + ":before",
    receipt = record(result["brokerReceipt"]),
    operation = record(receipt["operationResult"]);
  assert.equal(coordinator["runId"], owner.runId);
  assert.ok(Array.isArray(coordinator["scenarioIds"]));
  assert.ok(coordinator["scenarioIds"].includes(owner.scenarioId));
  assert.equal(owner.clientId, `scenario:${owner.runId}:${owner.scenarioId}`);
  assert.equal(intent["phase"], "before");
  for (const row of [intent, result, receipt, operation])
    assert.equal(row["requestId"], requestId);
  assert.equal(receipt["clientId"], clientId);
  assert.equal(result["state"], "succeeded");
  assert.equal(result["sdkSettled"], true);
  assert.equal(receipt["state"], "succeeded");
  assert.equal(operation["acceptance"], "accepted");
  assert.equal(operation["executionOutcome"], "succeeded");
  assert.equal(operation["jobId"], text(receipt["jobId"]));
  const lines = text(result["stdout"])
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(marker));
  assert.equal(lines.length, 1);
  const raw = record(JSON.parse(lines[0]!.slice(marker.length)) as unknown);
  assert.equal(raw["active"], before["active"]);
  const original = parseDocumentSnapshot(
    { documents: raw["documents"], activeCreationId: raw["active"] },
    "Original pre-creation inventory",
  );
  assert.ok(Array.isArray(before["documents"]));
  const originalById = new Map(
    original.documents.map((row) => [row.creationId, row]),
  );
  const protectedIds = new Set<string>();
  const protectedDocuments = before["documents"].map((value) => {
    const row = record(value),
      id = text(row["creationId"]),
      originalRow = originalById.get(id);
    assert.ok(!protectedIds.has(id), "Duplicate protected document");
    protectedIds.add(id);
    assert.ok(
      originalRow,
      "Protected document is absent from original receipt",
    );
    assert.deepEqual(
      row,
      originalRow,
      "Protected document differs from original receipt",
    );
    return originalRow;
  });
  // Only excluded, actually observed peers may explain the projection. In
  // particular, a later proof cannot exempt a protected document from its guard.
  const peerProofs = new Map(
    [...proofs].filter(([id, proof]) => {
      const visibleId =
        proof.state === "saved" ? proof.savedDocument.creationId : id;
      return (
        (originalById.has(visibleId) && !protectedIds.has(visibleId)) ||
        (originalById.has(id) && !protectedIds.has(id))
      );
    }),
  );
  // This is a historical observation, not a current inventory assertion. A
  // peer's later close does not erase its earlier authenticated presence.
  for (const row of original.documents) {
    if (protectedIds.has(row.creationId)) continue;
    const proof = [...peerProofs.values()].find(
      (candidate) =>
        candidate.document.creationId === row.creationId ||
        (candidate.state === "saved" &&
          candidate.savedDocument.creationId === row.creationId),
    );
    assert.ok(proof, "Original import peer lacks exact provenance");
    if (proof.state === "saved") {
      assert.notEqual(
        proof.savedState,
        "unsettled",
        "Original import peer is unsettled",
      );
      if (row.saved) {
        assert.equal(row.creationId, proof.savedDocument.creationId);
        assert.equal(row.name, proof.savedDocument.name);
        assert.equal(row.fileId, proof.savedDocument.file.fileId);
      } else {
        assertOwnedUnsavedDocument([row], proof.document);
      }
    } else {
      assert.notEqual(
        proof.state,
        "unsettled",
        "Original import peer is unsettled",
      );
      assertOwnedUnsavedDocument([row], proof.document);
    }
  }
  if (
    original.activeCreationId !== null &&
    !protectedIds.has(original.activeCreationId)
  ) {
    const proof = [...peerProofs.values()].find(
      (candidate) =>
        candidate.document.creationId === original.activeCreationId ||
        (candidate.state === "saved" &&
          candidate.savedDocument.creationId === original.activeCreationId),
    );
    assert.ok(
      proof?.state === "open" ||
        proof?.state === "closed" ||
        (proof?.state === "saved" && proof.savedState !== "unsettled"),
      "Filtered original active document lacks exact settled peer provenance",
    );
  }
  return { original, protectedDocuments };
}

export function readImportBaseline(
  directory: string,
  owner: Owner,
  backendIdentity: string,
): ImportBaseline {
  const root = path.dirname(directory);
  const read = (file: string): unknown => {
    const fd = fs.openSync(
      path.join(root, file),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const stat = fs.fstatSync(fd);
      assert.ok(stat.isFile() && stat.size <= 16 * 1024 * 1024);
      return JSON.parse(fs.readFileSync(fd, "utf8")) as unknown;
    } finally {
      fs.closeSync(fd);
    }
  };
  const coordinator = record(read("index.json"));
  assert.equal(coordinator["backendIdentity"], backendIdentity);
  const mode = coordinator["mode"],
    protocol = coordinator["protocol"];
  assert.ok(mode === "fusion" || mode === "simulator");
  assert.ok(protocol === "addin" || protocol === "mcp");
  assert.equal(coordinator["qualification"], "broker");
  return parseImportBaseline(
    owner,
    coordinator,
    read("_coordinator/before.intent.json"),
    read("_coordinator/before.result.json"),
    discoverOwnedUnsavedFixtureProofs(path.dirname(root), {
      mode,
      protocol,
      qualification: "broker",
      identity: backendIdentity,
    }),
  );
}
