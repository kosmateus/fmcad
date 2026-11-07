"""Legacy parameter commands. The broker owns transport; Fusion owns validation."""
import re

OP = "help"
ARGS: list[str] = []
KNOWN_UNITS = ["mm", "cm", "m", "in", "ft", "yd", "deg", "rad"]
USAGE = ["param_list", "param_add <name> <expression> [unit] [comment]",
         "param_set <name> <expression>", "param_rename <name> <new_name>", "param_delete <name>"]


def _find_param(design: "adsk.fusion.Design", name: str) -> "adsk.fusion.UserParameter | None":
    for p in design.userParameters:
        if p.name == name:
            return p
    return None


def _resolve_unit(design: "adsk.fusion.Design", expression: str) -> str:
    tokens = [t for t in re.split(r"[^A-Za-z0-9_]+", expression) if t]
    for t in tokens:
        p = _find_param(design, t)
        if p is not None:
            return str(p.unit)
    for t in reversed(tokens):
        if t in KNOWN_UNITS:
            return t
    return ""


def cmd_param_list(data: object, doc_name: str) -> None:
    design = _design(doc_name)
    if design is None:
        return
    for p in design.userParameters:
        print("PARAM name=" + p.name + " expr=" + str(p.expression) + " unit=" + str(p.unit) + " comment=" + str(p.comment))
    print("DONE")


def cmd_param_add(data: object, name: str, expression: str, unit: str, comment: str, doc_name: str) -> None:
    design = _design(doc_name)
    if design is None:
        return
    if _find_param(design, name) is not None:
        print("EXISTS name=" + name)
        print("DONE")
        return
    if not unit:
        unit = _resolve_unit(design, expression)
    p = cast("adsk.fusion.UserParameter | None", design.userParameters.add(name, adsk.core.ValueInput.createByString(expression), unit, comment))
    if p is None:
        _err("param_add " + name)
        return
    print("CREATED_PARAM name=" + p.name + " expr=" + str(p.expression) + " unit=" + str(p.unit))
    print("DONE")


def cmd_param_set(data: object, name: str, expression: str, doc_name: str) -> None:
    design = _design(doc_name)
    if design is None:
        return
    p = _find_param(design, name)
    if p is None:
        _err("parameter not found: " + name)
        return
    p.expression = expression
    print("UPDATED_PARAM name=" + p.name + " expr=" + str(p.expression) + " unit=" + str(p.unit))
    print("DONE")


def cmd_param_rename(data: object, name: str, new_name: str, doc_name: str) -> None:
    design = _design(doc_name)
    if design is None:
        return
    p = _find_param(design, name)
    if p is None:
        _err("parameter not found: " + name)
        return
    p.name = new_name
    print("RENAMED_PARAM new=" + p.name)
    print("DONE")


def cmd_param_delete(data: object, name: str, doc_name: str) -> None:
    design = _design(doc_name)
    if design is None:
        return
    p = _find_param(design, name)
    if p is None:
        _err("parameter not found: " + name)
        return
    if p.deleteMe() and _find_param(design, name) is None:
        print("DELETED_PARAM name=" + name)
    else:
        _err("param_delete " + name)
    print("DONE")


def dispatch_parameter(operation: str, args: list[str]) -> None:
    data = adsk.core.Application.get().data
    if operation == "param_list":
        cmd_param_list(data, args[0] if len(args) > 0 else "")
    elif operation == "param_add":
        cmd_param_add(data, args[0], args[1], args[2] if len(args) > 2 else "", args[3] if len(args) > 3 else "", args[4] if len(args) > 4 else "")
    elif operation == "param_set":
        cmd_param_set(data, args[0], args[1], args[2] if len(args) > 2 else "")
    elif operation == "param_rename":
        cmd_param_rename(data, args[0], args[1], args[2] if len(args) > 2 else "")
    elif operation == "param_delete":
        cmd_param_delete(data, args[0], args[1] if len(args) > 1 else "")
    else:
        for line in USAGE:
            print("USAGE " + line)


def run(_context: str) -> None:
    dispatch_parameter(OP, ARGS)
