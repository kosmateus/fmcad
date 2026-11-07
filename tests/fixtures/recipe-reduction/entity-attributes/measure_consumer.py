"""Read-only native proof that attribute query refs flow through measure.volume."""
DOC_NAME = "FMCAD_tcc_entity_attributes"


def run(context):
    component = FMCAD.resolve('TCC_PhysicalPart', 'component')
    reference = {'query': {'kind': 'body', 'scope': {'component': {
        'token': component.entityToken, 'kind': 'component', 'name': component.name}},
        'filters': {'attributes': [{'group': 'TCC_ATTRIBUTE_QUERY_FIXTURE',
            'name': 'definitionRole', 'value': 'physical-part', 'owner': 'native'}]}}}
    measured = FMCAD.call('measure.volume', {'ref': reference, 'units': 'cm3'})
    if abs(measured['value'] - 0.24) > 1e-6:
        raise RuntimeError('measure.volume query-reference result differs from independent box volume')
    return {'scratchOnly': True, 'consumer': 'measure.volume', 'referenceOwner': 'native',
            'volumeCm3': measured['value'], 'component': measured['ref']}
