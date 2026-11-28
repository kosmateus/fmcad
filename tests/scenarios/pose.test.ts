import test from "node:test";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { poseScenarios } from "./pose-cases";
import { runScenarios, resumeCleanup, ScenarioSession } from "./runner";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cadCommand } from "./cad-programs";
import { guard, program, emit } from "./programs";
import { record, text } from "./contracts";
for (const protocol of ["mcp", "addin"] as const) {
  for (const concurrency of [1, 2, 10]) {
    test(`pose manifest revisions and visibility restoration via ${protocol}, concurrency ${concurrency}`, async (t) => {
      const { backend, model, directory } = await fixture(t, protocol);
      const reports = await runScenarios(
        backend,
        poseScenarios(simulatorFolder, 2),
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

test("lost pose application stops restoration and recovers only original cleanup evidence", async (t) => {
  const { backend, model, directory } = await fixture(t);
  let applies = 0;
  const faulty = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      const result = await backend.execute(request);
      if (request.source.includes('FMCAD.call("pose.apply"')) {
        applies++;
        throw new Error("Lost pose application reply");
      }
      return result;
    },
  };
  const reports = await runScenarios(
    faulty,
    poseScenarios(simulatorFolder, 2),
    directory,
    10,
  );
  assert.equal(reports[0]?.status, "failed");
  assert.equal(reports[0]?.cleanup, "deferred");
  assert.equal(reports[1]?.status, "not-run");
  assert.equal(applies, 1);
  const recovered = await resumeCleanup(
    backend,
    path.join(reports[0]!.directory, "report.json"),
  );
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.cleanup, "complete");
  assert.equal(applies, 1);
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("foreign pose refs cannot change another saved document", async (t) => {
  const { backend, model, directory } = await fixture(t);
  const runId = randomUUID();
  const protectedSession = new ScenarioSession(
    backend,
    {
      runId,
      scenarioId: "protected",
      clientId: "scenario:" + runId + ":protected",
    },
    path.join(directory, "protected"),
    undefined,
    simulatorFolder,
  );
  await protectedSession.setup();
  try {
    const made = await protectedSession.execute(
      "protected-body",
      cadCommand(protectedSession.document, "shape.box", {
        name: "Protected",
        width: "13 mm",
        depth: "17 mm",
        height: "19 mm",
      }),
      protectedSession.document,
      "cad-v1",
    );
    const foreignToken = text(
      record((record(made["result"])["bodies"] as unknown[])[0])["token"],
    );
    const probe = () =>
      protectedSession.execute(
        "protected-readback",
        program(`${guard(protectedSession.document)}
body = design.rootComponent.bRepBodies.item(0)
${emit("dict(creationId=doc.creationId, visible=body.isLightBulbOn, token=body.entityToken, volume=body.volume, poses=design.rootComponent.attributes.itemByName('fmcad.pose', '__index__') is not None)")}`),
      );
    const before = await probe();
    let substitutions = 0;
    const corrupt = {
      ...backend,
      async execute(request: Parameters<typeof backend.execute>[0]) {
        if (
          request.owner.scenarioId.startsWith("pose-visibility-") &&
          request.source.includes('FMCAD.call("pose.save"') &&
          request.source.includes("PoseAlternate")
        ) {
          substitutions++;
          return backend.execute({
            ...request,
            source: request.source.replaceAll(
              /model-body:[a-f0-9-]+/gu,
              foreignToken,
            ),
          });
        }
        return backend.execute(request);
      },
    };
    const reports = await runScenarios(
      corrupt,
      poseScenarios(simulatorFolder, 1),
      directory,
      1,
    );
    assert.equal(substitutions, 2);
    assert.equal(reports[0]?.status, "failed");
    assert.equal(reports[0]?.cleanup, "complete");
    assert.deepEqual(await probe(), before);
  } finally {
    await protectedSession.cleanup();
  }
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("pose assertion failure restores the observed original visibility before cleanup", async (t) => {
  const { backend, model, directory } = await fixture(t);
  let applied = false;
  const observed: boolean[] = [];
  const faulty = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      const result = await backend.execute(request);
      if (request.source.includes('FMCAD.call("pose.apply"')) applied = true;
      if (applied && request.source.includes("bodies[0].isLightBulbOn")) {
        const lines = result.stdout.split("\n");
        const index = lines.findIndex((line) =>
          line.startsWith("FMCAD_SCENARIO "),
        );
        const value = JSON.parse(lines[index]!.slice("FMCAD_SCENARIO ".length));
        observed.push(value.visible);
        if (observed.length === 1) {
          value.visible = !value.visible;
          lines[index] = "FMCAD_SCENARIO " + JSON.stringify(value);
          return { ...result, stdout: lines.join("\n") };
        }
      }
      return result;
    },
  };
  const reports = await runScenarios(
    faulty,
    poseScenarios(simulatorFolder, 2),
    directory,
    10,
  );
  assert.equal(reports[0]?.status, "failed");
  assert.equal(reports[0]?.cleanup, "complete");
  assert.equal(reports[1]?.status, "not-run");
  assert.deepEqual(observed, [false, true]);
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});
