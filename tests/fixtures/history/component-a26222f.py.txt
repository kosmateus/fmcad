import adsk.core
import adsk.fusion

OP = "help"
ARGS = []

USAGE = [
    "comp_list <doc>",
    "comp_add <name> <parent|''> <doc>",
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


def _find_comp(design, name):
    if design.rootComponent.name == name:
        return design.rootComponent
    for c in design.allComponents:
        if c.name == name:
            return c
    return None


def cmd_comp_list(data, doc_name):
    design = _design(doc_name)
    if design is None:
        return
    root = design.rootComponent
    print("COMP name=" + root.name + " parent=-")

    def rec(occs, parent):
        for i in range(occs.count):
            o = occs.item(i)
            print("COMP name=" + o.component.name + " parent=" + parent)
            rec(o.component.occurrences, o.component.name)

    rec(root.occurrences, root.name)
    print("DONE")


def cmd_comp_add(data, doc_name, name, parent_name):
    design = _design(doc_name)
    if design is None:
        return
    if _find_comp(design, name) is not None:
        print("EXISTS name=" + name)
        print("DONE")
        return
    target = design.rootComponent
    if parent_name:
        p = _find_comp(design, parent_name)
        if p is None:
            _err("parent component not found: " + parent_name)
            return
        target = p
    occ = target.occurrences.addNewComponent(adsk.core.Matrix3D.create())
    if occ is None:
        _err("comp_add " + name)
        return
    occ.component.name = name
    print("CREATED_COMP name=" + occ.component.name + " parent=" + target.name)
    print("DONE")


def run(_context: str):
    app = adsk.core.Application.get()
    data = app.data
    if OP == "comp_list":
        cmd_comp_list(data, ARGS[0] if len(ARGS) > 0 else "")
    elif OP == "comp_add":
        doc = ARGS[len(ARGS) - 1]
        parent = ARGS[1] if len(ARGS) > 2 else ""
        cmd_comp_add(data, doc, ARGS[0], parent)
    else:
        for line in USAGE:
            print("USAGE " + line)
