import test from "node:test";
import path from "node:path";
import { program } from "./programs";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { transactionScenarios } from "./transaction-cases";
import { runScenarios, resumeCleanup } from "./runner";
for (const protocol of ["mcp", "addin"] as const) {
  for (const concurrency of [1, 2, 10]) {
    test(`definition reference and replay contracts via ${protocol}, concurrency ${concurrency}`, async (t) => {
      const { backend, model, directory } = await fixture(t, protocol);
      const reports = await runScenarios(
        backend,
        transactionScenarios(simulatorFolder, concurrency === 10 ? 10 : 2),
        directory,
        concurrency,
      );
      for (const report of reports) {
        assert.equal(report.status, "passed", JSON.stringify(report));
        assert.equal(report.cleanup, "complete");
      }
      assert.deepEqual(await remaining(model), { active: null, documents: [] });
    });
  }
}

test("successful replay and changed run IDs perform no physical SDK calls", async (t) => {
  const { backend, model, directory } = await fixture(t);
  let attempts = 0;
  const measured = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      const literal = request.command?.data["runId"] === "literal";
      const previous = model.executions;
      const offline =
        String(request.command?.data["runId"]).startsWith("unsupported_") ||
        request.command?.data["mode"] === "preview";
      const result = await backend.execute(request);
      if (offline)
        assert.equal(
          model.executions,
          previous,
          "Offline rejection/preview contacted SDK",
        );
      if (literal && ++attempts > 1)
        assert.equal(
          model.executions,
          previous,
          "Replay or rejected request contacted the SDK",
        );
      return result;
    },
  };
  const [report] = await runScenarios(
    measured,
    transactionScenarios(simulatorFolder, 1),
    directory,
    1,
  );
  assert.equal(report?.status, "passed", JSON.stringify(report));
  assert.equal(attempts, 3);
});

test("a lost completed definition response recovers original evidence without replay", async (t) => {
  const { backend, model, directory } = await fixture(t);
  let calls = 0;
  const faulty = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      const result = await backend.execute(request);
      if (request.command) {
        calls++;
        throw new Error("Lost original command reply");
      }
      return result;
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
  const restored = await resumeCleanup(
    backend,
    path.join(report!.directory, "report.json"),
  );
  assert.equal(restored.status, "failed");
  assert.equal(restored.cleanup, "complete");
  assert.equal(calls, 1);
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("foreign batch context defers cleanup until original evidence is recovered", async (t) => {
  const { backend, model, directory } = await fixture(t);
  const faulty = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      const result = await backend.execute(request);
      if (!request.command) return result;
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      const context = output["context"] as Record<string, unknown>;
      context["docId"] = "foreign-document";
      return { ...result, stdout: JSON.stringify(output) };
    },
  };
  const [report] = await runScenarios(
    faulty,
    transactionScenarios(simulatorFolder, 1),
    directory,
    1,
  );
  assert.equal(report?.status, "failed");
  assert.match(report?.error ?? "", /Foreign CAD context/u);
  assert.equal(report?.cleanup, "deferred");
  const restored = await resumeCleanup(
    backend,
    path.join(report!.directory, "report.json"),
  );
  assert.equal(restored.cleanup, "complete");
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("area and volume expressions retain dimensional scales and reject incompatible quantities", async (t) => {
  const { model } = await fixture(t);
  const result = await model.execute(
    program(`import adsk.core
units=adsk.core.UnitsManager()
for expression, unit, expected in [('7 mm^3','cm^3',0.007), ('2 cm^3 + 500 mm^3','cm^3',2.5), ('4 mm^2','cm^2',0.04), ('3 cm * 2 cm * 4 cm','cm^3',24)]:
    assert abs(units.evaluateExpression(expression,unit)-expected)<1e-12
assert not units.isValidExpression('1 mm^3','cm^2')
assert not units.isValidExpression('__import__("builtins").str(23) + " mm"','cm')
`),
  );
  assert.equal(result.success, true, result.error);
});
