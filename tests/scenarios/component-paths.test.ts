import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./test-support";
import { runScenarios } from "./runner";
import { g29_9 } from "./gm29-cases";
import { simulatorFolder } from "./simulator";

for (const protocol of ["mcp", "addin"] as const) {
  test(`component CAD keeps generated fixture paths local via ${protocol}`, async (t) => {
    const { backend, directory } = await fixture(t, protocol);
    const [report] = await runScenarios(
      backend,
      [
        {
          id: "gm-contract-g29-09",
          fixture: simulatorFolder,
          requires: ["documents", "saved-fixtures"],
          run: g29_9.run,
        },
      ],
      directory,
      1,
    );
    assert.equal(report?.status, "passed", JSON.stringify(report));
    assert.equal(report?.cleanup, "complete");
  });
}
