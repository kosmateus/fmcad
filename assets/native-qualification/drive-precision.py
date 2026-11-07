"""Fixed stage-separated coordinate diagnostic; no coupling or precision PASS claim."""
from typing import TypeAlias as _PrecisionAlias

_PrecisionJSON: _PrecisionAlias = None | bool | int | float | str | list['_PrecisionJSON'] | dict[str, '_PrecisionJSON']
ARGS = {}
DOC_NAME = None


def _precision_object(value: _PrecisionJSON) -> dict[str, _PrecisionJSON]:
    if not isinstance(value, dict):
        raise RuntimeError('Complete precision diagnostic object required')
    return value


def _precision_call(operation: str, data: dict[str, _PrecisionJSON]) -> dict[str, _PrecisionJSON]:
    return _precision_object(FMCAD.call(operation, data))


def _precision_poses(snapshot: dict[str, _PrecisionJSON]) -> dict[str, list[_PrecisionJSON]]:
    rows = snapshot.get('occurrences')
    if not isinstance(rows, list):
        raise RuntimeError('Occurrence snapshot required')
    result: dict[str, list[_PrecisionJSON]] = {}
    for value in rows:
        row = _precision_object(value)
        ref = _precision_object(row.get('ref'))
        name, transform = ref.get('name'), row.get('transform')
        if not isinstance(name, str) or name in result or not isinstance(transform, list) or len(transform) != 16:
            raise RuntimeError('Distinct occurrence names and full matrices required')
        result[name] = transform
    return result


def _precision_near(first: _PrecisionJSON, second: _PrecisionJSON) -> bool:
    import math
    return (not isinstance(first, bool) and not isinstance(second, bool) and
        isinstance(first, (int, float)) and isinstance(second, (int, float)) and
        math.isfinite(first) and math.isfinite(second) and abs(first - second) <= 1e-6)


def run(_context: str) -> dict[str, _PrecisionJSON]:
    import math
    import adsk.core
    doc = FMCAD.doc
    build = adsk.core.Application.get().version
    if ARGS.get('approved') is not True or ARGS.get('creationId') != doc.creationId or ARGS.get('expectedFusionVersion') != build:
        raise RuntimeError('Exact approved fresh diagnostic document and Fusion build required')
    prefix = ARGS.get('fixturePrefix')
    if not isinstance(prefix, str) or not prefix or not prefix.isalnum() or prefix.upper() != prefix:
        raise ValueError('Uppercase alphanumeric prefix required')
    status = _precision_call('document.status', {})
    if status.get('creationId') != doc.creationId or status.get('saved') is not False or status.get('modified') is not False:
        raise RuntimeError('Fresh unsaved unmodified diagnostic document required')
    if FMCAD.root.bRepBodies.count or FMCAD.root.sketches.count or FMCAD.root.allOccurrences.count or FMCAD.design.timeline.count:
        raise RuntimeError('Cannot adopt an existing diagnostic assembly')
    ground = _precision_object(_precision_call('component.create', {'name': prefix + '_Ground'}).get('occurrence'))
    rotor = _precision_object(_precision_call('component.create', {'name': prefix + '_Rotor'}).get('occurrence'))
    if _precision_call('assembly.ground', {'occurrence': ground}).get('grounded') is not True:
        raise RuntimeError('Diagnostic base grounding not confirmed')
    joint = _precision_object(_precision_call('joint.revolute', {'name': prefix + '_Driver',
        'occurrenceOne': ground, 'occurrenceTwo': rotor, 'point': 'origin', 'axis': 'Z'}).get('joint'))
    initial = _precision_call('joint.inspect', {'joint': joint})
    start = initial.get('rotationValue')
    if initial.get('motionType') != 'RevoluteJointMotion' or initial.get('units') != 'cm/rad' or not _precision_near(start, 0):
        raise RuntimeError('Diagnostic initial revolute zero readback required')
    before = _precision_call('snapshot', {})
    poses = _precision_poses(before)
    trials: list[_PrecisionJSON] = []
    complete = True
    for target in [0.05, 0.1, math.pi / 180]:
        trial: dict[str, _PrecisionJSON] = {'targetRadians': target}
        try:
            driven = _precision_call('joint.drive', {'joint': joint, 'rotation': format(target, '.17g') + ' rad'})
            trial['drive'] = driven
            trial['independentJointReadback'] = _precision_call('joint.inspect', {'joint': joint})
            trial['observedSnapshot'] = _precision_call('snapshot', {})
            evidence = _precision_object(driven.get('coordinateReadback'))
            trial['evaluatedRadians'] = _precision_object(evidence.get('evaluated')).get('rotationValue')
            trial['beforeCaptureRadians'] = _precision_object(evidence.get('beforeCapture')).get('rotationValue')
            trial['afterCaptureRadians'] = driven.get('rotationValue')
        except Exception as error:
            trial['error'] = type(error).__name__ + ': ' + str(error)
            complete = False
        finally:
            try:
                trial['restoreCommand'] = _precision_call('joint.drive', {'joint': joint, 'rotation': '0 rad'})
                restored = _precision_call('joint.inspect', {'joint': joint})
                snapshot = _precision_call('snapshot', {})
                actual = _precision_poses(snapshot)
                restored_ok = (_precision_near(restored.get('rotationValue'), start) and set(poses) == set(actual) and
                    all(_precision_near(value, actual[name][index]) for name, matrix in poses.items() for index, value in enumerate(matrix)))
                trial['restore'] = {'status': 'pass' if restored_ok else 'fail', 'joint': restored, 'snapshot': snapshot}
            except Exception as error:
                trial['restore'] = {'status': 'unknown', 'error': type(error).__name__ + ': ' + str(error)}
                restored_ok = False
        trials.append(trial)
        if not restored_ok or not complete:
            complete = False
            break
    report: dict[str, _PrecisionJSON] = {'fixtureId': 'drive-precision-program-v1', 'diagnosticComplete': complete,
        'fusionBuild': build, 'document': {'name': doc.name, 'creationId': doc.creationId}, 'initial': initial,
        'before': before, 'trials': trials, 'nativeQualified': False, 'arbitraryAnglePrecisionQualified': False,
        'cleanup': 'separate exact owner cleanup/restore required',
        'limitations': ['Stage observations diagnose precision; no changed tolerance, solver repair or coupling qualification.',
            'Only driver helper writes; no raw SDK setters, follower writes, lifecycle, file or cloud effects.',
            'Each trial restores once and independently checks joint and all occurrence matrices; uncertainty stops further trials.']}
    FMCAD.emit(report)
    return report
