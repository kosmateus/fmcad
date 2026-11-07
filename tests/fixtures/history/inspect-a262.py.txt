import adsk.core
import adsk.fusion

OP = "help"
ARGS = []

USAGE = [
    "stats <doc>",
    "bbox <doc>",
    "bodies <doc>",
    "rollback <pos> <doc>",
    "units <mm|cm|in> <doc>",
]


def _err(msg):
    print("ERROR " + msg)


def _design(doc_name):
    app = adsk.core.Application.get()
    if not doc_name:
        _err("document commands require a document name")
        return None
    for d in app.documents:
        if d.name.lower() == doc_name.lower():
            d.activate()
            design = adsk.fusion.Design.cast(app.activeProduct)
            if design is None:
                _err("document is not a design: " + doc_name)
                return None
            print("DOC name=" + d.name)
            return design
    _err("document not open: " + doc_name)
    return None


def cmd_stats(data, doc_name):
    design = _design(doc_name)
    if design is None:
        return
    root = design.rootComponent
    print("BODIES=" + str(root.bRepBodies.count) + " FEATURES=" + str(root.features.count) + " SKETCHES=" + str(root.sketches.count) + " USER_PARAMS=" + str(design.userParameters.count) + " PLANES=" + str(root.constructionPlanes.count))
    tl = design.timeline
    for i in range(tl.count):
        item = tl.item(i)
        if item.healthState != adsk.fusion.FeatureHealthStates.HealthyFeatureHealthState:
            print("TIMELINE_ISSUE name=" + str(item.name) + " state=" + str(item.healthState) + " msg=" + str(item.errorOrWarningMessage))
    print("DONE")


def cmd_bbox(data, doc_name):
    design = _design(doc_name)
    if design is None:
        return
    root = design.rootComponent
    for i in range(root.bRepBodies.count):
        b = root.bRepBodies.item(i)
        bb = b.boundingBox
        mi = bb.minPoint
        ma = bb.maxPoint
        print("BODY name=%s min=(%.2f,%.2f,%.2f) max=(%.2f,%.2f,%.2f) size=(%.1f x %.1f x %.1f) mm" % (
            b.name, mi.x * 10, mi.y * 10, mi.z * 10, ma.x * 10, ma.y * 10, ma.z * 10,
            (ma.x - mi.x) * 10, (ma.y - mi.y) * 10, (ma.z - mi.z) * 10))
    print("DONE")


def cmd_bodies(data, doc_name):
    design = _design(doc_name)
    if design is None:
        return
    root = design.rootComponent
    for i in range(root.bRepBodies.count):
        b = root.bRepBodies.item(i)
        vol = 0.0
        try:
            vol = b.physicalProperties.volume * 1000.0
        except Exception:
            pass
        print("BODY name=" + b.name + " volume=%.2f mm3 visible=%s" % (vol, b.isVisible))
    print("DONE")


def cmd_rollback(data, doc_name, pos):
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


def cmd_units(data, doc_name, unit):
    design = _design(doc_name)
    if design is None:
        return
    low = unit.lower()
    if low not in UNITS_MAP:
        _err("unsupported unit: " + unit + " (use mm, cm or in)")
        return
    design.unitsManager.distanceDisplayUnits = UNITS_MAP[low]
    print("UNITS distanceDisplayUnits=" + str(design.unitsManager.distanceDisplayUnits))
    print("DONE")


def run(_context: str):
    app = adsk.core.Application.get()
    data = app.data
    if OP == "stats":
        cmd_stats(data, ARGS[0] if len(ARGS) > 0 else "")
    elif OP == "bbox":
        cmd_bbox(data, ARGS[0] if len(ARGS) > 0 else "")
    elif OP == "bodies":
        cmd_bodies(data, ARGS[0] if len(ARGS) > 0 else "")
    elif OP == "rollback":
        cmd_rollback(data, ARGS[1] if len(ARGS) > 1 else "", ARGS[0])
    elif OP == "units":
        cmd_units(data, ARGS[1] if len(ARGS) > 1 else "", ARGS[0])
    else:
        for line in USAGE:
            print("USAGE " + line)
