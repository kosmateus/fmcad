"""GM11 involute spur gears and pair checks.

The involute flank is generated locally (Fusion exposes no parametric involute
constraint). Flanks are sampled involute polylines (chordal line segments whose
sagitta stays below flankTolerance); fitted splines are deliberately avoided so
the tooth sketch closes with plain coincident constraints that the VCS solver
accepts. The below-base-circle transition and undercut limits are explicit.
Diameters follow d=mz, db=d*cos(alpha), da=m(z+2*ha+2x), df=m(z-2*hf+2x).
"""
import math as _gear_fusion_math
from typing import TypedDict as _gear_fusion_TypedDict
from typing import cast as _gear_fusion_cast

if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'gear'


class _GearParameters(_gear_fusion_TypedDict):
    module: float
    teeth: int
    pressureAngle: float
    system: str
    addendumCoefficient: float
    dedendumCoefficient: float
    profileShift: float
    pitch: float
    base: float
    addendum: float
    root: float


def _gear_fields(data: "JsonObject", required: tuple[str, ...] = (),
                 optional: tuple[str, ...] = ()) -> None:
    _model_fields(data, required, optional)
    if 'teeth' in data and (type(data['teeth']) is not int or data['teeth'] < 1):
        raise ValueError('teeth must be a positive integer')
    if 'profileShift' in data:
        profile_shift = data['profileShift']
        if type(profile_shift) not in (int, float) or not _gear_fusion_math.isfinite(
                _gear_fusion_cast(int | float, profile_shift)):
            raise ValueError('profileShift must be a finite number')




def _gear_diameters(ctx: "CadContext", data: "JsonObject") -> _GearParameters:
    m = ctx.length(data['module'])
    z = _gear_fusion_cast(int, data['teeth'])
    alpha = ctx.angle(data.get('pressureAngle', '20 deg'))
    return _gear_fusion_cast(_GearParameters, _gear_diameter_plan(m, z, alpha, data))








def _gear_tooth_geometry(ctx: "CadContext", params: _GearParameters,
                         data: "JsonObject") -> tuple[list["JsonObject"], list["JsonObject"],
                                                       list["JsonObject"], "JsonObject"]:
    m = params['module']
    alpha = params['pressureAngle']
    x = params['profileShift']
    reduction = ctx.length(data.get('toothThicknessReduction', '0 mm'))
    backlash = ctx.length(data.get('backlashAllocation', '0 mm'))
    s = _gear_fusion_math.pi * m / 2.0 + 2.0 * x * m * _gear_fusion_math.tan(alpha) - reduction - backlash
    r = params['pitch'] / 2.0
    half = s / (2.0 * r)
    inv_alpha = _gear_fusion_math.tan(alpha) - alpha
    rot = half - inv_alpha
    rb = params['base'] / 2.0
    ra = params['addendum'] / 2.0
    rf = params['root'] / 2.0
    t_max = _gear_fusion_math.sqrt(max((ra / rb) ** 2 - 1.0, 0.0))
    tip_angle = rot + t_max - _gear_fusion_math.atan(t_max)
    # A non-positive rot (half tooth angle) or tip_angle would produce a
    # non-positive arc sweep. Fusion's always-CCW arcs swap start/end on a
    # negative sweep, silently corrupting the profile into a split/looped sketch.
    if rot <= 0 or tip_angle <= 0:
        raise ValueError('backlashAllocation and toothThicknessReduction leave no positive '
                         'tooth/tip half-angle; reduce them so a tooth profile remains')
    tolerance = ctx.length(data.get('flankTolerance', '0.001 mm'))
    _, _, _, count, _ = _gear_sample(params, tolerance)
    right = _gear_flank_points(rb, rot, t_max, count, False)
    left = list(reversed(_gear_flank_points(rb, rot, t_max, count, True)))
    root_left = [str(rf * _gear_fusion_math.cos(rot)) + ' cm', str(-rf * _gear_fusion_math.sin(rot)) + ' cm', '0 mm']
    root_right = [str(rf * _gear_fusion_math.cos(rot)) + ' cm', str(rf * _gear_fusion_math.sin(rot)) + ' cm', '0 mm']
    geometry: list["JsonObject"] = []
    for i in range(count):
        geometry.append({'type': 'line', 'name': 'rightFlank%d' % i, 'start': right[i], 'end': right[i + 1]})
    # Fusion's SketchArcs.addByCenterStartSweep always emits a counterclockwise
    # arc: a negative sweep does not draw clockwise, it swaps the arc's start and
    # end points (the passed startPoint becomes the end). The tip must therefore
    # start at the left-flank tip (angle -tip_angle) and sweep +2*tip_angle CCW to
    # the right-flank tip (angle +tip_angle), so that tip.start/tip.end land on the
    # exact flank endpoints the coincident constraints below expect.
    geometry.append({'type': 'arc', 'name': 'tip', 'center': ['0 mm', '0 mm', '0 mm'],
                     'start': left[0], 'sweep': str(2 * tip_angle) + ' rad'})
    for i in range(count):
        geometry.append({'type': 'line', 'name': 'leftFlank%d' % i, 'start': left[i], 'end': left[i + 1]})
    geometry.append({'type': 'line', 'name': 'leftTransition', 'start': left[count], 'end': root_left})
    # Root arc sweeps the *minor* arc from root_left (angle -rot) through the
    # tooth centerline to root_right (angle +rot). Fusion arcs are always CCW
    # (a negative sweep swaps start/end), so this must be a positive +2*rot sweep
    # starting at root_left; a negative sweep would put the arc's end on the wrong
    # side of the tooth and split the profile into two loops.
    geometry.append({'type': 'arc', 'name': 'rootArc', 'center': ['0 mm', '0 mm', '0 mm'],
                     'start': root_left, 'sweep': str(2 * rot) + ' rad'})
    geometry.append({'type': 'line', 'name': 'rightTransition', 'start': root_right, 'end': right[0]})
    constraints: list["JsonObject"] = []
    for i in range(count - 1):
        constraints.append({'type': 'coincident', 'entities': ['rightFlank%d.end' % i, 'rightFlank%d.start' % (i + 1)]})
    constraints.append({'type': 'coincident', 'entities': ['rightFlank%d.end' % (count - 1), 'tip.end']})
    constraints.append({'type': 'coincident', 'entities': ['tip.start', 'leftFlank0.start']})
    for i in range(count - 1):
        constraints.append({'type': 'coincident', 'entities': ['leftFlank%d.end' % i, 'leftFlank%d.start' % (i + 1)]})
    constraints.append({'type': 'coincident', 'entities': ['leftFlank%d.end' % (count - 1), 'leftTransition.start']})
    constraints.append({'type': 'coincident', 'entities': ['leftTransition.end', 'rootArc.start']})
    constraints.append({'type': 'coincident', 'entities': ['rootArc.end', 'rightTransition.start']})
    constraints.append({'type': 'coincident', 'entities': ['rightTransition.end', 'rightFlank0.start']})
    constraints.append({'type': 'concentric', 'entities': ['tip', 'rootArc']})
    z, ha, hf = params['teeth'], params['addendumCoefficient'], params['dedendumCoefficient']
    module_expression = _gear_fusion_cast(str, data['module'])
    ra_expr = '(' + module_expression + ') * (' + str(z) + ' + ' + repr(2 * ha + 2 * x) + ') / 2'
    rf_expr = '(' + module_expression + ') * (' + str(z) + ' - ' + repr(2 * hf - 2 * x) + ') / 2'
    dimensions = _gear_fusion_cast(list["JsonObject"], [
        {'type': 'radius', 'entities': ['tip'], 'expression': ra_expr},
        {'type': 'radius', 'entities': ['rootArc'], 'expression': rf_expr},
    ])
    return geometry, constraints, dimensions, {'halfToothAngle': half, 'involuteRollMax': t_max,
                                               'tipAngle': tip_angle, 'rotation': rot,
                                               'toothThickness': s, 'addendumExpression': ra_expr,
                                               'rootExpression': rf_expr}


def _gear_declared_plane(ctx: "CadContext", data: "JsonObject",
                         plane_name: str) -> tuple["JsonValue", bool]:
    if 'frame' in data and 'plane' in data and data['plane'] != 'XY':
        raise ValueError('frame and plane are mutually exclusive')
    if 'frame' in data:
        frame = data['frame']
        if isinstance(frame, str):
            frame = {'datum': frame}
        if not isinstance(frame, dict) or not frame:
            raise ValueError('frame must be a datum.frame name or frame descriptor')
        frame = _gear_fusion_cast("JsonObject", frame)
        return ctx.call('datum.plane', {'name': plane_name, 'mode': 'frame', 'frame': frame,
                                        'associativity': 'snapshot', 'schemaVersion': 1}), True
    plane = data.get('plane', 'XY')
    if _cad_type(ctx.resolve(plane, 'plane')) != 'ConstructionPlane':
        raise ValueError('gear plane must be a native construction plane')
    return plane, False


def _gear_section(ctx: "CadContext", name: str, plane: "JsonValue",
                  radius_expr: str) -> tuple["JsonValue", "adsk.fusion.Profile"]:
    sketch_result = _gear_fusion_cast("JsonObject", ctx.call('sketch.create', {'name': name, 'plane': plane}))
    sketch = sketch_result['sketch']
    origin = ctx.ref(ctx.resolve(sketch, 'sketch').originPoint)
    made = _gear_fusion_cast("JsonObject", ctx.call('sketch.geometry', {'sketch': sketch, 'geometry': [
        {'type': 'circle', 'name': 'disc', 'center': ['0 mm', '0 mm', '0 mm'], 'radius': radius_expr}]}))
    refs = _gear_fusion_cast("JsonObject", made['refs'])
    circle = refs['disc']
    ctx.call('sketch.constrain', {'sketch': sketch, 'type': 'coincident',
                                  'entities': [{'entity': circle, 'point': 'center'}, origin]})
    ctx.call('sketch.dimension', {'sketch': sketch, 'type': 'radius', 'entities': [circle],
                                  'text': [radius_expr, radius_expr, '0 mm'], 'expression': radius_expr})
    profile = ctx.resolve({'kind': 'profile', 'sketch': sketch, 'loopCount': 1}, 'profile')
    return sketch, profile


def shape_gear(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _gear_fields(data, ('name', 'module', 'teeth', 'faceWidth'),
                 ('pressureAngle', 'system', 'addendumCoefficient', 'dedendumCoefficient', 'profileShift',
                  'rootTreatment', 'toothThicknessReduction', 'backlashAllocation', 'bore', 'hub', 'key',
                  'plane', 'frame', 'axis', 'flankTolerance'))
    if ctx.length(data['faceWidth']) <= 0:
        raise ValueError('faceWidth must be positive')
    root_treatment = data.get('rootTreatment', 'trochoidal')
    if root_treatment not in ('straight', 'trochoidal'):
        raise ValueError('rootTreatment must be straight or trochoidal')
    root_treatment = _gear_fusion_cast(str, root_treatment)
    reduction = ctx.length(data.get('toothThicknessReduction', '0 mm'))
    backlash = ctx.length(data.get('backlashAllocation', '0 mm'))
    if reduction < 0 or backlash < 0:
        raise ValueError('toothThicknessReduction and backlashAllocation cannot be negative')
    params = _gear_diameters(ctx, data)
    undercut = _gear_undercut(params)
    axis = data.get('axis', 'Z')
    if _cad_type(ctx.resolve(axis, 'axis')) != 'ConstructionAxis':
        raise ValueError('gear axis must be a native construction axis')
    name = _gear_fusion_cast(str, data['name'])
    module_expression = _gear_fusion_cast(str, data['module'])
    plane, framed = _gear_declared_plane(ctx, data, name + '__plane')
    names = [name, name + '__root__section', name + '__tooth__section'] + \
            ([name + '__plane'] if framed else [])
    _shapes_reserve(ctx, names)
    z, ha, hf = params['teeth'], params['addendumCoefficient'], params['dedendumCoefficient']
    rf_expr = '(' + module_expression + ') * (' + str(z) + ' - ' + repr(2 * hf - 2 * params['profileShift']) + ') / 2'
    root_sketch, root_profile = _gear_section(ctx, name + '__root__section', plane, rf_expr)
    blank = _gear_fusion_cast("JsonObject", ctx.call('model.extrude', {'name': name + '__blank', 'profile': ctx.ref(root_profile),
                                       'distance': data['faceWidth']}))
    geometry, constraints, dimensions, tooth_info = _gear_tooth_geometry(ctx, params, data)
    tooth_spec: "JsonObject" = {'plane': plane, 'geometry': geometry, 'constraints': constraints, 'dimensions': dimensions}
    _shapes_prepare_sketch(ctx, tooth_spec)
    tooth_sketch_ref, refs = _shapes_build_sketch(ctx, name + '__tooth__section', tooth_spec)
    tooth_profile = ctx.resolve({'kind': 'profile', 'sketch': tooth_sketch_ref, 'loopCount': 1}, 'profile')
    tooth = _gear_fusion_cast("JsonObject", ctx.call('model.extrude', {'name': name + '__tooth', 'profile': ctx.ref(tooth_profile),
                                       'distance': data['faceWidth'], 'operation': 'join'}))
    pattern = _gear_fusion_cast("JsonObject", ctx.call('pattern.circular', {'name': name, 'entities': [tooth['feature']],
                                            'axis': axis, 'quantity': data['teeth'], 'angle': '360 deg'}))
    result: "JsonObject" = _gear_fusion_cast("JsonObject", {'feature': pattern['feature'], 'bodies': pattern.get('bodies', []), 'healthState': pattern.get('healthState', 0),
              'message': pattern.get('message', ''), 'blank': blank, 'tooth': tooth, 'pattern': pattern,
              'helpers': [root_sketch, tooth_sketch_ref, blank['feature'], tooth['feature'], pattern['feature']],
              'recipe': 'gear', 'atomic': False,
              'diameters': {'pitch': params['pitch'], 'base': params['base'], 'addendum': params['addendum'],
                            'root': params['root']},
               'diameterExpressions': {'pitch': '(' + module_expression + ') * ' + str(z),
                                       'base': '(' + module_expression + ') * ' + str(z) + ' * cos(' + _gear_fusion_cast(str, data.get('pressureAngle', '20 deg')) + ')',
                                       'addendum': '(' + module_expression + ') * (' + str(z) + ' + ' + repr(2 * ha + 2 * params['profileShift']) + ')',
                                       'root': '(' + module_expression + ') * (' + str(z) + ' - ' + repr(2 * hf - 2 * params['profileShift']) + ')'},
              'toothCount': z, 'pressureAngle': data.get('pressureAngle', '20 deg'),
              'rootTreatment': root_treatment,
               'rootFilletRadius': '0 mm' if root_treatment == 'straight' else ('(' + module_expression + ') * 0.38'),
              'undercut': undercut, 'toothThickness': tooth_info['toothThickness'],
              'approximationError': _gear_sample(params, ctx.length(data.get('flankTolerance', '0.001 mm')))[4],              'dependencies': 'Tip and root radii are driving expressions; involute flanks are sampled chordal segments (recipeRegeneration)',
               'regeneration': 'recipeRegeneration'})
    if 'bore' in data:
        if ctx.length(data['bore']) <= 0:
            raise ValueError('bore must be positive')
        pattern_bodies = _gear_fusion_cast(list["JsonValue"], pattern.get('bodies', []))
        blank_bodies = _gear_fusion_cast(list["JsonValue"], blank['bodies'])
        bore_result = _gear_fusion_cast("JsonObject", ctx.call('model.hole', {'name': name + '__bore', 'points': [ctx.ref(ctx.resolve(root_sketch, 'sketch').originPoint)],
                                                 'diameter': data['bore'], 'depth': data['faceWidth'],
                                                 'participants': [pattern_bodies[0] if pattern_bodies else blank_bodies[0]]}))
        result['bore'] = bore_result
        helpers = _gear_fusion_cast(list["JsonValue"], result['helpers'])
        helpers.append(bore_result['feature'])
    if 'hub' in data:
        hub = data['hub']
        if not isinstance(hub, dict):
            raise ValueError('hub must be a descriptor')
        _model_fields(hub, ('diameter', 'height'), ())
        if ctx.length(hub['diameter']) <= 0 or ctx.length(hub['height']) <= 0:
            raise ValueError('hub diameter and height must be positive')
        hub_result = _gear_fusion_cast("JsonObject", ctx.call('model.extrude', {'name': name + '__hub',
                                                    'profile': ctx.ref(ctx.resolve({'kind': 'profile', 'sketch': root_sketch, 'loopCount': 1}, 'profile')),
                                                    'distance': hub['height'], 'operation': 'join'}))
        result['hub'] = hub_result
        helpers = _gear_fusion_cast(list["JsonValue"], result['helpers'])
        helpers.append(hub_result['feature'])
    if 'key' in data:
        key = data['key']
        if not isinstance(key, dict):
            raise ValueError('key must be a descriptor')
        _model_fields(key, ('width', 'depth'), ())
        if ctx.length(key['width']) <= 0 or ctx.length(key['depth']) <= 0:
            raise ValueError('key width and depth must be positive')
        key_width = _gear_fusion_cast(str, key['width'])
        key_depth = _gear_fusion_cast(str, key['depth'])
        key_sketch_response = _gear_fusion_cast(
            "JsonObject", ctx.call('sketch.create', {'name': name + '__key__section', 'plane': plane}))
        key_sketch = key_sketch_response['sketch']
        ctx.call('sketch.geometry', {'sketch': key_sketch, 'geometry': [
            {'type': 'rectangle', 'name': 'key', 'start': ['-(' + key_width + ') / 2', '0 mm', '0 mm'],
             'end': ['(' + key_width + ') / 2', '(' + key_depth + ')', '0 mm']}]})
        key_result = _gear_fusion_cast("JsonObject", ctx.call('model.extrude', {'name': name + '__key',
                                                   'profile': ctx.ref(ctx.resolve({'kind': 'profile', 'sketch': key_sketch, 'loopCount': 1}, 'profile')),
                                                   'distance': data['faceWidth'], 'operation': 'cut'}))
        result['key'] = key_result
        helpers = _gear_fusion_cast(list["JsonValue"], result['helpers'])
        helpers.append(key_result['feature'])
    return result


def gear_pair_check(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('gear1', 'gear2'), ('centerDistance', 'phase', 'external', 'schemaVersion'))
    for key in ('gear1', 'gear2'):
        if not isinstance(data[key], dict):
            raise ValueError(key + ' must be a gear descriptor')
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('pair-check requires schemaVersion 1')
    external = data.get('external', True)
    if type(external) is not bool:
        raise ValueError('external must be boolean')
    gear_one = _gear_fusion_cast("JsonObject", data['gear1'])
    gear_two = _gear_fusion_cast("JsonObject", data['gear2'])
    p1 = _gear_diameters(ctx, gear_one)
    p2 = _gear_diameters(ctx, gear_two)
    m1, m2 = p1['module'], p2['module']
    if abs(m1 - m2) > 1e-12:
        raise ValueError('Pair gears must share one module; found %g and %g' % (m1, m2))
    z1, z2 = p1['teeth'], p2['teeth']
    ratio = (z2 / z1) if external else (-z2 / z1)
    nominal_center = m1 * (z1 + z2) / 2.0 if external else m1 * (z1 - z2) / 2.0
    center = ctx.length(data['centerDistance']) if 'centerDistance' in data else nominal_center
    if center <= 0:
        raise ValueError('centerDistance must be positive')
    db1, db2 = p1['base'], p2['base']
    if external:
        working_cos = (db1 + db2) / (2.0 * center) if center > 0 else 0.0
        sign = 1
    else:
        working_cos = (db1 - db2) / (2.0 * center) if center > 0 else 0.0
        sign = -1
    working_angle = _gear_fusion_math.acos(min(max(working_cos, -1.0), 1.0)) if 0 < working_cos < 1.0 else p1['pressureAngle']
    backlash = ctx.length(gear_one.get('backlashAllocation', '0 mm')) + \
               ctx.length(gear_two.get('backlashAllocation', '0 mm'))
    backlash += ctx.length(gear_one.get('toothThicknessReduction', '0 mm')) + \
                ctx.length(gear_two.get('toothThicknessReduction', '0 mm'))
    undercuts = [_gear_undercut(p1), _gear_undercut(p2)]
    infeasible = [g for g, u in zip(('gear1', 'gear2'), undercuts) if u['undercut']]
    phase = data.get('phase', 0.0)
    if not isinstance(phase, (int, float)) or not _gear_fusion_math.isfinite(phase):
        raise ValueError('phase must be a finite angle (radians)')
    phase = _gear_fusion_cast(int | float, phase)
    passed = not infeasible and working_angle > 0
    result: "JsonObject" = {'schemaVersion': 1, 'success': passed, 'status': 'pass' if passed else 'fail', 'operation': 'gear.pair-check',
              'ratio': ratio, 'sign': sign, 'centerDistance': center, 'nominalCenterDistance': nominal_center,
              'external': external, 'phase': phase, 'workingAngle': working_angle,
              'nominalPressureAngle': p1['pressureAngle'], 'backlash': backlash,
              'undercut': {'gear1': undercuts[0], 'gear2': undercuts[1]},
              'teeth': (z1, z2), 'diameters': {'gear1': {k: p1[k] for k in ('pitch', 'base', 'addendum', 'root')},
                                               'gear2': {k: p2[k] for k in ('pitch', 'base', 'addendum', 'root')}},
              'units': {'length': 'cm', 'angle': 'rad'}, 'frame': 'component',
              'associativity': 'snapshot', 'warnings': ['Undercut gear: ' + g for g in infeasible],
              'method': 'Local involute model; d=mz, db=d*cos(alpha), da=m(z+2ha+2x), df=m(z-2hf+2x)',
              'limitations': ['Backlash is the sum of the two declared per-gear circular-backlash allocations and thickness reductions, not an unconditional split of one value.',
                              'Operating working angle assumes involute contact and a declared center distance.'],
              'provenance': {'requirement': 'GM11', 'source': 'docs/GEARS.md'}}
    return result


CAD_HANDLERS.update({'shape.gear': shape_gear, 'gear.pair-check': gear_pair_check})

_fmcad_gear_runtime_loaded = True
