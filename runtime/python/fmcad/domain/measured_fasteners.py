"""SDK-free evaluation of versioned, frame-qualified fastener measurements."""
import math as _mf_math
from collections.abc import Sequence as _MFSequence
from typing import Literal as _MFLiteral, overload as _MFOverload, cast as _MFCast


def _mf_vector(value: "JsonValue", label: str) -> list[float]:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError(label + ' must be a three-dimensional vector')
    result: list[float] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not _mf_math.isfinite(item):
            raise ValueError(label + ' must contain finite numbers')
        result.append(float(item))
    return result


def _mf_norm(vector: "_MFSequence[float]") -> float:
    return _mf_math.sqrt(sum(value * value for value in vector))


def _mf_unit(vector: "_MFSequence[float]", label: str) -> list[float]:
    length = _mf_norm(vector)
    if length <= 1e-12:
        raise ValueError(label + ' must have nonzero length')
    return [value / length for value in vector]


def _mf_dot(a: "_MFSequence[float]", b: "_MFSequence[float]") -> float:
    return sum(a[i] * b[i] for i in range(3))


def _mf_sub(a: "_MFSequence[float]", b: "_MFSequence[float]") -> list[float]:
    return [a[i] - b[i] for i in range(3)]


def _mf_cross(a: "_MFSequence[float]", b: "_MFSequence[float]") -> list[float]:
    return [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]]


@_MFOverload
def _mf_record(readings: "JsonObject", path: str, dimension: _MFLiteral["vector"],
               frame: "JsonObject", missing: list[str]) -> "tuple[list[float] | None, JsonObject | None, JsonValue]": ...


@_MFOverload
def _mf_record(readings: "JsonObject", path: str, dimension: _MFLiteral["scalar"],
               frame: "JsonObject", missing: list[str]) -> "tuple[float | None, JsonObject | None, JsonValue]": ...


def _mf_record(readings: "JsonObject", path: str, dimension: _MFLiteral["vector", "scalar"],
               frame: "JsonObject", missing: list[str]) -> "tuple[list[float] | float | None, JsonObject | None, JsonValue]":
    value = readings
    for key in path.split('.'):
        if isinstance(value, list):
            if not key.isdigit():
                value = None
                break
            index = int(key)
            items = _MFCast('list[JsonValue]', value)
            value = items[index] if index < len(items) else None
        elif isinstance(value, dict) and key in value:
            value = value[key]
        else:
            value = None
            break
    if not isinstance(value, dict) or value.get('status') != 'measured':
        if path not in missing:
            missing.append(path)
        reason = value.get('reason') if isinstance(value, dict) else 'No reference supplied.'
        return None, None, reason or 'Measurement is unavailable.'
    if type(value.get('sourceVersion')) is not int or value.get('sourceVersion') != 1:
        raise ValueError(path + ' must use sourceVersion 1')
    provenance = value.get('provenance')
    if (not isinstance(provenance, dict) or not provenance.get('sourceRef') or
            type(provenance.get('sourceVersion')) is not int or provenance.get('sourceVersion') != 1 or
            provenance.get('frame') != frame):
        raise ValueError(path + ' requires sourceRef, sourceVersion 1 and the native frame')
    raw = value.get('value')
    parsed: "list[float] | float"
    if dimension == 'vector':
        parsed = _mf_vector(raw, path)
    else:
        parsed = _MFCast('float', raw)
    if dimension == 'scalar' and (isinstance(raw, bool) or not isinstance(raw, (int, float)) or not _mf_math.isfinite(raw)):
        raise ValueError(path + ' must contain a finite scalar')
    return parsed, provenance, None


def _mf_metric(value: "float | list[float] | None", unit: str,
               sources: "_MFSequence[JsonObject | None]", missing: "_MFSequence[str] | None" = None,
               method: "str | None" = None) -> "JsonObject":
    rows: list[JsonObject] = []
    for source in sources:
        if source is not None and source not in rows:
            rows.append(source)
    if value is None:
        return {'status': 'notEvaluated', 'units': unit, 'sourceVersion': 1,
                'missing': list(missing or []), 'provenance': rows}
    result: "JsonObject" = {'status': 'measured', 'value': value, 'units': unit,
              'sourceVersion': 1, 'provenance': rows}
    if method:
        result['method'] = method
    return result


def _mf_interval(start: "float | None", end: "float | None",
                 sources: "_MFSequence[JsonObject | None]", missing: "_MFSequence[str] | None" = None,
                 method: "str | None" = None) -> "JsonObject":
    if start is None or end is None:
        return {'status': 'notEvaluated', 'units': 'mm', 'sourceVersion': 1,
                'missing': list(missing or []), 'provenance': [row for row in sources if row is not None]}
    lower, upper = sorted((start, end))
    return {'status': 'measured', 'start': {'value': lower, 'units': 'mm'},
            'end': {'value': upper, 'units': 'mm'}, 'sourceVersion': 1,
            'provenance': [row for row in sources if row is not None], 'method': method}


def _measured_fasteners_evaluate(data: "JsonValue") -> "JsonObject":
    """Evaluate supplied native readings without interpreting SDK entities."""
    if not isinstance(data, dict) or type(data.get('schemaVersion')) is not int or data.get('schemaVersion') != 1 or \
            type(data.get('sourceVersion')) is not int or data.get('sourceVersion') != 1:
        raise ValueError('native measurement data requires schemaVersion:1 and sourceVersion:1')
    frame = data.get('frame')
    if not isinstance(frame, dict) or frame.get('space') not in ('assembly', 'component local'):
        raise ValueError('native measurements require an explicit assembly or component-local frame')
    tolerance = data.get('tolerance')
    if not isinstance(tolerance, dict):
        raise ValueError('native measurements require declared axis tolerances')
    axis_offset_tolerance = tolerance.get('axisOffsetMm')
    axis_angle_tolerance = tolerance.get('axisAngleRad')
    for name, value in (('axisOffsetMm', axis_offset_tolerance), ('axisAngleRad', axis_angle_tolerance)):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not _mf_math.isfinite(value) or value < 0:
            raise ValueError('tolerance.' + name + ' must be a finite nonnegative number')
    axis_offset_tolerance = _MFCast('float', axis_offset_tolerance)
    axis_angle_tolerance = _MFCast('float', axis_angle_tolerance)
    minimum_engagement = tolerance.get('minimumEngagementMm')
    if minimum_engagement is not None and (isinstance(minimum_engagement, bool) or
                                            not isinstance(minimum_engagement, (int, float)) or
                                            not _mf_math.isfinite(minimum_engagement) or minimum_engagement < 0):
        raise ValueError('tolerance.minimumEngagementMm must be nonnegative when supplied')
    if minimum_engagement is not None:
        minimum_engagement = _MFCast('float', minimum_engagement)

    missing: list[str] = []
    sources: dict[str, "JsonObject | None"] = {}

    def point(path: str) -> "list[float] | None":
        value, source, reason = _mf_record(data, path, 'vector', frame, missing)
        sources[path] = source
        return value

    screw = data.get('screw', {})
    receptacle = data.get('receptacle', {})
    if not isinstance(screw, dict) or not isinstance(receptacle, dict):
        raise ValueError('screw and receptacle measurements must be objects')
    screw_origin = point('screw.axis.origin')
    screw_direction, screw_direction_source, _ = _mf_record(data, 'screw.axis.direction', 'vector', frame, missing)
    sources['screw.axis.direction'] = screw_direction_source
    head = point('screw.headBearing')
    tip = point('screw.tip')
    screw_thread_start = point('screw.threadStart')
    screw_thread_end = point('screw.threadEnd')
    receptacle_origin = point('receptacle.axis.origin')
    receptacle_direction, receptacle_direction_source, _ = _mf_record(
        data, 'receptacle.axis.direction', 'vector', frame, missing)
    sources['receptacle.axis.direction'] = receptacle_direction_source
    receptacle_thread_start = point('receptacle.threadStart')
    receptacle_thread_end = point('receptacle.threadEnd')
    blind_bottom = None
    if receptacle.get('kind') == 'blind':
        blind_bottom = point('receptacle.bottom')
    elif receptacle.get('bottom') is not None:
        blind_bottom = point('receptacle.bottom')

    layers = data.get('layers', [])
    if not isinstance(layers, list):
        raise ValueError('layers must be an array')
    layer_points: list["tuple[JsonValue, list[float] | None, list[float] | None, str, str]"] = []
    for index, layer in enumerate(layers):
        if not isinstance(layer, dict):
            raise ValueError('each layer must be an object')
        start_path = 'layers.%d.start' % index
        end_path = 'layers.%d.end' % index
        layer_points.append((layer.get('id', str(index)), point(start_path), point(end_path), start_path, end_path))
    if not layers:
        missing.append('layers')

    screw_axis: list[float] | None = None
    head_to_tip: list[float] | None = None
    if screw_direction is not None:
        screw_axis = _mf_unit(screw_direction, 'screw axis direction')
    if head is not None and tip is not None:
        head_to_tip = _mf_sub(tip, head)
        if _mf_norm(head_to_tip) <= 1e-12:
            raise ValueError('screw headBearing and tip must not coincide')
        if screw_axis is not None and _mf_dot(head_to_tip, screw_axis) < 0:
            screw_axis = [-value for value in screw_axis]

    actual_engagement: float | None = None
    screw_thread_interval: tuple[float, float] | None = None
    receptacle_thread_interval: tuple[float, float] | None = None
    screw_thread_sources = [sources.get('screw.threadStart'), sources.get('screw.threadEnd')]
    receptacle_thread_sources = [sources.get('receptacle.threadStart'), sources.get('receptacle.threadEnd')]
    if screw_axis is not None and head is not None and screw_thread_start is not None and screw_thread_end is not None and \
            receptacle_thread_start is not None and receptacle_thread_end is not None:
        screw_interval_values = sorted((_mf_dot(_mf_sub(screw_thread_start, head), screw_axis),
                                        _mf_dot(_mf_sub(screw_thread_end, head), screw_axis)))
        receptacle_interval_values = sorted((_mf_dot(_mf_sub(receptacle_thread_start, head), screw_axis),
                                             _mf_dot(_mf_sub(receptacle_thread_end, head), screw_axis)))
        screw_interval: tuple[float, float] = (screw_interval_values[0], screw_interval_values[1])
        receptacle_interval: tuple[float, float] = (receptacle_interval_values[0], receptacle_interval_values[1])
        screw_thread_interval = screw_interval
        receptacle_thread_interval = receptacle_interval
        actual_engagement = max(0.0, min(screw_interval[1], receptacle_interval[1]) -
                                max(screw_interval[0], receptacle_interval[0]))
    screw_thread_interval_metric = _mf_interval(
        *(screw_thread_interval or (None, None)), screw_thread_sources,
        [path for path in missing if path in ('screw.threadStart', 'screw.threadEnd')],
        'selected screw thread-boundary stations relative to the measured head-bearing point')
    receptacle_thread_interval_metric = _mf_interval(
        *(receptacle_thread_interval or (None, None)), receptacle_thread_sources,
        [path for path in missing if path in ('receptacle.threadStart', 'receptacle.threadEnd')],
        'selected receptacle thread-boundary stations relative to the screw head-bearing point')
    engagement_metric = _mf_metric(
        actual_engagement, 'mm', screw_thread_sources + receptacle_thread_sources,
        [path for path in missing if 'thread' in path],
        'overlap of selected axial thread-boundary references; thread flanks are not inspected')

    checks: list[JsonObject] = []
    status = 'pass'
    if actual_engagement is None:
        checks.append({'check': 'actual-engagement', 'status': 'unknown', 'measurement': engagement_metric,
                       'message': 'Native axial thread-boundary references are incomplete; declared values are not substituted.'})
        status = 'unknown'
    elif actual_engagement <= 0:
        checks.append({'check': 'actual-engagement', 'status': 'fail', 'measurement': engagement_metric,
                       'message': 'The selected screw and receptacle axial thread intervals do not overlap.'})
        status = 'fail'
    elif minimum_engagement is None:
        checks.append({'check': 'actual-engagement', 'status': 'notEvaluated', 'measurement': engagement_metric,
                       'message': 'No minimum engagement was supplied for this measured overlap.'})
        status = 'unknown'
    else:
        passed = actual_engagement >= minimum_engagement
        checks.append({'check': 'actual-engagement', 'status': 'pass' if passed else 'fail',
                       'measurement': engagement_metric,
                       'required': {'value': minimum_engagement, 'units': 'mm'}})
        if not passed:
            status = 'fail'

    axis_metrics: dict[str, JsonObject] = {'axisOffset': _mf_metric(None, 'mm', [], ['screw/receptacle axis references']),
                    'axisAngle': _mf_metric(None, 'rad', [], ['screw/receptacle axis references'])}
    axis_sources = [screw_direction_source, sources.get('screw.axis.origin'),
                    receptacle_direction_source, sources.get('receptacle.axis.origin')]
    if screw_axis is not None and screw_origin is not None and receptacle_origin is not None and receptacle_direction is not None:
        receptacle_axis = _mf_unit(receptacle_direction, 'receptacle axis direction')
        delta = _mf_sub(receptacle_origin, screw_origin)
        cross = _mf_cross(screw_axis, receptacle_axis)
        cross_length = _mf_norm(cross)
        if cross_length <= 1e-12:
            offset = _mf_norm(_mf_cross(delta, screw_axis))
        else:
            offset = abs(_mf_dot(delta, [value / cross_length for value in cross]))
        cosine = min(1.0, max(-1.0, abs(_mf_dot(screw_axis, receptacle_axis))))
        angle = _mf_math.acos(cosine)
        axis_metrics = {'axisOffset': _mf_metric(offset, 'mm', axis_sources, method='shortest distance between measured axis lines'),
                        'axisAngle': _mf_metric(angle, 'rad', axis_sources, method='unsigned angle between measured axis directions')}
        aligned = offset <= axis_offset_tolerance and angle <= axis_angle_tolerance
        checks.append({'check': 'alignment', 'status': 'pass' if aligned else 'fail',
                       'axisOffset': axis_metrics['axisOffset'], 'axisOffsetTolerance': {'value': axis_offset_tolerance, 'units': 'mm'},
                       'axisAngle': axis_metrics['axisAngle'], 'axisAngleTolerance': {'value': axis_angle_tolerance, 'units': 'rad'}})
        if not aligned:
            status = 'fail'
    else:
        checks.append({'check': 'alignment', 'status': 'unknown', 'axisOffset': axis_metrics['axisOffset'],
                       'axisAngle': axis_metrics['axisAngle'], 'message': 'Native axis reads are incomplete.'})
        if status != 'fail':
            status = 'unknown'

    layer_axial_intervals: list[JsonObject] = []
    for layer_id, start, end, start_path, end_path in layer_points:
        if screw_axis is not None and head is not None and start is not None and end is not None:
            start_station = _mf_dot(_mf_sub(start, head), screw_axis)
            end_station = _mf_dot(_mf_sub(end, head), screw_axis)
            layer_axial_intervals.append({'id': layer_id, 'status': 'measured',
                                          'start': {'value': min(start_station, end_station), 'units': 'mm'},
                                          'end': {'value': max(start_station, end_station), 'units': 'mm'},
                                          'sourceVersion': 1,
                                          'provenance': [sources.get(start_path), sources.get(end_path)],
                                          'method': 'selected layer endpoint stations on the screw axis'})
        else:
            layer_axial_intervals.append({'id': layer_id, 'status': 'notEvaluated',
                                          'sourceVersion': 1, 'missing': [start_path, end_path],
                                          'provenance': [row for row in (sources.get(start_path), sources.get(end_path))
                                                         if row is not None]})

    protrusion: float | None = None
    layer_sources: list[JsonObject | None] = []
    if screw_axis is not None and head is not None and tip is not None and layer_points and \
            all(layer.get('status') == 'measured' for layer in layer_axial_intervals):
        stack_far = max(_MFCast('float', _MFCast('JsonObject', layer['end'])['value'])
                        for layer in layer_axial_intervals)
        tip_station = _mf_dot(_mf_sub(tip, head), screw_axis)
        protrusion = tip_station - stack_far
        for _, _, _, start_path, end_path in layer_points:
            layer_sources.extend((sources.get(start_path), sources.get(end_path)))
    protrusion_metric = _mf_metric(protrusion, 'mm', [sources.get('screw.tip')] + layer_sources,
                                   [path for path in missing if path.startswith('layers.') or path == 'layers'],
                                   'screw-tip station minus farthest measured stack-layer station')
    if protrusion is None:
        checks.append({'check': 'protrusion', 'status': 'unknown', 'measurement': protrusion_metric,
                       'message': 'Screw tip or layer axial endpoints are unavailable.'})
        if status != 'fail':
            status = 'unknown'
    else:
        checks.append({'check': 'protrusion', 'status': 'pass' if protrusion >= 0 else 'fail',
                       'measurement': protrusion_metric,
                       'message': 'Positive values extend beyond the measured stack; negative values stop short.'})
        if protrusion < 0:
            status = 'fail'

    bottoming: JsonObject | None = None
    bottom_metric = _mf_metric(None, 'mm', [], ['receptacle.bottom'])
    if blind_bottom is not None and tip is not None and head is not None and screw_axis is not None:
        clearance = _mf_dot(_mf_sub(blind_bottom, tip), screw_axis)
        bottoming = {'clearance': _mf_metric(clearance, 'mm', [sources.get('receptacle.bottom'), sources.get('screw.tip')],
                                             method='blind-bottom station minus screw-tip station'),
                     'bottomed': clearance <= 0}
        bottom_metric = bottoming['clearance']
        checks.append({'check': 'bottoming', 'status': 'fail' if bottoming['bottomed'] else 'pass',
                       'measurement': bottom_metric, 'bottomed': bottoming['bottomed']})
        if bottoming['bottomed']:
            status = 'fail'
    elif receptacle.get('kind') == 'blind':
        checks.append({'check': 'bottoming', 'status': 'unknown', 'measurement': bottom_metric,
                       'message': 'Blind-hole bottom or screw-tip measurement is unavailable.'})
        if status != 'fail':
            status = 'unknown'
    else:
        checks.append({'check': 'bottoming', 'status': 'notEvaluated', 'measurement': bottom_metric,
                       'message': 'No blind receptacle bottom was supplied.'})

    screw_axis_metric: JsonObject = {'status': 'measured' if screw_axis is not None and screw_origin is not None else 'notEvaluated',
                         'origin': _mf_metric(screw_origin, 'mm', [sources.get('screw.axis.origin')]),
                         'direction': _mf_metric(screw_axis, 'unit vector', [screw_direction_source]) if screw_axis is not None else
                                      _mf_metric(None, 'unit vector', [], ['screw.axis.direction']),
                         'sourceVersion': 1}
    receptacle_axis_metric: JsonObject = {'status': 'measured' if receptacle_origin is not None and receptacle_direction is not None else 'notEvaluated',
                              'origin': _mf_metric(receptacle_origin, 'mm', [sources.get('receptacle.axis.origin')]),
                              'direction': _mf_metric(_mf_unit(receptacle_direction, 'receptacle axis direction'), 'unit vector',
                                                      [receptacle_direction_source]) if receptacle_direction is not None else
                                           _mf_metric(None, 'unit vector', [], ['receptacle.axis.direction']),
                              'sourceVersion': 1}

    return {'schemaVersion': 1, 'sourceVersion': 1, 'frame': frame,
            'status': status, 'measurements': {'actualEngagement': engagement_metric,
                                               'screwThreadInterval': screw_thread_interval_metric,
                                               'receptacleThreadInterval': receptacle_thread_interval_metric,
                                               'screwAxis': screw_axis_metric,
                                               'receptacleAxis': receptacle_axis_metric,
                                               'layerAxialIntervals': layer_axial_intervals,
                                               'protrusion': protrusion_metric,
                                               'axisOffset': axis_metrics['axisOffset'],
                                               'axisAngle': axis_metrics['axisAngle'],
                                               'bottoming': bottoming},
            'checks': checks,
            'coverage': {'status': 'incomplete' if missing else 'complete',
                         'frameStatus': 'unverified' if frame.get('status') == 'unverified' else 'measured',
                         'missingMeasurements': missing,
                         'threadRepresentation': 'axial boundary references only; exact helical thread/flank contact is not available from this measurement.'},
            'limitations': ['Native axial interval overlap is not exact thread-flank contact or a strength assessment.',
                            'All native coordinates are projected in the frame identified above; unsupported/missing reads are not replaced by declared stack values.']}
