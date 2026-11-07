"""Fusion adapter for persisted rules over the existing entity resolver."""


def _selection_rules_owner(ctx: "CadContext") -> "tuple[JsonObject, JsonObject]":
    ctx.assert_identity()
    doc = ctx.doc
    file = doc.dataFile
    project = getattr(file, 'parentProject', None)
    project_id = getattr(project, 'id', None)
    file_id = getattr(file, 'id', None)
    creation_id = getattr(doc, 'creationId', None)
    version = getattr(file, 'versionNumber', None)
    if not isinstance(project_id, str) or not project_id or not isinstance(file_id, str) or not file_id:
        raise ValueError('Selection rules require a saved document with exact project and file IDs')
    if creation_id is not None and not isinstance(creation_id, str):
        raise ValueError('Document creationId must be text or null')
    if type(version) is not int or version < 0:
        raise ValueError('Selection rules require a nonnegative source document version')
    owner: "JsonObject" = {'projectId': project_id, 'documentFileId': file_id, 'documentCreationId': creation_id}
    source: "JsonObject" = {'documentName': doc.name, 'version': version}
    return owner, source


def _selection_rules_query(ctx: "CadContext", query: "JsonObject", exclusions: "list[JsonObject]") -> "tuple[list[CadEntity], list[JsonRecord], list[CadEntity], JsonRecord]":
    current_query = dict(query)
    current_query['expect'] = {'min': 0}
    entities, report = _entity_query(ctx, current_query)
    excluded: list[CadEntity] = []
    for filters in exclusions:
        exclusion_query = {key: query[key] for key in
                           ('kind', 'component', 'occurrence', 'scope', 'instances', 'frame') if key in query}
        exclusion_query.update(schemaVersion=1, filters=filters, expect={'min': 0})
        found, _ = _entity_query(ctx, exclusion_query)
        for entity in found:
            if not any(entity == existing for existing in excluded):
                excluded.append(entity)
    selected: list[CadEntity] = []
    rows: list[JsonRecord] = []
    for entity, row in zip(entities, _cad_cast('list[JsonRecord]', report['entities'])):
        if not any(entity == omitted for omitted in excluded):
            selected.append(entity)
            rows.append(row)
    return selected, rows, excluded, report


def _selection_rules_occurrence_path(reference: "JsonObject") -> "JsonValue":
    if reference.get('kind') == 'occurrence':
        return reference.get('path')
    occurrence = reference.get('occurrence')
    return occurrence.get('path') if isinstance(occurrence, dict) else None


def _selection_rules_lineage(ctx: "CadContext", reference: "JsonObject",
                             current: "list[CadEntity]") -> list[int]:
    token = reference.get('token')
    if not isinstance(token, str) or not token:
        return []
    try:
        resolved = _cad_items(ctx.design.findEntityByToken(token))
    except Exception:
        resolved = []
    old_path = _selection_rules_occurrence_path(reference)
    matches: set[int] = set()
    for candidate_index, entity in enumerate(current):
        entity_native = getattr(entity, 'nativeObject', None) or entity
        entity_occurrence = entity if _cad_kind(entity) == 'occurrence' else getattr(entity, 'assemblyContext', None)
        entity_path = getattr(entity_occurrence, 'fullPathName', None)
        if old_path != entity_path:
            continue
        current_ref = ctx.ref(entity)
        current_token = current_ref.get('token')
        if current_token == token:
            matches.add(candidate_index)
        for old in resolved:
            old_native = getattr(old, 'nativeObject', None) or old
            old_token = getattr(old_native, 'entityToken', None)
            if ((old_token is not None and old_token == current_token)
                    or old_native == entity_native):
                matches.add(candidate_index)
    return sorted(matches)


def _selection_rules_references(ctx: "CadContext", entities: "list[CadEntity]") -> "list[JsonRecord]":
    references: list[JsonRecord] = [{'reference': ctx.ref(entity)} for entity in entities]
    def sort_key(item: "JsonRecord") -> "tuple[str, str, str]":
        reference = _cad_cast('JsonObject', item['reference'])
        occurrence = reference.get('occurrence')
        occurrence_record = occurrence if isinstance(occurrence, dict) else {}
        path = occurrence_record.get('path', reference.get('path', ''))
        return (str(reference.get('kind', '')), str(path), str(reference.get('token', '')))
    return sorted(references, key=sort_key)


def _selection_rules_changes(ctx: "CadContext", previous: "_SelectionLastResolution",
                             current: "list[CadEntity]") -> "tuple[list[JsonRecord], list[list[int]]]":
    prior_refs = [item['reference'] for item in previous['selectedReferences']]
    mappings = [_selection_rules_lineage(ctx, reference, current) for reference in prior_refs]
    changes: list[JsonRecord] = []
    for reference, indexes in zip(prior_refs, mappings):
        if len(indexes) > 1:
            changes.append({'kind': 'split', 'previous': reference,
                            'current': [ctx.ref(current[index]) for index in indexes]})
    for current_index in range(len(current)):
        owners = [reference for reference, indexes in zip(prior_refs, mappings) if current_index in indexes]
        if len(owners) > 1:
            changes.append({'kind': 'merge', 'previous': owners, 'current': ctx.ref(current[current_index])})
    return changes, mappings


def _selection_rules_create_manifest(ctx: "CadContext", definition: "_SelectionDefinition",
                                     owner: "JsonObject", source: "JsonObject",
                                     selected: "list[CadEntity]") -> "_SelectionRuleManifest":
    scope = _selection_rule_in_scope(definition['query'])
    references = _selection_rules_references(ctx, selected)
    return _cad_cast('_SelectionRuleManifest', {
        'schemaVersion': 1,
        'revision': 1,
        'rule': {'id': definition['ruleId'], 'version': 1,
                 'query': definition['query'], 'exclude': definition['exclude']},
        'owner': owner,
        'source': source,
        'instanceScope': scope,
        'lastResolution': {'sourceVersion': source['version'], 'count': len(selected),
                           'selectedReferences': references},
        'provenance': {'definedBy': 'selection.rule.define',
                       'resolver': 'entity._entity_query',
                       'projectId': owner['projectId'],
                       'documentFileId': owner['documentFileId'],
                       'documentCreationId': owner['documentCreationId'],
                       'sourceVersion': source['version']},
    })


def _selection_rules_define(ctx: "CadContext", data: "JsonValue") -> "JsonRecord":
    definition = _selection_rule_definition(data)
    owner, source = _selection_rules_owner(ctx)
    expected = _entity_interval(ctx, definition['query']['expect'], 'expected cardinality', True)
    expected_cardinality = _cad_cast('_SelectionCardinality', {'min': expected[0], 'max': expected[1]})
    selected, rows, excluded, _ = _selection_rules_query(ctx, definition['query'], definition['exclude'])
    if not _selection_rule_cardinality_passed(len(selected), expected_cardinality):
        raise ValueError('Selection rule expected %s..%s entities, found %d' %
                         (expected[0], expected[1], len(selected)))
    manifest = _selection_rules_create_manifest(ctx, definition, owner, source, selected)
    ctx.assert_identity()
    return _cad_cast("JsonRecord", {
        'schemaVersion': 1, 'operation': 'selection.rule.define', 'success': True, 'status': 'pass',
        'ruleId': definition['ruleId'], 'count': len(selected),
        'refs': [ctx.ref(entity) for entity in selected], 'entities': rows,
        'excludedCount': len(excluded), 'manifest': manifest,
        'provenance': manifest['provenance'],
        'method': 'current native topology through entity._entity_query',
        'limitations': ['The returned manifest must be stored by the caller through the selection rule artifact client.',
                        'Historical references are provenance only and are never used to select a current entity.'],
    })


def _selection_rules_owned_manifest(ctx: "CadContext", value: "JsonValue") -> "tuple[_SelectionRuleManifest, JsonObject, JsonObject]":
    manifest = _selection_rules_validate_manifest(value)
    owner, source = _selection_rules_owner(ctx)
    if manifest['owner'] != owner:
        raise ValueError('Selection rule ownership conflict: project or document identity differs')
    return manifest, owner, source


def _selection_rules_inspect(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('manifest',))
    manifest, owner, source = _selection_rules_owned_manifest(ctx, data['manifest'])
    ctx.assert_identity()
    return _cad_cast("JsonRecord", {
        'schemaVersion': 1, 'operation': 'selection.rule.inspect', 'success': True, 'status': 'pass',
        'ruleId': manifest['rule']['id'], 'revision': manifest['revision'],
        'owner': owner, 'source': source, 'instanceScope': manifest['instanceScope'],
        'expectedCardinality': manifest['rule']['query']['expect'],
        'lastResolution': manifest['lastResolution'], 'provenance': manifest['provenance'],
        'manifest': manifest,
        'limitations': ['Inspection validates ownership and stored provenance; it does not resolve current topology.'],
    })


def _selection_rules_run(ctx: "CadContext", data: "JsonObject",
                         operation: "Literal['selection.rule.resolve', 'selection.rule.check']") -> "JsonRecord":
    _cad_fields(data, ('manifest',))
    manifest, owner, source = _selection_rules_owned_manifest(ctx, data['manifest'])
    query = manifest['rule']['query']
    exclusions = manifest['rule']['exclude']
    expected_range = _entity_interval(ctx, query['expect'], 'expected cardinality', True)
    expected = _cad_cast('_SelectionCardinality', {
        'min': expected_range[0], 'max': expected_range[1]})
    selected, rows, excluded, query_report = _selection_rules_query(ctx, query, exclusions)
    previous = manifest['lastResolution']
    changes, mappings = _selection_rules_changes(ctx, previous, selected)
    source_changed = source['version'] != manifest['source']['version']
    cardinality_passed = _selection_rule_cardinality_passed(len(selected), expected)

    if not selected and previous['count']:
        status = 'missing'
    elif any(change['kind'] == 'split' for change in changes):
        status = 'split'
    elif any(change['kind'] == 'merge' for change in changes):
        status = 'merge'
    elif expected['max'] is not None and len(selected) > expected['max']:
        status = 'ambiguous'
    elif source_changed:
        status = 'stale'
    elif not cardinality_passed:
        status = 'missing' if len(selected) < (expected['min'] or 0) else 'ambiguous'
    else:
        prior_covered = all(len(indexes) == 1 for indexes in mappings)
        current_covered = set(index for indexes in mappings for index in indexes) == set(range(len(selected)))
        one_to_one = all(sum(index in indexes for indexes in mappings) == 1 for index in range(len(selected)))
        status = 'resolved' if prior_covered and current_covered and one_to_one else 'stale'

    updated = manifest
    if status == 'resolved':
        references = _selection_rules_references(ctx, selected)
        if references != previous['selectedReferences']:
            updated = _cad_cast('_SelectionRuleManifest', dict(manifest))
            updated['revision'] = manifest['revision'] + 1
            updated['lastResolution'] = _cad_cast('_SelectionLastResolution', {
                'sourceVersion': source['version'], 'count': len(selected),
                'selectedReferences': references,
            })
            updated['provenance'] = dict(manifest['provenance'], lastResolvedBy=operation,
                                         lastResolvedVersion=source['version'])

    ctx.assert_identity()
    document_identity = _cad_cast('JsonObject', query_report['documentIdentity'])
    passed = status == 'resolved' and cardinality_passed and document_identity['fileId'] == owner['documentFileId']
    return _cad_cast("JsonRecord", {
        'schemaVersion': 1, 'operation': operation, 'success': passed, 'status': status,
        'passed': passed, 'ruleId': manifest['rule']['id'], 'revision': updated['revision'],
        'source': source, 'sourceChanged': source_changed,
        'expectedCardinality': expected, 'count': len(selected),
        'refs': [ctx.ref(entity) for entity in selected], 'entities': rows,
        'excludedCount': len(excluded), 'changes': changes,
        'manifest': updated,
        'provenance': {'resolver': 'entity._entity_query', 'owner': owner,
                       'sourceVersion': source['version'], 'ruleRevision': manifest['revision']},
        'method': 'fresh current-topology query through entity._entity_query',
        'limitations': ['Previous native references are compared only for change reporting; they never choose or repair a current reference.',
                        'A changed saved document version is stale even when the predicates still match.',
                        'A failed, stale, split, merged, missing, or ambiguous resolution does not advance the stored manifest.'],
    })


def _selection_rules_resolve(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    return _selection_rules_run(ctx, data, 'selection.rule.resolve')


def _selection_rules_check(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    return _selection_rules_run(ctx, data, 'selection.rule.check')


def _selection_rules_internal_binding(data: "JsonObject") -> "JsonObject":
    binding = data.get('_trustedBinding')
    if not isinstance(binding, dict) or binding.get('version') != 1 or binding.get('service') != 'selection-rules':
        raise ValueError('Selection-rule SDK operation requires its trusted coordinator binding')
    return binding


def _selection_rules_define_internal(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('definition', '_trustedBinding'))
    _selection_rules_internal_binding(data)
    return _selection_rules_define(ctx, data['definition'])


def _selection_rules_manifest_internal(ctx: "CadContext", data: "JsonObject", operation: str) -> "JsonRecord":
    _cad_fields(data, ('manifest', '_trustedBinding'))
    _selection_rules_internal_binding(data)
    if operation == 'inspect':
        return _selection_rules_inspect(ctx, {'manifest': data['manifest']})
    if operation == 'resolve':
        return _selection_rules_resolve(ctx, {'manifest': data['manifest']})
    return _selection_rules_check(ctx, {'manifest': data['manifest']})
