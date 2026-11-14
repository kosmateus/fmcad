import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { runScenarios } from "./runner";
import { gmDeclarationScenarios } from "./gm-declaration-cases";

for (const protocol of ["mcp", "addin"] as const) {
  test(`historical GM25–37 contracts through owned CAD commands via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    const reports = await runScenarios(
      backend,
      gmDeclarationScenarios(simulatorFolder),
      directory,
      10,
    );
    assert.equal(reports.length, 83);
    assert.equal(
      new Set(reports.map((report) => report.owner.scenarioId)).size,
      83,
    );
    const failures = reports.filter(
      (report) => report.status !== "passed" || report.cleanup !== "complete",
    );
    assert.equal(
      failures.length,
      0,
      JSON.stringify(
        failures.map((report) => ({
          id: report.owner.scenarioId,
          status: report.status,
          cleanup: report.cleanup,
          error: report.error,
          cleanupError: report.cleanupError,
        })),
      ),
    );
    for (const report of reports) {
      assert.equal(report.status, "passed", JSON.stringify(report));
      assert.equal(report.cleanup, "complete", JSON.stringify(report));
    }
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
}
