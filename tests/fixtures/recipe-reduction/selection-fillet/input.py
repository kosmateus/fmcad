ARGS = {'prefix': 'caller-name-prefix', 'radius': '1 mm', 'height': '20 mm', 'edgeRadius': '10 mm', 'tolerance': 1e-7, 'expectedEdges': 2}
DOC_NAME = 'scratch'

def run(_context):
    # Select the cylinder's two circular rim edges geometrically and guard cardinality.
    cylinder = FMCAD.call('shape.cylinder', {'name': ARGS['prefix'] + '_cylinder',
                                            'radius': ARGS['edgeRadius'], 'height': ARGS['height']})
    candidates = FMCAD.call('entity.list', {'kind': 'edge'})
    target_radius = FMCAD.length(ARGS['edgeRadius'])
    height = FMCAD.length(ARGS['height'])
    edges = []
    for edge in candidates['entities']:
        geometry = edge.get('geometry') or {}
        center = geometry.get('center') or [None, None, None]
        if geometry.get('type') == 'Circle3D' and abs(geometry.get('radius', -1) - target_radius) <= ARGS['tolerance'] and \
                min(abs(center[2]), abs(center[2] - height)) <= ARGS['tolerance']:
            edges.append({key: edge[key] for key in ('token', 'kind', 'component', 'occurrence') if key in edge})
    if len(edges) != ARGS['expectedEdges']:
        raise RuntimeError('edge cardinality mismatch')
    resolved = [FMCAD.resolve(edge, 'edge') for edge in edges]
    if len(resolved) != ARGS['expectedEdges']:
        raise RuntimeError('reference resolution cardinality mismatch')
    result = FMCAD.call('model.fillet', {'edges': edges, 'radius': ARGS['radius'], 'tangentChain': False})
    if 'feature' not in result or result.get('healthState') != 0:
        raise RuntimeError('fillet did not return a healthy native feature')
    FMCAD.require_pass({'passed': result['healthState'] == 0})
    return {'cylinder': cylinder['bodies'][0], 'selectedEdges': edges, 'fillet': result['feature'],
            'healthState': result['healthState']}
