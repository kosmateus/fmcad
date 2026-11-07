"""GM17: mechanism couplings and stop checks.

A coupling is either a signed rotational ratio (gear/generic) or a screw lead
(linear advance per revolution) plus a zero phase. The relationship is evaluated
into an explicit, unwrapped track; angles may exceed 360 degrees. Native motion
links are gated: the installed stable SDK exposes no reliable motion-link
creation path, so `representation:native` is blocked and the explicit track is
returned instead of a fake joint. A disconnected follower is independent.

Reuses nothing geometry-specific; the coupling math is self-contained and read-only.
"""
import math as _mechanism_fusion_math
from collections.abc import Mapping as _mechanism_Mapping
from typing import cast as _mechanism_fusion_cast

if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'mechanism'

import adsk.core as _mechanism_fusion_core
import adsk.fusion as _mechanism_sdk_fusion


def _mechanism_contract(ctx: "CadContext", operation: str,
                        result: _mechanism_Mapping[str, "JsonValue"],
                        status: str = 'pass', read_only: bool = True,
                        **extra: "JsonValue") -> "JsonObject":
    identity = None
    if hasattr(ctx, 'doc') and getattr(ctx.doc, 'name', None) is not None:
        identity = {'creationId': getattr(ctx.doc, 'creationId', None), 'name': ctx.doc.name}
    component = None
    if hasattr(ctx, 'component') and hasattr(ctx, 'ref'):
        try:
            component = ctx.ref(ctx.component)
        except Exception:
            component = None
    out: "JsonObject" = _mechanism_fusion_cast("JsonObject", dict(schemaVersion=1, operation=operation, status=status, success=status == 'pass',
               documentIdentity=identity,
               units={'length': 'cm', 'angle': 'rad'},
               frame={'space': 'component', 'component': component},
               associativity='snapshot' if read_only else 'recipeRegeneration',
               method='GM17 mechanism coupling, stop and limit evaluation',
               provenance={'requirement': 'GM17', 'source': 'docs/MECHANISMS.md'}))
    result_values = dict(result)
    extra_values = dict(extra)
    out['warnings'] = list(_mechanism_fusion_cast(list["JsonValue"], result_values.pop('warnings', []))) + list(
        _mechanism_fusion_cast(list["JsonValue"], extra_values.pop('warnings', [])))
    out['limitations'] = ['Explicit evaluated track; angles may be unwrapped beyond 360 deg.',
                          'Gear ratio and screw lead are distinct relationships.',
                          'A disconnected follower is independent; engagement is never assumed.'] + \
                          list(_mechanism_fusion_cast(list["JsonValue"], result_values.pop('limitations', []))) + list(
                              _mechanism_fusion_cast(list["JsonValue"], extra_values.pop('limitations', [])))
    out['affected'] = list(_mechanism_fusion_cast(list["JsonValue"], result_values.pop('affected', []))) + list(
        _mechanism_fusion_cast(list["JsonValue"], extra_values.pop('affected', [])))
    out.update(extra_values)
    out.update(result_values)
    return out






def _mechanism_coupling(ctx: "CadContext", coupling: "JsonValue") -> "JsonObject":
    """Parse a coupling descriptor into a driven(driver) model (rad/rad or cm/rad)."""
    if not isinstance(coupling, dict):
        raise ValueError('coupling must be an object')
    kind = coupling.get('type', 'rotation')
    if kind not in ('rotation', 'screw'):
        raise ValueError('coupling.type must be rotation or screw')
    zero_phase = ctx.angle(coupling.get('zeroPhase', '0 deg'))
    if kind == 'screw':
        lead = ctx.length(coupling['lead'])
        if lead <= 0:
            raise ValueError('screw lead must be positive')
        driven_zero = ctx.length(coupling.get('drivenZero', '0 mm'))

        return {'type': 'screw', 'lead': lead, 'sign': 1, 'zeroPhase': zero_phase,
                'drivenZero': driven_zero, 'ratio': None}
    ratio, sign = None, None
    if 'ratio' in coupling:
        ratio = _mechanism_number(coupling['ratio'], 'ratio')
        sign = -1 if ratio < 0 else 1
    elif 'driverTeeth' in coupling or 'drivenTeeth' in coupling:
        if 'driverTeeth' not in coupling or 'drivenTeeth' not in coupling:
            raise ValueError('Provide both driverTeeth and drivenTeeth')
        driver_teeth = coupling['driverTeeth']
        driven_teeth = coupling['drivenTeeth']
        if (type(driver_teeth) is not int or driver_teeth < 1 or type(driven_teeth) is not int or driven_teeth < 1):
            raise ValueError('driverTeeth and drivenTeeth must be positive integers')
        external = coupling.get('external', True)
        if type(external) is not bool:
            raise ValueError('external must be boolean')
        ratio = (driver_teeth / driven_teeth) * (-1.0 if external else 1.0)
        sign = -1 if external else 1
    else:
        raise ValueError('rotation coupling requires ratio, or driverTeeth/drivenTeeth')
    driven_zero = ctx.angle(coupling.get('drivenZero', '0 deg'))

    return {'type': 'rotation', 'ratio': ratio, 'sign': sign, 'zeroPhase': zero_phase,
            'drivenZero': driven_zero, 'lead': None}


def _mechanism_range(ctx: "CadContext", value: "JsonValue",
                     label: str) -> tuple[float, float]:
    if not isinstance(value, dict) or set(value) - {'from', 'to'} or 'from' not in value or 'to' not in value:
        raise ValueError(label + ' requires {from,to} angle expressions')
    start, end = ctx.angle(value['from']), ctx.angle(value['to'])
    if not _mechanism_fusion_math.isfinite(start) or not _mechanism_fusion_math.isfinite(end):
        raise ValueError(label + ' must be finite')
    return start, end


def _mechanism_track(ctx: "CadContext", model: "JsonObject",
                     data: "JsonObject") -> "JsonObject":
    start, end = _mechanism_range(ctx, data['driverRange'], 'driverRange')
    samples = data.get('samples', 16)
    if type(samples) is not int or not 2 <= samples <= 100000:
        raise ValueError('samples must be an integer in 2..100000')
    measured = data.get('drivenMeasured')
    if measured is not None and (not isinstance(measured, list) or len(measured) != samples):
        raise ValueError('drivenMeasured requires one entry per sample')
    tolerance = data.get('tolerance')
    length_dim = model['type'] == 'screw'
    tolerance_value = (ctx.length if length_dim else ctx.angle)(tolerance) if tolerance is not None else None
    sample_count = samples
    track: list["JsonObject"] = []
    residuals: list[float] = []
    coupling_model = _mechanism_fusion_cast('_ScrewCoupling | _RotationCoupling', model)
    for i in range(sample_count):
        driver = start if i == 0 else end if i == sample_count - 1 else start * (1 - i / (sample_count - 1)) + end * (i / (sample_count - 1))
        driven = _mechanism_driven(coupling_model, driver)
        residual = None
        if measured is not None:
            expected = (ctx.length if length_dim else ctx.angle)(measured[i])
            residual = expected - driven
            residuals.append(abs(residual))
        track.append({'driver': {'value': driver, 'units': 'rad'},
                      'driven': {'value': driven, 'units': 'cm' if length_dim else 'rad'},
                      'residual': {'value': residual, 'units': 'cm' if length_dim else 'rad'} if residual is not None else None,
                      'engaged': (residual is None or tolerance_value is None or abs(residual) <= tolerance_value)})
    return {'driverRange': {'from': {'value': start, 'units': 'rad'}, 'to': {'value': end, 'units': 'rad'}},
            'samples': samples, 'unwrapped': True,
            'track': track,
            'maxResidual': {'value': max(residuals), 'units': 'cm' if length_dim else 'rad'} if residuals else None,
            'engaged': all(t['engaged'] for t in track)}


def mechanism_couple(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _mechanism_version(data)
    _model_fields(data, ('schemaVersion', 'frame', 'coupling', 'driverRange'),
                  ('samples', 'drivenMeasured', 'tolerance', 'representation', 'limits',
                   'stopSurfaces', 'sensorWindow', 'engagement'))
    representation = data.get('representation', 'explicit')
    if representation not in ('explicit', 'native'):
        raise ValueError('representation must be explicit or native')
    model = _mechanism_coupling(ctx, data['coupling'])
    result = {'representation': representation,
              'type': model['type'], 'ratio': model['ratio'], 'lead': model['lead'],
              'sign': model['sign'],
              'zeroPhase': {'value': model['zeroPhase'], 'units': 'rad'},
              'evaluated': _mechanism_track(ctx, model, data),
              'nativeMotionLink': False}
    if representation == 'native':
        result['representation'] = 'explicit'
        result['warnings'] = ['mechanism.couple evaluates mathematics only; use mechanism.motion-link.create to author a real native MotionLink.']
        result['limitations'] = ['No native link is created or inferred from SDK/API availability.']
        return _mechanism_contract(ctx, 'mechanism.couple', result, status='blocked', read_only=True)
    return _mechanism_contract(ctx, 'mechanism.couple', result, status='pass', read_only=True)


def mechanism_inspect(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _mechanism_version(data)
    _model_fields(data, ('schemaVersion', 'frame', 'coupling', 'driverValue', 'drivenValue'),
                  ('tolerance',))
    model = _mechanism_coupling(ctx, data['coupling'])
    length_dim = model['type'] == 'screw'
    driver = ctx.angle(data['driverValue'])
    driven_actual = (ctx.length if length_dim else ctx.angle)(data['drivenValue'])
    expected = _mechanism_driven(
        _mechanism_fusion_cast('_ScrewCoupling | _RotationCoupling', model), driver)
    residual = driven_actual - expected
    tolerance = (ctx.length if length_dim else ctx.angle)(data['tolerance']) if 'tolerance' in data else None
    engaged = tolerance is None or abs(residual) <= tolerance
    result = {'actual': {'driver': {'value': driver, 'units': 'rad'},
                         'driven': {'value': driven_actual, 'units': 'cm' if length_dim else 'rad'}},
              'expectedDriven': {'value': expected, 'units': 'cm' if length_dim else 'rad'},
              'residual': {'value': residual, 'units': 'cm' if length_dim else 'rad'},
              'engaged': engaged,
              'type': model['type'], 'ratio': model['ratio'], 'lead': model['lead'], 'sign': model['sign'],
              'zeroPhase': {'value': model['zeroPhase'], 'units': 'rad'}}
    return _mechanism_contract(ctx, 'mechanism.inspect', result,
                               status='pass' if engaged else 'fail', read_only=True)


def _mechanism_limit_checks(ctx: "CadContext", data: "JsonObject",
                            model: "JsonObject") -> list["JsonObject"]:
    limits = data.get('limits', {})
    if not isinstance(limits, dict):
        raise ValueError('limits must be an object')
    checks: list["JsonObject"] = []
    hard = limits.get('hard')
    program = limits.get('program')
    working = limits.get('working')
    hard_data = _mechanism_fusion_cast("JsonObject", hard) if hard is not None else None
    program_data = _mechanism_fusion_cast("JsonObject", program) if program is not None else None
    if hard is None:
        checks.append({'check': 'hard-stop', 'status': 'unknown', 'message': 'no hard limit declared'})
    else:
        hard_max = ctx.angle(hard_data['max']) if isinstance(hard, dict) and hard_data is not None and 'max' in hard_data else None
        if hard_max is None:
            checks.append({'check': 'hard-stop', 'status': 'unknown', 'message': 'hard limit requires max'})
        else:
            checks.append({'check': 'hard-stop', 'status': 'pass',
                           'hardLimit': {'value': hard_max, 'units': 'rad'}})
    if program_data is not None and hard_data is not None and 'max' in program_data and 'max' in hard_data:
        program_max = ctx.angle(program_data['max'])
        hard_max = ctx.angle(hard_data['max'])
        margin = hard_max - program_max
        ok = program_max < hard_max
        checks.append({'check': 'program-vs-hard', 'status': 'pass' if ok else 'fail',
                       'programLimit': {'value': program_max, 'units': 'rad'},
                       'hardLimit': {'value': hard_max, 'units': 'rad'},
                       'margin': {'value': margin, 'units': 'rad'},
                       'message': 'program limit must be a distinct limit reached before the physical stop' if not ok else None})
    else:
        checks.append({'check': 'program-vs-hard', 'status': 'unknown', 'message': 'declared program and hard limits are both required'})
    return checks


def mechanism_stop_check(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _mechanism_version(data)
    _model_fields(data, ('schemaVersion', 'frame', 'coupling'),
                  ('limits', 'stopSurfaces', 'sensorWindow', 'engagement', 'tolerance',
                   'lengthTolerance', 'driverValue', 'drivenValue'))
    model = _mechanism_coupling(ctx, data['coupling'])
    length_dim = model['type'] == 'screw'
    tolerance = (ctx.length if length_dim else ctx.angle)(data.get('tolerance', '0.01 mm' if length_dim else '0.01 deg'))
    length_tolerance = ctx.length(data.get('lengthTolerance', '0 mm'))
    checks = _mechanism_limit_checks(ctx, data, model)
    driver_value = ctx.angle(data['driverValue']) if 'driverValue' in data else None
    expected = _mechanism_driven(
        _mechanism_fusion_cast('_ScrewCoupling | _RotationCoupling', model), driver_value
    ) if driver_value is not None else None
    # Engagement: a mechanical counter must remain engaged (coupling not slipped)
    # up to and including the hard stop.
    if driver_value is not None:
        if 'drivenValue' not in data:
            raise ValueError('driverValue requires drivenValue')
        driven_actual = (ctx.length if length_dim else ctx.angle)(data['drivenValue'])
        residual = driven_actual - _mechanism_fusion_cast(float, expected)
        engaged = abs(residual) <= tolerance
        checks.append({'check': 'engagement', 'status': 'pass' if engaged else 'fail',
                       'residual': {'value': residual, 'units': 'cm' if length_dim else 'rad'},
                       'tolerance': {'value': tolerance, 'units': 'cm' if length_dim else 'rad'},
                       'message': 'mechanical counter keeps engagement through the hard stop' if engaged else 'coupling slipped beyond tolerance before the hard stop'})
    else:
        checks.append({'check': 'engagement', 'status': 'unknown', 'message': 'driverValue/drivenValue not supplied'})
    stop_surfaces = data.get('stopSurfaces')
    if stop_surfaces is not None:
        if not isinstance(stop_surfaces, list) or not stop_surfaces:
            raise ValueError('stopSurfaces must be a nonempty array')
        for i, surface in enumerate(stop_surfaces):
            if not isinstance(surface, dict) or 'clearance' not in surface:
                raise ValueError('stopSurfaces entries require a clearance length')
            clearance = ctx.length(surface['clearance'])
            margin = clearance - length_tolerance
            checks.append({'check': 'stop-surface-' + str(i), 'status': 'pass' if margin >= 0 else 'fail',
                           'clearance': {'value': clearance, 'units': 'cm'},
                           'margin': {'value': margin, 'units': 'cm'},
                           'ref': surface.get('ref')})
    else:
        checks.append({'check': 'stop-surface', 'status': 'unknown', 'message': 'no stop surface declared; physical stop evidence is required'})
    window = data.get('sensorWindow')
    if window is not None:
        start, end = _mechanism_range(ctx, window, 'sensorWindow')
        inside = True
        limits = _mechanism_fusion_cast("JsonObject", data.get('limits', {}))
        working = limits.get('working')
        if isinstance(working, dict) and 'min' in working and 'max' in working:
            wmin, wmax = ctx.angle(working['min']), ctx.angle(working['max'])
            inside = wmin <= start and end <= wmax
        checks.append({'check': 'sensor-window', 'status': 'pass' if inside else 'fail',
                       'window': {'from': {'value': start, 'units': 'rad'}, 'to': {'value': end, 'units': 'rad'}},
                       'message': None if inside else 'sensor window lies outside the working range'})
    statuses = {_mechanism_fusion_cast(str, c['status']) for c in checks}
    status = 'fail' if 'fail' in statuses else ('unknown' if 'unknown' in statuses else 'pass')
    result: "JsonObject" = {'checks': checks, 'coupling': {'type': model['type'], 'ratio': model['ratio'],
                                             'lead': model['lead'], 'sign': model['sign']},
              'limits': data.get('limits', {}),
              'programLimitIsNotPhysicalStop': any(c['check'] == 'program-vs-hard' and c['status'] == 'pass' for c in checks)}
    return _mechanism_contract(ctx, 'mechanism.stop-check', result, status=status, read_only=True)


CAD_HANDLERS.update({'mechanism.couple': mechanism_couple,
                     'mechanism.inspect': mechanism_inspect,
                     'mechanism.stop-check': mechanism_stop_check})

_fmcad_mechanism_runtime_loaded = True
