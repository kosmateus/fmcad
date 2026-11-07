"""Opt-in native qualification on an ALREADY prepared synthetic document.

Never executed by offline tests or normal commands. Loading this file does not
touch Fusion. The caller must explicitly authorize live execution, pin the
document, prepare the positive/negative cases separately and supply fingerprints.
This runner makes no sketch/document edits and cannot create its own fixtures.
"""

REQUIRED_CASES = {
    'coordinate-positive': 'pass', 'shifted-center': 'fail', 'bad-diameter': 'fail',
    'microgap': 'fail', 'duplicate-edge': 'fail', 'hole-inside-material': 'pass',
    'hole-inside-void': 'fail', 'multiple-profiles-ambiguous': 'fail',
    'multiple-profiles-selected': 'pass', 'missing-topology': 'unknown',
}
FINGERPRINT_FIELDS = {'documentIdentity', 'component', 'occurrenceTransform',
                      'timelineMarker', 'timelineCount', 'sketchTransform', 'geometry',
                      'constraints', 'dimensions', 'isComputeDeferred', 'activeEditState'}


def qualify(ctx, cases, fingerprint, *, authorize_live=False):
    """fingerprint(ctx) must capture document, geometry and restoration state.

    The fixture producer owns names, entity tokens and analytic expected values.
    Missing native topology may be a qualified unavailable case, never fabricated
    by monkeypatching the SDK. The returned record is NOT automatically a pass.
    """
    if authorize_live is not True:
        raise ValueError('Explicit live Fusion qualification authorization is required')
    if set(cases) != set(REQUIRED_CASES):
        raise ValueError('Supply all required native qualification cases')
    for name, case in cases.items():
        if not case.get('unavailableReason') and case.get('operation') not in ('sketch.coordinate-check', 'sketch.profile-query'):
            raise ValueError('Qualification only permits the two read-only proof operations')
        if not case.get('unavailableReason'):
            expected = case.get('expected', {})
            if expected.get('healthStatus') != 'pass' or expected.get('geometryStatus') != REQUIRED_CASES[name]:
                raise ValueError('Each case must assert healthy sketch and its required geometry outcome')
    ctx.assert_identity()
    before = fingerprint(ctx)
    if not isinstance(before, dict) or FINGERPRINT_FIELDS - set(before):
        raise ValueError('Fingerprint must capture all required document/geometry/restoration fields')
    outcomes = []
    after = None
    try:
        for name, case in cases.items():
            if case.get('unavailableReason'):
                outcomes.append({'case': name, 'status': 'unknown', 'reason': case['unavailableReason']})
                continue
            result = ctx.call(case['operation'], case['data'])
            expected = case['expected']
            actual = {key: result.get(key) for key in expected}
            outcomes.append({'case': name, 'status': 'pass' if actual == expected else 'fail',
                             'expected': expected, 'actual': actual, 'evidence': result})
    finally:
        ctx.assert_identity()
        after = fingerprint(ctx)
        # There are no setters to undo. A changed fingerprint is a failed restore
        # invariant, not permission to mutate or retry the sketch.
        if before != after:
            raise RuntimeError('Read-only qualification changed document/geometry/restoration state; inspect without retry')
    statuses = [o['status'] for o in outcomes]
    return {'status': 'fail' if 'fail' in statuses else 'unknown' if 'unknown' in statuses else 'pass',
            'nativeQualification': True, 'readOnlyInvariant': 'pass',
            'documentIdentity': {'creationId': ctx.doc.creationId, 'name': ctx.doc.name},
            'before': before, 'after': after, 'outcomes': outcomes}
