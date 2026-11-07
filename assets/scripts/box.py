import adsk.core
import adsk.fusion
from typing import Callable, cast

ARGS = [10]
DOC_NAME = ""


def run(_context: str) -> None:
    cast_design = cast("Callable[[object], adsk.fusion.Design | None]", adsk.fusion.Design.cast)
    app = adsk.core.Application.get()
    design = None
    if DOC_NAME:
        matches = [d for d in app.documents if d.name.lower() == DOC_NAME.lower()]
        if len(matches) != 1:
            print("ERROR expected exactly one open document: " + DOC_NAME)
            return
        target = matches[0]
        design = cast_design(target.products.itemByProductType("DesignProductType"))
        if design is None:
            print("ERROR document is not a design: " + DOC_NAME)
            return
        if not target.activate() or app.activeDocument != target:
            print("ERROR could not activate document: " + DOC_NAME)
            return
        print("DOC name=" + target.name)
    else:
        design = cast_design(app.activeProduct)
    if not design:
        print("NO_DESIGN")
        return
    size = ARGS[0] if ARGS else 10
    cm = size / 10.0
    first = adsk.core.Point3D.create(0, 0, 0)
    second = adsk.core.Point3D.create(cm, cm, 0)
    if first is None or second is None:
        raise RuntimeError("Box corners are unavailable")
    root = design.rootComponent
    sketch = cast("adsk.fusion.Sketch | None", root.sketches.add(root.xYConstructionPlane))
    if sketch is None:
        raise RuntimeError("Box sketch creation failed")
    sketch.name = "BoxSketch"
    _ = sketch.sketchCurves.sketchLines.addTwoPointRectangle(first, second)
    prof = cast("adsk.fusion.Profile | None", sketch.profiles.item(0))
    if prof is None:
        raise RuntimeError("Box profile is unavailable")
    ext = root.features.extrudeFeatures
    inp = cast("adsk.fusion.ExtrudeFeatureInput | None", ext.createInput(prof, cast(adsk.fusion.FeatureOperations, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)))
    if inp is None:
        raise RuntimeError("Box extrusion input is unavailable")
    extent = cast("adsk.fusion.DistanceExtentDefinition | None", adsk.fusion.DistanceExtentDefinition.create(adsk.core.ValueInput.createByString(str(size) + " mm")))
    if extent is None or not inp.setOneSideExtent(extent, cast(adsk.fusion.ExtentDirections, adsk.fusion.ExtentDirections.PositiveExtentDirection)):
        raise RuntimeError("Box extrusion extent was rejected")
    feature = cast("adsk.fusion.ExtrudeFeature | None", ext.add(inp))
    if feature is None:
        raise RuntimeError("Box extrusion creation failed")
    print("BOX_CREATED size=" + str(size) + " mm")
