"""Legacy construction-plane commands, composed with legacy_document.py."""

OP = "help"
ARGS: list[str] = []
USAGE = ["plane_list", "plane_add <name> offset <ref> <distance>",
         "plane_add <name> mid <ref1> <ref2>", "plane_add <name> angle <ref> <axis> <angle>",
         "plane_rename <name> <new_name>", "plane_delete <name>"]


def _root(doc_name: str) -> "adsk.fusion.Component | None":
    design = _design(doc_name)
    if design is None:
        return None
    return design.rootComponent


def _find_plane(root: adsk.fusion.Component, name: str) -> "adsk.fusion.ConstructionPlane | None":
    for p in root.constructionPlanes:
        if p.name == name:
            return p
    return None


def _resolve_plane_ref(root: adsk.fusion.Component, ref: str) -> "adsk.fusion.ConstructionPlane | None":
    low = ref.lower()
    if low == "xy":
        return root.xYConstructionPlane
    if low == "xz":
        return root.xZConstructionPlane
    if low == "yz":
        return root.yZConstructionPlane
    return _find_plane(root, ref)


def _resolve_axis(root: adsk.fusion.Component, axis: str) -> "adsk.fusion.ConstructionAxis | None":
    low = axis.lower()
    if low == "x":
        return root.xConstructionAxis
    if low == "y":
        return root.yConstructionAxis
    if low == "z":
        return root.zConstructionAxis
    return None


def cmd_plane_list(data: object, doc_name: str) -> None:
    root = _root(doc_name)
    if root is None:
        return
    for p in root.constructionPlanes:
        print("PLANE name=" + p.name)
    print("DONE")


def cmd_plane_add(data: object, doc_name: str, name: str, mode: str, mode_args: list[str]) -> None:
    root = _root(doc_name)
    if root is None:
        return
    if _find_plane(root, name) is not None:
        print("EXISTS name=" + name)
        print("DONE")
        return
    inp = root.constructionPlanes.createInput()
    ok = False
    if mode == "offset":
        if len(mode_args) < 2:
            _err("plane_add offset needs <ref> <distance>")
            return
        ref = _resolve_plane_ref(root, mode_args[0])
        if ref is None:
            _err("plane ref not found: " + mode_args[0])
            return
        ok = inp.setByOffset(ref, adsk.core.ValueInput.createByString(mode_args[1]))
    elif mode == "mid":
        if len(mode_args) < 2:
            _err("plane_add mid needs <ref1> <ref2>")
            return
        a = _resolve_plane_ref(root, mode_args[0])
        b = _resolve_plane_ref(root, mode_args[1])
        if a is None or b is None:
            _err("plane ref not found")
            return
        ok = inp.setByTwoPlanes(a, b)
    elif mode == "angle":
        if len(mode_args) < 3:
            _err("plane_add angle needs <ref> <axis> <angle>")
            return
        ref = _resolve_plane_ref(root, mode_args[0])
        axis = _resolve_axis(root, mode_args[1])
        if ref is None or axis is None:
            _err("plane ref or axis not found")
            return
        ok = inp.setByAngle(axis, adsk.core.ValueInput.createByString(mode_args[2]), ref)
    else:
        _err("unknown plane mode: " + mode)
        return
    if not ok:
        _err("plane_add definition failed")
        return
    p = cast("adsk.fusion.ConstructionPlane | None", root.constructionPlanes.add(inp))
    if p is None:
        _err("plane_add " + name)
        return
    p.name = name
    print("CREATED_PLANE name=" + p.name)
    print("DONE")


def cmd_plane_rename(data: object, doc_name: str, name: str, new_name: str) -> None:
    root = _root(doc_name)
    if root is None:
        return
    p = _find_plane(root, name)
    if p is None:
        _err("plane not found: " + name)
        return
    p.name = new_name
    print("RENAMED_PLANE new=" + p.name)
    print("DONE")


def cmd_plane_delete(data: object, doc_name: str, name: str) -> None:
    root = _root(doc_name)
    if root is None:
        return
    p = _find_plane(root, name)
    if p is None:
        _err("plane not found: " + name)
        return
    if p.deleteMe():
        print("DELETED_PLANE name=" + name)
    else:
        _err("plane_delete " + name)
    print("DONE")


def dispatch_plane(operation: str, args: list[str]) -> None:
    data = adsk.core.Application.get().data
    if operation == "plane_list":
        cmd_plane_list(data, args[0] if len(args) > 0 else "")
    elif operation == "plane_add":
        doc = args[-1]
        cmd_plane_add(data, doc, args[0], args[1], args[2:-1])
    elif operation == "plane_rename":
        cmd_plane_rename(data, args[2] if len(args) > 2 else "", args[0], args[1])
    elif operation == "plane_delete":
        cmd_plane_delete(data, args[1] if len(args) > 1 else "", args[0])
    else:
        for line in USAGE:
            print("USAGE " + line)


def run(_context: str) -> None:
    dispatch_plane(OP, ARGS)
