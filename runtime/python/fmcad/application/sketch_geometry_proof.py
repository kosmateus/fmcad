"""SDK-free proof decisions and public sketch proof application handlers."""
from collections.abc import Iterable as _sketch_proof_Iterable
import math as _sketch_proof_math
from typing import Literal as _sketch_proof_Literal
from typing import TypedDict as _sketch_proof_TypedDict
from typing import cast as _sketch_proof_cast


_SketchProofStatus = _sketch_proof_Literal['pass', 'fail', 'unknown']
_SketchProofPoint = list[float]
_SketchProofPolyline = list[_SketchProofPoint]
_SketchProofLoopPolylines = list[_SketchProofPolyline]


class _SketchProofCurveEvidence(_sketch_proof_TypedDict):
    polylines: list[_SketchProofPolyline]
    loops: list[JsonObject]
    selfIntersections: list[JsonObject]
    cusps: list[JsonObject]
    status: str


def proof_status(statuses: _sketch_proof_Iterable[str]) -> _SketchProofStatus:
    values = list(statuses)
    if 'fail' in values:
        return 'fail'
    if not values or 'unknown' in values:
        return 'unknown'
    return 'pass'


def proof_fields(value: object, required: tuple[str, ...] = (),
                 optional: tuple[str, ...] = ()) -> None:
    if not isinstance(value, dict):
        raise TypeError('Sketch proof input must be an object')
    record = _sketch_proof_cast(dict[object, object], value)
    if any(not isinstance(key, str) for key in record):
        raise ValueError('Sketch proof object keys must be strings')
    names = {key for key in record if isinstance(key, str)}
    missing = set(required) - names
    unknown = names - set(required) - set(optional)
    if missing or unknown:
        raise ValueError('Invalid sketch proof fields; missing: %s; unsupported: %s' %
                         (sorted(missing), sorted(unknown)))


def proof_number(value: object, name: str, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(name + ' must be a finite number')
    number = float(value)
    if not _sketch_proof_math.isfinite(number) or positive and number <= 0:
        raise ValueError(name + ' must be finite' + (' and positive' if positive else ''))
    return number


def proof_count(value: object, name: str) -> int:
    if type(value) is not int or value < 0:
        raise ValueError(name + ' must be a nonnegative integer')
    return value


def proof_vector(value: object) -> _SketchProofPoint:
    if not isinstance(value, list):
        raise ValueError('Expected a finite three-coordinate point')
    coordinates = _sketch_proof_cast(list[JsonValue], value)
    if len(coordinates) != 3:
        raise ValueError('Expected a finite three-coordinate point')
    return [proof_number(coordinate, 'coordinate') for coordinate in coordinates]


def proof_distance(a: object, b: object) -> float:
    left, right = proof_vector(a), proof_vector(b)
    return _sketch_proof_math.sqrt(sum((x-y)**2 for x, y in zip(left, right)))


def proof_compare(label: str, actual: JsonValue, expected: JsonValue, tolerance: float,
                  method: str = 'analytic') -> JsonObject:
    if actual is None:
        return {'check': label, 'status': 'unknown', 'actual': None,
                'expected': expected, 'method': method}
    if isinstance(expected, list):
        error = proof_distance(actual, expected)
    else:
        error = abs(proof_number(actual, label) - proof_number(expected, label))
    status: _SketchProofStatus = 'pass' if error <= tolerance else 'fail'
    return {'check': label, 'status': status, 'actual': actual, 'expected': expected,
            'error': error, 'tolerance': tolerance, 'method': method}


def proof_topology(evidence: JsonObject, tolerance: float) -> JsonObject:
    """Augment the existing curve graph; do not rebuild connected components."""
    graph = _sketch_proof_cast(_SketchProofCurveEvidence, evidence)
    polylines = graph['polylines']
    endpoints = [(index, point) for index, line in enumerate(polylines)
                 for point in (line[0], line[-1])]
    branches = sorted({index for index, point in endpoints
                       if sum(proof_distance(point, other) <= tolerance
                              for _, other in endpoints) > 2})
    degeneracies = [index for index, line in enumerate(polylines)
                    if sum(proof_distance(a, b) for a, b in zip(line, line[1:])) <= tolerance]
    # Duplicate strokes are sampled evidence, not equality of analytic curves.
    duplicates: list[list[int]] = []
    for index, line in enumerate(polylines):
        for prior, other in enumerate(polylines[:index]):
            same = len(line) == len(other) and any(
                all(proof_distance(a, b) <= tolerance for a, b in zip(line, candidate))
                for candidate in (other, list(reversed(other))))
            if same:
                duplicates.append([prior, index])
    loops = graph['loops']
    closed = bool(loops) and all(loop.get('closed') is True for loop in loops)
    intersections, cusps = graph['selfIntersections'], graph['cusps']
    status: str = ('fail' if not closed or branches or degeneracies or duplicates or intersections or cusps
                   else graph['status'])
    return {'status': status, 'method': 'sampled', 'loops': loops,
            'branches': branches, 'degeneracies': degeneracies, 'duplicateEdges': duplicates,
            'selfIntersections': intersections, 'strokeTolerance': tolerance}


def proof_contains(point: _SketchProofPoint, loops: list[_SketchProofLoopPolylines],
                   tolerance: float) -> _sketch_proof_Literal['inside', 'outside', 'unknown']:
    """Return parity over native profile-loop strokes; boundary is unresolved."""
    x, y, z = proof_vector(point)
    if abs(z) > tolerance:
        return 'outside'
    inside = False
    for loop in loops:
        # Native closed profile curves may return almost, but not bitwise,
        # identical stroke endpoints. Include the sampled seam segment so the
        # half-open ray rule cannot count a numerical seam twice. Match only
        # unambiguous endpoint pairs within the existing stroke tolerance;
        # open/branched input remains unresolved, not repaired or certified.
        if not loop or any(len(line) < 2 for line in loop):
            return 'unknown'
        endpoints = [point for line in loop for point in (line[0], line[-1])]
        segments = [(a, b) for line in loop for a, b in zip(line, line[1:])]
        for index, endpoint in enumerate(endpoints):
            matches = [other for other, candidate in enumerate(endpoints)
                       if other != index and proof_distance(endpoint, candidate) <= tolerance]
            if len(matches) != 1:
                return 'unknown'
            if matches[0] > index:
                segments.append((endpoint, endpoints[matches[0]]))
        for a, b in segments:
            delta = [b[index]-a[index] for index in range(3)]
            norm = sum(value*value for value in delta)
            t = max(0.0, min(1.0, sum((point[index]-a[index])*delta[index]
                                     for index in range(3))/norm)) if norm else 0.0
            nearest = [a[index] + t*delta[index] for index in range(3)]
            if proof_distance(point, nearest) <= tolerance:
                return 'unknown'
            if ((a[1] > y) != (b[1] > y) and
                    x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]):
                inside = not inside
    return 'inside' if inside else 'outside'


def proof_profile_match(profile: JsonObject, query: JsonObject,
                         length_tolerance: float, area_tolerance: float) -> JsonObject:
    checks: list[JsonValue] = []
    if 'area' in query:
        checks.append(proof_compare('area', profile.get('area'), query['area'],
                                    area_tolerance, 'nativeIntegral'))
    if 'centroid' in query:
        checks.append(proof_compare('centroid', profile.get('centroid'), query['centroid'],
                                    length_tolerance, 'nativeIntegral'))
    for field in ('outerLoops', 'innerLoops'):
        if field in query:
            checks.append(proof_compare(field, profile.get(field), query[field], 0.0))
    if 'contains' in query:
        boundaries = _sketch_proof_cast(list[_SketchProofLoopPolylines], profile['boundaries'])
        classification = (proof_contains(proof_vector(query['contains']), boundaries, length_tolerance)
                          if boundaries else 'unknown')
        checks.append({'check': 'contains', 'classification': classification, 'method': 'sampled',
                       'status': {'inside': 'pass', 'outside': 'fail', 'unknown': 'unknown'}[classification]})
    # Topology and analytic integrals are mandatory even for an explicit index.
    checks.append({'check': 'completeTopology', 'status': profile['topologyStatus'], 'method': 'nativeTopology'})
    checks.append({'check': 'nativeIntegral', 'status': profile.get('integralStatus', 'unknown'), 'method': 'nativeIntegral'})
    checks.append({'check': 'sampledTopology', 'status': profile.get('sampledTopologyStatus', 'unknown'), 'method': 'sampled'})
    typed_checks = _sketch_proof_cast(list[JsonObject], checks)
    return {'status': proof_status(str(check['status']) for check in typed_checks), 'checks': typed_checks}


def proof_select(profiles: list[JsonObject], query: JsonObject,
                 length_tolerance: float, area_tolerance: float) -> JsonObject:
    matches: list[int] = []
    unresolved: list[int] = []
    results: list[JsonValue] = []
    for profile in profiles:
        index = proof_count(profile['index'], 'profile index')
        if 'index' in query and index != query['index']:
            continue
        result = proof_profile_match(profile, query, length_tolerance, area_tolerance)
        results.append({'index': index, **result})
        if result['status'] == 'pass':
            matches.append(index)
        elif result['status'] == 'unknown':
            unresolved.append(index)
    # An unresolved candidate may match too; never silently select profiles[0].
    selected = matches[0] if len(matches) == 1 and not unresolved else None
    status: _SketchProofStatus = ('pass' if selected is not None else
                                  'unknown' if unresolved else 'fail')
    reason = (None if selected is not None else 'incompleteEvidence' if unresolved else
              'ambiguous' if matches else 'noMatch')
    return {'status': status, 'selectedIndex': selected, 'matches': matches,
            'unresolved': unresolved, 'reason': reason,
            'candidates': _sketch_proof_cast(list[JsonObject], results)}



def sketch_coordinate_check(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return SketchGeometryProofFusion(ctx).coordinate_check(data)


def sketch_profile_query(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return SketchGeometryProofFusion(ctx).profile_query(data)


def register_sketch_geometry_proof(handlers: "HandlerRegistry") -> None:
    if hasattr(handlers, 'owner'):
        handlers.owner = 'sketch_geometry_proof'
    handlers.update({
        'sketch.coordinate-check': sketch_coordinate_check,
        'sketch.profile-query': sketch_profile_query,
    })


register_sketch_geometry_proof(CAD_HANDLERS)
