import assert from "node:assert/strict";
import type { Document } from "./contracts";
import { record, text } from "./contracts";

export function recoveredCommandResult(
  stdout: string,
  intent: Record<string, unknown> | undefined,
  requestId: string,
  targets?: readonly Document[],
): Record<string, unknown> {
  if (intent?.["kind"] === "cad-fenced") {
    const operation = intent["operation"];
    if (typeof operation !== "string" || !operation)
      throw new Error("Fenced CAD request has no operation");
    const lines = stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("FMCAD_RESULT "));
    assert.equal(lines.length, 1, "Expected exactly one cad-v1 result marker");
    const wrapper = record(
      JSON.parse(lines[0]!.slice("FMCAD_RESULT ".length)) as unknown,
    );
    assert.equal(
      wrapper["success"],
      true,
      "cad-v1 helper turn did not succeed",
    );
    const value = record(wrapper["result"]);
    assert.equal(value["operation"], operation);
    if (targets)
      assert.ok(
        targets.some(
          (target) =>
            value["creationId"] === target.creationId &&
            value["document"] === target.name,
        ),
        "Fenced CAD result has a foreign target identity",
      );
    const calls = wrapper["helperCallsOnly"];
    if (value["admission"] !== undefined) {
      const admission = record(value["admission"]);
      assert.equal(admission["status"], "inventory-changed");
      assert.equal(admission["requestId"], requestId);
      assert.equal(admission["helperCalls"], 0);
      assert.equal(admission["mutationStarted"], false);
      assert.deepEqual(calls, []);
      return value;
    }
    assert.ok(
      Array.isArray(calls) && calls.length === 1,
      "Fenced CAD turn must contain exactly one helper call",
    );
    const call = record(calls[0]);
    assert.equal(call["operation"], operation);
    assert.equal(call["status"], "completed");
    assert.equal(call["effects"], "observed");
    return commandResult(JSON.stringify(value), targets, operation);
  }
  const command = intent?.["command"];
  return commandResult(
    stdout,
    targets,
    command === undefined ? undefined : text(record(command)["operation"]),
  );
}

/** A completed transport is not proof that a native command transaction settled. */
export function commandResult(
  stdout: string,
  targets?: readonly Document[],
  expectedOperation?: string,
): Record<string, unknown> {
  const output = record(JSON.parse(stdout) as unknown);
  if (typeof output["success"] !== "boolean")
    throw new Error("CAD result has no explicit outcome");
  if (
    expectedOperation !== undefined &&
    output["operation"] !== expectedOperation
  )
    throw new Error(
      "Original CAD command operation does not match its request",
    );
  const unsettled = new Set([
    "unknown",
    "running",
    "pending",
    "started",
    "cleanup_pending",
  ]);
  // These read-only evaluators use `unknown` for incomplete declared evidence.
  const declaredUnknown =
    expectedOperation === output["operation"] &&
    output["status"] === "unknown" &&
    ["check.set", "evidence.package", "evidence.check", "deliver"].includes(
      expectedOperation ?? "",
    );
  for (const field of ["status", "outcome", "executionOutcome"])
    if (
      unsettled.has(String(output[field])) &&
      !(field === "status" && declaredUnknown)
    )
      throw new Error(
        "Original CAD command remains unsettled: " +
          field +
          "=" +
          String(output[field]),
      );
  if (output["completed"] === false)
    throw new Error("Original CAD command has not completed");
  if (output["context"] !== undefined && targets) {
    const context = record(output["context"]);
    if (
      !targets.some(
        (target) =>
          context["doc"] === target.name &&
          context["docId"] === target.creationId &&
          (context["docFileId"] ?? null) === (target.file?.fileId ?? null),
      )
    )
      throw new Error(
        "Foreign CAD context; recover the original command before cleanup",
      );
  } else if (
    output["context"] === undefined &&
    output["success"] === true &&
    !["preview", "validate"].includes(String(output["mode"])) &&
    ["definition.instantiate", "batch.run"].includes(
      String(output["operation"]),
    )
  )
    throw new Error("Successful batch has no pinned context");
  return output;
}
