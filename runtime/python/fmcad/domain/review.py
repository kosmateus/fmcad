"""Pure camera-evidence comparisons, not model or physical acceptance."""
import math

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def near_state(actual, expected):
    for key, value in expected.items():
        other = actual.get(key)
        if isinstance(value, list):
            if not isinstance(other, list) or len(other) != len(value):
                return False
            if not all(math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-8) for a, b in zip(other, value)):
                return False
        elif isinstance(value, str):
            if other != value:
                return False
        elif not isinstance(other, (int, float)) or not math.isclose(other, value, rel_tol=1e-9, abs_tol=1e-8):
            return False
    return True

def verify_view_directions(rows):
    def unit(vector):
        length = math.sqrt(sum(x*x for x in vector))
        require(math.isfinite(length) and length > 1e-9, 'Invalid camera direction')
        return [x/length for x in vector]
    def dot(a, b):
        return sum(x*y for x, y in zip(a, b))
    directions = _direction_vectors(rows)
    checks = 0
    for a, b in [('front', 'back'), ('left', 'right'), ('top', 'bottom')]:
        if a in directions and b in directions:
            require(abs(dot(directions[a], directions[b])+1) < 1e-6,
                    'Opposed view directions do not match')
            checks += 1
    if all(name in directions for name in ('front', 'right', 'top')):
        f, r, t = [directions[n] for n in ('front', 'right', 'top')]
        require(max(abs(dot(a, b)) for a, b in [(f, r), (f, t), (r, t)]) < 1e-6,
                'Side views are not orthogonal')
        checks += 1
        for name, signs in [('iso-top-left', (1, -1, 1)), ('iso-bottom-right', (1, 1, -1))]:
            if name in directions:
                expected = unit([sum(sign*v[i] for sign, v in zip(signs, (f, r, t))) for i in range(3)])
                require(abs(dot(directions[name], expected)-1) < 1e-6,
                        'Isometric view direction does not match: ' + name)
                checks += 1
    return {'status': 'verified' if checks else 'readback-only', 'directions': directions,
            'method': 'Opposed orthogonal pairs and ViewCube-relative isometric vectors; enum getter may report arbitrary.'}


def read_view_directions(rows):
    """Retain finite camera-vector readbacks for a selected, nonstandard recipe."""
    return {'status': 'readback-only', 'directions': _direction_vectors(rows),
            'method': 'Finite direction vectors read back from the selected camera recipe; no cross-view basis is assumed.'}


def _direction_vectors(rows):
    directions = {}
    for row in rows:
        vector = [a - b for a, b in zip(row['camera']['eye'], row['camera']['target'])]
        length = math.sqrt(sum(value * value for value in vector))
        require(math.isfinite(length) and length > 1e-9, 'Invalid camera direction')
        directions[row['name']] = [value / length for value in vector]
    return directions
