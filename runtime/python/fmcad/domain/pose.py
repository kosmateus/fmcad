"""SDK-free pose validation and numerical data operations."""
import json as _pose_domain_json
from collections.abc import Hashable as _pose_Hashable
from typing import cast as _pose_cast

_POSE_FILL_STATES = (None, 'FULL', 'EMPTY')

_POSE_SPRING_STATES = (None, 'FREE', 'COCKED', 'COMPRESSED')

def _pose_version(data: "JsonObject") -> None:
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('GM18 pose operations require schemaVersion:1 and frame:component')

def _pose_validate_fields(data: "JsonObject", optional: tuple[str, ...] = ()) -> None:
    for key in ('joints', 'parameters', 'visibility'):
        if key in data and not isinstance(data[key], list):
            raise ValueError(key + ' must be an array')
    if 'fillState' in data and data['fillState'] not in _POSE_FILL_STATES:
        raise ValueError('fillState must be FULL or EMPTY')
    if 'springState' in data and data['springState'] not in _POSE_SPRING_STATES:
        raise ValueError('springState must be FREE, COCKED or COMPRESSED')
    if 'routeVariant' in data and not isinstance(data['routeVariant'], str):
        raise ValueError('routeVariant must be text')
    if 'service' in data:
        service = data['service']
        if not isinstance(service, dict) or 'disconnections' not in service or not isinstance(service['disconnections'], list):
            raise ValueError('service requires a disconnections array')

def _pose_key(ref: "JsonValue") -> _pose_Hashable:
    if isinstance(ref, dict):
        return _pose_cast(_pose_Hashable,
                          ref.get('token') or ref.get('name') or ref.get('path') or
                          _pose_domain_json.dumps(ref, sort_keys=True))
    return str(ref)


def _pose_manifest_data(name: str, revision: int, data: "JsonObject", identity: "JsonObject",
                        saved_at: str, schema: str) -> "JsonObject":
    return {'schema': schema, 'name': name, 'revision': revision,
            'document': identity, 'savedAt': saved_at,
            'joints': data.get('joints', []),
            'parameters': data.get('parameters', []),
            'visibility': data.get('visibility', []),
            'fillState': data.get('fillState'),
            'springState': data.get('springState'),
            'routeVariant': data.get('routeVariant'),
            'service': data.get('service')}
