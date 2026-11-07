"""Change or restore one pinned, owned driver source and check its physical witness."""
ARGS = {}
DOC_NAME = ''


def run(_context):
    required = {'projectId', 'folderId', 'fileId', 'creationId', 'version',
                'parameter', 'expectedExpression', 'expression', 'expectedValue'}
    if not isinstance(ARGS, dict) or set(ARGS) != required:
        raise ValueError('Driver update requires exact owned identity and before/after values')
    doc = FMCAD.doc
    file = doc.dataFile
    if (file is None or doc.creationId != ARGS['creationId'] or file.id != ARGS['fileId'] or
            file.parentProject.id != ARGS['projectId'] or file.parentFolder.id != ARGS['folderId'] or
            int(file.versionNumber) != ARGS['version'] or file.isComplete is not True or
            file.isReadOnly is not False or doc.isModified):
        raise ValueError('Driver update target differs from exact clean saved owned pin')
    parameter = FMCAD.design.userParameters.itemByName(ARGS['parameter'])
    if parameter is None or parameter.expression != ARGS['expectedExpression']:
        raise ValueError('Driver expression no longer matches the declared source baseline')
    bodies = [FMCAD.root.bRepBodies.item(i) for i in range(FMCAD.root.bRepBodies.count)]
    if len(bodies) != 1 or not bodies[0].isSolid:
        raise ValueError('Driver source requires one solid physical witness')
    FMCAD.call('param.apply', {'parameters': [{'name': ARGS['parameter'],
        'expression': ARGS['expression'], 'unit': 'mm'}], 'overwrite': True})
    if not FMCAD.design.computeAll():
        raise RuntimeError('Driver source recompute failed; inspect before any follow-up')
    if (parameter.expression != ARGS['expression'] or
            abs(float(parameter.value) - float(ARGS['expectedValue'])) > 1e-9 or
            abs(float(bodies[0].volume) - float(ARGS['expectedValue'])) > 1e-9):
        raise RuntimeError('Driver source expression/value/physical witness readback failed')
    health = FMCAD.call('history.check', {})
    if health.get('status') != 'pass' or health.get('healthy') is not True:
        raise RuntimeError('Driver source history is unhealthy')
    return {'status': 'pass', 'fileId': file.id, 'creationId': doc.creationId,
        'parameter': parameter.name, 'expression': parameter.expression,
        'valueCm': float(parameter.value), 'bodyVolumeCm3': float(bodies[0].volume),
        'healthy': True, 'requiresAuthorizedSave': True}
