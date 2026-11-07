import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { runScenarios } from "./runner";
import { cloudScenarios } from "./cloud-cases";
import { record } from "./contracts";

for (const protocol of ["mcp", "addin"] as const) {
  for (const concurrency of [1, 2, 10]) {
    test(`cloud inventory and saved cleanup via ${protocol}, concurrency ${concurrency}`, async (t) => {
      const { directory, model, backend } = await fixture(t, protocol);
      const cases = Array.from({ length: 3 }, (_, i) => ({
        ...cloudScenarios(simulatorFolder)[0]!,
        id: "cloud-inventory-" + i,
      }));
      const reports = await runScenarios(
        backend,
        cases,
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

test("later cloud fixture preserves the exact source before migration", () => {
  const base = path.resolve(
    __dirname,
    "../../../tests/fixtures/history/cloud-9dc58fd.py",
  );
  const metadata = record(JSON.parse(readFileSync(base + ".json", "utf8")));
  assert.equal(metadata["commit"], "9dc58fdd0929b674d2c5571a2eba1342ebbbc3a6");
  assert.equal(
    createHash("sha256")
      .update(readFileSync(base + ".txt"))
      .digest("hex"),
    metadata["sha256"],
  );
});
