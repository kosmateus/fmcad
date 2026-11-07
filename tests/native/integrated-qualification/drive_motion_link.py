"""Single pinned synthetic fixture for Drive and MotionLink acceptance cases."""
ARGS = {}


def run(_context):
    import adsk.core
    import math

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
        raise RuntimeError('Drive/MotionLink requires a fresh unsaved, unmodified scratch')

    prefix = ARGS.get('fixturePrefix')
    if not isinstance(prefix, str) or not prefix.isalnum() or prefix.upper() != prefix:
        raise ValueError('fixturePrefix must be uppercase alphanumeric text')
    ratio = ARGS.get('expectedRatio')
    phase = ARGS.get('expectedPhase')
    if type(ratio) not in (int, float) or not math.isfinite(ratio) or ratio == 0 or \
            type(phase) not in (int, float) or not math.isfinite(phase):
        raise ValueError('Expected ratio and phase must be explicit finite native-unit numbers')
    if ARGS.get('expectationSource') != 'integrated-fixture-contract: one-to-one, zero-phase':
        raise ValueError('Expected ratio/phase fixture contract is missing')

    ground = FMCAD.call('component.create', {'name': prefix + '_Ground'})['occurrence']
    rotor = FMCAD.call('component.create', {'name': prefix + '_Rotor'})['occurrence']
    follower_occurrence = FMCAD.call('component.create', {'name': prefix + '_Follower'})['occurrence']
    grounded = FMCAD.call('assembly.ground', {'occurrence': ground})
    if grounded.get('grounded') is not True:
        raise RuntimeError('Native base occurrence did not read back grounded')
    driver = FMCAD.call('joint.revolute', {
        'name': prefix + '_Driver', 'occurrenceOne': ground, 'occurrenceTwo': rotor,
        'point': 'origin', 'axis': 'Z'})['joint']
    follower = FMCAD.call('joint.revolute', {
        'name': prefix + '_FollowerJoint', 'occurrenceOne': ground,
        'occurrenceTwo': follower_occurrence, 'point': 'origin', 'axis': 'Z'})['joint']
    start = FMCAD.call('joint.inspect', {'joint': driver})['rotationValue']

    def restore_ok(result):
        return result.get('restore', {}).get('status') == 'pass'

    def unknown_outcome(result):
        return (result.get('status') in ('unknown', 'blocked') or
                result.get('actualSolver', {}).get('status') == 'unknown' or
                result.get('restore', {}).get('status') == 'unknown')

    def assertion_status(passed, result):
        return 'pass' if passed else 'unknown' if unknown_outcome(result) else 'fail'

    def partial_report(cases, status):
        return {
            'featureIds': ['native-drive-test', 'motion-link'],
            'nativeCasesStatus': status,
            'fusionBuild': fusion_build,
            'document': {'name': str(doc.name), 'creationId': creation_id,
                         'savedBefore': before['saved'], 'modifiedBefore': before['modified']},
            'expectation': {'ratio': ratio, 'phase': phase, 'source': ARGS['expectationSource']},
            'cases': cases,
            'nativeQualified': False,
            'scratchCleanup': 'pending: caller must verify exact active creationId, discard only this scratch, then read back inventory',
            'limitations': ['One-to-one, zero-phase is the explicit fixture contract; native link values are not used as evidence of solver behavior.',
                            'No restore-failure injection or body-proxy geometry qualification is included.'],
        }

    def drive(case_ratio, case_phase):
        step = min(math.pi / 180, (math.pi / 180) / abs(case_ratio))
        return FMCAD.call('mechanism.drive-test', {
            'schemaVersion': 1, 'confirm': True, 'driver': driver,
            'waypoints': [start + index * step for index in range(5)],
            'followers': [{'joint': follower, 'coordinate': 'rotation',
                           'ratio': case_ratio, 'phase': case_phase, 'tolerance': 1e-5}],
            'budgetSeconds': 10, 'driverTolerance': 1e-6, 'restoreTolerance': 1e-6,
        })

    disconnected = drive(ratio, phase)
    disconnected_capture = disconnected.get('capture', {})
    joint_readback = disconnected_capture.get('joints', {})
    joint_refs = disconnected.get('observations', {}).get('joints', {})
    joint_readback_pass = (isinstance(joint_readback.get('driver'), dict) and
                           isinstance(joint_readback.get('follower:0'), dict) and
                           set(joint_refs) >= {'driver', 'follower:0'})
    disconnected_pass = (disconnected.get('status') == 'fail' and
                         disconnected.get('actualSolver', {}).get('status') == 'fail' and
                         disconnected.get('restore', {}).get('status') == 'pass')
    cases = {
        'disconnected-follower-detected': {
            'status': assertion_status(disconnected_pass, disconnected), 'result': disconnected},
        'native-joint-readback': {
            'status': assertion_status(joint_readback_pass, disconnected),
            'joints': joint_readback, 'refs': joint_refs},
    }
    if not restore_ok(disconnected):
        report = partial_report(cases, 'unknown' if disconnected.get('restore', {}).get('status') == 'unknown' else 'fail')
        FMCAD.emit(report)
        return report
    link = FMCAD.call('mechanism.motion-link.create', {
        'schemaVersion': 1, 'frame': 'component', 'confirm': True,
        'jointOne': driver, 'jointTwo': follower,
        'valueOne': '1 rad', 'valueTwo': '1 rad', 'isReversed': False,
    })
    link_pass = (link.get('status') == 'pass' and link.get('nativeMotionLink') is True and
                 link.get('readback', {}).get('status') == 'pass')
    cases['native-motion-link-readback'] = {'status': assertion_status(link_pass, link), 'result': link}
    # A failed or unknown create can retain a native link; never continue on that state.
    if not link_pass:
        report = partial_report(cases, 'unknown' if link.get('status') in ('unknown', 'blocked') else 'fail')
        FMCAD.emit(report)
        return report
    linked = drive(ratio, phase)
    linked_pass = (linked.get('status') == 'pass' and
                   linked.get('actualSolver', {}).get('status') == 'pass' and
                   linked.get('restore', {}).get('status') == 'pass')
    cases['linked-driver-positive'] = {'status': assertion_status(linked_pass, linked), 'result': linked}
    if not restore_ok(linked):
        report = partial_report(cases, 'unknown' if linked.get('restore', {}).get('status') == 'unknown' else 'fail')
        FMCAD.emit(report)
        return report
    wrong_ratio = drive(ratio * 2, phase)
    wrong_ratio_pass = (wrong_ratio.get('status') == 'fail' and
                        wrong_ratio.get('actualSolver', {}).get('status') == 'fail' and
                        wrong_ratio.get('restore', {}).get('status') == 'pass')
    cases['wrong-ratio-negative'] = {'status': assertion_status(wrong_ratio_pass, wrong_ratio), 'result': wrong_ratio}
    if not restore_ok(wrong_ratio):
        report = partial_report(cases, 'unknown' if wrong_ratio.get('restore', {}).get('status') == 'unknown' else 'fail')
        FMCAD.emit(report)
        return report
    wrong_phase = drive(ratio, phase + 0.2)
    wrong_phase_pass = (wrong_phase.get('status') == 'fail' and
                        wrong_phase.get('actualSolver', {}).get('status') == 'fail' and
                        wrong_phase.get('restore', {}).get('status') == 'pass')
    cases['wrong-phase-negative'] = {'status': assertion_status(wrong_phase_pass, wrong_phase), 'result': wrong_phase}
    restore_statuses = [result.get('restore', {}).get('status') for result in
                        (disconnected, linked, wrong_ratio, wrong_phase)]
    cases['driver-restore-readback'] = {'status': 'pass' if all(value == 'pass' for value in restore_statuses) else
        'unknown' if any(value == 'unknown' for value in restore_statuses) else 'fail'}
    case_statuses = [case['status'] for case in cases.values()]
    passed = all(status == 'pass' for status in case_statuses)
    unresolved = any(status == 'unknown' for status in case_statuses)
    report = {
        'featureIds': ['native-drive-test', 'motion-link'],
        'nativeCasesStatus': 'pass' if passed else 'unknown' if unresolved else 'fail',
        'fusionBuild': fusion_build,
        'document': {'name': str(doc.name), 'creationId': creation_id,
                     'savedBefore': before['saved'], 'modifiedBefore': before['modified']},
        'expectation': {'ratio': ratio, 'phase': phase, 'source': ARGS['expectationSource']},
        'cases': cases,
        'nativeQualified': False,
        'scratchCleanup': 'pending: caller must verify exact active creationId, discard only this scratch, then read back inventory',
        'limitations': ['One-to-one, zero-phase is the explicit fixture contract; native link values are not used as evidence of solver behavior.',
                        'No restore-failure injection or body-proxy geometry qualification is included.'],
    }
    FMCAD.emit(report)
    return report
