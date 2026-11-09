import path from "node:path";

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const load = createRequire(
  path.join(process.cwd(), "tests/gm12-fixed-result.test.ts"),
);
const saved = load("./fixtures/gm12-fixed-result-classification.json") as {
  origin: {
    kind: string;
    originalJobId: string;
    originalRequestId: string;
    originalReportSha256: string;
  };
  receipt: { state: string; executionOutcome: string; sdkSettled: boolean };
  envelope: {
    success: boolean;
    modelUnchanged: boolean;
    nativeGeometry: boolean;
    results: Record<string, { status: string; success: boolean }>;
  };
};
const { assertFixedMethodResults, isExecutionUnknown } = load(
  "./helpers/gm12-fixed-result",
) as {
  assertFixedMethodResults(
    payload: unknown,
    operations: string[],
    creationId: string,
  ): void;
  isExecutionUnknown(value: unknown): boolean;
};

const operations = [
  "curve.helix",
  "shape.spring",
  "spring.evaluate",
  "spring.configure",
];

test("saved owned GM12 result separates terminal success from an engineering unknown and rejects missing methods", () => {
  assert.equal(saved.origin.kind, "projection-of-owned-result");
  assert.equal(
    saved.origin.originalJobId,
    "0d1a1dee-a0b8-4bb4-a171-352da73e17cd",
  );
  assert.equal(
    saved.origin.originalRequestId,
    "gm12-spring-b486113e-2d64-478b-bb0e-93c2c347713c",
  );
  assert.match(saved.origin.originalReportSha256, /^[a-f0-9]{64}$/);
  assert.equal(saved.receipt.state, "succeeded");
  assert.equal(saved.receipt.executionOutcome, "succeeded");
  assert.equal(saved.receipt.sdkSettled, true);
  assert.equal(saved.envelope.success, true);
  assert.equal(saved.envelope.modelUnchanged, true);
  assert.equal(saved.envelope.nativeGeometry, false);

  assert.equal(isExecutionUnknown(saved.receipt), false);
  assert.equal(
    isExecutionUnknown(saved.envelope),
    false,
    "slenderness.status=unknown is a domain limitation, not an execution outcome",
  );
  assertFixedMethodResults(saved.envelope, operations, "saved-scratch");

  const missingNativeResult = structuredClone(saved.envelope);
  delete missingNativeResult.results["shape.spring"];
  assert.throws(
    () =>
      assertFixedMethodResults(
        missingNativeResult,
        operations,
        "saved-scratch",
      ),
    /missing or added a method result/i,
  );

  const unsupportedNativeResult = structuredClone(saved.envelope);
  unsupportedNativeResult.results["shape.spring"]!.status = "blocked";
  unsupportedNativeResult.results["shape.spring"]!.success = false;
  assert.throws(
    () =>
      assertFixedMethodResults(
        unsupportedNativeResult,
        operations,
        "saved-scratch",
      ),
    /did not return a passing method result/i,
  );

  const unresolvedReceipt = structuredClone(saved.receipt);
  unresolvedReceipt.state = "needs_reconciliation";
  assert.equal(
    isExecutionUnknown(unresolvedReceipt),
    true,
    "an unresolved queue receipt must remain unknown",
  );
});
