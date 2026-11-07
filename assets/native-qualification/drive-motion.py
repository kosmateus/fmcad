"""Fixed caller-owned joint solver and MotionLink fixture, ratio 1, phase 0."""
from typing import TypeAlias as _DriveFixtureAlias

_DriveFixtureJSON: _DriveFixtureAlias = None | bool | int | float | str | list['_DriveFixtureJSON'] | dict[str, '_DriveFixtureJSON']

ARGS = {}
DOC_NAME = None


def _drive_object(value: _DriveFixtureJSON) -> dict[str, _DriveFixtureJSON]:
    if not isinstance(value, dict):
        raise RuntimeError('Native drive fixture requires a complete JSON object')
    return value


def _drive_call(operation: str, data: dict[str, _DriveFixtureJSON]) -> dict[str, _DriveFixtureJSON]:
    return _drive_object(FMCAD.call(operation, data))


def _drive_part(result: dict[str, _DriveFixtureJSON], field: str) -> dict[str, _DriveFixtureJSON]:
    value = result.get(field)
    return {} if value is None else _drive_object(value)


def run(_context: str) -> dict[str, _DriveFixtureJSON]:
    import math
    import adsk.core
    doc = FMCAD.doc
    build = adsk.core.Application.get().version
    if ARGS.get('approved') is not True or ARGS.get('creationId') != doc.creationId or ARGS.get('expectedFusionVersion') != build:
        raise RuntimeError('Exact approved owned drive document and Fusion build required')
    prefix = ARGS.get('fixturePrefix')
    if not isinstance(prefix, str) or not prefix or not prefix.isalnum() or prefix.upper() != prefix:
        raise ValueError('Uppercase alphanumeric fixture prefix required')
    before = _drive_call('document.status', {})
    if before.get('creationId') != doc.creationId or before.get('saved') is not False or before.get('modified') is not False:
        raise RuntimeError('Drive fixture requires a fresh unsaved unmodified document')
    if FMCAD.root.bRepBodies.count or FMCAD.root.sketches.count or FMCAD.root.allOccurrences.count or FMCAD.design.timeline.count:
        raise RuntimeError('Drive fixture cannot adopt an existing assembly')
    ground = _drive_object(_drive_call('component.create', {'name': prefix + '_Ground'}).get('occurrence'))
    rotor = _drive_object(_drive_call('component.create', {'name': prefix + '_Rotor'}).get('occurrence'))
    follower_occurrence = _drive_object(_drive_call('component.create', {'name': prefix + '_Follower'}).get('occurrence'))
    if _drive_call('assembly.ground', {'occurrence': ground}).get('grounded') is not True:
        raise RuntimeError('Native base did not read back grounded')
    driver = _drive_object(_drive_call('joint.revolute', {'name': prefix + '_Driver', 'occurrenceOne': ground,
        'occurrenceTwo': rotor, 'point': 'origin', 'axis': 'Z'}).get('joint'))
    follower = _drive_object(_drive_call('joint.revolute', {'name': prefix + '_FollowerJoint', 'occurrenceOne': ground,
        'occurrenceTwo': follower_occurrence, 'point': 'origin', 'axis': 'Z'}).get('joint'))
    inspected = _drive_call('joint.inspect', {'joint': driver})
    inspected_ref = _drive_object(inspected.get('joint'))
    rotation = inspected.get('rotationValue')
    if inspected_ref.get('kind') not in ['Joint', 'AsBuiltJoint'] or inspected.get('motionType') != 'RevoluteJointMotion' or inspected.get('units') != 'cm/rad' or isinstance(rotation, bool) or not isinstance(rotation, (int, float)) or not math.isfinite(rotation):
        raise RuntimeError('Native Joint/AsBuiltJoint revolute readback is incomplete')
    start = float(rotation)
    ratio, phase = 1.0, 0.0
    cases: dict[str, _DriveFixtureJSON] = {}

    def restored(value: dict[str, _DriveFixtureJSON]) -> bool:
        return _drive_part(value, 'restore').get('status') == 'pass'

    def uncertain(value: dict[str, _DriveFixtureJSON]) -> bool:
        return value.get('status') in ['unknown', 'blocked'] or _drive_part(value, 'actualSolver').get('status') == 'unknown' or _drive_part(value, 'restore').get('status') == 'unknown'

    def assertion(passed: bool, result: dict[str, _DriveFixtureJSON]) -> str:
        return 'pass' if passed else 'unknown' if uncertain(result) else 'fail'

    def finish(override: str | None = None) -> dict[str, _DriveFixtureJSON]:
        statuses = [_drive_object(value).get('status') for value in cases.values()]
        status = override if override is not None else 'pass' if all(value == 'pass' for value in statuses) else 'unknown' if 'unknown' in statuses else 'fail'
        report: dict[str, _DriveFixtureJSON] = {'featureIds': ['native-drive-test', 'motion-link'], 'nativeCasesStatus': status,
            'fusionBuild': build, 'document': {'name': doc.name, 'creationId': doc.creationId, 'savedBefore': before['saved'], 'modifiedBefore': before['modified']},
            'expectation': {'ratio': ratio, 'phase': phase, 'source': 'integrated-fixture-contract: one-to-one, zero-phase'},
            'waypointContract': {'stepRadians': math.pi / 180, 'source': 'fixed one-degree grid; not inferred from link readback',
                'driverTolerance': 1e-6, 'followerTolerance': 1e-5},
            'cases': cases, 'nativeQualified': False, 'scratchCleanup': 'separate owner cleanup and exact restore required',
            'limitations': ['Native link declaration/readback is separate from observed solver behavior.',
                'One-degree grid qualifies sampled coupling only, not arbitrary-angle setter precision; original off-grid failure retained.',
                'Uncertain or failed restoration stops all subsequent fixture mutations; no retries.',
                'No restore-failure injection, body proxy geometry, file/cloud or document lifecycle effects.']}
        FMCAD.emit(report)
        return report

    def drive(case_ratio: float, case_phase: float) -> dict[str, _DriveFixtureJSON]:
        step = min(math.pi / 180, (math.pi / 180) / abs(case_ratio))
        return _drive_call('mechanism.drive-test', {'schemaVersion': 1, 'confirm': True, 'driver': driver,
            'waypoints': [start + index * step for index in range(5)],
            'followers': [{'joint': follower, 'coordinate': 'rotation', 'ratio': case_ratio, 'phase': case_phase, 'tolerance': 1e-5}],
            'budgetSeconds': 10, 'driverTolerance': 1e-6, 'restoreTolerance': 1e-6})

    disconnected = drive(ratio, phase)
    capture = _drive_part(_drive_part(disconnected, 'capture'), 'joints')
    refs = _drive_part(_drive_part(disconnected, 'observations'), 'joints')
    readback = isinstance(capture.get('driver'), dict) and isinstance(capture.get('follower:0'), dict) and set(refs) >= {'driver', 'follower:0'}
    disconnected_pass = disconnected.get('status') == 'fail' and _drive_part(disconnected, 'actualSolver').get('status') == 'fail' and restored(disconnected)
    cases['disconnected-follower-detected'] = {'status': assertion(disconnected_pass, disconnected), 'result': disconnected}
    cases['native-joint-readback'] = {'status': assertion(readback, disconnected), 'joints': capture, 'refs': refs}
    if not restored(disconnected):
        return finish('unknown' if _drive_part(disconnected, 'restore').get('status') == 'unknown' else 'fail')
    link = _drive_call('mechanism.motion-link.create', {'schemaVersion': 1, 'frame': 'component', 'confirm': True,
        'jointOne': driver, 'jointTwo': follower, 'valueOne': '1 rad', 'valueTwo': '1 rad', 'isReversed': False})
    link_pass = link.get('status') == 'pass' and link.get('nativeMotionLink') is True and _drive_part(link, 'readback').get('status') == 'pass'
    cases['native-motion-link-readback'] = {'status': assertion(link_pass, link), 'result': link}
    if not link_pass:
        return finish('unknown' if link.get('status') in ['unknown', 'blocked'] else 'fail')
    linked = drive(ratio, phase)
    linked_pass = linked.get('status') == 'pass' and _drive_part(linked, 'actualSolver').get('status') == 'pass' and restored(linked)
    cases['linked-driver-positive'] = {'status': assertion(linked_pass, linked), 'result': linked}
    if not restored(linked):
        return finish('unknown' if _drive_part(linked, 'restore').get('status') == 'unknown' else 'fail')
    wrong_ratio = drive(ratio * 2, phase)
    ratio_pass = wrong_ratio.get('status') == 'fail' and _drive_part(wrong_ratio, 'actualSolver').get('status') == 'fail' and restored(wrong_ratio)
    cases['wrong-ratio-negative'] = {'status': assertion(ratio_pass, wrong_ratio), 'result': wrong_ratio}
    if not restored(wrong_ratio):
        return finish('unknown' if _drive_part(wrong_ratio, 'restore').get('status') == 'unknown' else 'fail')
    wrong_phase = drive(ratio, phase + 0.2)
    phase_pass = wrong_phase.get('status') == 'fail' and _drive_part(wrong_phase, 'actualSolver').get('status') == 'fail' and restored(wrong_phase)
    cases['wrong-phase-negative'] = {'status': assertion(phase_pass, wrong_phase), 'result': wrong_phase}
    restores = [_drive_part(value, 'restore').get('status') for value in [disconnected, linked, wrong_ratio, wrong_phase]]
    cases['driver-restore-readback'] = {'status': 'pass' if all(value == 'pass' for value in restores) else 'unknown' if 'unknown' in restores else 'fail'}
    return finish()
