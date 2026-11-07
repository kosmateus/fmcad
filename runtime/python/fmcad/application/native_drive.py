"""Driver-only experiment orchestration over a narrow native observation port.

Port: guard(), read(), drive_driver(rad), cancelled(), clock(). read() returns
independent plain-data joints/transforms, never the return value of a setter.
Cleanup is bounded to one driver write plus one full read, outside sample budget.
"""
from typing import TYPE_CHECKING as _NativeDriveTypeChecking, Protocol as _NativeDriveProtocol
from typing import TypedDict as _NativeDriveAppTypedDict, cast as _NativeDriveAppCast


if _NativeDriveTypeChecking:
    class _NativeDriveTrackRow(_NativeDriveAppTypedDict):
        index: int
        driver: int | float
        followers: list[int | float]

    class _NativeDrivePort(_NativeDriveProtocol):
        def guard(self) -> None: ...

        def read(self) -> "_NativeDriveSnapshot": ...

        def drive_driver(self, value: int | float) -> None: ...

        def cancelled(self) -> bool: ...

        def clock(self) -> float: ...


def _native_drive_run(plan: "_NativeDrivePlan", port: "_NativeDrivePort") -> "JsonObject":
    port.guard()
    before = port.read()  # Complete capture must succeed before the first write.
    driver_rotation = before['joints']['driver'].get('rotation')
    if driver_rotation is None:
        raise ValueError('Driver rotation is unavailable in the initial observation')
    if abs(plan['waypoints'][0] - driver_rotation) >= 3.141592653589793 / 2:
        raise ValueError('initial driver-to-waypoint step exceeds phase bound')
    start = port.clock()
    samples: list[JsonObject] = []
    errors: list[str] = []
    restore_errors: list[str] = []
    track: list[_NativeDriveTrackRow] = [
        {'index': index, 'driver': value,
         'followers': [f['ratio'] * value + f['phase'] for f in plan['followers']]}
        for index, value in enumerate(plan['waypoints'])
    ]
    restore_readback: "_NativeDriveSnapshot | None" = None
    previous: "_NativeDriveSnapshot | None" = None
    phases: dict[str, "int | float | None"] | None = None
    outcome: str = 'complete'
    try:
        # Include the captured pose in the measured phase chain; do not anchor an
        # actual phase to commanded/expected angles (which would hide wrong phase).
        previous = before
        phases = {key: row.get('rotation') for key, row in before['joints'].items()}
        driver_phase = phases.get('driver')
        if driver_phase is None:
            raise ValueError('Driver rotation is unavailable in the initial observation')
        for index, command in enumerate(plan['waypoints']):
            port.guard()
            if port.cancelled():
                outcome = 'cancelled'
                break
            if port.clock() - start >= plan['budgetSeconds']:
                outcome = 'budget-exceeded'
                break
            if abs(command - driver_phase) >= 3.141592653589793 / 2:
                raise ValueError('initial/current driver-to-waypoint step exceeds phase bound')
            expected = track[index]['followers']
            port.drive_driver(command)  # The only experimental setter.
            port.guard()
            actual = port.read()
            lifted = dict(phases)
            for key, row in actual['joints'].items():
                if 'rotation' in row:
                    previous_rotation = previous['joints'][key].get('rotation')
                    phase = phases.get(key)
                    if previous_rotation is None or phase is None:
                        raise ValueError('A measured joint rotation is unavailable for phase lifting')
                    lifted[key] = _native_drive_lift(previous_rotation, phase, row['rotation'])
            residuals: list[int | float] = []
            for n, follower in enumerate(plan['followers']):
                key = 'follower:' + str(n)
                if follower['coordinate'] == 'rotation':
                    value = lifted.get(key)
                else:
                    value = actual['joints'][key].get('slide')
                if value is None:
                    raise ValueError('A measured follower coordinate is unavailable')
                residuals.append(value - expected[n])
            driver_phase = lifted.get('driver')
            if driver_phase is None:
                raise ValueError('Driver rotation is unavailable after the observation')
            driver_error = driver_phase - command
            passed = abs(driver_error) <= plan['driverTolerance'] and all(
                abs(value) <= follower['tolerance'] for value, follower in zip(residuals, plan['followers']))
            sample = _NativeDriveAppCast('JsonObject', {
                'index': index, 'actual': actual, 'unwrappedPhase': lifted,
                'driverResidual': driver_error, 'followerResiduals': residuals, 'passed': passed})
            samples.append(sample)
            previous, phases = actual, lifted
            # A slow synchronous SDK call cannot be interrupted; detect overrun on
            # return, including the last sample, and always proceed to cleanup.
            if port.cancelled():
                outcome = 'cancelled'
                break
            if port.clock() - start >= plan['budgetSeconds']:
                outcome = 'budget-exceeded'
                break
    except Exception as exc:
        outcome = 'error'
        errors.append(type(exc).__name__ + ': ' + str(exc))
    finally:
        try:
            port.guard()
            port.drive_driver(before['joints']['driver']['rotation'])
        except Exception as exc:
            restore_errors.append('driver restore: ' + type(exc).__name__ + ': ' + str(exc))
        # Independently read even after restore setter failure. No follower writes,
        # no transform writes, no snap-to-expected fallback that masks disconnection.
        try:
            port.guard()
            restore_readback = port.read()
            restore_errors.extend(_native_drive_restore_check(before, restore_readback, plan['restoreTolerance']))
        except Exception as exc:
            restore_errors.append('restore readback: ' + type(exc).__name__ + ': ' + str(exc))
    complete = outcome == 'complete' and len(samples) == len(plan['waypoints'])
    observed = complete and all(sample['passed'] for sample in samples)
    restored = not restore_errors and restore_readback is not None
    passed = observed and restored
    return _NativeDriveAppCast('JsonObject', {'operation': 'mechanism.drive-test', 'schemaVersion': 1,
            'status': 'pass' if passed else 'fail', 'passed': passed, 'outcome': outcome,
            'commandedMathTrack': track, 'actualSolver': {'status': 'pass' if observed else 'fail' if complete else 'unknown',
                                                       'samples': samples},
            'nativeCapability': {'status': 'unknown',
                                  'motionLinkCreation': 'separate-operation-not-run', 'qualified': False,
                                 'evidence': 'sampled response does not qualify native coupling capability'},
            'capture': before, 'restore': {'status': 'pass' if restored else 'fail' if restore_readback is not None else 'unknown',
                                         'readback': restore_readback, 'errors': restore_errors},
            'errors': errors, 'units': {'rotation': 'rad', 'slide': 'cm', 'transformTranslation': 'cm'},
            'limitations': ['Sampled kinematics only; no continuous, contact, dynamics or physical validation.',
                            'Angular lift is local and cannot exclude aliased multiple revolutions between observations.',
                            'Initial absolute angular winding is unknown; initial native angle is the phase anchor.',
                            'Only observed joints and their occurrence transforms are verified; no document rollback.',
                            'Sample budget is cooperative; cleanup uses a separate one-write/one-read budget.',
                             'Native qualification requires an explicitly authorized live scratch experiment.']})
