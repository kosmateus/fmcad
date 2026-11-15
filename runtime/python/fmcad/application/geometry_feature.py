"""Geometry feature: application; retained cad-v1 shared namespace."""
from typing import cast as _geometry_feature_cast
# Registry ownership is set here, before the compatibility facade executes.
if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'feature'


def _feature_dispatch(mode: str, rework: "CadHandler") -> "CadHandler":
    def handler(ctx: "CadContext", data: object) -> "JsonValue":
        if not isinstance(data, dict):
            raise TypeError('Operation data must be an object')
        payload = _geometry_feature_cast("JsonObject", data)
        if 'schemaVersion' in payload or 'frame' in payload:
            return rework(ctx, payload)
        # The legacy assembly history handlers remain the implementation for
        # payloads without schemaVersion; resolve them at call time from the
        # shared bundle namespace so registration order does not matter.
        return _assembly_handler(_assembly_history, mode)(ctx, payload)
    return handler


def feature_inspect(ctx: "CadContext", data: object) -> "JsonValue":
    if not isinstance(data, dict):
        raise TypeError('Operation data must be an object')
    payload = _geometry_feature_cast("JsonObject", data)
    if 'schemaVersion' in payload or 'frame' in payload:
        return _feature_inspect(ctx, payload)
    return _assembly_history(ctx, payload, 'inspect')


def feature_edit(ctx: "CadContext", data: object) -> "JsonValue":
    if not isinstance(data, dict):
        raise TypeError('Operation data must be an object')
    payload = _geometry_feature_cast("JsonObject", data)
    if 'schemaVersion' in payload or 'frame' in payload:
        return _feature_edit(ctx, payload)
    return _assembly_history(ctx, payload, 'edit')


CAD_HANDLERS.update({'feature.inspect': feature_inspect, 'feature.edit': feature_edit})

globals().__setitem__('_FMCAD_GEOMETRY_LOADED', (*globals().get('_FMCAD_GEOMETRY_LOADED', ()), 'feature'))
