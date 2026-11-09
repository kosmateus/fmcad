import test from "node:test";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { program } from "./programs";

// Model controls only occur here. Native/shared cases must use observed cloud
// completion, never advance_model or a simulated archive as native evidence.
test("saved model snapshots preserve geometry and attributes without retaining live edits", async (t) => {
  const { model } = await fixture(t);
  const result = await model.execute(
    program(`import adsk.core, adsk.fusion
app = adsk.core.Application.get()
folder = app.data.dataProjects.item(0).rootFolder
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
doc.name = 'Owned persistence test'
design = adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))
assert design is not None
root = design.rootComponent
sketch = root.sketches.add(root.xYConstructionPlane)
sketch.name = 'Saved rectangle'
_ = sketch.sketchCurves.sketchLines.addTwoPointRectangle(adsk.core.Point3D.create(0, 0, 0), adsk.core.Point3D.create(2, 3, 0))
extrudes = root.features.extrudeFeatures
spec = extrudes.createInput(sketch.profiles.item(0), adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
assert spec.setOneSideExtent(adsk.fusion.DistanceExtentDefinition.create(adsk.core.ValueInput.createByReal(4)), adsk.fusion.ExtentDirections.PositiveExtentDirection)
body = extrudes.add(spec).bodies.item(0)
body.name = 'Saved prism'
attr = body.attributes.add('owner', 'value', 'saved')
assert attr is not None
_ = design.userParameters.add('width', adsk.core.ValueInput.createByString('20 mm'), 'mm', 'saved comment')
assert doc.saveAs(doc.name, folder, '', '')
file = doc.dataFile
assert file is not None and file.versionNumber == 1
assert not file.isComplete
for _ in range(2):
    app.data.advance_model()
assert file.isComplete
assert app.documents.open(file, False) is doc
# Mutate the live graph after saving; opening must reconstruct the saved graph.
attr.value = 'discarded'
body.name = 'Discarded name'
old_id = doc.creationId
token = body.entityToken
assert doc.close(False)
assert design.findEntityByToken(token) == []
reopened = app.documents.open(file)
assert reopened.creationId != old_id
assert reopened.dataFile is file and reopened.isSaved and not reopened.isModified
restored = adsk.fusion.Design.cast(reopened.products.itemByProductType('DesignProductType'))
assert restored is not None
restored_body = restored.rootComponent.bRepBodies.item(0)
assert restored_body is not body
assert restored_body.name == 'Saved prism'
assert restored_body.physicalProperties.volume == 24
assert restored_body.boundingBox.maxPoint.asArray() == [2, 3, 4]
assert restored.rootComponent.sketches.item(0).name == 'Saved rectangle'
assert restored.rootComponent.sketches.item(0).profiles.count == 1
assert restored.timeline.count == 2 and restored.timeline.markerPosition == 2
assert len(restored.findEntityByToken(token)) == 1
saved_attr = restored_body.attributes.itemByName('owner', 'value')
assert saved_attr is not None and saved_attr.value == 'saved'
parameter = restored.userParameters.itemByName('width')
assert parameter is not None and parameter.expression == '20 mm' and parameter.comment == 'saved comment'
# A modified save creates a new snapshot/version; a no-op does not.
saved_attr.value = 'version two'
assert reopened.isModified and reopened.save('second')
second = reopened.dataFile
assert second is not None and second.id == file.id and second.versionNumber == 2
for _ in range(2):
    app.data.advance_model()
assert reopened.save('no-op') and reopened.dataFile is second
assert app.data.save_calls == 2
assert reopened.close(False)
try:
    app.documents.open(file)
except ValueError as error:
    assert 'superseded' in str(error)
else:
    raise AssertionError('Superseded version silently opened as latest')
third = app.documents.open(second)
third_design = adsk.fusion.Design.cast(third.products.itemByProductType('DesignProductType'))
assert third_design is not None
third_attr = third_design.rootComponent.bRepBodies.item(0).attributes.itemByName('owner', 'value')
assert third_attr is not None and third_attr.value == 'version two'
assert third.close(False)
assert second.deleteMe()
for _ in range(2):
    app.data.advance_model()
assert folder.dataFiles.count == 0
`),
  );
  assert.equal(result.success, true, result.error);
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("open rejects foreign, incomplete, deleting and deleted files without creating documents", async (t) => {
  const { model } = await fixture(t);
  const result = await model.execute(
    program(`import adsk.core
app = adsk.core.Application.get()
folder = app.data.dataProjects.item(0).rootFolder
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
assert doc.saveAs('Owned', folder, '', '')
file = doc.dataFile
assert file is not None
assert doc.close(False)
try:
    app.documents.open(file)
except ValueError:
    pass
else:
    raise AssertionError('Incomplete file opened')
for _ in range(2):
    app.data.advance_model()
foreign = adsk.core.Application()
try:
    foreign.documents.open(file)
except ValueError:
    pass
else:
    raise AssertionError('Foreign file opened')
assert foreign.documents.count == 0
assert file.deleteMe()
for deleted in [False, True]:
    if deleted:
        for _ in range(2):
            app.data.advance_model()
    try:
        app.documents.open(file)
    except ValueError:
        pass
    else:
        raise AssertionError('Deleting/deleted file opened')
assert app.documents.count == 0
assert app.data.save_calls == 1 and app.data.delete_calls == 1
`),
  );
  assert.equal(result.success, true, result.error);
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});
