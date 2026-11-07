"""Owned-scratch native case for namespaced attrs on nested repeated instances."""
DOC_NAME = "FMCAD_tcc_entity_attributes"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def settle(FMCAD):
    snapshots = FMCAD.design.snapshots
    if snapshots.hasPendingSnapshot:
        require(snapshots.add() is not None, 'could not capture pending scratch positions')
    require(not snapshots.hasPendingSnapshot, 'pending scratch positions remain')


def ref(entity):
    return {'token': entity.entityToken, 'kind': 'occurrence', 'name': entity.name,
            'path': entity.fullPathName}


def run(context):
    part = FMCAD.resolve('TCC_PhysicalPart', 'component')
    require(part.bRepBodies.count == 1, 'owned physical part fixture body missing')
    settle(FMCAD)
    parent = FMCAD.call('component.create', {'name': 'TCC_NestedParent'})
    nested = FMCAD.call('occurrence.add', {'component': {
        'token': part.entityToken, 'kind': 'component', 'name': part.name},
        'copyMode': 'linked', 'destination': parent['occurrence']})
    settle(FMCAD)
    repeated_parent = FMCAD.call('occurrence.add', {'component': parent['component'],
        'copyMode': 'linked', 'destination': 'root'})
    settle(FMCAD)

    parent_paths = sorted(o.fullPathName for o in
        [FMCAD.root.allOccurrences.item(i) for i in range(FMCAD.root.allOccurrences.count)]
        if o.component == FMCAD.resolve(parent['component'], 'component'))
    nested_instances = sorted((FMCAD.root.allOccurrences.item(i)
        for i in range(FMCAD.root.allOccurrences.count)
        if FMCAD.root.allOccurrences.item(i).component == part and
        any(FMCAD.root.allOccurrences.item(i).fullPathName.startswith(path + '+')
            for path in parent_paths)), key=lambda occurrence: occurrence.fullPathName)
    require(len(parent_paths) == 2 and len(nested_instances) == 2,
            'independent root-context inventory lacks two repeated nested instances')
    for occurrence, location in zip(nested_instances, ('north', 'south')):
        FMCAD.call('entity.attribute.set', {'ref': ref(occurrence),
            'group': 'TCC_NESTED_INSTANCE', 'name': 'location', 'value': location})

    part_ref = {'token': part.entityToken, 'kind': 'component', 'name': part.name}
    native = FMCAD.call('entity.find', {'kind': 'body', 'component': part_ref,
        'instances': True, 'filters': {'attributes': [{'group': 'TCC_ATTRIBUTE_QUERY_FIXTURE',
            'name': 'definitionRole', 'value': 'physical-part', 'owner': 'native'}]},
        'expect': 4, 'groupBy': ['occurrence']})
    expected_paths = sorted(o.fullPathName for o in
        [FMCAD.root.allOccurrences.item(i) for i in range(FMCAD.root.allOccurrences.count)]
        if o.component == part)
    require(native['count'] == 4 and sorted(row['occurrencePath'] for row in native['entities']) == expected_paths,
            'native predicate did not preserve all direct/nested repeated paths')

    nested_north = FMCAD.call('entity.find', {'kind': 'body', 'component': part_ref,
        'instances': True, 'filters': {'attributes': [{'group': 'TCC_NESTED_INSTANCE',
            'name': 'location', 'value': 'north', 'owner': 'occurrence'}]}, 'expect': 1})
    require(nested_north['success'] and
            [row['occurrencePath'] for row in nested_north['entities']] == [nested_instances[0].fullPathName],
            'occurrence attribute predicate selected the wrong nested path')
    proxy_ref = nested_north['refs'][0]
    FMCAD.call('entity.attribute.set', {'ref': proxy_ref, 'group': 'TCC_NESTED_INSTANCE',
        'name': 'proxyOnly', 'value': 'contextual'})
    proxy = FMCAD.call('entity.find', {'kind': 'body', 'component': part_ref,
        'instances': True, 'filters': {'attributes': [{'group': 'TCC_NESTED_INSTANCE',
            'name': 'proxyOnly', 'value': 'contextual', 'owner': 'proxy'}]}, 'expect': 1})
    require(proxy['success'] and proxy['entities'][0]['occurrencePath'] == nested_instances[0].fullPathName,
            'proxy predicate did not select the explicitly attributed context')
    no_fallback = FMCAD.call('entity.find', {'kind': 'body', 'component': part_ref,
        'instances': True, 'filters': {'attributes': [{'group': 'TCC_NESTED_INSTANCE',
            'name': 'proxyOnly', 'value': 'contextual', 'owner': 'native'}]}, 'expect': 0})
    require(no_fallback['success'] and no_fallback['count'] == 0,
            'native owner implicitly used the nested proxy attribute')
    return {'scratchOnly': True, 'parentPaths': parent_paths,
            'independentNestedPaths': [o.fullPathName for o in nested_instances],
            'nativeMatchingPaths': expected_paths, 'nativeCount': native['count'],
            'occurrenceOwnerPath': nested_north['entities'][0]['occurrencePath'],
            'proxyOwnerPath': proxy['entities'][0]['occurrencePath'],
            'nativeFallbackCount': no_fallback['count'],
            'hiddenPhysicalPartStillMatched': native['count'] == 4,
            'linkedParentPaths': repeated_parent['affectedPaths'],
            'nestedAddPaths': nested['affectedPaths']}
