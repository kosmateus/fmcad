"""GM25: 3D routing centerline, inspection, cut-list and motion states.

The centerline is numerically solved (uniform Catmull-Rom through waypoints when
requested, otherwise the polyline), so it interpolates all waypoints including
inflection points. Bend radius is measured as the local circumradius of three
consecutive samples (no unstable Frenet frame); transport frames use a declared
up vector projected onto the normal plane, stable through inflections. Route
state is explicitly declared set / numerically-solved / native-dependent. Cut
length follows the explicit interpretation ``L*allowanceFactor + 2*serviceTail``
(``1.1*L + 2*15 mm``) and never double-adds an already-modeled service tail.
"""
import math as _route3d_fusion_math
from collections.abc import Mapping as _route3d_fusion_Mapping
from typing import cast as _route3d_fusion_cast

if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'route3d'

import adsk.core as _route3d_fusion_core
import adsk.fusion as _route3d_sdk_fusion


# --- vector helpers (cm internal) -------------------------------------------------

def _route3d_point3(ctx: "CadContext", spec: "JsonValue") -> list[float]:
    p = _route3d_fusion_cast(object, ctx.point(spec))
    if isinstance(p, (list, tuple)):
        coordinates = _route3d_fusion_cast(list[object] | tuple[object, ...], p)
        return [float(_route3d_fusion_cast(str | int | float | bool, value))
                for value in coordinates]
    point = _route3d_fusion_cast('adsk.core.Point3D', p)
    return [float(point.x), float(point.y), float(point.z)]
















# --- centerline ------------------------------------------------------------------

















# --- envelope --------------------------------------------------------------------

def _route_contract(ctx: "CadContext", operation: str,
                    result: _route3d_fusion_Mapping[str, "JsonValue"],
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
    merged: "JsonObject" = _route3d_fusion_cast("JsonObject", dict(schemaVersion=1, operation=operation, documentIdentity=identity,
                  units={'length': 'cm', 'angle': 'rad'},
                  frame={'space': 'component', 'component': component}, associativity='snapshot',
                  warnings=[], method='GM25 numerically-solved 3D centerline; local circumradius bend radius and up-projected transport frames',
                  limitations=['No unstable Frenet frame; inflection points are handled by local circumradius.', 'AWG does not define insulation diameter; callers declare the section/insulated envelope explicitly.',
                               'Endpoints alone do not uniquely define a flexible route; waypoints and constraints are explicit.'],
                   provenance={'requirement': 'GM25', 'source': 'docs/ROUTING.md'}, affected=[]))
    merged.update(result)
    merged.setdefault('status', status)
    merged['success'] = merged['status'] == 'pass'
    return merged


def _route_geometry(ctx: "CadContext", data: "JsonObject", samples_per_segment: int) -> tuple[
        list[list[float]], str, list[float], float, float, list[float]]:
    if 'centerline' in data:
        centerline_values = _route3d_fusion_cast(list["JsonValue"], data['centerline'])
        centerline = [_route3d_point3(ctx, point) for point in centerline_values]
        interpolation = 'explicit'
    else:
        waypoints = data['waypoints']
        if not isinstance(waypoints, list) or len(waypoints) < 2:
            raise ValueError('waypoints requires at least two expression coordinate arrays')
        interpolation = data.get('interpolation', 'spline')
        if interpolation not in ('spline', 'polyline'):
            raise ValueError('interpolation must be spline or polyline')
        interpolation = _route3d_fusion_cast(str, interpolation)
        centerline = _sample_centerline([_route3d_point3(ctx, wp) for wp in waypoints],
                                        samples_per_segment, interpolation)
    if len(centerline) < 2:
        raise ValueError('centerline must have at least two points')
    up = _cad_direction(data.get('up', [0, 0, 1]))
    length = _arc_length(centerline)
    radii = _bend_radii(centerline)
    min_radius = min(radii) if radii else _route3d_fusion_math.inf
    return centerline, interpolation, up, length, min_radius, radii




def _route_clearances(ctx: "CadContext", centerline: list[list[float]],
                      obstacles: list["JsonValue"], minimum: float) -> list["JsonObject"]:
    rows: list["JsonObject"] = []
    for obstacle in obstacles:
        obstacle_data = _route3d_fusion_cast("JsonObject", obstacle)
        point = _route3d_point3(ctx, obstacle_data["point"])
        distance = min(_segment_distance(point, point, centerline[i], centerline[i + 1])
                       for i in range(len(centerline) - 1))
        rows.append({'obstacle': point, 'clearance': distance, 'violates': distance < minimum})
    return rows


def route_create3d(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('waypoints',), ('interpolation', 'endTangents', 'up', 'bendConstraints',
                                       'twist', 'section', 'name', 'frame', 'minimumClearance',
                                       'obstacles', 'representation', 'normalSections', 'schemaVersion'))
    samples = data.get('schemaVersion', 1)
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('create3d requires schemaVersion 1')
    centerline, interpolation, up, length, min_radius, radii = _route_geometry(ctx, data, 20)
    frames = _transport_frames(centerline, up)
    self_clearance = _route_self_contact(centerline)
    obstacles = data.get('obstacles', [])
    if not isinstance(obstacles, list):
        raise ValueError('obstacles must be an array')
    minimum = ctx.length(data.get('minimumClearance', '0 mm'))
    clearances = _route_clearances(ctx, centerline, obstacles, minimum) if obstacles else []
    normal_sections = _route3d_fusion_cast(list["JsonValue"], data.get('normalSections', []))
    stations = [ctx.length(_route3d_fusion_cast("JsonObject", section).get('station', '0 mm'))
                for section in normal_sections]
    sections = [{'station': station, 'position': _point_at_station(centerline, station)}
                for station in stations]
    end_tangents = data.get('endTangents')
    tangent_report = None
    if end_tangents is not None:
        tangent_data = _route3d_fusion_cast("JsonObject", end_tangents)
        start = _cad_direction(tangent_data.get('start', centerline[1]))
        end = _cad_direction(tangent_data.get('end', centerline[-2]))
        tangent_report = {
            'start': start,
            'end': end,
            'computed': {
                'start': _route3d_vunit(_route3d_vsub(centerline[1], centerline[0])),
                'end': _route3d_vunit(_route3d_vsub(centerline[-1], centerline[-2])),
            },
        }
    state = 'set' if end_tangents is not None else 'numerically-solved'
    return _route_contract(ctx, 'route.create3d', {
        'centerline': centerline, 'interpolation': interpolation, 'arcLength': length,
        'minBendRadius': min_radius if _route3d_fusion_math.isfinite(min_radius) else None,
        'normalSections': sections, 'frames': frames,
        'selfClearance': self_clearance if _route3d_fusion_math.isfinite(self_clearance) else None,
        'clearances': clearances, 'endTangents': tangent_report, 'routeState': state,
        'state': state, 'twist': ctx.angle(data['twist']) if 'twist' in data else None})


def route_inspect(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, (), ('waypoints', 'centerline', 'interpolation', 'up', 'minimumClearance',
                           'obstacles', 'normalSections', 'frame', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('inspect requires schemaVersion 1')
    if 'waypoints' not in data and 'centerline' not in data:
        raise ValueError('inspect requires waypoints or an explicit centerline')
    centerline, interpolation, up, length, min_radius, radii = _route_geometry(ctx, data, 20)
    frames = _transport_frames(centerline, up)
    self_clearance = _route_self_contact(centerline)
    obstacles = data.get('obstacles', [])
    minimum = ctx.length(data.get('minimumClearance', '0 mm'))
    obstacle_values = _route3d_fusion_cast(list["JsonValue"], obstacles)
    clearances = _route_clearances(ctx, centerline, obstacle_values, minimum) if obstacles else []
    normal_sections = _route3d_fusion_cast(list["JsonValue"], data.get('normalSections', []))
    stations = [ctx.length(_route3d_fusion_cast("JsonObject", section).get('station', '0 mm'))
                for section in normal_sections]
    sections = [{'station': station, 'position': _point_at_station(centerline, station)}
                for station in stations]
    return _route_contract(ctx, 'route.inspect', {
        'arcLength': length, 'minBendRadius': min_radius if _route3d_fusion_math.isfinite(min_radius) else None,
        'bendRadii': radii, 'frames': frames,
        'selfClearance': self_clearance if _route3d_fusion_math.isfinite(self_clearance) else None,
        'clearances': clearances, 'normalSections': sections, 'routeState': 'numerically-solved'})




def route_cut_list(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('length',), ('allowanceFactor', 'serviceTail', 'serviceTailModeled',
                                    'pieces', 'frame', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('cut-list requires schemaVersion 1')
    length = ctx.length(data['length'])
    if length <= 0:
        raise ValueError('length must be positive')
    factor = float(_route3d_fusion_cast(str | int | float | bool, data.get('allowanceFactor', 1.1)))
    if not _route3d_fusion_math.isfinite(factor) or factor < 1.0:
        raise ValueError('allowanceFactor must be finite and at least 1.0')
    tail = ctx.length(data.get('serviceTail', '15 mm'))
    if tail < 0:
        raise ValueError('serviceTail must be nonnegative')
    modeled = data.get('serviceTailModeled', False)
    if type(modeled) is not bool:
        raise ValueError('serviceTailModeled must be boolean')
    pieces = data.get('pieces', 1)
    if type(pieces) is not int or pieces < 1:
        raise ValueError('pieces must be a positive integer')
    tails = 0.0 if modeled else 2.0 * tail
    per_piece = (length * factor + tails) / pieces
    interpretation = 'cutLength = L * %.3g + %d * %g mm (L=%.6g mm neutral axis, serviceTailModeled=%s)' % (
        factor, 0 if modeled else 2, _to_mm(tail), _to_mm(length), modeled)
    if modeled:
        warnings = ['serviceTail is already modeled in length; it is not added again.']
    else:
        warnings = []
    return _route_contract(ctx, 'route.cut-list', {
        'length': _to_mm(length), 'allowanceFactor': factor, 'serviceTail': _to_mm(tail),
        'serviceTailModeled': modeled, 'pieces': pieces,
        'cutLengthPerPiece': _to_mm(per_piece), 'totalCutLength': _to_mm(per_piece * pieces),
        'interpretation': interpretation, 'warnings': warnings})




def route_motion_states(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('length',), ('pan', 'tilt', 'minBendRadius', 'poses', 'state',
                                    'representation', 'frame', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('motion-states requires schemaVersion 1')
    length = ctx.length(data['length'])
    if length <= 0:
        raise ValueError('length must be positive')
    min_radius = ctx.length(data['minBendRadius']) if 'minBendRadius' in data else None
    declared = data.get('state', 'numerically-solved')
    if declared not in ('set', 'numerically-solved', 'native-dependent'):
        raise ValueError('state must be set, numerically-solved or native-dependent')
    if 'poses' in data:
        poses = data['poses']
        if not isinstance(poses, list) or not poses:
            raise ValueError('poses must be a nonempty array')
    else:
        pan = data.get('pan')
        tilt = data.get('tilt')
        if not isinstance(pan, dict) or not isinstance(tilt, dict):
            raise ValueError('motion-states requires poses or pan/tilt range objects')
        pan_values = [ctx.angle(pan.get('min', '0 deg')), ctx.angle(pan.get('max', '0 deg'))]
        tilt_values = [ctx.angle(tilt.get('min', '0 deg')), ctx.angle(tilt.get('max', '0 deg'))]
        poses = [{'pan': p, 'tilt': t} for p in pan_values for t in tilt_values]
    rows: list["JsonObject"] = []
    for pose_value in poses:
        pose = _route3d_fusion_cast("JsonObject", pose_value)
        pan_value = pose.get('pan', '0 deg')
        tilt_value = pose.get('tilt', '0 deg')
        pan = ctx.angle(pan_value) if isinstance(pan_value, str) else float(
            _route3d_fusion_cast(str | int | float | bool, pose.get('pan', 0)))
        tilt = ctx.angle(tilt_value) if isinstance(tilt_value, str) else float(
            _route3d_fusion_cast(str | int | float | bool, pose.get('tilt', 0)))
        if 'bendRadius' in pose:
            radius = ctx.length(pose['bendRadius'])
            state = 'set'
        else:
            radius = _pose_required_radius(length, pan, tilt)
            state = 'native-dependent' if declared == 'native-dependent' else declared
        rows.append({'pan': pan, 'tilt': tilt, 'length': length, 'lengthPreserved': True,
                     'requiredBendRadius': radius if _route3d_fusion_math.isfinite(radius) else None,
                     'fits': min_radius is None or radius >= min_radius,
                     'state': state})
    return _route_contract(ctx, 'route.motion-states', {
        'states': rows, 'length': length, 'lengthPreserved': all(r['lengthPreserved'] for r in rows),
        'declaredState': declared, 'minBendRadius': min_radius,
        'extremeCoverage': 'cartesian product of PAN and TILT extremes, not a synchronous diagonal'})


CAD_HANDLERS.update({
    'route.create3d': route_create3d,
    'route.inspect': route_inspect,
    'route.cut-list': route_cut_list,
    'route.motion-states': route_motion_states,
})

_fmcad_route3d_runtime_loaded = True
