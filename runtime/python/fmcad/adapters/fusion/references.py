"""Private SDK operations used by the Node-owned references.refresh journal."""
import sys as _references_sys
import time as _references_time
sys = _references_sys
time = _references_time


globals().setdefault('_CAD_TYPE_CHECKING', False)


def _references_runtime_cast(_type: object, value: object) -> object:
    return value


if not _CAD_TYPE_CHECKING and '_cad_cast' not in globals():
    globals()['_cad_cast'] = _references_runtime_cast


if _CAD_TYPE_CHECKING:
    class _ReferencesDataProject(_Protocol):
        @property
        def id(self) -> str: ...

        @property
        def rootFolder(self) -> "_ReferencesDataFolder": ...

    class _ReferencesDataFolder(_Protocol):
        @property
        def id(self) -> str: ...

        @property
        def dataFiles(self) -> "_CadItemCollection[_ReferencesDataFile]": ...

        @property
        def dataFolders(self) -> "_CadItemCollection[_ReferencesDataFolder]": ...

    class _ReferencesDataFile(_Protocol):
        @property
        def id(self) -> str: ...

        @property
        def name(self) -> str: ...

        @property
        def versionNumber(self) -> int: ...

        @property
        def latestVersionNumber(self) -> int: ...

        @property
        def isComplete(self) -> bool: ...

        @property
        def isReadOnly(self) -> bool: ...

        @property
        def parentProject(self) -> _ReferencesDataProject: ...

        @property
        def latestVersion(self) -> "_ReferencesDataFile | None": ...

        @property
        def versions(self) -> "_CadItemCollection[_ReferencesDataFile]": ...

        @property
        def childReferences(self) -> "_CadItemCollection[_ReferencesDataFile]": ...

        def refresh(self, handler: object | None) -> bool: ...

    class _ReferencesDataManager(_Protocol):
        @property
        def dataProjects(self) -> "_CadItemCollection[_ReferencesDataProject]": ...

        @property
        def findFileById(self) -> "Callable[[str], _ReferencesDataFile | None] | None": ...

    class _ReferencesAttribute(_Protocol):
        @property
        def groupName(self) -> str: ...

        @property
        def name(self) -> str: ...

        @property
        def value(self) -> str: ...

    class _ReferencesAttributeOwner(_Protocol):
        @property
        def attributes(self) -> "_CadItemCollection[_ReferencesAttribute]": ...

    class _ReferencesDocumentReference(_Protocol):
        @property
        def dataFile(self) -> _ReferencesDataFile: ...

        @property
        def version(self) -> int: ...

        @property
        def parentDocument(self) -> "_ReferencesDocument": ...

        @property
        def referencedDocument(self) -> "_ReferencesDocument | None": ...

        def getLatestVersion(self) -> bool: ...

    class _ReferencesDocument(_Protocol):
        @property
        def name(self) -> str: ...

        @property
        def creationId(self) -> str: ...

        @property
        def dataFile(self) -> "_ReferencesDataFile | None": ...

        @property
        def isModified(self) -> bool: ...

        @property
        def isSaved(self) -> bool: ...

        @property
        def isUpToDate(self) -> bool: ...

        @property
        def isValid(self) -> bool: ...

        @property
        def documentReferences(self) -> "_CadItemCollection[_ReferencesDocumentReference]": ...

        @property
        def allDocumentReferences(self) -> "_CadItemCollection[_ReferencesDocumentReference]": ...

        def close(self, saveChanges: bool) -> bool: ...

        def activate(self) -> bool: ...

        def save(self, description: str) -> bool: ...

        def updateAllReferences(self) -> bool: ...

    class _ReferencesCommand(_Protocol):
        @property
        def isValid(self) -> bool: ...

        @property
        def isNative(self) -> bool: ...

        def execute(self) -> bool: ...

    class _ReferencesCommandDefinitions(_Protocol):
        def itemById(self, command_id: str) -> _ReferencesCommand | None: ...

    class _ReferencesSelections(_Protocol):
        @property
        def count(self) -> int: ...

    class _ReferencesUserInterface(_Protocol):
        @property
        def activeCommand(self) -> str: ...

        @property
        def activeSelections(self) -> _ReferencesSelections: ...

        @property
        def commandDefinitions(self) -> _ReferencesCommandDefinitions: ...

    class _ReferencesDocuments(_CadItemCollection["_ReferencesDocument"], _Protocol):
        def open(
            self, file: _ReferencesDataFile, visible: bool
        ) -> _ReferencesDocument | None: ...

    class _ReferencesApplication(_Protocol):
        @property
        def data(self) -> _ReferencesDataManager: ...

        @property
        def documents(self) -> _ReferencesDocuments: ...

        @property
        def userInterface(self) -> _ReferencesUserInterface: ...

        @property
        def activeDocument(self) -> "_ReferencesDocument | None": ...

        @property
        def version(self) -> str: ...

    class _ReferencesPoint(_Protocol):
        @property
        def x(self) -> float: ...

        @property
        def y(self) -> float: ...

        @property
        def z(self) -> float: ...

    class _ReferencesUnitsManager(_Protocol):
        def convert(self, value: float, source: str, target: str) -> float: ...

    class _ReferencesParameter(_Protocol):
        @property
        def name(self) -> str: ...

        @property
        def expression(self) -> str: ...

        @property
        def unit(self) -> str: ...

        @property
        def value(self) -> float | str: ...

        @property
        def isFavorite(self) -> bool: ...

        @property
        def dependencyParameters(self) -> "Iterable[_ReferencesParameter]": ...

        @property
        def deriveFeature(self) -> "_ReferencesFeature": ...

    class _ReferencesSnapshots(_Protocol):
        @property
        def hasPendingSnapshot(self) -> bool: ...

    class _ReferencesTimeline(_Protocol):
        @property
        def markerPosition(self) -> int: ...

        @property
        def count(self) -> int: ...

    class _ReferencesDesign(_Protocol):
        @property
        def parentDocument(self) -> _ReferencesDocument: ...

        @property
        def userParameters(self) -> "Iterable[_ReferencesParameter]": ...

        @property
        def derivedParameters(self) -> "Iterable[_ReferencesParameter]": ...

        @property
        def allParameters(self) -> "Iterable[_ReferencesParameter]": ...

        @property
        def unitsManager(self) -> _ReferencesUnitsManager: ...

        @property
        def timeline(self) -> _ReferencesTimeline: ...

        @property
        def snapshots(self) -> _ReferencesSnapshots: ...

        @property
        def designType(self) -> int | None: ...

        def computeAll(self) -> bool: ...

    class _ReferencesOccurrence(_ReferencesAttributeOwner, _Protocol):
        @property
        def entityToken(self) -> str | None: ...

        @property
        def fullPathName(self) -> str: ...

        @property
        def component(self) -> "_ReferencesComponent": ...

        @property
        def isDerived(self) -> bool: ...

        @property
        def isReferencedComponent(self) -> bool: ...

        @property
        def nativeObject(self) -> object | None: ...

        @property
        def assemblyContext(self) -> object | None: ...

        @property
        def transform2(self) -> "adsk.core.Matrix3D": ...

        @property
        def documentReference(self) -> _ReferencesDocumentReference: ...

    class _ReferencesFeatureCollection(_CadItemCollection["_ReferencesFeature"], _Protocol):
        @property
        def deriveFeatures(self) -> "Iterable[_ReferencesFeature]": ...

    class _ReferencesComponent(_ReferencesAttributeOwner, _Protocol):
        @property
        def entityToken(self) -> str | None: ...

        @property
        def name(self) -> str: ...

        @property
        def occurrences(self) -> "Iterable[_ReferencesOccurrence]": ...

        @property
        def allOccurrences(self) -> "Iterable[_ReferencesOccurrence]": ...

        @property
        def bRepBodies(self) -> "Iterable[_ReferencesBody]": ...

        @property
        def features(self) -> _ReferencesFeatureCollection: ...

    class _ReferencesStyle(_Protocol):
        @property
        def id(self) -> str: ...

    class _ReferencesBoundingBox(_Protocol):
        @property
        def minPoint(self) -> _ReferencesPoint: ...

        @property
        def maxPoint(self) -> _ReferencesPoint: ...

    class _ReferencesBody(_ReferencesAttributeOwner, _Protocol):
        @property
        def entityToken(self) -> str | None: ...

        @property
        def name(self) -> str: ...

        @property
        def isSolid(self) -> bool: ...

        @property
        def isLightBulbOn(self) -> bool: ...

        @property
        def faces(self) -> "_CadItemCollection[object]": ...

        @property
        def edges(self) -> "_CadItemCollection[object]": ...

        @property
        def volume(self) -> float: ...

        @property
        def boundingBox(self) -> _ReferencesBoundingBox: ...

        @property
        def material(self) -> "_ReferencesStyle | None": ...

        @property
        def appearance(self) -> "_ReferencesStyle | None": ...

    class _ReferencesFeature(_Protocol):
        @property
        def objectType(self) -> str: ...

        @property
        def entityToken(self) -> str | None: ...

        @property
        def name(self) -> str: ...

        @property
        def isSuppressed(self) -> bool: ...

        @property
        def documentReference(self) -> _ReferencesDocumentReference: ...

        @property
        def sourceDesign(self) -> _ReferencesDesign: ...

    _ReferencesEdge: _CadTypeAlias = dict[str, object]
    _ReferencesPlanEdge: _CadTypeAlias = dict[str, object]
    _ReferencesInput: _CadTypeAlias = Mapping[str, object]

    class _ReferencesForwardInventory(_CadTypedDict):
        linked: "list[_ReferencesDocumentReference]"
        derives: "list[tuple[_ReferencesComponent, _ReferencesFeature]]"
        deriveCollectionEchoes: "dict[str, JsonObject]"

    class _ReferencesSnapshot(_CadTypedDict):
        document: "JsonObject"
        edges: "list[_ReferencesEdge]"
        unhealthy: "list[JsonObject]"
        bindingReadErrors: "list[_ReferencesEdge]"
        coverage: "JsonObject"

    class _ReferencesRawEdge(_CadTypedDict):
        ref: _ReferencesDocumentReference
        sourceFileId: str
        identityPart: str
        ownerContext: "JsonObject"

    class _ReferencesBindings(_CadTypedDict):
        edgeId: str
        sourceParameter: str

    class _ReferencesBinding(_ReferencesBindings, total=False):
        consumerAlias: str
        nativeDerivedParameter: str

    class _ReferencesBindingWithAlias(_ReferencesBindings):
        consumerAlias: str


def _references_as_json_object(value: object) -> "JsonObject":
    return _cad_cast("JsonObject", value)


def _references_str(data: "Mapping[str, object]", key: str) -> str:
    return _cad_cast(str, data[key])


def _references_int(data: "Mapping[str, object]", key: str) -> int:
    return _cad_cast(int, data[key])


def _references_input_object(data: "_ReferencesInput", key: str, default: object | None = None) -> "JsonObject":
    return _cad_cast("JsonObject", data.get(key, default))


def _references_input_rows(data: "_ReferencesInput", key: str, default: object | None = None) -> "list[JsonObject]":
    return _cad_cast("list[JsonObject]", data.get(key, default))


def _references_input_bindings(data: "_ReferencesInput", key: str) -> "list[_ReferencesBinding]":
    return _cad_cast("list[_ReferencesBinding]", data.get(key, []))


def _references_input_mapping(data: "_ReferencesInput", key: str) -> "Mapping[str, JsonValue] | None":
    value = data.get(key)
    return _cad_cast("Mapping[str, JsonValue] | None", value)


def _references_record_str(record: "_ReferencesEdge | _ReferencesBinding", key: str) -> str:
    return _cad_cast(str, record[key])


def _references_record_json(record: "_ReferencesEdge", key: str) -> "JsonObject":
    return _cad_cast("JsonObject", record[key])


def _references_record_rows(record: "_ReferencesEdge", key: str) -> "list[JsonObject]":
    return _cad_cast("list[JsonObject]", record[key])


def _references_rows(value: "JsonValue") -> "list[JsonObject]":
    return _cad_cast("list[JsonObject]", value)


def _references_edges(value: "JsonValue") -> "list[_ReferencesEdge]":
    return _cad_cast("list[_ReferencesEdge]", value)


def _references_plan_edges(value: "JsonValue") -> "list[_ReferencesPlanEdge]":
    return _cad_cast("list[_ReferencesPlanEdge]", value)


def _references_context_app(ctx: "CadContext") -> "_ReferencesApplication":
    return _cad_cast("_ReferencesApplication", _cad_cast(object, ctx.app))


def _references_context_document(ctx: "CadContext") -> "_ReferencesDocument":
    return _cad_cast("_ReferencesDocument", _cad_cast(object, ctx.doc))


def _references_context_design(ctx: "CadContext") -> "_ReferencesDesign":
    return _cad_cast("_ReferencesDesign", _cad_cast(object, ctx.design))


def _references_context_component(ctx: "CadContext") -> "_ReferencesComponent":
    return _cad_cast("_ReferencesComponent", _cad_cast(object, ctx.root))


def _references_reference_token(reference: "_ReferencesDocumentReference") -> "str | None":
    try:
        token = _cad_cast(object, getattr(reference, 'entityToken', None))
    except Exception:
        return None
    return _cad_cast("str | None", token)


def _references_reference_occurrence(reference: "_ReferencesDocumentReference") -> "_ReferencesOccurrence | None":
    try:
        occurrence = _cad_cast(object, getattr(reference, 'occurrence', None))
    except Exception:
        return None
    return _cad_cast("_ReferencesOccurrence | None", occurrence)


def _references_items(collection: "_CadItemCollection[_CadItem] | Iterable[_CadItem]") -> "list[_CadItem]":
    try:
        return _cad_items(_cad_cast("_CadItemCollection[_CadItem]", collection))
    except AttributeError:
        # Some Fusion vectors are iterable but expose no .count (notably
        # DerivedParameterVector); preserve their runtime members rather than
        # converting a supported getter into an unresolved binding.
        return list(_cad_cast("Iterable[_CadItem]", collection))


def _references_file_identity(file: "_ReferencesDataFile") -> "JsonObject":
    project = getattr(file, 'parentProject', None)
    result: JsonObject = {'fileId': _cad_cast("str | None", getattr(file, 'id', None)),
                          'fileName': _cad_cast("str | None", getattr(file, 'name', None)),
                          'projectId': _cad_cast("str | None", getattr(project, 'id', None))}
    for key in ('versionNumber', 'latestVersionNumber', 'isComplete', 'isReadOnly'):
        try: result[{'versionNumber': 'version', 'latestVersionNumber': 'latestVersion',
                     'isComplete': 'isComplete', 'isReadOnly': 'readOnly'}[key]] = _cad_cast("int | bool", getattr(file, key))
        except Exception as exc:
            _cad_cast("JsonObject", result.setdefault('getterErrors', {}))[key] = type(exc).__name__ + ': ' + str(exc)
    return result


def _references_document_identity(doc: "_ReferencesDocument") -> "JsonObject":
    file = _cad_cast("_ReferencesDataFile | None", _cad_cast(object, getattr(doc, 'dataFile', None)))
    if file is None:
        return {'name': doc.name, 'creationId': doc.creationId, 'fileId': None, 'projectId': None,
                'version': None, 'latestVersion': None, 'isComplete': None, 'readOnly': None}
    result = _references_file_identity(file)
    result.update(name=doc.name, creationId=doc.creationId)
    for key in ('isModified', 'isSaved', 'isUpToDate'):
        try: result[{'isModified': 'modified', 'isSaved': 'saved', 'isUpToDate': 'isUpToDate'}[key]] = bool(_cad_cast(object, getattr(doc, key)))
        except Exception as exc:
            _cad_cast("JsonObject", result.setdefault('getterErrors', {}))[key] = type(exc).__name__ + ': ' + str(exc)
    return result


def _references_walk_files(folder: "_ReferencesDataFolder", visited: "set[str] | None" = None) -> "Generator[_ReferencesDataFile, None, None]":
    visited = visited if visited is not None else set()
    key = _cad_cast("str | None", getattr(folder, 'id', None)) or str(id(folder))
    if key in visited:
        return
    visited.add(key)
    for file in _references_items(folder.dataFiles):
        yield file
    for child in _references_items(folder.dataFolders):
        for file in _references_walk_files(child, visited):
            yield file


def _references_project_file(app: "_ReferencesApplication", project_id: str, file_id: str,
                             version: int | None = None) -> "_ReferencesDataFile":
    projects = [project for project in _references_items(app.data.dataProjects) if project.id == project_id]
    if len(projects) != 1:
        raise ValueError('projectId must match exactly one accessible project')
    lookup = _cad_cast("Callable[[str], _ReferencesDataFile | None] | None",
                       getattr(app.data, 'findFileById', None))
    if callable(lookup):
        file = lookup(file_id)
        if file is None or file.id != file_id or file.parentProject.id != project_id:
            raise ValueError('fileId did not resolve in the allowed project')
        # Resolve latest independently of the reference-buffer DataFile. Do not
        # enumerate every unrelated worker folder for every edge/readback.
        latest = file.latestVersion
        if latest is None or latest.id != file_id or latest.parentProject.id != project_id:
            raise ValueError('latest DataFile identity differs from the requested file/project')
        matches: list[_ReferencesDataFile] = [latest]
    else:
        matches = [file for file in _references_walk_files(projects[0].rootFolder) if file.id == file_id]
    if len(matches) != 1:
        raise ValueError('fileId must match exactly one DataFile in the allowed project; found %d' % len(matches))
    file = matches[0]
    if version is None:
        return file
    if type(version) is not int or version < 1:
        raise ValueError('version must be a positive exact DataFile version number')
    if int(file.versionNumber) == version:
        return file
    try:
        versions = _references_items(file.versions)
    except Exception as exc:
        raise ValueError('DataFile.versions exact-version collection is unavailable; latest/name fallback refused') from exc
    exact: list[_ReferencesDataFile] = []
    for candidate in versions:
        try:
            candidate_project = _cad_cast("_ReferencesDataProject | None", candidate.parentProject)
            if (candidate.id == file_id and int(candidate.versionNumber) == version and
                    candidate_project is not None and candidate_project.id == project_id):
                exact.append(candidate)
        except Exception:
            continue
    if len(exact) != 1:
        raise ValueError('DataFile.versions must expose exactly one matching fileId/version; found %d; latest/name fallback refused' %
                         len(exact))
    return exact[0]


def _references_target_file(app: "_ReferencesApplication", project_id: str, file_id: str,
                            version: int, data_file_hint: "_ReferencesDataFile | None" = None) -> "_ReferencesDataFile":
    if data_file_hint is not None:
        try:
            project = _cad_cast("_ReferencesDataProject | None", data_file_hint.parentProject)
            if (data_file_hint.id == file_id and project is not None and project.id == project_id and
                    int(data_file_hint.versionNumber) == version):
                return data_file_hint
        except Exception:
            pass
    return _references_project_file(app, project_id, file_id, version)


def _references_open_matches(app: "_ReferencesApplication", file_id: str, project_id: str,
                             version: int | None = None) -> "list[_ReferencesDocument]":
    rows: list[_ReferencesDocument] = []
    for doc in _references_items(app.documents):
        file = _cad_cast("_ReferencesDataFile | None", _cad_cast(object, getattr(doc, 'dataFile', None)))
        if file is None or file.id != file_id:
            continue
        parent = _cad_cast("_ReferencesDataProject | None", _cad_cast(object, getattr(file, 'parentProject', None)))
        if parent is None or parent.id != project_id:
            continue
        if version is not None and file.versionNumber != version:
            continue
        try:
            doc.allDocumentReferences.count
        except RuntimeError as error:
            if 'non-top-level document' in str(error):
                continue
            raise
        rows.append(doc)
    return rows


def _references_open_file(app: "_ReferencesApplication", project_id: str, file_id: str,
                          version: int, lifecycle: str, opened: "list[_ReferencesDocument]") -> "tuple[_ReferencesDocument | None, JsonObject]":
    matches = _references_open_matches(app, file_id, project_id, version)
    if len(matches) > 1:
        return None, {'status': 'ambiguous', 'candidates': [_references_document_identity(doc) for doc in matches]}
    if matches:
        doc = matches[0]
        return doc, {'status': 'resolved', 'openedByRequest': False,
                     'identity': _references_document_identity(doc)}
    other_versions = _references_open_matches(app, file_id, project_id)
    if other_versions:
        return None, {'status': 'olderRevisionOpen', 'candidates': [_references_document_identity(doc) for doc in other_versions]}
    if lifecycle != 'openOwned':
        return None, {'status': 'unavailable', 'unavailableEvidence': ['exact file/version is not already open']}
    try:
        file = _references_project_file(app, project_id, file_id, version)
    except Exception as exc:
        return None, {'status': 'unavailable',
                      'unavailableEvidence': [type(exc).__name__ + ': ' + str(exc)]}
    if file.isComplete is not True or file.isReadOnly is not False:
        return None, {'status': 'blocked', 'unavailableEvidence': ['pinned DataFile is incomplete or read-only']}
    doc = _cad_require_result(app.documents.open(file, True), 'Open exact owned reference document')
    identity = _references_document_identity(doc)
    if identity['fileId'] != file_id or identity['projectId'] != project_id or identity['version'] != version:
        return None, {'status': 'identity_mismatch', 'identity': identity}
    opened.append(doc)
    return doc, {'status': 'resolved', 'openedByRequest': True, 'identity': identity}


def _references_own_components(root: "_ReferencesComponent") -> "Generator[_ReferencesComponent, None, None]":
    pending: list[_ReferencesComponent]
    seen: set[str]
    pending, seen = [root], set()
    while pending:
        component = pending.pop()
        token = _cad_cast("str | None", getattr(component, 'entityToken', None))
        key = token if token else str(id(component))
        if key in seen:
            continue
        seen.add(key)
        yield component
        for occurrence in _references_items(component.occurrences):
            try:
                referenced = occurrence.isReferencedComponent
                derived = occurrence.isDerived
            except Exception as error:
                raise ValueError('Owned component traversal unavailable: ' + type(error).__name__)
            if referenced is False and derived is False:
                pending.append(occurrence.component)


def _references_attribute_rows(entity: "_ReferencesAttributeOwner", kind: str, namespace: str | None) -> "tuple[list[JsonObject], JsonObject]":
    rows: list[JsonObject] = []
    try:
        attributes = _references_items(entity.attributes)
        for attribute in attributes:
            rows.append({'kind': kind, 'namespace': namespace,
                         'group': attribute.groupName, 'name': attribute.name, 'value': attribute.value})
    except Exception as error:
        return [], {'kind': kind, 'namespace': namespace, 'status': 'unknown',
                    'error': type(error).__name__ + ': ' + str(error)}
    return rows, {'kind': kind, 'namespace': namespace, 'status': 'complete', 'count': len(rows)}


def _references_vec(point: "_ReferencesPoint") -> "list[float]":
    return [float(point.x), float(point.y), float(point.z)]


def _references_native_occurrence_token(native: object | None) -> "str | None":
    if native is None:return None
    try:
        return _cad_cast("str | None", _cad_cast(object, getattr(native, 'entityToken', None)))
    except RuntimeError as error:
        if 'Tokens can only be created for proxies whose top-level parent is the root component' in str(error):return None
        raise


def _references_metadata(design: "_ReferencesDesign", root: "_ReferencesComponent") -> "JsonObject":
    attrs: list[JsonObject]
    coverage: list[JsonObject]
    attrs, coverage = [], []
    components = list(_references_own_components(root))
    component_ids = { _cad_cast("str | None", _cad_cast(object, getattr(component, 'entityToken', None))) for component in components}
    body_rows: list[JsonObject]
    occurrence_rows: list[JsonObject]
    consumed_rows: list[JsonObject]
    body_rows, occurrence_rows, consumed_rows = [], [], []
    for component in components:
        token = _cad_cast("str | None", _cad_cast(object, getattr(component, 'entityToken', None)))
        rows, cover = _references_attribute_rows(component, 'component', token)
        attrs.extend(rows); coverage.append(cover)
        for body in _references_items(component.bRepBodies):
            key = _cad_cast("str | None", _cad_cast(object, getattr(body, 'entityToken', None)))
            box = body.boundingBox
            body_rows.append({'componentToken': token, 'bodyToken': key, 'name': getattr(body, 'name', None),
                              'isSolid': bool(body.isSolid), 'isVisible': bool(getattr(body, 'isLightBulbOn', True)),
                              'faces': int(body.faces.count), 'edges': int(body.edges.count),
                              'volumeInternal': float(body.volume),
                              'boundsInternal': [_references_vec(box.minPoint), _references_vec(box.maxPoint)],
                              'materialId': _cad_cast("str | None", _cad_cast(object, getattr(getattr(body, 'material', None), 'id', None))),
                              'appearanceId': _cad_cast("str | None", _cad_cast(object, getattr(getattr(body, 'appearance', None), 'id', None)))})
            rows, cover = _references_attribute_rows(body, 'body', str(key))
            attrs.extend(rows); coverage.append(cover)
        for feature in _references_items(component.features):
            kind = _cad_type(_cad_cast("adsk.core.Base", feature))
            if kind in ('CombineFeature', 'CutPasteBody', 'RectangularPatternFeature', 'CircularPatternFeature', 'PathPatternFeature'):
                refs: list[JsonObject]
                refs = []
                for property_name in ('targetBody', 'toolBodies', 'participantBodies', 'sourceBody', 'inputEntities', 'seedEntity'):
                    try:
                        value = _cad_cast(object, getattr(feature, property_name))
                    except (AttributeError, RuntimeError):
                        continue
                    if value is None:
                        continue
                    try:
                        members = _references_items(_cad_cast("_CadItemCollection[object]", value)) if hasattr(value, 'count') else [value]
                    except Exception:
                        members = []
                    for member in members:
                        try:
                            owner = _cad_cast(object, getattr(member, 'parentComponent', None)) or _cad_cast(object, getattr(_cad_cast(object, getattr(member, 'body', None)), 'parentComponent', None))
                            refs.append({'property': property_name, 'token': _cad_cast("str | None", _cad_cast(object, getattr(member, 'entityToken', None))),
                                         'ownerToken': _cad_cast("str | None", _cad_cast(object, getattr(owner, 'entityToken', None))),
                                         'ownerIsLocal': owner is None or _cad_cast("str | None", _cad_cast(object, getattr(owner, 'entityToken', None))) in component_ids})
                        except Exception:
                            refs.append({'property': property_name, 'status': 'unknown'})
                consumed_rows.append({'featureToken': _cad_cast("str | None", _cad_cast(object, getattr(feature, 'entityToken', None))), 'type': kind,
                                       'ownerToken': token, 'consumedRefs': refs,
                                       'contextVerified': bool(refs) and all(row.get('ownerIsLocal') is True for row in refs)})
    for occurrence in _references_items(root.allOccurrences):
        token = _cad_cast("str | None", _cad_cast(object, getattr(occurrence, 'entityToken', None)))
        component = occurrence.component
        is_derived = bool(getattr(occurrence, 'isDerived', False))
        is_referenced = bool(getattr(occurrence, 'isReferencedComponent', False))
        native = getattr(occurrence, 'nativeObject', None)
        native_token = _references_native_occurrence_token(native)
        occurrence_rows.append({'token': token, 'path': occurrence.fullPathName,
                                'componentToken': _cad_cast("str | None", _cad_cast(object, getattr(component, 'entityToken', None))),
                                'componentName': _cad_cast("str | None", _cad_cast(object, getattr(component, 'name', None))),
                                'isDerived': is_derived, 'isReferencedComponent': is_referenced,
                                'transform': list(occurrence.transform2.asArray()),
                                'nativeToken': native_token,
                                **({'nativeAttributeLocator':'nativeObjectOf:'+str(token)} if native is not None and native_token is None else {}),
                                'contextKind': 'proxy' if getattr(occurrence, 'assemblyContext', None) is not None else 'native'})
        rows, cover = _references_attribute_rows(_cad_cast("_ReferencesAttributeOwner", occurrence), 'nativeOccurrence', token)
        attrs.extend(rows); coverage.append(cover)
        if native is not None:
            rows, cover = _references_attribute_rows(_cad_cast("_ReferencesAttributeOwner", native), 'nativeObject', native_token or 'nativeObjectOf:'+str(token))
            attrs.extend(rows); coverage.append(cover)
    # Construction/source geometry and hidden B-Rep bodies are counted from the
    # owned local component definitions above, never inferred from visibility.
    metadata_coverage = {'component': 'complete', 'body': 'complete',
        'nativeOccurrence': 'complete', 'occurrenceProxy': 'complete',
        'nativeObject': 'complete' if all(row['status'] == 'complete' for row in coverage) else 'unknown'}
    return {'components': len(components), 'bodies': body_rows, 'occurrences': occurrence_rows,
            'attributes': attrs, 'attributeCoverage': coverage, 'consumedBodies': consumed_rows,
            'consumedBodiesVerified': all(row['contextVerified'] for row in consumed_rows),
            'metadataCoverage': metadata_coverage,
            'metadataComplete': all(value == 'complete' for value in metadata_coverage.values()),
            'componentTokens': sorted(str(value) for value in component_ids if value)}




def _references_internal_unit(parameter: "_ReferencesParameter") -> "tuple[str, str]":
    unit = str(getattr(parameter, 'unit', '') or '').strip()
    if unit.lower() == 'text':
        return 'text', 'text'
    if unit in ('mm', 'cm', 'm', 'in'):
        return unit, 'cm'
    if unit in ('deg', 'rad'):
        return unit, 'rad'
    if unit in ('', 'unitless', '1'):
        return unit or '1', '1'
    raise ValueError('Unsupported parameter unit for binding proof: ' + unit)


def _references_parameter_value(parameter: "_ReferencesParameter", units_manager: "_ReferencesUnitsManager") -> "JsonObject":
    display_unit, internal_unit = _references_internal_unit(parameter)
    if internal_unit == 'text':
        value = str(parameter.value)
        return {'name': str(parameter.name), 'expression': str(parameter.expression), 'dependsOn': [],
                'internal_value': value, 'internal_unit': 'text',
                'display_value': value, 'display_unit': 'text',
                'isFavorite': bool(getattr(parameter, 'isFavorite', False))}
    internal_value = float(parameter.value)
    expression = str(parameter.expression)
    if display_unit == internal_unit:
        display_value = internal_value
    else:
        display_value = float(units_manager.convert(internal_value, internal_unit, display_unit))
    try:
        dependencies = [str(item.name) for item in _references_items(parameter.dependencyParameters)]
    except Exception:
        dependencies = None
    return {'name': str(parameter.name), 'expression': expression, 'dependsOn': dependencies,
            'internal_value': internal_value, 'internal_unit': internal_unit,
            'display_value': display_value, 'display_unit': display_unit,
            'isFavorite': bool(getattr(parameter, 'isFavorite', False))}


def _references_edge_version(doc: "_ReferencesDocument", edge: "_ReferencesDocumentReference",
                             source_id: str, forward_count: int,
                             app: "_ReferencesApplication | None" = None,
                             allowed_project_ids: "set[str] | None" = None) -> "JsonObject":
    version: int | None = None
    error: str | None = None
    try:
        version = int(edge.version)
    except Exception as exc:
        error = str(exc)
    source_file = _cad_cast("_ReferencesDataFile | None", _cad_cast(object, getattr(edge, 'dataFile', None)))
    latest: int | None = None
    latest_source: str | None = None
    latest_error: str | None = None
    file_version: int | None = None
    source_project: str | None = None
    if source_file is not None:
        try: file_version = int(source_file.versionNumber)
        except Exception: pass
        try: source_project = source_file.parentProject.id
        except Exception: pass
        allowed_projects = set(allowed_project_ids if allowed_project_ids is not None else
                               [_cad_cast("str | None", _cad_cast(object, getattr(getattr(getattr(doc, 'dataFile', None), 'parentProject', None), 'id', None)))])
        if app is not None and source_project in allowed_projects:
            try:
                current_file = _references_project_file(app, _cad_cast(str, source_project), source_id)
                latest = int(current_file.latestVersionNumber)
                latest_source = 'project_datafile'
            except Exception as exc:
                latest_error = type(exc).__name__ + ': ' + str(exc)
                latest_source = 'unresolved'
        else:
            try:
                latest = int(source_file.latestVersionNumber)
                latest_source = 'reference_datafile'
            except Exception as exc:
                latest_error = type(exc).__name__ + ': ' + str(exc)
                latest_source = 'unresolved'
    source = 'document_reference'
    if version is None and error and 'InternalValidationError : doc' in error and forward_count == 1:
        matches: list[int] = []
        try:
            for child in _references_items(_cad_cast("_ReferencesDataFile", doc.dataFile).childReferences):
                if child.id == source_id:
                    matches.append(int(child.versionNumber))
        except Exception:
            matches = []
        if len(matches) == 1:
            version = matches[0]
            source = 'saved_forward_cloud_reference'
        else:
                    source = 'unresolved'
    elif version is None:
        source = 'unresolved'
    return {'baselineVersion': version, 'dataFileVersion': file_version, 'latestVersion': latest,
            'sourceProjectId': source_project, 'versionSource': source,
            'latestVersionSource': latest_source, 'latestVersionError': latest_error,
            'getterError': error}


def _references_forward_inventory(ctx: "CadContext") -> "_ReferencesForwardInventory":
    refs = _references_items(_cad_cast("_ReferencesDocument", ctx.doc).documentReferences)
    features = [(component, feature) for component in _references_own_components(_cad_cast("_ReferencesComponent", ctx.root))
              for feature in _references_items(component.features.deriveFeatures)
              if not bool(getattr(feature,'isSuppressed',False))]
    linked_sources={o.documentReference.dataFile.id for o in _references_items(_cad_cast("_ReferencesComponent", ctx.root).allOccurrences)
                    if getattr(o,'isReferencedComponent',False)}
    kept: list[_ReferencesDocumentReference]
    echoes: dict[str, JsonObject]
    kept=[];echoes={}
    for ref in refs:
        correlated=None
        try:
            source=ref.dataFile
            matches=[feature for component,feature in features if feature.documentReference.dataFile.id==source.id]
            same_source=[other for other in refs if other.dataFile.id==source.id]
            # A file ID alone is not proof. Keep self edges, ordinary occurrence
            # uses, multiple references/features/pins, and unknown contexts.
            if (source.id!=_cad_cast("_ReferencesDataFile", _cad_cast("_ReferencesDocument", ctx.doc).dataFile).id and source.id not in linked_sources and
                    len(matches)==1 and len(same_source)==1 and
                    not _cad_cast("str | None", _cad_cast(object, getattr(ref, 'entityToken', None))) and
                    not _cad_cast("_ReferencesOccurrence | None", _cad_cast(object, getattr(ref, 'occurrence', None)))):
                feature=matches[0];derived=feature.documentReference
                referenced=ref.referencedDocument
                if (_cad_cast("str | None", _cad_cast(object, getattr(feature, 'entityToken', None))) and
                        ref.parentDocument==_cad_cast("_ReferencesDocument", ctx.doc) and derived.parentDocument==_cad_cast("_ReferencesDocument", ctx.doc) and
                        referenced is not None and referenced==derived.referencedDocument and
                        source.parentProject.id==derived.dataFile.parentProject.id and
                        int(source.versionNumber)==int(derived.dataFile.versionNumber) and
                        int(ref.version)==int(derived.version) and int(ref.version)>0):
                    correlated=_cad_cast(str, feature.entityToken)
                    echoes[correlated]={'sourceFileId':source.id,'version':int(ref.version),
                        'ownerCreationId':_cad_cast("_ReferencesDocument", ctx.doc).creationId,'referencedCreationId':referenced.creationId,
                        'evidence':'sameOwnerAndReferencedDocumentAndPin;noOrdinaryOccurrenceUse'}
        except Exception:
            # Missing optional correlation evidence never discards an edge.
            correlated=None
        if correlated is None: kept.append(ref)
    return {'linked':kept,'derives':features,'deriveCollectionEchoes':echoes}


def _references_owned_derives(ctx: "CadContext", allowed_project_ids: "set[str] | None" = None,
                              inventory: "_ReferencesForwardInventory | None" = None) -> "list[_ReferencesEdge]":
    allowed_project_ids = set(allowed_project_ids if allowed_project_ids is not None else
                              [_cad_cast("_ReferencesDataFile", ctx.doc.dataFile).parentProject.id])
    rows: list[_ReferencesEdge]
    visited: set[tuple[str, str]]
    forward_counts: dict[str, int]
    rows, visited = [], set()
    forward_counts = {}
    inventory=inventory if inventory is not None else _references_forward_inventory(ctx)
    for ref in inventory['linked']:
        try:
            file_id = ref.dataFile.id
            forward_counts[file_id] = forward_counts.get(file_id, 0) + 1
        except Exception:
            pass
    owned_features = inventory['derives']
    for owner_component,owned_feature in owned_features:
        try:
            file_id=owned_feature.documentReference.dataFile.id
            forward_counts[file_id]=forward_counts.get(file_id,0)+1
        except Exception:pass
    for component, feature in owned_features:
        component_token = _cad_cast("str | None", _cad_cast(object, getattr(component, 'entityToken', None)))
        token = _cad_cast("str | None", _cad_cast(object, getattr(feature, 'entityToken', None)))
        ref = feature.documentReference
        source_file = ref.dataFile
        key = (source_file.id, token or str(id(feature)))
        if key in visited:
            continue
        visited.add(key)
        version_info = _references_edge_version(_cad_cast("_ReferencesDocument", ctx.doc), ref, source_file.id,
            forward_counts.get(source_file.id, 0), _cad_cast("_ReferencesApplication", ctx.app), allowed_project_ids)
        source_design: _ReferencesDesign | None
        source_params: list[JsonObject]
        source_modified: bool | None
        source_parameter_file: str | None
        source_parameter_version: int | None
        source_design = None
        source_params = []
        source_modified = None
        source_parameter_file = None
        source_parameter_version = None
        try:
            source_design = feature.sourceDesign
            parent = source_design.parentDocument
            source_modified = bool(parent.isModified)
            source_params = [_references_parameter_value(parameter, source_design.unitsManager)
                             for parameter in _references_items(source_design.userParameters)]
            source_parameter_file = _cad_cast("_ReferencesDataFile", parent.dataFile).id
            source_parameter_version = int(_cad_cast("_ReferencesDataFile", parent.dataFile).versionNumber)
        except Exception as exc:
            source_params = []
            source_error = type(exc).__name__ + ': ' + str(exc)
        else:
            source_error = None
        derived_params: list[JsonObject]
        derived_params = []
        try:
            for parameter in _references_items(_cad_cast("_ReferencesDesign", ctx.design).derivedParameters):
                if parameter.deriveFeature == feature:
                    derived_params.append(_references_parameter_value(parameter, _cad_cast("_ReferencesDesign", ctx.design).unitsManager))
        except Exception as exc:
            source_error = source_error or ('derivedParameters: ' + type(exc).__name__ + ': ' + str(exc))
        owner_paths = [occ.fullPathName for occ in _references_items(_cad_cast("_ReferencesComponent", ctx.root).allOccurrences)
                       if occ.component == component]
        identity_part = token or (str(component_token) + ':' + source_file.id + ':' + str(feature.name))
        edge_id = _references_edge_id(_cad_cast("_ReferencesDataFile", ctx.doc.dataFile).id, 'derive', source_file.id, identity_part)
        rows.append(_cad_cast("_ReferencesEdge", {'edgeId': edge_id, 'edgeIdentityUnique': bool(token), 'kind': 'derive',
                     'ownerFileId': _cad_cast("_ReferencesDataFile", ctx.doc.dataFile).id,
                     'ownerProjectId': _cad_cast("_ReferencesDataFile", ctx.doc.dataFile).parentProject.id,
                     'ownerContext': {'componentToken': component_token,
                         'componentName': component.name, 'occurrencePaths': owner_paths},
                     'sourceFileId': source_file.id, 'sourceProjectId': source_file.parentProject.id,
                     'featureName': feature.name, 'featureToken': token,
                      'suppressed': False, 'selfReference': source_file.id == _cad_cast("_ReferencesDataFile", ctx.doc.dataFile).id,
                     **version_info, 'sourceParameters': source_params,
                      'derivedParameters': derived_params, 'sourceDocumentModified': source_modified,
                      'sourceParameterFileId': source_parameter_file, 'sourceParameterVersion': source_parameter_version,
                          'bindingReadError': source_error, '_sourceDataFile': source_file,
                           **({'collectionEcho': inventory['deriveCollectionEchoes'][_cad_cast(str, token)]}
                           if _cad_cast(str, token) in inventory['deriveCollectionEchoes'] else {})}))
    return rows


def _references_linked_edges(ctx: "CadContext", allowed_project_ids: "set[str] | None" = None,
                             inventory: "_ReferencesForwardInventory | None" = None) -> "list[_ReferencesEdge]":
    allowed_project_ids = set(allowed_project_ids if allowed_project_ids is not None else
                              [_cad_cast("_ReferencesDataFile", ctx.doc.dataFile).parentProject.id])
    inventory=inventory if inventory is not None else _references_forward_inventory(ctx)
    refs = inventory['linked']
    forward_counts: dict[str, int]
    forward_counts = {}
    for reference in refs:
        try:
            file_id = reference.dataFile.id
            forward_counts[file_id] = forward_counts.get(file_id, 0) + 1
        except Exception:
            pass
    for component,feature in inventory['derives']:
        try:
            file_id=feature.documentReference.dataFile.id
            forward_counts[file_id]=forward_counts.get(file_id,0)+1
        except Exception:pass
    raw: list[_ReferencesRawEdge]
    raw = []
    for index, ref in enumerate(refs):
        source_file = ref.dataFile
        try: token = _cad_cast("str | None", _cad_cast(object, getattr(ref, 'entityToken', None)))
        except Exception: token = None
        try: owner_context = _cad_cast("_ReferencesOccurrence | None", _cad_cast(object, getattr(ref, 'occurrence', None)))
        except Exception: owner_context = None
        context_token = _cad_cast("str | None", _cad_cast(object, getattr(owner_context, 'entityToken', None))) if owner_context else None
        context_path = _cad_cast("str | None", _cad_cast(object, getattr(owner_context, 'fullPathName', None))) if owner_context else None
        identity_part = token or context_token or source_file.id
        raw.append({'ref': ref, 'sourceFileId': source_file.id, 'identityPart': identity_part,
                    'ownerContext': {'componentToken': _cad_cast("str | None", _cad_cast(object, getattr(ctx.root, 'entityToken', None))),
                                      'occurrenceToken': context_token, 'occurrencePath': context_path}})
    counts: dict[tuple[str, str], int]
    counts = {}
    for row in raw:
        key = (row['sourceFileId'], row['identityPart'])
        counts[key] = counts.get(key, 0) + 1
    rows: list[_ReferencesEdge]
    rows = []
    for row in raw:
        ref = row['ref']
        source_id = row['sourceFileId']
        version_info = _references_edge_version(_cad_cast("_ReferencesDocument", ctx.doc), ref, source_id,
            forward_counts.get(source_id, 0), _cad_cast("_ReferencesApplication", ctx.app), allowed_project_ids)
        unique = counts[(source_id, row['identityPart'])] == 1
        rows.append(_cad_cast("_ReferencesEdge", {'edgeId': _references_edge_id(_cad_cast("_ReferencesDataFile", ctx.doc.dataFile).id, 'linked', source_id, row['identityPart']),
                       'edgeIdentityUnique': unique, 'kind': 'linked',
                       'isOccurrenceReference': any(getattr(o,'isReferencedComponent',False) and
                            o.documentReference.dataFile.id==source_id for o in _references_items(_cad_cast("_ReferencesComponent", ctx.root).allOccurrences)),
                       'ownerFileId': _cad_cast("_ReferencesDataFile", ctx.doc.dataFile).id, 'ownerProjectId': _cad_cast("_ReferencesDataFile", ctx.doc.dataFile).parentProject.id,
                        'ownerContext': row['ownerContext'], 'sourceFileId': source_id,
                        'sourceProjectId': _cad_cast("str | None", _cad_cast(object, getattr(getattr(ref.dataFile, 'parentProject', None), 'id', None))),
                         'selfReference': source_id == _cad_cast("_ReferencesDataFile", ctx.doc.dataFile).id, 'suppressed': False,
                       **version_info, '_sourceDataFile': ref.dataFile}))
    return rows


def _references_doc_snapshot(ctx: "CadContext", allowed_project_ids: "set[str]",
                             visited_paths: "set[str]", caller_namespaces: "Mapping[str, JsonValue] | None" = None) -> "_ReferencesSnapshot":
    doc = _cad_cast("_ReferencesDocument", ctx.doc)
    file = _cad_cast("_ReferencesDataFile", doc.dataFile)
    design = _cad_cast("_ReferencesDesign", ctx.design)
    identity = _references_document_identity(doc)
    health = _cad_cast("JsonObject", ctx.call('history.check', {}))
    metadata = _references_metadata(design, _cad_cast("_ReferencesComponent", ctx.root))
    inventory=_references_forward_inventory(ctx)
    derives = _references_owned_derives(ctx, allowed_project_ids, inventory)
    linked = _references_linked_edges(ctx, allowed_project_ids, inventory)
    all_edges = linked + derives
    # A duplicated structural identity cannot receive a caller pin or be safely
    # acted on. Keep diagnostics, but the planner must not silently collapse it.
    duplicate_ids = {edge['edgeId'] for edge in all_edges
                     if sum(1 for other in all_edges if other['edgeId'] == edge['edgeId']) > 1}
    for edge in all_edges:
        if edge['edgeId'] in duplicate_ids:
            edge['edgeIdentityUnique'] = False
            edge['identityError'] = 'multiple edges have the same stable structural identity'
        if caller_namespaces and _cad_cast(str, edge['edgeId']) in caller_namespaces:
            edge['callerNamespace'] = caller_namespaces[_cad_cast(str, edge['edgeId'])]
            edge['ownerContext'] = dict(_cad_cast("JsonObject", edge.get('ownerContext', {})), callerNamespace=caller_namespaces[_cad_cast(str, edge['edgeId'])])
        edge['scopeProjectAllowed'] = edge['sourceProjectId'] in allowed_project_ids
    parameters: list[JsonObject]
    parameters = []
    for parameter in _references_items(design.allParameters):
        try:
            parameters.append(_references_parameter_value(parameter, design.unitsManager))
        except Exception as exc:
            parameters.append({'name': str(getattr(parameter, 'name', '<unknown>')),
                               'status': 'unknown', 'error': type(exc).__name__ + ': ' + str(exc)})
    design_type = _cad_cast("int | None", getattr(design, 'designType', None))
    marker = int(design.timeline.markerPosition)
    timeline_count = int(design.timeline.count)
    bad_contexts = [row for row in _cad_cast("list[JsonObject]", metadata['consumedBodies']) if row.get('contextVerified') is not True]
    owner_unknown = any(row.get('ownerUnknown') is True for row in _cad_cast("list[JsonObject]", health.get('timeline', [])))
    history_healthy = health.get('status') == 'pass' and health.get('healthy') is True and not owner_unknown
    metadata_coverage = _cad_cast("JsonObject", metadata['metadataCoverage'])
    metadata_complete = all(value == 'complete' for value in metadata_coverage.values())
    version = int(file.versionNumber)
    latest = identity.get('latestVersion')
    project_id = file.parentProject.id
    if not isinstance(latest, int):
        getter_errors = _cad_cast("JsonObject", identity.setdefault('getterErrors', {}))
        getter_errors.setdefault('latestVersionNumber', 'unavailable')
    return {'document': {**identity, 'version': version, 'latestVersion': latest,
                         'isComplete': identity.get('isComplete'), 'readOnly': identity.get('readOnly'),
                         'modified': identity.get('modified'), 'saved': identity.get('saved'), 'isUpToDate': identity.get('isUpToDate'),
                         'timelineAtEnd': marker == timeline_count, 'timelineMarker': marker,
                         'timelineCount': timeline_count, 'pendingSnapshot': bool(design.snapshots.hasPendingSnapshot),
                         'designType': int(design_type) if design_type is not None else None,
                         'available': True, 'openedByRequest': doc.creationId in visited_paths,
                         'history': {**health, 'healthy': history_healthy,
                                     'repairRequired': not history_healthy or bool(bad_contexts)},
                         'repairRequired': not history_healthy or bool(bad_contexts),
                         'consumedBodiesVerified': not bad_contexts,
                         'historySnapshotSupported': True,
                         'metadataCoverage': metadata_coverage,
                         'metadataComplete': metadata_complete,
                         'metadata': metadata, 'parameters': parameters,
                         'userParameters': _references_user_parameter_state(design),
                         'deriveCount': len(derives)},
            'edges': all_edges,
             'unhealthy': [row for row in _cad_cast("list[JsonObject]", health.get('timeline', [])) if row.get('state') != 'HealthyFeatureHealthState' and not row.get('duplicate')],
            'bindingReadErrors': [edge for edge in derives if edge.get('bindingReadError')],
            'coverage': {'directReferences': len(linked), 'ownedUnsuppressedDerives': len(derives),
                          'suppressedDerivesExcluded': sum(1 for component in _references_own_components(_cad_cast("_ReferencesComponent", ctx.root))
                            for feature in _references_items(component.features.deriveFeatures) if bool(feature.isSuppressed)),
                           'ownedComponents': metadata['components'], 'bodyDefinitions': len(_cad_cast("list[JsonObject]", metadata['bodies'])),
                           'occurrences': len(_cad_cast("list[JsonObject]", metadata['occurrences'])), 'metadataComplete': metadata_complete}}


def _references_collect_graph(data: "_ReferencesInput") -> "JsonObject":
    app = _cad_cast("_ReferencesApplication", adsk.core.Application.get())
    project_id, root_id, root_version = (_cad_cast(str, _cad_cast("JsonObject", data['root'])['projectId']),
                                         _cad_cast(str, _cad_cast("JsonObject", data['root'])['fileId']),
                                         _cad_cast(int, _cad_cast("JsonObject", data['root'])['version']))
    lifecycle = _cad_cast(str, data.get('lifecycle', 'existingOnly'))
    allowed = set(_cad_cast("Iterable[str]", data.get('allowedProjectIds', [project_id])))
    max_files = _cad_cast(int, data.get('maxFiles', 100))
    if app.userInterface.activeCommand not in ('', 'SelectCommand'):
        return {'schemaVersion': 1, 'root': _cad_cast("JsonValue", data['root']), 'documents': [], 'edges': [],
                'graphComplete': False, 'getterErrors': [], 'lifecycleEffects': [],
                'coverage': {'reachableDocuments': 0, 'reachableEdges': 0},
                'environment': {'fusionVersion': getattr(app, 'version', None), 'os': sys.platform},
                'blocked': 'interactiveCommandActive', 'activeCommand': app.userInterface.activeCommand}
    opened: list[_ReferencesDocument] = []
    by_identity: dict[tuple[str, int], JsonObject] = {}
    edges: list[_ReferencesEdge] = []
    getter_errors: list[JsonObject] = []
    lifecycle_effects: list[JsonObject] = []
    errors: list[JsonObject] = []
    graph_complete = True
    queue: list[tuple[str, str, int, _ReferencesDataFile | None]] = [(root_id, project_id, root_version, None)]
    while queue:
        file_id, owner_project, version, data_file_hint = queue.pop(0)
        key = (file_id, version)
        if key in by_identity:
            continue
        if len(by_identity) >= max_files:
            graph_complete = False
            errors.append({'fileId': file_id, 'status': 'notProcessed', 'reason': 'maxFiles'})
            continue
        candidates = _references_open_matches(app, file_id, owner_project, version)
        opened_by_request = False
        if len(candidates) > 1:
            graph_complete = False
            stub = _cad_cast("JsonObject", {'fileId': file_id, 'projectId': owner_project, 'version': version,
                    'latestVersion': None, 'available': False, 'blockedReason': 'duplicateOpenEditor'})
            by_identity[key] = stub
            errors.append({'fileId': file_id, 'status': 'ambiguous', 'candidates': [d.creationId for d in candidates]})
            continue
        if candidates:
            doc = candidates[0]
        elif lifecycle == 'openOwned':
            try:
                file = _references_target_file(app, owner_project, file_id, version, data_file_hint)
                if file.id != file_id or int(file.versionNumber) != version or file.parentProject.id != owner_project:
                    raise ValueError('exact pinned DataFile version identity mismatch; latest/name fallback refused')
                if file.isReadOnly is not False:
                    raise ValueError('DataFile is uneditable')
                doc = _cad_require_result(app.documents.open(file, True), 'Open exact pinned owned document')
                opened.append(doc); opened_by_request = True
                if _cad_cast("_ReferencesDataFile", doc.dataFile).id != file_id or _cad_cast("_ReferencesDataFile", doc.dataFile).versionNumber != version or _cad_cast("_ReferencesDataFile", doc.dataFile).parentProject.id != owner_project:
                    raise ValueError('opened document identity/version differs from pinned DataFile')
                # A DataFile enumerated from a closed project folder may report
                # incomplete until Fusion resolves it into a document. Trust
                # only the exact opened document's cloud state, never its name.
                if _cad_cast("_ReferencesDataFile", doc.dataFile).isComplete is not True or _cad_cast("_ReferencesDataFile", doc.dataFile).isReadOnly is not False:
                    raise ValueError('Opened pinned document is incomplete or uneditable')
                lifecycle_effects.append({'fileId': file_id, 'effect': 'opened', 'creationId': doc.creationId,
                                          'version': version, 'owned': True})
            except Exception as exc:
                graph_complete = False
                by_identity[key] = {'fileId': file_id, 'projectId': owner_project, 'version': version,
                    'latestVersion': None, 'available': False, 'blockedReason': 'exactOpenUnavailable',
                    'openError': type(exc).__name__ + ': ' + str(exc)}
                errors.append({'fileId': file_id, 'status': 'unavailable', 'message': str(exc)})
                continue
        else:
            graph_complete = False
            try:
                # Existing-only reports the current project DataFile's latest
                # independently of a possibly stale reference DataFile hint.
                file = _references_project_file(app, owner_project, file_id)
                latest_version = int(file.latestVersionNumber)
            except Exception as exc:
                latest_version = None
                errors.append({'fileId': file_id, 'status': 'unresolved', 'message': type(exc).__name__ + ': ' + str(exc)})
            by_identity[key] = {'fileId': file_id, 'projectId': owner_project, 'version': version,
                'latestVersion': latest_version, 'available': False, 'blockedReason': 'notOpen'}
            continue
        try:
            # CadContext resolves only one exact top-level editor in this
            # project and reasserts the cloud identity before SDK observation.
            ctx = CadContext(doc.name, project_id=owner_project, doc_id=doc.creationId,
                             doc_file_id=file_id, resolved_doc=_cad_cast("adsk.core.Document", _cad_cast(object, doc)))
            if _cad_cast("_ReferencesDataFile", ctx.doc.dataFile).versionNumber != version:
                raise ValueError('opened revision changed during graph scan')
            observed = _references_doc_snapshot(ctx, allowed, {item.creationId for item in opened},
                                                _cad_cast("Mapping[str, JsonValue]", data.get('callerNamespaces', {})))
            row = observed['document']
            row['openedByRequest'] = opened_by_request
            row['version'] = version
            row['reachable'] = True
            row['key'] = _cad_cast("JsonValue", key)
            by_identity[key] = row
            edges.extend(observed['edges'])
            for edge in observed['edges']:
                if edge['selfReference']:
                    continue
                if not edge['scopeProjectAllowed']:
                    continue
                if not edge['sourceProjectId'] or edge['sourceFileId'] == file_id:
                    continue
                if edge['baselineVersion'] is None:
                    getter_errors.append({'edgeId': _cad_cast("JsonValue", edge['edgeId']),
                                          'sourceFileId': _cad_cast("JsonValue", edge['sourceFileId']),
                                          'error': _cad_cast("JsonValue", edge['getterError'])})
                    # The edge is retained as unresolved; no guessed latest traversal.
                    continue
                pin = next((row for row in _cad_cast("list[JsonObject]", data.get('pins', []))
                            if row['edgeId'] == _cad_cast(str, edge['edgeId'])), None)
                if pin:
                    target_version = _cad_cast(int, pin['version'])
                elif data.get('policy', 'preserve') == 'latest' and edge['latestVersion'] is not None:
                    target_version = _cad_cast(int, edge['latestVersion'])
                else:
                    target_version = _cad_cast(int, edge['baselineVersion'])
                # The edge's embedded DataFile may be an older cached object.
                # Preserve its version as the baseline, but acquire the exact
                # independently selected target version during traversal.
                source_file = _cad_cast("_ReferencesDataFile | None", edge.get('_sourceDataFile'))
                target_key = (_cad_cast(str, edge['sourceFileId']), target_version)
                if target_key not in by_identity and not any(item[0] == target_key[0] and item[2] == target_key[1] for item in queue):
                    queue.append((_cad_cast(str, edge['sourceFileId']), _cad_cast(str, edge['sourceProjectId']), target_version, source_file))
        except Exception as exc:
            graph_complete = False
            by_identity[key] = {'fileId': file_id, 'projectId': owner_project, 'version': version,
                'latestVersion': None, 'available': False, 'openedByRequest': opened_by_request,
                'blockedReason': 'auditFailed', 'auditError': type(exc).__name__ + ': ' + str(exc)}
            errors.append({'fileId': file_id, 'status': 'failed', 'message': type(exc).__name__ + ': ' + str(exc)})
    # Collapse document versions to a single row only when unambiguous. Multiple
    # deliberate versions stay in edges and cause the planner to block mass update.
    docs_by_id: dict[str, JsonObject] = {}
    for (file_id, version), row in by_identity.items():
        current = docs_by_id.get(file_id)
        if current is None:
            docs_by_id[file_id] = row
        elif current.get('version') != version:
            current['versionConflict'] = sorted({_cad_cast(int, current.get('version')), version})
            current['available'] = False
            current['blockedReason'] = 'multiplePinnedVersions'
            graph_complete = False
    if opened:
        for doc in reversed(opened):
            file_id = None
            creation_id = None
            try:
                file_id = _cad_cast("_ReferencesDataFile", doc.dataFile).id
                creation_id = doc.creationId
                valid = bool(doc.isValid)
                modified = bool(doc.isModified) if valid else False
                if valid and modified is False:
                    doc.close(False)
                    lifecycle_effects.append({'fileId': file_id, 'effect': 'closed',
                                              'creationId': creation_id, 'owned': True})
                elif valid:
                    lifecycle_effects.append({'fileId': file_id, 'effect': 'retainedDirty',
                                              'creationId': creation_id, 'owned': True})
                    if file_id in docs_by_id:
                        docs_by_id[file_id]['modified'] = True
                        docs_by_id[file_id]['available'] = False
                    graph_complete = False
            except Exception as exc:
                lifecycle_effects.append({'fileId': file_id,
                    'effect': 'closeFailed', 'error': type(exc).__name__ + ': ' + str(exc)})
                graph_complete = False
    public_edges = _cad_cast("list[JsonValue]", _references_public_edges(edges))
    return {'schemaVersion': 1, 'root': _cad_cast("JsonValue", data['root']), 'documents': list(docs_by_id.values()),
            'edges': public_edges, 'graphComplete': graph_complete, 'getterErrors': getter_errors,
            'lifecycleEffects': lifecycle_effects,
            'coverage': {'reachableDocuments': len(docs_by_id), 'reachableEdges': len(edges),
                         'availableDocuments': sum(row.get('available') is True for row in docs_by_id.values()),
                         'unavailableDocuments': sum(row.get('available') is not True for row in docs_by_id.values()),
                         'independentErrors': errors},
             'environment': {'fusionVersion': getattr(app, 'version', None), 'os': sys.platform,
                            'backend': 'selected fmcad backend', 'locale': None, 'adapterQualification': None}}


def _references_current_edges(ctx: "CadContext", allowed_project_ids: "set[str] | None" = None) -> "list[_ReferencesEdge]":
    # sourceDesign can load a cold Derive's document reference lazily. Use the
    # same observation order as graph capture, or preflight sees a false drift.
    inventory=_references_forward_inventory(ctx)
    derives = _references_owned_derives(ctx, allowed_project_ids, inventory)
    return _references_linked_edges(ctx, allowed_project_ids, inventory) + derives


def _references_feature_health(ctx: "CadContext") -> "JsonObject":
    result = _cad_cast("JsonObject", ctx.call('history.check', {}))
    return {'healthy': result.get('healthy') is True and result.get('status') == 'pass',
            'status': result.get('status'), 'coverage': result.get('coverage'),
            'timeline': result.get('timeline', []), 'repairRequired': result.get('healthy') is not True}


def _references_binding_checks(ctx: "CadContext", edge_id: str, bindings: "Sequence[_ReferencesBinding]",
                               expected_source_parameters: "Mapping[str, list[JsonObject]] | None" = None,
                               allowed_project_ids: "set[str] | None" = None) -> "JsonObject":
    selected = [binding for binding in bindings if binding['edgeId'] == edge_id]
    if not selected:
        return {'status': 'unverified', 'passed': False, 'bindings': [],
                'reason': 'explicit sourceParameter-to-consumerAlias/nativeDerivedParameter mapping required'}
    edges = _references_owned_derives(ctx, allowed_project_ids)
    edge = next((item for item in edges if _cad_cast(str, item['edgeId']) == edge_id), None)
    if edge is None:
        return {'status': 'unresolved', 'passed': False, 'bindings': [], 'reason': 'derive edge not present in owned unsuppressed history'}
    results: list[JsonObject]
    results = []
    for binding in selected:
        source = [row for row in _cad_cast("list[JsonObject]", edge['sourceParameters']) if row['name'] == binding['sourceParameter']]
        if len(source) != 1:
            results.append({'sourceParameter': binding['sourceParameter'], 'status': 'unresolved',
                            'reason': 'source parameter is missing or ambiguous'})
            continue
        independent = [row for row in (expected_source_parameters or {}).get(_cad_cast(str, edge['sourceFileId']), [])
                       if row.get('name') == binding['sourceParameter']]
        if len(independent) != 1:
            results.append({'edgeId': edge_id, 'sourceParameter': binding['sourceParameter'],
                            'status': 'unresolved', 'reason': 'independent saved source parameter is unavailable'})
            continue
        target_name = binding.get('nativeDerivedParameter')
        if not target_name and binding.get('consumerAlias'):
            alias_rows = [parameter for parameter in _references_items(_cad_cast("_ReferencesDesign", ctx.design).allParameters)
                          if parameter.name == _cad_cast("_ReferencesBindingWithAlias", binding)['consumerAlias']]
            if len(alias_rows) == 1:
                alias = alias_rows[0]
                dependencies = None
                try: dependencies = [str(parameter.name) for parameter in _references_items(alias.dependencyParameters)]
                except Exception: pass
                candidates = [row['name'] for row in _cad_cast("list[JsonObject]", edge['derivedParameters'])
                              if alias.expression == row['name'] or dependencies is not None and row['name'] in dependencies]
                if len(candidates) == 1:
                    target_name = candidates[0]
        target = [row for row in _cad_cast("list[JsonObject]", edge['derivedParameters']) if row['name'] == target_name] if target_name else []
        if target_name and len(target) != 1:
            results.append({'sourceParameter': binding['sourceParameter'], 'nativeDerivedParameter': target_name,
                            'status': 'unresolved', 'reason': 'exact native DerivedParameter name is missing or ambiguous'})
            continue
        source_row = source[0]
        target_row = target[0] if target else None
        value_matches = bool(target_row and _cad_cast(str, source_row['internal_unit']) != 'text' and
            source_row['internal_unit'] == target_row['internal_unit'] == _cad_cast(str, independent[0].get('internal_unit')) and
            abs(_cad_cast(float, source_row['internal_value']) - _cad_cast(float, target_row['internal_value'])) <=
            1e-9 * max(1.0, abs(_cad_cast(float, source_row['internal_value']))) and
            abs(_cad_cast(float, independent[0]['internal_value']) - _cad_cast(float, target_row['internal_value'])) <=
            1e-9 * max(1.0, abs(_cad_cast(float, independent[0]['internal_value']))))
        alias_status = 'notRequested'
        if binding.get('consumerAlias'):
            aliases = [parameter for parameter in _references_items(_cad_cast("_ReferencesDesign", ctx.design).allParameters)
                       if parameter.name == _cad_cast("_ReferencesBindingWithAlias", binding)['consumerAlias']]
            if len(aliases) != 1:
                alias_status = 'unresolved'
            else:
                alias = aliases[0]
                expression = str(alias.expression)
                dependencies = None
                try:
                    dependencies = [parameter.name for parameter in _references_items(alias.dependencyParameters)]
                except Exception:
                    pass
                alias_status = 'verified' if target_name and (expression == target_name or
                    dependencies is not None and target_name in dependencies) else 'unresolved'
        results.append({'edgeId': edge_id, 'sourceParameter': binding['sourceParameter'],
            'source': source_row, 'independentSource': independent[0],
            'nativeDerivedParameter': target_row, 'consumerAlias': binding.get('consumerAlias'),
            'aliasStatus': alias_status, 'valueMatches': value_matches,
            'status': 'verified' if value_matches and alias_status in ('verified', 'notRequested') else 'unresolved'})
    return {'status': 'verified' if results and all(row['status'] == 'verified' for row in results) else 'unresolved',
            'passed': bool(results) and all(row['status'] == 'verified' for row in results), 'bindings': results}


def _references_preflight(ctx: "CadContext", data: "_ReferencesInput") -> "JsonObject":
    doc = _cad_cast("_ReferencesDocument", ctx.doc)
    file = doc.dataFile
    design = _cad_cast("_ReferencesDesign", ctx.design)
    allowed_project_ids = set(_cad_cast("Iterable[str]", data.get('allowedProjectIds') or [_cad_cast(str, data['projectId'])]))
    if doc.isValid is not True or file is None or file.id != data['fileId'] or file.parentProject.id != data['projectId']:
        return {'status': 'blocked', 'reason': 'identityMismatch'}
    current = _references_document_identity(doc)
    health = _references_feature_health(ctx)
    metadata = _references_metadata(design, _cad_cast("_ReferencesComponent", ctx.root))
    current.update(timelineAtEnd=design.timeline.markerPosition == design.timeline.count,
        pendingSnapshot=bool(design.snapshots.hasPendingSnapshot), health=health,
        metadataCoverage=metadata['metadataCoverage'], metadataComplete=metadata['metadataComplete'],
        consumedBodiesVerified=metadata['consumedBodiesVerified'], parameters=_references_parameters(design))
    return {'status': 'complete', 'document': current,
            'edges': _cad_cast("list[JsonValue]", _references_public_edges(_references_current_edges(ctx, allowed_project_ids))),
            'metadata': metadata, 'lifecycleEffects': []}


def _references_update(ctx: "CadContext", data: "_ReferencesInput") -> "JsonObject":
    if data.get('confirm') is not True:
        raise ValueError('references.refresh apply update step requires the immutable-plan confirmation')
    preflight = _references_preflight(ctx, {'fileId': _cad_cast(str, data['fileId']), 'projectId': _cad_cast(str, data['projectId']),
                                            'allowedProjectIds': data.get('allowedProjectIds')})
    if preflight['status'] != 'complete': return preflight
    before = preflight
    edge_state_ok, edge_state_reason = _references_edge_snapshot_matches(
        _cad_cast("list[JsonObject]", before['edges']), _cad_cast("list[JsonObject]", data['planEdges']),
        _cad_cast(str, data['fileId']), _cad_cast("Mapping[str, JsonValue] | None", data.get('effectiveTargets')))
    if not edge_state_ok:
        return {'status': 'blocked', 'reason': edge_state_reason, 'before': before}
    if (_cad_cast("JsonObject", before['document'])['modified'] or _cad_cast("JsonObject", before['document'])['readOnly'] or
            not _cad_cast("JsonObject", before['document'])['isComplete'] or
            not _cad_cast("JsonObject", before['document'])['timelineAtEnd'] or
            _cad_cast("JsonObject", before['document'])['pendingSnapshot'] or
            not _cad_cast("JsonObject", _cad_cast("JsonObject", before['document'])['health'])['healthy']):
        return {'status': 'blocked', 'reason': 'preconditionsChanged', 'before': before}
    edge_ids = set(_cad_cast("Iterable[str]", data['edgeIds']))
    current_edges = _cad_cast("list[JsonObject]", before['edges'])
    selected = [edge for edge in current_edges if _cad_cast(str, edge['edgeId']) in edge_ids]
    if len(selected) != len(edge_ids) or any(_cad_cast(str, edge['kind']) not in ('linked', 'derive') or edge['selfReference'] for edge in selected):
        return {'status': 'blocked', 'reason': 'plannedForwardEdgeMissingOrUnsupported', 'before': before}
    old_parameters = _references_user_parameter_state(_cad_cast("_ReferencesDesign", ctx.design),
        _cad_cast("list[_ReferencesBinding]", data.get('parameterBindings', [])))
    before_metadata = _cad_cast("JsonObject", before.get('metadata', {}))
    requested_method = _cad_cast(str, data['method'])
    try:
        if requested_method == 'DocumentReference.getLatestVersion':
            for edge in selected:
                if _cad_cast(str, edge['kind']) != 'linked':
                    return {'status': 'blocked', 'reason': 'edgeScopedMethodDoesNotSupportDerive'}
                target_version = _cad_cast("Mapping[str, JsonValue]", data.get('effectiveTargets', {})).get(
                    _cad_cast(str, edge['edgeId']),
                    next((row.get('targetVersion') for row in _cad_cast("list[JsonObject]", data['planEdges'])
                          if row['edgeId'] == edge['edgeId']), None))
                if target_version is not None and edge.get('baselineVersion') == target_version:
                    continue
                ref = _references_find_live_linked(_cad_cast("_ReferencesDocument", ctx.doc), _cad_cast(str, edge['edgeId']))
                if not ref:
                    return {'status': 'blocked', 'reason': 'edgeIdentityChanged'}
                if ref.getLatestVersion() is not True:
                    return {'status': 'unknown', 'outcome': 'unknown', 'reason': 'getLatestVersion returned false', 'before': before}
        elif requested_method == 'document.updateAllReferences':
            if _cad_cast("_ReferencesDesign", ctx.design).timeline.markerPosition != _cad_cast("_ReferencesDesign", ctx.design).timeline.count or _cad_cast("_ReferencesDesign", ctx.design).snapshots.hasPendingSnapshot:
                return {'status': 'blocked', 'reason': 'historyOrPendingSnapshotChanged'}
            if _cad_cast("_ReferencesDocument", ctx.doc).updateAllReferences() is not True:
                return {'status': 'unknown', 'outcome': 'unknown', 'reason': 'updateAllReferences did not return true', 'before': before}
        else:
            return {'status': 'blocked', 'reason': 'unsupportedPlannedMethod'}
    except Exception as exc:
        return {'status': 'unknown', 'outcome': 'unknown', 'reason': type(exc).__name__ + ': ' + str(exc), 'before': before}
    try:
        if _cad_cast("_ReferencesDesign", ctx.design).computeAll() is not True:
            return {'status': 'unknown', 'outcome': 'unknown', 'reason': 'computeAll returned false after reference update', 'before': before}
    except Exception as exc:
        return {'status': 'unknown', 'outcome': 'unknown', 'reason': 'computeAll: ' + type(exc).__name__ + ': ' + str(exc), 'before': before}
    after = _references_preflight(ctx, {'fileId': _cad_cast(str, data['fileId']), 'projectId': _cad_cast(str, data['projectId']),
                                        'allowedProjectIds': data.get('allowedProjectIds')})
    selected_after = [edge for edge in _cad_cast("list[JsonObject]", after.get('edges', []))
                      if _cad_cast(str, edge['edgeId']) in edge_ids]
    required = {_cad_cast(str, edge['edgeId']):
                _cad_cast("Mapping[str, JsonValue]", data.get('effectiveTargets', {})).get(
                    _cad_cast(str, edge['edgeId']), edge.get('targetVersion'))
                for edge in _cad_cast("list[JsonObject]", data['planEdges'])
                if _cad_cast(str, edge['edgeId']) in edge_ids}
    edge_current = len(selected_after) == len(edge_ids) and all(
        required.get(_cad_cast(str, edge['edgeId'])) == edge.get('baselineVersion') for edge in selected_after)
    requested_bindings = [binding for binding in _cad_cast("list[_ReferencesBinding]", data.get('parameterBindings', [])) if binding['edgeId'] in edge_ids]
    expected_source_parameters = data.get('expectedSourceParameters', {})
    if requested_bindings:
        binding_results = [_references_binding_checks(ctx, _cad_cast(str, edge['edgeId']), requested_bindings,
            _cad_cast("Mapping[str, list[JsonObject]]", expected_source_parameters),
            _cad_cast("set[str] | None", data.get('allowedProjectIds')))
                            for edge in selected_after if edge['kind'] == 'derive']
        bindings_pass = bool(binding_results) and all(row['passed'] for row in binding_results)
    else:
        bindings_pass = not any(edge['kind'] == 'derive' and edge['derivedParameters'] for edge in selected_after)
        binding_results = []
    history = _cad_cast("JsonObject", _cad_cast("JsonObject", after.get('document', {})).get('health', {}))
    unchanged_local_parameters = old_parameters == _references_user_parameter_state(
        _cad_cast("_ReferencesDesign", ctx.design), _cad_cast("list[_ReferencesBinding]", data.get('parameterBindings', [])))
    after_metadata = _cad_cast("JsonObject", after.get('metadata', {}))
    attrs_before = sorted(_cad_cast("list[JsonObject]", before_metadata.get('attributes', [])), key=lambda row: (row.get('kind',''), str(row.get('namespace')), row.get('group',''), row.get('name','')))
    attrs_after = sorted(_cad_cast("list[JsonObject]", after_metadata.get('attributes', [])), key=lambda row: (row.get('kind',''), str(row.get('namespace')), row.get('group',''), row.get('name','')))
    occurrence_before = _references_occurrence_states(before_metadata)
    occurrence_after = _references_occurrence_states(after_metadata)
    metadata_preserved = attrs_before == attrs_after and occurrence_before is not None and occurrence_before == occurrence_after
    scope_pass = all(_cad_cast(str, edge['edgeId']) in edge_ids or edge.get('baselineVersion') == next(
        (before_edge['baselineVersion'] for before_edge in _cad_cast("list[JsonObject]", before['edges'])
         if _cad_cast(str, before_edge['edgeId']) == _cad_cast(str, edge['edgeId'])), None)
        for edge in _cad_cast("list[JsonObject]", after.get('edges', [])))
    checks: JsonObject = {'intendedReferencesCurrent': edge_current, 'bindingsPass': bindings_pass,
              'healthPass': history.get('healthy') is True, 'scopePass': scope_pass,
              'localParametersPreserved': unchanged_local_parameters,
              'metadataPreserved': metadata_preserved,
              'consumedBodiesVerified': after_metadata.get('consumedBodiesVerified') is True,
              'getterState': 'unresolved' if any(edge.get('versionSource') == 'unresolved' for edge in selected_after) else
                'diagnostic' if any(edge.get('getterError') for edge in selected_after) else 'resolved',
              'bindingResults': binding_results, 'health': history,
              'metadataCoverage': _cad_cast("JsonObject", after.get('document', {})).get('metadataCoverage'),
              'metadataPass': _cad_cast("JsonObject", after.get('document', {})).get('metadataComplete') is True and metadata_preserved,
              'physicalResponse': {'before': [row['volumeInternal'] for row in _cad_cast("list[JsonObject]", _cad_cast("JsonObject", before.get('metadata', {})).get('bodies', []))],
                                   'after': [row['volumeInternal'] for row in _cad_cast("list[JsonObject]", _cad_cast("JsonObject", after.get('metadata', {})).get('bodies', []))],
                                   'measured': True, 'acceptance': 'caller binding/physical fixture required'}}
    if checks['getterState'] == 'unresolved':
        status, outcome = 'unknown', 'unknown'
    elif not edge_current and scope_pass and checks['healthPass'] and unchanged_local_parameters:
        status, outcome = 'knownStale', 'settled'
    elif edge_current and bindings_pass and checks['healthPass'] and scope_pass and unchanged_local_parameters and metadata_preserved:
        status, outcome = 'complete', 'settled'
    else:
        status, outcome = 'failed', 'settled'
    return {'status': status, 'outcome': outcome, 'modified': bool(ctx.doc.isModified),
            'checks': checks, 'before': before, 'after': after}


def _references_parameters(design: "_ReferencesDesign") -> "list[JsonObject]":
    rows: list[JsonObject] = []
    for parameter in _references_items(design.allParameters):
        try: rows.append(_references_parameter_value(parameter, design.unitsManager))
        except Exception: rows.append({'name': _cad_cast("str | None", getattr(parameter, 'name', None)), 'status': 'unknown'})
    return rows


def _references_user_parameter_state(design: "_ReferencesDesign",
                                     bindings: "Sequence[_ReferencesBinding]" = ()) -> "list[JsonObject]":
    aliases = {row.get('consumerAlias') for row in bindings if row.get('consumerAlias')}
    rows: list[JsonObject] = []
    for parameter in _references_items(design.userParameters):
        value = _references_parameter_value(parameter, design.unitsManager)
        rows.append({'name': value['name'], 'expression': value['expression'],
                     'display_unit': value['display_unit'], 'comment': str(getattr(parameter, 'comment', '')),
                     'isFavorite': value['isFavorite'],
                     'display_value': None if value['name'] in aliases else value['display_value'],
                     'internal_value': None if value['name'] in aliases else value['internal_value'],
                     'internal_unit': value['internal_unit']})
    return sorted(rows, key=lambda row: _cad_cast(str, row['name']))


def _references_find_live_linked(doc: "_ReferencesDocument", edge_id: str) -> "_ReferencesDocumentReference | None":
    matches: list[_ReferencesDocumentReference] = []
    for ref in _references_items(doc.documentReferences):
        source_file = ref.dataFile
        token = _cad_cast("str | None", _cad_cast(object, getattr(ref, 'entityToken', None)))
        occurrence = _cad_cast("_ReferencesOccurrence | None", _cad_cast(object, getattr(ref, 'occurrence', None)))
        identity_part = token or (_cad_cast("str | None", _cad_cast(object, getattr(occurrence, 'entityToken', None))) if occurrence else None) or source_file.id
        if _references_edge_id(_cad_cast("_ReferencesDataFile", doc.dataFile).id, 'linked', source_file.id, identity_part) == edge_id:
            matches.append(ref)
    return matches[0] if len(matches) == 1 else None


def _references_step_context(data: "_ReferencesInput", action: str) -> "tuple[CadContext | None, JsonObject]":
    app = _cad_cast("_ReferencesApplication", adsk.core.Application.get())
    file_id, project_id, version = (_cad_cast(str, data['fileId']), _cad_cast(str, data['projectId']), _cad_cast(int, data['version']))
    lifecycle = _cad_cast(str, data.get('lifecycle', 'existingOnly'))
    matches = _references_open_matches(app, file_id, project_id, version)
    if len(matches) > 1:
        return None, {'status': 'blocked', 'reason': 'ambiguousOpenDocument',
                      'candidates': [_references_document_identity(doc) for doc in matches]}
    opened_by_request = False
    if matches:
        doc = _cad_cast("adsk.core.Document", _cad_cast(object, matches[0]))
        if data.get('ownedCreationId') and doc.creationId != data['ownedCreationId']:
            return None, {'status': 'blocked', 'reason': 'ownedEditorIdentityChanged',
                          'identity': _references_document_identity(doc)}
        # ownedCreationId pins the exact editor across steps; it does not claim
        # that a pre-existing editor was opened by this request.
        opened_by_request = data.get('openedByRequest') is True
    elif lifecycle == 'openOwned':
        opened: list[_ReferencesDocument]
        opened = []
        doc, effect = _cad_cast("tuple[adsk.core.Document | None, JsonObject]",
            _references_open_file(app, project_id, file_id, version, lifecycle, opened))
        if doc is None:
            return None, effect
        opened_by_request = effect.get('openedByRequest') is True
    else:
        return None, {'status': 'blocked', 'reason': 'notOpenExistingOnly'}
    identity = _references_document_identity(_cad_cast("_ReferencesDocument", doc))
    if identity['fileId'] != file_id or identity['projectId'] != project_id or identity['version'] != version:
        return None, {'status': 'blocked', 'reason': 'identityMismatch', 'identity': identity}
    try:
        ctx = CadContext(doc.name, project_id=project_id, doc_id=doc.creationId,
                         doc_file_id=file_id, resolved_doc=doc)
    except Exception as exc:
        return None, {'status': 'blocked', 'reason': 'documentContextUnavailable',
                      'identity': identity, 'error': type(exc).__name__ + ': ' + str(exc)}
    if action in ('sdkUpdate', 'nativeUpdate', 'save', 'coldVerify'):
        if app.userInterface.activeCommand not in ('', 'SelectCommand'):
            return None, {'status': 'blocked', 'reason': 'interactiveCommandActive',
                          'activeCommand': app.userInterface.activeCommand, 'identity': identity}
        if app.activeDocument != doc and (doc.activate() is not True or app.activeDocument != doc):
            return None, {'status': 'blocked', 'reason': 'activationFailed', 'identity': identity}
    return ctx, {'status': 'resolved', 'identity': identity, 'openedByRequest': opened_by_request,
                 'active': app.activeDocument == doc}


def _references_native_update(ctx: "CadContext", data: "_ReferencesInput") -> "JsonObject":
    # This is a best-effort scheduling deadline for the entire SDK operation,
    # not a hard timeout: synchronous Fusion calls may overrun it. Start it
    # before identity, health, graph and command preflight so those costs reduce
    # the poll window instead of extending the RPC past Node's allocated time.
    operation_started = time.monotonic()
    time_budget_ms = float(_cad_cast(float, data.get('timeBudgetMs', 180000)))
    operation_deadline = operation_started + time_budget_ms / 1000.0
    poll_deadline = operation_deadline - _REFERENCES_NATIVE_REPORT_RESERVE_MS / 1000.0
    if data.get('confirm') is not True or data.get('command') != 'UpdateAllLatestCmd':
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                'reason': 'nativeUpdateRequiresPlannedCommandAndConfirmation'}
    doc, app = ctx.doc, ctx.app
    update: JsonObject
    update = _cad_cast("JsonObject", data.get('update')) if isinstance(data.get('update'), dict) else {}
    planned_method = data.get('plannedMethod')
    direct_native = (data.get('nativeRoute') == 'directPlanned' and
                     planned_method == 'UpdateAllLatestCmd' and data.get('method') == planned_method and
                     update.get('method') == planned_method and data.get('nativeFallback') == 'qualifiedOnce' and
                     'priorSdkResult' not in data)
    sdk_fallback = (data.get('nativeRoute') == 'sdkFallback' and
                    planned_method == 'document.updateAllReferences' and data.get('method') == planned_method and
                    update.get('method') == planned_method and update.get('fallback') == 'UpdateAllLatestCmd' and
                    data.get('nativeFallback') == 'qualifiedOnce')
    if not direct_native and not sdk_fallback:
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                'reason': 'nativeUpdateRouteDoesNotMatchImmutablePlan'}
    sdk_result: JsonObject | None
    sdk_result = _cad_cast("JsonObject", data.get('priorSdkResult')) if sdk_fallback else None
    if sdk_fallback and (not isinstance(sdk_result, dict) or
                         sdk_result.get('status') != 'knownStale'):
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                'reason': 'nativeFallbackRequiresKnownSettledSdkStaleResult'}
    dirty_state_changed = (doc.isModified is not False if direct_native else
        bool(doc.isModified) != (_cad_cast("JsonObject", sdk_result).get('modified') is True))
    if _cad_cast("_ReferencesDataFile", doc.dataFile).id != _cad_cast(str, data['fileId']) or _cad_cast("_ReferencesDataFile", doc.dataFile).versionNumber != _cad_cast(int, data['version']) or dirty_state_changed:
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                'reason': 'identityVersionOrDirtyStateChanged'}
    if _cad_cast("_ReferencesDesign", ctx.design).timeline.markerPosition != _cad_cast("_ReferencesDesign", ctx.design).timeline.count or _cad_cast("_ReferencesDesign", ctx.design).snapshots.hasPendingSnapshot:
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                'reason': 'historyOrPendingSnapshotChanged'}
    if not _references_feature_health(ctx)['healthy']:
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True, 'reason': 'repairRequired'}
    try:
        if app.userInterface.activeSelections.count != 0:
            return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                    'reason': 'nativeUpdateRequiresNoPreexistingSelections'}
    except Exception:
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True, 'reason': 'selectionStateUnavailable'}
    before = _references_preflight(ctx, {'fileId': data['fileId'], 'projectId': data['projectId'],
                                         'allowedProjectIds': data.get('allowedProjectIds')})
    prior_after = _cad_cast("list[JsonObject]", _cad_cast("JsonObject",
        _cad_cast("JsonObject", sdk_result).get('after', {})).get('edges', [])) if sdk_fallback else None
    edge_state_ok, edge_state_reason = _references_edge_snapshot_matches(
        _cad_cast("list[JsonObject]", before['edges']), _cad_cast("list[JsonObject]", data['planEdges']),
        _cad_cast(str, data['fileId']), _cad_cast("Mapping[str, JsonValue]", data.get('effectiveTargets')),
        prior_edges=prior_after)
    if not edge_state_ok:
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                'reason': 'sdkPostcheckReceiptDoesNotMatchCurrentDocument',
                'edgeStateReason': edge_state_reason}
    if sdk_fallback:
        sdk_after = {_cad_cast(str, edge['edgeId']): edge for edge in _cad_cast("list[JsonObject]",
            _cad_cast("JsonObject", _cad_cast("JsonObject", sdk_result).get('after', {})).get('edges', []))}
        if not sdk_after or any(_cad_cast(str, edge['edgeId']) not in sdk_after or
                edge['sourceFileId'] != sdk_after[_cad_cast(str, edge['edgeId'])]['sourceFileId'] or
                edge['baselineVersion'] != sdk_after[_cad_cast(str, edge['edgeId'])]['baselineVersion']
                for edge in _cad_cast("list[JsonObject]", before['edges'])):
            return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                    'reason': 'sdkPostcheckReceiptDoesNotMatchCurrentDocument'}
    if any(edge['selfReference'] for edge in _cad_cast("list[JsonObject]", before['edges'])):
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                'reason': 'UpdateAllLatestCmdCouldAdvanceHistoricalSelfReference'}
    plan_edges = {_cad_cast(str, edge['edgeId']): edge for edge in _cad_cast("list[JsonObject]", data['planEdges']) if edge['ownerFileId'] == data['fileId']}
    targets = _cad_cast("JsonObject", data.get('effectiveTargets', {}))
    if any(_cad_cast(str, edge['edgeId']) not in plan_edges or
           targets.get(_cad_cast(str, edge['edgeId']), plan_edges[_cad_cast(str, edge['edgeId'])].get('targetVersion')) != edge.get('latestVersion')
           for edge in _cad_cast("list[JsonObject]", before['edges']) if not edge['selfReference']):
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                'reason': 'UpdateAllLatestCmdCouldAdvanceUnplannedOrPinnedReference'}
    before_parameters = _references_user_parameter_state(_cad_cast("_ReferencesDesign", ctx.design), _cad_cast("list[_ReferencesBinding]", data.get('parameterBindings', [])))
    before_metadata: JsonObject
    before_metadata = _cad_cast("JsonObject", before.get('metadata', {}))
    if direct_native:
        planned_edges = [edge for edge in _cad_cast("list[JsonObject]", data['planEdges'])
                         if edge.get('ownerFileId') == data['fileId'] and not edge.get('selfReference')]
        kinds = {_cad_cast(str, edge.get('kind')) for edge in planned_edges}
        derive_edges = [edge for edge in planned_edges if edge.get('kind') == 'derive']
        if not {'linked', 'derive'}.issubset(kinds) or not derive_edges or any(
                edge.get('explicitPin') is True or edge.get('scopeProjectAllowed') is not True or
                 _cad_cast("JsonObject", edge.get('bindingCoverage', {})).get('complete') is not True for edge in derive_edges):
            return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                    'reason': 'directNativePlanIsNotStructurallyQualifiedMixedParent'}
    required_before_submit_ms = _REFERENCES_NATIVE_REPORT_RESERVE_MS + _REFERENCES_NATIVE_MIN_POLL_MS
    if (operation_deadline - time.monotonic()) * 1000.0 < required_before_submit_ms:
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                'reason': 'nativeUpdateBudgetInsufficientBeforeCommand',
                'timeBudgetMs': time_budget_ms, 'requiredReserveMs': required_before_submit_ms,
                'before': before}
    command = _cad_cast("_ReferencesCommand | None",
        _cad_cast(object, app.userInterface.commandDefinitions.itemById('UpdateAllLatestCmd')))
    if command is None or not command.isValid or not command.isNative:
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                'reason': 'qualifiedNativeCommandUnavailable'}
    try:
        submitted = command.execute()
    except Exception as exc:
        return {'status': 'unknown', 'outcome': 'unknown', 'actionSubmitted': None,
                'reason': 'UpdateAllLatestCmd execute: ' + type(exc).__name__ + ': ' + str(exc), 'before': before}
    if submitted is not True:
        return {'status': 'blocked', 'actionSubmitted': False, 'reason': 'nativeCommandNotSubmitted', 'before': before}
    # The Node owner has armed the shipped .11 watcher before this single SDK
    # submission. Pump only Fusion's SDK main thread; never invoke UIA here.
    # Keep the post-poll reserve for one final readback and the semantic report.
    settled = False
    while time.monotonic() < poll_deadline:
        adsk.doEvents()
        try:
            if app.activeDocument == doc and app.userInterface.activeCommand in ('', 'SelectCommand') and doc.isUpToDate:
                settled = True
                break
        except Exception:
            pass
        time.sleep(.1)
    # One deliberate post-settlement recompute, never a repair/retry loop.
    # Node still requires the independent one-shot confirmation receipt before save.
    if settled:
        try:
            if _cad_cast("_ReferencesDesign", ctx.design).computeAll() is not True:
                return {'status': 'failed', 'outcome': 'settled', 'actionSubmitted': True,
                        'reason': 'computeFailedAfterNativeUpdate', 'modified': bool(doc.isModified)}
        except Exception as exc:
            return {'status': 'failed', 'outcome': 'settled', 'actionSubmitted': True,
                    'reason': 'computeFailedAfterNativeUpdate: ' + str(exc), 'modified': bool(doc.isModified)}
    # Always perform one final readback after polling, including when a
    # synchronous execute/doEvents/preflight call overran the scheduling
    # window. This is best effort and may itself overrun; it must not cause a
    # second command submission.
    try:
        after = _references_preflight(ctx, {'fileId': data['fileId'], 'projectId': data['projectId'],
                                            'allowedProjectIds': data.get('allowedProjectIds')})
    except Exception:
        after = None
    if after is None:
        return {'status': 'unknown', 'outcome': 'unknown', 'actionSubmitted': True,
                'reason': 'native command was submitted but reference readback is unavailable'}
    if app.userInterface.activeCommand not in ('', 'SelectCommand'):
        return {'status': 'unknown', 'outcome': 'unknown', 'actionSubmitted': True,
                'reason': 'native command did not reach a known settled idle state', 'after': after}
    current = {_cad_cast(str, edge['edgeId']): edge for edge in _cad_cast("list[JsonObject]", after['edges'])}
    targets = _cad_cast("JsonObject", data.get('effectiveTargets', {}))
    expected = {_cad_cast(str, edge['edgeId']): targets.get(_cad_cast(str, edge['edgeId']), edge.get('targetVersion'))
                for edge in _cad_cast("list[JsonObject]", data['planEdges'])
                if edge['ownerFileId'] == data['fileId'] and not edge['selfReference']}
    edges_current = all(current.get(edge_id) and current[edge_id].get('baselineVersion') == version
                        for edge_id, version in expected.items())
    bindings = [_cad_cast("_ReferencesBinding", binding) for binding in _cad_cast("list[JsonObject]", data.get('parameterBindings', [])) if binding['edgeId'] in expected]
    derived_ids = {_cad_cast(str, edge['edgeId']) for edge in _cad_cast("list[JsonObject]", data['planEdges'])
                   if edge['ownerFileId'] == data['fileId'] and edge['kind'] == 'derive'}
    binding_results = [_references_binding_checks(ctx, edge_id, bindings,
        _cad_cast("Mapping[str, list[JsonObject]]", data.get('expectedSourceParameters', {})),
        _cad_cast("set[str] | None", data.get('allowedProjectIds')))
                        for edge_id in derived_ids]
    bindings_pass = not derived_ids or bool(binding_results) and all(row['passed'] for row in binding_results)
    history = _cad_cast("JsonObject", _cad_cast("JsonObject", after.get('document', {})).get('health', {}))
    local_parameters_preserved = before_parameters == _references_user_parameter_state(
        _cad_cast("_ReferencesDesign", ctx.design), _cad_cast("list[_ReferencesBinding]", data.get('parameterBindings', [])))
    metadata: JsonObject
    metadata = _cad_cast("JsonObject", after.get('metadata', {}))
    before_attrs = sorted(_cad_cast("list[JsonObject]", before_metadata.get('attributes', [])), key=lambda row: (
        row.get('kind',''), str(row.get('namespace')), row.get('group',''), row.get('name','')))
    after_attrs = sorted(_cad_cast("list[JsonObject]", metadata.get('attributes', [])), key=lambda row: (
        row.get('kind',''), str(row.get('namespace')), row.get('group',''), row.get('name','')))
    before_occurrences = _references_occurrence_states(before_metadata)
    after_occurrences = _references_occurrence_states(metadata)
    metadata_preserved = (before_attrs == after_attrs and before_occurrences is not None and
                          before_occurrences == after_occurrences)
    checks: JsonObject = {'intendedReferencesCurrent': edges_current, 'bindingsPass': bindings_pass,
              'recomputed': settled,
              'healthPass': history.get('healthy') is True, 'scopePass': edges_current,
              'localParametersPreserved': local_parameters_preserved,
              'metadataPreserved': metadata_preserved,
              'consumedBodiesVerified': metadata.get('consumedBodiesVerified') is True,
              'getterState': 'diagnostic' if any(edge.get('getterError') for edge in current.values()) else 'resolved',
              'bindingResults': binding_results, 'health': history,
              'metadataCoverage': _cad_cast("JsonObject", after.get('document', {})).get('metadataCoverage'),
              'metadataPass': metadata.get('metadataComplete') is True and metadata_preserved}
    complete = settled and edges_current and bindings_pass and checks['healthPass'] and local_parameters_preserved and \
        metadata_preserved and checks['consumedBodiesVerified'] and checks['metadataPass']
    return {'status': 'complete' if complete else 'knownStale',
            'outcome': 'settled', 'actionSubmitted': True,
            'operationOutcome': 'pass' if complete else 'fail',
            'checks': checks,
            'before': before, 'after': after, 'modified': bool(doc.isModified),
            'command': 'UpdateAllLatestCmd'}


def _references_save(ctx: "CadContext", data: "_ReferencesInput") -> "JsonObject":
    if ctx.doc.dataFile.id != _cad_cast(str, data['fileId']) or ctx.doc.dataFile.parentProject.id != data['projectId']:
        return {'status': 'blocked', 'reason': 'identityMismatch'}
    if ctx.doc.dataFile.versionNumber != data['version'] or ctx.doc.dataFile.latestVersionNumber != data.get('latestVersion'):
        return {'status': 'blocked', 'reason': 'documentVersionDriftBeforeSave'}
    if ctx.app.userInterface.activeCommand not in ('', 'SelectCommand'):
        return {'status': 'blocked', 'reason': 'interactiveCommandActive', 'activeCommand': ctx.app.userInterface.activeCommand}
    if ctx.design.timeline.markerPosition != ctx.design.timeline.count or ctx.design.snapshots.hasPendingSnapshot:
        return {'status': 'blocked', 'reason': 'timelineOrPendingSnapshotChanged'}
    if not _references_feature_health(ctx)['healthy']:
        return {'status': 'failed', 'reason': 'repairRequiredBeforeSave'}
    plan_edges: list[JsonObject]
    plan_edges = _cad_cast("list[JsonObject]", data.get('planEdges', []))
    post_edges = data.get('postUpdateEdges')
    if not isinstance(post_edges, list):
        return {'status': 'blocked', 'reason': 'postUpdateReferenceReceiptUnavailable'}
    current_snapshot = _references_preflight(ctx, {'fileId': data['fileId'], 'projectId': data['projectId'],
                                                   'allowedProjectIds': data.get('allowedProjectIds')})
    edge_ok, edge_reason = _references_edge_snapshot_matches(
        _cad_cast("list[JsonObject]", current_snapshot['edges']), plan_edges, _cad_cast(str, data['fileId']),
        _cad_cast("Mapping[str, JsonValue] | None", data.get('effectiveTargets')),
        prior_edges=_cad_cast("list[JsonObject]", post_edges))
    if not edge_ok:
        return {'status': 'blocked', 'reason': edge_reason}
    required_checks: JsonObject
    required_checks = _cad_cast("JsonObject", data.get('checks', {}))
    if not all(required_checks.get(key) is True for key in
               ('bindingsPass', 'healthPass', 'scopePass', 'metadataPass', 'localParametersPreserved', 'consumedBodiesVerified')):
        return {'status': 'blocked', 'reason': 'postUpdateChecksNotPassed'}
    if ctx.doc.isModified is False:
        return {'status': 'complete', 'changed': False, 'resultingVersion': int(ctx.doc.dataFile.versionNumber),
                'cloudComplete': bool(ctx.doc.dataFile.isComplete), 'parameters': _references_parameters(_cad_cast("_ReferencesDesign", ctx.design)),
                'metadata': _references_metadata(_cad_cast("_ReferencesDesign", ctx.design), _cad_cast("_ReferencesComponent", ctx.root)), 'lifecycleEffects': []}
    if ctx.doc.dataFile.isReadOnly is not False:
        return {'status': 'blocked', 'reason': 'readOnly'}
    before = int(ctx.doc.dataFile.versionNumber)
    try:
        accepted = ctx.doc.save('Authorized references.refresh request ' + _cad_cast(str, data['requestId']))
    except Exception as exc:
        return {'status': 'unknown', 'outcome': 'unknown', 'reason': 'save call raised after entry: ' + type(exc).__name__ + ': ' + str(exc),
                'modified': bool(ctx.doc.isModified)}
    if accepted is not True:
        return {'status': 'failed', 'reason': 'saveNotAccepted', 'accepted': bool(accepted),
                'modified': bool(ctx.doc.isModified)}
    deadline = time.monotonic() + float(_cad_cast(float, data.get('timeBudgetMs', 180000))) / 1000.0
    try:
        while time.monotonic() < deadline:
            current = ctx.doc.dataFile
            if current.id != _cad_cast(str, data['fileId']) or current.parentProject.id != data['projectId']:
                return {'status': 'unknown', 'outcome': 'unknown', 'reason': 'save target identity changed'}
            try:
                if not current.isComplete:
                    _cad_cast("_ReferencesDataFile", current).refresh(None)
            except Exception as exc:
                return {'status': 'unknown', 'outcome': 'unknown', 'reason': 'cloud completion readback: ' + type(exc).__name__ + ': ' + str(exc),
                    'savedVersionObserved': int(current.versionNumber)}
            if int(current.versionNumber) > before and _cad_cast(bool, _cad_cast(object, current.isComplete)) is True and _cad_cast(bool, _cad_cast(object, ctx.doc.isModified)) is False:
                return {'status': 'complete', 'changed': True, 'resultingVersion': int(current.versionNumber),
                        'identityAfter': _references_document_identity(_cad_cast("_ReferencesDocument", ctx.doc)),
                        'cloudComplete': True, 'isUpToDate': bool(ctx.doc.isUpToDate),
                        'parameters': _references_parameters(_cad_cast("_ReferencesDesign", ctx.design)),
                        'metadata': _references_metadata(_cad_cast("_ReferencesDesign", ctx.design), _cad_cast("_ReferencesComponent", ctx.root)),
                        'lifecycleEffects': [{'fileId': _cad_cast(str, data['fileId']), 'effect': 'saved',
                                              'version': int(current.versionNumber)}]}
            adsk.doEvents(); time.sleep(.1)
    except Exception as exc:
        return {'status': 'unknown', 'outcome': 'unknown', 'reason': 'save readback: ' + type(exc).__name__ + ': ' + str(exc)}
    return {'status': 'unknown', 'outcome': 'unknown', 'reason': 'save was accepted but cloud completion is not confirmed',
            'savedVersionObserved': int(ctx.doc.dataFile.versionNumber), 'modified': bool(ctx.doc.isModified)}


def _references_cold_editor_owned(doc: "_ReferencesDocument", data: "_ReferencesInput") -> bool:
    return (data.get('lifecycle') == 'openOwned' and isinstance(data.get('ownedCreationId'), str) and
            bool(_cad_cast(str, data['ownedCreationId'])) and doc.creationId == _cad_cast(str, data['ownedCreationId']))


def _references_cold_verify(ctx: "CadContext", data: "_ReferencesInput") -> "JsonObject":
    doc, file = ctx.doc, _cad_cast("_ReferencesDataFile", ctx.doc.dataFile)
    if not _references_cold_editor_owned(_cad_cast("_ReferencesDocument", doc), data):
        return {'status': 'blocked', 'coldVerified': False,
                'reason': 'cold close/reopen requires openOwned authorization and the exact captured editor identity'}
    if doc.isModified or file.id != data['fileId'] or file.versionNumber != _cad_cast(int, data['resultingVersion']) or not file.isComplete:
        return {'status': 'blocked', 'coldVerified': False, 'reason': 'cold precondition not satisfied'}
    file_id, project_id, version = file.id, file.parentProject.id, int(file.versionNumber)
    creation_id = doc.creationId
    try:
        if doc.close(False) is not True:
            return {'status': 'unknown', 'coldVerified': False, 'reason': 'owned clean editor close was not confirmed'}
        # Closing the document can invalidate the SDK wrapper for its DataFile.
        # Resolve a fresh cloud object by exact project/file/version, never keep
        # using the pre-close wrapper or fall back to a name/latest guess.
        if _references_open_matches(_cad_cast("_ReferencesApplication", ctx.app), file_id, project_id, version):
            return {'status': 'blocked', 'coldVerified': False,
                    'reason': 'another top-level editor remains for the pinned cold-reopen target'}
        try:
            reopen_file = _references_project_file(_cad_cast("_ReferencesApplication", ctx.app), project_id, file_id, version)
        except Exception as exc:
            return {'status': 'blocked', 'coldVerified': False,
                    'reason': 'exact saved cloud version is unavailable for cold reopen: ' + str(exc),
                    'lifecycleEffects': [{'fileId': file_id, 'effect': 'closed',
                                          'creationId': creation_id, 'owned': True}]}
        if reopen_file.id != file_id or reopen_file.versionNumber != version or reopen_file.isReadOnly is not False:
            return {'status': 'blocked', 'coldVerified': False,
                    'reason': 'exact saved cloud file is not writable at the requested version'}
        reopened = _cad_require_result(ctx.app.documents.open(_cad_cast("adsk.core.DataFile", _cad_cast(object, reopen_file)), True), 'Cold reopen exact saved DataFile')
        identity = _references_document_identity(_cad_cast("_ReferencesDocument", reopened))
        if identity['fileId'] != file_id or identity['projectId'] != project_id or identity['version'] != version or identity['modified']:
            return {'status': 'unknown', 'coldVerified': False, 'identity': identity,
                    'reason': 'cold reopen identity/version/dirty check failed'}
        cold_ctx = CadContext(reopened.name, project_id=project_id, doc_id=reopened.creationId,
                              doc_file_id=file_id, resolved_doc=reopened)
        post = _references_preflight(cold_ctx, {'fileId': file_id, 'projectId': project_id,
                                                 'allowedProjectIds': data.get('allowedProjectIds')})
        expected = {_cad_cast(str, edge['edgeId']): _cad_cast("JsonObject", data.get('effectiveTargets', {})).get(_cad_cast(str, edge['edgeId']), edge.get('targetVersion'))
                    for edge in _cad_cast("list[JsonObject]", data.get('planEdges', [])) if edge['ownerFileId'] == file_id}
        current = {_cad_cast(str, edge['edgeId']): edge for edge in _cad_cast("list[JsonObject]", post['edges'])}
        edge_pass = all(current.get(edge_id) and current[edge_id].get('baselineVersion') == target
                        for edge_id, target in expected.items())
        derive_ids = {_cad_cast(str, edge['edgeId']) for edge in _cad_cast("list[JsonObject]", data.get('planEdges', []))
                      if edge['ownerFileId'] == file_id and edge['kind'] == 'derive'}
        bindings = [binding for binding in _cad_cast("list[_ReferencesBinding]", data.get('parameterBindings', [])) if binding['edgeId'] in derive_ids]
        binding_results = [_references_binding_checks(cold_ctx, edge_id, bindings,
            _cad_cast("Mapping[str, list[JsonObject]]", data.get('expectedSourceParameters', {})),
            _cad_cast("set[str] | None", data.get('allowedProjectIds'))) for edge_id in derive_ids]
        binding_pass = not derive_ids or bool(binding_results) and all(row['passed'] for row in binding_results)
        history_pass = _cad_cast("JsonObject", _cad_cast("JsonObject", post['document'])['health'])['healthy'] is True
        expected_user: list[JsonObject]
        expected_user = []
        aliases = {binding.get('consumerAlias') for binding in _cad_cast("list[_ReferencesBinding]", data.get('parameterBindings', [])) if binding.get('consumerAlias')}
        for row in _cad_cast("list[JsonObject]", data.get('baselineUserParameters', [])):
            copied = dict(row)
            if copied.get('name') in aliases:
                copied['display_value'] = None; copied['internal_value'] = None
            expected_user.append(copied)
        expected_user = sorted(expected_user, key=lambda row: _cad_cast(str, row.get('name', '')))
        current_user = _references_user_parameter_state(_cad_cast("_ReferencesDesign", cold_ctx.design),
            _cad_cast("list[_ReferencesBinding]", data.get('parameterBindings', [])))
        user_parameters_pass = expected_user == current_user
        metadata: JsonObject
        metadata = _cad_cast("JsonObject", post.get('metadata', {}))
        baseline_metadata: JsonObject
        baseline_metadata = _cad_cast("JsonObject", data.get('baselineMetadata', {}))
        before_attrs = sorted(_cad_cast("list[JsonObject]", baseline_metadata.get('attributes', [])), key=lambda row: (
            row.get('kind',''), str(row.get('namespace')), row.get('group',''), row.get('name','')))
        after_attrs = sorted(_cad_cast("list[JsonObject]", metadata.get('attributes', [])), key=lambda row: (
            row.get('kind',''), str(row.get('namespace')), row.get('group',''), row.get('name','')))
        metadata_pass = before_attrs == after_attrs and metadata.get('metadataComplete') is True
        identity_pass = (identity.get('fileId') == file_id and identity.get('projectId') == project_id and
                         identity.get('version') == version and identity.get('isComplete') is True and
                         identity.get('modified') is False)
        cold_verified = edge_pass and binding_pass and history_pass and metadata_pass and user_parameters_pass and \
            metadata.get('consumedBodiesVerified') is True and identity_pass
        checks: JsonObject = {'intendedReferencesCurrent': edge_pass, 'bindingsPass': binding_pass,
                  'healthPass': history_pass, 'metadataPass': metadata_pass,
                  'localParametersPreserved': user_parameters_pass, 'identityPass': identity_pass,
                  'consumedBodiesVerified': metadata.get('consumedBodiesVerified') is True,
                  'bindingResults': binding_results,
                  'getterState': 'unresolved' if any(edge.get('versionSource') == 'unresolved' for edge in _cad_cast("list[JsonObject]", post['edges'])) else
                    'diagnostic' if any(edge.get('getterError') for edge in _cad_cast("list[JsonObject]", post['edges'])) else 'resolved'}
        return {'status': 'complete' if cold_verified else 'failed',
                'coldVerified': cold_verified, 'identity': identity,
                 'checks': checks, 'edges': _cad_cast("list[JsonValue]", post['edges']), 'parameters': _references_parameters(_cad_cast("_ReferencesDesign", cold_ctx.design)),
                 'metadata': metadata,
                 'lifecycleEffects': [{'fileId': file_id, 'effect': 'closed', 'creationId': creation_id,
                                       'owned': True}, {'fileId': file_id, 'effect': 'coldReopened',
                                       'creationId': reopened.creationId, 'version': version, 'owned': True}]}
    except Exception as exc:
        return {'status': 'unknown', 'coldVerified': False,
                'reason': type(exc).__name__ + ': ' + str(exc),
                'lifecycleEffects': [{'fileId': file_id, 'effect': 'coldReopenUncertain', 'owned': True}]}


def _references_refresh_internal(action: object, payload: object) -> "JsonObject":
    if not isinstance(action, str) or action not in ('graph', 'preflight', 'sdkUpdate', 'nativeUpdate', 'save', 'coldVerify'):
        raise ValueError('Unknown private references.refresh SDK action')
    if not isinstance(payload, dict):
        raise ValueError('references.refresh data must be an object')
    data = _cad_cast("_ReferencesInput", payload)
    if action == 'graph':
        return _references_collect_graph(data)
    if action not in ('preflight', 'sdkUpdate', 'nativeUpdate', 'save', 'coldVerify'):
        raise ValueError('Unknown private references.refresh SDK action')
    ctx, lifecycle = _references_step_context(data, action)
    if ctx is None:
        return lifecycle
    if action == 'preflight':
        result = _references_preflight(ctx, {'fileId': data['fileId'], 'projectId': data['projectId'],
                                             'allowedProjectIds': data.get('allowedProjectIds')})
    elif action == 'sdkUpdate':
        result = _references_update(ctx, data)
    elif action == 'nativeUpdate':
        result = _references_native_update(ctx, data)
    elif action == 'save':
        result = _references_save(ctx, data)
    else:
        result = _references_cold_verify(ctx, data)
    _cad_cast("list[JsonObject]", result.setdefault('lifecycleEffects', []))
    if lifecycle.get('openedByRequest'):
        result['openedByRequest'] = True
        result['ownedCreationId'] = _cad_cast(str, _cad_cast("JsonObject", lifecycle['identity'])['creationId'])
        _cad_cast("list[JsonObject]", result['lifecycleEffects']).append({'fileId': _cad_cast(str, data['fileId']), 'effect': 'openedForApply',
            'creationId': _cad_cast(str, _cad_cast("JsonObject", lifecycle['identity'])['creationId']), 'owned': True})
    result.setdefault('identity', lifecycle.get('identity'))
    return result
