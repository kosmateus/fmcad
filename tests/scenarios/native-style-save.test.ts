import test from "node:test";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { runScenarios } from "./runner";
import {
  nativeStyleSaveScenarios,
  nativeStyleSavePreview,
} from "./native-style-save-cases";

for (const protocol of ["mcp", "addin"] as const)
  test(`native style/save qualification requires the real kernel before all ten owners or user-view capture via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    const before = model.executions;
    const reports = await runScenarios(
      backend,
      nativeStyleSaveScenarios(),
      directory,
      10,
    );
    assert.equal(reports.length, 10);
    assert.equal(
      model.executions,
      before,
      "Unsupported native styles must not read or change the user's view",
    );
    for (const report of reports) {
      assert.equal(report.status, "unsupported");
      assert.equal(report.cleanup, "not-created");
      assert.deepEqual(report.requests, []);
    }
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });

test("retained style/save local preview validates inputs without backend or cloud destination", async () => {
  const preview = await nativeStyleSavePreview();
  assert.equal(preview["mutation"], false);
  assert.equal(preview["state"], "input-validated-only");
});
