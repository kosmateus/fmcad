"""Build a tiny source definition in the owned external-reference scratch file."""
DOC_NAME = "FMCAD_iw7_6_external_source v1"


def run(context):
    existing = [FMCAD.design.allComponents.item(i)
                for i in range(FMCAD.design.allComponents.count)
                if FMCAD.design.allComponents.item(i).name == 'IW76_External']
    if existing:
        return {'scratchOnly': True, 'componentExists': True}
    result = FMCAD.call('component.create', {'name': 'IW76_External'})
    return {'scratchOnly': True, 'component': result['component'], 'occurrence': result['occurrence']}
