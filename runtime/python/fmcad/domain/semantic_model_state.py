"""JSON-only semantic observations; no SDK, entity helpers or global snapshot store."""

import math as _semantic_math
import copy as _semantic_copy
from typing import cast as _semantic_cast


_SEMANTIC_IDENTITY: list[int | float] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
_SEMANTIC_CHANNELS = ('geometry', 'pose', 'attributes', 'topology', 'visibility')


def _semantic_number(value: "JsonValue") -> "int | float":
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not _semantic_math.isfinite(value):
        raise ValueError('Expected a finite number')
    return value


def _semantic_matrix(values: "JsonValue") -> "list[int | float]":
    if not isinstance(values, list) or len(values) != 16:
        raise ValueError('Expected a row-major 4x4 matrix')
    return [_semantic_number(v) for v in values]


def _semantic_multiply(a: "list[int | float]", b: "list[int | float]") -> "list[int | float]":
    return [sum(a[4*r+k]*b[4*k+c] for k in range(4)) for r in range(4) for c in range(4)]


def _semantic_point(m: "list[int | float]", p: "JsonValue") -> "list[int | float]":
    if not isinstance(p, list) or len(p) != 3:
        raise ValueError('Expected a three-coordinate point')
    p = [_semantic_number(v) for v in p]
    return [sum(m[4*r+c]*p[c] for c in range(3)) + m[4*r+3] for r in range(3)]


def _semantic_rigid(m: "list[int | float]", tolerance: "int | float") -> bool:
    columns = [[m[4*r+c] for r in range(3)] for c in range(3)]
    det = (m[0]*(m[5]*m[10]-m[6]*m[9]) - m[1]*(m[4]*m[10]-m[6]*m[8])
           + m[2]*(m[4]*m[9]-m[5]*m[8]))
    return (abs(det-1) <= tolerance and
            all(abs(sum(a*b for a, b in zip(columns[i], columns[j])) - (i == j)) <= tolerance
                for i in range(3) for j in range(3)) and
            all(abs(a-b) <= tolerance for a, b in zip(m[12:], [0, 0, 0, 1])))


def _semantic_equal(a: "JsonValue", b: "JsonValue", tolerance: "int | float") -> bool:
    # Numeric tolerance applies only to numbers, not missing fields or booleans.
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(_semantic_number(a)-_semantic_number(b)) <= tolerance
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        b = _semantic_cast('JsonObject', b)
        return a.keys() == b.keys() and all(_semantic_equal(a[k], b[k], tolerance) for k in a)
    if isinstance(a, list):
        b = _semantic_cast('list[JsonValue]', b)
        return len(a) == len(b) and all(_semantic_equal(x, y, tolerance) for x, y in zip(a, b))
    return a == b


def _semantic_tolerance(value: "JsonValue") -> "int | float":
    value = _semantic_number(value)
    if value <= 0:
        raise ValueError('Tolerance must be positive')
    return value


def _semantic_frame_audit(observation: "JsonObject", length_tolerance: "JsonValue" = 1e-7,
                          matrix_tolerance: "JsonValue" = 1e-9) -> "JsonRecord":
    """Compare independent inputs, never a transform/inverse roundtrip.

    nativeChain contains ONLY native local transforms. proxyToRoot is already
    root qualified and must never be multiplied by its parents again.
    """
    length_tolerance = _semantic_tolerance(length_tolerance)
    matrix_tolerance = _semantic_tolerance(matrix_tolerance)
    proxy = _semantic_matrix(observation['proxyToRoot'])
    datum = _semantic_matrix(observation['datumToRoot'])
    chain = observation['nativeChain']
    if not isinstance(chain, list):
        raise ValueError('nativeChain must be an array')
    native = list(_SEMANTIC_IDENTITY)
    matrices: list[list[int | float]] = [proxy, datum]
    for item in chain:
        local = _semantic_matrix(item)
        matrices.append(local)
        native = _semantic_multiply(native, local)
    failures: list[str] = []
    if not all(_semantic_rigid(m, matrix_tolerance) for m in matrices):
        failures.append('nonRigidFrame')
    # Translation has length units; linear parts are unitless.
    def agrees(a: "list[int | float]", b: "list[int | float]") -> bool:
        return all(abs(x-y) <= (length_tolerance if i in (3, 7, 11) else matrix_tolerance)
                   for i, (x, y) in enumerate(zip(a, b)))
    if not agrees(native, proxy):
        failures.append('nativeProxyMismatch')
    if not agrees(datum, proxy):
        failures.append('datumProxyMismatch')
    witnesses = observation.get('brepWitnesses', [])
    if not isinstance(witnesses, list):
        raise ValueError('brepWitnesses must be an array')
    for witness in witnesses:
        if not isinstance(witness, dict):
            raise ValueError('Each BRep witness must be an object')
        expected = _semantic_point(proxy, witness['nativePoint'])
        actual = _semantic_point(_SEMANTIC_IDENTITY, witness['proxyPoint'])
        if _semantic_math.dist(expected, actual) > length_tolerance:
            failures.append('brepPointMismatch')
            break
    # Missing witnesses are not a passing geometric audit.
    return {'schemaVersion': 2, 'operation': 'frame.context_audit',
            'status': 'fail' if failures else ('partial' if not witnesses else 'pass'),
            'precision': 'sampled', 'exactBRepEquivalence': False,
            'failures': failures, 'observation': observation,
            'nativeToRoot': native, 'witnessCount': len(witnesses),
            'tolerances': {'lengthCm': length_tolerance, 'matrix': matrix_tolerance},
            'limitations': ['Independent point witnesses are not exact BRep equivalence.',
                            'Datum input independence is the caller responsibility.']}


def _semantic_index(snapshot: "JsonObject") -> "tuple[dict[tuple[str, tuple[str, ...]], JsonObject], list[JsonRecord]]":
    if snapshot.get('schemaVersion') != 2:
        raise ValueError('Expected semantic snapshot schemaVersion:2; v1 is unchanged')
    if snapshot.get('precision') != 'observational' or not isinstance(snapshot.get('scope'), dict):
        raise ValueError('Snapshot must declare observational precision and scope')
    result: dict[tuple[str, tuple[str, ...]], JsonObject] = {}
    duplicates: list[JsonRecord] = []
    entities = snapshot['entities']
    if not isinstance(entities, list):
        raise ValueError('Snapshot entities must be an array')
    for entity in entities:
        if not isinstance(entity, dict):
            raise ValueError('Each semantic entity must be an object')
        role, source, instance = entity['role'], entity['source'], entity['instance']
        if not isinstance(role, str) or not role or not isinstance(source, dict):
            raise ValueError('Each entity requires a role and qualified source')
        if not isinstance(source.get('id'), str) or not source['id'] or not isinstance(source.get('document'), dict):
            raise ValueError('Source identity and document provenance are required')
        if not isinstance(instance, list) or not all(isinstance(p, str) and p for p in instance):
            raise ValueError('Instance must be an explicit root-qualified path array')
        instance = _semantic_cast('list[str]', instance)
        # A role may repeat in distinct instances; a source change is an identity
        # change of that semantic slot, not a way to hide a duplicate slot.
        key = (role, tuple(instance))
        if key in result:
            duplicates.append({'role': role, 'instance': instance})
        else:
            result[key] = entity
    return result, duplicates


def _semantic_diff(before: "JsonObject", after: "JsonObject",
                   allowed_moved_subtrees: "JsonValue" = (),
                   tolerances: "JsonValue | None" = None) -> "JsonRecord":
    left, duplicates_left = _semantic_index(before)
    right, duplicates_right = _semantic_index(after)
    if tolerances is None:
        tolerances = {}
    elif not isinstance(tolerances, dict):
        raise ValueError('Tolerances must be an object')
    if set(tolerances) - set(_SEMANTIC_CHANNELS):
        raise ValueError('Unknown tolerance channel')
    tolerances = {key: _semantic_tolerance(tolerances.get(key, 1e-7)) for key in _SEMANTIC_CHANNELS}
    if not isinstance(allowed_moved_subtrees, (list, tuple)):
        raise ValueError('Allowed moved subtrees must be an array')
    subtrees = list(allowed_moved_subtrees)
    if any(not isinstance(p, list) or not p or not all(isinstance(v, str) and v for v in p) for p in subtrees):
        raise ValueError('Allowed moved subtrees must be nonempty explicit instance paths')
    subtrees = _semantic_cast('list[list[str]]', subtrees)
    changes: list[JsonRecord] = []
    missing: list[JsonRecord] = []
    for key in sorted(left.keys() | right.keys()):
        a, b = left.get(key), right.get(key)
        if a is None or b is None:
            changes.append({'role': key[0], 'instance': list(key[1]), 'channel': 'identity',
                            'change': 'added' if a is None else 'removed', 'allowed': False})
            continue
        if a['source'] != b['source']:
            changes.append({'role': key[0], 'instance': list(key[1]), 'channel': 'source', 'allowed': False})
        for channel in _SEMANTIC_CHANNELS:
            if channel not in a or channel not in b or a[channel] is None or b[channel] is None:
                missing.append({'role': key[0], 'instance': list(key[1]), 'channel': channel})
                continue
            if not _semantic_equal(a[channel], b[channel], tolerances[channel]):
                allowed = channel == 'pose' and any(list(key[1][:len(p)]) == p for p in subtrees)
                changes.append({'role': key[0], 'instance': list(key[1]), 'channel': channel, 'allowed': allowed})
    scope_changed = before['scope'] != after['scope']
    duplicates = {'before': duplicates_left, 'after': duplicates_right}
    failed = scope_changed or duplicates_left or duplicates_right or any(not c['allowed'] for c in changes)
    return {'schemaVersion': 2, 'operation': 'snapshot.diff_v2',
            'status': 'fail' if failed else ('partial' if missing else 'pass'),
            'precision': 'observational', 'coverage': 'partial', 'exactBRepEquivalence': False,
            'changes': changes, 'duplicates': duplicates, 'missingObservations': missing,
            'scopeChanged': scope_changed, 'scope': after['scope'],
            'allowedMovedSubtrees': subtrees, 'tolerances': tolerances,
            'limitations': ['Only explicitly observed roles, instances and channels are compared.',
                            'Equal summaries do not prove exact BRep equivalence.',
                            'Allowed pose changes do not authorize geometry, identity or visibility changes.']}
