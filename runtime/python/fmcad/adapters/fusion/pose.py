"""GM18: named product states (poses) stored as an explicit local manifest.

The manifest is a JSON blob held in root-component attributes; it is explicitly
not a native Fusion ConfigurationTable. A pose captures: identity/revision, joint
values, parameter values, visibility, fill state, spring state, route variant and
service/disconnection flags. `apply` leaves the requested state; `evaluate` applies
temporarily and restores the previous state, reporting restoration failure as a
separate error. Incompatible documents and stale refs are rejected.

Reuses `joint.drive` and `param.apply` by dispatch; visibility uses the native
light-bulb flag. Fill/spring/route/service states are manifest-carried declarations
whose geometric and mass effect is resolved by the corresponding GM methods
(GM12 spring evaluate, GM23 fluid mass), never re-computed here.
"""
import datetime
import json as _pose_fusion_json
from typing import Protocol as _pose_Protocol
from typing import cast as _pose_fusion_cast

if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'pose'

_POSE_GROUP = 'fmcad.pose'
_POSE_INDEX = '__index__'
_POSE_SCHEMA = 'fmcad.pose.manifest.v1'


class _PoseVisibility(_pose_Protocol):
    @property
    def isLightBulbOn(self) -> bool: ...

    @isLightBulbOn.setter
    def isLightBulbOn(self, value: bool) -> None: ...


class _PoseAttributeOwner(_pose_Protocol):
    @property
    def attributes(self) -> object: ...


def _pose_contract(ctx: "CadContext", operation: str, result: "JsonObject",
                   status: str = 'pass', read_only: bool = True,
                   **extra: "JsonValue") -> "JsonObject":
    identity = None
    if hasattr(ctx, 'doc') and getattr(ctx.doc, 'name', None) is not None:
        identity = {'creationId': getattr(ctx.doc, 'creationId', None), 'name': ctx.doc.name}
    component = None
    if hasattr(ctx, 'component') and hasattr(ctx, 'ref'):
        try:
            component = ctx.ref(ctx.component)
        except Exception:
            component = None
    out: "JsonObject" = dict(schemaVersion=1, operation=operation, status=status, success=status == 'pass',
               documentIdentity=identity,
               units={'length': 'cm', 'angle': 'rad'},
               frame={'space': 'component', 'component': component},
               associativity='snapshot',
               method='GM18 named product states; local manifest, not a native ConfigurationTable',
               provenance={'requirement': 'GM18', 'source': 'docs/POSES.md'})
    out['warnings'] = list(_pose_fusion_cast(list[str], result.pop('warnings', []))) + list(
        _pose_fusion_cast(list[str], extra.pop('warnings', [])))
    out['limitations'] = ['Local attribute manifest, not a native Fusion ConfigurationTable.',
                          'Fill/spring/route/service states are manifest-carried; their mass/force effect is resolved by GM12/GM23, not recomputed here.'] + \
                         list(_pose_fusion_cast(list[str], result.pop('limitations', []))) + list(
                             _pose_fusion_cast(list[str], extra.pop('limitations', [])))
    out['affected'] = list(_pose_fusion_cast(list["JsonValue"], result.pop('affected', []))) + list(
        _pose_fusion_cast(list["JsonValue"], extra.pop('affected', [])))
    out.update(extra)
    out.update(result)
    return out


def _pose_identity(ctx: "CadContext") -> "JsonObject":
    document = _pose_fusion_cast(object, ctx.doc) if hasattr(ctx, 'doc') else None
    if document is None:
        return {'creationId': None, 'name': None}
    typed_document = _pose_fusion_cast('adsk.core.Document', document)
    return {'creationId': getattr(typed_document, 'creationId', None),
            'name': getattr(typed_document, 'name', None)}




def _pose_attributes(ctx: "CadContext") -> 'adsk.core.Attributes':
    root_value = (ctx.root if hasattr(ctx, 'root') else
                  _pose_fusion_cast(object, getattr(ctx, 'component', None)))
    root = _pose_fusion_cast(object, root_value)
    if root is None or not hasattr(root, 'attributes'):
        raise ValueError('Pose manifest requires root-component attributes')
    owner = _pose_fusion_cast(_PoseAttributeOwner, root)
    attributes = owner.attributes
    if attributes is None:
        raise ValueError('Pose manifest requires root-component attributes')
    return _pose_fusion_cast('adsk.core.Attributes', attributes)


def _pose_index_read(ctx: "CadContext") -> dict[str, object]:
    attribute_value = _pose_fusion_cast(
        object, _pose_attributes(ctx).itemByName(_POSE_GROUP, _POSE_INDEX))
    if attribute_value is None:
        return {}
    attribute = _pose_fusion_cast('adsk.core.Attribute', attribute_value)
    value = _pose_fusion_cast(object, _pose_fusion_json.loads(attribute.value))
    return _pose_fusion_cast(dict[str, object], value) if isinstance(value, dict) else {}


def _pose_index_write(ctx: "CadContext", index: dict[str, object]) -> None:
    _cad_require_result(_pose_attributes(ctx).add(_POSE_GROUP, _POSE_INDEX, _pose_fusion_json.dumps(index)), 'Store pose index')




def _pose_manifest(ctx: "CadContext", name: str, revision: int,
                   data: "JsonObject") -> "JsonObject":
    identity = _pose_identity(ctx)
    saved_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    return _pose_manifest_data(name, revision, data, identity, saved_at, _POSE_SCHEMA)


def _pose_read_manifest(ctx: "CadContext", name: str) -> "JsonObject":
    index = _pose_index_read(ctx)
    if name not in index:
        raise ValueError('No saved pose named ' + name)
    manifest = index[name]
    if not isinstance(manifest, dict):
        raise ValueError('Pose manifest has an incompatible schema')
    manifest_data = _pose_fusion_cast('JsonObject', manifest)
    if manifest_data.get('schema') != _POSE_SCHEMA:
        raise ValueError('Pose manifest has an incompatible schema')
    return manifest_data


def _pose_resolve_refs(ctx: "CadContext", manifest: "JsonObject") -> list[tuple[_PoseVisibility, bool]]:
    """Fail before mutation on any stale ref; returns resolved visibility entities."""
    for spec in _pose_fusion_cast('list[JsonObject]', manifest.get('joints', [])):
        ctx.resolve(spec.get('joint'))
    for spec in _pose_fusion_cast('list[JsonObject]', manifest.get('parameters', [])):
        name = spec.get('name')
        if not isinstance(name, str) or not name:
            raise ValueError('parameter entries require a name')
    visibility: list[tuple[_PoseVisibility, bool]] = []
    for spec in _pose_fusion_cast('list[JsonObject]', manifest.get('visibility', [])):
        entity = _pose_fusion_cast(_PoseVisibility, ctx.resolve(spec.get('ref')))
        visibility.append((entity, _pose_fusion_cast(bool, spec.get('visible'))))
    return visibility


def pose_save(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _pose_version(data)
    _model_fields(data, ('schemaVersion', 'frame', 'name'),
                  ('revision', 'joints', 'parameters', 'visibility', 'fillState', 'springState',
                   'routeVariant', 'service', 'onExisting', 'confirm'))
    name = data['name']
    if not isinstance(name, str) or not name.strip():
        raise ValueError('pose name must be nonempty')
    _pose_validate_fields(data)
    policy = data.get('onExisting', 'error')
    if policy not in ('error', 'update'):
        raise ValueError('onExisting must be error or update')
    revision = data.get('revision', 1)
    if type(revision) is not int or revision < 1:
        raise ValueError('revision must be a positive integer')
    index = _pose_index_read(ctx)
    if name in index and policy == 'error':
        raise ValueError('Pose already exists: ' + name + '; choose onExisting:update with confirm')
    if name in index and policy == 'update':
        ctx.require_confirm(data)
        if 'revision' not in data:
            revision = _pose_fusion_cast(
                int, _pose_fusion_cast('JsonObject', index[name]).get('revision', 0)) + 1
    manifest = _pose_manifest(ctx, name, revision, data)
    index[name] = manifest
    _pose_index_write(ctx, index)
    return _pose_contract(ctx, 'pose.save',
                          {'name': name, 'revision': revision, 'manifest': manifest,
                           'identity': _pose_identity(ctx), 'changed': True},
                          read_only=False)




def _pose_capture(ctx: "CadContext", manifest: "JsonObject") -> "JsonObject":
    joints: dict[_pose_Hashable, "JsonValue"] = {}
    for spec in _pose_fusion_cast('list[JsonObject]', manifest.get('joints', [])):
        inspected = _pose_fusion_cast(
            'JsonObject', ctx.call('joint.inspect', {'joint': spec['joint']}))
        for key, units in (('rotationValue', 'rad'), ('slideValue', 'cm')):
            if key in inspected:
                joints[_pose_key(spec['joint'])] = {'value': inspected[key], 'units': units}
                break
    parameters: dict[str, "JsonValue"] = {}
    parameter_specs = _pose_fusion_cast('list[JsonObject]', manifest.get('parameters', []))
    names: list[str] = []
    for spec in parameter_specs:
        name = spec.get('name')
        if isinstance(name, str):
            names.append(name)
    if names:
        inspected = _pose_fusion_cast('JsonObject', ctx.call('param.inspect', {'names': names}))
        for row in _pose_fusion_cast('list[JsonObject]', inspected.get('parameters', [])):
            parameters[_pose_fusion_cast(str, row['name'])] = row.get('expression', row.get('value'))
    visibility: dict[_pose_Hashable, "JsonValue"] = {}
    for spec in _pose_fusion_cast('list[JsonObject]', manifest.get('visibility', [])):
        try:
            entity = _pose_fusion_cast(_PoseVisibility, ctx.resolve(spec.get('ref')))
            visibility[_pose_key(spec.get('ref'))] = bool(entity.isLightBulbOn)
        except Exception:
            visibility[_pose_key(spec.get('ref'))] = None
    return _pose_fusion_cast("JsonObject", {
        'joints': joints, 'parameters': parameters, 'visibility': visibility})


def _pose_apply_manifest(
        ctx: "CadContext", manifest: "JsonObject", resolve: bool = True
) -> tuple[list["JsonObject"], list["JsonObject"]]:
    visibility = _pose_resolve_refs(ctx, manifest) if resolve else []
    applied: list["JsonObject"] = []
    unapplied: list["JsonObject"] = []
    for spec in _pose_fusion_cast('list[JsonObject]', manifest.get('joints', [])):
        drive: "JsonObject" = {'joint': spec['joint']}
        if 'rotation' in spec:
            drive['rotation'] = spec['rotation']
        elif 'slide' in spec:
            drive['slide'] = spec['slide']
        else:
            unapplied.append({'dimension': 'joint', 'ref': spec.get('joint'), 'reason': 'no rotation or slide value'})
            continue
        result = _pose_fusion_cast('JsonObject', ctx.call('joint.drive', drive))
        applied.append({'dimension': 'joint', 'ref': spec.get('joint'),
                        'requested': drive, 'actual': {k: result.get(k) for k in ('rotationValue', 'slideValue') if k in result}})
    if manifest.get('parameters'):
        result = _pose_fusion_cast(
            'JsonObject', ctx.call('param.apply', {'parameters': manifest['parameters'], 'overwrite': True}))
        for row in _pose_fusion_cast('list[JsonObject]', result.get('parameters', [])):
            applied.append({'dimension': 'parameter', 'ref': row.get('name'), 'actual': row.get('expression')})
    for entity, visible in visibility:
        entity.isLightBulbOn = visible
        applied.append({'dimension': 'visibility', 'ref': None, 'actual': {'isLightBulbOn': entity.isLightBulbOn, 'visible': visible}})
    for dimension, key in (('fillState', 'fillState'), ('springState', 'springState'),
                           ('routeVariant', 'routeVariant'), ('service', 'service')):
        if manifest.get(key) is not None:
            applied.append({'dimension': dimension, 'requested': manifest.get(key),
                            'actual': manifest.get(key), 'applied': 'manifest-carried'})
    return applied, unapplied


def pose_apply(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _pose_version(data)
    _model_fields(data, ('schemaVersion', 'frame', 'name'), ())
    manifest = _pose_read_manifest(ctx, _pose_fusion_cast(str, data['name']))
    if manifest.get('document') != _pose_identity(ctx):
        raise ValueError('Pose belongs to a different document; recapture the pose for this document')
    before = _pose_capture(ctx, manifest)
    applied, unapplied = _pose_apply_manifest(ctx, manifest)
    after = _pose_capture(ctx, manifest)
    status = 'pass' if not unapplied else 'fail'
    return _pose_contract(ctx, 'pose.apply',
                          {'name': manifest['name'], 'revision': manifest['revision'],
                           'requested': manifest, 'applied': applied, 'unapplied': unapplied,
                           'before': before, 'after': after, 'leftApplied': True},
                          status=status, read_only=False,
                          limitations=['apply leaves the requested state; no automatic restoration.'])


def pose_evaluate(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _pose_version(data)
    _model_fields(data, ('schemaVersion', 'frame', 'name'), ())
    manifest = _pose_read_manifest(ctx, _pose_fusion_cast(str, data['name']))
    if manifest.get('document') != _pose_identity(ctx):
        raise ValueError('Pose belongs to a different document; recapture the pose for this document')
    before = _pose_capture(ctx, manifest)
    applied: list["JsonObject"] = []
    unapplied: list["JsonObject"] = []
    after: "JsonObject | None" = None
    primary_error: str | None = None
    restore_errors: list[str] = []
    try:
        applied, unapplied = _pose_apply_manifest(ctx, manifest)
        after = _pose_capture(ctx, manifest)
    except Exception as exc:
        primary_error = type(exc).__name__ + ': ' + str(exc)
    finally:
        restore_errors.extend(_pose_restore(ctx, manifest, before))
    try:
        restored: "JsonObject | None" = _pose_capture(ctx, manifest)
    except Exception as exc:
        restored = None
        restore_errors.append('readback: ' + type(exc).__name__ + ': ' + str(exc))
    restored_ok = not restore_errors and restored == before
    status = 'pass' if primary_error is None and not unapplied and restored_ok else 'fail'
    result: "JsonObject" = {'name': manifest['name'], 'revision': manifest['revision'],
              'requested': manifest, 'applied': applied, 'unapplied': unapplied,
              'before': before, 'after': after, 'restored': restored_ok,
              'restoration': restored, 'primaryError': primary_error, 'restoreErrors': restore_errors}
    if not restored_ok:
        result['warnings'] = ['Restoration failed; the previous state was not fully re-established. Restore failure is a separate error from the requested evaluation.']
    return _pose_contract(ctx, 'pose.evaluate', result, status=status, read_only=False,
                          limitations=['evaluate applies temporarily and restores the previous state; restoration failure is reported separately.'])


def _pose_restore(ctx: "CadContext", manifest: "JsonObject",
                  before: "JsonObject") -> list[str]:
    errors: list[str] = []
    before_joints = _pose_fusion_cast('dict[_pose_Hashable, JsonValue]', before['joints'])
    before_parameters = _pose_fusion_cast('dict[str, JsonValue]', before['parameters'])
    before_visibility = _pose_fusion_cast('dict[_pose_Hashable, JsonValue]', before['visibility'])
    for spec in _pose_fusion_cast('list[JsonObject]', manifest.get('joints', [])):
        captured = before_joints.get(_pose_key(spec.get('joint')))
        if not captured:
            continue
        captured_record = _pose_fusion_cast('JsonObject', captured)
        drive = {'joint': spec['joint']}
        if 'rotation' in spec:
            drive['rotation'] = format(float(_pose_fusion_cast(str | int | float, captured_record['value'])), '.17g') + ' ' + _pose_fusion_cast(str, captured_record['units'])
        elif 'slide' in spec:
            drive['slide'] = format(float(_pose_fusion_cast(str | int | float, captured_record['value'])), '.17g') + ' ' + _pose_fusion_cast(str, captured_record['units'])
        else:
            continue
        try:
            ctx.call('joint.drive', drive)
        except Exception as exc:
            errors.append('joint %s: %s: %s' % (_pose_key(spec.get('joint')), type(exc).__name__, str(exc)))
    parameter_specs = _pose_fusion_cast('list[JsonObject]', manifest.get('parameters', []))
    names: list[str] = []
    for spec in parameter_specs:
        name = spec.get('name')
        if isinstance(name, str):
            names.append(name)
    if names:
        for name in names:
            expression = before_parameters.get(name)
            if expression is None:
                errors.append('parameter %s: no baseline expression' % name)
                continue
            try:
                ctx.call('param.apply', {'parameters': [{'name': name, 'expression': expression}], 'overwrite': True})
            except Exception as exc:
                errors.append('parameter %s: %s: %s' % (name, type(exc).__name__, str(exc)))
    for spec in _pose_fusion_cast('list[JsonObject]', manifest.get('visibility', [])):
        value = before_visibility.get(_pose_key(spec.get('ref')))
        if value is None:
            errors.append('visibility %s: no baseline state' % _pose_key(spec.get('ref')))
            continue
        try:
            _pose_fusion_cast(_PoseVisibility, ctx.resolve(spec.get('ref'))).isLightBulbOn = _pose_fusion_cast(bool, value)
        except Exception as exc:
            errors.append('visibility %s: %s: %s' % (_pose_key(spec.get('ref')), type(exc).__name__, str(exc)))
    return errors


def pose_list(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _pose_version(data)
    _model_fields(data, ('schemaVersion', 'frame'), ())
    index = _pose_index_read(ctx)
    rows: list["JsonObject"] = []
    for name, manifest in index.items():
        if isinstance(manifest, dict):
            manifest_record = _pose_fusion_cast('JsonObject', manifest)
            rows.append({'name': name, 'revision': manifest_record.get('revision'),
                         'savedAt': manifest_record.get('savedAt'), 'document': manifest_record.get('document')})
    rows.sort(key=lambda row: _pose_fusion_cast(str, row['name']))
    return _pose_contract(ctx, 'pose.list', {'poses': rows, 'count': len(rows)}, read_only=True)


def pose_delete(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _pose_version(data)
    _model_fields(data, ('schemaVersion', 'frame', 'name'), ('confirm',))
    ctx.require_confirm(data)
    name = _pose_fusion_cast(str, data['name'])
    index = _pose_index_read(ctx)
    if name not in index:
        raise ValueError('No saved pose named ' + name)
    removed = index.pop(name)
    _pose_index_write(ctx, index)
    return _pose_contract(ctx, 'pose.delete',
                          {'name': name, 'deleted': True,
                           'revision': _pose_fusion_cast('JsonObject', removed).get('revision') if isinstance(removed, dict) else None},
                          read_only=False)


CAD_HANDLERS.update({'pose.save': pose_save, 'pose.apply': pose_apply, 'pose.list': pose_list,
                     'pose.delete': pose_delete, 'pose.evaluate': pose_evaluate})

_fmcad_pose_runtime_loaded = True
