import test from "node:test";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { rectangleScenarios } from "./rectangle-cases";
import { runScenarios } from "./runner";
import { program } from "./programs";
for (const protocol of ["mcp", "addin"] as const) {
  for (const concurrency of [1, 2, 10]) {
    test(`dimensioned rectangles regenerate and reopen via ${protocol}, concurrency ${concurrency}`, async (t) => {
      const { backend, model, directory } = await fixture(t, protocol);
      const reports = await runScenarios(
        backend,
        rectangleScenarios(simulatorFolder, 10),
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

test("bounded dimensions reject foreign, driven, duplicate and unsupported orientation inputs", async (t) => {
  const { model } = await fixture(t);
  const result = await model.execute(
    program(`import adsk.core, adsk.fusion
app = adsk.core.Application.get()
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
design = adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))
assert design is not None
root = design.rootComponent
sketch = root.sketches.add(root.xYConstructionPlane)
lines = sketch.sketchCurves.sketchLines.addTwoPointRectangle(adsk.core.Point3D.create(0,0,0), adsk.core.Point3D.create(2,3,0))
first = lines.item(0).startSketchPoint
second = lines.item(0).endSketchPoint
_ = sketch.geometricConstraints.addCoincident(first, sketch.originPoint)
other = root.sketches.add(root.xYConstructionPlane)
for end, orientation, driving in [(other.originPoint, 0, True), (second, 2, True), (second, 0, False)]:
    try:
        sketch.sketchDimensions.addDistanceDimension(first, end, orientation, adsk.core.Point3D.create(0,0,0), driving)
    except (ValueError, NotImplementedError):
        pass
    else:
        raise AssertionError('Unsupported dimension accepted')
    assert sketch.sketchDimensions.count == 0
    assert second.geometry.asArray() == [2,0,0]
dimension = sketch.sketchDimensions.addDistanceDimension(first, second, 0, adsk.core.Point3D.create(0,0,0))
dimension.parameter.expression = '27 mm'
assert abs(second.geometry.x - 2.7) < 1e-9
for expression in ('0 mm', '-1 mm', 'missingParameter'):
    try:
        dimension.parameter.expression = expression
    except ValueError:
        pass
    else:
        raise AssertionError('Invalid dimension accepted')
    assert dimension.parameter.expression == '27 mm'
try:
    sketch.sketchDimensions.addDistanceDimension(first, second, 0, adsk.core.Point3D.create(0,0,0))
except ValueError:
    pass
else:
    raise AssertionError('Duplicate dimension accepted')
assert sketch.sketchDimensions.count == 1
assert doc.close(False)
`),
  );
  assert.equal(result.success, true, result.error);
});
