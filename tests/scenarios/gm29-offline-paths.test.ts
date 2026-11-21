import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { fixture } from "./test-support";
import { runScenarios } from "./runner";
import { g29_9, g29_10 } from "./gm29-cases";
import { simulatorFolder } from "./simulator";

for (const protocol of ["mcp", "addin"] as const) {
  for (const mode of ["simulator", "fusion"] as const) {
    test(`GM29 ${mode} fixture routing uses the real offline handler via ${protocol}`, async (t) => {
      const { backend, directory } = await fixture(t, protocol);
      // Only the fixture's mode selection changes. The execution backend remains
      // the local Python model even for the fusion-routing regression.
      const routed = { ...backend, mode };
      const execute = backend.execute.bind(backend);
      let cadCommands = 0;
      routed.execute = async (request) => {
        if (request.command?.operation === "texture.heightmap") cadCommands++;
        return execute(request);
      };
      const reports = await runScenarios(
        routed,
        [g29_9, g29_10].map((entry) => ({
          id: entry.id.toLowerCase(),
          fixture: simulatorFolder,
          requires: ["documents", "saved-fixtures"],
          run: entry.run,
        })),
        directory,
        2,
      );
      for (const report of reports) {
        assert.equal(report.status, "passed", JSON.stringify(report));
        assert.equal(report.cleanup, "complete");
        const png = fs.readFileSync(
          path.join(report.directory, "heightmap.png"),
        );
        assert.deepEqual(
          png.subarray(0, 8),
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
        assert.equal(png.readUInt32BE(16), 64);
        assert.equal(png.readUInt32BE(20), 64);
      }
      assert.equal(
        cadCommands,
        mode === "simulator" ? 0 : 3,
        "only simulator fixtures bypass the Windows CAD preparation adapter",
      );
    });
  }
}
