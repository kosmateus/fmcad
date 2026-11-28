import test from "node:test";
import assert from "node:assert/strict";
import {
  successfulImportComputation,
  successfulDrawingComputation,
} from "../../packages/core/src/application/local-pipeline";

const unresolved = {
  operation: "catalog.check",
  success: true,
  status: "unknown",
  documentIdentity: null,
  mutation: false,
  modelValidated: false,
};
test("local ledger completion does not promote unknown evidence to model acceptance", () => {
  assert.equal(successfulImportComputation("catalog.check", unresolved), true);
  assert.equal(unresolved.status, "unknown");
  assert.equal(unresolved.modelValidated, false);
  assert.equal(
    successfulImportComputation("placement.check", {
      ...unresolved,
      operation: "placement.check",
    }),
    true,
  );
});
test("local ledger exception excludes failure mutation document and execution uncertainty", () => {
  for (const change of [
    { success: false },
    { status: "fail" },
    { status: "failed" },
    { status: "blocked" },
    { mutation: true },
    { modelValidated: true },
    { documentIdentity: { creationId: "owned" } },
    { operation: "catalog.import" },
    { outcome: "unknown" },
    { executionOutcome: "unknown" },
  ])
    assert.equal(
      successfulImportComputation("catalog.check", {
        ...unresolved,
        ...change,
      }),
      false,
    );
  for (const operation of [
    undefined,
    "catalog.import",
    "placement.import",
    "batch.reconcile",
    "batch.finalize",
    "shape.box",
  ])
    assert.equal(successfulImportComputation(operation, unresolved), false);
});

test("external drawing completion retains source uncertainty and excludes native or failed outcomes", () => {
  const drawing = {
    schemaVersion: 1,
    operation: "drawing.package",
    success: true,
    status: "unknown",
    frame: "sheet",
    associativity: "snapshot",
    nativeAcceptance: "notEvaluated",
  };
  assert.equal(successfulDrawingComputation("drawing.package", drawing), true);
  for (const change of [
    { success: false },
    { status: "blocked" },
    { status: "fail" },
    { frame: "component" },
    { associativity: "native" },
    { nativeAcceptance: "pass" },
    { outcome: "unknown" },
    { executionOutcome: "unknown" },
  ])
    assert.equal(
      successfulDrawingComputation("drawing.package", {
        ...drawing,
        ...change,
      }),
      false,
    );
  assert.equal(successfulDrawingComputation("shape.box", drawing), false);
});
