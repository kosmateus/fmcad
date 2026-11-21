import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, remaining } from "./test-support";
import { record } from "./contracts";
import { emit, guard, program } from "./programs";
import { gmCommands } from "./gm-command-contract";
import { runScenarios } from "./runner";
import { simulatorFolder } from "./simulator";

test("new component occurrences expose the Fusion entity type", async (t) => {
  const { model } = await fixture(t);
  const result = await model.execute(
    `
import adsk.core, adsk.fusion
app = adsk.core.Application.get()
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
try:
    design = adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))
    assert design is not None
    placement = adsk.core.Matrix3D.create()
    cells = placement.asArray()
    cells[3] = 1.25
    assert placement.setWithArray(cells)
    occurrence = design.rootComponent.occurrences.addNewComponent(placement)
    assert occurrence.objectType == 'adsk::fusion::Occurrence'
    assert occurrence.fullPathName == occurrence.name
    assert occurrence.component in design.allComponents
    all_occurrences = design.rootComponent.allOccurrences
    assert all_occurrences.count == 1 and all_occurrences.item(0) is occurrence
    transform = occurrence.transform2
    cells = transform.asArray()
    assert cells[3] == 1.25 and cells[7] == cells[11] == 0
    cells[3] = 2.5
    assert transform.setWithArray(cells)
    occurrence.transform2 = transform
    assert occurrence.transform2.asArray()[3] == 2.5
    cells[3] = 3.5
    assert occurrence.transform2.asArray()[3] == 2.5
    rotated = adsk.core.Matrix3D.create()
    cells = rotated.asArray()
    cells[0] = 0
    assert rotated.setWithArray(cells)
    try:
        occurrence.transform2 = rotated
    except NotImplementedError:
        pass
    else:
        raise AssertionError('Occurrence rotation accepted')
    occurrence.component.occurrences.addNewComponent(adsk.core.Matrix3D.create())
    try:
        design.rootComponent.allOccurrences
    except NotImplementedError:
        pass
    else:
        raise AssertionError('Nested occurrence enumeration accepted')
finally:
    doc.close(False)
`,
    false,
  );
  assert.equal(result.success, true, result.error);
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("Matrix3D stores coordinate-system axes and origin", async (t) => {
  const { model } = await fixture(t);
  const result = await model.execute(
    `
import adsk.core
matrix = adsk.core.Matrix3D.create()
assert matrix.setWithCoordinateSystem(
    adsk.core.Point3D.create(1, -2, 3),
    adsk.core.Vector3D.create(1, 0, 0),
    adsk.core.Vector3D.create(0, 1, 0),
    adsk.core.Vector3D.create(0, 0, 1))
assert matrix.asArray() == [1, 0, 0, 1, 0, 1, 0, -2, 0, 0, 1, 3, 0, 0, 0, 1]
matrix.translation = adsk.core.Vector3D.create(4, 5, 6)
assert matrix.asArray()[3:12:4] == [4, 5, 6]
`,
    false,
  );
  assert.equal(result.success, true, result.error);
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

for (const protocol of ["mcp", "addin"] as const) {
  test(`component.create preserves root translation placement via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    const reports = await runScenarios(
      backend,
      [
        {
          id: "component-create-translation",
          fixture: simulatorFolder,
          requires: ["documents"],
          async run(session) {
            const { fmcad } = gmCommands(session);
            await fmcad([
              "component",
              "create",
              "--doc",
              session.document.name,
              "--data",
              JSON.stringify({
                name: "Translated",
                placement: {
                  translation: ["10 mm", "-20 mm", "30 mm"],
                },
              }),
            ]);
            const readback = await session.execute(
              "placement-readback",
              program(`${guard(session.document)}
occurrence = design.rootComponent.occurrences.item(0)
matrix = occurrence.transform2.asArray()
assert matrix[3] == 1 and matrix[7] == -2 and matrix[11] == 3
${emit("dict(creationId=doc.creationId, translation=[matrix[3], matrix[7], matrix[11]])")}`),
              session.document,
            );
            assert.deepEqual(record(readback)["translation"], [1, -2, 3]);
          },
        },
      ],
      directory,
      1,
    );
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.status, "passed", JSON.stringify(reports[0]));
    assert.equal(reports[0]?.cleanup, "complete");
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
}
