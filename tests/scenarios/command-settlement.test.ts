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
import { commandResult, recoveredCommandResult } from "./command-result";

test("recovery distinguishes fenced helper results from CLI command JSON", () => {
  const target = { name: "owned", creationId: "document-1" };
  const output = {
    success: true,
    helperCallsOnly: [
      {
        operation: "component.create",
        status: "completed",
        effects: "observed",
      },
    ],
    result: {
      success: true,
      operation: "component.create",
      document: target.name,
      creationId: target.creationId,
    },
  };
  const intent = { kind: "cad-fenced", operation: "component.create" };
  const stdout = "FMCAD_RESULT " + JSON.stringify(output);
  assert.deepEqual(
    recoveredCommandResult(stdout, intent, "request-4", [target]),
    output.result,
  );
  for (const bad of [
    { ...output, success: false },
    { ...output, helperCallsOnly: [] },
    {
      ...output,
      helperCallsOnly: [
        { operation: "other", status: "completed", effects: "observed" },
      ],
    },
    { ...output, result: { ...output.result, creationId: "foreign" } },
    { ...output, result: { ...output.result, operation: "other" } },
    { ...output, result: { ...output.result, status: "unknown" } },
  ])
    assert.throws(() =>
      recoveredCommandResult(
        "FMCAD_RESULT " + JSON.stringify(bad),
        intent,
        "request-4",
        [target],
      ),
    );
  assert.throws(() =>
    recoveredCommandResult(stdout + "\n" + stdout, intent, "request-4", [
      target,
    ]),
  );
  assert.throws(() =>
    recoveredCommandResult(stdout, { kind: "cad" }, "request-4", [target]),
  );
  assert.deepEqual(
    recoveredCommandResult(
      JSON.stringify(output.result),
      { kind: "cad", command: { operation: "component.create" } },
      "request-4",
    ),
    output.result,
  );
});

test("fenced no-mutation admission remains bound to its original request", () => {
  const intent = { kind: "cad-fenced", operation: "component.create" };
  const admission = {
    status: "inventory-changed",
    requestId: "original",
    helperCalls: 0,
    mutationStarted: false,
  };
  const envelope = (proof: typeof admission, calls: unknown[] = []) =>
    "FMCAD_RESULT " +
    JSON.stringify({
      success: true,
      helperCallsOnly: calls,
      result: { operation: intent.operation, admission: proof },
    });
  assert.doesNotThrow(() =>
    recoveredCommandResult(envelope(admission), intent, "original"),
  );
  for (const change of [
    { status: "unknown" },
    { requestId: "foreign" },
    { helperCalls: 1 },
    { mutationStarted: true },
  ])
    assert.throws(() =>
      recoveredCommandResult(
        envelope({ ...admission, ...change }),
        intent,
        "original",
      ),
    );
  assert.throws(() =>
    recoveredCommandResult(envelope(admission, [{}]), intent, "original"),
  );
});

test("generic resumeCleanup validates stored fenced envelopes before owned cleanup", async (t) => {
  const { backend, model, directory } = await fixture(t, "addin");
  let operation = "";
  const lost = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      const result = await backend.execute(request);
      if (request.command) {
        operation = request.command.operation;
        throw new Error("Lost command reply");
      }
      return result;
    },
  };
  const [report] = await runScenarios(
    lost,
    transactionScenarios(simulatorFolder, 1),
    directory,
    1,
  );
  assert.ok(report);
  assert.equal(report.cleanup, "deferred");
  const filename = path.join(report.directory, "report.json");
  const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
  const entry = saved.requests.find((request: { phase: string }) =>
    request.phase.startsWith("cad-"),
  );
  assert.ok(operation);
  entry.intent = { kind: "cad-fenced", operation };
  fs.writeFileSync(filename, JSON.stringify(saved));
  let recoveryRequests = 0;
  const recovering = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      assert.equal(
        request.command,
        undefined,
        "Recovery must not replay the CAD command",
      );
      recoveryRequests++;
      return backend.execute(request);
    },
    async lookup(
      owner: Parameters<NonNullable<typeof backend.lookup>>[0],
      requestId: string,
    ) {
      const result = await backend.lookup!(owner, requestId);
      if (!result || requestId !== entry.requestId) return result;
      const value = JSON.parse(result.stdout);
      return {
        ...result,
        stdout:
          "FMCAD_RESULT " +
          JSON.stringify({
            success: true,
            helperCallsOnly: [
              { operation, status: "completed", effects: "observed" },
            ],
            result: {
              ...value,
              operation,
              document: report.document!.name,
              creationId: report.document!.creationId,
            },
          }),
      };
    },
  };
  const restored = await resumeCleanup(recovering, filename);
  assert.equal(restored.cleanup, "complete");
  assert.equal(restored.status, "failed");
  assert.ok(recoveryRequests > 0, "The owned cleanup actually ran");
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

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
  for (const operation of [
    "check.set",
    "evidence.package",
    "evidence.check",
    "deliver",
  ])
    assert.doesNotThrow(() =>
      commandResult(
        JSON.stringify({
          success: false,
          status: "unknown",
          operation,
          result: { success: true },
        }),
        undefined,
        operation,
      ),
    );
  for (const operation of ["definition.instantiate", "batch.run"])
    assert.throws(
      () =>
        commandResult(
          JSON.stringify({
            success: false,
            status: "unknown",
            operation,
          }),
          undefined,
          operation,
        ),
      /unsettled/u,
    );
  assert.throws(
    () =>
      commandResult(
        JSON.stringify({
          success: false,
          status: "unknown",
          operation: "check.set",
        }),
        undefined,
        "batch.run",
      ),
    /does not match its request/u,
  );
  assert.throws(
    () =>
      commandResult(
        JSON.stringify({
          success: false,
          status: "unknown",
          executionOutcome: "unknown",
          operation: "check.set",
        }),
        undefined,
        "check.set",
      ),
    /unsettled/u,
  );
});

test("unsaved command context accepts a null file pin but rejects another file", () => {
  const target = { name: "Owned", creationId: "owned-id" };
  const result = {
    success: true,
    context: { doc: "Owned", docId: "owned-id", docFileId: null },
  };
  assert.doesNotThrow(() => commandResult(JSON.stringify(result), [target]));
  assert.doesNotThrow(() =>
    commandResult(
      JSON.stringify({
        ...result,
        context: { doc: "Owned", docId: "owned-id" },
      }),
      [target],
    ),
  );
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
