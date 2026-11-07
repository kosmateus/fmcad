"""Read-only observation of a pinned .10 scratch fixture after an uncertain test action."""
ARGS = []
DOC_NAME = ''


def run(_context):
    design = FMCAD.design
    parameters = FMCAD.call('param.inspect', {})
    health = FMCAD.call('history.check', {})
    bodies = [{'name': str(body.name), 'isSolid': bool(body.isSolid), 'volumeCm3': float(body.volume)}
              for body in FMCAD.root.bRepBodies]
    derived = [{'name': str(parameter.name), 'expression': str(parameter.expression),
                'valueInternal': float(parameter.value), 'unit': str(parameter.unit)}
               for parameter in design.derivedParameters]
    return {'parameters': parameters, 'derivedParameters': derived,
            'health': {'status': health.get('status'), 'healthy': health.get('healthy'),
                       'coverage': health.get('coverage')}, 'bodies': bodies,
            'deriveFeatures': int(FMCAD.root.features.deriveFeatures.count),
            'occurrences': [{'path': occ.fullPathName, 'isDerived': bool(occ.isDerived),
                             'isReferencedComponent': bool(occ.isReferencedComponent)}
                            for occ in FMCAD.root.allOccurrences],
            'timeline': {'markerPosition': int(design.timeline.markerPosition),
                         'count': int(design.timeline.count)}}
