
OP = "help"
ARGS: list[str] = []

USAGE = [
    "comp_list <doc>",
    "comp_add <name> <parent|''> <doc>",
]


def _find_comp(design: adsk.fusion.Design, name: str) -> "adsk.fusion.Component | None":
    root = design.rootComponent
    matches = [root] if root.name == name else []
    matches.extend(c for c in design.allComponents if c != root and c.name == name)
    if len(matches) > 1:
        raise ValueError("ambiguous component name: " + name)
    return matches[0] if matches else None


def cmd_comp_list(data: object, doc_name: str) -> None:
    design = _design(doc_name)
    if design is None:
        return
    root = design.rootComponent
    print("COMP name=" + root.name + " parent=-")

    def rec(occs: adsk.fusion.Occurrences, parent: str) -> None:
        for i in range(occs.count):
            o = cast("adsk.fusion.Occurrence | None", occs.item(i))
            if o is None:
                raise RuntimeError("Component occurrence disappeared: " + str(i))
            print("COMP name=" + o.component.name + " parent=" + parent)
            rec(o.component.occurrences, o.component.name)

    rec(root.occurrences, root.name)
    print("DONE")


def cmd_comp_add(data: object, doc_name: str, name: str, parent_name: str) -> None:
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
    occ = cast("adsk.fusion.Occurrence | None", target.occurrences.addNewComponent(adsk.core.Matrix3D.create()))
    if occ is None:
        _err("comp_add " + name)
        return
    occ.component.name = name
    print("CREATED_COMP name=" + occ.component.name + " parent=" + target.name)
    print("DONE")


def dispatch_component(operation: str, args: list[str]) -> None:
    app = adsk.core.Application.get()
    data = app.data
    if operation == "comp_list":
        cmd_comp_list(data, args[0] if len(args) > 0 else "")
    elif operation == "comp_add":
        doc = args[len(args) - 1]
        parent = args[1] if len(args) > 2 else ""
        cmd_comp_add(data, doc, args[0], parent)
    else:
        for line in USAGE:
            print("USAGE " + line)


def run(_context: str) -> None:
    dispatch_component(OP, ARGS)
