import test from "node:test";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { runScenarios } from "./runner";
import { engineeringAnalyticDeclarationScenarios } from "./native-engineering-cases";
for (const protocol of ["mcp", "addin"] as const) {
  test(`retained analytic declarations preserve original steps and tolerances via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    const reports = await runScenarios(
      backend,
      engineeringAnalyticDeclarationScenarios(1),
      directory,
      10,
    );
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.status, "passed", JSON.stringify(reports));
    assert.equal(reports[0]?.cleanup, "complete");
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
}
