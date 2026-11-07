"""Read-only live cardinality/ambiguity check on the owned tcc scratch file."""
DOC_NAME = "FMCAD_tcc_entity_attributes"


def run(context):
    component = FMCAD.resolve('TCC_PhysicalPart', 'component')
    filters = {'attributes': [{'group': 'TCC_ATTRIBUTE_QUERY_FIXTURE',
        'name': 'definitionRole', 'value': 'physical-part', 'owner': 'native'}]}
    counted = FMCAD.call('entity.find', {'kind': 'body',
        'component': {'token': component.entityToken, 'kind': 'component', 'name': component.name},
        'instances': True, 'filters': filters, 'expect': 1})
    if counted['success'] or counted['status'] != 'fail' or counted['count'] != 2:
        raise RuntimeError('expected-count failure did not preserve both matching refs')
    try:
        FMCAD.call('entity.find', {'kind': 'body',
            'component': {'token': component.entityToken, 'kind': 'component', 'name': component.name},
            'instances': True, 'filters': filters, 'unique': True})
    except ValueError as error:
        message = str(error)
        if 'found 2' not in message:
            raise RuntimeError('unique ambiguity was rejected for an unexpected reason: ' + message)
    else:
        raise RuntimeError('unique:true silently selected one of two native matches')
    return {'scratchOnly': True, 'expectedCountFailurePreserved': counted['count'],
            'uniqueAmbiguityRejected': True,
            'paths': sorted(row['occurrencePath'] for row in counted['entities'])}
