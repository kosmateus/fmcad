"""Pinned native BRep containment check; caller owns scratch lifecycle."""
ARGS = {}


def run(_context):
    import adsk.core

    if ARGS.get('approved') is not True:
        raise RuntimeError('Explicit native qualification opt-in is required')
    doc = FMCAD.doc
    creation_id = str(doc.creationId)
    if creation_id != ARGS.get('creationId'):
        raise RuntimeError('Pinned scratch creationId mismatch')
    fusion_build = str(adsk.core.Application.get().version)
    if fusion_build != ARGS.get('expectedFusionVersion'):
        raise RuntimeError('Fusion build differs from the fresh qualified build receipt')

    before = FMCAD.call('document.status', {})
    if (before.get('creationId') != creation_id or before.get('saved') is not False or
            before.get('modified') is not False):
        raise RuntimeError('Containment requires a fresh unsaved, unmodified scratch')

    prefix = ARGS.get('fixturePrefix')
    if not isinstance(prefix, str) or not prefix or not prefix.isalnum() or prefix.upper() != prefix:
        raise ValueError('fixturePrefix must be nonempty uppercase alphanumeric text')
    result = FMCAD.call('shape.box', {
        'name': prefix + '_Body', 'width': '10 mm', 'depth': '10 mm', 'height': '10 mm'})
    bodies = result.get('bodies')
    if result.get('healthState') != 0 or not isinstance(bodies, list) or len(bodies) != 1:
        raise RuntimeError('Native containment fixture did not create exactly one healthy body')

    body_count = FMCAD.root.bRepBodies.count
    timeline_count = FMCAD.design.timeline.count
    status_before_measure = FMCAD.call('document.status', {})
    measured = FMCAD.call('measure.contains', {
        'schemaVersion': 1,
        'frame': 'component',
        'region': {'type': 'body', 'ref': bodies[0]},
        'points': [['5 mm', '5 mm', '5 mm'], ['12 mm', '5 mm', '5 mm'], ['0 mm', '5 mm', '5 mm']],
        'boundaryTolerance': '0.01 mm',
        'method': 'native',
    })
    status_after_measure = FMCAD.call('document.status', {})
    classifications = [row.get('classification') for row in measured.get('results') or []]
    unchanged = (FMCAD.root.bRepBodies.count == body_count and
                 FMCAD.design.timeline.count == timeline_count and
                 status_before_measure.get('modified') == status_after_measure.get('modified') and
                 status_before_measure.get('saved') == status_after_measure.get('saved'))
    expected = ['inside', 'outside', 'boundary']
    expected_count = measured.get('status') == 'pass' and classifications == expected
    report = {
        'featureId': 'containment',
        'nativeCasesStatus': 'pass' if expected_count and unchanged else
            'unknown' if measured.get('status') == 'unknown' else 'fail',
        'fusionBuild': fusion_build,
        'document': {'name': str(doc.name), 'creationId': creation_id,
                     'savedBefore': before['saved'], 'modifiedBefore': before['modified']},
        'cases': {
            'native-body-inside-outside-boundary': {
                'status': 'pass' if expected_count else 'unknown' if measured.get('status') == 'unknown' else 'fail',
                'expected': expected, 'observed': classifications, 'result': measured,
            },
            'temporary-copy-leaves-document-unchanged': {
                'status': 'pass' if unchanged else 'fail',
                'bodyCountBefore': body_count, 'bodyCountAfter': FMCAD.root.bRepBodies.count,
                'timelineCountBefore': timeline_count, 'timelineCountAfter': FMCAD.design.timeline.count,
                'statusBefore': status_before_measure, 'statusAfter': status_after_measure,
            },
        },
        'modelUnchangedDuringEvidence': unchanged,
        'nativeQualified': False,
        'scratchCleanup': 'pending: caller must verify exact active creationId, discard only this scratch, then read back inventory',
        'limitations': ['Unsupported point-containment remains unknown; this runner does not fabricate inside/outside/boundary results.'],
    }
    FMCAD.emit(report)
    return report
