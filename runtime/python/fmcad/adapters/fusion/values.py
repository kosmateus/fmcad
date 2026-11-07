"""SDK value projection; intentionally separate from JSON-only DTO validation.

The bundler includes the pure unit in the same namespace, without requiring a
Python package installation inside Fusion.
"""


def fusion_json(value: object) -> JsonValue:
    try:
        return json_value(value)
    except TypeError:
        pass
    if isinstance(value, (list, tuple)):
        items = cast(list[object] | tuple[object, ...], value)
        return [fusion_json(item) for item in items]
    if isinstance(value, dict):
        items = cast(dict[object, object], value)
        return {str(key): fusion_json(item) for key, item in items.items()}
    entity = cast("adsk.core.Base", value)
    kind = entity.objectType.split('::')[-1]

    def xyz(point: "adsk.core.Point3D | adsk.core.Vector3D") -> list[float]:
        return [float(point.x), float(point.y), float(point.z)]

    if kind in ('Point3D', 'Vector3D'):
        point = cast("adsk.core.Point3D | adsk.core.Vector3D", entity)
        return json_value({'type': kind, 'xyz': xyz(point)})
    if kind == 'Matrix3D':
        matrix = cast("adsk.core.Matrix3D", entity)
        return json_value({'type': kind, 'matrix': list(matrix.asArray())})
    if kind == 'BoundingBox3D':
        bounds = cast("adsk.core.BoundingBox3D", entity)
        return json_value({'min': xyz(bounds.minPoint), 'max': xyz(bounds.maxPoint), 'units': 'cm'})
    raise TypeError('Unsupported serialization type: ' + kind)
