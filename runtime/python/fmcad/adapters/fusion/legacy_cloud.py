import adsk.core
import json
from collections.abc import Iterator
from typing import Protocol, cast

class _CloudCollection(Protocol):
    def item(self, index: int) -> object: ...

OP = "help"
ARGS: list[str] = []

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
]


def _split(path: str) -> list[str]:
    return [s for s in path.split("/") if s]


def _get_project(data: "adsk.core.Data", name: str) -> "adsk.core.DataProject | None":
    for p in data.dataProjects.asArray():
        if p.name == name:
            return p
    return None


def _get_folder(project: "adsk.core.DataProject", path: str) -> "adsk.core.DataFolder | None":
    cur = project.rootFolder
    for part in _split(path):
        nxt = cast("adsk.core.DataFolder | None", cur.dataFolders.itemByName(part))
        if nxt is None:
            return None
        cur = nxt
    return cur


def _find_file(folder: "adsk.core.DataFolder", name: str) -> "adsk.core.DataFile | None":
    for f in folder.dataFiles.asArray():
        if f.name == name:
            return f
        if f.name + "." + str(f.fileExtension) == name:
            return f
    return None


def _err(msg: str) -> None:
    print("ERROR " + msg)


def cmd_projects(data: "adsk.core.Data") -> None:
    for p in data.dataProjects.asArray():
        print("PROJECT name=" + p.name + " id=" + str(p.id))
    print("DONE")


def cmd_project_create(data: "adsk.core.Data", name: str, purpose: str) -> None:
    if _get_project(data, name) is not None:
        print("EXISTS name=" + name)
        print("DONE")
        return
    p = cast("adsk.core.DataProject | None", data.dataProjects.add(name, purpose, ""))
    if p is None:
        _err("project_create " + name)
        return
    print("CREATED_PROJECT name=" + p.name + " id=" + str(p.id))
    print("DONE")


def cmd_project_rename(data: "adsk.core.Data", name: str, new_name: str) -> None:
    p = _get_project(data, name)
    if p is None:
        _err("project not found: " + name)
        return
    p.name = new_name
    print("RENAMED_PROJECT id=" + str(p.id) + " new=" + p.name)
    print("DONE")


def _print_contents(folder: "adsk.core.DataFolder") -> None:
    for f in folder.dataFolders.asArray():
        print("FOLDER name=" + f.name + " id=" + str(f.id))
    for f in folder.dataFiles.asArray():
        print("FILE name=" + f.name + " id=" + str(f.id) + " ext=" + str(f.fileExtension))
    print("DONE")


def cmd_folder_list(data: "adsk.core.Data", project_name: str, path: str) -> None:
    project = _get_project(data, project_name)
    if project is None:
        _err("project not found: " + project_name)
        return
    folder = _get_folder(project, path)
    if folder is None:
        _err("folder not found: " + path)
        return
    _print_contents(folder)


def cmd_folder_create(data: "adsk.core.Data", project_name: str, path: str) -> None:
    project = _get_project(data, project_name)
    if project is None:
        _err("project not found: " + project_name)
        return
    cur = project.rootFolder
    for part in _split(path):
        nxt = cast("adsk.core.DataFolder | None", cur.dataFolders.itemByName(part))
        if nxt is None:
            nxt = cast("adsk.core.DataFolder | None", cur.dataFolders.add(part))
            if nxt is None:
                _err("folder_create " + part)
                return
            print("CREATED_FOLDER name=" + part + " id=" + str(nxt.id) + " in=" + cur.name)
        else:
            print("EXISTS_FOLDER name=" + part + " in=" + cur.name)
        cur = nxt
    print("DONE")


def cmd_folder_rename(data: "adsk.core.Data", project_name: str, path: str, new_name: str) -> None:
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


def cmd_folder_delete(data: "adsk.core.Data", project_name: str, path: str) -> None:
    project = _get_project(data, project_name)
    if project is None:
        _err("project not found: " + project_name)
        return
    if not _split(path):
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


def cmd_file_rename(data: "adsk.core.Data", project_name: str, path: str, file_name: str, new_name: str) -> None:
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


def cmd_file_move(data: "adsk.core.Data", project_name: str, path: str, file_name: str, dest_path: str) -> None:
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
    if not f.move(dest):
        _err("file_move returned false: " + file_name)
        return
    print("MOVED_FILE id=" + str(f.id) + " to=" + dest.name)
    print("DONE")


def cmd_file_delete(data: "adsk.core.Data", project_name: str, path: str, file_name: str) -> None:
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


def cmd_file_editability(data: "adsk.core.Data") -> None:
    result: dict[str, object] = {"mutationSupported": False, "diagnosticsComplete": True}
    try:
        limits = cast("adsk.core.PersonalUseLimits | None", data.personalUseLimits)
        quota: dict[str, object] | None = None if limits is None else {
            "maxEditableFileCount": limits.maxEditableFileCount,
            "editableFileCount": limits.editableFileCount,
            "editableFiles": None,
        }
        result["personalUseLimits"] = quota
    except Exception as exc:
        _err("file_editability " + json.dumps({"mutationSupported": False, "error": str(exc)}))
        return
    if limits is not None:
        getter = "personalUseLimits.editableFiles"
        try:
            editable_files = limits.editableFiles
            files: list[dict[str, object]] = []
            for index, f in enumerate(editable_files):
                file: dict[str, object] = {}
                for attribute in ("id", "name", "isReadOnly"):
                    getter = "personalUseLimits.editableFiles[{}].{}".format(index, attribute)
                    file[attribute] = cast(object, getattr(f, attribute))
                files.append(file)
            assert quota is not None
            quota["editableFiles"] = files
        except Exception as exc:
            result["diagnosticsComplete"] = False
            result["errors"] = [{"getter": getter, "message": str(exc)}]
            print("FILE_EDITABILITY " + json.dumps(result))
            _err("file_editability " + getter + ": " + str(exc))
            return
    print("FILE_EDITABILITY " + json.dumps(result))
    print("DONE")


def cmd_file_editability_list(data: "adsk.core.Data", project: str | None = None) -> None:
    files: list[dict[str, object]] = []
    errors: list[dict[str, str]] = []
    result: dict[str, object] = {"files": files, "errors": errors, "complete": True}

    def error(scope: str, prop: str, message: object) -> None:
        errors.append({"scope": scope, "property": prop, "message": str(message)})

    def read(obj: object, prop: str, scope: str) -> object:
        try:
            value = cast(object, getattr(obj, prop))
            if value is None:
                raise ValueError("getter returned null")
            if prop == "isReadOnly" and type(value) is not bool:
                raise ValueError("expected boolean")
            return value
        except Exception as exc:
            error(scope, prop, exc)
            return None

    def items(obj: object, prop: str, scope: str) -> Iterator[tuple[object, str]]:
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
                item = cast(_CloudCollection, collection).item(index)
                if item is None:
                    raise ValueError("item returned null")
            except Exception as exc:
                error(item_scope, "item", exc)
                continue
            yield item, item_scope

    def visit(folder: object, scope: str, project_id: object, project_name: object, path: str | None) -> None:
        folder_id = read(folder, "id", scope)
        for file, file_scope in items(folder, "dataFiles", scope):
            row = {prop: read(file, prop, file_scope) for prop in ("id", "name", "isReadOnly")}
            row.update(projectId=project_id, projectName=project_name,
                       folderId=folder_id, folderPath=path)
            files.append(row)
        for child, child_scope in items(folder, "dataFolders", scope):
            name = cast(str | None, read(child, "name", child_scope))
            child_path = None if path is None or name is None else path.rstrip("/") + "/" + name
            visit(child, child_scope, project_id, project_name, child_path)

    projects: list[tuple[object, str, object, object]] = []
    for item, scope in items(data, "dataProjects", "data"):
        projects.append((item, scope, read(item, "id", scope), read(item, "name", scope)))
    if project is not None:
        matches = [entry for entry in projects if project in (entry[2], entry[3])]
        if errors:
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
        "files": len(files),
        "readOnly": sum(row["isReadOnly"] is True for row in files),
        "notReadOnly": sum(row["isReadOnly"] is False for row in files),
        "unknown": sum(row["isReadOnly"] is None for row in files),
    }
    result["complete"] = not errors
    print("FILE_EDITABILITY_LIST " + json.dumps(result))
    if result["complete"]:
        print("DONE")
    else:
        _err("file_editability_list incomplete inventory; see errors")


def cmd_tree(data: "adsk.core.Data", project_name: str, path: str) -> None:
    project = _get_project(data, project_name)
    if project is None:
        _err("project not found: " + project_name)
        return
    folder = _get_folder(project, path)
    if folder is None:
        _err("folder not found: " + path)
        return

    def rec(folder: "adsk.core.DataFolder", indent: str) -> None:
        for f in folder.dataFolders.asArray():
            print(indent + "FOLDER " + f.name + " id=" + str(f.id))
            rec(f, indent + "  ")
        for f in folder.dataFiles.asArray():
            print(indent + "FILE " + f.name + " id=" + str(f.id))

    rec(folder, "")
    print("DONE")


def dispatch_cloud(operation: str, args: list[str]) -> None:
    app = adsk.core.Application.get()
    data = app.data

    if operation == "projects":
        cmd_projects(data)
    elif operation == "project_create":
        cmd_project_create(data, args[0], args[1] if len(args) > 1 else "")
    elif operation == "project_rename":
        cmd_project_rename(data, args[0], args[1])
    elif operation == "folder_list":
        cmd_folder_list(data, args[0], args[1] if len(args) > 1 else "")
    elif operation == "folder_create":
        cmd_folder_create(data, args[0], args[1])
    elif operation == "folder_rename":
        cmd_folder_rename(data, args[0], args[1], args[2])
    elif operation == "folder_delete":
        cmd_folder_delete(data, args[0], args[1])
    elif operation == "file_rename":
        cmd_file_rename(data, args[0], args[1], args[2], args[3])
    elif operation == "file_move":
        cmd_file_move(data, args[0], args[1], args[2], args[3])
    elif operation == "file_delete":
        cmd_file_delete(data, args[0], args[1], args[2])
    elif operation == "file_editability":
        if args:
            _err("file_editability takes no positional arguments")
            return
        cmd_file_editability(data)
    elif operation == "file_editability_list":
        if len(args) > 1:
            _err("file_editability_list takes at most one project argument")
            return
        cmd_file_editability_list(data, args[0] if args else None)
    elif operation == "tree":
        cmd_tree(data, args[0], args[1] if len(args) > 1 else "")
    else:
        for line in USAGE:
            print("USAGE " + line)


def run(_context: str) -> None:
    dispatch_cloud(OP, ARGS)
