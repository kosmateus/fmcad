"""Exact new-file publication reads and retained-file UI close; never save/delete."""


class _SavedNamed(_AaProtocol):
    @property
    def id(self) -> str: ...


class _SavedFolder(_SavedNamed, _AaProtocol):
    @property
    def parentProject(self) -> _SavedNamed | None: ...


class _SavedFile(_AaFile, _AaProtocol):
    @property
    def name(self) -> str: ...
    @property
    def parentFolder(self) -> _SavedFolder | None: ...
    @property
    def isComplete(self) -> bool: ...


class _SavedDocument(_EpDocument, _AaProtocol):
    @property
    def dataFile(self) -> _SavedFile | None: ...


class _SavedDocuments(_EpDocuments, _AaProtocol):
    def item(self, index: int) -> _SavedDocument: ...


class _SavedHub(_SavedNamed, _AaProtocol):
    @property
    def name(self) -> str: ...


class _SavedProbeFolders(_AaCount, _AaProtocol):
    def item(self, index: int) -> '_SavedProbeFolder | None': ...


class _SavedProbeFolder(_SavedFolder, _AaProtocol):
    @property
    def name(self) -> str: ...
    @property
    def dataFolders(self) -> _SavedProbeFolders: ...


class _SavedProject(_SavedNamed, _AaProtocol):
    @property
    def name(self) -> str: ...
    @property
    def rootFolder(self) -> _SavedProbeFolder | None: ...
    @property
    def parentHub(self) -> _SavedHub | None: ...


class _SavedProjects(_AaCount, _AaProtocol):
    def item(self, index: int) -> _SavedProject | None: ...


class _SavedData(_AaProtocol):
    @property
    def dataProjects(self) -> _SavedProjects: ...


class SavedFixtureApplication(EpochApplication, _AaProtocol):
    @property
    def documents(self) -> _SavedDocuments: ...
    @property
    def activeDocument(self) -> _SavedDocument | None: ...
    @property
    def data(self) -> _SavedData: ...


def _saved_origin(app: SavedFixtureApplication, args: AaObject) -> tuple[_SavedDocument, AaObject, str, str]:
    identity, proof, binding_hash = (args.get(key) for key in ('document', 'proofPath', 'bindingHash'))
    epoch = args.get('epochId')
    if (not isinstance(identity, dict) or set(identity) != {'name', 'creationId', 'fileId'}
            or identity.get('fileId') is not None or not isinstance(identity.get('creationId'), str)
            or not identity.get('creationId') or not isinstance(epoch, str)
            or not _ep_re.fullmatch(r'[a-f0-9-]{36}', epoch)
            or identity.get('name') != 'FMCAD_ISOLATED_' + epoch
            or not isinstance(proof, str) or not isinstance(binding_hash, str)
            or not _ep_re.fullmatch(r'[a-f0-9]{64}', binding_hash)):
        raise ValueError('Exact broker-qualified new-document origin required')
    if app.userInterface.activeCommand not in ('', 'SelectCommand') or not 1 <= app.documents.count <= 256:
        raise ValueError('Bounded idle document inventory required')
    matches = [app.documents.item(index) for index in range(app.documents.count)
               if app.documents.item(index).creationId == identity['creationId']]
    if len(matches) != 1 or not matches[0].isValid or matches[0].name != identity['name']:
        raise ValueError('Original new document absent, renamed or ambiguous')
    if matches[0].allDocumentReferences.count != 0:
        raise ValueError('Saved fixture acquired external references')
    return matches[0], identity, proof, binding_hash


def _saved_snapshot(doc: _SavedDocument) -> AaObject:
    # An unsaved temporary DataFile getter may throw; do not call it in that state.
    saved = doc.isSaved
    file_error: AaObject | None = None
    try:
        file = doc.dataFile if saved else None
    except RuntimeError as error:
        if 'Failed to get temporary file' not in str(error):
            raise
        file = None
        file_error = {'type': type(error).__name__, 'message': str(error)}
    folder = file.parentFolder if file else None
    project = folder.parentProject if folder else None
    result: AaObject = {'name': doc.name, 'creationId': doc.creationId, 'saved': saved, 'modified': doc.isModified,
        'fileId': file.id if file else None, 'fileName': file.name if file else None,
        'version': file.versionNumber if file else None, 'isComplete': file.isComplete if file else None,
        'folderId': folder.id if folder else None, 'projectId': project.id if project else None}
    if file_error is not None:
        result['dataFileError'] = file_error
    return result


def probe_saved_destination(app: SavedFixtureApplication, args: AaObject) -> AaObject:
    doc, identity, proof, binding_hash = _saved_origin(app, args)
    destination = args.get('destination')
    if (not isinstance(destination, dict) or not isinstance(destination.get('projectName'), str)
            or not destination.get('projectName') or not isinstance(destination.get('folderName'), str)
            or not destination.get('folderName') or '/' in str(destination['folderName'])
            or not isinstance(destination.get('folderId'), str) or not destination.get('folderId')
            or doc.isSaved or doc.isModified):
        raise ValueError('Approved destination and unchanged unsaved origin required')
    projects = app.data.dataProjects
    if not 0 <= projects.count <= 1024:
        raise ValueError('Bounded active-hub project inventory required')
    matches: list[_SavedProject] = []
    for index in range(projects.count):
        candidate = projects.item(index)
        if candidate is None:
            raise ValueError('Project inventory incomplete')
        if candidate.name == destination['projectName']:
            matches.append(candidate)
    if len(matches) != 1:
        raise ValueError('Exactly one approved project in the current hub required; no hub switching')
    project = matches[0]
    root, hub = project.rootFolder, project.parentHub
    if root is None or hub is None or not project.id or not hub.id or not hub.name or not 0 <= root.dataFolders.count <= 4096:
        raise ValueError('Native destination project/hub/root metadata unavailable')
    folders: list[_SavedProbeFolder] = []
    for index in range(root.dataFolders.count):
        folder = root.dataFolders.item(index)
        if folder is None:
            raise ValueError('Folder inventory incomplete')
        if folder.name == destination['folderName']:
            folders.append(folder)
    if len(folders) != 1 or folders[0].id != destination['folderId']:
        raise ValueError('Exact independently approved new folder ID required')
    parent = folders[0].parentProject
    if parent is None or parent.id != project.id:
        raise ValueError('Native project/folder ownership is inconsistent')
    result: AaObject = {'version': 1, 'purpose': 'saved-fixture-destination-v1', 'epochId': args['epochId'],
        'bindingHash': binding_hash, 'document': identity, 'readOnly': True,
        'destination': {'projectName': project.name, 'nativeProjectId': project.id, 'nativeHubId': hub.id,
            'nativeHubName': hub.name, 'folderName': folders[0].name, 'folderId': folders[0].id}}
    _ep_write(proof, result)
    return result


def observe_saved_fixture(app: SavedFixtureApplication, args: AaObject) -> AaObject:
    doc, identity, proof, binding_hash = _saved_origin(app, args)
    destination = args.get('destination')
    if (not isinstance(destination, dict) or not isinstance(destination.get('projectId'), str)
            or not destination.get('projectId') or not isinstance(destination.get('folderId'), str)
            or not destination.get('folderId')):
        raise ValueError('Exact previously observed native destination required')
    observed = _saved_snapshot(doc)
    if observed['fileId'] is not None:
        if (observed['projectId'] is not None and observed['projectId'] != destination['projectId']
                or observed['folderId'] is not None and observed['folderId'] != destination['folderId']
                or observed['fileName'] is not None and observed['fileName'] != identity['name']
                or args.get('expectedFileId') is not None and observed['fileId'] != args['expectedFileId']):
            raise ValueError('First-save file lineage changed; never adopt another file')
    result: AaObject = {'version': 1, 'purpose': 'saved-first-save-publication-v1', 'epochId': args['epochId'],
        'bindingHash': binding_hash, 'document': identity, 'observed': observed, 'readOnly': True}
    _ep_write(proof, result)
    return result


def retain_saved_fixture(app: SavedFixtureApplication, args: AaObject) -> AaObject:
    doc, identity, proof, binding_hash = _saved_origin(app, args)
    expected = args.get('savedDocument')
    observed = _saved_snapshot(doc)
    keys = ('name', 'creationId', 'fileId', 'projectId', 'folderId', 'version')
    if (not isinstance(expected, dict) or set(expected) != set(keys)
            or any(expected.get(key) != observed.get(key) for key in keys)
            or not isinstance(expected.get('fileId'), str) or not expected.get('fileId')
            or type(expected.get('version')) is not int
            or observed['saved'] is not True or observed['modified'] is not False or observed['isComplete'] is not True):
        raise ValueError('Only the exact published unmodified new file may be retained and closed')
    file = doc.dataFile
    if file is None:
        raise ValueError('Published file handle unavailable')
    docs = app.documents
    count = docs.count
    before = {docs.item(index).creationId for index in range(count)}
    if len(before) != count:
        raise ValueError('Distinct protected document identities required')
    restore = args.get('restoreActiveCreationId')
    if restore is not None and (not isinstance(restore, str) or not restore or restore == identity['creationId']):
        raise ValueError('Exact captured restore identity required')
    active = app.activeDocument
    active_before = active.creationId if active is not None else None
    target = restore if active_before == identity['creationId'] else active_before
    # Resolve the restore target before the only close, not after losing the fixture.
    targets = [docs.item(index) for index in range(count) if docs.item(index).creationId == target]
    if target is not None and (len(targets) != 1 or not targets[0].isValid):
        raise ValueError('Captured restore document is unavailable')
    _ep_write(proof + '.started', {'epochId': args['epochId'], 'bindingHash': binding_hash, 'savedDocument': expected})
    if doc.close(False) is not True:
        raise RuntimeError('Saved fixture close outcome uncertain; never replay')
    after = {docs.item(index).creationId for index in range(docs.count)}
    if docs.count != count - 1 or after != before - {str(identity['creationId'])}:
        raise RuntimeError('Exact saved fixture-only UI close not established')
    if target is not None:
        active_after = app.activeDocument
        if active_after is None or not active_after.isValid or active_after.creationId != target:
            if targets[0].activate() is not True:
                raise RuntimeError('Captured active document restore failed')
    final = app.activeDocument
    restored = final.creationId if final is not None else None
    if restored != target:
        raise RuntimeError('Active document restoration was not observed')
    folder = file.parentFolder
    project = folder.parentProject if folder else None
    if (folder is None or project is None or file.id != expected['fileId'] or project.id != expected['projectId']
            or folder.id != expected['folderId'] or file.versionNumber != expected['version']
            or file.isComplete is not True):
        raise RuntimeError('Retained DataFile lineage/publication changed after UI close')
    result: AaObject = {'version': 1, 'purpose': 'saved-fixture-retain-v1', 'epochId': args['epochId'],
        'bindingHash': binding_hash, 'document': identity, 'savedDocument': expected,
        'closed': True, 'saved': True, 'retained': True, 'activeBeforeCloseCreationId': active_before,
        'restoredActiveCreationId': restored, 'activeDocumentRestored': True}
    _ep_write(proof, result)
    return result
