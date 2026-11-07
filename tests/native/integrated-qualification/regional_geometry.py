"""Pinned-scratch regional geometry proof using the public cad-v1 facade."""
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
    if before.get('creationId') != creation_id or before.get('saved') is not False or before.get('modified') is not False:
        raise RuntimeError('Regional proof requires a fresh unsaved, unmodified scratch')

    prefix = ARGS.get('fixturePrefix')
    if not isinstance(prefix, str) or not prefix or not prefix.isalnum() or prefix.upper() != prefix:
        raise ValueError('fixturePrefix must be nonempty uppercase alphanumeric text')

    def box(label, width, depth, height):
        result = FMCAD.call('shape.box', {'name': prefix + '_' + label,
            'width': width, 'depth': depth, 'height': height})
        bodies = result.get('bodies')
        if result.get('healthState') != 0 or not isinstance(bodies, list) or len(bodies) != 1:
            raise RuntimeError('Native regional fixture did not create one healthy body: ' + label)
        return bodies[0]

    before_body = box('Before', '10 mm', '10 mm', '10 mm')
    after_body = box('After', '20 mm', '10 mm', '10 mm')
    equal_before = box('EqualBefore', '10 mm', '10 mm', '4 mm')
    equal_after = box('EqualAfter', '20 mm', '5 mm', '4 mm')
    hole_before_result = FMCAD.call('shape.ring', {'name': prefix + '_HoleBefore',
        'outerRadius': '5 mm', 'innerRadius': '2 mm', 'height': '5 mm'})
    hole_after_result = FMCAD.call('shape.cylinder', {'name': prefix + '_HoleAfter',
        'radius': '5 mm', 'height': '5 mm'})
    hole_mask_result = FMCAD.call('shape.cylinder', {'name': prefix + '_HoleMask',
        'radius': '2 mm', 'height': '5 mm'})
    hole_before = hole_before_result['bodies'][0]
    hole_after = hole_after_result['bodies'][0]
    hole_mask = hole_mask_result['bodies'][0]
    root_frame = {'space': 'assembly', 'component': {'kind': 'component', 'name': 'root'}}
    body_count_before = FMCAD.root.bRepBodies.count
    timeline_count_before = FMCAD.design.timeline.count
    status_before_measurement = FMCAD.call('document.status', {})

    def compare(before_ref, after_ref, allowed, protected=None):
        data = {'before': before_ref, 'after': after_ref, 'frame': root_frame, 'allowed': allowed}
        if protected is not None:
            data['protected'] = protected
        return FMCAD.call('geometry.compare-region', data)

    cases = {}
    cases['inside-mask-positive'] = compare(before_body, after_body, {'include': [after_body]})
    cases['outside-mask-negative'] = compare(before_body, after_body, {'include': [before_body]})
    # Both bodies have volume 400 mm^3; removal outside the allowed after-body
    # remains visible instead of cancelling the equal-volume addition.
    cases['equal-volume-outside-mask-negative'] = compare(equal_before, equal_after,
        {'include': [equal_after]})
    cases['mask-union-exclusion-positive'] = compare(before_body, after_body,
        {'include': [after_body, before_body], 'exclude': [before_body]})
    cases['overlapping-mask-union-positive'] = compare(before_body, after_body,
        {'include': [after_body, before_body]})
    cases['excluded-mask-hole-negative'] = compare(hole_before, hole_after,
        {'include': [hole_after], 'exclude': [hole_mask]})
    cases['protected-region-precedence-negative'] = compare(before_body, after_body,
        {'include': [after_body]}, {'include': [after_body], 'exclude': [before_body]})

    expected = {
        'inside-mask-positive': 'pass',
        'outside-mask-negative': 'fail',
        'equal-volume-outside-mask-negative': 'fail',
        'mask-union-exclusion-positive': 'pass',
        'overlapping-mask-union-positive': 'pass',
        'excluded-mask-hole-negative': 'fail',
        'protected-region-precedence-negative': 'fail',
    }
    assertions = {name: {'status': 'pass' if cases[name].get('status') == wanted else
                         'unknown' if cases[name].get('status') == 'unknown' else 'fail',
                         'expected': wanted, 'result': cases[name]}
                  for name, wanted in expected.items()}
    status_after_measurement = FMCAD.call('document.status', {})
    unchanged = (FMCAD.root.bRepBodies.count == body_count_before and
                 FMCAD.design.timeline.count == timeline_count_before and
                 status_before_measurement.get('modified') == status_after_measurement.get('modified') and
                 status_before_measurement.get('saved') == status_after_measurement.get('saved'))
    assertions['temporary-copies-leave-document-unchanged'] = {
        'status': 'pass' if unchanged else 'fail',
        'bodyCountBefore': body_count_before, 'bodyCountAfter': FMCAD.root.bRepBodies.count,
        'timelineCountBefore': timeline_count_before, 'timelineCountAfter': FMCAD.design.timeline.count,
        'statusBefore': status_before_measurement, 'statusAfter': status_after_measurement,
    }
    failed = any(row['status'] == 'fail' for row in assertions.values())
    unknown = any(row['status'] == 'unknown' for row in assertions.values())
    report = {
        'featureId': 'regional-geometry',
        'nativeCasesStatus': 'fail' if failed else 'unknown' if unknown else 'pass',
        'fusionBuild': fusion_build,
        'document': {'name': str(doc.name), 'creationId': creation_id,
                     'savedBefore': before['saved'], 'modifiedBefore': before['modified']},
        'fixture': {'equalVolumeBeforeMm3': 400, 'equalVolumeAfterMm3': 400},
        'cases': assertions,
        'modelUnchangedDuringEvidence': unchanged,
        'nativeQualified': False,
        'scratchCleanup': 'pending: caller must verify exact active creationId, discard only this scratch, then read back inventory',
        'limitations': ['Component-local finite BRep proof only; no continuous path or occurrence-instance frame sweep.'],
    }
    FMCAD.emit(report)
    return report
