"""GM27: assembly sequence, service path-checks, tool access and fixture access.

``assembly.sequence`` orders parts from a rigid dependency graph; flexible media
(wires/hoses) are recorded as disconnection prerequisites and are never
rigidized into assembly joints. ``service.path-check`` samples a swept
withdrawal in a declared plane so an exploded endpoint is not mistaken for a
feasible insertion path. ``tool.access`` sweeps a cylindrical tool envelope
(explicitly a simplification, not a full fingers/grip model) along an approach
axis to a fastener. ``fixture.access`` checks that a part can seat onto fixture
datums (pin/hole fit, datum coincidence, approach reach and prerequisites).
"""
import math as _sequence_fusion_math
from collections.abc import Mapping as _sequence_fusion_Mapping, Sequence as _sequence_fusion_Sequence
from typing import TypedDict as _sequence_fusion_TypedDict
from typing import cast as _sequence_fusion_cast

if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'sequence'

import adsk.core as _sequence_fusion_core
import adsk.fusion as _sequence_sdk_fusion


# --- shared vector helpers (cm/rad internal) ---------------------------------------

class _SequenceFeature(_sequence_fusion_TypedDict):
    name: "JsonValue"
    kind: str
    origin: list[float]
    direction: list[float] | None
    diameter: float | None


def _sequence_point3(ctx: "CadContext", spec: "JsonValue") -> list[float]:
    p = _sequence_fusion_cast(object, ctx.point(spec))
    if isinstance(p, (list, tuple)):
        coordinates = _sequence_fusion_cast(list[object] | tuple[object, ...], p)
        return [float(_sequence_fusion_cast(str | int | float | bool, value))
                for value in coordinates]
    point = _sequence_fusion_cast('adsk.core.Point3D', p)
    return [float(point.x), float(point.y), float(point.z)]


















def _outline2(ctx: "CadContext", spec: "JsonValue") -> list[list[float]]:
    if not isinstance(spec, list) or len(spec) < 3:
        raise ValueError('outline requires at least three [x,y] points')
    return [[ctx.length(point[0]), ctx.length(point[1])]
            for point in (_sequence_fusion_cast(_sequence_fusion_Sequence["JsonValue"], row)
                          for row in spec)]














# --- envelope ---------------------------------------------------------------------

def _sequence_contract(ctx: "CadContext", operation: str,
                       result: _sequence_fusion_Mapping[str, "JsonValue"],
                       status: str = 'pass') -> "JsonObject":
    identity = None
    if hasattr(ctx, 'doc') and getattr(getattr(ctx, 'doc', None), 'name', None) is not None:
        identity = {'name': ctx.doc.name}
    component = None
    if hasattr(ctx, 'component') and hasattr(ctx, 'ref'):
        try:
            component = ctx.ref(ctx.component)
        except Exception:
            component = None
    merged: "JsonObject" = _sequence_fusion_cast("JsonObject", dict(schemaVersion=1, operation=operation, documentIdentity=identity,
                  units={'length': 'cm', 'angle': 'rad'},
                  frame={'space': 'component', 'component': component}, associativity='snapshot',
                  warnings=[], method='GM27 local assembly-sequence/service/tool/fixture geometry recipe',
                  limitations=['An exploded endpoint is not a feasible insertion path; swept access is sampled along the withdrawal and reported as bounds, never a continuous proof.',
                               'Flexible media (wires/hoses) are never rigidized into assembly joints; they are recorded as disconnection prerequisites only.',
                               'A cylindrical tool envelope is a simplification, not a full fingers/grip model.'],
                   provenance={'requirement': 'GM27', 'source': 'docs/ASSEMBLY_SEQUENCE.md'}, affected=[]))
    merged.update(result)
    merged.setdefault('status', status)
    merged['success'] = merged['status'] == 'pass'
    return merged


# --- assembly.sequence ------------------------------------------------------------



def assembly_sequence(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('parts',), ('dependencies', 'removedParts', 'disconnectedMedia',
                                   'serviceStates', 'phases', 'frame', 'schemaVersion'))
    _require_schema(data)
    plan = _sequence_plan(data)
    return _sequence_contract(ctx, 'assembly.sequence', plan,
                              status='fail' if plan['cycles'] else 'pass')


# --- service.path-check -----------------------------------------------------------

def service_path_check(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('part', 'direction', 'distance'), ('obstacles', 'minimumClearance',
                                                          'samples', 'frame', 'schemaVersion'))
    _require_schema(data)
    part = data['part']
    if not isinstance(part, dict) or 'outline' not in part:
        raise ValueError('part requires an outline')
    outline = _outline2(ctx, part['outline'])
    direction = _dir2(data['direction'])
    distance = ctx.length(data['distance'])
    if distance <= 0:
        raise ValueError('distance must be positive')

    minimum = ctx.length(data.get('minimumClearance', '0 mm'))
    if minimum < 0:
        raise ValueError('minimumClearance must be nonnegative')
    samples = data.get('samples', 20)
    if type(samples) is not int or samples < 1:
        raise ValueError('samples must be a positive integer')

    obstacles = data.get('obstacles', [])
    if not isinstance(obstacles, list):
        raise ValueError('obstacles must be an array')
    parsed: list["JsonObject"] = []
    for obstacle in obstacles:
        if not isinstance(obstacle, dict) or 'outline' not in obstacle:
            raise ValueError('obstacles require an outline')
        ob = obstacle
        poly = _outline2(ctx, ob['outline'])
        span = ob.get('span', ['0 mm', data['distance']])
        if not isinstance(span, (list, tuple)) or len(span) != 2:
            raise ValueError('obstacle span must be [start, end]')
        span_values = _sequence_fusion_cast(list["JsonValue"] | tuple["JsonValue", ...], span)
        parsed.append({'name': ob.get('name'), 'outline': poly,
                       'span': [ctx.length(span_values[0]), ctx.length(span_values[1])]})

    clearances: list[float | None] = []
    blockers: set[str] = set()
    sample_count = samples
    for i in range(sample_count + 1):
        station = distance * i / sample_count
        offset = [direction[0] * station, direction[1] * station]
        moved = [[p[0] + offset[0], p[1] + offset[1]] for p in outline]
        best: float | None = None
        for ob in parsed:
            obstacle_span = _sequence_fusion_cast(list[float], ob['span'])
            if not (obstacle_span[0] <= station <= obstacle_span[1]):
                continue
            obstacle_outline = _sequence_fusion_cast(list[list[float]], ob['outline'])
            d = _poly_dist(moved, obstacle_outline)
            if best is None or d < best:
                best = d
            if d < minimum:
                blockers.add(_sequence_fusion_cast(str, ob['name']) or
                             'obstacle-%d' % parsed.index(ob))
        clearances.append(best)

    active = [c for c in clearances if c is not None]
    min_clearance = min(active) if active else None
    feasible = (min_clearance is None or min_clearance >= minimum) and not blockers

    xs = [p[0] for p in outline] + [p[0] + direction[0] * distance for p in outline]
    ys = [p[1] for p in outline] + [p[1] + direction[1] * distance for p in outline]

    return _sequence_contract(ctx, 'service.path-check', {
        'feasible': feasible, 'blocked': not feasible,
        'minClearance': min_clearance, 'clearanceAtStations': clearances,
        'blockers': sorted(blockers), 'samples': samples,
        'sweptBounds': {'min': [min(xs), min(ys)], 'max': [max(xs), max(ys)]},
        'withdrawalDistance': distance},
        status='pass' if feasible else 'fail')


# --- tool.access ------------------------------------------------------------------



def _parse_obstacle_distance(ctx: "CadContext", obstacle: "JsonValue",
                             point: list[float]) -> float:
    if not isinstance(obstacle, dict):
        raise ValueError('obstacles must be objects')
    if 'point' in obstacle:
        center = _sequence_point3(ctx, obstacle['point'])
        radius = ctx.length(obstacle.get('radius', '0 mm'))
        return _sequence_vnorm(_sequence_vsub(point, center)) - radius
    if 'box' in obstacle:
        box = obstacle['box']
        if not isinstance(box, dict) or 'min' not in box or 'max' not in box:
            raise ValueError('box obstacle requires min and max')
        return _point_to_box_dist(point, _sequence_point3(ctx, box['min']), _sequence_point3(ctx, box['max']))
    raise ValueError('obstacles accept point/radius or box')


def tool_access(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('tool', 'target', 'entry'), ('obstacles', 'minimumClearance',
                                                    'samples', 'frame', 'schemaVersion'))
    _require_schema(data)
    tool = data['tool']
    if not isinstance(tool, dict) or 'diameter' not in tool or 'length' not in tool:
        raise ValueError('tool requires diameter and length')
    diameter = ctx.length(tool['diameter'])
    length = ctx.length(tool['length'])
    if diameter <= 0 or length <= 0:
        raise ValueError('tool diameter and length must be positive')

    target = data['target']
    if not isinstance(target, dict) or 'origin' not in target or 'axis' not in target:
        raise ValueError('target requires origin and axis')
    target_origin = _sequence_point3(ctx, target['origin'])
    target_axis = _sequence_vunit(_cad_direction(target['axis']))
    engagement_depth = ctx.length(target.get('engagementDepth', '0 mm'))
    if engagement_depth < 0:
        raise ValueError('engagementDepth must be nonnegative')

    entry = data['entry']
    if not isinstance(entry, dict) or 'origin' not in entry or 'direction' not in entry:
        raise ValueError('entry requires origin and direction')
    entry_origin = _sequence_point3(ctx, entry['origin'])
    entry_dir = _sequence_vunit(_cad_direction(entry['direction']))

    minimum = ctx.length(data.get('minimumClearance', '0 mm'))
    if minimum < 0:
        raise ValueError('minimumClearance must be nonnegative')
    samples = data.get('samples', 20)
    if type(samples) is not int or samples < 1:
        raise ValueError('samples must be a positive integer')

    engage_point = _sequence_vadd(target_origin, _sequence_vscale(target_axis, engagement_depth))
    to_target = _sequence_vsub(engage_point, entry_origin)
    reach = _sequence_vnorm(to_target)
    axis_aligned = reach > 0 and _sequence_vdot(entry_dir, _sequence_vunit(to_target)) > 1 - 1e-9
    length_sufficient = reach <= length
    tool_radius = diameter / 2.0

    obstacles = data.get('obstacles', [])
    if not isinstance(obstacles, list):
        raise ValueError('obstacles must be an array')

    obstacle_rows: list["JsonObject"] = []
    blockers: list["JsonValue"] = []
    min_clearance: float | None = None
    sample_count = samples
    for obstacle in obstacles:
        ob = _sequence_fusion_cast("JsonObject", obstacle)
        ob_min: float | None = None
        for i in range(sample_count + 1):
            t = reach * i / sample_count if reach > 0 else 0.0
            point = _sequence_vadd(entry_origin, _sequence_vscale(entry_dir, t))
            clearance = _parse_obstacle_distance(ctx, ob, point) - tool_radius
            if ob_min is None or clearance < ob_min:
                ob_min = clearance
        measured_clearance = _sequence_fusion_cast(float, ob_min)
        obstacle_rows.append({'obstacle': ob.get('name', 'unnamed'), 'minClearance': measured_clearance,
                              'blocks': measured_clearance < minimum})
        if measured_clearance < minimum:
            blockers.append(ob.get('name', 'unnamed'))
        if min_clearance is None or measured_clearance < min_clearance:
            min_clearance = measured_clearance

    reachable = axis_aligned and length_sufficient and not blockers
    return _sequence_contract(ctx, 'tool.access', {
        'reachable': reachable, 'reach': reach, 'toolDiameter': diameter, 'toolLength': length,
        'lengthSufficient': length_sufficient, 'axisAligned': axis_aligned,
        'engagementDepth': engagement_depth, 'clearances': obstacle_rows,
        'minClearance': min_clearance, 'blockers': blockers},
        status='pass' if reachable else 'fail')


# --- fixture.access ---------------------------------------------------------------

def _feature(ctx: "CadContext", spec: "JsonValue") -> _SequenceFeature:
    if not isinstance(spec, dict) or 'name' not in spec or 'kind' not in spec:
        raise ValueError('features require name and kind')
    kind = _sequence_fusion_cast(str, spec['kind'])
    if kind not in ('pin', 'hole', 'datum'):
        raise ValueError('feature kind must be pin, hole or datum')
    origin = _sequence_point3(ctx, spec['origin'])
    direction = _sequence_vunit(_cad_direction(spec['direction'])) if 'direction' in spec else None
    diameter = ctx.length(spec['diameter']) if 'diameter' in spec else None
    if kind in ('pin', 'hole') and (diameter is None or diameter <= 0):
        raise ValueError(kind + ' features require a positive diameter')
    if kind == 'datum' and direction is None:
        raise ValueError('datum features require a direction')
    return {'name': spec['name'], 'kind': kind, 'origin': origin, 'direction': direction,
            'diameter': diameter}


def fixture_access(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('part', 'fixture', 'pairs'), ('tolerance', 'angleTolerance',
                                                     'clearance', 'frame', 'schemaVersion'))
    _require_schema(data)
    part = data['part']
    fixture = data['fixture']
    if not isinstance(part, dict) or 'features' not in part:
        raise ValueError('part requires features')
    if not isinstance(fixture, dict) or 'features' not in fixture:
        raise ValueError('fixture requires features')
    approach_data = _sequence_fusion_cast("JsonObject", fixture.get('approach', {}))
    approach = _sequence_vunit(_cad_direction(approach_data.get('direction', [0, 0, 1])))

    part_feature_specs = _sequence_fusion_cast(list["JsonValue"], part['features'])
    fixture_feature_specs = _sequence_fusion_cast(list["JsonValue"], fixture['features'])
    part_features: dict[str, _SequenceFeature] = {}
    fixture_features: dict[str, _SequenceFeature] = {}
    for feature_value in part_feature_specs:
        feature = _sequence_fusion_cast("JsonObject", feature_value)
        part_features[_sequence_fusion_cast(str, feature['name'])] = _feature(ctx, feature)
    for feature_value in fixture_feature_specs:
        feature = _sequence_fusion_cast("JsonObject", feature_value)
        fixture_features[_sequence_fusion_cast(str, feature['name'])] = _feature(ctx, feature)

    pairs = data['pairs']
    if not isinstance(pairs, list) or not pairs:
        raise ValueError('pairs must be a nonempty array of [partFeature, fixtureFeature]')

    tolerance = ctx.length(data.get('tolerance', '0.01 mm'))
    angle_tolerance = ctx.angle(data.get('angleTolerance', '1 deg'))
    clearance = ctx.length(data.get('clearance', '0 mm'))
    if tolerance < 0 or angle_tolerance < 0 or clearance < 0:
        raise ValueError('tolerance, angleTolerance and clearance must be nonnegative')

    rows: list["JsonObject"] = []
    for pair_value in pairs:
        if not isinstance(pair_value, (list, tuple)):
            raise ValueError('pairs must be [partFeature, fixtureFeature]')
        pair = pair_value
        if len(pair) != 2:
            raise ValueError('pairs must be [partFeature, fixtureFeature]')
        part_name = _sequence_fusion_cast(str, pair[0])
        fixture_name = _sequence_fusion_cast(str, pair[1])
        if part_name not in part_features or fixture_name not in fixture_features:
            raise ValueError('pair references an unknown feature: %s / %s' % (pair[0], pair[1]))
        pf, ff = part_features[part_name], fixture_features[fixture_name]
        delta = _sequence_vsub(ff['origin'], pf['origin'])
        axial_gap = _sequence_vdot(delta, approach)
        lateral = _sequence_vsub(delta, _sequence_vscale(approach, axial_gap))
        lateral_offset = _sequence_vnorm(lateral)
        angle = _angle_between(pf['direction'], ff['direction'])
        reasons: list[str] = []
        fits = True
        if pf['kind'] in ('pin', 'hole') and ff['kind'] in ('pin', 'hole'):
            if pf['kind'] == ff['kind']:
                fits = False
                reasons.append('mating pin/hole pair must mix a pin with a hole')
            pin = pf if pf['kind'] == 'pin' else ff
            hole = ff if ff['kind'] == 'hole' else pf
            if hole['diameter'] is None or pin['diameter'] is None:
                fits = False
                reasons.append('pin/hole pair requires both diameters')
            elif pin['diameter'] > hole['diameter'] - clearance:
                fits = False
                reasons.append('pin diameter exceeds hole diameter minus clearance')
            if pf['direction'] and ff['direction'] and angle > angle_tolerance:
                fits = False
                reasons.append('axis angle exceeds angleTolerance')
        elif pf['kind'] == 'datum' and ff['kind'] == 'datum':
            if lateral_offset > tolerance:
                fits = False
                reasons.append('datum lateral offset exceeds tolerance')
            if angle > angle_tolerance:
                fits = False
                reasons.append('datum angle exceeds angleTolerance')
        else:
            fits = False
            reasons.append('incompatible feature kinds: %s / %s' % (pf['kind'], ff['kind']))
        rows.append({'part': pf['name'], 'fixture': ff['name'], 'kinds': [pf['kind'], ff['kind']],
                     'lateralOffset': lateral_offset, 'axialGap': axial_gap,
                     'angle': angle, 'fits': fits, 'reasons': reasons})

    seat_possible = all(r['fits'] for r in rows)
    return _sequence_contract(ctx, 'fixture.access', {
        'seatPossible': seat_possible, 'approach': approach, 'tolerance': tolerance,
        'angleTolerance': angle_tolerance, 'clearance': clearance, 'pairs': rows,
        'blockers': [r for r in rows if not r['fits']]},
        status='pass' if seat_possible else 'fail')




CAD_HANDLERS.update({
    'assembly.sequence': assembly_sequence,
    'service.path-check': service_path_check,
    'tool.access': tool_access,
    'fixture.access': fixture_access,
})

_fmcad_sequence_runtime_loaded = True
