"""Private SDK operations used by the Node-owned references.refresh journal."""
import json
import sys
import time

_REFERENCES_NATIVE_REPORT_RESERVE_MS = 10000
_REFERENCES_NATIVE_MIN_POLL_MS = 1000


def _references_items(collection):
    try:
        return _cad_items(collection)
    except AttributeError:
        # Some Fusion vectors are iterable but expose no .count (notably
        # DerivedParameterVector); preserve their runtime members rather than
        # converting a supported getter into an unresolved binding.
        return list(collection)


def _references_file_identity(file):
    project = getattr(file, 'parentProject', None)
    result = {'fileId': getattr(file, 'id', None), 'fileName': getattr(file, 'name', None),
              'projectId': getattr(project, 'id', None)}
    for key in ('versionNumber', 'latestVersionNumber', 'isComplete', 'isReadOnly'):
        try: result[{'versionNumber': 'version', 'latestVersionNumber': 'latestVersion',
                     'isComplete': 'isComplete', 'isReadOnly': 'readOnly'}[key]] = getattr(file, key)
        except Exception as exc: result.setdefault('getterErrors', {})[key] = type(exc).__name__ + ': ' + str(exc)
    return result


def _references_document_identity(doc):
    file = getattr(doc, 'dataFile', None)
    if file is None:
        return {'name': doc.name, 'creationId': doc.creationId, 'fileId': None, 'projectId': None,
                'version': None, 'latestVersion': None, 'isComplete': None, 'readOnly': None}
    result = _references_file_identity(file)
    result.update(name=doc.name, creationId=doc.creationId)
    for key in ('isModified', 'isSaved', 'isUpToDate'):
        try: result[{'isModified': 'modified', 'isSaved': 'saved', 'isUpToDate': 'isUpToDate'}[key]] = bool(getattr(doc, key))
        except Exception as exc: result.setdefault('getterErrors', {})[key] = type(exc).__name__ + ': ' + str(exc)
    return result


def _references_walk_files(folder, visited=None):
    visited = visited if visited is not None else set()
    key = getattr(folder, 'id', None) or str(id(folder))
    if key in visited:
        return
    visited.add(key)
    for file in _references_items(folder.dataFiles):
        yield file
    for child in _references_items(folder.dataFolders):
        for file in _references_walk_files(child, visited):
            yield file


def _references_project_file(app, project_id, file_id, version=None):
    projects = [project for project in _references_items(app.data.dataProjects) if project.id == project_id]
    if len(projects) != 1:
        raise ValueError('projectId must match exactly one accessible project')
    lookup = getattr(app.data, 'findFileById', None)
    if callable(lookup):
        file = lookup(file_id)
        if file is None or file.id != file_id or file.parentProject.id != project_id:
            raise ValueError('fileId did not resolve in the allowed project')
        # Resolve latest independently of the reference-buffer DataFile. Do not
        # enumerate every unrelated worker folder for every edge/readback.
        latest = file.latestVersion
        if latest is None or latest.id != file_id or latest.parentProject.id != project_id:
            raise ValueError('latest DataFile identity differs from the requested file/project')
        matches = [latest]
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
    exact = []
    for candidate in versions:
        try:
            candidate_project = candidate.parentProject
            if (candidate.id == file_id and int(candidate.versionNumber) == version and
                    candidate_project is not None and candidate_project.id == project_id):
                exact.append(candidate)
        except Exception:
            continue
    if len(exact) != 1:
        raise ValueError('DataFile.versions must expose exactly one matching fileId/version; found %d; latest/name fallback refused' %
                         len(exact))
    return exact[0]


def _references_target_file(app, project_id, file_id, version, data_file_hint=None):
    if data_file_hint is not None:
        try:
            project = data_file_hint.parentProject
            if (data_file_hint.id == file_id and project is not None and project.id == project_id and
                    int(data_file_hint.versionNumber) == version):
                return data_file_hint
        except Exception:
            pass
    return _references_project_file(app, project_id, file_id, version)


def _references_open_matches(app, file_id, project_id, version=None):
    rows = []
    for doc in _references_items(app.documents):
        file = getattr(doc, 'dataFile', None)
        if file is None or file.id != file_id:
            continue
        parent = getattr(file, 'parentProject', None)
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


def _references_open_file(app, project_id, file_id, version, lifecycle, opened):
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


def _references_own_components(root):
    pending, seen = [root], set()
    while pending:
        component = pending.pop()
        token = getattr(component, 'entityToken', None)
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


def _references_attribute_rows(entity, kind, namespace):
    rows = []
    try:
        attributes = _references_items(entity.attributes)
        for attribute in attributes:
            rows.append({'kind': kind, 'namespace': namespace,
                         'group': attribute.groupName, 'name': attribute.name, 'value': attribute.value})
    except Exception as error:
        return [], {'kind': kind, 'namespace': namespace, 'status': 'unknown',
                    'error': type(error).__name__ + ': ' + str(error)}
    return rows, {'kind': kind, 'namespace': namespace, 'status': 'complete', 'count': len(rows)}


def _references_vec(point):
    return [float(point.x), float(point.y), float(point.z)]


def _references_native_occurrence_token(native):
    if native is None:return None
    try:return getattr(native,'entityToken',None)
    except RuntimeError as error:
        if 'Tokens can only be created for proxies whose top-level parent is the root component' in str(error):return None
        raise


def _references_metadata(design, root):
    attrs, coverage = [], []
    components = list(_references_own_components(root))
    component_ids = {getattr(component, 'entityToken', None) for component in components}
    body_rows, occurrence_rows, consumed_rows = [], [], []
    for component in components:
        token = getattr(component, 'entityToken', None)
        rows, cover = _references_attribute_rows(component, 'component', token)
        attrs.extend(rows); coverage.append(cover)
        for body in _references_items(component.bRepBodies):
            key = getattr(body, 'entityToken', None)
            box = body.boundingBox
            body_rows.append({'componentToken': token, 'bodyToken': key, 'name': getattr(body, 'name', None),
                              'isSolid': bool(body.isSolid), 'isVisible': bool(getattr(body, 'isLightBulbOn', True)),
                              'faces': int(body.faces.count), 'edges': int(body.edges.count),
                              'volumeInternal': float(body.volume),
                              'boundsInternal': [_references_vec(box.minPoint), _references_vec(box.maxPoint)],
                              'materialId': getattr(getattr(body, 'material', None), 'id', None),
                              'appearanceId': getattr(getattr(body, 'appearance', None), 'id', None)})
            rows, cover = _references_attribute_rows(body, 'body', str(key))
            attrs.extend(rows); coverage.append(cover)
        for feature in _references_items(component.features):
            kind = _cad_type(feature)
            if kind in ('CombineFeature', 'CutPasteBody', 'RectangularPatternFeature', 'CircularPatternFeature', 'PathPatternFeature'):
                refs = []
                for property_name in ('targetBody', 'toolBodies', 'participantBodies', 'sourceBody', 'inputEntities', 'seedEntity'):
                    try:
                        value = getattr(feature, property_name)
                    except (AttributeError, RuntimeError):
                        continue
                    if value is None:
                        continue
                    try:
                        members = _references_items(value) if hasattr(value, 'count') else [value]
                    except Exception:
                        members = []
                    for member in members:
                        try:
                            owner = getattr(member, 'parentComponent', None) or getattr(getattr(member, 'body', None), 'parentComponent', None)
                            refs.append({'property': property_name, 'token': getattr(member, 'entityToken', None),
                                         'ownerToken': getattr(owner, 'entityToken', None),
                                         'ownerIsLocal': owner is None or getattr(owner, 'entityToken', None) in component_ids})
                        except Exception:
                            refs.append({'property': property_name, 'status': 'unknown'})
                consumed_rows.append({'featureToken': getattr(feature, 'entityToken', None), 'type': kind,
                                       'ownerToken': token, 'consumedRefs': refs,
                                       'contextVerified': bool(refs) and all(row.get('ownerIsLocal') is True for row in refs)})
    for occurrence in _references_items(root.allOccurrences):
        token = getattr(occurrence, 'entityToken', None)
        component = occurrence.component
        is_derived = bool(getattr(occurrence, 'isDerived', False))
        is_referenced = bool(getattr(occurrence, 'isReferencedComponent', False))
        native = getattr(occurrence, 'nativeObject', None)
        native_token = _references_native_occurrence_token(native)
        occurrence_rows.append({'token': token, 'path': occurrence.fullPathName,
                                'componentToken': getattr(component, 'entityToken', None),
                                'componentName': getattr(component, 'name', None),
                                'isDerived': is_derived, 'isReferencedComponent': is_referenced,
                                'transform': list(occurrence.transform2.asArray()),
                                'nativeToken': native_token,
                                **({'nativeAttributeLocator':'nativeObjectOf:'+str(token)} if native is not None and native_token is None else {}),
                                'contextKind': 'proxy' if getattr(occurrence, 'assemblyContext', None) is not None else 'native'})
        rows, cover = _references_attribute_rows(occurrence, 'nativeOccurrence', token)
        attrs.extend(rows); coverage.append(cover)
        if native is not None:
            rows, cover = _references_attribute_rows(native, 'nativeObject', native_token or 'nativeObjectOf:'+str(token))
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


def _references_occurrence_states(metadata):
    rows = metadata.get('occurrences', [])
    if any(not row.get('token') for row in rows):
        return None
    return sorted([{'token': row['token'], 'nativeToken': row.get('nativeToken'),
                    'transform': row.get('transform'), 'contextKind': row.get('contextKind'),
                    'isDerived': row.get('isDerived'),
                    'isReferencedComponent': row.get('isReferencedComponent')}
                   for row in rows], key=lambda row: row['token'])


def _references_internal_unit(parameter):
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


def _references_parameter_value(parameter, units_manager):
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


def _references_edge_version(doc, edge, source_id, forward_count, app=None, allowed_project_ids=None):
    version = None
    error = None
    try:
        version = int(edge.version)
    except Exception as exc:
        error = str(exc)
    source_file = getattr(edge, 'dataFile', None)
    latest = None
    latest_source = None
    latest_error = None
    file_version = None
    source_project = None
    if source_file is not None:
        try: file_version = int(source_file.versionNumber)
        except Exception: pass
        try: source_project = source_file.parentProject.id
        except Exception: pass
        allowed_projects = set(allowed_project_ids if allowed_project_ids is not None else
                               [getattr(getattr(getattr(doc, 'dataFile', None), 'parentProject', None), 'id', None)])
        if app is not None and source_project in allowed_projects:
            try:
                current_file = _references_project_file(app, source_project, source_id)
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
        matches = []
        try:
            for child in _references_items(doc.dataFile.childReferences):
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


def _references_forward_inventory(ctx):
    refs=_references_items(ctx.doc.documentReferences)
    features=[(component,feature) for component in _references_own_components(ctx.root)
              for feature in _references_items(component.features.deriveFeatures)
              if not bool(getattr(feature,'isSuppressed',False))]
    linked_sources={o.documentReference.dataFile.id for o in _references_items(ctx.root.allOccurrences)
                    if getattr(o,'isReferencedComponent',False)}
    kept=[];echoes={}
    for ref in refs:
        correlated=None
        try:
            source=ref.dataFile
            matches=[feature for component,feature in features if feature.documentReference.dataFile.id==source.id]
            same_source=[other for other in refs if other.dataFile.id==source.id]
            # A file ID alone is not proof. Keep self edges, ordinary occurrence
            # uses, multiple references/features/pins, and unknown contexts.
            if (source.id!=ctx.doc.dataFile.id and source.id not in linked_sources and
                    len(matches)==1 and len(same_source)==1 and
                    not getattr(ref,'entityToken',None) and not getattr(ref,'occurrence',None)):
                feature=matches[0];derived=feature.documentReference
                referenced=ref.referencedDocument
                if (getattr(feature,'entityToken',None) and ref.parentDocument==ctx.doc and derived.parentDocument==ctx.doc and
                        referenced is not None and referenced==derived.referencedDocument and
                        source.parentProject.id==derived.dataFile.parentProject.id and
                        int(source.versionNumber)==int(derived.dataFile.versionNumber) and
                        int(ref.version)==int(derived.version) and int(ref.version)>0):
                    correlated=feature.entityToken
                    echoes[correlated]={'sourceFileId':source.id,'version':int(ref.version),
                        'ownerCreationId':ctx.doc.creationId,'referencedCreationId':referenced.creationId,
                        'evidence':'sameOwnerAndReferencedDocumentAndPin;noOrdinaryOccurrenceUse'}
        except Exception:
            # Missing optional correlation evidence never discards an edge.
            correlated=None
        if correlated is None:kept.append(ref)
    return {'linked':kept,'derives':features,'deriveCollectionEchoes':echoes}


def _references_owned_derives(ctx, allowed_project_ids=None, inventory=None):
    allowed_project_ids = set(allowed_project_ids if allowed_project_ids is not None else
                              [ctx.doc.dataFile.parentProject.id])
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
        component_token = getattr(component, 'entityToken', None)
        token = getattr(feature, 'entityToken', None)
        ref = feature.documentReference
        source_file = ref.dataFile
        key = (source_file.id, token or str(id(feature)))
        if key in visited:
            continue
        visited.add(key)
        version_info = _references_edge_version(ctx.doc, ref, source_file.id,
            forward_counts.get(source_file.id, 0), ctx.app, allowed_project_ids)
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
            source_parameter_file = parent.dataFile.id
            source_parameter_version = int(parent.dataFile.versionNumber)
        except Exception as exc:
            source_params = []
            source_error = type(exc).__name__ + ': ' + str(exc)
        else:
            source_error = None
        derived_params = []
        try:
            for parameter in _references_items(ctx.design.derivedParameters):
                if parameter.deriveFeature == feature:
                    derived_params.append(_references_parameter_value(parameter, ctx.design.unitsManager))
        except Exception as exc:
            source_error = source_error or ('derivedParameters: ' + type(exc).__name__ + ': ' + str(exc))
        owner_paths = [occ.fullPathName for occ in _references_items(ctx.root.allOccurrences)
                       if occ.component == component]
        identity_part = token or (str(component_token) + ':' + source_file.id + ':' + str(feature.name))
        edge_id = _references_edge_id(ctx.doc.dataFile.id, 'derive', source_file.id, identity_part)
        rows.append({'edgeId': edge_id, 'edgeIdentityUnique': bool(token), 'kind': 'derive',
                     'ownerFileId': ctx.doc.dataFile.id,
                     'ownerProjectId': ctx.doc.dataFile.parentProject.id,
                     'ownerContext': {'componentToken': component_token,
                         'componentName': component.name, 'occurrencePaths': owner_paths},
                     'sourceFileId': source_file.id, 'sourceProjectId': source_file.parentProject.id,
                     'featureName': feature.name, 'featureToken': token,
                     'suppressed': False, 'selfReference': source_file.id == ctx.doc.dataFile.id,
                     **version_info, 'sourceParameters': source_params,
                      'derivedParameters': derived_params, 'sourceDocumentModified': source_modified,
                      'sourceParameterFileId': source_parameter_file, 'sourceParameterVersion': source_parameter_version,
                      'bindingReadError': source_error, '_sourceDataFile': source_file,
                      **({'collectionEcho':inventory['deriveCollectionEchoes'][token]}
                         if token in inventory['deriveCollectionEchoes'] else {})})
    return rows


def _references_edge_id(owner_file_id, kind, source_file_id, identity_part):
    import hashlib
    digest = hashlib.sha256((str(owner_file_id) + '\0' + str(kind) + '\0' + str(source_file_id) + '\0' + str(identity_part)).encode('utf-8')).hexdigest()
    return 'edge:' + digest


def _references_public_edges(edges):
    return [{key: value for key, value in edge.items() if not key.startswith('_')} for edge in edges]


def _references_linked_edges(ctx, allowed_project_ids=None, inventory=None):
    allowed_project_ids = set(allowed_project_ids if allowed_project_ids is not None else
                              [ctx.doc.dataFile.parentProject.id])
    inventory=inventory if inventory is not None else _references_forward_inventory(ctx)
    refs = inventory['linked']
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
    raw = []
    for index, ref in enumerate(refs):
        source_file = ref.dataFile
        try: token = getattr(ref, 'entityToken', None)
        except Exception: token = None
        try: owner_context = getattr(ref, 'occurrence', None)
        except Exception: owner_context = None
        context_token = getattr(owner_context, 'entityToken', None) if owner_context else None
        context_path = getattr(owner_context, 'fullPathName', None) if owner_context else None
        identity_part = token or context_token or source_file.id
        raw.append({'ref': ref, 'sourceFileId': source_file.id, 'identityPart': identity_part,
                    'ownerContext': {'componentToken': getattr(ctx.root, 'entityToken', None),
                                     'occurrenceToken': context_token, 'occurrencePath': context_path}})
    counts = {}
    for row in raw:
        key = (row['sourceFileId'], row['identityPart'])
        counts[key] = counts.get(key, 0) + 1
    rows = []
    for row in raw:
        ref = row['ref']
        source_id = row['sourceFileId']
        version_info = _references_edge_version(ctx.doc, ref, source_id,
            forward_counts.get(source_id, 0), ctx.app, allowed_project_ids)
        unique = counts[(source_id, row['identityPart'])] == 1
        rows.append({'edgeId': _references_edge_id(ctx.doc.dataFile.id, 'linked', source_id, row['identityPart']),
                      'edgeIdentityUnique': unique, 'kind': 'linked',
                      'isOccurrenceReference': any(getattr(o,'isReferencedComponent',False) and
                          o.documentReference.dataFile.id==source_id for o in _references_items(ctx.root.allOccurrences)),
                     'ownerFileId': ctx.doc.dataFile.id, 'ownerProjectId': ctx.doc.dataFile.parentProject.id,
                      'ownerContext': row['ownerContext'], 'sourceFileId': source_id,
                      'sourceProjectId': getattr(getattr(ref.dataFile, 'parentProject', None), 'id', None),
                      'selfReference': source_id == ctx.doc.dataFile.id, 'suppressed': False,
                      **version_info, '_sourceDataFile': ref.dataFile})
    return rows


def _references_doc_snapshot(ctx, allowed_project_ids, visited_paths, caller_namespaces=None):
    doc = ctx.doc
    file = doc.dataFile
    design = ctx.design
    identity = _references_document_identity(doc)
    health = ctx.call('history.check', {})
    metadata = _references_metadata(design, ctx.root)
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
        if caller_namespaces and edge['edgeId'] in caller_namespaces:
            edge['callerNamespace'] = caller_namespaces[edge['edgeId']]
            edge['ownerContext'] = dict(edge.get('ownerContext', {}), callerNamespace=caller_namespaces[edge['edgeId']])
        edge['scopeProjectAllowed'] = edge['sourceProjectId'] in allowed_project_ids
    parameters = []
    for parameter in _references_items(design.allParameters):
        try:
            parameters.append(_references_parameter_value(parameter, design.unitsManager))
        except Exception as exc:
            parameters.append({'name': str(getattr(parameter, 'name', '<unknown>')),
                               'status': 'unknown', 'error': type(exc).__name__ + ': ' + str(exc)})
    design_type = getattr(design, 'designType', None)
    marker = int(design.timeline.markerPosition)
    timeline_count = int(design.timeline.count)
    bad_contexts = [row for row in metadata['consumedBodies'] if row.get('contextVerified') is not True]
    owner_unknown = any(row.get('ownerUnknown') is True for row in health.get('timeline', []))
    history_healthy = health.get('status') == 'pass' and health.get('healthy') is True and not owner_unknown
    metadata_coverage = metadata['metadataCoverage']
    metadata_complete = all(value == 'complete' for value in metadata_coverage.values())
    version = int(file.versionNumber)
    latest = identity.get('latestVersion')
    project_id = file.parentProject.id
    if not isinstance(latest, int):
        getter_errors = identity.setdefault('getterErrors', {})
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
            'unhealthy': [row for row in health.get('timeline', []) if row.get('state') != 'HealthyFeatureHealthState' and not row.get('duplicate')],
            'bindingReadErrors': [edge for edge in derives if edge.get('bindingReadError')],
            'coverage': {'directReferences': len(linked), 'ownedUnsuppressedDerives': len(derives),
                         'suppressedDerivesExcluded': sum(1 for component in _references_own_components(ctx.root)
                           for feature in _references_items(component.features.deriveFeatures) if bool(feature.isSuppressed)),
                         'ownedComponents': metadata['components'], 'bodyDefinitions': len(metadata['bodies']),
                         'occurrences': len(metadata['occurrences']), 'metadataComplete': metadata_complete}}


def _references_collect_graph(data):
    app = adsk.core.Application.get()
    project_id, root_id, root_version = data['root']['projectId'], data['root']['fileId'], data['root']['version']
    lifecycle = data.get('lifecycle', 'existingOnly')
    allowed = set(data.get('allowedProjectIds', [project_id]))
    max_files = data.get('maxFiles', 100)
    if app.userInterface.activeCommand not in ('', 'SelectCommand'):
        return {'schemaVersion': 1, 'root': data['root'], 'documents': [], 'edges': [],
                'graphComplete': False, 'getterErrors': [], 'lifecycleEffects': [],
                'coverage': {'reachableDocuments': 0, 'reachableEdges': 0},
                'environment': {'fusionVersion': getattr(app, 'version', None), 'os': sys.platform},
                'blocked': 'interactiveCommandActive', 'activeCommand': app.userInterface.activeCommand}
    opened = []
    by_identity = {}
    edges = []
    getter_errors = []
    lifecycle_effects = []
    errors = []
    graph_complete = True
    queue = [(root_id, project_id, root_version, None)]
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
            stub = {'fileId': file_id, 'projectId': owner_project, 'version': version,
                    'latestVersion': None, 'available': False, 'blockedReason': 'duplicateOpenEditor'}
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
                if doc.dataFile.id != file_id or doc.dataFile.versionNumber != version or doc.dataFile.parentProject.id != owner_project:
                    raise ValueError('opened document identity/version differs from pinned DataFile')
                # A DataFile enumerated from a closed project folder may report
                # incomplete until Fusion resolves it into a document. Trust
                # only the exact opened document's cloud state, never its name.
                if doc.dataFile.isComplete is not True or doc.dataFile.isReadOnly is not False:
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
                             doc_file_id=file_id, resolved_doc=doc)
            if ctx.doc.dataFile.versionNumber != version:
                raise ValueError('opened revision changed during graph scan')
            observed = _references_doc_snapshot(ctx, allowed, {item.creationId for item in opened},
                                                data.get('callerNamespaces', {}))
            row = observed['document']
            row['openedByRequest'] = opened_by_request
            row['version'] = version
            row['reachable'] = True
            row['key'] = key
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
                    getter_errors.append({'edgeId': edge['edgeId'], 'sourceFileId': edge['sourceFileId'],
                                          'error': edge['getterError']})
                    # The edge is retained as unresolved; no guessed latest traversal.
                    continue
                pin = next((row for row in data.get('pins', []) if row['edgeId'] == edge['edgeId']), None)
                if pin:
                    target_version = pin['version']
                elif data.get('policy', 'preserve') == 'latest' and edge['latestVersion'] is not None:
                    target_version = edge['latestVersion']
                else:
                    target_version = edge['baselineVersion']
                # The edge's embedded DataFile may be an older cached object.
                # Preserve its version as the baseline, but acquire the exact
                # independently selected target version during traversal.
                source_file = edge.get('_sourceDataFile')
                target_key = (edge['sourceFileId'], target_version)
                if target_key not in by_identity and not any(item[0] == target_key[0] and item[2] == target_key[1] for item in queue):
                    queue.append((edge['sourceFileId'], edge['sourceProjectId'], target_version, source_file))
        except Exception as exc:
            graph_complete = False
            by_identity[key] = {'fileId': file_id, 'projectId': owner_project, 'version': version,
                'latestVersion': None, 'available': False, 'openedByRequest': opened_by_request,
                'blockedReason': 'auditFailed', 'auditError': type(exc).__name__ + ': ' + str(exc)}
            errors.append({'fileId': file_id, 'status': 'failed', 'message': type(exc).__name__ + ': ' + str(exc)})
    # Collapse document versions to a single row only when unambiguous. Multiple
    # deliberate versions stay in edges and cause the planner to block mass update.
    docs_by_id = {}
    for (file_id, version), row in by_identity.items():
        current = docs_by_id.get(file_id)
        if current is None:
            docs_by_id[file_id] = row
        elif current.get('version') != version:
            current['versionConflict'] = sorted({current.get('version'), version})
            current['available'] = False
            current['blockedReason'] = 'multiplePinnedVersions'
            graph_complete = False
    if opened:
        for doc in reversed(opened):
            file_id = None
            creation_id = None
            try:
                file_id = doc.dataFile.id
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
    public_edges = _references_public_edges(edges)
    return {'schemaVersion': 1, 'root': data['root'], 'documents': list(docs_by_id.values()),
            'edges': public_edges, 'graphComplete': graph_complete, 'getterErrors': getter_errors,
            'lifecycleEffects': lifecycle_effects,
            'coverage': {'reachableDocuments': len(docs_by_id), 'reachableEdges': len(edges),
                         'availableDocuments': sum(row.get('available') is True for row in docs_by_id.values()),
                         'unavailableDocuments': sum(row.get('available') is not True for row in docs_by_id.values()),
                         'independentErrors': errors},
            'environment': {'fusionVersion': getattr(app, 'version', None), 'os': sys.platform,
                            'backend': 'selected fmcad backend', 'locale': None, 'adapterQualification': None}}


def _references_current_edges(ctx, allowed_project_ids=None):
    # sourceDesign can load a cold Derive's document reference lazily. Use the
    # same observation order as graph capture, or preflight sees a false drift.
    inventory=_references_forward_inventory(ctx)
    derives = _references_owned_derives(ctx, allowed_project_ids, inventory)
    return _references_linked_edges(ctx, allowed_project_ids, inventory) + derives


def _references_feature_health(ctx):
    result = ctx.call('history.check', {})
    return {'healthy': result.get('healthy') is True and result.get('status') == 'pass',
            'status': result.get('status'), 'coverage': result.get('coverage'),
            'timeline': result.get('timeline', []), 'repairRequired': result.get('healthy') is not True}


def _references_edge_snapshot_matches(current_edges, plan_edges, file_id, effective_targets=None, prior_edges=None):
    effective_targets = effective_targets or {}
    baseline = {edge['edgeId']: edge for edge in (prior_edges if prior_edges is not None else plan_edges)
                if edge.get('ownerFileId') == file_id}
    expected = {edge['edgeId']: edge for edge in plan_edges if edge.get('ownerFileId') == file_id}
    current = {edge['edgeId']: edge for edge in current_edges if edge.get('ownerFileId') == file_id}
    if len(current) != sum(edge.get('ownerFileId') == file_id for edge in current_edges) or set(current) != set(baseline):
        return False, 'forwardEdgeSetDrift'
    for edge_id, row in current.items():
        plan_row = expected.get(edge_id)
        previous_row = baseline[edge_id]
        if plan_row is None or row.get('sourceFileId') != plan_row.get('sourceFileId') or row.get('kind') != plan_row.get('kind'):
            return False, 'forwardEdgeIdentityDrift'
        expected_version = previous_row.get('baselineVersion')
        dependency_receipt_version = effective_targets.get(edge_id)
        if row.get('baselineVersion') != expected_version and row.get('baselineVersion') != dependency_receipt_version:
            return False, 'forwardEdgeVersionDrift'
        expected_latest = effective_targets.get(edge_id, plan_row.get('latestVersion'))
        if expected_latest is not None and row.get('latestVersion') != expected_latest:
            return False, 'unrelatedSourceVersionDrift'
        if row.get('versionSource') == 'unresolved':
            return False, 'referenceVersionUnresolved'
    return True, None


def _references_binding_checks(ctx, edge_id, bindings, expected_source_parameters=None,
                               allowed_project_ids=None):
    selected = [binding for binding in bindings if binding['edgeId'] == edge_id]
    if not selected:
        return {'status': 'unverified', 'passed': False, 'bindings': [],
                'reason': 'explicit sourceParameter-to-consumerAlias/nativeDerivedParameter mapping required'}
    edges = _references_owned_derives(ctx, allowed_project_ids)
    edge = next((item for item in edges if item['edgeId'] == edge_id), None)
    if edge is None:
        return {'status': 'unresolved', 'passed': False, 'bindings': [], 'reason': 'derive edge not present in owned unsuppressed history'}
    results = []
    for binding in selected:
        source = [row for row in edge['sourceParameters'] if row['name'] == binding['sourceParameter']]
        if len(source) != 1:
            results.append({'sourceParameter': binding['sourceParameter'], 'status': 'unresolved',
                            'reason': 'source parameter is missing or ambiguous'})
            continue
        independent = [row for row in (expected_source_parameters or {}).get(edge['sourceFileId'], [])
                       if row.get('name') == binding['sourceParameter']]
        if len(independent) != 1:
            results.append({'edgeId': edge_id, 'sourceParameter': binding['sourceParameter'],
                            'status': 'unresolved', 'reason': 'independent saved source parameter is unavailable'})
            continue
        target_name = binding.get('nativeDerivedParameter')
        if not target_name and binding.get('consumerAlias'):
            alias_rows = [parameter for parameter in _references_items(ctx.design.allParameters)
                          if parameter.name == binding['consumerAlias']]
            if len(alias_rows) == 1:
                alias = alias_rows[0]
                dependencies = None
                try: dependencies = [str(parameter.name) for parameter in _references_items(alias.dependencyParameters)]
                except Exception: pass
                candidates = [row['name'] for row in edge['derivedParameters']
                              if alias.expression == row['name'] or dependencies is not None and row['name'] in dependencies]
                if len(candidates) == 1:
                    target_name = candidates[0]
        target = [row for row in edge['derivedParameters'] if row['name'] == target_name] if target_name else []
        if target_name and len(target) != 1:
            results.append({'sourceParameter': binding['sourceParameter'], 'nativeDerivedParameter': target_name,
                            'status': 'unresolved', 'reason': 'exact native DerivedParameter name is missing or ambiguous'})
            continue
        source_row = source[0]
        target_row = target[0] if target else None
        value_matches = bool(target_row and source_row['internal_unit'] != 'text' and
            source_row['internal_unit'] == target_row['internal_unit'] == independent[0].get('internal_unit') and
            abs(source_row['internal_value'] - target_row['internal_value']) <=
            1e-9 * max(1.0, abs(source_row['internal_value'])) and
            abs(independent[0]['internal_value'] - target_row['internal_value']) <=
            1e-9 * max(1.0, abs(independent[0]['internal_value'])))
        alias_status = 'notRequested'
        if binding.get('consumerAlias'):
            aliases = [parameter for parameter in _references_items(ctx.design.allParameters)
                       if parameter.name == binding['consumerAlias']]
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


def _references_preflight(ctx, data):
    doc = ctx.doc
    file = doc.dataFile
    design = ctx.design
    allowed_project_ids = set(data.get('allowedProjectIds') or [data['projectId']])
    if doc.isValid is not True or file is None or file.id != data['fileId'] or file.parentProject.id != data['projectId']:
        return {'status': 'blocked', 'reason': 'identityMismatch'}
    current = _references_document_identity(doc)
    health = _references_feature_health(ctx)
    metadata = _references_metadata(design, ctx.root)
    current.update(timelineAtEnd=design.timeline.markerPosition == design.timeline.count,
        pendingSnapshot=bool(design.snapshots.hasPendingSnapshot), health=health,
        metadataCoverage=metadata['metadataCoverage'], metadataComplete=metadata['metadataComplete'],
        consumedBodiesVerified=metadata['consumedBodiesVerified'], parameters=_references_parameters(design))
    return {'status': 'complete', 'document': current,
            'edges': _references_public_edges(_references_current_edges(ctx, allowed_project_ids)),
            'metadata': metadata, 'lifecycleEffects': []}


def _references_update(ctx, data):
    if data.get('confirm') is not True:
        raise ValueError('references.refresh apply update step requires the immutable-plan confirmation')
    preflight = _references_preflight(ctx, {'fileId': data['fileId'], 'projectId': data['projectId'],
                                            'allowedProjectIds': data.get('allowedProjectIds')})
    if preflight['status'] != 'complete': return preflight
    before = preflight
    edge_state_ok, edge_state_reason = _references_edge_snapshot_matches(before['edges'], data['planEdges'],
        data['fileId'], data.get('effectiveTargets'))
    if not edge_state_ok:
        return {'status': 'blocked', 'reason': edge_state_reason, 'before': before}
    if (before['document']['modified'] or before['document']['readOnly'] or not before['document']['isComplete'] or
            not before['document']['timelineAtEnd'] or before['document']['pendingSnapshot'] or
            not before['document']['health']['healthy']):
        return {'status': 'blocked', 'reason': 'preconditionsChanged', 'before': before}
    edge_ids = set(data['edgeIds'])
    current_edges = before['edges']
    selected = [edge for edge in current_edges if edge['edgeId'] in edge_ids]
    if len(selected) != len(edge_ids) or any(edge['kind'] not in ('linked', 'derive') or edge['selfReference'] for edge in selected):
        return {'status': 'blocked', 'reason': 'plannedForwardEdgeMissingOrUnsupported', 'before': before}
    old_parameters = _references_user_parameter_state(ctx.design, data.get('parameterBindings', []))
    before_metadata = before.get('metadata', {})
    requested_method = data['method']
    try:
        if requested_method == 'DocumentReference.getLatestVersion':
            for edge in selected:
                if edge['kind'] != 'linked':
                    return {'status': 'blocked', 'reason': 'edgeScopedMethodDoesNotSupportDerive'}
                target_version = data.get('effectiveTargets', {}).get(edge['edgeId'],
                    next((row.get('targetVersion') for row in data['planEdges'] if row['edgeId'] == edge['edgeId']), None))
                if target_version is not None and edge.get('baselineVersion') == target_version:
                    continue
                ref = _references_find_live_linked(ctx.doc, edge['edgeId'])
                if not ref:
                    return {'status': 'blocked', 'reason': 'edgeIdentityChanged'}
                if ref.getLatestVersion() is not True:
                    return {'status': 'unknown', 'outcome': 'unknown', 'reason': 'getLatestVersion returned false', 'before': before}
        elif requested_method == 'document.updateAllReferences':
            if ctx.design.timeline.markerPosition != ctx.design.timeline.count or ctx.design.snapshots.hasPendingSnapshot:
                return {'status': 'blocked', 'reason': 'historyOrPendingSnapshotChanged'}
            if ctx.doc.updateAllReferences() is not True:
                return {'status': 'unknown', 'outcome': 'unknown', 'reason': 'updateAllReferences did not return true', 'before': before}
        else:
            return {'status': 'blocked', 'reason': 'unsupportedPlannedMethod'}
    except Exception as exc:
        return {'status': 'unknown', 'outcome': 'unknown', 'reason': type(exc).__name__ + ': ' + str(exc), 'before': before}
    try:
        if ctx.design.computeAll() is not True:
            return {'status': 'unknown', 'outcome': 'unknown', 'reason': 'computeAll returned false after reference update', 'before': before}
    except Exception as exc:
        return {'status': 'unknown', 'outcome': 'unknown', 'reason': 'computeAll: ' + type(exc).__name__ + ': ' + str(exc), 'before': before}
    after = _references_preflight(ctx, {'fileId': data['fileId'], 'projectId': data['projectId'],
                                        'allowedProjectIds': data.get('allowedProjectIds')})
    selected_after = [edge for edge in after.get('edges', []) if edge['edgeId'] in edge_ids]
    required = {edge['edgeId']: data.get('effectiveTargets', {}).get(edge['edgeId'], edge.get('targetVersion'))
                for edge in data['planEdges'] if edge['edgeId'] in edge_ids}
    edge_current = len(selected_after) == len(edge_ids) and all(
        required.get(edge['edgeId']) == edge.get('baselineVersion') for edge in selected_after)
    requested_bindings = [binding for binding in data.get('parameterBindings', []) if binding['edgeId'] in edge_ids]
    expected_source_parameters = data.get('expectedSourceParameters', {})
    if requested_bindings:
        binding_results = [_references_binding_checks(ctx, edge['edgeId'], requested_bindings,
            expected_source_parameters, data.get('allowedProjectIds'))
                           for edge in selected_after if edge['kind'] == 'derive']
        bindings_pass = bool(binding_results) and all(row['passed'] for row in binding_results)
    else:
        bindings_pass = not any(edge['kind'] == 'derive' and edge['derivedParameters'] for edge in selected_after)
        binding_results = []
    history = after.get('document', {}).get('health', {})
    unchanged_local_parameters = old_parameters == _references_user_parameter_state(ctx.design, data.get('parameterBindings', []))
    after_metadata = after.get('metadata', {})
    attrs_before = sorted(before_metadata.get('attributes', []), key=lambda row: (row.get('kind',''), str(row.get('namespace')), row.get('group',''), row.get('name','')))
    attrs_after = sorted(after_metadata.get('attributes', []), key=lambda row: (row.get('kind',''), str(row.get('namespace')), row.get('group',''), row.get('name','')))
    occurrence_before = _references_occurrence_states(before_metadata)
    occurrence_after = _references_occurrence_states(after_metadata)
    metadata_preserved = attrs_before == attrs_after and occurrence_before is not None and occurrence_before == occurrence_after
    scope_pass = all(edge['edgeId'] in edge_ids or edge.get('baselineVersion') == next(
        (before_edge['baselineVersion'] for before_edge in before['edges'] if before_edge['edgeId'] == edge['edgeId']), None)
        for edge in after.get('edges', []))
    checks = {'intendedReferencesCurrent': edge_current, 'bindingsPass': bindings_pass,
              'healthPass': history.get('healthy') is True, 'scopePass': scope_pass,
              'localParametersPreserved': unchanged_local_parameters,
              'metadataPreserved': metadata_preserved,
              'consumedBodiesVerified': after_metadata.get('consumedBodiesVerified') is True,
              'getterState': 'unresolved' if any(edge.get('versionSource') == 'unresolved' for edge in selected_after) else
                'diagnostic' if any(edge.get('getterError') for edge in selected_after) else 'resolved',
              'bindingResults': binding_results, 'health': history,
              'metadataCoverage': after.get('document', {}).get('metadataCoverage'),
              'metadataPass': after.get('document', {}).get('metadataComplete') is True and metadata_preserved,
              'physicalResponse': {'before': [row['volumeInternal'] for row in before.get('metadata', {}).get('bodies', [])],
                                   'after': [row['volumeInternal'] for row in after.get('metadata', {}).get('bodies', [])],
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


def _references_parameters(design):
    rows = []
    for parameter in _references_items(design.allParameters):
        try: rows.append(_references_parameter_value(parameter, design.unitsManager))
        except Exception: rows.append({'name': getattr(parameter, 'name', None), 'status': 'unknown'})
    return rows


def _references_user_parameter_state(design, bindings=()):
    aliases = {row.get('consumerAlias') for row in bindings if row.get('consumerAlias')}
    rows = []
    for parameter in _references_items(design.userParameters):
        value = _references_parameter_value(parameter, design.unitsManager)
        rows.append({'name': value['name'], 'expression': value['expression'],
                     'display_unit': value['display_unit'], 'comment': str(getattr(parameter, 'comment', '')),
                     'isFavorite': value['isFavorite'],
                     'display_value': None if value['name'] in aliases else value['display_value'],
                     'internal_value': None if value['name'] in aliases else value['internal_value'],
                     'internal_unit': value['internal_unit']})
    return sorted(rows, key=lambda row: row['name'])


def _references_find_live_linked(doc, edge_id):
    matches = []
    for ref in _references_items(doc.documentReferences):
        source_file = ref.dataFile
        token = getattr(ref, 'entityToken', None)
        occurrence = getattr(ref, 'occurrence', None)
        identity_part = token or (getattr(occurrence, 'entityToken', None) if occurrence else None) or source_file.id
        if _references_edge_id(doc.dataFile.id, 'linked', source_file.id, identity_part) == edge_id:
            matches.append(ref)
    return matches[0] if len(matches) == 1 else None


def _references_step_context(data, action):
    app = adsk.core.Application.get()
    file_id, project_id, version = data['fileId'], data['projectId'], data['version']
    lifecycle = data.get('lifecycle', 'existingOnly')
    matches = _references_open_matches(app, file_id, project_id, version)
    if len(matches) > 1:
        return None, {'status': 'blocked', 'reason': 'ambiguousOpenDocument',
                      'candidates': [_references_document_identity(doc) for doc in matches]}
    opened_by_request = False
    if matches:
        doc = matches[0]
        if data.get('ownedCreationId') and doc.creationId != data['ownedCreationId']:
            return None, {'status': 'blocked', 'reason': 'ownedEditorIdentityChanged',
                          'identity': _references_document_identity(doc)}
        # ownedCreationId pins the exact editor across steps; it does not claim
        # that a pre-existing editor was opened by this request.
        opened_by_request = data.get('openedByRequest') is True
    elif lifecycle == 'openOwned':
        opened = []
        doc, effect = _references_open_file(app, project_id, file_id, version, lifecycle, opened)
        if doc is None:
            return None, effect
        opened_by_request = effect.get('openedByRequest') is True
    else:
        return None, {'status': 'blocked', 'reason': 'notOpenExistingOnly'}
    identity = _references_document_identity(doc)
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


def _references_native_update(ctx, data):
    # This is a best-effort scheduling deadline for the entire SDK operation,
    # not a hard timeout: synchronous Fusion calls may overrun it. Start it
    # before identity, health, graph and command preflight so those costs reduce
    # the poll window instead of extending the RPC past Node's allocated time.
    operation_started = time.monotonic()
    time_budget_ms = float(data.get('timeBudgetMs', 180000))
    operation_deadline = operation_started + time_budget_ms / 1000.0
    poll_deadline = operation_deadline - _REFERENCES_NATIVE_REPORT_RESERVE_MS / 1000.0
    if data.get('confirm') is not True or data.get('command') != 'UpdateAllLatestCmd':
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                'reason': 'nativeUpdateRequiresPlannedCommandAndConfirmation'}
    doc, app = ctx.doc, ctx.app
    update = data.get('update') if isinstance(data.get('update'), dict) else {}
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
    sdk_result = data.get('priorSdkResult') if sdk_fallback else None
    if sdk_fallback and (not isinstance(sdk_result, dict) or sdk_result.get('status') != 'knownStale'):
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                'reason': 'nativeFallbackRequiresKnownSettledSdkStaleResult'}
    dirty_state_changed = (doc.isModified is not False if direct_native else
        bool(doc.isModified) != (sdk_result.get('modified') is True))
    if doc.dataFile.id != data['fileId'] or doc.dataFile.versionNumber != data['version'] or dirty_state_changed:
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                'reason': 'identityVersionOrDirtyStateChanged'}
    if ctx.design.timeline.markerPosition != ctx.design.timeline.count or ctx.design.snapshots.hasPendingSnapshot:
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
    prior_after = sdk_result.get('after', {}).get('edges', []) if sdk_fallback else None
    edge_state_ok, edge_state_reason = _references_edge_snapshot_matches(before['edges'], data['planEdges'],
        data['fileId'], data.get('effectiveTargets'), prior_edges=prior_after)
    if not edge_state_ok:
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                'reason': 'sdkPostcheckReceiptDoesNotMatchCurrentDocument',
                'edgeStateReason': edge_state_reason}
    if sdk_fallback:
        sdk_after = {edge['edgeId']: edge for edge in sdk_result.get('after', {}).get('edges', [])}
        if not sdk_after or any(edge['edgeId'] not in sdk_after or
                edge['sourceFileId'] != sdk_after[edge['edgeId']]['sourceFileId'] or
                edge['baselineVersion'] != sdk_after[edge['edgeId']]['baselineVersion']
                for edge in before['edges']):
            return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                    'reason': 'sdkPostcheckReceiptDoesNotMatchCurrentDocument'}
    if any(edge['selfReference'] for edge in before['edges']):
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                'reason': 'UpdateAllLatestCmdCouldAdvanceHistoricalSelfReference'}
    plan_edges = {edge['edgeId']: edge for edge in data['planEdges'] if edge['ownerFileId'] == data['fileId']}
    targets = data.get('effectiveTargets', {})
    if any(edge['edgeId'] not in plan_edges or
           targets.get(edge['edgeId'], plan_edges[edge['edgeId']].get('targetVersion')) != edge.get('latestVersion')
           for edge in before['edges'] if not edge['selfReference']):
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                'reason': 'UpdateAllLatestCmdCouldAdvanceUnplannedOrPinnedReference'}
    before_parameters = _references_user_parameter_state(ctx.design, data.get('parameterBindings', []))
    before_metadata = before.get('metadata', {})
    if direct_native:
        planned_edges = [edge for edge in data['planEdges']
                         if edge.get('ownerFileId') == data['fileId'] and not edge.get('selfReference')]
        kinds = {edge.get('kind') for edge in planned_edges}
        derive_edges = [edge for edge in planned_edges if edge.get('kind') == 'derive']
        if not {'linked', 'derive'}.issubset(kinds) or not derive_edges or any(
                edge.get('explicitPin') is True or edge.get('scopeProjectAllowed') is not True or
                edge.get('bindingCoverage', {}).get('complete') is not True for edge in derive_edges):
            return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                    'reason': 'directNativePlanIsNotStructurallyQualifiedMixedParent'}
    required_before_submit_ms = _REFERENCES_NATIVE_REPORT_RESERVE_MS + _REFERENCES_NATIVE_MIN_POLL_MS
    if (operation_deadline - time.monotonic()) * 1000.0 < required_before_submit_ms:
        return {'status': 'blocked', 'actionSubmitted': False, 'notStarted': True,
                'reason': 'nativeUpdateBudgetInsufficientBeforeCommand',
                'timeBudgetMs': time_budget_ms, 'requiredReserveMs': required_before_submit_ms,
                'before': before}
    command = app.userInterface.commandDefinitions.itemById('UpdateAllLatestCmd')
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
            if ctx.design.computeAll() is not True:
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
    current = {edge['edgeId']: edge for edge in after['edges']}
    targets = data.get('effectiveTargets', {})
    expected = {edge['edgeId']: targets.get(edge['edgeId'], edge.get('targetVersion'))
                for edge in data['planEdges'] if edge['ownerFileId'] == data['fileId'] and not edge['selfReference']}
    edges_current = all(current.get(edge_id) and current[edge_id].get('baselineVersion') == version
                        for edge_id, version in expected.items())
    bindings = [binding for binding in data.get('parameterBindings', []) if binding['edgeId'] in expected]
    derived_ids = {edge['edgeId'] for edge in data['planEdges']
                   if edge['ownerFileId'] == data['fileId'] and edge['kind'] == 'derive'}
    binding_results = [_references_binding_checks(ctx, edge_id, bindings,
        data.get('expectedSourceParameters', {}), data.get('allowedProjectIds'))
                       for edge_id in derived_ids]
    bindings_pass = not derived_ids or bool(binding_results) and all(row['passed'] for row in binding_results)
    history = after.get('document', {}).get('health', {})
    local_parameters_preserved = before_parameters == _references_user_parameter_state(
        ctx.design, data.get('parameterBindings', []))
    metadata = after.get('metadata', {})
    before_attrs = sorted(before_metadata.get('attributes', []), key=lambda row: (
        row.get('kind',''), str(row.get('namespace')), row.get('group',''), row.get('name','')))
    after_attrs = sorted(metadata.get('attributes', []), key=lambda row: (
        row.get('kind',''), str(row.get('namespace')), row.get('group',''), row.get('name','')))
    before_occurrences = _references_occurrence_states(before_metadata)
    after_occurrences = _references_occurrence_states(metadata)
    metadata_preserved = (before_attrs == after_attrs and before_occurrences is not None and
                          before_occurrences == after_occurrences)
    checks = {'intendedReferencesCurrent': edges_current, 'bindingsPass': bindings_pass,
              'recomputed': settled,
              'healthPass': history.get('healthy') is True, 'scopePass': edges_current,
              'localParametersPreserved': local_parameters_preserved,
              'metadataPreserved': metadata_preserved,
              'consumedBodiesVerified': metadata.get('consumedBodiesVerified') is True,
              'getterState': 'diagnostic' if any(edge.get('getterError') for edge in current.values()) else 'resolved',
              'bindingResults': binding_results, 'health': history,
              'metadataCoverage': after.get('document', {}).get('metadataCoverage'),
              'metadataPass': metadata.get('metadataComplete') is True and metadata_preserved}
    complete = settled and edges_current and bindings_pass and checks['healthPass'] and local_parameters_preserved and \
        metadata_preserved and checks['consumedBodiesVerified'] and checks['metadataPass']
    return {'status': 'complete' if complete else 'knownStale',
            'outcome': 'settled', 'actionSubmitted': True,
            'operationOutcome': 'pass' if complete else 'fail',
            'checks': checks,
            'before': before, 'after': after, 'modified': bool(doc.isModified),
            'command': 'UpdateAllLatestCmd'}


def _references_save(ctx, data):
    if ctx.doc.dataFile.id != data['fileId'] or ctx.doc.dataFile.parentProject.id != data['projectId']:
        return {'status': 'blocked', 'reason': 'identityMismatch'}
    if ctx.doc.dataFile.versionNumber != data['version'] or ctx.doc.dataFile.latestVersionNumber != data.get('latestVersion'):
        return {'status': 'blocked', 'reason': 'documentVersionDriftBeforeSave'}
    if ctx.app.userInterface.activeCommand not in ('', 'SelectCommand'):
        return {'status': 'blocked', 'reason': 'interactiveCommandActive', 'activeCommand': ctx.app.userInterface.activeCommand}
    if ctx.design.timeline.markerPosition != ctx.design.timeline.count or ctx.design.snapshots.hasPendingSnapshot:
        return {'status': 'blocked', 'reason': 'timelineOrPendingSnapshotChanged'}
    if not _references_feature_health(ctx)['healthy']:
        return {'status': 'failed', 'reason': 'repairRequiredBeforeSave'}
    plan_edges = data.get('planEdges', [])
    post_edges = data.get('postUpdateEdges')
    if not isinstance(post_edges, list):
        return {'status': 'blocked', 'reason': 'postUpdateReferenceReceiptUnavailable'}
    current_snapshot = _references_preflight(ctx, {'fileId': data['fileId'], 'projectId': data['projectId'],
                                                   'allowedProjectIds': data.get('allowedProjectIds')})
    edge_ok, edge_reason = _references_edge_snapshot_matches(
        current_snapshot['edges'], plan_edges, data['fileId'], data.get('effectiveTargets'), prior_edges=post_edges)
    if not edge_ok:
        return {'status': 'blocked', 'reason': edge_reason}
    required_checks = data.get('checks', {})
    if not all(required_checks.get(key) is True for key in
               ('bindingsPass', 'healthPass', 'scopePass', 'metadataPass', 'localParametersPreserved', 'consumedBodiesVerified')):
        return {'status': 'blocked', 'reason': 'postUpdateChecksNotPassed'}
    if ctx.doc.isModified is False:
        return {'status': 'complete', 'changed': False, 'resultingVersion': int(ctx.doc.dataFile.versionNumber),
                'cloudComplete': bool(ctx.doc.dataFile.isComplete), 'parameters': _references_parameters(ctx.design),
                'metadata': _references_metadata(ctx.design, ctx.root), 'lifecycleEffects': []}
    if ctx.doc.dataFile.isReadOnly is not False:
        return {'status': 'blocked', 'reason': 'readOnly'}
    before = int(ctx.doc.dataFile.versionNumber)
    try:
        accepted = ctx.doc.save('Authorized references.refresh request ' + data['requestId'])
    except Exception as exc:
        return {'status': 'unknown', 'outcome': 'unknown', 'reason': 'save call raised after entry: ' + type(exc).__name__ + ': ' + str(exc),
                'modified': bool(ctx.doc.isModified)}
    if accepted is not True:
        return {'status': 'failed', 'reason': 'saveNotAccepted', 'accepted': bool(accepted),
                'modified': bool(ctx.doc.isModified)}
    deadline = time.monotonic() + float(data.get('timeBudgetMs', 180000)) / 1000.0
    try:
        while time.monotonic() < deadline:
            current = ctx.doc.dataFile
            if current.id != data['fileId'] or current.parentProject.id != data['projectId']:
                return {'status': 'unknown', 'outcome': 'unknown', 'reason': 'save target identity changed'}
            try:
                if not current.isComplete:
                    current.refresh(None)
            except Exception as exc:
                return {'status': 'unknown', 'outcome': 'unknown', 'reason': 'cloud completion readback: ' + type(exc).__name__ + ': ' + str(exc),
                        'savedVersionObserved': int(current.versionNumber)}
            if int(current.versionNumber) > before and current.isComplete is True and ctx.doc.isModified is False:
                return {'status': 'complete', 'changed': True, 'resultingVersion': int(current.versionNumber),
                        'identityAfter': _references_document_identity(ctx.doc),
                        'cloudComplete': True, 'isUpToDate': bool(ctx.doc.isUpToDate),
                        'parameters': _references_parameters(ctx.design),
                        'metadata': _references_metadata(ctx.design, ctx.root),
                        'lifecycleEffects': [{'fileId': data['fileId'], 'effect': 'saved',
                                              'version': int(current.versionNumber)}]}
            adsk.doEvents(); time.sleep(.1)
    except Exception as exc:
        return {'status': 'unknown', 'outcome': 'unknown', 'reason': 'save readback: ' + type(exc).__name__ + ': ' + str(exc)}
    return {'status': 'unknown', 'outcome': 'unknown', 'reason': 'save was accepted but cloud completion is not confirmed',
            'savedVersionObserved': int(ctx.doc.dataFile.versionNumber), 'modified': bool(ctx.doc.isModified)}


def _references_cold_editor_owned(doc, data):
    return (data.get('lifecycle') == 'openOwned' and isinstance(data.get('ownedCreationId'), str) and
            bool(data['ownedCreationId']) and doc.creationId == data['ownedCreationId'])


def _references_cold_verify(ctx, data):
    doc, file = ctx.doc, ctx.doc.dataFile
    if not _references_cold_editor_owned(doc, data):
        return {'status': 'blocked', 'coldVerified': False,
                'reason': 'cold close/reopen requires openOwned authorization and the exact captured editor identity'}
    if doc.isModified or file.id != data['fileId'] or file.versionNumber != data['resultingVersion'] or not file.isComplete:
        return {'status': 'blocked', 'coldVerified': False, 'reason': 'cold precondition not satisfied'}
    file_id, project_id, version = file.id, file.parentProject.id, int(file.versionNumber)
    creation_id = doc.creationId
    try:
        if doc.close(False) is not True:
            return {'status': 'unknown', 'coldVerified': False, 'reason': 'owned clean editor close was not confirmed'}
        # Closing the document can invalidate the SDK wrapper for its DataFile.
        # Resolve a fresh cloud object by exact project/file/version, never keep
        # using the pre-close wrapper or fall back to a name/latest guess.
        if _references_open_matches(ctx.app, file_id, project_id, version):
            return {'status': 'blocked', 'coldVerified': False,
                    'reason': 'another top-level editor remains for the pinned cold-reopen target'}
        try:
            reopen_file = _references_project_file(ctx.app, project_id, file_id, version)
        except Exception as exc:
            return {'status': 'blocked', 'coldVerified': False,
                    'reason': 'exact saved cloud version is unavailable for cold reopen: ' + str(exc),
                    'lifecycleEffects': [{'fileId': file_id, 'effect': 'closed',
                                          'creationId': creation_id, 'owned': True}]}
        if reopen_file.id != file_id or reopen_file.versionNumber != version or reopen_file.isReadOnly is not False:
            return {'status': 'blocked', 'coldVerified': False,
                    'reason': 'exact saved cloud file is not writable at the requested version'}
        reopened = _cad_require_result(ctx.app.documents.open(reopen_file, True), 'Cold reopen exact saved DataFile')
        identity = _references_document_identity(reopened)
        if identity['fileId'] != file_id or identity['projectId'] != project_id or identity['version'] != version or identity['modified']:
            return {'status': 'unknown', 'coldVerified': False, 'identity': identity,
                    'reason': 'cold reopen identity/version/dirty check failed'}
        cold_ctx = CadContext(reopened.name, project_id=project_id, doc_id=reopened.creationId,
                              doc_file_id=file_id, resolved_doc=reopened)
        post = _references_preflight(cold_ctx, {'fileId': file_id, 'projectId': project_id,
                                                 'allowedProjectIds': data.get('allowedProjectIds')})
        expected = {edge['edgeId']: data.get('effectiveTargets', {}).get(edge['edgeId'], edge.get('targetVersion'))
                    for edge in data.get('planEdges', []) if edge['ownerFileId'] == file_id}
        current = {edge['edgeId']: edge for edge in post['edges']}
        edge_pass = all(current.get(edge_id) and current[edge_id].get('baselineVersion') == target
                        for edge_id, target in expected.items())
        derive_ids = {edge['edgeId'] for edge in data.get('planEdges', [])
                      if edge['ownerFileId'] == file_id and edge['kind'] == 'derive'}
        bindings = [binding for binding in data.get('parameterBindings', []) if binding['edgeId'] in derive_ids]
        binding_results = [_references_binding_checks(cold_ctx, edge_id, bindings,
            data.get('expectedSourceParameters', {}), data.get('allowedProjectIds')) for edge_id in derive_ids]
        binding_pass = not derive_ids or bool(binding_results) and all(row['passed'] for row in binding_results)
        history_pass = post['document']['health']['healthy'] is True
        expected_user = []
        aliases = {binding.get('consumerAlias') for binding in data.get('parameterBindings', []) if binding.get('consumerAlias')}
        for row in data.get('baselineUserParameters', []):
            copied = dict(row)
            if copied.get('name') in aliases:
                copied['display_value'] = None; copied['internal_value'] = None
            expected_user.append(copied)
        expected_user = sorted(expected_user, key=lambda row: row.get('name', ''))
        current_user = _references_user_parameter_state(cold_ctx.design, data.get('parameterBindings', []))
        user_parameters_pass = expected_user == current_user
        metadata = post.get('metadata', {})
        baseline_metadata = data.get('baselineMetadata', {})
        before_attrs = sorted(baseline_metadata.get('attributes', []), key=lambda row: (
            row.get('kind',''), str(row.get('namespace')), row.get('group',''), row.get('name','')))
        after_attrs = sorted(metadata.get('attributes', []), key=lambda row: (
            row.get('kind',''), str(row.get('namespace')), row.get('group',''), row.get('name','')))
        metadata_pass = before_attrs == after_attrs and metadata.get('metadataComplete') is True
        identity_pass = (identity.get('fileId') == file_id and identity.get('projectId') == project_id and
                         identity.get('version') == version and identity.get('isComplete') is True and
                         identity.get('modified') is False)
        cold_verified = edge_pass and binding_pass and history_pass and metadata_pass and user_parameters_pass and \
            metadata.get('consumedBodiesVerified') is True and identity_pass
        checks = {'intendedReferencesCurrent': edge_pass, 'bindingsPass': binding_pass,
                  'healthPass': history_pass, 'metadataPass': metadata_pass,
                  'localParametersPreserved': user_parameters_pass, 'identityPass': identity_pass,
                  'consumedBodiesVerified': metadata.get('consumedBodiesVerified') is True,
                  'bindingResults': binding_results,
                  'getterState': 'unresolved' if any(edge.get('versionSource') == 'unresolved' for edge in post['edges']) else
                    'diagnostic' if any(edge.get('getterError') for edge in post['edges']) else 'resolved'}
        return {'status': 'complete' if cold_verified else 'failed',
                'coldVerified': cold_verified, 'identity': identity,
                 'checks': checks, 'edges': post['edges'], 'parameters': _references_parameters(cold_ctx.design),
                 'metadata': metadata,
                 'lifecycleEffects': [{'fileId': file_id, 'effect': 'closed', 'creationId': creation_id,
                                       'owned': True}, {'fileId': file_id, 'effect': 'coldReopened',
                                       'creationId': reopened.creationId, 'version': version, 'owned': True}]}
    except Exception as exc:
        return {'status': 'unknown', 'coldVerified': False,
                'reason': type(exc).__name__ + ': ' + str(exc),
                'lifecycleEffects': [{'fileId': file_id, 'effect': 'coldReopenUncertain', 'owned': True}]}


def _references_refresh_internal(action, data):
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
    result.setdefault('lifecycleEffects', [])
    if lifecycle.get('openedByRequest'):
        result['openedByRequest'] = True
        result['ownedCreationId'] = lifecycle['identity']['creationId']
        result['lifecycleEffects'].append({'fileId': data['fileId'], 'effect': 'openedForApply',
            'creationId': lifecycle['identity']['creationId'], 'owned': True})
    result.setdefault('identity', lifecycle.get('identity'))
    return result
