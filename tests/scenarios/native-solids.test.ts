import test from "node:test";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { nativeSolidsScenarios } from "./native-solids-cases";
import { runScenarios } from "./runner";
import { parse } from "./cli";

for (const protocol of ["mcp", "addin"] as const) {
  test(`native solid obligations refuse unsupported model capability before fixture creation via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    const initial = model.executions;
    const reports = await runScenarios(
      backend,
      nativeSolidsScenarios(simulatorFolder, 10),
      directory,
      10,
    );
    assert.equal(
      model.executions,
      initial,
      "Unsupported native family dispatched SDK work",
    );
    assert.equal(reports.length, 10);
    for (const report of reports) {
      assert.equal(report.status, "unsupported");
      assert.equal(report.cleanup, "not-created");
      assert.deepEqual(report.requests, []);
    }
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
}
test("native solid catalog entry requires explicit native run and saved folder", () => {
  assert.throws(
    () => parse(["--backend", "fusion", "--suite", "native-solids"]),
    /requires --run/u,
  );
  assert.throws(
    () => parse(["--backend", "fusion", "--run", "--suite", "native-solids"]),
    /explicitly configured/u,
  );
  assert.equal(
    parse([
      "--backend",
      "fusion",
      "--run",
      "--suite",
      "native-solids",
      "--project-id",
      "project",
      "--folder-id",
      "folder",
    ]).suite,
    "native-solids",
  );
});
