import adsk.core
import time

OP = "help"
ARGS = []

USAGE = [
    "upload <local_win_path> <project|''> <folder_path|''>",
]


def _err(msg):
    print("ERROR " + msg)


def _get_project(data, name):
    for p in data.dataProjects.asArray():
        if p.name == name:
            return p
    return None


def _get_folder(project, path):
    cur = project.rootFolder
    for part in [s for s in path.split("/") if s]:
        nxt = cur.dataFolders.itemByName(part)
        if nxt is None:
            return None
        cur = nxt
    return cur


def cmd_upload(data, local_path, project_name, folder_path):
    app = adsk.core.Application.get()
    if not project_name:
        project = app.data.activeProject
    else:
        project = _get_project(data, project_name)
    if project is None:
        _err("project not found: " + project_name)
        return
    folder = _get_folder(project, folder_path)
    if folder is None:
        _err("folder not found: " + folder_path)
        return
    fut = folder.uploadFile(local_path)
    if fut is None:
        _err("upload failed to start: " + local_path)
        return
    deadline = time.time() + 30
    while time.time() < deadline:
        state = fut.uploadState
        if state == adsk.core.UploadStates.UploadFinished:
            f = fut.dataFile
            if f is not None:
                print("UPLOAD_FINISHED name=" + f.name + " id=" + str(f.id))
                print("DONE")
                return
        if state == adsk.core.UploadStates.UploadFailed:
            _err("upload failed: " + local_path)
            return
        adsk.doEvents()
        time.sleep(0.2)
    print("UPLOAD_PENDING name=" + local_path + " (check with: fmcad folder_list \"" + project.name + "\" \"" + folder_path + "\")")
    print("DONE")


def run(_context: str):
    app = adsk.core.Application.get()
    data = app.data
    if OP == "upload":
        cmd_upload(data, ARGS[0], ARGS[1] if len(ARGS) > 1 else "", ARGS[2] if len(ARGS) > 2 else "")
    else:
        for line in USAGE:
            print("USAGE " + line)
