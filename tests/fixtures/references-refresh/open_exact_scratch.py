"""Open one specifically assigned task scratch DataFile by pinned project/file/version."""
ARGS = []
DOC_NAME = ''


def run(_context):
    import adsk.core

    required = {'projectId', 'fileId', 'version', 'folderId'}
    if not isinstance(ARGS, dict) or set(ARGS) != required:
        raise ValueError('Expected exact projectId, fileId, version and folderId')
    app = adsk.core.Application.get()
    projects = [project for project in app.data.dataProjects if project.id == ARGS['projectId']]
    if len(projects) != 1:
        raise ValueError('Pinned project ID must match exactly one project')
    files = []

    def walk(folder):
        for file in folder.dataFiles:
            if file.id == ARGS['fileId']:
                files.append(file)
        for child in folder.dataFolders:
            walk(child)

    walk(projects[0].rootFolder)
    if len(files) != 1:
        raise ValueError('Pinned file ID must match exactly one DataFile')
    file = files[0]
    if file.parentProject.id != ARGS['projectId'] or file.parentFolder.id != ARGS['folderId'] or \
            file.versionNumber != ARGS['version'] or file.isReadOnly is not False:
        raise ValueError('Pinned task scratch identity/version/folder is not exact and writable')
    matches = []
    for doc in app.documents:
        if getattr(getattr(doc, 'dataFile', None), 'id', None) != ARGS['fileId']:
            continue
        try:
            doc.allDocumentReferences.count
        except RuntimeError as error:
            if 'non-top-level document' in str(error):
                continue
            raise
        matches.append(doc)
    if len(matches) > 1:
        raise ValueError('Multiple top-level editors for pinned scratch file; no open was attempted')
    doc = matches[0] if matches else app.documents.open(file, True)
    identity = doc.dataFile
    if identity.id != ARGS['fileId'] or identity.versionNumber != ARGS['version'] or \
            identity.parentProject.id != ARGS['projectId'] or identity.parentFolder.id != ARGS['folderId']:
        raise ValueError('Opened document differs from the exact task scratch pin')
    return {'name': str(doc.name), 'creationId': str(doc.creationId), 'fileId': identity.id,
            'version': int(identity.versionNumber), 'isComplete': bool(identity.isComplete),
            'isReadOnly': bool(identity.isReadOnly), 'modified': bool(doc.isModified),
            'saved': bool(doc.isSaved), 'folderId': identity.parentFolder.id,
            'projectId': identity.parentProject.id}
