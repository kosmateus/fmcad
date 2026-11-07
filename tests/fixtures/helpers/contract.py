ARGS = {'propagateFailure': False, 'testReadonly': False}
DOC_NAME = 'scratch'

def run(_context):
    import math
    import adsk.core

    if FMCAD.doc is None or FMCAD.design is None or FMCAD.root is None:
        raise RuntimeError('trusted SDK getters missing')
    if FMCAD.resolve('root', 'component') != FMCAD.root:
        raise RuntimeError('root reference did not resolve uniquely')
    bodies = FMCAD.call('entity.list', {'kind': 'body'})
    if 'entities' not in bodies:
        raise RuntimeError('FMCAD.call did not preserve the domain result')
    try:
        FMCAD.resolve({'query': {'kind': 'edge'}}, 'edge')
    except (RuntimeError, ValueError):
        pass
    else:
        raise RuntimeError('FMCAD.resolve accepted an ambiguous edge selector')
    if abs(FMCAD.length('5 mm') - 0.5) > 1e-12 or abs(FMCAD.angle('180 deg') - math.pi) > 1e-12:
        raise RuntimeError('unit helper mismatch')
    point = FMCAD.point(['1 mm', '2 mm', '3 mm'])
    if not isinstance(point, adsk.core.Point3D) or max(abs(a-b) for a,b in zip((point.x, point.y, point.z), (.1, .2, .3))) > 1e-12:
        raise RuntimeError('point conversion mismatch')
    if FMCAD.value('5 mm') is None:
        raise RuntimeError('value helper failed')
    if FMCAD.collection([]).count != 0:
        raise RuntimeError('collection helper failed')

    accepted = ({'accepted': True}, {'checkPassed': True}, {'passed': True})
    for result in accepted:
        FMCAD.require_pass(result)
    rejected = ({'success': True}, {'accepted': True, 'passed': False}, {'passed': 1},
                {'passed': True, 'success': False}, {'passed': True, 'failed': True})
    for result in rejected:
        try:
            FMCAD.require_pass(result)
        except RuntimeError:
            pass
        else:
            raise RuntimeError('require_pass accepted a false or absent acceptance flag')
    for status in ('unknown', 'missing', 'stale', 'blocked', 'error', 'fail', 'failed'):
        try:
            FMCAD.require_pass({'passed': True, 'status': status})
        except RuntimeError:
            pass
        else:
            raise RuntimeError('require_pass accepted unresolved status ' + status)

    before = FMCAD.design.timeline.markerPosition
    FMCAD.require_history_end()
    if FMCAD.design.timeline.markerPosition != before:
        raise RuntimeError('require_history_end moved the timeline marker')
    if ARGS.get('testReadonly'):
        try:
            FMCAD.call('shape.box', {'name': 'FMCAD_READONLY_MUST_NOT_CREATE', 'width': '1 mm',
                                     'depth': '1 mm', 'height': '1 mm'})
        except RuntimeError as exc:
            if 'readonly helper dispatch rejected' not in str(exc):
                raise
        else:
            raise RuntimeError('readonly dispatch accepted a mutating helper call')
    after = FMCAD.call('entity.list', {'kind': 'body'})
    if len(after['entities']) != len(bodies['entities']) or any(
            row.get('name') == 'FMCAD_READONLY_MUST_NOT_CREATE' for row in after['entities']):
        raise RuntimeError('readonly dispatch changed document geometry')
    FMCAD.emit({'domainResult': bodies, 'ambiguousSelector': 'query:kind=edge',
                'acceptanceCases': len(accepted) + len(rejected) + 7})
    if ARGS.get('propagateFailure'):
        FMCAD.call('fmcad.missing.operation', {})
