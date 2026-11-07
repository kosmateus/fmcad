"""Read-only cloud cache diagnostic for an exact owned project/file identity."""
ARGS = []
DOC_NAME = ''


def run(_context):
    import adsk.core

    if not isinstance(ARGS, dict) or set(ARGS) != {'projectId', 'fileId'}:
        raise ValueError('Expected exact {projectId,fileId}')
    app = adsk.core.Application.get()
    projects = [project for project in app.data.dataProjects if project.id == ARGS['projectId']]
    if len(projects) != 1:
        raise ValueError('Expected exactly one pinned project')
    rows = []

    def walk(folder):
        for file in folder.dataFiles:
            if file.id == ARGS['fileId']:
                parent = getattr(file, 'parentFolder', None)
                latest = file.latestVersion
                rows.append({'fileId': file.id, 'name': str(file.name),
                    'version': int(file.versionNumber), 'latestVersion': int(file.latestVersionNumber),
                    'isComplete': bool(file.isComplete), 'isReadOnly': bool(file.isReadOnly),
                    'latestIdentity': {'fileId': latest.id, 'version': int(latest.versionNumber),
                        'isComplete': bool(latest.isComplete), 'isReadOnly': bool(latest.isReadOnly)},
                    'folderId': getattr(parent, 'id', None), 'projectId': file.parentProject.id})
        for child in folder.dataFolders:
            walk(child)

    walk(projects[0].rootFolder)
    return {'matches': rows}
