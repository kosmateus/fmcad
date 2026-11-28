import assert from "node:assert/strict";

type ObjectValue = Record<string, unknown>;

function isObject(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object";
}

const pendingStates = new Set([
  "started",
  "running",
  "pending",
  "needs_reconciliation",
]);
const queuedStates = new Set([
  "queued",
  "preparing",
  "running",
  "sending",
  "needs_reconciliation",
]);

function isExecutionUnknown(value: unknown, root = true): boolean {
  if (!isObject(value)) return false;
  if (
    value["executionOutcome"] === "unknown" ||
    value["completed"] === false ||
    (typeof value["status"] === "string" &&
      pendingStates.has(value["status"])) ||
    (typeof value["state"] === "string" && queuedStates.has(value["state"])) ||
    (root && (value["status"] === "unknown" || value["state"] === "unknown"))
  )
    return true;
  return Object.entries(value).some(
    ([key, nested]) =>
      !(key === "status" && nested === "unknown") &&
      isExecutionUnknown(nested, false),
  );
}

function assertFixedMethodResults(
  payload: unknown,
  operations: readonly string[],
  creationId: string,
): void {
  assert.ok(isObject(payload));
  assert.deepEqual(
    payload["operations"],
    operations,
    "Fixed-run operation list differs.",
  );
  assert.ok(isObject(payload["results"]), "Fixed-run result map is missing.");
  const results = payload["results"];
  assert.deepEqual(
    Object.keys(results).sort(),
    [...operations].sort(),
    "Fixed-run output is missing or added a method result.",
  );
  for (const operation of operations) {
    const result = results[operation];
    assert.ok(isObject(result), operation + " returned no method result.");
    assert.equal(
      result["operation"],
      operation,
      operation + " returned a mismatched operation identity.",
    );
    assert.equal(
      result["status"],
      "pass",
      operation + " did not return a passing method result.",
    );
    assert.equal(
      result["success"],
      true,
      operation + " did not return method success.",
    );
    const documentIdentity = result["documentIdentity"];
    assert.equal(
      isObject(documentIdentity) ? documentIdentity["creationId"] : undefined,
      creationId,
      operation + " did not identify the exact owner scratch.",
    );
  }
}

export { isExecutionUnknown, assertFixedMethodResults };
