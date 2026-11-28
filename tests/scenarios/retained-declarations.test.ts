import test from "node:test";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { runScenarios, type ScenarioSession } from "./runner";
import {
  retainedDeclarationScenarios,
  retainedDeclarations,
  type DeclarationFamily,
} from "./retained-declaration-cases";
for (const family of Object.keys(retainedDeclarations) as DeclarationFamily[]) {
  for (const protocol of ["mcp", "addin"] as const) {
    test(`retained ${family} declaration assertions via ${protocol}`, async (t) => {
      const { backend, model, directory } = await fixture(t, protocol);
      const reports = await runScenarios(
        backend,
        retainedDeclarationScenarios(simulatorFolder, family, 1),
        directory,
        10,
      );
      for (const report of reports) {
        assert.equal(report.status, "passed", JSON.stringify(report));
        assert.equal(report.cleanup, "complete");
      }
      assert.deepEqual(await remaining(model), { active: null, documents: [] });
    });
  }
}

const g19Case = (id: string) => {
  const scenario = retainedDeclarationScenarios(
    simulatorFolder,
    "interference",
    1,
  ).find((candidate) => candidate.id === id);
  assert.ok(scenario, `Missing retained scenario ${id}`);
  return scenario;
};
const fakeSession = (
  output: Record<string, unknown>,
  execute: () => Promise<Record<string, unknown>> = async () => output,
): ScenarioSession =>
  ({
    document: { creationId: "test-document", name: "test-document" },
    execute,
  }) as unknown as ScenarioSession;

test("retained G19-11 accepts only its structured unknown result", async () => {
  const scenario = g19Case("retained-interference-g19-11-0");
  const result = {
    operation: "motion.envelope",
    success: false,
    status: "unknown",
    continuousVerified: false,
    certified: false,
  };
  await scenario.run(fakeSession({ error: null, result }));
  await assert.rejects(
    scenario.run(
      fakeSession({ error: null, result: { ...result, success: true } }),
    ),
  );
  await assert.rejects(
    scenario.run(fakeSession({ error: "CAD transport failed" })),
    /CAD transport failed/,
  );
  await assert.rejects(
    scenario.run(
      fakeSession({ error: null, result }, async () => {
        throw new Error("Broker request failed");
      }),
    ),
    /Broker request failed/,
  );
});

test("retained successful motion envelopes remain accepted", async () => {
  await g19Case("retained-interference-g19-06-0").run(
    fakeSession({
      error: null,
      result: {
        operation: "motion.envelope",
        success: true,
        status: "pass",
        sampleCount: 5,
        sampledEnvelope: { max: [12, 10, 10] },
        continuousVerified: false,
      },
    }),
  );
});
