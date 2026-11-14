import test from "node:test";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { parameterScenarios } from "./parameter-cases";
import { runScenarios } from "./runner";
import { marker } from "./programs";

for (const protocol of ["mcp", "addin"] as const) {
  for (const defect of ["tiny-value-error", "renamed-list-output"] as const) {
    test(`historical parameter expectation detects ${defect} via ${protocol}`, async (t) => {
      const { backend, model, directory } = await fixture(t, protocol);
      let injections = 0;
      const faulty = {
        ...backend,
        async execute(request: Parameters<typeof backend.execute>[0]) {
          const result = await backend.execute(request);
          const lines = result.stdout.split("\n");
          const index = lines.findIndex((line) => line.startsWith(marker));
          if (index < 0) return result;
          const value = JSON.parse(lines[index]!.slice(marker.length));
          const command = value.commands?.[0];
          if (
            defect === "tiny-value-error" &&
            request.source.includes(
              '[("param_set", ["migration_width", "20 mm",',
            )
          ) {
            command.parameters[0].value += 5e-10;
            injections++;
          } else if (
            defect === "renamed-list-output" &&
            request.source.includes('[("param_list",') &&
            command?.parameters?.[0]?.name === "migration_width_renamed"
          ) {
            command.output = command.output.replace(
              "PARAM name=migration_width_renamed",
              "PARAM name=wrong",
            );
            injections++;
          } else return result;
          lines[index] = marker + JSON.stringify(value);
          return { ...result, stdout: lines.join("\n") };
        },
      };
      const [report] = await runScenarios(
        faulty,
        parameterScenarios(simulatorFolder).filter(
          (scenario) => scenario.id === "parameter-crud",
        ),
        directory,
        1,
      );
      assert.equal(injections, 1);
      assert.equal(report?.status, "failed");
      assert.equal(report?.cleanup, "complete");
      assert.deepEqual(await remaining(model), { active: null, documents: [] });
    });
  }
}
