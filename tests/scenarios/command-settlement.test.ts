import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import type { Execution } from "./contracts";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { transactionScenarios } from "./transaction-cases";
import { runScenarios, resumeCleanup } from "./runner";
import { queueExecution } from "./queue-backend";
import { commandResult } from "./command-result";

for (const protocol of ["mcp", "addin"] as const) {
  for (const defect of ["unknown", "foreign", "missing-execution"] as const) {
    test(`${protocol}: ${defect} original command evidence cannot authorize cleanup`, async (t) => {
      const { backend, model, directory } = await fixture(t, protocol);
      let commands = 0;
      let bad: Execution | undefined;
      const faulty = {
        ...backend,
        async execute(request: Parameters<typeof backend.execute>[0]) {
          const result = await backend.execute(request);
          if (!request.command) return result;
          commands++;
          const output = JSON.parse(result.stdout);
          if (defect === "missing-execution") {
            bad = queueExecution(
              {
                job: {
                  clientId: request.owner.clientId,
                  requestId: request.requestId,
                  state: "succeeded",
                },
                stdout: result.stdout,
              },
              request.owner,
              request.requestId,
            );
            return bad;
          }
          if (defect === "unknown") {
            output.status = "unknown";
            output.outcome = "unknown";
            output.success = false;
          } else {
            output.context ??= {
              doc: request.target?.name,
              docId: request.target?.creationId,
            };
            output.context.docId = "unrelated-document";
          }
          bad = { ...result, stdout: JSON.stringify(output) };
          return bad;
        },
        async lookup(
          owner: Parameters<NonNullable<typeof backend.lookup>>[0],
          requestId: string,
        ) {
          if (bad?.requestId === requestId) return bad;
          return backend.lookup!(owner, requestId);
        },
      };
      const [report] = await runScenarios(
        faulty,
        transactionScenarios(simulatorFolder, 1),
        directory,
        1,
      );
      assert.equal(report?.status, "failed");
      assert.equal(report?.cleanup, "deferred");
      assert.equal(commands, 1);
      const retained = await remaining(model);
      const file = path.join(report!.directory, "report.json");
      await assert.rejects(
        resumeCleanup(faulty, file),
        /unsettled|Foreign CAD context/u,
      );
      assert.equal(
        JSON.parse(fs.readFileSync(file, "utf8")).cleanup,
        "deferred",
      );
      assert.deepEqual(
        await remaining(model),
        retained,
        "Invalid evidence changed the retained document",
      );
      const recovered = await resumeCleanup(backend, file);
      assert.equal(recovered.cleanup, "complete");
      assert.equal(recovered.status, "failed");
      assert.equal(commands, 1);
      assert.deepEqual(await remaining(model), { active: null, documents: [] });
    });
  }
}
test("only command control fields determine settlement, never literal input data", () => {
  assert.equal(
    commandResult(
      JSON.stringify({
        success: false,
        status: "failed",
        request: { status: "unknown" },
        steps: [{ status: "skipped" }],
      }),
    )["status"],
    "failed",
  );
  for (const value of [
    { success: false, status: "running" },
    { success: false, outcome: "unknown" },
    { success: true, completed: false },
    { success: true, executionOutcome: "unknown" },
    { success: true, operation: "batch.run" },
  ])
    assert.throws(() => commandResult(JSON.stringify(value)));
  assert.doesNotThrow(() =>
    commandResult(
      JSON.stringify({
        success: true,
        mode: "preview",
        operation: "definition.instantiate",
        mutated: false,
      }),
    ),
  );
});

test("unsaved command context accepts a null file pin but rejects another file", () => {
  const target = { name: "Owned", creationId: "owned-id" };
  const result = {
    success: true,
    context: { doc: "Owned", docId: "owned-id", docFileId: null },
  };
  assert.doesNotThrow(() => commandResult(JSON.stringify(result), [target]));
  assert.throws(
    () =>
      commandResult(
        JSON.stringify({
          ...result,
          context: { ...result.context, docFileId: "foreign-file" },
        }),
        [target],
      ),
    /Foreign CAD context/u,
  );
});
