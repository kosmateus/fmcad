from typing import Callable, cast
import adsk.core
import adsk.fusion

OP = "help"
ARGS: list[str] = []

USAGE = [
    "stats <doc>",
    "bbox <doc>",
    "bodies <doc>",
    "rollback <pos> <doc>",
    "units <mm|cm|in> <doc>",
]


def _err(msg: str) -> None:
    print("ERROR " + msg)


def _design(doc_name: str) -> "adsk.fusion.Design | None":
    app = adsk.core.Application.get()
    if not doc_name:
        _err("document commands require a document name")
        return None
    matches = [d for d in app.documents if d.name.lower() == doc_name.lower()]
    if not matches:
        _err("document not open: " + doc_name)
        return None
    if len(matches) != 1:
        _err("document name is ambiguous: " + doc_name)
        return None
    doc = matches[0]
    if not doc.activate():
        _err("document activation failed: " + doc_name)
        return None
    active = cast("adsk.core.Document | None", app.activeDocument)
    if active is None or active.creationId != doc.creationId:
        _err("active document identity changed: " + doc_name)
        return None
    design_cast = cast("Callable[[object], adsk.fusion.Design | None]", getattr(adsk.fusion.Design, "cast"))
    design = design_cast(app.activeProduct)
    if design is None:
        _err("document is not a design: " + doc_name)
        return None
    print("DOC name=" + doc.name)
    return design


def cmd_stats(data: object, doc_name: str) -> None:
    design = _design(doc_name)
    if design is None:
        return
    root = design.rootComponent
    print("BODIES=" + str(root.bRepBodies.count) + " FEATURES=" + str(root.features.count) + " SKETCHES=" + str(root.sketches.count) + " USER_PARAMS=" + str(design.userParameters.count) + " PLANES=" + str(root.constructionPlanes.count))
    tl = design.timeline
    for i in range(tl.count):
        item = cast("adsk.fusion.TimelineObject | None", tl.item(i))
        if item is None:
            raise RuntimeError("Timeline item disappeared: " + str(i))
        if cast(object, item.healthState) != adsk.fusion.FeatureHealthStates.HealthyFeatureHealthState:
            print("TIMELINE_ISSUE name=" + str(item.name) + " state=" + str(item.healthState) + " msg=" + str(item.errorOrWarningMessage))
    print("DONE")


def cmd_bbox(data: object, doc_name: str) -> None:
    design = _design(doc_name)
    if design is None:
        return
    root = design.rootComponent
    for i in range(root.bRepBodies.count):
        b = cast("adsk.fusion.BRepBody | None", root.bRepBodies.item(i))
        if b is None:
            raise RuntimeError("Body disappeared: " + str(i))
        bb = b.boundingBox
        mi = bb.minPoint
        ma = bb.maxPoint
        print("BODY name=%s min=(%.2f,%.2f,%.2f) max=(%.2f,%.2f,%.2f) size=(%.1f x %.1f x %.1f) mm" % (
            b.name, mi.x * 10, mi.y * 10, mi.z * 10, ma.x * 10, ma.y * 10, ma.z * 10,
            (ma.x - mi.x) * 10, (ma.y - mi.y) * 10, (ma.z - mi.z) * 10))
    print("DONE")


def cmd_bodies(data: object, doc_name: str) -> None:
    design = _design(doc_name)
    if design is None:
        return
    root = design.rootComponent
    for i in range(root.bRepBodies.count):
        b = cast("adsk.fusion.BRepBody | None", root.bRepBodies.item(i))
        if b is None:
            raise RuntimeError("Body disappeared: " + str(i))
        vol = 0.0
        try:
            vol = b.physicalProperties.volume * 1000.0
        except Exception:
            pass
        print("BODY name=" + b.name + " volume=%.2f mm3 visible=%s" % (vol, b.isVisible))
    print("DONE")


def cmd_rollback(data: object, doc_name: str, pos: str) -> None:
    design = _design(doc_name)
    if design is None:
        return
    p = int(pos)
    tl = design.timeline
    if p < 0 or p > tl.count:
        _err("rollback position out of range: " + str(p) + " (valid 0.." + str(tl.count) + ")")
        return
    tl.markerPosition = p
    print("ROLLBACK pos=" + str(tl.markerPosition) + " of " + str(tl.count))
    print("DONE")


UNITS_MAP = {
    "mm": adsk.fusion.DistanceUnits.MillimeterDistanceUnits,
    "cm": adsk.fusion.DistanceUnits.CentimeterDistanceUnits,
    "in": adsk.fusion.DistanceUnits.InchDistanceUnits,
}


def cmd_units(data: object, doc_name: str, unit: str) -> None:
    design = _design(doc_name)
    if design is None:
        return
    low = unit.lower()
    if low not in UNITS_MAP:
        _err("unsupported unit: " + unit + " (use mm, cm or in)")
        return
    units = cast("adsk.fusion.FusionUnitsManager", design.unitsManager)
    units.distanceDisplayUnits = cast("adsk.fusion.DistanceUnits", UNITS_MAP[low])
    print("UNITS distanceDisplayUnits=" + str(units.distanceDisplayUnits))
    print("DONE")


def run(_context: str) -> None:
    app = adsk.core.Application.get()
    data = app.data
    operation = cast(str, OP)
    if operation == "stats":
        cmd_stats(data, ARGS[0] if len(ARGS) > 0 else "")
    elif operation == "bbox":
        cmd_bbox(data, ARGS[0] if len(ARGS) > 0 else "")
    elif operation == "bodies":
        cmd_bodies(data, ARGS[0] if len(ARGS) > 0 else "")
    elif operation == "rollback":
        cmd_rollback(data, ARGS[1] if len(ARGS) > 1 else "", ARGS[0])
    elif operation == "units":
        cmd_units(data, ARGS[1] if len(ARGS) > 1 else "", ARGS[0])
    else:
        for line in USAGE:
            print("USAGE " + line)
