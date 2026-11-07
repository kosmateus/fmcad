"""Durable recipe ownership and guarded in-place native parameter regeneration.

The Node batch runner remains the only operation executor. This module records
ownership and edits model parameters; it never deletes or recreates geometry.
"""
if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'definitions'
import json as _definition_json
import math as _definition_math
import re as _definition_re
from typing import TYPE_CHECKING as _definition_type_checking

_DEFINITION_GROUP = 'fmcad.recipes.v1'
_DEFINITION_OWNER = 'fmcad.recipeOwner.v1'


if _definition_type_checking:
    class _DefinitionAttributeCollection(_Protocol):
        def itemByName(self, group: str, name: str, /) -> "adsk.core.Attribute | None": ...

        def add(self, group: str, name: str, value: str, /) -> bool: ...

    class _DefinitionOwnedEntity(_Protocol):
        @property
        def attributes(self) -> _DefinitionAttributeCollection: ...

    class _DefinitionParameter(_Protocol):
        @property
        def name(self) -> str: ...

        @property
        def unit(self) -> str: ...

        @property
        def expression(self) -> str: ...

        @expression.setter
        def expression(self, value: str) -> None: ...

        @property
        def createdBy(self) -> object | None: ...

    class _DefinitionSketchCurve(_Protocol):
        @property
        def objectType(self) -> str: ...

        @property
        def isConstruction(self) -> bool: ...

        @property
        def isFixed(self) -> bool: ...

        @property
        def geometry(self) -> object: ...

    class _DefinitionSketchPoint(_Protocol):
        @property
        def geometry(self) -> "adsk.core.Point3D": ...

    class _DefinitionSketchDimension(_Protocol):
        @property
        def objectType(self) -> str: ...

        @property
        def parameter(self) -> _DefinitionParameter: ...

    class _DefinitionNurbsCurve(_Protocol):
        def getData(self) -> "tuple[bool, Sequence[object], int, Sequence[float], bool, Sequence[float], bool]": ...


def _definition_ready(ctx: "CadContext") -> "adsk.fusion.Timeline":
    ctx.assert_identity()
    if not ctx.doc_file_id or not ctx.doc.dataFile or ctx.doc.dataFile.id != ctx.doc_file_id:
        raise ValueError('Durable recipes require a saved document pinned with --doc-file-id')
    if _cad_cast(object, ctx.design.designType) != adsk.fusion.DesignTypes.ParametricDesignType:
        raise ValueError('Durable recipes require native parametric history')
    timeline = ctx.design.timeline
    if timeline.markerPosition != timeline.count:
        raise ValueError('Recipe requires timeline at end; marker is not moved automatically')
    if any(_cad_cast(object, item.healthState) !=
           adsk.fusion.FeatureHealthStates.HealthyFeatureHealthState
           for item in _cad_items(_cad_cast("_CadItemCollection[adsk.fusion.TimelineObject]", timeline))):
        raise ValueError('Unhealthy history blocks recipe changes')
    return timeline




def _definition_store(ctx: "CadContext", record: "JsonRecord") -> None:
    _cad_require_result(ctx.root.attributes.add(_DEFINITION_GROUP, _cad_cast(str, record['id']),
                        _definition_json.dumps(record, allow_nan=False, sort_keys=True)), 'Store durable recipe')


def _definition_load(ctx: "CadContext", name: str) -> "JsonRecord":
    attribute = ctx.root.attributes.itemByName(_DEFINITION_GROUP, _definition_id(name))
    if not attribute:
        raise ValueError('Missing durable recipe/source: ' + name)
    record = _cad_cast("JsonRecord", _definition_json.loads(attribute.value))
    if record.get('formatVersion') != 1 or record.get('fileId') != ctx.doc_file_id:
        raise ValueError('Recipe format or document identity conflict')
    return record


def _definition_state(ctx: "CadContext", entity: "CadEntity") -> "JsonRecord":
    state: JsonRecord = {'type': entity.objectType, 'name': getattr(entity, 'name', None),
             'suppressed': getattr(entity, 'isSuppressed', False)}
    all_parameters = _cad_items(_cad_cast(
        "_CadItemCollection[_DefinitionParameter]", ctx.design.allParameters))
    state['parameters'] = [{'name': parameter.name, 'expression': parameter.expression, 'unit': parameter.unit}
                           for parameter in all_parameters
                           if getattr(parameter, 'createdBy', None) == entity]
    if _cad_kind(entity) == 'sketch':
        sketch = _cad_cast("adsk.fusion.Sketch", entity)
        # Exact control data, rather than tessellation or sampled bounding boxes.
        curves: list[JsonRecord] = []
        curve_collection = _cad_cast("_CadItemCollection[adsk.fusion.SketchCurve]", sketch.sketchCurves)
        for curve_value in _cad_items(curve_collection):
            curve = _cad_cast("_DefinitionSketchCurve", curve_value)
            geometry = _cad_cast("adsk.core.Base", curve.geometry)
            nurbs = getattr(geometry, 'asNurbsCurve', None)
            if nurbs is None:
                raise ValueError('Recipe snapshot does not support curve type ' + geometry.objectType)
            data = _cad_cast("_DefinitionNurbsCurve", nurbs).getData()
            if not data[0]:
                raise ValueError('Cannot read curve control data for recipe ownership')
            # getData arrays can be SWIG vectors, not list/tuple or Fusion Base.
            _, points, degree, knots, rational, weights, periodic = data
            curves.append({'type': curve.objectType, 'construction': curve.isConstruction,
                           'fixed': curve.isFixed, 'data': _cad_json([
                               list(points), degree, list(knots), rational, list(weights), periodic])})
        sketch_points = _cad_items(_cad_cast(
            "_CadItemCollection[_DefinitionSketchPoint]", sketch.sketchPoints))
        constraints = _cad_items(_cad_cast(
            "_CadItemCollection[adsk.fusion.GeometricConstraint]", sketch.geometricConstraints))
        dimensions = _cad_items(_cad_cast(
            "_CadItemCollection[_DefinitionSketchDimension]", sketch.sketchDimensions))
        state.update(curves=curves,
                     points=[_cad_xyz(point.geometry) for point in sketch_points],
                     constraints=[constraint.objectType for constraint in constraints],
                     dimensions=[{'type': dimension.objectType, 'expression': dimension.parameter.expression}
                                 for dimension in dimensions])
    if _cad_kind(entity) == 'occurrence':
        occurrence = _cad_cast("adsk.fusion.Occurrence", entity)
        state['transform'] = list(occurrence.transform2.asArray())
    return state


def _definition_snapshot(ctx: "CadContext") -> "list[JsonRecord]":
    timeline = _cad_cast("_CadItemCollection[adsk.fusion.TimelineObject]", ctx.design.timeline)
    return [{'ref': ctx.ref(item.entity), 'state': _definition_state(ctx, item.entity)}
            for item in _cad_items(timeline)]


def _definition_user_parameters(ctx: "CadContext") -> "list[JsonRecord]":
    parameters = _cad_items(_cad_cast(
        "_CadItemCollection[_DefinitionParameter]", ctx.design.allParameters))
    return [{'name': p.name, 'expression': p.expression, 'unit': p.unit}
            for p in parameters if getattr(p, 'createdBy', None) is None]


def _definition_compare(ctx: "CadContext", snapshot: "Sequence[JsonObject]",
                        prefix: bool = False) -> None:
    timeline = ctx.design.timeline
    if len(snapshot) > timeline.count or not prefix and len(snapshot) != timeline.count:
        raise ValueError('Downstream/history membership conflict; recipe migration required')
    for i, saved in enumerate(snapshot):
        entity = ctx.resolve(saved['ref'])
        if entity != timeline.item(i).entity or _definition_state(ctx, entity) != saved['state']:
            raise ValueError('User edit or history order conflict at ' + str(i))


def _definition_bindings(ctx: "CadContext", bindings: "JsonValue",
                         owned: "Sequence[CadEntity]") -> "list[JsonRecord]":
    if not isinstance(bindings, list) or not bindings:
        raise ValueError('Nonempty native parameter bindings required')
    binding_values = _cad_cast("Sequence[JsonValue]", bindings)
    result: list[JsonRecord] = []
    seen: set[str] = set()
    for binding_value in binding_values:
        binding = _cad_cast("JsonObject", binding_value)
        _cad_fields(binding, ('parameter', 'target', 'input'), ('name', 'role'))
        feature = ctx.resolve(binding['target'], 'feature')
        if not any(feature == entity for entity in owned):
            raise ValueError('Binding target is not an owned recipe feature')
        if 'name' not in binding and 'role' not in binding:
            raise ValueError('Binding requires a native parameter name or role')
        parameters = _cad_items(_cad_cast(
            "_CadItemCollection[_DefinitionParameter]", ctx.design.allParameters))
        candidates: list[_DefinitionParameter] = [parameter for parameter in parameters
                      if getattr(parameter, 'createdBy', None) == feature
                      and ('name' not in binding or parameter.name == binding['name'])
                      and ('role' not in binding or
                           _cad_cast(str, getattr(parameter, 'role')) == binding['role'])]
        parameter = _cad_unique(candidates, 'Recipe parameter binding')
        if parameter.name in seen:
            raise ValueError('Duplicate native parameter binding: ' + parameter.name)
        seen.add(parameter.name)
        result.append({'parameter': binding['parameter'], 'target': ctx.ref(feature),
                       'name': parameter.name, 'unit': parameter.unit, 'expression': parameter.expression})
    return result


def _definition_recipe(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('action', 'recipe', 'sourceHash'), ('source', 'bindings', 'exports', 'created'))
    timeline = _definition_ready(ctx)
    recipe = _cad_cast("JsonObject", data['recipe'])
    _cad_fields(recipe, ('id', 'bindings'))
    name = _definition_id(recipe['id'])
    if not isinstance(data['sourceHash'], str) or not _definition_re.fullmatch('[a-f0-9]{64}', data['sourceHash']):
        raise ValueError('sourceHash must be a SHA256 hex string')
    if data['action'] == 'begin':
        if ctx.root.attributes.itemByName(_DEFINITION_GROUP, name):
            raise ValueError('Recipe already exists; inspect instead of replaying mutations')
        source_value = data.get('source')
        if not isinstance(source_value, dict) or not source_value.get('operations'):
            raise ValueError('Embedded recipe source required before mutation')
        source = source_value
        binding_values = recipe['bindings']
        if not isinstance(binding_values, list) or not binding_values:
            raise ValueError('Recipe declaration requires nonempty bindings')
        bindings = _cad_cast("Sequence[JsonValue]", binding_values)
        source_parameters = _cad_cast("JsonObject", source.get('parameters', {}))
        for binding_value in bindings:
            binding = _cad_cast("JsonObject", binding_value)
            _cad_fields(binding, ('parameter', 'input', 'target'), ('name', 'role'))
            if not isinstance(binding['input'], str) or not binding['input'] or not isinstance(
                    source_parameters.get(_cad_cast(str, binding['parameter'])), str):
                raise ValueError('Binding requires an input path and a root expression parameter')
            target = binding['target']
            if not isinstance(target, dict) or set(target) != {'$ref'} or not isinstance(target['$ref'], str):
                raise ValueError('Binding target must be a symbolic output reference')
            if not any(isinstance(binding.get(key), str) and binding[key] for key in ('name', 'role')):
                raise ValueError('Binding requires a native parameter name or role')
        record: JsonRecord = {'formatVersion': 1, 'id': name, 'revision': 1, 'fileId': ctx.doc_file_id,
                  'sourceHash': data['sourceHash'], 'source': source, 'declaration': recipe,
                  'status': 'building', 'baseline': _definition_snapshot(ctx)}
        _definition_store(ctx, record)
    elif data['action'] == 'complete':
        record = _definition_load(ctx, name)
        if record['status'] != 'building' or record['sourceHash'] != data['sourceHash'] or record['declaration'] != recipe:
            raise ValueError('Recipe source/state conflict; completion refused')
        baseline = _cad_cast("Sequence[JsonObject]", record['baseline'])
        _definition_compare(ctx, baseline, prefix=True)
        owned: list[CadEntity] = [timeline.item(i).entity for i in range(len(baseline), timeline.count)]
        if not owned:
            raise ValueError('Recipe created no native history entities')
        if not isinstance(data.get('created'), list):
            raise ValueError('Actual batch created refs required for ownership attribution')
        created_values = _cad_cast("Sequence[JsonValue]", data['created'])
        created = [ctx.resolve(ref) for ref in created_values]
        if any(not any(entity == candidate for candidate in created) for entity in owned):
            raise ValueError('Unattributed downstream history; refusing to adopt foreign entities')
        bindings = _definition_bindings(ctx, data.get('bindings'), owned)
        for entity in owned:
            owned_entity = _cad_cast("_DefinitionOwnedEntity", entity)
            if owned_entity.attributes.itemByName(_DEFINITION_OWNER, 'id'):
                raise ValueError('Entity already owned by another recipe')
        snapshot = _definition_snapshot(ctx)
        for entity in owned:
            owned_entity = _cad_cast("_DefinitionOwnedEntity", entity)
            _cad_require_result(owned_entity.attributes.add(_DEFINITION_OWNER, 'id', name), 'Tag recipe ownership')
        source_record = _cad_cast("JsonObject", record['source'])
        record.update(status='ready', bindings=bindings, snapshot=snapshot,
                      owned=[ctx.ref(entity) for entity in owned], exports=data.get('exports', {}),
                      userParameters=_definition_user_parameters(ctx),
                      parameters=source_record.get('parameters', {}))
        _definition_store(ctx, record)
    else:
        raise ValueError('Recipe action must be begin or complete')
    return {'status': 'pass', 'recipeStatus': record['status'], 'id': name, 'revision': record['revision'],
            'sourceHash': record['sourceHash'], 'documentIdentity': {'fileId': ctx.doc_file_id},
            'associativity': 'recipeRegeneration', 'savedToCloud': False,
            'method': 'durable document attributes; appended native history ownership', 'atomic': False}


def _definition_regenerate(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('id', 'expectedRevision', 'sourceHash'), ('parameters', 'dryRun'))
    if type(data.get('dryRun', True)) is not bool or type(data['expectedRevision']) is not int or data['expectedRevision'] < 1:
        raise ValueError('dryRun must be boolean; expectedRevision must be a positive integer')
    _definition_ready(ctx)
    record = _definition_load(ctx, _cad_cast(str, data['id']))
    if record['status'] != 'ready' or record['revision'] != data['expectedRevision']:
        raise ValueError('Recipe revision/state conflict; no automatic retry')
    if not record.get('source') or record['sourceHash'] != data['sourceHash']:
        raise ValueError('Missing or changed source hash; preflight/migration required')
    snapshot = _cad_cast("Sequence[JsonObject]", record['snapshot'])
    _definition_compare(ctx, snapshot)
    if _definition_user_parameters(ctx) != record['userParameters']:
        raise ValueError('User parameter/dependency conflict')
    owned_refs = _cad_cast("Sequence[JsonValue]", record['owned'])
    owned: list[CadEntity] = [ctx.resolve(ref) for ref in owned_refs]
    for entity in owned:
        owned_entity = _cad_cast("_DefinitionOwnedEntity", entity)
        tag = owned_entity.attributes.itemByName(_DEFINITION_OWNER, 'id')
        if not tag or tag.value != record['id']:
            raise ValueError('Recipe ownership conflict')
    changes = _cad_cast("JsonObject", data.get('parameters', {}))
    bindings_to_change = _definition_regeneration_bindings(record, changes)
    plan: list[JsonRecord] = []
    for binding in bindings_to_change:
        parameter_key = _cad_cast(str, binding['parameter'])
        expression = changes[parameter_key]
        # Reuse the existing feature-edit validator and native parameter selector.
        feature, edits = _cad_cast(
            "tuple[adsk.fusion.Feature, list[tuple[_DefinitionParameter, JsonValue]]]",
            _assembly_feature_plan(ctx, {'feature': binding['target'],
                                         'parameters': {_cad_cast(str, binding['name']): expression}}))
        parameter = edits[0][0]
        if parameter.expression != binding['expression'] or parameter.unit != binding['unit']:
            raise ValueError('User-edited binding conflicts with durable recipe')
        plan.append({'parameter': binding['parameter'], 'name': parameter.name, 'unit': parameter.unit,
                     'target': ctx.ref(feature), 'before': parameter.expression, 'after': expression})
    result: JsonRecord = {'status': 'pass', 'id': record['id'], 'revision': record['revision'], 'plan': plan,
              'applied': False, 'documentIdentity': {'fileId': ctx.doc_file_id},
              'associativity': 'recipeRegeneration', 'units': 'per-binding unit', 'frame': 'native owning component',
              'affected': [], 'warnings': [], 'atomic': False,
              'provenance': {'sourceHash': record['sourceHash'], 'formatVersion': 1},
              'method': 'in-place native model parameter expressions',
              'limitations': ['Conservative whole-history fence; not a complete downstream dependency graph.',
                              'Snapshot checks names, parameter expressions, curve control data and history membership; not every SDK feature property.',
                              'No automatic save, rollback, source migration or structural rebuild.']}
    if data.get('dryRun', True) or not plan:
        return result
    # Write uncertainty before the first assignment; any exception leaves a durable fence.
    record['status'] = 'updating'
    record['pending'] = plan
    _definition_store(ctx, record)
    for change in plan:
        ctx.assert_identity()
        ctx.call('feature.edit', {'feature': change['target'],
                                  'parameters': {_cad_cast(str, change['name']): change['after']}})
    _cad_require_result(ctx.design.computeAll(), 'Recipe recompute')
    _definition_ready(ctx)
    stored_bindings = _cad_cast("Sequence[JsonObject]", record['bindings'])
    for binding in stored_bindings:
        parameter_key = _cad_cast(str, binding['parameter'])
        if parameter_key in changes:
            feature, edits = _cad_cast(
                "tuple[adsk.fusion.Feature, list[tuple[_DefinitionParameter, JsonValue]]]",
                _assembly_feature_plan(ctx, {'feature': binding['target'],
                    'parameters': {_cad_cast(str, binding['name']): changes[parameter_key]}}))
            actual = edits[0][0].expression
            expression_reader = getattr(ctx, 'expression', None)
            if callable(expression_reader):
                parse_expression = _cad_cast("Callable[[object, str, bool], tuple[str, float]]",
                                             expression_reader)
            else:
                parse_expression = _cad_cast("Callable[[object, str, bool], tuple[str, float]]",
                                             getattr(ctx, '_expression'))
            expected_value = parse_expression(changes[parameter_key], _cad_cast(str, binding['unit']),
                                              binding['unit'] == '')[1]
            actual_value = parse_expression(actual, _cad_cast(str, binding['unit']),
                                            binding['unit'] == '')[1]
            if not _definition_math.isclose(expected_value, actual_value, rel_tol=1e-10, abs_tol=1e-12):
                raise RuntimeError('Native binding readback differs from requested expression')
            binding['expression'] = actual
    parameters = _cad_cast("JsonObject", record['parameters'])
    parameters.update(changes)
    record.update(status='ready', revision=_cad_cast(int, record['revision']) + 1,
                   snapshot=_definition_snapshot(ctx))
    del record['pending']
    _definition_store(ctx, record)
    result.update(applied=True, revision=record['revision'],
                  affected=[change['target'] for change in plan])
    return result


CAD_HANDLERS.update({'definition.recipe': _definition_recipe, 'definition.regenerate': _definition_regenerate})

_fmcad_definitions_runtime_loaded = True
