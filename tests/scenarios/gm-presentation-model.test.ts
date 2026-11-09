import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, remaining } from "./test-support";

test("sketch visibility is document-local and closed design recompute cannot succeed", async (t) => {
  const { model } = await fixture(t);
  const result = await model.execute(`
import adsk.core, adsk.fusion
app = adsk.core.Application.get()
first = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
second = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
try:
    a = adsk.fusion.Design.cast(first.products.itemByProductType('DesignProductType'))
    b = adsk.fusion.Design.cast(second.products.itemByProductType('DesignProductType'))
    assert a is not None and b is not None
    sa = a.rootComponent.sketches.add(a.rootComponent.xYConstructionPlane)
    sb = b.rootComponent.sketches.add(b.rootComponent.xYConstructionPlane)
    sb.isLightBulbOn = False
    assert sa.isLightBulbOn is True and sb.isLightBulbOn is False
    lines = sa.sketchCurves.sketchLines.addTwoPointRectangle(adsk.core.Point3D.create(0, 0, 0), adsk.core.Point3D.create(2, 3, 0))
    start = lines.item(0).startSketchPoint
    end = lines.item(0).endSketchPoint
    _ = sa.geometricConstraints.addCoincident(start, sa.originPoint)
    width = a.userParameters.add('width', adsk.core.ValueInput.createByString('20 mm'), 'mm', '')
    dimension = sa.sketchDimensions.addDistanceDimension(start, end, adsk.fusion.DimensionOrientations.HorizontalDimensionOrientation, adsk.core.Point3D.create(0, 0, 0))
    dimension.parameter.expression = 'width'
    width.expression = '25 mm'
    assert a.computeAll() is True and b.computeAll() is True
    assert abs(end.geometry.x - 2.5) < 1e-9
    width.expression = '-1 mm'
    try:
        a.computeAll()
    except ValueError as error:
        assert 'positive' in str(error)
    else:
        raise AssertionError('Invalid rectangular graph reported successful recompute')
    assert b.computeAll() is True and sb.isLightBulbOn is False
    width.expression = '30 mm'
    assert a.computeAll() is True and abs(end.geometry.x - 3) < 1e-9
    first.close(False)
    for action in (lambda: sa.isLightBulbOn, lambda: setattr(sa, 'isLightBulbOn', False), a.computeAll):
        try:
            action()
        except ValueError as error:
            assert 'closed' in str(error)
        else:
            raise AssertionError('Closed document allowed a visibility or recompute access')
    assert sb.isLightBulbOn is False and b.computeAll() is True
finally:
    if first.isValid: first.close(False)
    if second.isValid: second.close(False)
`);
  assert.equal(result.success, true, result.error);
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});
