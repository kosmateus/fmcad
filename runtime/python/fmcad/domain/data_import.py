"""DTO-only rules extracted from assets/cad/data_import.py. No SDK or filesystem access."""
import math as _di_math

_DI_GROUP = 'fmcad.dataImport.v1'

def _di_eye() -> "list[int | float]":
    return [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]

def _di_mul(a: "Sequence[int | float]", b: "Sequence[int | float]") -> "list[int | float]":
    return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4)) for r in range(4) for c in range(4)]

def _di_inverse(a: "Sequence[int | float]") -> "list[int | float]":
    b = _di_eye()
    for r in range(3):
        for c in range(3):
            b[r * 4 + c] = a[c * 4 + r]
        b[r * 4 + 3] = -sum(a[c * 4 + r] * a[c * 4 + 3] for c in range(3))
    return b

def _di_rigid(value: "Sequence[object]") -> "list[int | float]":
    if not isinstance(value, list) or len(value) != 16:
        raise ValueError('Transform requires 16 finite numbers')
    a: list[int | float] = []
    for coordinate in value:
        if type(coordinate) is int:
            number: int | float = coordinate
        elif type(coordinate) is float:
            number = coordinate
        else:
            raise ValueError('Transform requires 16 finite numbers')
        if not _di_math.isfinite(number):
            raise ValueError('Transform requires 16 finite numbers')
        a.append(number)
    if any(abs(a[12 + i] - (1 if i == 3 else 0)) > 1e-9 for i in range(4)):
        raise ValueError('Invalid homogeneous row')
    for r in range(3):
        for c in range(3):
            if abs(sum(a[k * 4 + r] * a[k * 4 + c] for k in range(3)) - (1 if r == c else 0)) > 1e-9:
                raise ValueError('Scaling/shear is not supported')
    det = a[0] * (a[5] * a[10] - a[6] * a[9]) - a[1] * (a[4] * a[10] - a[6] * a[8]) + a[2] * (a[4] * a[9] - a[5] * a[8])
    if abs(det - 1) > 1e-9:
        raise ValueError('Reflection/handedness reversal is not supported')
    return a

def _di_same(a: "Sequence[int | float]", b: "Sequence[int | float]",
             tolerance: float = 1e-8) -> bool:
    return len(a) == len(b) and all(abs(x - y) <= tolerance for x, y in zip(a, b))

def _di_metadata(plan: "Mapping[str, object]", **values: "JsonValue") -> "JsonRecord":
    owner, revision, digest = plan['owner'], plan['revision'], plan['digest']
    if owner is not None and not isinstance(owner, str):
        raise ValueError('Import owner must be text or null')
    if revision is not None and not isinstance(revision, str):
        raise ValueError('Import revision must be text or null')
    if not isinstance(digest, str):
        raise ValueError('Import digest must be text')
    result: JsonRecord = {'owner': owner, 'revision': revision, 'digest': digest}
    result.update(values)
    return result


def _di_json_object(value: "JsonValue", label: str) -> "JsonObject":
    if not isinstance(value, dict):
        raise ValueError(label + ' must be an object')
    entries = _cad_cast("dict[object, JsonValue]", value)
    if any(not isinstance(key, str) for key in entries):
        raise ValueError(label + ' keys must be strings')
    return _cad_cast("JsonObject", entries)

def _di_json_records(value: "JsonValue", label: str) -> "list[JsonRecord]":
    if not isinstance(value, list):
        raise ValueError(label + ' must be an array')
    return [_di_json_object(row, label + ' item') for row in value]

def _di_item_metadata(value: "JsonValue") -> "_DiItemMetadata":
    metadata = _di_json_object(value, 'Stored data-import metadata')
    _cad_fields(metadata, ('owner', 'revision', 'digest'),
                ('id', 'item', 'geometry', 'occurrence', 'placement'))
    for key in ('owner', 'revision', 'digest'):
        if not isinstance(metadata[key], str):
            raise ValueError('Stored data-import metadata has invalid ' + key)
    return _cad_cast("_DiItemMetadata", metadata)

def _di_placement_metadata(value: "JsonValue") -> "_DiPlacementMetadata":
    metadata = _di_json_object(value, 'Stored placement metadata')
    _cad_fields(metadata, ('owner', 'revision', 'digest', 'matrix', 'provenance'))
    for key in ('owner', 'revision', 'digest'):
        if not isinstance(metadata[key], str):
            raise ValueError('Stored placement metadata has invalid ' + key)
    if not isinstance(metadata['matrix'], list):
        raise ValueError('Stored placement metadata has invalid matrix')
    matrix = _di_rigid(metadata['matrix'])
    provenance = _di_json_object(metadata['provenance'], 'Stored placement provenance')
    checked = dict(metadata)
    checked.update(matrix=matrix, provenance=provenance)
    return _cad_cast("_DiPlacementMetadata", checked)

def _di_plan(value: "JsonObject") -> "_DiPlan":
    fields = ('version', 'operation', 'owner', 'revision', 'expectedRevision', 'onExisting',
              'digest', 'provenance', 'result', 'unresolved', 'warnings', 'maxItems', 'budgetMs')
    _cad_fields(value, fields, ('observed',))
    operation = value['operation']
    operations = ('param.import', 'catalog.import', 'catalog.check', 'placement.import',
                  'placement.check', 'cots.replace')
    if type(value['version']) is not int or value['version'] != 1:
        raise ValueError('Unsupported data adapter version')
    if not isinstance(operation, str) or operation not in operations:
        raise ValueError('Unsupported data import operation')
    if value['owner'] is not None and not isinstance(value['owner'], str):
        raise ValueError('Import owner must be text or null')
    if value['revision'] is not None and not isinstance(value['revision'], str):
        raise ValueError('Import revision must be text or null')
    if not operation.endswith('.check') and (not value['owner'] or not value['revision']):
        raise ValueError('Mutating data import requires owner and revision')
    if value['expectedRevision'] is not None and not isinstance(value['expectedRevision'], str):
        raise ValueError('Expected revision must be text or null')
    if value['onExisting'] not in ('error', 'reuse', 'update'):
        raise ValueError('Invalid onExisting policy')
    if not isinstance(value['digest'], str):
        raise ValueError('Import digest must be text')
    provenance = _di_json_object(value['provenance'], 'Import provenance')
    result = _di_json_object(value['result'], 'Import result')
    if not isinstance(value['unresolved'], list) or not isinstance(value['warnings'], list):
        raise ValueError('Import unresolved and warnings must be arrays')
    unresolved = [_di_json_object(row, 'Unresolved item') for row in value['unresolved']]
    warnings: list[str] = []
    for warning in value['warnings']:
        if not isinstance(warning, str):
            raise ValueError('Import warnings must be text')
        warnings.append(warning)
    max_items, budget_ms = value['maxItems'], value['budgetMs']
    if type(max_items) is not int or max_items < 1 or type(budget_ms) is not int or budget_ms < 1:
        raise ValueError('Import maxItems and budgetMs must be positive integers')
    value['provenance'], value['result'] = provenance, result
    value['unresolved'], value['warnings'] = unresolved, warnings
    return _cad_cast("_DiPlan", value)

def _di_plan_text(plan: "_DiPlan", key: "Literal['owner', 'revision']") -> str:
    value = plan[key]
    if not isinstance(value, str) or not value:
        raise ValueError('Mutating data import requires ' + key)
    return value

def _di_existing(old: "JsonObject | None", plan: "_DiPlan", label: str) -> None:
    if not old:
        return
    if old.get('owner') != plan['owner']:
        raise ValueError(label + ': ownership conflict')
    if plan['onExisting'] == 'error':
        raise ValueError(label + ': already exists (onExisting defaults to error)')
    if plan['onExisting'] == 'reuse' and (old.get('digest') != plan['digest'] or old.get('revision') != plan['revision']):
        raise ValueError(label + ': reuse requires identical revision and content')
    if plan['onExisting'] == 'update' and old.get('revision') != plan['expectedRevision']:
        raise ValueError(label + ': expectedRevision conflict')
