"""Geometry shapes: domain; retained cad-v1 shared namespace."""


def _shapes_point_names(name: str) -> list[str]:
    return [name] + [name + '__' + axis for axis in ('x', 'y', 'z')]


def _shapes_axis_vector(axis: str) -> tuple[float, float, float]:
    vectors = {'X': (1.0, 0.0, 0.0), 'Y': (0.0, 1.0, 0.0), 'Z': (0.0, 0.0, 1.0)}
    if axis not in vectors:
        raise ValueError('Generated face/edge discovery requires an X, Y or Z axis')
    return vectors[axis]
