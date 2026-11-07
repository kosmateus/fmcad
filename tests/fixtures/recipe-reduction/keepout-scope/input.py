ARGS = {'prefix': 'caller-name-prefix', 'width': '20 mm', 'depth': '20 mm', 'height': '20 mm', 'separation': '50 mm', 'minimumClearance': '5 mm'}
DOC_NAME = 'scratch'

def run(_context):
    import math
    if abs(FMCAD.length('5 mm') - 0.5) > 1e-12 or abs(FMCAD.angle('180 deg') - math.pi) > 1e-12:
        raise RuntimeError('unit conversion mismatch')
    point = FMCAD.point(['1 mm', '2 mm', '3 mm'])
    if max(abs(a - b) for a, b in zip((point.x, point.y, point.z), (0.1, 0.2, 0.3))) > 1e-12:
        raise RuntimeError('point unit conversion mismatch')
    FMCAD.value('5 mm')
    marker = FMCAD.design.timeline.markerPosition
    FMCAD.require_history_end()
    if FMCAD.design.timeline.markerPosition != marker:
        raise RuntimeError('history-end check moved the marker')
    # Build an owned pair in the scratch document; the measurement is native B-Rep clearance.
    first = FMCAD.call('shape.box', {'name': ARGS['prefix'] + '_inner', 'width': ARGS['width'],
                                    'depth': ARGS['depth'], 'height': ARGS['height']})
    plane = FMCAD.call('datum.plane', {'name': ARGS['prefix'] + '_obstacle_plane',
                                      'plane': 'XY', 'offset': ARGS['separation']})
    second = FMCAD.call('shape.box', {'name': ARGS['prefix'] + '_obstacle', 'width': ARGS['width'],
                                     'depth': ARGS['depth'], 'height': ARGS['height'], 'plane': plane})
    measure = FMCAD.call('measure.distance', {'a': first['bodies'][0], 'b': second['bodies'][0], 'units': 'cm'})
    body = FMCAD.resolve(first['bodies'][0], 'body')
    collection = FMCAD.collection([body])
    if collection.count != 1:
        raise RuntimeError('ObjectCollection conversion failed')
    clearance = FMCAD.length(ARGS['minimumClearance'])
    accepted = measure['value'] >= clearance
    FMCAD.require_pass({'passed': accepted})
    return {'measured': measure, 'minimumClearanceCm': clearance, 'inner': first['bodies'][0],
            'obstacle': second['bodies'][0]}
