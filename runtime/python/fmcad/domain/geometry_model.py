"""Geometry model: domain; retained cad-v1 shared namespace."""
from typing import cast as _geometry_model_fields_cast


def _model_fields(data: object, required: tuple[str, ...] = (), optional: tuple[str, ...] = ()) -> None:
    if not isinstance(data, dict):
        raise ValueError('Command data must be an object')
    fields = _geometry_model_fields_cast('dict[str, object]', data)
    missing = set(required) - fields.keys()
    unknown = fields.keys() - set(required) - set(optional)
    if missing or unknown:
        raise ValueError('Missing inputs: %s; unsupported inputs: %s' %
                         (sorted(missing), sorted(unknown)))
    if 'name' in fields and (not isinstance(fields['name'], str) or not fields['name'].strip()):
        raise ValueError('name must be a nonempty string')
    for key in ('visible', 'construction', 'fixed', 'delete', 'confirm', 'driving', 'linked',
                'symmetric', 'solid', 'closed', 'reverse', 'tangentChain', 'keepTools',
                'extend', 'internal', 'modeled', 'rightHanded'):
        if key in fields and type(fields[key]) is not bool:
            raise ValueError(key + ' must be boolean')
