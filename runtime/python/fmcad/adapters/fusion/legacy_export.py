import adsk.core
import adsk.fusion

OP = "help"
ARGS = []

USAGE = [
    "export <stl|step> <body|''> <out_path> <doc>",
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


def _find_body(root, name):
    for i in range(root.bRepBodies.count):
        b = root.bRepBodies.item(i)
        if b.name == name:
            return b
    return None


def cmd_export(data, fmt, body_name, out_path, doc_name):
    design = _design(doc_name)
    if design is None:
        return
    root = design.rootComponent
    geom = root
    if body_name:
        b = _find_body(root, body_name)
        if b is None:
            _err("body not found: " + body_name)
            return
        geom = b
    em = design.exportManager
    ok = False
    if fmt == "stl":
        opts = em.createSTLExportOptions(geom, out_path)
        ok = em.execute(opts)
    elif fmt == "step":
        opts = em.createSTEPExportOptions(out_path, geom)
        ok = em.execute(opts)
    else:
        _err("unknown export format: " + fmt)
        return
    if not ok:
        _err("export " + fmt + " to " + out_path)
        return
    print("EXPORTED path=" + out_path)
    print("DONE")


def run(_context: str):
    app = adsk.core.Application.get()
    data = app.data
    if OP == "export":
        cmd_export(data, ARGS[0], ARGS[1] if len(ARGS) > 1 else "", ARGS[2] if len(ARGS) > 2 else "", ARGS[3] if len(ARGS) > 3 else "")
    else:
        for line in USAGE:
            print("USAGE " + line)
