"""Cloud-logical document operations; never create destinations or map native paths.

API contract: installed adsk/core.py Document.saveAs/save/isSaved/dataFile,
Data.dataProjects, DataProject.rootFolder, DataFolder.dataFolders/dataFiles,
and DataFile.isComplete. Saving is unsupported in command-related events.
"""

if _CAD_TYPE_CHECKING:
    _DocumentItem = TypeVar('_DocumentItem', bound=adsk.core.Base, covariant=True)

    class _DocumentClearCollection(_Protocol[_DocumentItem]):
        @property
        def count(self) -> int: ...

        def item(self, index: int, /) -> _DocumentItem: ...

    class _DocumentTimelineRow(_Protocol):
        @property
        def entity(self) -> "adsk.core.Base | None": ...

        @property
        def isGroup(self) -> bool: ...

        @property
        def isSuppressed(self) -> bool: ...

        @property
        def index(self) -> int: ...

        @property
        def parentTimeline(self) -> "adsk.fusion.Timeline": ...

    class _DocumentDerivedEntity(_Protocol):
        @property
        def isDerived(self) -> bool: ...

    class _DocumentTimelineObject(_Protocol):
        @property
        def entity(self) -> "adsk.core.Base | None": ...

        @property
        def isValid(self) -> bool: ...

        @property
        def index(self) -> int: ...

        @property
        def parentTimeline(self) -> "adsk.fusion.Timeline": ...

        @property
        def isGroup(self) -> bool: ...

        @property
        def isSuppressed(self) -> bool: ...

    class _DocumentOccurrence(_Protocol):
        @property
        def isReferencedComponent(self) -> bool: ...

        @property
        def component(self) -> "adsk.fusion.Component": ...


_DOCUMENT_SAVE_WARNING = (
    'Fusion SDK saving is unsupported inside command-related events/command transactions. '
    'Run save_as separately outside such a transaction, not inside an MCP command-event '
    'transaction. Pre-save and saveAs-call errors propagate; post-save status errors are '
    'reported as readbackError. Do not blindly retry an accepted or uncertain save. '
    'Read document.status to inspect asynchronous cloud processing.')


def _document_status(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data)
    return _document_snapshot(ctx.doc)


class _DocumentCopyEffects:
    """SDK handles are owned only by this adapter for this single request."""
    def __init__(self, ctx: "CadContext") -> None:
        self.ctx = ctx
        self.folder: adsk.core.DataFolder | None = None

    def target(self, request: "JsonRecord") -> "JsonRecord":
        name = _cad_cast(str, request['name'])
        project_ref = _cad_cast(str, request['project'])
        path = _cad_cast(str, request['folder'])
        projects: list[adsk.core.DataProject] = [
            project for project in _cad_items(self.ctx.app.data.dataProjects)
            if project.id == project_ref or project.name == project_ref]
        if len(projects) != 1:
            raise ValueError('project must match exactly one accessible project in the active hub; found ' + str(len(projects)))
        project = projects[0]
        if 'expectedProjectId' in request and project.id != request['expectedProjectId']:
            raise ValueError('expectedProjectId does not match the selected destination')
        folder = project.rootFolder
        folder = _cad_cast("adsk.core.DataFolder | None", folder)
        if folder is None:
            raise ValueError('Project root folder is unavailable')
        for part in path.split('/') if path else []:
            matches = [f for f in _cad_items(folder.dataFolders) if f.name == part]
            if len(matches) != 1:
                raise ValueError('folder segment ' + repr(part) + ' must match exactly one child; found ' + str(len(matches)))
            folder = matches[0]
        if 'expectedFolderId' in request and folder.id != request['expectedFolderId']:
            raise ValueError('expectedFolderId does not match the selected destination')
        if any(f.name.casefold() == name.casefold() for f in _cad_items(folder.dataFiles)):
            raise ValueError('Target filename already exists; choose a unique name (overwrite is not supported)')
        self.folder = folder
        return {'name': name, 'projectId': project.id, 'projectName': project.name,
                'folderId': folder.id, 'folder': path}

    def snapshot(self) -> "JsonRecord":
        return _document_snapshot(self.ctx.doc)

    def progress(self, target: "JsonRecord", warning: str) -> None:
        print('FMCAD_PROGRESS ' + json.dumps({'operation': 'document.save_as',
              'state': 'validated', 'target': target, 'warning': warning}))

    def save_copy(self, request: "JsonRecord") -> bool:
        folder = _cad_cast("adsk.core.DataFolder", self.folder)
        return self.ctx.doc.saveAs(_cad_cast(str, request['name']), folder,
                                   _cad_cast(str, request['description']), _cad_cast(str, request['tag']))


def _document_save_as(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('name', 'project', 'folder', 'confirm'), ('description', 'tag', 'expectedFolderId', 'expectedProjectId'))
    ctx.require_confirm(data)
    return document_copy(data, _DocumentCopyEffects(ctx), _DOCUMENT_SAVE_WARNING)


def _document_save_native(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    """Issue exactly one save for the already-open, identity-pinned document.

    Publication is observed later through document.status; no post-save DataFile
    getter is required to report the native acceptance result.
    """
    _cad_fields(data, ('requestId', 'operationId', 'projectId', 'fileId', 'creationId', 'version', 'description'))
    doc = ctx.doc
    try:
        ctx.assert_identity()
        file = _cad_cast("adsk.core.DataFile | None", doc.dataFile)
        project_id = file.parentProject.id if file else None
        if (doc.isValid is not True or doc.isSaved is not True or file is None or
                doc.creationId != data['creationId'] or file.id != data['fileId'] or
                project_id != data['projectId'] or int(file.versionNumber) != data['version']):
            return {'status': 'blocked', 'accepted': False, 'saveAttempted': False,
                    'reason': 'identityOrVersionMismatch'}
        modified = doc.isModified
        if modified is False:
            return {'status': 'noop', 'accepted': False, 'saveAttempted': False,
                    'changed': False, 'resultingVersion': data['version'], 'fileId': file.id,
                    'cloudComplete': file.isComplete is True}
        if modified is not True:
            return {'status': 'blocked', 'accepted': False, 'saveAttempted': False,
                    'reason': 'modifiedStateUnavailable'}
        if ctx.app.activeDocument != doc:
            return {'status': 'blocked', 'accepted': False, 'saveAttempted': False,
                    'reason': 'targetIsNotAlreadyActive'}
        if ctx.app.userInterface.activeCommand not in ('', 'SelectCommand'):
            return {'status': 'blocked', 'accepted': False, 'saveAttempted': False,
                    'reason': 'interactiveCommandActive'}
        if file.isReadOnly is not False or file.isComplete is not True:
            return {'status': 'blocked', 'accepted': False, 'saveAttempted': False,
                    'reason': 'targetIsReadOnlyOrCloudIncomplete'}
    except Exception as exc:
        return {'status': 'blocked', 'accepted': False, 'saveAttempted': False,
                'reason': 'preSaveIdentityReadbackFailed',
                'error': {'type': type(exc).__name__, 'message': str(exc)}}
    try:
        accepted = doc.save(_cad_cast(str, data['description']))
    except Exception as exc:
        return {'status': 'unknown', 'accepted': None, 'saveAttempted': True,
                'reason': 'saveCallRaisedAfterEntry',
                'error': {'type': type(exc).__name__, 'message': str(exc)}}
    if accepted is not True:
        return {'status': 'failed', 'accepted': False, 'saveAttempted': True,
                'reason': 'saveNotAccepted'}
    return {'status': 'accepted', 'accepted': True, 'saveAttempted': True,
            'changed': True, 'baselineVersion': data['version'], 'fileId': data['fileId'],
            'projectId': data['projectId'], 'creationId': data['creationId']}


# Public SDK references and the deliberately bounded empty-content contract:
# docs/DOCUMENT_CLEAR.md. Unknown/missing audit data is never treated as empty.
_DOCUMENT_CLEAR_TIMELINE_TYPES = {
    'Occurrence', 'Sketch', 'Canvas', 'ConstructionPlane', 'ConstructionAxis', 'ConstructionPoint',
    'ExtrudeFeature', 'RevolveFeature', 'SweepFeature', 'LoftFeature', 'FilletFeature',
    'ChamferFeature', 'ShellFeature', 'DraftFeature', 'HoleFeature', 'CombineFeature',
    'MirrorFeature', 'RectangularPatternFeature', 'CircularPatternFeature',
    'PathPatternFeature', 'MoveFeature', 'ScaleFeature', 'SplitBodyFeature',
    'SplitFaceFeature', 'DeleteFaceFeature', 'RemoveFeature', 'OffsetFeature',
    'ThickenFeature', 'StitchFeature', 'UnstitchFeature', 'PatchFeature', 'ExtendFeature',
    'TrimFeature', 'CutPasteBody',
    'Joint', 'AsBuiltJoint', 'JointOrigin', 'RigidGroup', 'Snapshot', 'BaseFeature',
}
_DOCUMENT_CLEAR_COMPONENT_COLLECTIONS = (
    'occurrences', 'bRepBodies', 'sketches', 'features', 'constructionPlanes',
    'constructionAxes', 'constructionPoints', 'joints', 'asBuiltJoints',
    'jointOrigins', 'rigidGroups', 'canvases', 'customGraphicsGroups',
    'meshBodies', 'decals', 'pmiAnnotations', 'userCoordinateSystems')
_DOCUMENT_CLEAR_RETAINED = [
    'Cloud file identity, name, location, metadata and version history; root component and origin datums.',
    'Units, materials, appearances, rules, view/render settings and document preferences are not reset.',
    'This is a supported design-content empty contract, not a literal new document. No save is performed.']


def _document_clear_items(collection: object, *, array: bool = False,
                          label: str = 'collection') -> "list[CadEntity]":
    if collection is None:
        raise ValueError('document.clear audit unavailable: null collection')
    # Product.findAttributes returns an array (SWIG AttributeVector on some SDKs),
    # not an Attributes count/item collection. Select this contract explicitly;
    # never fall back to iteration after an SDK collection getter fails.
    if array or isinstance(collection, (list, tuple)):
        items: list[object] = list(_cad_cast("Iterable[object]", collection))
    else:
        source = _cad_cast("_DocumentClearCollection[CadEntity]", collection)
        count = source.count
        if type(count) is not int or count < 0:
            raise ValueError('document.clear audit unavailable: invalid collection count')
        items = [source.item(i) for i in range(count)]
    checked_items: list[CadEntity] = []
    for index, item in enumerate(items):
        if item is None:
            raise ValueError('document.clear audit unavailable: null/invalid entity at %s index %d type <null>' %
                             (label, index))
        entity = _cad_cast("CadEntity", item)
        if entity.isValid is not True:
            kind = _cad_type(entity)
            raise ValueError('document.clear audit unavailable: null/invalid entity at %s index %d type %s' %
                             (label, index, kind))
        checked_items.append(entity)
    return checked_items


def _document_clear_guard(ctx: "CadContext", file_id: object) -> "JsonRecord":
    ctx.assert_identity()
    if (not isinstance(file_id, str) or not file_id or re.search(r'\s', file_id)
            or file_id.startswith('-') or ctx.doc_file_id != file_id):
        raise ValueError('document.clear requires --doc-file-id and data.fileId with the same exact DataFile.id')
    doc = ctx.doc
    if doc.isValid is not True or doc.isSaved is not True:
        raise ValueError('document.clear requires a valid previously saved cloud document')
    file = _cad_cast("adsk.core.DataFile | None", doc.dataFile)
    if (file is None or file.isValid is not True or file.id != file_id
            or file.isComplete is not True or file.isReadOnly is not False):
        raise ValueError('document.clear requires the exact complete, writable cloud DataFile')
    if type(doc.isModified) is not bool:
        raise ValueError('document.clear modified status is unavailable')
    return {'fileId': file.id, 'saved': True, 'modified': doc.isModified,
            'isComplete': True, 'readOnly': False}


def _document_clear_audit(ctx: "CadContext") -> "tuple[dict[str, int], list[adsk.fusion.UserParameter]]":
    design, root, doc = ctx.design, ctx.root, ctx.doc
    if design.isValid is not True or root.isValid is not True:
        raise ValueError('document.clear requires valid Design/root objects')
    if (_cad_cast("object", design.designType) !=
            _cad_cast("object", adsk.fusion.DesignTypes.ParametricDesignType)):
        raise ValueError('document.clear does not support direct designs')
    if design.isConfiguredDesign is not False or design.isConfiguration is not False:
        raise ValueError('document.clear does not support configured designs/configurations')
    if ctx.component != root or ctx.occurrence is not None or design.activeEditObject != root:
        raise ValueError('document.clear requires root scope and root edit target')
    products = _document_clear_items(doc.products)
    if len(products) != 1 or products[0] != design:
        raise ValueError('document.clear cannot certify non-Design products (including CAM/manufacturing)')
    if _document_clear_items(doc.documentReferences):
        raise ValueError('document.clear does not support external document references')
    for name in ('selectionSets', 'contactSets', 'namedViews'):
        collection = _cad_cast("object", getattr(design, name))
        if _document_clear_items(collection):
            raise ValueError('document.clear unsupported Design contents: ' + name)
    analyses: list[adsk.fusion.Analysis] = [
        _cad_cast("adsk.fusion.Analysis", analysis)
        for analysis in _document_clear_items(design.analyses)]
    for analysis in analyses:
        if _cad_type(analysis) != 'SectionAnalysis':
            raise ValueError('document.clear unsupported Design contents: analyses type ' + _cad_type(analysis))
    timeline = design.timeline
    rows: list[_DocumentTimelineRow] = _cad_cast(
        "list[_DocumentTimelineRow]", _document_clear_items(timeline, label='timeline'))
    if timeline.markerPosition != len(rows):
        raise ValueError('document.clear requires timeline marker at end for a complete audit')
    groups: list[adsk.fusion.TimelineGroup] = [
        _cad_cast("adsk.fusion.TimelineGroup", group)
        for group in _document_clear_items(timeline.timelineGroups)]
    audit_rows: list[_DocumentTimelineRow] = []
    seen_groups: list[adsk.fusion.TimelineGroup] = []
    for index, row in enumerate(rows):
        if row.isGroup is True:
            matches = [group for group in groups if group == _cad_cast("object", row)]
            if len(matches) != 1 or row.isSuppressed is not False:
                kind = _cad_type(row.entity) if row.entity is not None else '<no public entity>'
                raise ValueError('document.clear timeline index %d type %s: grouped entry unsupported' % (index, kind))
            members: list[_DocumentTimelineRow] = _cad_cast(
                "list[_DocumentTimelineRow]", _document_clear_items(matches[0], label='timeline group'))
            if not members or any(m.isGroup is not False for m in members):
                raise ValueError('document.clear empty/nested timeline group unsupported')
            audit_rows.extend(members)
            seen_groups.append(matches[0])
        else:
            audit_rows.append(row)
    if len(seen_groups) != len(groups):
        raise ValueError('document.clear timeline group inventory mismatch')
    if not callable(timeline.deleteAllAfterMarker):
        raise ValueError('document.clear timeline deletion API unavailable')
    components: list[adsk.fusion.Component] = [
        _cad_cast("adsk.fusion.Component", component)
        for component in _document_clear_items(design.allComponents)]
    current_occurrences: list[adsk.fusion.Occurrence] = [
        _cad_cast("adsk.fusion.Occurrence", occurrence)
        for component in components for occurrence in _document_clear_items(component.occurrences)]
    entities: list[CadEntity] = []
    for index, row in enumerate(audit_rows):
        entity = row.entity
        kind = _cad_type(entity) if entity is not None else '<no public entity>'
        location = 'document.clear timeline index %d type %s: ' % (index, kind)
        if row.isGroup is not False:
            raise ValueError(location + 'grouped entry unsupported')
        if row.isSuppressed is not False:
            raise ValueError(location + 'suppressed entry unsupported')
        if entity is None:
            raise ValueError(location + 'no public API entity to audit')
        if entity.isValid is not True:
            raise ValueError(location + 'invalid entity')
        if kind not in _DOCUMENT_CLEAR_TIMELINE_TYPES:
            raise ValueError(location + 'unsupported public entity type')
        if kind in ('Occurrence', 'Sketch', 'Canvas', 'ConstructionPlane',
                    'ConstructionAxis', 'ConstructionPoint'):
            try:
                derived = _cad_cast("_DocumentDerivedEntity", entity).isDerived
            except RuntimeError as error:
                # Removed occurrence history has no current occPath. Audit its
                # local historical definition below instead of inventing a path.
                occurrence_entity = _cad_cast("_DocumentOccurrence", entity)
                if (kind != 'Occurrence' or entity in current_occurrences
                        or 'InternalValidationError : occPath.valid()' not in str(error)
                        or occurrence_entity.isReferencedComponent is not False
                        or occurrence_entity.component.isValid is not True
                        or occurrence_entity.component.parentDesign != design):
                    raise
            else:
                if derived is not False:
                    raise ValueError(location + 'derived timeline entity unsupported')
        entities.append(entity)
    # allComponents omits definitions only retained by removed history. They
    # still need the same full content audit before deleting the whole timeline.
    for entity in entities:
        owner = (_cad_cast("adsk.fusion.Occurrence", entity).component
                 if _cad_type(entity) == 'Occurrence' else None)
        if owner is not None and owner not in components:
            components.append(owner)
    for component in components:
        for occurrence_value in _document_clear_items(component.occurrences):
            occurrence = _cad_cast("adsk.fusion.Occurrence", occurrence_value)
            if occurrence.component not in components:
                components.append(occurrence.component)
    if root not in components:
        raise ValueError('document.clear audit missing root component')
    for index, entity in enumerate(entities):
        if _cad_type(entity) == 'BaseFeature':
            base_feature = _cad_cast("adsk.fusion.BaseFeature", entity)
            if (getattr(base_feature, 'assemblyContext', 'unavailable') is not None
                    or _cad_cast("object | None", getattr(base_feature, 'baseFeature', None)) is not None
                    or base_feature.parentComponent not in components):
                raise ValueError('document.clear unsupported base feature ownership')
            for name in ('sketches', 'constructionPlanes', 'constructionAxes',
                         'constructionPoints', 'meshBodies', 'linkedFeatures'):
                base_collection = _cad_cast("object", getattr(base_feature, name))
                if _document_clear_items(base_collection, array=True, label='base feature ' + name):
                    raise ValueError('document.clear unsupported base feature contents: ' + name)
            source_bodies = [_cad_cast("adsk.fusion.BRepBody", body)
                             for body in _document_clear_items(base_feature.sourceBodies, array=True,
                                                              label='base feature source bodies')]
            if any(body.isDerived is not False for body in source_bodies):
                raise ValueError('document.clear derived base feature source bodies unsupported')
        if _cad_type(entity) == 'CutPasteBody':
            cut_paste = _cad_cast("adsk.fusion.CutPasteBody", entity)
            if (cut_paste.isParametric is not True
                    or _cad_cast("object | None", getattr(cut_paste, 'baseFeature', None)) is not None
                    or cut_paste.parentComponent not in components):
                raise ValueError('document.clear timeline index %d type CutPasteBody: '
                                 'requires a local parametric feature outside a base feature' % index)
    counts: dict[str, int] = dict.fromkeys(_DOCUMENT_CLEAR_COMPONENT_COLLECTIONS, 0)
    snapshots: list[adsk.fusion.Snapshot] = [
        _cad_cast("adsk.fusion.Snapshot", snapshot)
        for snapshot in _document_clear_items(design.snapshots)]
    if any(snapshot not in entities for snapshot in snapshots):
        raise ValueError('document.clear snapshot outside audited timeline')
    counts.update(timeline=len(rows), snapshots=len(snapshots), descendantComponents=len(components) - 1,
                  analyses=len(analyses), userParameters=0, modelParameters=0, attributes=0)
    canvases: list[adsk.fusion.Canvas] = []
    graphics: list[adsk.fusion.CustomGraphicsGroup] = []
    audited_entities: list[CadEntity] = list(entities)
    for component in components:
        flat_pattern = _cad_cast("object | None", getattr(component, 'flatPattern', None))
        if component.parentDesign != design or flat_pattern is not None:
            raise ValueError('document.clear unsupported component ownership/flat pattern')
        for name in _DOCUMENT_CLEAR_COMPONENT_COLLECTIONS:
            collection = _cad_cast("object", getattr(component, name))
            values = _document_clear_items(collection)
            counts[name] += len(values)
            if values and name in ('meshBodies', 'decals', 'pmiAnnotations', 'userCoordinateSystems'):
                raise ValueError('document.clear unsupported component contents: ' + name)
            if name == 'canvases':
                canvas_values = [
                    _cad_cast("adsk.fusion.Canvas", value) for value in values]
                if any(value.isDerived is not False for value in canvas_values):
                    raise ValueError('document.clear derived canvas unsupported')
                canvases.extend(canvas_values)
            elif name == 'customGraphicsGroups':
                graphics.extend(_cad_cast("adsk.fusion.CustomGraphicsGroup", value) for value in values)
            elif name == 'features':
                for feature_value in values:
                    feature = _cad_cast("adsk.fusion.Feature", feature_value)
                    if feature in entities:
                        continue
                    # Compound CutPasteBody entries expose internal Feature/RemoveFeature
                    # objects in Component.features. Their own timelineObject.entity can
                    # be the helper, so bind through the canonical public timeline index.
                    kind = _cad_type(feature)
                    binding = (_cad_cast("_DocumentTimelineObject", feature.timelineObject)
                               if kind in ('Feature', 'RemoveFeature') else None)
                    index = binding.index if binding is not None and binding.isValid is True else None
                    timeline_row: "_DocumentTimelineRow | None" = (
                        rows[index]
                        if type(index) is int and 0 <= index < len(rows) else None)
                    row_entity: "adsk.core.Base | None" = (
                        timeline_row.entity if timeline_row is not None else None)
                    removed_occurrence = (kind == 'RemoveFeature' and type(index) is int
                        and 0 <= index < len(rows) and row_entity is not None
                        and _cad_type(row_entity) == 'Occurrence'
                        and binding is not None and binding.entity == row_entity
                        and row_entity not in current_occurrences)
                    if (binding is None or binding.isValid is not True
                            or type(index) is not int or not 0 <= index < len(rows)
                            or binding.parentTimeline != timeline or (binding.entity != feature and not removed_occurrence)
                            or binding.isGroup is not False or binding.isSuppressed is not False
                            or rows[index].index != index or rows[index].parentTimeline != timeline
                            or (row_entity is None or (_cad_type(row_entity) != 'CutPasteBody'
                                                       and not removed_occurrence))
                            or feature.parentComponent != component
                            or _cad_cast("object | None", getattr(feature, 'assemblyContext', None)) is not None
                            or feature.isParametric is not True
                            or _cad_cast("object | None", getattr(feature, 'baseFeature', None)) is not None):
                        raise ValueError('document.clear feature type %s at timeline index %r: '
                                         'not a valid local parametric CutPasteBody helper' % (kind, index))
                    audited_entities.append(feature)
            elif name not in ('bRepBodies', 'meshBodies', 'decals', 'pmiAnnotations', 'userCoordinateSystems'):
                if any(value not in entities for value in values):
                    raise ValueError('document.clear contents outside audited timeline: ' + name)
            if name == 'occurrences':
                for occurrence_value in values:
                    occurrence = _cad_cast("adsk.fusion.Occurrence", occurrence_value)
                    if occurrence.isReferencedComponent is not False or occurrence.component not in components:
                        raise ValueError('document.clear does not support external occurrences')
            if name == 'bRepBodies':
                body_values = [_cad_cast("adsk.fusion.BRepBody", value) for value in values]
                if any((_cad_cast("object | None", getattr(value, 'baseFeature', None)) is not None and (
                        getattr(value, 'baseFeature') not in entities
                        or _cad_type(_cad_cast("CadEntity", getattr(value, 'baseFeature'))) != 'BaseFeature'))
                       or value.isDerived is not False for value in body_values):
                    raise ValueError('document.clear direct/base/derived bodies unsupported')
    # History is audited across the entire Design. moveToComponent/CutPasteBody can
    # leave source features in root and result bodies in children. Do not require
    # co-location or read CutPasteBody.sourceBody (requires timeline rollback).
    # BRep bodies require supported history, including audited BRep-only base features.
    if counts['bRepBodies'] and not counts['features']:
        raise ValueError('document.clear cannot certify bodies without parametric features')
    parameters: list[adsk.fusion.UserParameter] = [
        _cad_cast("adsk.fusion.UserParameter", parameter)
        for parameter in _document_clear_items(design.userParameters)]
    all_parameters: list[adsk.fusion.Parameter] = [
        _cad_cast("adsk.fusion.Parameter", parameter)
        for parameter in _document_clear_items(design.allParameters)]
    if any(p not in all_parameters for p in parameters):
        raise ValueError('document.clear inconsistent parameter inventory')
    for parameter in all_parameters:
        if parameter not in parameters:
            if _cad_type(parameter) != 'ModelParameter':
                raise ValueError('document.clear unsupported parameter type')
            owner = _cad_cast("object | None", getattr(
                _cad_cast("adsk.fusion.ModelParameter", parameter), 'createdBy', None))
            if owner is not None and hasattr(owner, 'parentSketch'):
                owner = _cad_cast("object | None", getattr(owner, 'parentSketch'))
            if owner not in audited_entities:
                raise ValueError('document.clear model parameter outside audited timeline')
    # Plan dependent-first user deletion without changing expressions or trying deletes.
    dependents: list[list[adsk.fusion.Parameter]] = []
    for parameter in parameters:
        deps = [_cad_cast("adsk.fusion.Parameter", value)
                for value in _document_clear_items(parameter.dependentParameters)]
        dependencies = [_cad_cast("adsk.fusion.Parameter", value)
                        for value in _document_clear_items(parameter.dependencyParameters)]
        if any(p not in all_parameters for p in deps) or any(p not in parameters for p in dependencies):
            raise ValueError('document.clear unsupported parameter relationships')
        if type(parameter.isDeletable) is not bool or (not deps and not parameter.isDeletable):
            raise ValueError('document.clear undeletable user parameter')
        dependents.append(deps)
    order: list[adsk.fusion.UserParameter] = []
    while len(order) < len(parameters):
        ready: list[adsk.fusion.UserParameter] = [
            parameter for parameter, deps in zip(parameters, dependents)
            if parameter not in order and all(dependency not in parameters or dependency in order
                                              for dependency in deps)]
        if not ready:
            raise ValueError('document.clear cyclic user parameter relationships')
        order.extend(ready)
    attributes: list[adsk.core.Attribute] = [
        _cad_cast("adsk.core.Attribute", attribute) for attribute in
        (_document_clear_items(design.findAttributes('', ''), array=True)
         + _document_clear_items(design.attributes) + _document_clear_items(doc.attributes))]
    for entity in canvases + graphics + parameters + attributes:
        if not callable(_cad_cast("Callable[[], bool]", getattr(entity, 'deleteMe'))):
            raise ValueError('document.clear required deletion API unavailable')
    counts.update({'userParameters': len(parameters),
                   'modelParameters': len(all_parameters) - len(parameters),
                   'attributes': len(attributes)})
    return counts, order


def _document_clear(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('fileId', 'confirm'), ('dryRun',))
    ctx.require_confirm(data)
    if type(data.get('dryRun', False)) is not bool:
        raise ValueError('dryRun must be boolean')
    original = _document_clear_guard(ctx, data['fileId'])
    before, parameters = _document_clear_audit(ctx)
    _document_clear_guard(ctx, data['fileId'])
    if data.get('dryRun', False):
        return {'status': 'inspected', 'dryRun': True, 'mutation': False, 'before': before,
                'current': original, 'savePerformed': False, 'unsavedChanges': original['modified'],
                'retained': _DOCUMENT_CLEAR_RETAINED}
    # Activation occurs only after all input/identity/content audit reads succeed.
    ctx.activate_target()
    _document_clear_guard(ctx, data['fileId'])
    print('FMCAD_PROGRESS ' + json.dumps({'operation': 'document.clear', 'state': 'validated',
          'fileId': data['fileId'], 'before': before,
          'warning': 'Destructive unsaved content change; no save, retry or rollback. Inspect any partial failure.'}))
    if before['timeline']:
        ctx.design.timeline.markerPosition = 0
        if ctx.design.timeline.markerPosition != 0:
            raise RuntimeError('document.clear marker did not reach zero; inspect partial changes')
        _cad_require_result(ctx.design.timeline.deleteAllAfterMarker(), 'Clear timeline')
    # Section analyses are analysis results, not timeline entities; delete survivors explicitly.
    for analysis_value in _document_clear_items(ctx.design.analyses):
        analysis = _cad_cast("adsk.fusion.SectionAnalysis", analysis_value)
        _cad_require_result(_cad_cast("Callable[[], bool]", getattr(analysis, 'deleteMe'))(),
                            'Clear section analysis')
    # Re-enumerate survivors: child component objects may already have been deleted by history.
    for component_value in _document_clear_items(ctx.design.allComponents):
        component = _cad_cast("adsk.fusion.Component", component_value)
        for name in ('canvases', 'customGraphicsGroups'):
            collection = _cad_cast("object", getattr(component, name))
            for entity in _document_clear_items(collection):
                _cad_require_result(_cad_cast("Callable[[], bool]", getattr(entity, 'deleteMe'))(),
                                    'Clear ' + name)
    for parameter in parameters:
        if parameter.isValid is not True or parameter.isDeletable is not True:
            raise RuntimeError('document.clear user parameter not deletable after history removal; inspect partial changes')
        _cad_require_result(_cad_cast("Callable[[], bool]", getattr(parameter, 'deleteMe'))(),
                            'Clear user parameter')
    attributes = (_document_clear_items(ctx.design.findAttributes('', ''), array=True)
                  + _document_clear_items(ctx.design.attributes) + _document_clear_items(ctx.doc.attributes))
    for attribute in attributes:
        _cad_require_result(_cad_cast("Callable[[], bool]", getattr(attribute, 'deleteMe'))(),
                            'Clear attribute')
    current = _document_clear_guard(ctx, data['fileId'])
    after, unused = _document_clear_audit(ctx)
    if any(after.values()):
        raise RuntimeError('document.clear verification failed; partial unsaved contents remain: ' + json.dumps(after))
    changed = any(before.values())
    if changed and current['modified'] is not True:
        raise RuntimeError('document.clear content changed but unsaved modification status was not observed')
    return {'status': 'cleared', 'dryRun': False, 'mutation': changed, 'before': before, 'after': after,
            'current': current, 'savePerformed': False, 'unsavedChanges': current['modified'],
            'retained': _DOCUMENT_CLEAR_RETAINED}


CAD_HANDLERS.update({'document.status': _document_status,
                     'document.save_native': _document_save_native,
                     'document.save_as': _document_save_as,
                     'document.clear': _document_clear})
