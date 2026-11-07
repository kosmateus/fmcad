"""Consent-gated scratch qualification helper, not an auto-executed live test.

Load after the production native_drive bundle in a pinned scratch CAD context.
No SDK mutation occurs on import. Call prepare_native_drive_scratch(ctx,
consent=True) only after explicit user authorization. This helper creates only
independent revolute controls; use the separate brokered
mechanism.motion-link.create operation to author a real native link. It never
guesses coupling from introspection or issues raw SDK calls. See docs/NATIVE_DRIVE.md.
"""


def _native_drive_scratch_guard(ctx, consent):
    if consent is not True:
        raise ValueError('Explicit user consent is required')
    if (not ctx.doc.isValid or ctx.doc.isSaved or
            not ctx.doc.name.startswith('FMCAD_NATIVE_DRIVE_') or ctx.app.activeDocument != ctx.doc):
        raise ValueError('Requires the pinned active unsaved FMCAD_NATIVE_DRIVE_ scratch document')


def prepare_native_drive_scratch(ctx, consent=False):
    """Build only independent revolute controls in an explicitly owned scratch.

    Creates no native coupling. A disconnected negative is available immediately;
    true native positive/wrong-ratio/phase cases need an authorized native fixture.
    No automatic document creation, close, save, retry or cleanup after ambiguity.
    """
    _native_drive_scratch_guard(ctx, consent)
    if ctx.root.occurrences.count:
        raise ValueError('Prepare requires an empty owned scratch root')
    components = [ctx.call('component.create', {'name': name}) for name in
                  ('DriveGround', 'DriveRotor', 'DriveDisconnected')]
    occurrences = [item['occurrence'] for item in components]
    ctx.resolve(occurrences[0]).isGrounded = True
    joints = []
    for i, name in ((1, 'DriveDriver'), (2, 'DriveFollower')):
        _native_drive_scratch_guard(ctx, consent)
        joints.append(ctx.call('joint.revolute', {'name': name, 'occurrenceOne': occurrences[0],
                         'occurrenceTwo': occurrences[i], 'point': 'origin', 'axis': 'Z'})['joint'])
    return {'document': {'creationId': ctx.doc.creationId, 'name': ctx.doc.name},
            'driver': joints[0], 'follower': joints[1], 'nativeCoupling': 'not-created',
            'qualified': False}


def qualify_native_drive_case(ctx, driver, follower, ratio, phase, consent=False,
                              case='disconnected', coordinate='rotation'):
    """Run one observed case; never labels a whole native qualification complete."""
    _native_drive_scratch_guard(ctx, consent)
    if case not in ('coupled', 'disconnected', 'wrong-ratio', 'wrong-phase', 'restore-failure'):
        raise ValueError('Unknown qualification case')
    if ratio == 0:
        raise ValueError('Nonzero expected relationship required')
    start = ctx.resolve(driver).jointMotion.rotationValue
    step = min(.05, .05 / abs(ratio))
    result = mechanism_drive_test(ctx, {'schemaVersion': 1, 'confirm': True, 'driver': driver,
        'waypoints': [start + i * step for i in range(5)], 'followers': [
            {'joint': follower, 'coordinate': coordinate, 'ratio': ratio, 'phase': phase, 'tolerance': 1e-6}]})
    return {'case': case, 'result': result, 'qualified': False,
            'note': 'Review real geometry/transforms and native fixture provenance; single case is not qualification.'}
