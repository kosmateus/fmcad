import adsk.core
import adsk.fusion
import json
import re

OP = "help"
ARGS = []

USAGE = [
    "projects",
    "project_create <project> [purpose]",
    "project_rename <project> <new_name>",
    "folder_list <project> [folder_path]",
    "folder_create <project> <folder_path>",
    "folder_rename <project> <folder_path> <new_name>",
    "folder_delete <project> <folder_path>",
    "file_rename <project> <folder_path> <file_name> <new_name>",
    "file_move <project> <folder_path> <file_name> <dest_folder_path>",
    "file_delete <project> <folder_path> <file_name>",
    "file_editability",
    "file_editability_list [project]",
    "tree <project> [folder_path]",
    "param_list",
    "param_add <name> <expression> [unit] [comment]",
    "param_set <name> <expression>",
    "param_rename <name> <new_name>",
    "param_delete <name>",
    "plane_list",
    "plane_add <name> offset <ref> <distance>",
    "plane_add <name> mid <ref1> <ref2>",
    "plane_add <name> angle <ref> <axis> <angle>",
    "plane_rename <name> <new_name>",
    "plane_delete <name>",
]


def _split(path):
    return [s for s in path.split("/") if s]


def _get_project(data, name):
    for p in data.dataProjects.asArray():
        if p.name == name:
            return p
    return None


def _get_folder(project, path):
    cur = project.rootFolder
    for part in _split(path):
        nxt = cur.dataFolders.itemByName(part)
        if nxt is None:
            return None
        cur = nxt
    return cur


def _find_file(folder, name):
    for f in folder.dataFiles.asArray():
        if f.name == name:
            return f
        if f.name + "." + str(f.fileExtension) == name:
            return f
    return None


def _err(msg):
    print("ERROR " + msg)


def cmd_projects(data):
    for p in data.dataProjects.asArray():
        print("PROJECT name=" + p.name + " id=" + str(p.id))
    print("DONE")


def cmd_project_create(data, name, purpose):
    if _get_project(data, name) is not None:
        print("EXISTS name=" + name)
        print("DONE")
        return
    p = data.dataProjects.add(name, purpose, "")
    if p is None:
        _err("project_create " + name)
        return
    print("CREATED_PROJECT name=" + p.name + " id=" + str(p.id))
    print("DONE")


def cmd_project_rename(data, name, new_name):
    p = _get_project(data, name)
    if p is None:
        _err("project not found: " + name)
        return
    p.name = new_name
    print("RENAMED_PROJECT id=" + str(p.id) + " new=" + p.name)
    print("DONE")


def _print_contents(folder):
    for f in folder.dataFolders.asArray():
        print("FOLDER name=" + f.name + " id=" + str(f.id))
    for f in folder.dataFiles.asArray():
        print("FILE name=" + f.name + " id=" + str(f.id) + " ext=" + str(f.fileExtension))
    print("DONE")


def cmd_folder_list(data, project_name, path):
    project = _get_project(data, project_name)
    if project is None:
        _err("project not found: " + project_name)
        return
    folder = _get_folder(project, path)
    if folder is None:
        _err("folder not found: " + path)
        return
    _print_contents(folder)


def cmd_folder_create(data, project_name, path):
    project = _get_project(data, project_name)
    if project is None:
        _err("project not found: " + project_name)
        return
    cur = project.rootFolder
    for part in _split(path):
        nxt = cur.dataFolders.itemByName(part)
        if nxt is None:
            nxt = cur.dataFolders.add(part)
            if nxt is None:
                _err("folder_create " + part)
                return
            print("CREATED_FOLDER name=" + part + " id=" + str(nxt.id) + " in=" + cur.name)
        else:
            print("EXISTS_FOLDER name=" + part + " in=" + cur.name)
        cur = nxt
    print("DONE")


def cmd_folder_rename(data, project_name, path, new_name):
    project = _get_project(data, project_name)
    if project is None:
        _err("project not found: " + project_name)
        return
    folder = _get_folder(project, path)
    if folder is None:
        _err("folder not found: " + path)
        return
    folder.name = new_name
    print("RENAMED_FOLDER id=" + str(folder.id) + " new=" + folder.name)
    print("DONE")


def cmd_folder_delete(data, project_name, path):
    project = _get_project(data, project_name)
    if project is None:
        _err("project not found: " + project_name)
        return
    if not path:
        _err("cannot delete project root")
        return
    folder = _get_folder(project, path)
    if folder is None:
        _err("folder not found: " + path)
        return
    if folder.deleteMe():
        print("DELETED_FOLDER path=" + path)
    else:
        _err("folder_delete " + path)
    print("DONE")


def cmd_file_rename(data, project_name, path, file_name, new_name):
    project = _get_project(data, project_name)
    if project is None:
        _err("project not found: " + project_name)
        return
    folder = _get_folder(project, path)
    if folder is None:
        _err("folder not found: " + path)
        return
    f = _find_file(folder, file_name)
    if f is None:
        _err("file not found: " + file_name)
        return
    f.name = new_name
    print("RENAMED_FILE id=" + str(f.id) + " new=" + f.name)
    print("DONE")


def cmd_file_move(data, project_name, path, file_name, dest_path):
    project = _get_project(data, project_name)
    if project is None:
        _err("project not found: " + project_name)
        return
    folder = _get_folder(project, path)
    if folder is None:
        _err("folder not found: " + path)
        return
    f = _find_file(folder, file_name)
    if f is None:
        _err("file not found: " + file_name)
        return
    dest = _get_folder(project, dest_path)
    if dest is None:
        _err("dest folder not found: " + dest_path)
        return
    f.move(dest)
    print("MOVED_FILE id=" + str(f.id) + " to=" + dest.name)
    print("DONE")


def cmd_file_delete(data, project_name, path, file_name):
    project = _get_project(data, project_name)
    if project is None:
        _err("project not found: " + project_name)
        return
    folder = _get_folder(project, path)
    if folder is None:
        _err("folder not found: " + path)
        return
    f = _find_file(folder, file_name)
    if f is None:
        _err("file not found: " + file_name)
        return
    file_id, actual_name = f.id, f.name
    if not f.deleteMe():
        _err("file_delete deleteMe returned false: " + file_name)
        return
    print("DELETED_FILE name=" + file_name)
    print("FILE_DELETE " + json.dumps({"id": file_id, "name": actual_name,
          "accepted": True, "permanentDeletionVerified": False,
          "editableSlotReleased": "notVerified"}))
    print("DONE")


def cmd_file_editability(data):
    result = {"mutationSupported": False, "diagnosticsComplete": True}
    try:
        limits = data.personalUseLimits
        result["personalUseLimits"] = None if limits is None else {
            "maxEditableFileCount": limits.maxEditableFileCount,
            "editableFileCount": limits.editableFileCount,
            "editableFiles": None,
        }
    except Exception as exc:
        _err("file_editability " + json.dumps({"mutationSupported": False, "error": str(exc)}))
        return
    if limits is not None:
        getter = "personalUseLimits.editableFiles"
        try:
            editable_files = limits.editableFiles
            files = []
            for index, f in enumerate(editable_files):
                file = {}
                for attribute in ("id", "name", "isReadOnly"):
                    getter = "personalUseLimits.editableFiles[{}].{}".format(index, attribute)
                    file[attribute] = getattr(f, attribute)
                files.append(file)
            result["personalUseLimits"]["editableFiles"] = files
        except Exception as exc:
            result["diagnosticsComplete"] = False
            result["errors"] = [{"getter": getter, "message": str(exc)}]
            print("FILE_EDITABILITY " + json.dumps(result))
            _err("file_editability " + getter + ": " + str(exc))
            return
    print("FILE_EDITABILITY " + json.dumps(result))
    print("DONE")


def cmd_file_editability_list(data, project=None):
    result = {"files": [], "errors": [], "complete": True}

    def error(scope, prop, message):
        result["errors"].append({"scope": scope, "property": prop, "message": str(message)})

    def read(obj, prop, scope):
        try:
            value = getattr(obj, prop)
            if value is None:
                raise ValueError("getter returned null")
            if prop == "isReadOnly" and type(value) is not bool:
                raise ValueError("expected boolean")
            return value
        except Exception as exc:
            error(scope, prop, exc)
            return None

    def items(obj, prop, scope):
        collection = read(obj, prop, scope)
        if collection is None:
            return
        count = read(collection, "count", scope + "." + prop)
        if count is None:
            return
        if type(count) is not int or count < 0:
            error(scope + "." + prop, "count", "expected nonnegative integer")
            return
        for index in range(count):
            item_scope = scope + "." + prop + "[{}]".format(index)
            try:
                item = collection.item(index)
                if item is None:
                    raise ValueError("item returned null")
            except Exception as exc:
                error(item_scope, "item", exc)
                continue
            yield item, item_scope

    def visit(folder, scope, project_id, project_name, path):
        folder_id = read(folder, "id", scope)
        for file, file_scope in items(folder, "dataFiles", scope):
            row = {prop: read(file, prop, file_scope) for prop in ("id", "name", "isReadOnly")}
            row.update(projectId=project_id, projectName=project_name,
                       folderId=folder_id, folderPath=path)
            result["files"].append(row)
        for child, child_scope in items(folder, "dataFolders", scope):
            name = read(child, "name", child_scope)
            child_path = None if path is None or name is None else path.rstrip("/") + "/" + name
            visit(child, child_scope, project_id, project_name, child_path)

    projects = []
    for item, scope in items(data, "dataProjects", "data"):
        projects.append((item, scope, read(item, "id", scope), read(item, "name", scope)))
    if project is not None:
        matches = [entry for entry in projects if project in (entry[2], entry[3])]
        if result["errors"]:
            error("data", "project", "cannot establish unique project selection after metadata errors")
            projects = []
        elif len(matches) != 1:
            error("data", "project", "project not found: " + project if not matches else "ambiguous project: " + project)
            projects = []
        else:
            projects = matches
    for item, scope, project_id, project_name in projects:
        folder = read(item, "rootFolder", scope)
        if folder is not None:
            visit(folder, scope + ".rootFolder", project_id, project_name, "/")

    result["counts"] = {
        "files": len(result["files"]),
        "readOnly": sum(row["isReadOnly"] is True for row in result["files"]),
        "notReadOnly": sum(row["isReadOnly"] is False for row in result["files"]),
        "unknown": sum(row["isReadOnly"] is None for row in result["files"]),
    }
    result["complete"] = not result["errors"]
    print("FILE_EDITABILITY_LIST " + json.dumps(result))
    if result["complete"]:
        print("DONE")
    else:
        _err("file_editability_list incomplete inventory; see errors")


def cmd_tree(data, project_name, path):
    project = _get_project(data, project_name)
    if project is None:
        _err("project not found: " + project_name)
        return
    folder = _get_folder(project, path)
    if folder is None:
        _err("folder not found: " + path)
        return

    def rec(folder, indent):
        for f in folder.dataFolders.asArray():
            print(indent + "FOLDER " + f.name + " id=" + str(f.id))
            rec(f, indent + "  ")
        for f in folder.dataFiles.asArray():
            print(indent + "FILE " + f.name + " id=" + str(f.id))

    rec(folder, "")
    print("DONE")


KNOWN_UNITS = ["mm", "cm", "m", "in", "ft", "yd", "deg", "rad"]


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


def _find_param(design, name):
    for p in design.userParameters:
        if p.name == name:
            return p
    return None


def _resolve_unit(design, expression):
    tokens = [t for t in re.split(r"[^A-Za-z0-9_]+", expression) if t]
    for t in tokens:
        p = _find_param(design, t)
        if p is not None:
            return str(p.unit)
    for t in reversed(tokens):
        if t in KNOWN_UNITS:
            return t
    return ""


def cmd_param_list(data, doc_name):
    design = _design(doc_name)
    if design is None:
        return
    for p in design.userParameters:
        print("PARAM name=" + p.name + " expr=" + str(p.expression) + " unit=" + str(p.unit) + " comment=" + str(p.comment))
    print("DONE")


def cmd_param_add(data, name, expression, unit, comment, doc_name):
    design = _design(doc_name)
    if design is None:
        return
    if _find_param(design, name) is not None:
        print("EXISTS name=" + name)
        print("DONE")
        return
    if not unit:
        unit = _resolve_unit(design, expression)
    p = design.userParameters.add(name, adsk.core.ValueInput.createByString(expression), unit, comment)
    if p is None:
        _err("param_add " + name)
        return
    print("CREATED_PARAM name=" + p.name + " expr=" + str(p.expression) + " unit=" + str(p.unit))
    print("DONE")


def cmd_param_set(data, name, expression, doc_name):
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


def cmd_param_rename(data, name, new_name, doc_name):
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


def cmd_param_delete(data, name, doc_name):
    design = _design(doc_name)
    if design is None:
        return
    p = _find_param(design, name)
    if p is None:
        _err("parameter not found: " + name)
        return
    if p.deleteMe():
        print("DELETED_PARAM name=" + name)
    else:
        _err("param_delete " + name)
    print("DONE")


def _root(doc_name):
    design = _design(doc_name)
    if design is None:
        return None
    return design.rootComponent


def _find_plane(root, name):
    for p in root.constructionPlanes:
        if p.name == name:
            return p
    return None


def _resolve_plane_ref(root, ref):
    low = ref.lower()
    if low == "xy":
        return root.xYConstructionPlane
    if low == "xz":
        return root.xZConstructionPlane
    if low == "yz":
        return root.yZConstructionPlane
    return _find_plane(root, ref)


def _resolve_axis(root, axis):
    low = axis.lower()
    if low == "x":
        return root.xConstructionAxis
    if low == "y":
        return root.yConstructionAxis
    if low == "z":
        return root.zConstructionAxis
    return None


def cmd_plane_list(data, doc_name):
    root = _root(doc_name)
    if root is None:
        return
    for p in root.constructionPlanes:
        print("PLANE name=" + p.name)
    print("DONE")


def cmd_plane_add(data, doc_name, name, mode, mode_args):
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
    p = root.constructionPlanes.add(inp)
    if p is None:
        _err("plane_add " + name)
        return
    p.name = name
    print("CREATED_PLANE name=" + p.name)
    print("DONE")


def cmd_plane_rename(data, doc_name, name, new_name):
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


def cmd_plane_delete(data, doc_name, name):
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


def run(_context: str):
    app = adsk.core.Application.get()
    data = app.data

    if OP == "projects":
        cmd_projects(data)
    elif OP == "project_create":
        cmd_project_create(data, ARGS[0], ARGS[1] if len(ARGS) > 1 else "")
    elif OP == "project_rename":
        cmd_project_rename(data, ARGS[0], ARGS[1])
    elif OP == "folder_list":
        cmd_folder_list(data, ARGS[0], ARGS[1] if len(ARGS) > 1 else "")
    elif OP == "folder_create":
        cmd_folder_create(data, ARGS[0], ARGS[1])
    elif OP == "folder_rename":
        cmd_folder_rename(data, ARGS[0], ARGS[1], ARGS[2])
    elif OP == "folder_delete":
        cmd_folder_delete(data, ARGS[0], ARGS[1])
    elif OP == "file_rename":
        cmd_file_rename(data, ARGS[0], ARGS[1], ARGS[2], ARGS[3])
    elif OP == "file_move":
        cmd_file_move(data, ARGS[0], ARGS[1], ARGS[2], ARGS[3])
    elif OP == "file_delete":
        cmd_file_delete(data, ARGS[0], ARGS[1], ARGS[2])
    elif OP == "file_editability":
        if ARGS:
            _err("file_editability takes no positional arguments")
            return
        cmd_file_editability(data)
    elif OP == "file_editability_list":
        if len(ARGS) > 1:
            _err("file_editability_list takes at most one project argument")
            return
        cmd_file_editability_list(data, ARGS[0] if ARGS else None)
    elif OP == "tree":
        cmd_tree(data, ARGS[0], ARGS[1] if len(ARGS) > 1 else "")
    elif OP == "param_list":
        cmd_param_list(data, ARGS[0] if len(ARGS) > 0 else "")
    elif OP == "param_add":
        cmd_param_add(data, ARGS[0], ARGS[1], ARGS[2] if len(ARGS) > 2 else "", ARGS[3] if len(ARGS) > 3 else "", ARGS[4] if len(ARGS) > 4 else "")
    elif OP == "param_set":
        cmd_param_set(data, ARGS[0], ARGS[1], ARGS[2] if len(ARGS) > 2 else "")
    elif OP == "param_rename":
        cmd_param_rename(data, ARGS[0], ARGS[1], ARGS[2] if len(ARGS) > 2 else "")
    elif OP == "param_delete":
        cmd_param_delete(data, ARGS[0], ARGS[1] if len(ARGS) > 1 else "")
    elif OP == "plane_list":
        cmd_plane_list(data, ARGS[0] if len(ARGS) > 0 else "")
    elif OP == "plane_add":
        doc = ARGS[len(ARGS) - 1]
        mode_args = ARGS[2:-1]
        cmd_plane_add(data, doc, ARGS[0], ARGS[1], mode_args)
    elif OP == "plane_rename":
        cmd_plane_rename(data, ARGS[2] if len(ARGS) > 2 else "", ARGS[0], ARGS[1])
    elif OP == "plane_delete":
        cmd_plane_delete(data, ARGS[1] if len(ARGS) > 1 else "", ARGS[0])
    else:
        for line in USAGE:
            print("USAGE " + line)
