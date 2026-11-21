"""GM14: cam profiles, pressure angle/curvature evaluation and cycle resolution.

Reuses GM07 normal-offset concepts for the roller working profile. The CWG CSV only
defines the rise flank; release/dwell remain unresolved and are never closed by a
chord or replaced by an eccentric. See docs/CAM.md.
"""
import math
import re

import adsk.core
import adsk.fusion


def _cam_contract(ctx, operation, result, status='pass', read_only=True, associativity=None,
                  warnings=None, limitations=None, **extra):
    identity = None
    if hasattr(ctx, 'doc') and getattr(ctx.doc, 'name', None) is not None:
        identity = {'creationId': getattr(ctx.doc, 'creationId', None), 'name': ctx.doc.name}
    component = None
    if hasattr(ctx, 'component') and hasattr(ctx, 'ref'):
        try:
            component = ctx.ref(ctx.component)
        except Exception:
            component = None
    return dict(schemaVersion=1, operation=operation, status=status, success=status == 'pass',
                documentIdentity=identity,
                units={'length': 'cm', 'angle': 'rad'},
                frame={'space': 'component', 'component': component},
                associativity=associativity or 'snapshot',
                warnings=list(warnings or []),
                method='GM14 cam pitch/working profiles, pressure angle, curvature and cycle resolution',
                limitations=['Rise-only sources stay open; no chord closure or eccentric substitution.',
                             'Drop edge and dynamics remain blocked until properly defined.'] + list(limitations or []),
                provenance={'requirement': 'GM14', 'source': 'docs/CAM.md'},
                affected=[], **extra, **result)


def _cam_length(ctx, expression):
    return ctx.length(expression) * 10.0


def _cam_rise(ctx, data):
    rise = data.get('rise')
    if not isinstance(rise, dict):
        raise ValueError('rise must be an object describing the rise law')
    base = _cam_length(ctx, data.get('baseRadius', '15 mm'))
    if base <= 0:
        raise ValueError('baseRadius must be positive')
    roller = _cam_length(ctx, data.get('rollerRadius', '5 mm'))
    if roller <= 0:
        raise ValueError('rollerRadius must be positive')
    if 'samples' in rise:
        samples = rise['samples']
        if not isinstance(samples, list) or len(samples) < 3:
            raise ValueError('rise.samples requires at least three {angle, lift} points')
        angles, lifts = [], []
        for sample in samples:
            if not isinstance(sample, dict) or 'angle' not in sample or 'lift' not in sample:
                raise ValueError('rise samples require angle and lift')
            angle = ctx.angle(sample['angle'])
            lift = _cam_length(ctx, sample['lift'])
            if lift < 0:
                raise ValueError('rise lift cannot be negative')
            angles.append(angle)
            lifts.append(lift)
        if angles[0] != 0.0 or angles[-1] <= angles[0]:
            raise ValueError('rise samples must start at angle 0 and increase monotonically')
        beta = angles[-1]
        span = [float(a) for a in angles]
        values = [float(l) for l in lifts]

        def r(theta):
            return base + _interpolate(span, values, theta)

        def rp(theta):
            delta = max(beta / 1000.0, 1e-6)
            return (r(theta + delta) - r(theta - delta)) / (2.0 * delta)

        def rpp(theta):
            delta = max(beta / 200.0, 1e-5)
            return (r(theta + delta) - 2.0 * r(theta) + r(theta - delta)) / (delta * delta)
        return base, roller, beta, r, rp, rpp, {'sampleCount': len(samples)}
    if rise.get('law') == 'halfCosine':
        lift = _cam_length(ctx, rise['lift'])
        beta = ctx.angle(rise['angle'])
        if lift <= 0 or not 0 < beta <= 2.0 * math.pi:
            raise ValueError('halfCosine rise requires positive lift and angle in (0, 360 deg]')
        k = math.pi / beta

        def r(theta):
            return base + (lift / 2.0) * (1.0 - math.cos(k * theta))

        def rp(theta):
            return (lift / 2.0) * k * math.sin(k * theta)

        def rpp(theta):
            return (lift / 2.0) * k * k * math.cos(k * theta)
        return base, roller, beta, r, rp, rpp, {'law': 'halfCosine', 'lift': lift, 'angle': beta}
    raise ValueError('rise law must be halfCosine or samples')


def _interpolate(xs, ys, x):
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    for i in range(len(xs) - 1):
        if xs[i] <= x <= xs[i + 1]:
            t = (x - xs[i]) / (xs[i + 1] - xs[i])
            return ys[i] + t * (ys[i + 1] - ys[i])
    return ys[-1]


def _cam_normal(r, rp, theta):
    """Unit outward normal of the pitch curve at angle theta (CCW cam)."""
    tangent = [rp * math.cos(theta) - r * math.sin(theta),
               rp * math.sin(theta) + r * math.cos(theta)]
    norm = math.hypot(*tangent)
    tangent = [t / norm for t in tangent]
    # CCW curve: outward normal is tangent rotated -90 degrees.
    return [tangent[1], -tangent[0]]


def _cam_compute(ctx, data):
    base, roller, beta, r, rp, rpp, meta = _cam_rise(ctx, data)
    follower_line = data.get('followerLine', [0.0, 1.0, 0.0])
    follower = _cad_direction(follower_line)
    phase = ctx.angle(data.get('phase', '0 deg'))
    direction = data.get('direction', 'ccw')
    if direction not in ('ccw', 'cw'):
        raise ValueError('direction must be ccw or cw')
    if direction == 'cw':
        phase = -phase
    samples = 2000
    max_pressure = 0.0
    min_rho = float('inf')
    max_pressure_at = 0.0
    min_rho_at = 0.0
    pitch_points = []
    working_points = []
    normals = []
    for i in range(samples + 1):
        theta = beta * i / samples
        radius = r(theta)
        derivative = rp(theta)
        second = rpp(theta)
        pressure = math.atan2(derivative, radius)
        if abs(pressure) > abs(max_pressure):
            max_pressure, max_pressure_at = pressure, theta
        denom = radius * radius + 2.0 * derivative * derivative - radius * second
        if denom > 1e-12:
            rho = (radius * radius + derivative * derivative) ** 1.5 / denom
            if 0 < rho < min_rho:
                min_rho, min_rho_at = rho, theta
        angle = theta + phase
        pitch_points.append([radius * math.cos(angle), radius * math.sin(angle)])
        normal = _cam_normal(radius, derivative, theta)
        rotated_normal = [normal[0] * math.cos(phase) - normal[1] * math.sin(phase),
                          normal[0] * math.sin(phase) + normal[1] * math.cos(phase)]
        normals.append(rotated_normal)
        working_points.append([pitch_points[-1][0] - roller * rotated_normal[0],
                               pitch_points[-1][1] - roller * rotated_normal[1]])
    return {'baseRadius': base, 'rollerRadius': roller, 'riseAngle': beta, 'rise': meta,
            'followerLine': follower, 'phase': phase, 'direction': direction,
            'maxPressureAngle': max_pressure, 'maxPressureAngleDegrees': math.degrees(max_pressure),
            'maxPressureAngleAt': max_pressure_at,
            'minPitchCurvatureRadius': min_rho, 'minPitchCurvatureRadiusAt': min_rho_at,
            'pitchPoints': pitch_points, 'workingPoints': working_points, 'normals': normals,
            'sampleCount': samples}


def cam_profile(ctx, data):
    _model_fields(data, ('schemaVersion', 'frame', 'rise'),
                  ('baseRadius', 'rollerRadius', 'followerLine', 'phase', 'direction', 'release', 'dwell'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('GM14 cam profile requires schemaVersion:1 and frame:component')
    computed = _cam_compute(ctx, data)
    unresolved = []
    resolved = [{'interval': 'rise', 'from': {'value': 0.0, 'units': 'rad'},
                 'to': {'value': computed['riseAngle'], 'units': 'rad'}, 'law': computed['rise'].get('law', 'samples')}]
    if 'dwell' in data:
        resolved.append({'interval': 'dwell', 'law': 'given'})
    if 'release' in data:
        resolved.append({'interval': 'release', 'law': 'given'})
    else:
        unresolved.append({'interval': 'release', 'reason': 'rise-only source; release is not defined and is not closed by chord or eccentric'})
    result = {'pitchProfile': computed['pitchPoints'],
              'workingProfile': computed['workingPoints'],
              'rollerRadius': {'value': computed['rollerRadius'], 'units': 'mm'},
              'normalOffset': {'value': computed['rollerRadius'], 'units': 'mm'},
              'maxPressureAngle': {'value': math.degrees(computed['maxPressureAngle']), 'units': 'deg'},
              'minPitchCurvatureRadius': {'value': computed['minPitchCurvatureRadius'], 'units': 'mm'},
              'followerLine': computed['followerLine'], 'phase': {'value': computed['phase'], 'units': 'rad'},
              'direction': computed['direction'],
              'resolvedIntervals': resolved, 'unresolvedIntervals': unresolved,
              'contact': 'resolved over the rise only', 'separation': 'release contact unresolved'}
    return _cam_contract(ctx, 'cam.profile', result, status='pass', read_only=True,
                         limitations=['Open rise flank is preserved; no chord closure.', 'Release/dwell are unresolved unless explicitly supplied.'])


def cam_evaluate(ctx, data):
    _model_fields(data, ('schemaVersion', 'frame', 'rise'),
                  ('baseRadius', 'rollerRadius', 'followerLine', 'phase', 'direction', 'minimumCurvatureRadius', 'maximumPressureAngle'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('GM14 cam evaluate requires schemaVersion:1 and frame:component')
    computed = _cam_compute(ctx, data)
    status = 'pass'
    checks = []
    if 'minimumCurvatureRadius' in data:
        required = _cam_length(ctx, data['minimumCurvatureRadius'])
        ok = computed['minPitchCurvatureRadius'] >= required
        checks.append({'check': 'curvature', 'status': 'pass' if ok else 'fail',
                       'value': {'value': computed['minPitchCurvatureRadius'], 'units': 'mm'},
                       'required': {'value': required, 'units': 'mm'}})
        status = 'fail' if not ok else status
    else:
        checks.append({'check': 'curvature', 'status': 'notEvaluated',
                       'value': {'value': computed['minPitchCurvatureRadius'], 'units': 'mm'},
                       'message': 'no required minimum curvature radius was declared'})
    if 'maximumPressureAngle' in data:
        required = ctx.angle(data['maximumPressureAngle'])
        ok = abs(computed['maxPressureAngle']) <= required
        checks.append({'check': 'pressure-angle', 'status': 'pass' if ok else 'fail',
                       'value': {'value': math.degrees(computed['maxPressureAngle']), 'units': 'deg'},
                       'required': {'value': math.degrees(required), 'units': 'deg'}})
        status = 'fail' if not ok else status
    else:
        checks.append({'check': 'pressure-angle', 'status': 'notEvaluated',
                       'value': {'value': math.degrees(computed['maxPressureAngle']), 'units': 'deg'},
                       'message': 'no maximum pressure angle was declared'})
    result = {'maxPressureAngle': {'value': math.degrees(computed['maxPressureAngle']), 'units': 'deg'},
              'minPitchCurvatureRadius': {'value': computed['minPitchCurvatureRadius'], 'units': 'mm'},
              'checks': checks}
    return _cam_contract(ctx, 'cam.evaluate', result, status=status, read_only=True)


def cam_cycle_check(ctx, data):
    _model_fields(data, ('schemaVersion', 'frame'), ('rise', 'baseRadius', 'rollerRadius', 'followerLine', 'phase', 'direction',
                    'release', 'dwell', 'returnLaw', 'followerCoupling'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('GM14 cam cycle check requires schemaVersion:1 and frame:component')
    resolved, unresolved = [], []
    status = 'pass'
    if 'rise' in data:
        resolved.append('rise')
    if 'dwell' in data:
        resolved.append('dwell')
    else:
        unresolved.append({'interval': 'dwell', 'reason': 'not defined'})
    if 'release' in data or 'returnLaw' in data:
        resolved.append('release')
    else:
        unresolved.append({'interval': 'release', 'reason': 'rise-only source; no release/return law'})
    if 'followerCoupling' in data:
        coupling = data['followerCoupling']
        if coupling not in ('spring-return', 'force-closed', 'form-closed'):
            raise ValueError('followerCoupling must be spring-return, force-closed or form-closed')
    result = {'resolvedIntervals': resolved, 'unresolvedIntervals': unresolved,
              'closure': 'open rise flank preserved; no chord closure or eccentric substitution',
              'followerCoupling': data.get('followerCoupling'),
              'dropEdgeDynamics': 'blocked (no proper definition or evidence)',
              'cycleStatus': 'pass' if not unresolved else 'unknown'}
    final = 'pass' if not unresolved else 'unknown'
    return _cam_contract(ctx, 'cam.cycle-check', result, status=final, read_only=True)


CAD_HANDLERS.update({'cam.profile': cam_profile, 'cam.evaluate': cam_evaluate, 'cam.cycle-check': cam_cycle_check})
