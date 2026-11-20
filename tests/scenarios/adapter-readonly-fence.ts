import assert from "node:assert/strict";
import { record, text } from "./contracts";
import type { OwnedUnsavedFixtureProof } from "./fixture-provenance";

/** The bridge does not expose cloud file identity; the final full snapshot does. */
export function assertAdapterBridge(
  beforeValue: unknown,
  currentValue: unknown,
  proofs: ReadonlyMap<string, OwnedUnsavedFixtureProof>,
): void {
  assert.ok(Array.isArray(beforeValue));
  assert.ok(Array.isArray(currentValue));
  const before = beforeValue.map(record);
  const current = currentValue.map(record);
  const ids = current.map((row) => text(row["creationId"]));
  assert.equal(
    new Set(ids).size,
    ids.length,
    "Duplicate bridge document identity",
  );
  const baselineIds = new Set(before.map((row) => text(row["creationId"])));
  let expectedCount = before.length;
  for (const row of before) {
    const id = text(row["creationId"]);
    const found = current.find((entry) => entry["creationId"] === id);
    const proof = proofs.get(id);
    if (!found) {
      assert.equal(
        proof?.state,
        "closed",
        "Document disappeared without its close receipt",
      );
      expectedCount--;
    } else if (!proof) {
      for (const key of ["name", "isSaved", "isModified"])
        assert.equal(
          found[key],
          row[key],
          `Unowned document changed: ${id}/${key}`,
        );
    }
  }
  for (const row of current) {
    const id = text(row["creationId"]);
    const proof = proofs.get(id);
    if (!baselineIds.has(id)) {
      assert.ok(proof, "New bridge document lacks canonical peer provenance");
      expectedCount++;
    }
    if (proof) {
      assert.notEqual(proof.state, "closed", "Closed peer is still present");
      assert.equal(
        row["name"],
        proof.state === "saved"
          ? proof.savedDocument.name
          : proof.document.name,
        "Peer identity was renamed",
      );
      assert.equal(
        row["isSaved"],
        proof.state === "saved",
        "Peer save state lacks its receipt",
      );
    }
  }
  assert.equal(
    current.length,
    expectedCount,
    "Bridge count differs from receipt-bound inventory",
  );
}

export function assertAdapterActive(
  before: unknown,
  after: unknown,
  proofs: ReadonlyMap<string, OwnedUnsavedFixtureProof>,
): void {
  if (before === after) return;
  assert.ok(
    (typeof before === "string" && proofs.has(before)) ||
      (typeof after === "string" && proofs.has(after)),
    "Active document changed without canonical peer provenance",
  );
}

/** Check the adapter's own SDK turn, rather than forbidding peer SDK turns. */
export function adapterReadonlyFence(source: string): string {
  return `${source}

import adsk.core as _adapter_fence_core
def _adapter_fence_snapshot() -> object:
    app = _adapter_fence_core.Application.get()
    return (
        sorted([(d.creationId, d.name, d.isSaved, d.isModified,
                 d.dataFile.id if d.dataFile else None) for d in app.documents]),
        app.activeDocument.creationId if app.activeDocument else None,
    )

_adapter_fence_original = run
def _adapter_fenced_run(_context: str):
    before = _adapter_fence_snapshot()
    try:
        return _adapter_fence_original(_context)
    finally:
        assert _adapter_fence_snapshot() == before, "Adapter changed documents during its SDK turn"
run = _adapter_fenced_run
`;
}
