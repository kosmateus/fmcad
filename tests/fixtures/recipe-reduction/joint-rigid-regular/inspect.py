ARGS = {'joint': {'token': 'caller-joint-token', 'kind': 'Joint'}}
DOC_NAME = 'scratch'

def run(_context):
    output = {}
    if 'joint' in ARGS:
        output['joint'] = FMCAD.call('joint.inspect', {'joint': ARGS['joint']})
    output['parameters'] = FMCAD.call('param.inspect', {'names': ARGS.get('parameters', [])})
    occurrences = FMCAD.root.allOccurrences
    output['poses'] = [{'path': occurrences.item(index).fullPathName,
        'matrix': list(occurrences.item(index).transform2.asArray()),
        'grounded': getattr(occurrences.item(index), 'isGrounded', False),
        'groundToParent': getattr(occurrences.item(index), 'isGroundToParent', False)}
        for index in range(occurrences.count)]
    FMCAD.emit(output)
