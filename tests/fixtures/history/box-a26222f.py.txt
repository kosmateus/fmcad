import adsk.core
import adsk.fusion

ARGS = [10]
DOC_NAME = ""


def run(_context):
    app = adsk.core.Application.get()
    design = None
    if DOC_NAME:
        matches = [d for d in app.documents if d.name.lower() == DOC_NAME.lower()]
        if len(matches) != 1:
            print("ERROR expected exactly one open document: " + DOC_NAME)
            return
        target = matches[0]
        design = adsk.fusion.Design.cast(target.products.itemByProductType("DesignProductType"))
        if design is None:
            print("ERROR document is not a design: " + DOC_NAME)
            return
        if not target.activate() or app.activeDocument != target:
            print("ERROR could not activate document: " + DOC_NAME)
            return
        print("DOC name=" + target.name)
    else:
        design = adsk.fusion.Design.cast(app.activeProduct)
    if not design:
        print("NO_DESIGN")
        return
    size = ARGS[0] if ARGS else 10
    cm = size / 10.0
    root = design.rootComponent
    sketch = root.sketches.add(root.xYConstructionPlane)
    sketch.name = "BoxSketch"
    sketch.sketchCurves.sketchLines.addTwoPointRectangle(
        adsk.core.Point3D.create(0, 0, 0),
        adsk.core.Point3D.create(cm, cm, 0))
    prof = sketch.profiles.item(0)
    ext = root.features.extrudeFeatures
    inp = ext.createInput(prof, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
    inp.setDistanceExtent(False, adsk.core.ValueInput.createByString(str(size) + " mm"))
    ext.add(inp)
    print("BOX_CREATED size=" + str(size) + " mm")
