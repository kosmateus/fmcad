"""Owned-scratch live case for GM03 namespaced attribute predicates."""
DOC_NAME = "FMCAD_tcc_entity_attributes"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(context):
    component = FMCAD.call('component.create', {'name': 'TCC_PhysicalPart'})
    FMCAD.call('shape.box', {'name': 'TCC_Block', 'width': '10 mm', 'depth': '8 mm',
                             'height': '3 mm'}, component=component['component'])
    body = FMCAD.call('component.inspect', {'component': component['component']})['bodies'][0]
    group = 'TCC_ATTRIBUTE_QUERY_FIXTURE'
    FMCAD.call('entity.attribute.set', {'ref': body, 'group': group,
                                        'name': 'definitionRole', 'value': 'physical-part'})
    measured = FMCAD.call('measure.volume', {'ref': {'query': {'kind': 'body',
        'scope': {'component': component['component']}, 'filters': {'attributes': [
            {'group': group, 'name': 'definitionRole', 'value': 'physical-part', 'owner': 'native'}]}}},
        'units': 'cm3'})
    require(abs(measured['value'] - 0.24) < 1e-6,
            'measure.volume query-reference consumer did not select the attributed body')
    FMCAD.call('entity.attribute.set', {'ref': component['occurrence'], 'group': group,
                                        'name': 'site', 'value': 'north'})
    second = FMCAD.call('occurrence.add', {'component': component['component'], 'copyMode': 'linked',
                                           'destination': 'root'})
    FMCAD.call('entity.attribute.set', {'ref': second['occurrence'], 'group': group,
                                        'name': 'site', 'value': 'south'})
    hidden = FMCAD.call('visibility.hide', {'refs': [body]})
    require(hidden['items'][0]['isLightBulbOn'] is False, 'visibility.hide did not hide the fixture body')
    part_native = FMCAD.resolve(component['component'], 'component')
    expected_paths = sorted(o.fullPathName for o in
        [FMCAD.root.allOccurrences.item(i) for i in range(FMCAD.root.allOccurrences.count)]
        if o.component == part_native)
    require(len(expected_paths) == 2 and part_native.bRepBodies.count == 1,
            'independent physical occurrence inventory differs from declared setup')

    native = FMCAD.call('entity.find', {'kind': 'body', 'component': component['component'],
        'instances': True, 'filters': {'attributes': [
            {'group': group, 'name': 'definitionRole', 'value': 'physical-part', 'owner': 'native'}]},
        'expect': 2, 'groupBy': ['occurrence']})
    require(native['count'] == 2 and native['success'], 'native owner did not select both physical instances')
    require(sorted(row['occurrencePath'] for row in native['entities']) == expected_paths,
            'native owner instance paths differ from the independent occurrence inventory')

    north = FMCAD.call('entity.find', {'kind': 'body', 'component': component['component'],
        'instances': True, 'filters': {'attributes': [
            {'group': group, 'name': 'site', 'value': 'north', 'owner': 'occurrence'}]}, 'expect': 1})
    require(north['success'] and [row['occurrencePath'] for row in north['entities']] ==
            [component['occurrence']['path']], 'occurrence owner selected the wrong physical instance')
    FMCAD.call('entity.attribute.set', {'ref': north['refs'][0], 'group': group,
                                        'name': 'proxyRole', 'value': 'context-only'})
    proxy = FMCAD.call('entity.find', {'kind': 'body', 'component': component['component'],
        'instances': True, 'filters': {'attributes': [
            {'group': group, 'name': 'proxyRole', 'value': 'context-only', 'owner': 'proxy'}]}, 'expect': 1})
    require(proxy['success'] and [row['occurrencePath'] for row in proxy['entities']] ==
            [component['occurrence']['path']], 'proxy owner selected the wrong context')
    native_no_fallback = FMCAD.call('entity.find', {'kind': 'body', 'component': component['component'],
        'instances': True, 'filters': {'attributes': [
            {'group': group, 'name': 'proxyRole', 'value': 'context-only', 'owner': 'native'}]}, 'expect': 0})
    require(native_no_fallback['success'] and native_no_fallback['count'] == 0,
            'native owner silently fell back to a proxy attribute')
    missing = FMCAD.call('entity.find', {'kind': 'body', 'component': component['component'],
        'instances': True, 'filters': {'attributes': [
            {'group': group, 'name': 'missingRole', 'value': 'x', 'owner': 'native'}]}, 'expect': 0})
    require(missing['success'] and missing['count'] == 0 and
            all(any(reason.startswith('attribute missing:') for reason in row['reasons'])
                for row in missing['rejected']), 'missing attribute was not an explicit nonmatch')
    multiple = FMCAD.call('entity.find', {'kind': 'body', 'component': component['component'],
        'instances': True, 'filters': {'attributes': [
            {'group': group, 'name': 'definitionRole', 'value': 'physical-part', 'owner': 'native'}]},
        'expect': 1})
    require(not multiple['success'] and multiple['status'] == 'fail' and multiple['count'] == 2,
            'count failure lost multiple matches/cardinality')
    try:
        FMCAD.call('entity.find', {'kind': 'body', 'component': {'kind': 'component', 'name': 'root'},
            'occurrence': component['occurrence'], 'instances': True, 'filters': {'attributes': [
                {'group': group, 'name': 'site', 'value': 'north', 'owner': 'occurrence'}]}})
    except ValueError as error:
        require('contexts disagree' in str(error), 'context conflict had an unexpected rejection')
    else:
        raise RuntimeError('conflicting component and occurrence contexts were accepted')
    return {'scratchOnly': True, 'independentExpectedPaths': expected_paths,
            'nativeMatches': native['count'], 'occurrenceMatch': north['entities'][0]['occurrencePath'],
            'queryConsumerVolumeCm3': measured['value'],
            'proxyMatch': proxy['entities'][0]['occurrencePath'], 'missingAttributeCount': missing['count'],
            'hiddenPhysicalBodyRetained': (native['count'] == 2 and
                                           hidden['items'][0]['isLightBulbOn'] is False),
            'multipleCountFailurePreservedMatches': multiple['count'] == 2}
