ARGS = {'prefix': 'caller-prefix'}
DOC_NAME = 'scratch'

def run(_context):
    one = FMCAD.call('component.create', {'name': ARGS['prefix'] + 'Base'})
    two = FMCAD.call('component.create', {'name': ARGS['prefix'] + 'Part'})
    for ref in (one['occurrence'], two['occurrence']):
        occurrence = FMCAD.resolve(ref, 'occurrence')
        if getattr(occurrence, 'isGrounded', False) or getattr(occurrence, 'isGroundToParent', False):
            FMCAD.call('assembly.unground', {'occurrence': ref})
    occurrences = [FMCAD.resolve(ref, 'occurrence') for ref in (one['occurrence'], two['occurrence'])]
    before = [list(occurrence.transform2.asArray()) for occurrence in occurrences]
    result = FMCAD.call('joint.rigid', {'name': ARGS['prefix'] + 'AsBuilt',
        'occurrenceOne': one['occurrence'], 'occurrenceTwo': two['occurrence']})
    after = [list(occurrence.transform2.asArray()) for occurrence in occurrences]
    if result.get('asBuilt') is not True or result.get('type') != 'rigid':
        raise RuntimeError('joint.rigid legacy default did not return an as-built joint')
    if any(abs(a-b) > 1e-8 for before_row, after_row in zip(before, after)
           for a, b in zip(before_row, after_row)):
        raise RuntimeError('legacy as-built joint changed an occurrence pose')
    FMCAD.emit({'asBuilt': result['asBuilt'], 'posesPreserved': True, 'joint': result['joint']})
