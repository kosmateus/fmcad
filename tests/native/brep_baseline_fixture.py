"""Two-invocation native acceptance driver. NOT run by the offline suite.

The caller supplies the broker-admitted, pinned scratch fixture adapter; this
module does not connect to Fusion, save/close documents or bypass the queue.
Export the returned reference, terminate the first SDK Python invocation, then
invoke restore_phase in a fresh invocation with that same owned reference.
"""

TOLERANCES = {'volume': '0.000001 cm^3', 'length': '0.000001 cm', 'angle': '0.000001 rad'}


def guard(fixture, consent, expected):
    if consent is not True:
        raise PermissionError('Explicit native qualification consent required')
    if not expected or fixture.identity() != expected or not fixture.is_owned_scratch():
        raise PermissionError('Exact owned scratch document identity required')


def capture_phase(service, fixture, *, consent=False, expected=None):
    guard(fixture, consent, expected)
    specs, frame = fixture.create_two_synthetic_solids()
    result = service.capture(specs, frame, 'durable')
    if result['status'] == 'unsupported':
        return {'status': 'unsupported', 'nativeRoundtrip': 'not-run', 'capture': result}
    if result['status'] != 'pass':
        raise AssertionError(result)
    return {'status': 'partial', 'nativeRoundtrip': 'awaiting-new-invocation',
            'baseline': result['baseline'], 'specs': specs, 'frame': frame}


def restore_phase(service, fixture, evidence, *, consent=False, expected=None):
    guard(fixture, consent, expected)
    reference, specs = evidence['baseline'], evidence['specs']
    inspected = service.inspect(reference)
    if inspected['status'] != 'pass':
        raise AssertionError(inspected)
    equal = service.compare(reference, specs, TOLERANCES)
    if equal['status'] != 'pass':
        raise AssertionError(equal)
    results = {'restoredEqual': equal}
    # The native fixture adapter must independently mutate and restore its own
    # scratch solids for each case. Failed restoration must raise, never hide.
    for case, status in (('equal-volume-different-shape', 'fail'),
                         ('changed-occurrence-pose', 'fail'),
                         ('missing-body', 'missing'), ('stale-source-version', 'stale')):
        with fixture.case(case) as current_specs:
            result = service.compare(reference, current_specs, TOLERANCES)
            if result['status'] != status:
                raise AssertionError((case, status, result))
            results[case] = result
    restored = service.compare(reference, specs, TOLERANCES)
    if restored['status'] != 'pass':
        raise AssertionError(('final scratch restoration', restored))
    return {'status': 'pass', 'nativeRoundtrip': 'performed', 'checks': results,
            'restoration': restored}
