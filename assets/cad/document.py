"""Cloud-logical document operations; never create destinations or map native paths.

API contract: installed adsk/core.py Document.saveAs/save/isSaved/dataFile,
Data.dataProjects, DataProject.rootFolder, DataFolder.dataFolders/dataFiles,
and DataFile.isComplete. Saving is unsupported in command-related events.
"""

_DOCUMENT_SAVE_WARNING = (
    'Fusion SDK saving is unsupported inside command-related events/command transactions. '
    'Run save_as separately outside such a transaction, not inside an MCP command-event '
    'transaction. Pre-save and saveAs-call errors propagate; post-save status errors are '
    'reported as readbackError. Do not blindly retry an accepted or uncertain save. '
    'Read document.status to inspect asynchronous cloud processing.')


def _document_status(ctx, data):
    _cad_fields(data)
    return _document_snapshot(ctx.doc)


def _document_save_as(ctx, data):
    _cad_fields(data, ('name', 'project', 'folder', 'confirm'), ('description', 'tag', 'expectedFolderId', 'expectedProjectId'))
    ctx.require_confirm(data)
    name, project_ref, path = data['name'], data['project'], data['folder']
    if (not isinstance(name, str) or not name.strip() or name != name.strip()
            or name in ('.', '..') or any(c in name for c in '/\\:*?"<>|')
            or any(ord(c) < 32 for c in name) or name.endswith('.')):
        raise ValueError('name must be a nonempty document name, not a path, without reserved characters or edge whitespace/dots')
    if not isinstance(project_ref, str) or not project_ref.strip():
        raise ValueError('project must be an exact nonempty project ID or name')
    if (not isinstance(path, str) or '\\' in path or ':' in path
            or any(ord(c) < 32 for c in path)
            or (path != '' and any(p in ('', '.', '..') for p in path.split('/')))):
        raise ValueError('folder must be a relative cloud folder path separated by /; use empty string for root')
    for key in ('description', 'tag'):
        if not isinstance(data.get(key, ''), str):
            raise ValueError(key + ' must be a string')
    if 'expectedFolderId' in data and (not isinstance(data['expectedFolderId'], str) or not data['expectedFolderId'].strip()):
        raise ValueError('expectedFolderId must be a nonempty exact folder ID')
    if 'expectedProjectId' in data and (not isinstance(data['expectedProjectId'], str) or not data['expectedProjectId'].strip()):
        raise ValueError('expectedProjectId must be a nonempty exact native project ID')

    projects = [p for p in _cad_items(ctx.app.data.dataProjects)
                if p.id == project_ref or p.name == project_ref]
    if len(projects) != 1:
        raise ValueError('project must match exactly one accessible project in the active hub; found ' + str(len(projects)))
    project = projects[0]
    if 'expectedProjectId' in data and project.id != data['expectedProjectId']:
        raise ValueError('expectedProjectId does not match the selected destination')
    folder = project.rootFolder
    if folder is None:
        raise ValueError('Project root folder is unavailable')
    for part in path.split('/') if path else []:
        matches = [f for f in _cad_items(folder.dataFolders) if f.name == part]
        if len(matches) != 1:
            raise ValueError('folder segment ' + repr(part) + ' must match exactly one child; found ' + str(len(matches)))
        folder = matches[0]
    if 'expectedFolderId' in data and folder.id != data['expectedFolderId']:
        raise ValueError('expectedFolderId does not match the selected destination')
    # Conservative case-insensitive collision guard, across file types. Never overwrite.
    if any(f.name.casefold() == name.casefold() for f in _cad_items(folder.dataFiles)):
        raise ValueError('Target filename already exists; choose a unique name (overwrite is not supported)')
    target = {'name': name, 'projectId': project.id, 'projectName': project.name,
              'folderId': folder.id, 'folder': path}
    original = _document_status(ctx, {})
    if original.get('dataFileError'):
        # Diagnostics may expose a partial local identity. A cloud-logical copy
        # must not silently reinterpret an unreadable saved source as unsaved.
        raise RuntimeError(original['dataFileError']['message'])
    print('FMCAD_PROGRESS ' + json.dumps({'operation': 'document.save_as',
          'state': 'validated', 'target': target, 'warning': _DOCUMENT_SAVE_WARNING}))
    accepted = ctx.doc.saveAs(name, folder, data.get('description', ''), data.get('tag', ''))
    # Only post-save readback is recoverable: never lose the returned SDK boolean.
    readback_error = None
    try:
        current = _document_status(ctx, {})
        if current.get('dataFileError'):
            readback_error = current['dataFileError']
            current = None
    except Exception as exc:
        current = None
        readback_error = {'type': type(exc).__name__, 'message': str(exc)}
    # An old, complete DataFile after saveAs is not evidence that the copy completed.
    target_observed = bool(current is not None and current['saved'] and current['fileId']
                           and current['fileId'] != original['fileId']
                           and current['fileName'] == name
                           and current['projectId'] == project.id
                           and current['folderId'] == folder.id)
    complete = bool(accepted and target_observed and not current['modified']
                    and current['isComplete'] is True)
    result = {'accepted': bool(accepted), 'pending': bool(accepted and not complete),
            'status': 'complete' if complete else ('pending' if accepted else 'failed'),
            'targetObserved': target_observed, 'original': original, 'current': current,
            'target': target, 'copyRequested': bool(original['saved']),
            'warning': _DOCUMENT_SAVE_WARNING}
    if readback_error is not None:
        result['readbackError'] = readback_error
    return result


def _document_save_native(ctx, data):
    """Issue exactly one save for the already-open, identity-pinned document.

    Publication is observed later through document.status; no post-save DataFile
    getter is required to report the native acceptance result.
    """
    _cad_fields(data, ('requestId', 'operationId', 'projectId', 'fileId', 'creationId', 'version', 'description'))
    doc = ctx.doc
    try:
        ctx.assert_identity()
        file = doc.dataFile
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
        accepted = doc.save(data['description'])
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


def _document_clear_items(collection, *, array=False, label='collection'):
    if collection is None:
        raise ValueError('document.clear audit unavailable: null collection')
    # Product.findAttributes returns an array (SWIG AttributeVector on some SDKs),
    # not an Attributes count/item collection. Select this contract explicitly;
    # never fall back to iteration after an SDK collection getter fails.
    if array or isinstance(collection, (list, tuple)):
        items = list(collection)
    else:
        count = collection.count
        if type(count) is not int or count < 0:
            raise ValueError('document.clear audit unavailable: invalid collection count')
        items = [collection.item(i) for i in range(count)]
    for index, item in enumerate(items):
        if item is None or item.isValid is not True:
            kind = _cad_type(item) if item is not None else '<null>'
            raise ValueError('document.clear audit unavailable: null/invalid entity at %s index %d type %s' %
                             (label, index, kind))
    return items


def _document_clear_guard(ctx, file_id):
    ctx.assert_identity()
    if (not isinstance(file_id, str) or not file_id or re.search(r'\s', file_id)
            or file_id.startswith('-') or ctx.doc_file_id != file_id):
        raise ValueError('document.clear requires --doc-file-id and data.fileId with the same exact DataFile.id')
    doc = ctx.doc
    if doc.isValid is not True or doc.isSaved is not True:
        raise ValueError('document.clear requires a valid previously saved cloud document')
    file = doc.dataFile
    if (file is None or file.isValid is not True or file.id != file_id
            or file.isComplete is not True or file.isReadOnly is not False):
        raise ValueError('document.clear requires the exact complete, writable cloud DataFile')
    if type(doc.isModified) is not bool:
        raise ValueError('document.clear modified status is unavailable')
    return {'fileId': file.id, 'saved': True, 'modified': doc.isModified,
            'isComplete': True, 'readOnly': False}


def _document_clear_audit(ctx):
    design, root, doc = ctx.design, ctx.root, ctx.doc
    items = _document_clear_items
    if design.isValid is not True or root.isValid is not True:
        raise ValueError('document.clear requires valid Design/root objects')
    if design.designType != adsk.fusion.DesignTypes.ParametricDesignType:
        raise ValueError('document.clear does not support direct designs')
    if design.isConfiguredDesign is not False or design.isConfiguration is not False:
        raise ValueError('document.clear does not support configured designs/configurations')
    if ctx.component != root or ctx.occurrence is not None or design.activeEditObject != root:
        raise ValueError('document.clear requires root scope and root edit target')
    products = items(doc.products)
    if len(products) != 1 or products[0] != design:
        raise ValueError('document.clear cannot certify non-Design products (including CAM/manufacturing)')
    if items(doc.documentReferences):
        raise ValueError('document.clear does not support external document references')
    for name in ('selectionSets', 'contactSets', 'namedViews'):
        if items(getattr(design, name)):
            raise ValueError('document.clear unsupported Design contents: ' + name)
    analyses = items(design.analyses)
    for analysis in analyses:
        if _cad_type(analysis) != 'SectionAnalysis':
            raise ValueError('document.clear unsupported Design contents: analyses type ' + _cad_type(analysis))
    timeline = design.timeline
    rows = items(timeline, label='timeline')
    if timeline.markerPosition != len(rows):
        raise ValueError('document.clear requires timeline marker at end for a complete audit')
    groups = items(timeline.timelineGroups)
    audit_rows, seen_groups = [], []
    for index, row in enumerate(rows):
        if row.isGroup is True:
            matches = [g for g in groups if g == row]
            if len(matches) != 1 or row.isSuppressed is not False:
                kind = _cad_type(row.entity) if row.entity is not None else '<no public entity>'
                raise ValueError('document.clear timeline index %d type %s: grouped entry unsupported' % (index, kind))
            members = items(matches[0], label='timeline group')
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
    components = items(design.allComponents)
    current_occurrences = [o for c in components for o in items(c.occurrences)]
    entities = []
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
                derived = entity.isDerived
            except RuntimeError as error:
                # Removed occurrence history has no current occPath. Audit its
                # local historical definition below instead of inventing a path.
                if (kind != 'Occurrence' or entity in current_occurrences
                        or 'InternalValidationError : occPath.valid()' not in str(error)
                        or entity.isReferencedComponent is not False
                        or entity.component.isValid is not True
                        or entity.component.parentDesign != design):
                    raise
            else:
                if derived is not False:
                    raise ValueError(location + 'derived timeline entity unsupported')
        entities.append(entity)
    # allComponents omits definitions only retained by removed history. They
    # still need the same full content audit before deleting the whole timeline.
    for entity in entities:
        owner = entity.component if _cad_type(entity) == 'Occurrence' else None
        if owner is not None and owner not in components:
            components.append(owner)
    for component in components:
        for occurrence in items(component.occurrences):
            if occurrence.component not in components:
                components.append(occurrence.component)
    if root not in components:
        raise ValueError('document.clear audit missing root component')
    for index, entity in enumerate(entities):
        if _cad_type(entity) == 'BaseFeature':
            if (getattr(entity, 'assemblyContext', 'unavailable') is not None
                    or entity.baseFeature is not None or entity.parentComponent not in components):
                raise ValueError('document.clear unsupported base feature ownership')
            for name in ('sketches', 'constructionPlanes', 'constructionAxes',
                         'constructionPoints', 'meshBodies', 'linkedFeatures'):
                if items(getattr(entity, name), array=True, label='base feature ' + name):
                    raise ValueError('document.clear unsupported base feature contents: ' + name)
            if any(b.isDerived is not False for b in items(entity.sourceBodies, array=True, label='base feature source bodies')):
                raise ValueError('document.clear derived base feature source bodies unsupported')
        if _cad_type(entity) == 'CutPasteBody' and (entity.isParametric is not True
                or entity.baseFeature is not None or entity.parentComponent not in components):
            raise ValueError('document.clear timeline index %d type CutPasteBody: '
                             'requires a local parametric feature outside a base feature' % index)
    counts = dict.fromkeys(_DOCUMENT_CLEAR_COMPONENT_COLLECTIONS, 0)
    snapshots = items(design.snapshots)
    if any(snapshot not in entities for snapshot in snapshots):
        raise ValueError('document.clear snapshot outside audited timeline')
    counts.update(timeline=len(rows), snapshots=len(snapshots), descendantComponents=len(components) - 1,
                  analyses=len(analyses), userParameters=0, modelParameters=0, attributes=0)
    canvases, graphics = [], []
    audited_entities = list(entities)
    for component in components:
        if component.parentDesign != design or component.flatPattern is not None:
            raise ValueError('document.clear unsupported component ownership/flat pattern')
        for name in _DOCUMENT_CLEAR_COMPONENT_COLLECTIONS:
            values = items(getattr(component, name))
            counts[name] += len(values)
            if values and name in ('meshBodies', 'decals', 'pmiAnnotations', 'userCoordinateSystems'):
                raise ValueError('document.clear unsupported component contents: ' + name)
            if name == 'canvases':
                if any(value.isDerived is not False for value in values):
                    raise ValueError('document.clear derived canvas unsupported')
                canvases.extend(values)
            elif name == 'customGraphicsGroups':
                graphics.extend(values)
            elif name == 'features':
                for feature in values:
                    if feature in entities:
                        continue
                    # Compound CutPasteBody entries expose internal Feature/RemoveFeature
                    # objects in Component.features. Their own timelineObject.entity can
                    # be the helper, so bind through the canonical public timeline index.
                    kind = _cad_type(feature)
                    binding = feature.timelineObject if kind in ('Feature', 'RemoveFeature') else None
                    index = binding.index if binding is not None and binding.isValid is True else None
                    removed_occurrence = (kind == 'RemoveFeature' and type(index) is int
                        and 0 <= index < len(rows) and rows[index].entity is not None
                        and _cad_type(rows[index].entity) == 'Occurrence'
                        and binding.entity == rows[index].entity
                        and rows[index].entity not in current_occurrences)
                    if (binding is None or binding.isValid is not True
                            or type(index) is not int or not 0 <= index < len(rows)
                            or binding.parentTimeline != timeline or (binding.entity != feature and not removed_occurrence)
                            or binding.isGroup is not False or binding.isSuppressed is not False
                            or rows[index].index != index or rows[index].parentTimeline != timeline
                            or (_cad_type(rows[index].entity) != 'CutPasteBody' and not removed_occurrence)
                            or feature.parentComponent != component or feature.assemblyContext is not None
                            or feature.isParametric is not True or feature.baseFeature is not None):
                        raise ValueError('document.clear feature type %s at timeline index %r: '
                                         'not a valid local parametric CutPasteBody helper' % (kind, index))
                    audited_entities.append(feature)
            elif name not in ('bRepBodies', 'meshBodies', 'decals', 'pmiAnnotations', 'userCoordinateSystems'):
                if any(value not in entities for value in values):
                    raise ValueError('document.clear contents outside audited timeline: ' + name)
            if name == 'occurrences':
                for occurrence in values:
                    if occurrence.isReferencedComponent is not False or occurrence.component not in components:
                        raise ValueError('document.clear does not support external occurrences')
            if name == 'bRepBodies':
                if any((value.baseFeature is not None and (value.baseFeature not in entities
                        or _cad_type(value.baseFeature) != 'BaseFeature'))
                       or value.isDerived is not False for value in values):
                    raise ValueError('document.clear direct/base/derived bodies unsupported')
    # History is audited across the entire Design. moveToComponent/CutPasteBody can
    # leave source features in root and result bodies in children. Do not require
    # co-location or read CutPasteBody.sourceBody (requires timeline rollback).
    # BRep bodies require supported history, including audited BRep-only base features.
    if counts['bRepBodies'] and not counts['features']:
        raise ValueError('document.clear cannot certify bodies without parametric features')
    parameters = items(design.userParameters)
    all_parameters = items(design.allParameters)
    if any(p not in all_parameters for p in parameters):
        raise ValueError('document.clear inconsistent parameter inventory')
    for parameter in all_parameters:
        if parameter not in parameters:
            if _cad_type(parameter) != 'ModelParameter':
                raise ValueError('document.clear unsupported parameter type')
            owner = parameter.createdBy
            if owner is not None and hasattr(owner, 'parentSketch'):
                owner = owner.parentSketch
            if owner not in audited_entities:
                raise ValueError('document.clear model parameter outside audited timeline')
    # Plan dependent-first user deletion without changing expressions or trying deletes.
    dependents = []
    for parameter in parameters:
        deps = items(parameter.dependentParameters)
        dependencies = items(parameter.dependencyParameters)
        if any(p not in all_parameters for p in deps) or any(p not in parameters for p in dependencies):
            raise ValueError('document.clear unsupported parameter relationships')
        if type(parameter.isDeletable) is not bool or (not deps and not parameter.isDeletable):
            raise ValueError('document.clear undeletable user parameter')
        dependents.append(deps)
    order = []
    while len(order) < len(parameters):
        ready = [p for p, deps in zip(parameters, dependents) if p not in order
                 and all(d not in parameters or d in order for d in deps)]
        if not ready:
            raise ValueError('document.clear cyclic user parameter relationships')
        order.extend(ready)
    attributes = items(design.findAttributes('', ''), array=True) + items(design.attributes) + items(doc.attributes)
    for entity in canvases + graphics + parameters + attributes:
        if not callable(entity.deleteMe):
            raise ValueError('document.clear required deletion API unavailable')
    counts.update(userParameters=len(parameters), modelParameters=len(all_parameters) - len(parameters),
                  attributes=len(attributes))
    return counts, order


def _document_clear(ctx, data):
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
    for analysis in _document_clear_items(ctx.design.analyses):
        _cad_require_result(analysis.deleteMe(), 'Clear section analysis')
    # Re-enumerate survivors: child component objects may already have been deleted by history.
    for component in _document_clear_items(ctx.design.allComponents):
        for name in ('canvases', 'customGraphicsGroups'):
            for entity in _document_clear_items(getattr(component, name)):
                _cad_require_result(entity.deleteMe(), 'Clear ' + name)
    for parameter in parameters:
        if parameter.isValid is not True or parameter.isDeletable is not True:
            raise RuntimeError('document.clear user parameter not deletable after history removal; inspect partial changes')
        _cad_require_result(parameter.deleteMe(), 'Clear user parameter')
    attributes = (_document_clear_items(ctx.design.findAttributes('', ''), array=True)
                  + _document_clear_items(ctx.design.attributes) + _document_clear_items(ctx.doc.attributes))
    for attribute in attributes:
        _cad_require_result(attribute.deleteMe(), 'Clear attribute')
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
