import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, remaining } from "./test-support";

test("synthetic appearance descriptors are immutable metadata bound to the copied resource", async (t) => {
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
    root = a.rootComponent
    sketch = root.sketches.add(root.xYConstructionPlane)
    _ = sketch.sketchCurves.sketchLines.addTwoPointRectangle(
        adsk.core.Point3D.create(0, 0, 0), adsk.core.Point3D.create(2, 3, 0))
    profile = sketch.profiles.item(0)
    extrudes = root.features.extrudeFeatures
    input = extrudes.createInput(profile, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
    extent = adsk.fusion.DistanceExtentDefinition.create(
        adsk.core.ValueInput.createByString('2 mm'))
    assert input.setOneSideExtent(extent, adsk.fusion.ExtentDirections.PositiveExtentDirection)
    assert extrudes.add(input) is not None
    body = root.bRepBodies.item(0)
    faces = list(body.faces)
    assert len(faces) == 6
    assert len({face.entityToken for face in faces}) == 6
    for face in faces:
        assert face.objectType == 'adsk::fusion::BRepFace'
        assert face.body is body and face.parentComponent is root and face.isValid
        assert face.appearance is None and face.appearanceSourceType is None
        assert not hasattr(face, 'geometry')
    try:
        body.faces.item(0)
    except NotImplementedError:
        pass
    else:
        raise AssertionError('Synthetic face identity exposed indexed topology')
    source = app.materialLibraries.item(0).appearances.item(0)
    one = a.appearances.addByCopy(source, 'First descriptor copy')
    two = b.appearances.addByCopy(one, 'Second descriptor copy')
    props = [item.appearanceProperties.item(0) for item in (source, one, two)]
    assert len({id(prop) for prop in props}) == 3
    for item, prop in zip((source, one, two), props):
        assert item.appearanceProperties.count == 1
        assert prop.id == 'model:test-property'
        assert prop.name == 'Model descriptor only'
        assert prop.isReadOnly is True
        assert prop.parent is item
        assert not hasattr(prop, 'value')
        assert item.appearanceProperties.itemById(prop.id) is prop
        assert item.appearanceProperties.itemByName(prop.name) is prop
        assert item.appearanceProperties.itemById('missing') is None
        assert item.appearanceProperties.itemByName('missing') is None
        for field, value in (('id', 'foreign'), ('name', 'foreign'), ('isReadOnly', False), ('parent', source)):
            try:
                setattr(prop, field, value)
            except AttributeError:
                pass
            else:
                raise AssertionError('Immutable descriptor field changed: ' + field)
    first.close(False)
    for field in ('id', 'name', 'isReadOnly', 'parent'):
        try:
            getattr(props[1], field)
        except ValueError as error:
            assert 'closed' in str(error)
        else:
            raise AssertionError('Closed document descriptor readable: ' + field)
    assert props[0].parent is source and props[2].parent is two
    assert props[2].id == props[0].id == 'model:test-property'
finally:
    if first.isValid: first.close(False)
    if second.isValid: second.close(False)
`, false);
  assert.equal(result.success, true, result.error);
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});
