import test from "node:test";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { text } from "./contracts";
import { program, guard, emit } from "./programs";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { appearanceScenarios, appearanceReadback } from "./appearance-cases";
import { runScenarios, resumeCleanup, ScenarioSession } from "./runner";
for (const protocol of ["mcp", "addin"] as const) {
  for (const concurrency of [1, 2, 10]) {
    test(`local appearance metadata survives owned reopen via ${protocol}, concurrency ${concurrency}`, async (t) => {
      const { backend, model, directory } = await fixture(t, protocol);
      const reports = await runScenarios(
        backend,
        appearanceScenarios(simulatorFolder, concurrency === 10 ? 10 : 2),
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
  test(`lost appearance copy reply recovers the original receipt without a second copy via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    let copies = 0;
    const faulty = {
      ...backend,
      async execute(request: Parameters<typeof backend.execute>[0]) {
        const result = await backend.execute(request);
        if (request.source.includes('FMCAD.call("appearance.create"')) {
          copies++;
          throw new Error("Lost appearance copy reply");
        }
        return result;
      },
    };
    const [report] = await runScenarios(
      faulty,
      appearanceScenarios(simulatorFolder, 1),
      directory,
      1,
    );
    assert.equal(report?.status, "failed");
    assert.equal(report?.cleanup, "deferred");
    assert.ok(report?.document);
    const observed = await model.execute(
      program(`import adsk.core, adsk.fusion, json
app = adsk.core.Application.get()
owned = [doc for doc in app.documents if doc.creationId == ${JSON.stringify(report.document.creationId)}]
assert len(owned) == 1
assert owned[0].dataFile is not None and owned[0].dataFile.id == ${JSON.stringify(report.document.file!.fileId)}
design = adsk.fusion.Design.cast(owned[0].products.itemByProductType('DesignProductType'))
assert design is not None and design.appearances.count == 1
`),
    );
    assert.equal(observed.success, true, observed.error);
    const recovered = await resumeCleanup(
      backend,
      path.join(report!.directory, "report.json"),
    );
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.cleanup, "complete");
    assert.equal(copies, 1);
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
}

test("appearance identifiers from a protected saved document cannot edit its metadata through another owner", async (t) => {
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
    const created = await protectedSession.execute(
      "protected-appearance",
      program(`${guard(protectedSession.document)}
source = app.materialLibraries.item(0).appearances.item(0)
item = design.appearances.addByCopy(source, 'ProtectedAppearance')
${emit("dict(creationId=doc.creationId, id=item.id)")}`),
    );
    const foreignId = text(created["id"]);
    const before = await protectedSession.execute(
      "protected-before",
      appearanceReadback(protectedSession.document),
    );
    let edits = 0;
    const faulty = {
      ...backend,
      async execute(request: Parameters<typeof backend.execute>[0]) {
        if (request.source.includes('FMCAD.call("appearance.edit"')) {
          edits++;
          return backend.execute({
            ...request,
            source: request.source.replace(
              /model-appearance:[a-f0-9-]+/gu,
              foreignId,
            ),
          });
        }
        return backend.execute(request);
      },
    };
    const [report] = await runScenarios(
      faulty,
      appearanceScenarios(simulatorFolder, 1),
      directory,
      1,
    );
    assert.equal(edits, 1);
    assert.equal(report?.status, "failed");
    assert.equal(report?.cleanup, "complete");
    assert.deepEqual(
      await protectedSession.execute(
        "protected-after",
        appearanceReadback(protectedSession.document),
      ),
      before,
    );
  } finally {
    await protectedSession.cleanup();
  }
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("model appearance copies detach metadata, preserve parent ownership and refuse library or closed-document writes", async (t) => {
  const { model } = await fixture(t);
  const result = await model.execute(
    program(`import adsk.core, adsk.fusion
app = adsk.core.Application.get()
a = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
b = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
da = adsk.fusion.Design.cast(a.products.itemByProductType('DesignProductType'))
db = adsk.fusion.Design.cast(b.products.itemByProductType('DesignProductType'))
assert da is not None and db is not None
source = app.materialLibraries.item(0).appearances.item(0)
original = source.name
try:
    source.name = 'ForbiddenLibraryEdit'
except ValueError:
    pass
else:
    raise AssertionError('Library mutation accepted')
first = da.appearances.addByCopy(source, 'A')
second = db.appearances.addByCopy(first, 'B')
assert first.parent is da and second.parent is db
assert first.appearanceProperties is not second.appearanceProperties
first.name = 'A changed'
assert second.name == 'B'
assert source.name == original
assert a.close(False)
try:
    first.name = 'ClosedEdit'
except ValueError:
    pass
else:
    raise AssertionError('Closed document mutation accepted')
assert b.close(False)
`),
  );
  assert.equal(result.success, true, result.error);
});

test("an appearance-copy assertion failure cleans the owned saved file and stops before rename", async (t) => {
  const { backend, model, directory } = await fixture(t);
  let edits = 0;
  const faulty = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      const result = await backend.execute(request);
      if (request.source.includes('FMCAD.call("appearance.edit"')) edits++;
      if (request.source.includes('FMCAD.call("appearance.create"')) {
        const lines = result.stdout.split("\n");
        const index = lines.findIndex((line) =>
          line.startsWith("FMCAD_SCENARIO "),
        );
        const value = JSON.parse(lines[index]!.slice("FMCAD_SCENARIO ".length));
        value.result.copiedFrom = "wrong-source";
        lines[index] = "FMCAD_SCENARIO " + JSON.stringify(value);
        return { ...result, stdout: lines.join("\n") };
      }
      return result;
    },
  };
  const [report] = await runScenarios(
    faulty,
    appearanceScenarios(simulatorFolder, 1),
    directory,
    1,
  );
  assert.equal(report?.status, "failed");
  assert.equal(report?.cleanup, "complete");
  assert.equal(edits, 0);
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("a boolean projection cannot satisfy the historical nullable property assertion", async (t) => {
  const { backend, model, directory } = await fixture(t);
  const faulty = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      const result = await backend.execute(request);
      if (!request.source.includes('FMCAD.call("appearance.projection"'))
        return result;
      const lines = result.stdout.split("\n");
      const index = lines.findIndex((line) =>
        line.startsWith("FMCAD_SCENARIO "),
      );
      const value = JSON.parse(lines[index]!.slice("FMCAD_SCENARIO ".length));
      value.result.projection = false;
      lines[index] = "FMCAD_SCENARIO " + JSON.stringify(value);
      return { ...result, stdout: lines.join("\n") };
    },
  };
  const [report] = await runScenarios(
    faulty,
    appearanceScenarios(simulatorFolder, 1),
    directory,
    1,
  );
  assert.equal(report?.status, "failed");
  assert.equal(report?.cleanup, "complete");
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});
