import test from "node:test";
import path from "node:path";
import { marker } from "./programs";
import { record } from "./contracts";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { runScenarios, resumeCleanup } from "./runner";
import { engineeringDeclarationScenarios } from "./engineering-declaration-cases";
for (const protocol of ["mcp", "addin"] as const) {
  for (const concurrency of [1, 2, 10]) {
    test(`declared cam, assembly and service analytics via ${protocol}, concurrency ${concurrency}`, async (t) => {
      const { backend, model, directory } = await fixture(t, protocol);
      const reports = await runScenarios(
        backend,
        engineeringDeclarationScenarios(
          simulatorFolder,
          concurrency === 10 ? 10 : 2,
        ),
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

for (const protocol of ["mcp", "addin"] as const) {
  test(`lost analytic response retains original evidence and never replays via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    let calls = 0;
    const faulty = {
      ...backend,
      async execute(request: Parameters<typeof backend.execute>[0]) {
        const result = await backend.execute(request);
        if (request.source.includes('FMCAD.call("cam.profile"')) {
          calls++;
          throw new Error("Lost analytic response");
        }
        return result;
      },
    };
    const [report] = await runScenarios(
      faulty,
      engineeringDeclarationScenarios(simulatorFolder, 1),
      directory,
      1,
    );
    assert.equal(report?.status, "failed");
    assert.equal(report?.cleanup, "deferred");
    const recovered = await resumeCleanup(
      backend,
      path.join(report!.directory, "report.json"),
    );
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.cleanup, "complete");
    assert.equal(calls, 1);
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
}

test("a falsely qualified continuous envelope fails its original assertion and cleans the fixture", async (t) => {
  const { backend, model, directory } = await fixture(t);
  const faulty = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      const result = await backend.execute(request);
      if (!request.source.includes('FMCAD.call("motion.envelope"'))
        return result;
      const lines = result.stdout.split("\n");
      const index = lines.findIndex((line) => line.startsWith(marker));
      assert.ok(index >= 0);
      const output = record(
        JSON.parse(lines[index]!.slice(marker.length)) as unknown,
      );
      record(output["result"])["continuousVerified"] = true;
      lines[index] = marker + JSON.stringify(output);
      return { ...result, stdout: lines.join("\n") };
    },
  };
  const [report] = await runScenarios(
    faulty,
    engineeringDeclarationScenarios(simulatorFolder, 1),
    directory,
    1,
  );
  assert.equal(report?.status, "failed");
  assert.equal(report?.cleanup, "complete");
  assert.match(report?.error ?? "", /true !== false/u);
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});
