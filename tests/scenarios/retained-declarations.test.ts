import test from "node:test";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { runScenarios } from "./runner";
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
