import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./test-support";
import { simulatorFolder } from "./simulator";
import { transactionScenarios } from "./transaction-cases";
import { runScenarios } from "./runner";

for (const protocol of ["mcp", "addin"] as const) {
  test(`historical numeric definition precedes unsupported syntax and literal rejection via ${protocol}`, async (t) => {
    const { backend, directory } = await fixture(t, protocol);
    const faulty = {
      ...backend,
      async execute(request: Parameters<typeof backend.execute>[0]) {
        if (request.command) {
          // A loss at the final rejection boundary must not move earlier
          // historical assertions behind that uncertain operation.
          if (
            request.command.data["runId"] === "no_eval" &&
            request.command.data["mode"] !== "preview"
          )
            throw new Error("Injected loss at final literal rejection");
        }
        return backend.execute(request);
      },
    };
    const [report] = await runScenarios(
      faulty,
      transactionScenarios(simulatorFolder, 1),
      directory,
      1,
    );
    assert.equal(report?.status, "failed");
    assert.match(
      report?.error ?? "",
      /Injected loss at final literal rejection/u,
    );
    assert.equal(report?.cleanup, "deferred");
    const phases = report!.requests.map((request) => request.phase);
    assert.deepEqual(
      phases
        .filter(
          (phase) =>
            phase.startsWith("cad-") && !phase.startsWith("cad-audit-"),
        )
        .slice(-6),
      [
        "cad-numeric",
        "cad-invalid-0",
        "cad-invalid-1",
        "cad-invalid-2",
        "cad-literal-preview",
        "cad-literal-rejection",
      ],
    );
    assert.ok(phases.includes("before-invalid"));
    assert.ok(phases.includes("after-invalid"));
    assert.ok(!phases.includes("after-code-literal"));
  });
}
