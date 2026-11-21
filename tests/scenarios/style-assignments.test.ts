import { cadCommand } from "./cad-programs";
import { record } from "./contracts";
import test from "node:test";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { text } from "./contracts";
import { program, guard } from "./programs";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import {
  styleAssignmentReadback,
  styleAssignmentScenarios,
} from "./style-assignment-cases";
import { runScenarios, resumeCleanup, ScenarioSession } from "./runner";
for (const protocol of ["mcp", "addin"] as const) {
  for (const concurrency of [1, 2, 10]) {
    test(`explicit body style assignment survives owned reopen via ${protocol}, concurrency ${concurrency}`, async (t) => {
      const { backend, model, directory } = await fixture(t, protocol);
      const reports = await runScenarios(
        backend,
        styleAssignmentScenarios(simulatorFolder, concurrency === 10 ? 10 : 2),
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
  test(`lost body assignment recovers without a second mutation via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    let assignments = 0;
    const faulty = {
      ...backend,
      async execute(request: Parameters<typeof backend.execute>[0]) {
        const result = await backend.execute(request);
        if (request.source.includes('FMCAD.call("appearance.assign"')) {
          assignments++;
          throw new Error("Lost assignment reply");
        }
        return result;
      },
    };
    const [report] = await runScenarios(
      faulty,
      styleAssignmentScenarios(simulatorFolder, 1),
      directory,
      1,
    );
    assert.equal(report?.status, "failed");
    assert.equal(report?.cleanup, "deferred");
    assert.ok(report?.document);
    const observed = await model.execute(
      styleAssignmentReadback(report.document),
    );
    assert.equal(observed.success, true, observed.error);
    const line = observed.stdout
      .split("\n")
      .find((line) => line.startsWith("FMCAD_SCENARIO "))!;
    const body = record(
      JSON.parse(line.slice("FMCAD_SCENARIO ".length)).bodies[0],
    );
    assert.ok(text(body["appearance"]));
    assert.equal(body["material"], null);
    const recovered = await resumeCleanup(
      backend,
      path.join(report.directory, "report.json"),
    );
    assert.equal(recovered.cleanup, "complete");
    assert.equal(recovered.status, "failed");
    assert.equal(assignments, 1);
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
}

test("foreign saved body tokens cannot receive another owner's style assignment", async (t) => {
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
    await protectedSession.execute(
      "protected-box",
      cadCommand(protectedSession.document, "shape.box", {
        name: "ProtectedBody",
        width: "4 mm",
        depth: "5 mm",
        height: "6 mm",
      }),
      protectedSession.document,
      "cad-v1",
    );
    const before = await protectedSession.execute(
      "protected-before",
      styleAssignmentReadback(protectedSession.document),
    );
    assert.ok(Array.isArray(before["bodies"]));
    const token = text(record(before["bodies"][0])["token"]);
    let assignments = 0;
    const faulty = {
      ...backend,
      async execute(request: Parameters<typeof backend.execute>[0]) {
        if (request.source.includes('FMCAD.call("appearance.assign"')) {
          assignments++;
          return backend.execute({
            ...request,
            source: request.source.replace(/model-body:[a-f0-9-]+/gu, token),
          });
        }
        return backend.execute(request);
      },
    };
    const [report] = await runScenarios(
      faulty,
      styleAssignmentScenarios(simulatorFolder, 1),
      directory,
      1,
    );
    assert.equal(assignments, 1);
    assert.equal(report?.status, "failed");
    assert.equal(report?.cleanup, "complete");
    assert.deepEqual(
      await protectedSession.execute(
        "protected-after",
        styleAssignmentReadback(protectedSession.document),
      ),
      before,
    );
  } finally {
    await protectedSession.cleanup();
  }
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("root-body style setters reject foreign resources, library resources and closed targets", async (t) => {
  const { backend, model, directory } = await fixture(t);
  const runId = randomUUID();
  const session = new ScenarioSession(
    backend,
    { runId, scenarioId: "guard", clientId: "scenario:" + runId + ":guard" },
    path.join(directory, "guard"),
    undefined,
    simulatorFolder,
  );
  await session.setup();
  try {
    await session.execute(
      "box",
      cadCommand(session.document, "shape.box", {
        name: "GuardBody",
        width: "4 mm",
        depth: "5 mm",
        height: "6 mm",
      }),
      session.document,
      "cad-v1",
    );
    const result = await model.execute(
      program(`${guard(session.document)}
body = design.rootComponent.bRepBodies.item(0)
foreign = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
other = adsk.fusion.Design.cast(foreign.products.itemByProductType('DesignProductType'))
assert other is not None
library = app.materialLibraries.item(0)
a = other.appearances.addByCopy(library.appearances.item(0), 'ForeignAppearance')
m = other.materials.addByCopy(library.materials.item(0), 'ForeignMaterial')
for prop, resource in [('appearance', a), ('material', m), ('appearance', library.appearances.item(0)), ('material', library.materials.item(0))]:
    try:
        setattr(body, prop, resource)
    except ValueError:
        pass
    else:
        raise AssertionError('Foreign or library assignment accepted')
assert body.appearance is None and body.material is None
assert foreign.close(False)
assert doc.activate()
local_appearance = design.appearances.addByCopy(library.appearances.item(0), 'LocalAppearance')
local_material = design.materials.addByCopy(library.materials.item(0), 'LocalMaterial')
body.appearance = local_appearance
body.material = local_material
assert body.appearance is local_appearance and body.material is local_material
assert doc.close(False)
for prop, resource in [('appearance', local_appearance), ('material', local_material)]:
    try:
        setattr(body, prop, resource)
    except ValueError:
        pass
    else:
        raise AssertionError('Closed body assignment accepted')
`),
    );
    assert.equal(result.success, true, result.error);
  } finally {
    await session.cleanup();
  }
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("a false assignment-map assertion cleans the owned saved file and stops physical assignment", async (t) => {
  const { backend, model, directory } = await fixture(t);
  let physicalAssignments = 0;
  const faulty = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      const result = await backend.execute(request);
      if (request.source.includes('FMCAD.call("material.assign"'))
        physicalAssignments++;
      if (request.source.includes('FMCAD.call("appearance.assign-map"')) {
        const lines = result.stdout.split("\n");
        const index = lines.findIndex((line) =>
          line.startsWith("FMCAD_SCENARIO "),
        );
        const value = JSON.parse(lines[index]!.slice("FMCAD_SCENARIO ".length));
        value.result.mismatchCount = 1;
        lines[index] = "FMCAD_SCENARIO " + JSON.stringify(value);
        return { ...result, stdout: lines.join("\n") };
      }
      return result;
    },
  };
  const [report] = await runScenarios(
    faulty,
    styleAssignmentScenarios(simulatorFolder, 1),
    directory,
    1,
  );
  assert.equal(report?.status, "failed");
  assert.equal(report?.cleanup, "complete");
  assert.equal(physicalAssignments, 0);
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});
