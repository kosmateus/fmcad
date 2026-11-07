"""Fusion adapter: prewritten sketch and feature commands.

API signatures checked against Autodesk Fusion API documentation via apiDocumentation.
Lengths passed as floats are internal cm; all user dimensional inputs are expressions.
"""
import adsk.core as _geometry_model_core
import adsk.fusion as _geometry_model_fusion
from typing import Protocol as _GeometryModelProtocol
from typing import TypeVar as _geometry_model_TypeVar, cast as _geometry_model_cast
from typing import overload as _geometry_model_overload




_GeometryModelItem = _geometry_model_TypeVar('_GeometryModelItem')


class _GeometryModelNamed(_GeometryModelProtocol):
    name: str


class _GeometryModelConstruction(_GeometryModelProtocol):
    isConstruction: bool


class _GeometryModelPointSelector(_GeometryModelProtocol):
    startSketchPoint: "adsk.fusion.SketchPoint"
    endSketchPoint: "adsk.fusion.SketchPoint"
    centerSketchPoint: "adsk.fusion.SketchPoint"


class _GeometryModelProfileCaster(_GeometryModelProtocol):
    @staticmethod
    def cast(value: object) -> "adsk.fusion.Profile | None": ...


class _GeometryModelFaceCaster(_GeometryModelProtocol):
    @staticmethod
    def cast(value: object) -> "adsk.fusion.BRepFace | None": ...


class _GeometryModelSketchTextCaster(_GeometryModelProtocol):
    @staticmethod
    def cast(value: object) -> "adsk.fusion.SketchText | None": ...


class _GeometryModelPlaneCaster(_GeometryModelProtocol):
    @staticmethod
    def cast(value: object) -> "adsk.core.Plane | None": ...


class _GeometryModelPlanarSupport(_GeometryModelProtocol):
    geometry: object


class _GeometryModelSketchPointCaster(_GeometryModelProtocol):
    @staticmethod
    def cast(value: object) -> "adsk.fusion.SketchPoint | None": ...


class _GeometryModelSketchEntityCaster(_GeometryModelProtocol):
    @staticmethod
    def cast(value: object) -> "adsk.fusion.SketchEntity | None": ...


class _GeometryModelSketchLineCaster(_GeometryModelProtocol):
    @staticmethod
    def cast(value: object) -> "adsk.fusion.SketchLine | None": ...


class _GeometryModelSketchCircleCaster(_GeometryModelProtocol):
    @staticmethod
    def cast(value: object) -> "adsk.fusion.SketchCircle | None": ...


class _GeometryModelSketchArcCaster(_GeometryModelProtocol):
    @staticmethod
    def cast(value: object) -> "adsk.fusion.SketchArc | None": ...


class _GeometryModelBodyCaster(_GeometryModelProtocol):
    @staticmethod
    def cast(value: object) -> "adsk.fusion.BRepBody | None": ...


class _GeometryModelVertexCaster(_GeometryModelProtocol):
    @staticmethod
    def cast(value: object) -> "adsk.fusion.BRepVertex | None": ...


class _GeometryModelConstructionPlaneCaster(_GeometryModelProtocol):
    @staticmethod
    def cast(value: object) -> "adsk.fusion.ConstructionPlane | None": ...


class _GeometryModelConstructionPointCaster(_GeometryModelProtocol):
    @staticmethod
    def cast(value: object) -> "adsk.fusion.ConstructionPoint | None": ...


class _GeometryModelSketchCurveCaster(_GeometryModelProtocol):
    @staticmethod
    def cast(value: object) -> "adsk.fusion.SketchCurve | None": ...


class _GeometryModelBRepEdgeCaster(_GeometryModelProtocol):
    @staticmethod
    def cast(value: object) -> "adsk.fusion.BRepEdge | None": ...


class _GeometryModelSketchCurveConstruction(_GeometryModelProtocol):
    isConstruction: bool


class _GeometryModelConstraintAdder(_GeometryModelProtocol):
    def __call__(self, *entities: "adsk.fusion.SketchEntity") -> "adsk.fusion.GeometricConstraint": ...


class _GeometryModelDimensionParameter(_GeometryModelProtocol):
    @property
    def name(self) -> str: ...

    @property
    def expression(self) -> str: ...


class _GeometryModelOffsetDimension(_GeometryModelProtocol):
    parameter: "_GeometryModelDimensionParameter | None"


class _GeometryModelRectangularPatternInput(_GeometryModelProtocol):
    def setDirectionOne(self, direction: "adsk.fusion.SketchLine | None",
                        quantity: "adsk.core.ValueInput", distance: "adsk.core.ValueInput") -> bool: ...

    def setDirectionTwo(self, direction: "adsk.fusion.SketchLine | None",
                        quantity: "adsk.core.ValueInput", distance: "adsk.core.ValueInput") -> bool: ...


class _GeometryModelSolidFeatureInput(_GeometryModelProtocol):
    isSolid: bool


class _GeometryModelParticipantsFeatureInput(_GeometryModelProtocol):
    participantBodies: list["adsk.fusion.BRepBody"]


class _GeometryModelSurfacePreflight(_GeometryModelProtocol):
    def __call__(self, ctx: "CadContext", data: "JsonObject", mode: str, /) -> "JsonValue | None": ...


class _GeometryModelSurfaceLoftConditions(_GeometryModelProtocol):
    def __call__(self, ctx: "CadContext", inp: "adsk.fusion.LoftFeatureInput",
                 data: "JsonObject", /) -> None: ...


class _GeometryModelSurfaceResult(_GeometryModelProtocol):
    def __call__(self, ctx: "CadContext", mode: str, data: "JsonObject",
                 feature: "adsk.fusion.Feature", result: "JsonObject", /) -> "JsonValue": ...


class _GeometryModelAssemblyContext(_GeometryModelProtocol):
    @property
    def assemblyContext(self) -> "adsk.fusion.Occurrence | None": ...


class _GeometryModelNativeObject(_GeometryModelProtocol):
    @property
    def nativeObject(self) -> "CadEntity | None": ...


def _model_ok(result: _GeometryModelItem | None, operation: str) -> _GeometryModelItem:
    if result is None or result is False:
        raise RuntimeError('Fusion failed: ' + operation)
    return result


def _model_items(collection: "_CadItemCollection[_GeometryModelItem] | list[_GeometryModelItem] | tuple[_GeometryModelItem, ...]") -> "list[_GeometryModelItem]":
    if isinstance(collection, (list, tuple)):
        return list(collection)
    return [collection.item(i) for i in range(collection.count)]


def _model_enum(group: object, key: object, choices: "Mapping[str, str]") -> object:
    if not isinstance(key, str) or key not in choices:
        raise ValueError('Supported modes: ' + ', '.join(choices))
    return _geometry_model_cast(object, getattr(group, choices[key]))


def _model_assembly_context(entity: "CadEntity") -> "adsk.fusion.Occurrence | None":
    if not hasattr(entity, 'assemblyContext'):
        return None
    return _geometry_model_cast(_GeometryModelAssemblyContext, entity).assemblyContext


def _model_native_object(entity: "CadEntity") -> "CadEntity":
    if not hasattr(entity, 'nativeObject'):
        return entity
    native = _geometry_model_cast(_GeometryModelNativeObject, entity).nativeObject
    return native if native is not None else entity


def _model_json_object(value: object, label: str) -> "JsonObject":
    if not isinstance(value, dict):
        raise ValueError(label + ' must be an object')
    raw = _geometry_model_cast("dict[object, object]", value)
    if any(not isinstance(key, str) for key in raw):
        raise ValueError(label + ' keys must be strings')
    return _geometry_model_cast("JsonObject", value)


def _model_json_object_or_none(value: object, label: str) -> "JsonObject | None":
    if not isinstance(value, dict):
        return None
    raw = _geometry_model_cast("dict[object, object]", value)
    if any(not isinstance(key, str) for key in raw):
        raise ValueError(label + ' keys must be strings')
    return _geometry_model_cast("JsonObject", raw)


def _model_json_array(value: object, label: str) -> "list[JsonValue]":
    if not isinstance(value, list):
        raise ValueError(label + ' must be an array')
    return _geometry_model_cast("list[JsonValue]", value)


def _model_json_text(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise ValueError(label + ' must be text')
    return value


def _model_resolve(ctx: "CadContext", ref: object, kind: str | None = None) -> "CadEntity":
    if isinstance(ref, dict):
        raw_reference = _geometry_model_cast("dict[object, object]", ref)
        if any(not isinstance(key, str) for key in raw_reference):
            raise ValueError('reference keys must be strings')
        reference = _geometry_model_cast("JsonObject", raw_reference)
        if reference.get('kind') == 'openProfile':
            return _surface_open_profile(ctx, reference)
        if reference.get('kind') == 'path':
            return _model_path(ctx, reference)
        if 'entity' in reference and 'point' in reference:
            _model_fields(reference, ('entity', 'point'))
            attr = {'start': 'startSketchPoint', 'end': 'endSketchPoint', 'center': 'centerSketchPoint'}
            point_name = reference['point']
            if not isinstance(point_name, str) or point_name not in attr:
                raise ValueError('Point selector must be start, end, or center')
            selector = _geometry_model_cast(_GeometryModelPointSelector, ctx.resolve(reference['entity']))
            if point_name == 'start':
                return selector.startSketchPoint
            if point_name == 'end':
                return selector.endSketchPoint
            return selector.centerSketchPoint
        return ctx.resolve(reference, kind)
    return ctx.resolve(ref, kind)


@_geometry_model_overload
def _model_entities(ctx: "CadContext", refs: object, sketch: "adsk.fusion.Sketch",
                    kind: None = None) -> "list[CadEntity]": ...


@_geometry_model_overload
def _model_entities(ctx: "CadContext", refs: object, sketch: "adsk.fusion.Sketch",
                    kind: str) -> "list[CadEntity]": ...


@_geometry_model_overload
def _model_entities(ctx: "CadContext", refs: object, sketch: None = None,
                    kind: str | None = None) -> "list[CadEntity]": ...


def _model_entities(ctx: "CadContext", refs: object, sketch: "adsk.fusion.Sketch | None" = None,
                    kind: str | None = None) -> "list[CadEntity]":
    if not isinstance(refs, list) or not refs:
        raise ValueError('entities must be a nonempty array of references')
    references = _geometry_model_cast("list[object]", refs)
    entities = [_model_resolve(ctx, ref, kind) for ref in references]
    if sketch is not None:
        for entity in entities:
            sketch_entity = _geometry_model_cast("adsk.fusion.SketchEntity", entity)
            if sketch_entity.parentSketch != sketch:
                raise ValueError('All entities must belong to the selected sketch')
    return entities


def _model_sketch_entities(ctx: "CadContext", refs: object,
                           sketch: "adsk.fusion.Sketch") -> "list[adsk.fusion.SketchEntity]":
    sketch_entities: list["adsk.fusion.SketchEntity"] = []
    sketch_entity_type: object | None = getattr(_geometry_model_fusion, 'SketchEntity', None)
    caster = (_geometry_model_cast(_GeometryModelSketchEntityCaster, sketch_entity_type)
              if sketch_entity_type is not None else None)
    for entity in _model_entities(ctx, refs, sketch):
        if caster is not None:
            sketch_entity = caster.cast(entity)
            if sketch_entity is None:
                raise ValueError('All entities must be sketch entities')
        else:
            object_type: object = getattr(entity, 'objectType', None)
            parent_sketch: object = getattr(entity, 'parentSketch', None)
            if (not isinstance(object_type, str) or
                    not object_type.rsplit('::', 1)[-1].startswith('Sketch') or
                    parent_sketch != sketch):
                raise ValueError('All entities must be sketch entities')
            sketch_entity = _geometry_model_cast("adsk.fusion.SketchEntity", entity)
        sketch_entities.append(sketch_entity)
    return sketch_entities


def _model_extrude_profile_plane(profile: object) -> "adsk.core.Plane":
    profile_cast = _geometry_model_cast(_GeometryModelProfileCaster, _geometry_model_fusion.Profile)
    face_cast = _geometry_model_cast(_GeometryModelFaceCaster, _geometry_model_fusion.BRepFace)
    plane_cast = _geometry_model_cast(_GeometryModelPlaneCaster, _geometry_model_core.Plane)
    profile_entity = profile_cast.cast(profile)
    if profile_entity is not None:
        plane = profile_entity.plane
        sketch = profile_entity.parentSketch
    elif (face_entity := face_cast.cast(profile)) is not None:
        plane = plane_cast.cast(face_entity.geometry)
        sketch = None
    else:
        sketch_text_type: object | None = getattr(_geometry_model_fusion, 'SketchText', None)
        sketch_text = (_geometry_model_cast(_GeometryModelSketchTextCaster, sketch_text_type).cast(profile)
                       if sketch_text_type is not None else None)
        if sketch_text is None:
            raise ValueError('Extrude profiles must resolve to Profile, planar BRepFace, or SketchText refs')
        sketch = sketch_text.parentSketch
        support = sketch.referencePlane
        support_geometry = _geometry_model_cast(_GeometryModelPlanarSupport, support).geometry
        plane = plane_cast.cast(support_geometry)
    if plane is None:
        raise ValueError('Extrude profiles must have a supported planar definition')
    if sketch is not None:
        transform: object = getattr(sketch, 'transform', None)
        if transform is None:
            raise ValueError('Sketch-based extrude profiles require a model-space sketch transform')
        plane = plane.copy()
        matrix = _geometry_model_cast("adsk.core.Matrix3D", transform)
        if not plane.transformBy(matrix):
            raise ValueError('Unable to transform sketch-based extrude profile plane into model space')
    return plane


def _model_created(ctx: "CadContext", entity: "CadEntity", name: object = None) -> "JsonValue":
    _model_ok(entity, 'create entity')
    if name is not None:
        if not isinstance(name, str) or not name.strip():
            raise ValueError('name must be a nonempty string')
        _geometry_model_cast(_GeometryModelNamed, entity).name = name
    ref = ctx.ref(entity)
    ctx.created.append(ref)
    return ref


def _model_geometry_result(ctx: "CadContext", entities: "Sequence[CadEntity]") -> "JsonObject":
    refs = [_model_created(ctx, entity) for entity in entities]
    return {'entities': refs, 'refs': {}}


def _model_operation(data: "JsonObject") -> "adsk.fusion.FeatureOperations":
    return _geometry_model_cast("adsk.fusion.FeatureOperations", _model_enum(_geometry_model_fusion.FeatureOperations, data.get('operation', 'newBody'), {
        'newBody': 'NewBodyFeatureOperation', 'join': 'JoinFeatureOperation',
        'cut': 'CutFeatureOperation', 'intersect': 'IntersectFeatureOperation'}))


def _model_distance_type(data: "JsonObject") -> "adsk.fusion.PatternDistanceType":
    return _geometry_model_cast("adsk.fusion.PatternDistanceType", _model_enum(_geometry_model_fusion.PatternDistanceType, data.get('distanceType', 'spacing'), {
        'spacing': 'SpacingPatternDistanceType', 'extent': 'ExtentPatternDistanceType'}))


def _model_quantity(ctx: "CadContext", quantity: object) -> "adsk.core.ValueInput":
    if type(quantity) is int:
        if quantity < 1:
            raise ValueError('quantity must be positive')
        return _geometry_model_core.ValueInput.createByReal(quantity)
    if not isinstance(quantity, str) or not quantity.strip():
        raise ValueError('quantity must be a positive integer or unitless parameter expression')
    return ctx.value(quantity)


def _model_path(ctx: "CadContext", data: object) -> "adsk.fusion.Path":
    _model_fields(data, ('curves',), ('chain', 'kind', 'name'))
    data = _geometry_model_cast("JsonObject", data)
    if data.get('kind', 'path') != 'path':
        raise ValueError('Path descriptor kind must be path')
    curves = _model_entities(ctx, data['curves'])
    chain = _geometry_model_cast("adsk.fusion.ChainedCurveOptions", _model_enum(_geometry_model_fusion.ChainedCurveOptions, data.get('chain', 'none'), {
        'none': 'noChainedCurves', 'connected': 'connectedChainedCurves', 'tangent': 'tangentChainedCurves'})
    )
    if len(curves) > 1 and data.get('chain', 'none') != 'none':
        raise ValueError('Automatic chaining requires exactly one seed curve')
    if data.get('chain') == 'connected' and curves[0].objectType.endswith('BRepEdge'):
        raise ValueError('connected chaining supports sketch curves only; use explicit edge refs or tangent chaining')
    owner = _cad_owner(curves[0])
    occurrence = _model_assembly_context(curves[0])
    sketch_curve_caster = _geometry_model_cast(_GeometryModelSketchCurveCaster, _geometry_model_fusion.SketchCurve)
    edge_caster = _geometry_model_cast(_GeometryModelBRepEdgeCaster, _geometry_model_fusion.BRepEdge)
    for curve in curves:
        if sketch_curve_caster.cast(curve) is None and edge_caster.cast(curve) is None:
            raise ValueError('Paths require sketch curves or model edges')
        if _cad_owner(curve) != owner or _model_assembly_context(curve) != occurrence:
            raise ValueError('Path curves must share one component and occurrence context')
    if owner is None or (occurrence is not None and occurrence.component != owner):
        raise ValueError('Path curves require a valid owning component and occurrence context')
    inputs = curves[0] if len(curves) == 1 else ctx.collection(curves)
    if occurrence is not None:
        # Keep the exact proxies, including nested occurrence transforms. Never
        # invent an occurrence for a native component definition.
        return _model_ok(_geometry_model_fusion.Path.create(inputs, chain), 'Path.create')
    # Static Path.create has no component owner and fails for native child
    # sketch curves. Features.createPath supplies that scope without activation.
    path = _model_ok(owner.features.createPath(inputs, data.get('chain') == 'connected'), 'Features.createPath')
    if data.get('chain') == 'tangent':
        _model_ok(path.addCurves(curves[0], chain), 'Path.addCurves')
    return path


def model_path_create(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    path = _model_path(ctx, data)
    curves = _model_json_array(data['curves'], 'curves')
    seed = _model_resolve(ctx, curves[0])
    native_frame = _model_assembly_context(seed) is None
    refs: list["JsonValue"] = []
    for i in range(path.count):
        entity = path.item(i).entity
        # Features.createPath can return contextualized entries for native inputs.
        # Serialize in the requested definition frame, not the SDK's chosen instance.
        if native_frame:
            entity = _model_native_object(entity)
            if _model_assembly_context(entity) is not None or _cad_owner(entity) != _cad_owner(seed):
                raise ValueError('Generated path curve does not belong to the requested native component frame')
        refs.append(ctx.ref(entity))
    descriptor: "JsonObject" = {'kind': 'path', 'curves': refs, 'chain': 'none'}
    if 'name' in data:
        descriptor['name'] = _geometry_model_cast(str, data['name'])
    return {'path': descriptor, 'count': path.count, 'isClosed': path.isClosed}


@_cad_scoped_step('sketch.create', scope_keys=('component',))
def model_sketch_create(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    _model_fields(data, ('name', 'plane'), ('occurrence',))
    if 'occurrence' in data:
        sketch = ctx.component.sketches.addWithoutEdges(
            _model_resolve(ctx, data['plane']), ctx.resolve(data['occurrence'], 'occurrence'))
    else:
        sketch = ctx.component.sketches.addWithoutEdges(_model_resolve(ctx, data['plane']))
    return {'sketch': _model_created(ctx, sketch, _geometry_model_cast(str, data['name']))}


def model_sketch_inspect(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    _model_fields(data, ('sketch',))
    sketch = ctx.resolve(data['sketch'], 'sketch')
    return {'sketch': ctx.ref(sketch), 'isFullyConstrained': sketch.isFullyConstrained,
            'curves': [ctx.describe(e) for e in _model_items(sketch.sketchCurves)],
            'points': [ctx.describe(e) for e in _model_items(sketch.sketchPoints)],
            'constraints': [ctx.ref(e) for e in _model_items(sketch.geometricConstraints)],
            'dimensions': [{'ref': ctx.ref(e), 'expression': e.parameter.expression,
                            'isDriving': e.isDriving} for e in _model_items(sketch.sketchDimensions)],
            'profiles': [{'ref': {'kind': 'profile', 'sketch': ctx.ref(sketch), 'index': i},
                          'loops': sketch.profiles.item(i).profileLoops.count}
                         for i in range(sketch.profiles.count)]}


def model_sketch_check(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    _model_fields(data, ('sketch',))
    sketch = ctx.resolve(data['sketch'], 'sketch')
    health_state = _geometry_model_cast(int, sketch.healthState)
    return {'sketch': ctx.ref(sketch), 'isFullyConstrained': sketch.isFullyConstrained,
            'profileCount': sketch.profiles.count, 'healthState': int(health_state),
            'message': sketch.errorOrWarningMessage,
            'underconstrained': [ctx.ref(e) for e in _model_items(sketch.sketchCurves)
                                 if not e.isFullyConstrained]}


def model_sketch_edit(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    _model_fields(data, ('sketch',), ('name', 'visible', 'entities', 'construction', 'fixed', 'delete', 'confirm'))
    sketch = ctx.resolve(data['sketch'], 'sketch')
    entities: "Sequence[adsk.fusion.SketchEntity]" = (
        _model_sketch_entities(ctx, data['entities'], sketch) if 'entities' in data else ())
    if any(k in data for k in ('construction', 'fixed', 'delete')) and not entities:
        raise ValueError('Entity edits require entities')
    if data.get('delete'):
        ctx.require_confirm(data)
        if any(k in data for k in ('construction', 'fixed')):
            raise ValueError('delete cannot be combined with construction/fixed edits')
    if 'construction' in data and any(not hasattr(e, 'isConstruction') for e in entities):
        raise ValueError('construction applies only to sketch curves')
    if 'name' in data:
        sketch.name = _geometry_model_cast(str, data['name'])
    if 'visible' in data:
        sketch.isLightBulbOn = _geometry_model_cast(bool, data['visible'])
    for entity in entities:
        if data.get('delete'):
            _model_ok(entity.deleteMe(), 'delete sketch entity')
        else:
            if 'construction' in data:
                _geometry_model_cast(_GeometryModelConstruction, entity).isConstruction = _geometry_model_cast(
                    bool, data['construction'])
            if 'fixed' in data:
                entity.isFixed = _geometry_model_cast(bool, data['fixed'])
    return {'sketch': ctx.ref(sketch), 'edited': len(entities)}


def model_sketch_geometry(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    _model_fields(data, ('sketch', 'geometry'))
    sketch = ctx.resolve(data['sketch'], 'sketch')
    specs = _model_json_array(data['geometry'], 'geometry')
    if not specs:
        raise ValueError('geometry must be a nonempty array')
    schemas = {'point': ('point',), 'line': ('start', 'end'), 'circle': ('center', 'radius'),
               'arc': ('center', 'start', 'sweep'), 'arc3': ('start', 'through', 'end'),
               'rectangle': ('start', 'end'), 'spline': ('points',), 'bezier': ('controlPoints',)}
    names: set[str] = set()
    validated_specs: "list[tuple[str, JsonObject, list[JsonValue], str | None, bool | None, bool | None]]" = []
    for spec_value in specs:
        spec = _model_json_object(spec_value, 'geometry item')
        mode_value = spec.get('type')
        if not isinstance(mode_value, str) or mode_value not in schemas:
            raise ValueError('Supported geometry: ' + ', '.join(schemas))
        mode = mode_value
        _model_fields(spec, ('type',) + schemas[mode], ('name', 'construction', 'fixed'))
        name: str | None = None
        if 'name' in spec:
            if not isinstance(spec['name'], str) or not spec['name'] or spec['name'] in names:
                raise ValueError('Geometry names must be nonempty and unique within the command')
            name = spec['name']
            names.add(name)
        if mode == 'point' and 'construction' in spec:
            raise ValueError('Points do not support construction mode')
        points: list[JsonValue] = []
        if mode == 'spline':
            raw_points = spec['points']
            if not isinstance(raw_points, list) or len(raw_points) < 2:
                raise ValueError('Fitted spline requires at least two points')
            points = raw_points
        if mode == 'bezier':
            raw_points = spec['controlPoints']
            if not isinstance(raw_points, list) or len(raw_points) != 4:
                raise ValueError('Cubic Bezier requires exactly four controlPoints')
            if spec.get('fixed') is False:
                raise ValueError('Bezier is an intrinsically fixed noneditable reference curve; fixed:false is not supported')
            points = raw_points
        construction = _geometry_model_cast(bool, spec['construction']) if 'construction' in spec else None
        fixed = _geometry_model_cast(bool, spec['fixed']) if 'fixed' in spec else None
        validated_specs.append((mode, spec, points, name, construction, fixed))
    created_entities: list["JsonValue"] = []
    named_refs: dict[str, "JsonValue"] = {}
    for mode, spec, points, name, construction, fixed in validated_specs:
        curves = sketch.sketchCurves
        if mode == 'point':
            made = [sketch.sketchPoints.add(ctx.point(spec['point']))]
        elif mode == 'line':
            made = [curves.sketchLines.addByTwoPoints(ctx.point(spec['start']), ctx.point(spec['end']))]
        elif mode == 'circle':
            made = [curves.sketchCircles.addByCenterRadius(ctx.point(spec['center']), ctx.length(spec['radius']))]
        elif mode == 'arc':
            made = [curves.sketchArcs.addByCenterStartSweep(ctx.point(spec['center']), ctx.point(spec['start']), ctx.angle(spec['sweep']))]
        elif mode == 'arc3':
            made = [curves.sketchArcs.addByThreePoints(ctx.point(spec['start']), ctx.point(spec['through']), ctx.point(spec['end']))]
        elif mode == 'rectangle':
            made = _model_items(curves.sketchLines.addTwoPointRectangle(ctx.point(spec['start']), ctx.point(spec['end'])))
        elif mode == 'bezier':
            nurbs = _model_ok(_geometry_model_core.NurbsCurve3D.createNonRational(
                [ctx.point(point) for point in points], 3,
                [0, 0, 0, 0, 1, 1, 1, 1], False), 'create cubic Bezier')
            made = [curves.sketchFixedSplines.addByNurbsCurve(nurbs)]
        else:
            made = [curves.sketchFittedSplines.add(ctx.collection([ctx.point(point) for point in points]))]
        for entity in made:
            _model_ok(entity, 'sketch ' + mode)
            if construction is not None:
                curve = _geometry_model_cast("adsk.fusion.SketchCurve", entity)
                curve.isConstruction = construction
            if fixed is not None and mode != 'bezier':
                sketch_entity = _geometry_model_cast("adsk.fusion.SketchEntity", entity)
                sketch_entity.isFixed = fixed
        refs = [_model_created(ctx, entity) for entity in made]
        created_entities.extend(refs)
        if name is not None:
            named_refs[name] = refs if len(refs) > 1 else refs[0]
    return {'entities': created_entities, 'refs': named_refs}


def model_sketch_constrain(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    _model_fields(data, ('sketch', 'type', 'entities'))
    sketch = ctx.resolve(data['sketch'], 'sketch')
    methods = {'coincident': ('addCoincident', 2), 'collinear': ('addCollinear', 2),
               'concentric': ('addConcentric', 2), 'midpoint': ('addMidPoint', 2),
               'parallel': ('addParallel', 2), 'perpendicular': ('addPerpendicular2', 2),
               'horizontal': ('addHorizontal', 1), 'vertical': ('addVertical', 1),
               'horizontalPoints': ('addHorizontalPoints', 2), 'verticalPoints': ('addVerticalPoints', 2),
               'tangent': ('addTangent', 2), 'smooth': ('addSmooth', 2),
               'equal': ('addEqual', 2), 'symmetry': ('addSymmetry', 3)}
    constraint_type = data['type']
    if not isinstance(constraint_type, str) or constraint_type not in methods:
        raise ValueError('Supported constraints: ' + ', '.join(methods))
    method, count = methods[constraint_type]
    entities = _model_sketch_entities(ctx, data['entities'], sketch)
    if len(entities) != count:
        raise ValueError('%s requires %d entities' % (constraint_type, count))
    adder = _geometry_model_cast(
        _GeometryModelConstraintAdder, getattr(sketch.geometricConstraints, method))
    return {'constraint': _model_created(ctx, adder(*entities))}


def model_sketch_dimension(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    _model_fields(data, ('sketch', 'type', 'entities', 'text'), ('expression', 'driving', 'orientation'))
    sketch = ctx.resolve(data['sketch'], 'sketch')
    mode_value = data['type']
    if not isinstance(mode_value, str):
        raise ValueError('Sketch dimension type must be text')
    mode = mode_value
    counts = {'distance': 2, 'angle': 2, 'radius': 1, 'diameter': 1}
    entities = _model_sketch_entities(ctx, data['entities'], sketch)
    if mode not in counts or len(entities) != counts[mode]:
        raise ValueError('distance/angle require two entities; radius/diameter require one curve')
    driving = _geometry_model_cast(bool, data.get('driving', True))
    if driving and 'expression' not in data:
        raise ValueError('Driving dimensions require expression')
    if not driving and 'expression' in data:
        raise ValueError('Driven dimensions cannot accept expression')
    if mode != 'distance' and 'orientation' in data:
        raise ValueError('orientation is only supported for distance dimensions')
    expression: str | None = None
    if 'expression' in data:
        expression_value = data['expression']
        (ctx.angle if mode == 'angle' else ctx.length)(expression_value)
        expression = _geometry_model_cast(str, expression_value)
    text_point = ctx.point(data['text'])
    dimension_collection = sketch.sketchDimensions
    if mode == 'distance':
        points: list["adsk.fusion.SketchPoint"] = []
        point_caster = _geometry_model_cast(
            _GeometryModelSketchPointCaster, _geometry_model_fusion.SketchPoint)
        for entity in entities:
            point = point_caster.cast(entity)
            if point is None:
                raise ValueError('Distance dimensions require sketch-point references')
            points.append(point)
        orientation = _geometry_model_cast("adsk.fusion.DimensionOrientations", _model_enum(
            _geometry_model_fusion.DimensionOrientations, data.get('orientation', 'aligned'), {
            'aligned': 'AlignedDimensionOrientation', 'horizontal': 'HorizontalDimensionOrientation',
            'vertical': 'VerticalDimensionOrientation'}))
        dimension = _model_ok(dimension_collection.addDistanceDimension(
            points[0], points[1], orientation, text_point, driving), 'addDistanceDimension')
    elif mode == 'angle':
        lines: list["adsk.fusion.SketchLine"] = []
        line_caster = _geometry_model_cast(
            _GeometryModelSketchLineCaster, _geometry_model_fusion.SketchLine)
        for entity in entities:
            line = line_caster.cast(entity)
            if line is None:
                raise ValueError('Angular dimensions require sketch-line references')
            lines.append(line)
        dimension = _model_ok(dimension_collection.addAngularDimension(
            lines[0], lines[1], text_point, driving), 'addAngularDimension')
    else:
        curves: list["adsk.fusion.SketchCurve"] = []
        curve_caster = _geometry_model_cast(
            _GeometryModelSketchCurveCaster, _geometry_model_fusion.SketchCurve)
        for entity in entities:
            curve = curve_caster.cast(entity)
            if curve is None:
                raise ValueError('Radius and diameter dimensions require sketch-curve references')
            curves.append(curve)
        if mode == 'radius':
            dimension = _model_ok(dimension_collection.addRadialDimension(
                curves[0], text_point, driving), 'addRadialDimension')
        else:
            dimension = _model_ok(dimension_collection.addDiameterDimension(
                curves[0], text_point, driving), 'addDiameterDimension')
    if driving:
        dimension.parameter.expression = _geometry_model_cast(str, expression)
    parameter = _geometry_model_cast(_GeometryModelDimensionParameter, dimension.parameter)
    return {'dimension': _model_created(ctx, dimension), 'parameter': parameter.name,
            'expression': parameter.expression}


def model_sketch_project(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    _model_fields(data, ('sketch', 'entities'), ('linked',))
    sketch = ctx.resolve(data['sketch'], 'sketch')
    entities = list(_model_entities(ctx, data['entities']))
    linked = _geometry_model_cast(bool, data.get('linked', True))
    return _model_geometry_result(ctx, sketch.project2(entities, linked))


def model_sketch_offset(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    _model_fields(data, ('sketch', 'entities', 'distance'))
    sketch = ctx.resolve(data['sketch'], 'sketch')
    constraints = sketch.geometricConstraints
    curves: list["adsk.fusion.SketchCurve"] = []
    curve_caster = _geometry_model_cast(
        _GeometryModelSketchCurveCaster, _geometry_model_fusion.SketchCurve)
    for entity in _model_sketch_entities(ctx, data['entities'], sketch):
        curve = curve_caster.cast(entity)
        if curve is None:
            raise ValueError('Offset entities must be sketch curves')
        curves.append(curve)
    inp = _model_ok(constraints.createOffsetInput(curves, ctx.value(data['distance'])), 'createOffsetInput')
    constraint = _model_ok(constraints.addOffset2(inp), 'addOffset2')
    offset_parameter = None
    dimension_value: object | None = getattr(constraint, 'dimension', None)
    if dimension_value is not None:
        dimension = _geometry_model_cast(_GeometryModelOffsetDimension, dimension_value)
        if dimension.parameter is not None:
            offset_parameter = dimension.parameter.name
    return {'constraint': _model_created(ctx, constraint), 'offsetParameter': offset_parameter,
            **_model_geometry_result(ctx, list(constraint.childCurves))}


def model_sketch_mirror(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    _model_fields(data, ('sketch', 'entities', 'line'))
    sketch = ctx.resolve(data['sketch'], 'sketch')
    entities = _model_sketch_entities(ctx, data['entities'], sketch)
    line_entity = _model_sketch_entities(ctx, [data['line']], sketch)[0]
    line = _geometry_model_cast(
        _GeometryModelSketchLineCaster, _geometry_model_fusion.SketchLine).cast(line_entity)
    if line is None:
        raise ValueError('Mirror axis must be a sketch line')
    point_caster = _geometry_model_cast(
        _GeometryModelSketchPointCaster, _geometry_model_fusion.SketchPoint)
    line_caster = _geometry_model_cast(
        _GeometryModelSketchLineCaster, _geometry_model_fusion.SketchLine)
    circle_caster = _geometry_model_cast(
        _GeometryModelSketchCircleCaster, _geometry_model_fusion.SketchCircle)
    arc_caster = _geometry_model_cast(
        _GeometryModelSketchArcCaster, _geometry_model_fusion.SketchArc)
    if any(not (line_caster.cast(entity) or circle_caster.cast(entity)
                or arc_caster.cast(entity) or point_caster.cast(entity)) for entity in entities):
        raise ValueError('Sketch mirror supports points, lines, circles, and arcs only')
    a, b = line.startSketchPoint.geometry, line.endSketchPoint.geometry
    dx, dy = b.x - a.x, b.y - a.y
    norm = dx * dx + dy * dy
    if norm == 0 or abs(a.z) > 1e-7 or abs(b.z) > 1e-7:
        raise ValueError('Mirror axis must be a nonzero line in the sketch XY plane')

    def reflected(point: "adsk.core.Point3D") -> "adsk.core.Point3D":
        if abs(point.z) > 1e-7:
            raise ValueError('Sketch mirror supports planar XY geometry only')
        t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / norm
        mirrored = _geometry_model_core.Point3D.create(2 * (a.x + t * dx) - point.x,
                                                        2 * (a.y + t * dy) - point.y, 0)
        if mirrored is None:
            raise ValueError('Fusion could not create mirrored sketch geometry')
        return mirrored

    # Rebuild primitive geometry, then constrain symmetry rather than relying on
    # an unsupported negative-determinant sketch copy transform.
    prepared: list[tuple[str, tuple[object, ...], bool]] = []
    for entity in entities:
        point = point_caster.cast(entity)
        if point is not None:
            prepared.append(('point', (reflected(point.geometry),), False))
            continue
        source_line = line_caster.cast(entity)
        if source_line is not None:
            construction = _geometry_model_cast(_GeometryModelSketchCurveConstruction, source_line).isConstruction
            prepared.append(('line', (reflected(source_line.startSketchPoint.geometry),
                                      reflected(source_line.endSketchPoint.geometry)), construction))
            continue
        circle = circle_caster.cast(entity)
        if circle is not None:
            construction = _geometry_model_cast(_GeometryModelSketchCurveConstruction, circle).isConstruction
            prepared.append(('circle', (reflected(circle.centerSketchPoint.geometry), circle.radius), construction))
        else:
            arc = arc_caster.cast(entity)
            if arc is None:
                raise ValueError('Sketch mirror supports points, lines, circles, and arcs only')
            construction = _geometry_model_cast(_GeometryModelSketchCurveConstruction, arc).isConstruction
            prepared.append(('arc', (reflected(arc.centerSketchPoint.geometry),
                                     reflected(arc.endSketchPoint.geometry),
                                     reflected(arc.startSketchPoint.geometry)), construction))
    made: list["adsk.fusion.SketchEntity"] = []
    constraints: list["JsonValue"] = []
    curves = sketch.sketchCurves
    for entity, (mode, args, construction) in zip(entities, prepared):
        if mode == 'point':
            point_args = _geometry_model_cast("tuple[adsk.core.Point3D]", args)
            new = sketch.sketchPoints.add(point_args[0])
        elif mode == 'line':
            line_args = _geometry_model_cast("tuple[adsk.core.Point3D, adsk.core.Point3D]", args)
            new = curves.sketchLines.addByTwoPoints(line_args[0], line_args[1])
        elif mode == 'circle':
            circle_args = _geometry_model_cast("tuple[adsk.core.Point3D, float]", args)
            new = curves.sketchCircles.addByCenterRadius(circle_args[0], circle_args[1])
        else:
            arc_args = _geometry_model_cast("tuple[adsk.core.Point3D, adsk.core.Point3D, adsk.core.Point3D]", args)
            new = curves.sketchArcs.addByCenterStartEnd(arc_args[0], arc_args[1], arc_args[2])
        _model_ok(new, 'mirrored ' + mode)
        if mode != 'point':
            _geometry_model_cast(_GeometryModelSketchCurveConstruction, new).isConstruction = construction
        made.append(new)
        constraints.append(_model_created(ctx, sketch.geometricConstraints.addSymmetry(entity, new, line)))
    return {**_model_geometry_result(ctx, made), 'constraints': constraints}


def model_sketch_pattern(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    _model_fields(data, ('sketch', 'type', 'entities', 'quantity'),
                  ('center', 'angle', 'direction', 'distance', 'distanceType', 'quantityTwo', 'distanceTwo', 'directionTwo'))
    sketch = ctx.resolve(data['sketch'], 'sketch')
    entities = _model_sketch_entities(ctx, data['entities'], sketch)
    constraints = sketch.geometricConstraints
    quantity = _model_quantity(ctx, data['quantity'])
    if data['type'] == 'circular':
        _model_fields(data, ('sketch', 'type', 'entities', 'quantity', 'center'), ('angle',))
        center_entity = _model_sketch_entities(ctx, [data['center']], sketch)[0]
        center = _geometry_model_cast(
            _GeometryModelSketchPointCaster, _geometry_model_fusion.SketchPoint).cast(center_entity)
        if center is None:
            raise ValueError('Circular sketch patterns require a sketch-point center')
        inp = constraints.createCircularPatternInput(list(entities), center)
        inp.quantity = quantity
        inp.totalAngle = ctx.value(data.get('angle', '360 deg'))
        result = constraints.addCircularPattern(inp)
    elif data['type'] == 'rectangular':
        _model_fields(data, ('sketch', 'type', 'entities', 'quantity', 'distance'),
                      ('direction', 'distanceType', 'quantityTwo', 'distanceTwo', 'directionTwo'))
        if ('quantityTwo' in data) != ('distanceTwo' in data) or ('directionTwo' in data and 'quantityTwo' not in data):
            raise ValueError('Second direction requires quantityTwo and distanceTwo')
        inp = constraints.createRectangularPatternInput(list(entities), _model_distance_type(data))
        rectangular_input = _geometry_model_cast(_GeometryModelRectangularPatternInput, inp)
        direction: "adsk.fusion.SketchLine | None" = None
        if 'direction' in data:
            direction_entity = _model_sketch_entities(ctx, [data['direction']], sketch)[0]
            direction = _geometry_model_cast(
                _GeometryModelSketchLineCaster, _geometry_model_fusion.SketchLine).cast(direction_entity)
            if direction is None:
                raise ValueError('Rectangular sketch patterns require sketch-line directions')
        _model_ok(rectangular_input.setDirectionOne(direction, quantity, ctx.value(data['distance'])), 'setDirectionOne')
        if 'quantityTwo' in data:
            direction = None
            if 'directionTwo' in data:
                direction_entity = _model_sketch_entities(ctx, [data['directionTwo']], sketch)[0]
                direction = _geometry_model_cast(
                    _GeometryModelSketchLineCaster, _geometry_model_fusion.SketchLine).cast(direction_entity)
                if direction is None:
                    raise ValueError('Rectangular sketch patterns require sketch-line directions')
            _model_ok(rectangular_input.setDirectionTwo(
                direction, _model_quantity(ctx, data['quantityTwo']), ctx.value(data['distanceTwo'])), 'setDirectionTwo')
        result = constraints.addRectangularPattern(inp)
    else:
        raise ValueError('Sketch pattern type must be circular or rectangular')
    return {'constraint': _model_created(ctx, result)}


def _model_add_feature(collection: object, mode: str, feature_input: object) -> "adsk.fusion.Feature":
    if mode == 'extrude':
        return _model_ok(_geometry_model_cast("adsk.fusion.ExtrudeFeatures", collection).add(
            _geometry_model_cast("adsk.fusion.ExtrudeFeatureInput", feature_input)), mode)
    if mode == 'revolve':
        return _model_ok(_geometry_model_cast("adsk.fusion.RevolveFeatures", collection).add(
            _geometry_model_cast("adsk.fusion.RevolveFeatureInput", feature_input)), mode)
    if mode == 'sweep':
        return _model_ok(_geometry_model_cast("adsk.fusion.SweepFeatures", collection).add(
            _geometry_model_cast("adsk.fusion.SweepFeatureInput", feature_input)), mode)
    if mode == 'loft':
        return _model_ok(_geometry_model_cast("adsk.fusion.LoftFeatures", collection).add(
            _geometry_model_cast("adsk.fusion.LoftFeatureInput", feature_input)), mode)
    if mode == 'hole':
        return _model_ok(_geometry_model_cast("adsk.fusion.HoleFeatures", collection).add(
            _geometry_model_cast("adsk.fusion.HoleFeatureInput", feature_input)), mode)
    if mode == 'shell':
        return _model_ok(_geometry_model_cast("adsk.fusion.ShellFeatures", collection).add(
            _geometry_model_cast("adsk.fusion.ShellFeatureInput", feature_input)), mode)
    if mode == 'thicken':
        return _model_ok(_geometry_model_cast("adsk.fusion.ThickenFeatures", collection).add(
            _geometry_model_cast("adsk.fusion.ThickenFeatureInput", feature_input)), mode)
    if mode == 'combine':
        return _model_ok(_geometry_model_cast("adsk.fusion.CombineFeatures", collection).add(
            _geometry_model_cast("adsk.fusion.CombineFeatureInput", feature_input)), mode)
    if mode == 'split':
        return _model_ok(_geometry_model_cast("adsk.fusion.SplitBodyFeatures", collection).add(
            _geometry_model_cast("adsk.fusion.SplitBodyFeatureInput", feature_input)), mode)
    if mode == 'fillet':
        return _model_ok(_geometry_model_cast("adsk.fusion.FilletFeatures", collection).add(
            _geometry_model_cast("adsk.fusion.FilletFeatureInput", feature_input)), mode)
    if mode == 'chamfer':
        return _model_ok(_geometry_model_cast("adsk.fusion.ChamferFeatures", collection).add(
            _geometry_model_cast("adsk.fusion.ChamferFeatureInput", feature_input)), mode)
    if mode == 'draft':
        return _model_ok(_geometry_model_cast("adsk.fusion.DraftFeatures", collection).add(
            _geometry_model_cast("adsk.fusion.DraftFeatureInput", feature_input)), mode)
    if mode == 'thread':
        return _model_ok(_geometry_model_cast("adsk.fusion.ThreadFeatures", collection).add(
            _geometry_model_cast("adsk.fusion.ThreadFeatureInput", feature_input)), mode)
    if mode == 'mirror':
        return _model_ok(_geometry_model_cast("adsk.fusion.MirrorFeatures", collection).add(
            _geometry_model_cast("adsk.fusion.MirrorFeatureInput", feature_input)), mode)
    if mode == 'circular':
        return _model_ok(_geometry_model_cast("adsk.fusion.CircularPatternFeatures", collection).add(
            _geometry_model_cast("adsk.fusion.CircularPatternFeatureInput", feature_input)), mode)
    if mode == 'rectangular':
        return _model_ok(_geometry_model_cast("adsk.fusion.RectangularPatternFeatures", collection).add(
            _geometry_model_cast("adsk.fusion.RectangularPatternFeatureInput", feature_input)), mode)
    return _model_ok(_geometry_model_cast("adsk.fusion.PathPatternFeatures", collection).add(
        _geometry_model_cast("adsk.fusion.PathPatternFeatureInput", feature_input)), mode)


@_cad_scoped_step('model', native_only=True)
def model_feature(ctx: "CadContext", data: "JsonObject", mode: str) -> "JsonValue":
    surface_variant = mode in ('loft', 'sweep', 'revolve') and data.get('solid') is False
    if surface_variant:
        preflight = _geometry_model_cast(_GeometryModelSurfacePreflight, _surface_model_preflight)
        blocked = preflight(ctx, data, mode)
        if blocked is not None:
            return blocked
    schemas = {
        'extrude': ((), ('profile', 'profiles', 'extent', 'distance', 'target', 'offset', 'startOffset', 'symmetric', 'direction', 'taper')),
        'revolve': (('profile', 'axis', 'angle'), ('symmetric',)),
        'sweep': (('profile', 'path'), ('twist', 'taper', 'orientation', 'guideRail')),
        'loft': (('profiles',), ('closed', 'rails', 'centerLine')),
        'hole': (('points', 'diameter'), ('extent', 'depth', 'target', 'type', 'boreDiameter', 'boreDepth', 'sinkDiameter', 'sinkAngle', 'reverse')),
        'shell': (('entities', 'thickness'), ('outsideThickness', 'tangentChain')),
        'thicken': (('entities', 'thickness'), ('symmetric', 'tangentChain')),
        'combine': (('target', 'tools', 'operation'), ('keepTools',)),
        'split': (('bodies', 'tool'), ('extend',)),
        'fillet': (('radius',), ('edges', 'query', 'tangentChain')),
        'chamfer': (('distance',), ('edges', 'query', 'tangentChain')),
        'draft': (('faces', 'plane', 'angle'), ('symmetric', 'reverse', 'tangentChain')),
        'thread': (('faces', 'internal', 'threadType', 'designation', 'class'), ('modeled', 'rightHanded', 'length', 'offset')),
        'mirror': (('entities', 'plane'), ()),
        'circular': (('entities', 'axis', 'quantity'), ('angle', 'symmetric')),
        'rectangular': (('entities', 'direction', 'quantity', 'distance'), ('distanceType', 'directionTwo', 'quantityTwo', 'distanceTwo')),
        'path': (('entities', 'path', 'quantity', 'distance'), ('distanceType',)),
    }
    required, optional = schemas[mode]
    if surface_variant:
        optional += ('schemaVersion', 'frame', 'representation', 'onExisting', 'protected') + (('endConditions',) if mode == 'loft' else ())
    operation_modes = ('extrude', 'revolve', 'sweep', 'loft', 'thicken')
    if mode in operation_modes:
        optional += ('operation', 'solid', 'participants') if mode != 'thicken' else ('operation',)
    if mode == 'hole':
        optional += ('participants',)
    _model_fields(data, required, optional + ('name',))
    extrude_profiles: list["CadEntity"] = []
    multi_profile_extrude = False
    if mode == 'extrude':
        has_profile, has_profiles = 'profile' in data, 'profiles' in data
        if has_profile == has_profiles:
            raise ValueError('Supply exactly one of profile or profiles for model.extrude')
        multi_profile_extrude = has_profiles
        if has_profiles:
            profile_refs_value = data['profiles']
            if not isinstance(profile_refs_value, list) or not profile_refs_value:
                raise ValueError('profiles must be a nonempty array of profile references')
            profile_refs = profile_refs_value
            extrude_profiles = [_model_resolve(ctx, ref) for ref in profile_refs]
            for index, profile in enumerate(extrude_profiles):
                if getattr(profile, 'assemblyContext', None) is not None or _cad_owner(profile) != ctx.component:
                    raise ValueError('Every extrude profile must be native geometry owned by the selected component')
                if any(profile == other for other in extrude_profiles[:index]):
                    raise ValueError('profiles must contain distinct profile references')
            planes = [_model_extrude_profile_plane(profile) for profile in extrude_profiles]
            if any(not planes[0].isCoPlanarTo(plane) for plane in planes[1:]):
                raise ValueError('All profiles in a multi-profile extrusion must be co-planar')
        else:
            if isinstance(data['profile'], (list, tuple)):
                raise ValueError('profile accepts one reference; use profiles for a collection')
            extrude_profiles = [_model_resolve(ctx, data['profile'])]
    resolved_query: "JsonObject | None" = None
    selected_edges: list["CadEntity"] | None = None
    if mode in ('fillet', 'chamfer'):
        if ('edges' in data) == ('query' in data):
            raise ValueError('Supply exactly one of edges or query')
        dimension = 'radius' if mode == 'fillet' else 'distance'
        if ctx.length(data[dimension]) <= 0:
            raise ValueError(dimension + ' must be a positive length')
        if 'query' in data:
            if not isinstance(data['query'], dict):
                raise ValueError('query must be an object')
            query = _model_json_object(data['query'], 'query')
            if query.get('kind', 'edge') != 'edge':
                raise ValueError('Fillet/chamfer query kind must be edge')
            query['kind'] = 'edge'
            if 'expect' not in query and not query.get('unique'):
                raise ValueError('Modeling query requires expect or unique:true')
            selected_edges, resolved_query = _entity_query(ctx, query)
            if not resolved_query['success'] or not selected_edges:
                raise ValueError('Modeling query did not select an accepted nonempty set: ' + json.dumps(resolved_query))
            for edge in selected_edges:
                if getattr(edge, 'assemblyContext', None) is not None or _cad_owner(edge) != ctx.component:
                    raise ValueError('Modeling requires native input geometry in the selected component; cross-occurrence creation is unsupported')
    extent_mode: str = 'distance'
    if mode in ('extrude', 'hole'):
        extent_value = data.get('extent', 'distance')
        if not isinstance(extent_value, str) or extent_value not in ('distance', 'throughAll', 'toEntity'):
            raise ValueError('extent must be distance, throughAll, or toEntity')
        extent_mode = extent_value
        distance_key = 'distance' if mode == 'extrude' else 'depth'
        if (distance_key in data) != (extent_mode == 'distance'):
            raise ValueError(distance_key + ' is required only for distance extent')
        if ('target' in data) != (extent_mode == 'toEntity'):
            raise ValueError('target is required only for toEntity extent')
        if 'offset' in data and extent_mode != 'toEntity':
            raise ValueError('offset requires toEntity extent')
        if mode == 'extrude' and data.get('symmetric', False):
            if extent_mode != 'distance' or 'direction' in data or 'startOffset' in data:
                raise ValueError('Symmetric extrude requires distance and cannot specify direction or startOffset')
        if mode == 'hole' and extent_mode == 'toEntity' and 'reverse' in data:
            raise ValueError('toEntity hole determines direction automatically; reverse is unsupported')
    if mode == 'sweep' and 'guideRail' in data and any(k in data for k in ('orientation', 'twist', 'taper')):
        raise ValueError('guideRail cannot combine with orientation, twist, or taper (ignored by Fusion)')
    if mode == 'loft' and 'rails' in data and 'centerLine' in data:
        raise ValueError('Loft accepts rails or centerLine, not both')
    # Validate dimensional compatibility, but retain the original expressions in ValueInput.
    if mode in ('extrude', 'hole', 'sweep'):
        for key in ('distance', 'depth', 'diameter', 'offset', 'startOffset', 'boreDiameter', 'boreDepth', 'sinkDiameter'):
            if key in data:
                ctx.length(data[key])
        for key in ('taper', 'twist', 'sinkAngle'):
            if key in data:
                ctx.angle(data[key])
    direction: "adsk.fusion.ExtentDirections | None" = None
    if mode == 'extrude':
        direction = _geometry_model_cast("adsk.fusion.ExtentDirections", _model_enum(
            _geometry_model_fusion.ExtentDirections, data.get('direction', 'positive'), {
                'positive': 'PositiveExtentDirection', 'negative': 'NegativeExtentDirection'}))
    orientation: "adsk.fusion.SweepOrientationTypes | None" = None
    if mode == 'sweep' and 'orientation' in data:
        orientation = _geometry_model_cast("adsk.fusion.SweepOrientationTypes", _model_enum(
            _geometry_model_fusion.SweepOrientationTypes, data['orientation'], {
                'perpendicular': 'PerpendicularOrientationType', 'parallel': 'ParallelOrientationType'}))
    # This command surface deliberately excludes cross-occurrence creation.
    # Reject foreign/proxy inputs before Fusion can interpret them in the wrong frame.
    refs: list["JsonValue"] = []
    for key in ('profile', 'axis', 'target', 'tool', 'plane') + (('direction', 'directionTwo') if mode == 'rectangular' else ()):
        if key in data:
            refs.append(data[key])
    for key in ('profiles', 'points', 'entities', 'tools', 'bodies', 'edges', 'faces', 'participants'):
        if key in data:
            value = data[key]
            if not isinstance(value, list) or not value:
                raise ValueError(key + ' must be a nonempty reference array')
            refs.extend(value)
    guides: list["JsonValue"] = []
    if 'rails' in data:
        if not isinstance(data['rails'], list) or not data['rails']:
            raise ValueError('rails must be a nonempty array of curve refs or path descriptors')
        guides.extend(data['rails'])
    if 'centerLine' in data:
        guides.append(data['centerLine'])
    paths: list["JsonValue"] = [data[k] for k in ('path', 'guideRail') if k in data]
    for guide in guides:
        guide_object = _model_json_object_or_none(guide, 'guide')
        if guide_object is not None and ('curves' in guide_object or guide_object.get('kind') == 'path'):
            paths.append(guide_object)
        else:
            refs.append(guide)
    for path in paths:
        _model_fields(path, ('curves',), ('chain', 'kind', 'name'))
        path_data = _model_json_object(path, 'path')
        curve_refs = path_data['curves']
        if not isinstance(curve_refs, list) or not curve_refs:
            raise ValueError('Path curves must be a nonempty reference array')
        refs.extend(curve_refs)
    for ref in refs:
        entity = _model_resolve(ctx, ref)
        owner = _cad_owner(entity)
        if getattr(entity, 'assemblyContext', None) is not None or (owner is not None and owner != ctx.component):
            raise ValueError('Modeling requires native input geometry in the selected component; cross-occurrence creation is unsupported')
    features = ctx.component.features
    chain = _geometry_model_cast(bool, data.get('tangentChain', True))
    operation: "adsk.fusion.FeatureOperations | None" = None
    if mode in operation_modes or mode == 'combine':
        operation = _model_operation(data)
    participants: list["adsk.fusion.BRepBody"] | None = None
    if 'participants' in data:
        if mode != 'hole' and data.get('operation', 'newBody') not in ('cut', 'intersect'):
            raise ValueError('participants are supported only for cut/intersect or holes')
        participants = []
        body_caster = _geometry_model_cast(
            _GeometryModelBodyCaster, _geometry_model_fusion.BRepBody)
        for entity in _model_entities(ctx, data['participants'], kind='body'):
            body = body_caster.cast(entity)
            if body is None:
                raise ValueError('participants must reference bodies')
            participants.append(body)
        if mode == 'extrude' and multi_profile_extrude and any(
                _cad_owner(body) != ctx.component or getattr(body, 'assemblyContext', None) is not None
                for body in participants):
            raise ValueError('Extrude participants must be native bodies owned by the selected component')
    target: "CadEntity | None" = None
    if mode in ('extrude', 'hole') and extent_mode == 'toEntity':
        target = _model_resolve(ctx, data['target'])
        target_entity = target
        plane_caster = _geometry_model_cast(
            _GeometryModelConstructionPlaneCaster, _geometry_model_fusion.ConstructionPlane)
        face_caster = _geometry_model_cast(_GeometryModelFaceCaster, _geometry_model_fusion.BRepFace)
        supported = plane_caster.cast(target_entity) is not None or face_caster.cast(target_entity) is not None
        if mode == 'hole':
            body_caster = _geometry_model_cast(_GeometryModelBodyCaster, _geometry_model_fusion.BRepBody)
            vertex_caster = _geometry_model_cast(_GeometryModelVertexCaster, _geometry_model_fusion.BRepVertex)
            point_caster = _geometry_model_cast(
                _GeometryModelConstructionPointCaster, _geometry_model_fusion.ConstructionPoint)
            supported = (supported or body_caster.cast(target_entity) is not None
                         or vertex_caster.cast(target_entity) is not None
                         or point_caster.cast(target_entity) is not None)
        if not supported:
            raise ValueError('Unsupported toEntity target type')
    prepared_guides: list["CadEntity"] = []
    for guide in guides:
        guide_object = _model_json_object_or_none(guide, 'guide')
        if guide_object is not None and ('curves' in guide_object or guide_object.get('kind') == 'path'):
            prepared_guides.append(_model_path(ctx, guide_object))
        else:
            curve = _model_resolve(ctx, guide)
            curve_caster = _geometry_model_cast(
                _GeometryModelSketchCurveCaster, _geometry_model_fusion.SketchCurve)
            edge_caster = _geometry_model_cast(
                _GeometryModelBRepEdgeCaster, _geometry_model_fusion.BRepEdge)
            if curve_caster.cast(curve) is None and edge_caster.cast(curve) is None:
                raise ValueError('Loft guides require sketch curves, edges, or path descriptors')
            prepared_guides.append(curve)
    if mode == 'extrude':
        collection = features.extrudeFeatures
        profile_input = (ctx.collection(extrude_profiles) if multi_profile_extrude else
                         _geometry_model_cast("tuple[CadEntity, ...]", extrude_profiles)[0])
        inp = collection.createInput(profile_input, _geometry_model_cast(
            "adsk.fusion.FeatureOperations", operation))
        taper = ctx.value(data.get('taper', '0 deg'))
        if 'startOffset' in data:
            inp.startExtent = _model_ok(_geometry_model_fusion.OffsetStartDefinition.create(ctx.value(data['startOffset'])), 'OffsetStartDefinition.create')
        if _geometry_model_cast(bool, data.get('symmetric', False)):
            _model_ok(inp.setSymmetricExtent(ctx.value(data['distance']), True, taper), 'setSymmetricExtent')
        else:
            if extent_mode == 'distance':
                extent = _geometry_model_fusion.DistanceExtentDefinition.create(ctx.value(data['distance']))
            elif extent_mode == 'throughAll':
                extent = _geometry_model_fusion.ThroughAllExtentDefinition.create()
            else:
                extent = _geometry_model_fusion.ToEntityExtentDefinition.create(
                    _geometry_model_cast("CadEntity", target), False, ctx.value(data.get('offset', '0 mm')))
            _model_ok(extent, 'create extent')
            _model_ok(inp.setOneSideExtent(
                extent, _geometry_model_cast("adsk.fusion.ExtentDirections", direction), taper), 'setOneSideExtent')
    elif mode == 'revolve':
        collection = features.revolveFeatures
        inp = collection.createInput(_model_resolve(ctx, data['profile']), _model_resolve(ctx, data['axis']),
                                     _geometry_model_cast("adsk.fusion.FeatureOperations", operation))
        _model_ok(inp.setAngleExtent(_geometry_model_cast(bool, data.get('symmetric', False)),
                                     ctx.value(data['angle'])), 'setAngleExtent')
    elif mode == 'sweep':
        collection = features.sweepFeatures
        inp = collection.createInput(_model_resolve(ctx, data['profile']), _model_path(ctx, data['path']),
                                     _geometry_model_cast("adsk.fusion.FeatureOperations", operation))
        if orientation is not None:
            inp.orientation = orientation
        if 'guideRail' in data:
            inp.guideRail = _model_path(ctx, data['guideRail'])
        if 'twist' in data:
            inp.twistAngle = ctx.value(data['twist'])
        if 'taper' in data:
            inp.taperAngle = ctx.value(data['taper'])
    elif mode == 'loft':
        profiles = _model_entities(ctx, data['profiles'])
        if len(profiles) < 2:
            raise ValueError('Loft requires at least two explicitly selected sections')
        collection = features.loftFeatures
        inp = collection.createInput(_geometry_model_cast("adsk.fusion.FeatureOperations", operation))
        inp.isSolid = _geometry_model_cast(bool, data.get('solid', True))
        for profile in profiles:
            _model_ok(inp.loftSections.add(profile), 'loftSections.add')
        inp.isClosed = _geometry_model_cast(bool, data.get('closed', False))
        for guide in prepared_guides:
            if 'centerLine' in data:
                _model_ok(inp.centerLineOrRails.addCenterLine(guide), 'loft guide')
            else:
                _model_ok(inp.centerLineOrRails.addRail(guide), 'loft guide')
        if surface_variant:
            loft_conditions = _geometry_model_cast(
                _GeometryModelSurfaceLoftConditions, _surface_loft_conditions)
            loft_conditions(ctx, inp, data)
    elif mode == 'hole':
        collection = features.holeFeatures
        hole_type = _model_json_text(data.get('type', 'simple'), 'type')
        diameter = ctx.value(data['diameter'])
        extras = {'simple': (), 'counterbore': ('boreDiameter', 'boreDepth'), 'countersink': ('sinkDiameter', 'sinkAngle')}
        if hole_type not in extras:
            raise ValueError('Hole type must be simple, counterbore, or countersink')
        supplied = set(data) & {'boreDiameter', 'boreDepth', 'sinkDiameter', 'sinkAngle'}
        if supplied != set(extras[hole_type]):
            raise ValueError('Hole mode requires exactly these inputs: ' + ', '.join(extras[hole_type]))
        if hole_type == 'simple':
            inp = collection.createSimpleInput(diameter)
        elif hole_type == 'counterbore':
            inp = collection.createCounterboreInput(diameter, ctx.value(data['boreDiameter']),
                                                    ctx.value(data['boreDepth']))
        else:
            inp = collection.createCountersinkInput(diameter, ctx.value(data['sinkDiameter']),
                                                    ctx.value(data['sinkAngle']))
        points: list["adsk.fusion.SketchPoint"] = []
        sketch_point_caster = _geometry_model_cast(
            _GeometryModelSketchPointCaster, _geometry_model_fusion.SketchPoint)
        for entity in _model_entities(ctx, data['points']):
            sketch_point = sketch_point_caster.cast(entity)
            if sketch_point is None:
                raise ValueError('Hole position points must be sketch points')
            points.append(sketch_point)
        _model_ok(inp.setPositionBySketchPoints(ctx.collection(points)), 'setPositionBySketchPoints')
        if extent_mode == 'distance':
            _model_ok(inp.setDistanceExtent(ctx.value(data['depth'])), 'setDistanceExtent')
            inp.isDefaultDirection = not _geometry_model_cast(bool, data.get('reverse', False))
        elif extent_mode == 'throughAll':
            direction = _geometry_model_cast("adsk.fusion.ExtentDirections",
                _geometry_model_fusion.ExtentDirections.PositiveExtentDirection if _geometry_model_cast(bool, data.get('reverse', False))
                else _geometry_model_fusion.ExtentDirections.NegativeExtentDirection)
            _model_ok(inp.setAllExtent(direction), 'setAllExtent')
            # setAllExtent can change the input's default-direction flag. Keep
            # the same natural/reversed convention as distance holes explicitly.
            inp.isDefaultDirection = not _geometry_model_cast(bool, data.get('reverse', False))
        else:
            _model_ok(inp.setOneSideToExtent(_geometry_model_cast("CadEntity", target), False),
                      'setOneSideToExtent')
    elif mode == 'shell':
        collection = features.shellFeatures
        inp = collection.createInput(ctx.collection(_model_entities(ctx, data['entities'])), chain)
        inp.insideThickness = ctx.value(data['thickness'])
        if 'outsideThickness' in data:
            inp.outsideThickness = ctx.value(data['outsideThickness'])
    elif mode == 'thicken':
        collection = features.thickenFeatures
        inp = collection.createInput(ctx.collection(_model_entities(ctx, data['entities'])),
                                     ctx.value(data['thickness']),
                                     _geometry_model_cast(bool, data.get('symmetric', False)),
                                     _geometry_model_cast("adsk.fusion.FeatureOperations", operation), chain)
    elif mode == 'combine':
        if data['operation'] == 'newBody':
            raise ValueError('Combine supports join, cut, or intersect only')
        collection = features.combineFeatures
        inp = collection.createInput(ctx.resolve(data['target'], 'body'), ctx.collection(_model_entities(ctx, data['tools'], kind='body')))
        inp.operation = _geometry_model_cast("adsk.fusion.FeatureOperations", operation)
        inp.isKeepToolBodies = _geometry_model_cast(bool, data.get('keepTools', True))
    elif mode == 'split':
        collection = features.splitBodyFeatures
        inp = collection.createInput(ctx.collection(_model_entities(ctx, data['bodies'], kind='body')),
                                     _model_resolve(ctx, data['tool']),
                                     _geometry_model_cast(bool, data.get('extend', True)))
    elif mode == 'fillet':
        collection = features.filletFeatures
        inp = collection.createInput()
        _model_ok(inp.edgeSetInputs.addConstantRadiusEdgeSet(ctx.collection(selected_edges if selected_edges is not None else _model_entities(ctx, data['edges'])), ctx.value(data['radius']), chain), 'addConstantRadiusEdgeSet')
    elif mode == 'chamfer':
        collection = features.chamferFeatures
        inp = collection.createInput2()
        _model_ok(inp.chamferEdgeSets.addEqualDistanceChamferEdgeSet(ctx.collection(selected_edges if selected_edges is not None else _model_entities(ctx, data['edges'])), ctx.value(data['distance']), chain), 'addEqualDistanceChamferEdgeSet')
    elif mode == 'draft':
        collection = features.draftFeatures
        faces: list["adsk.fusion.BRepFace"] = []
        face_caster = _geometry_model_cast(_GeometryModelFaceCaster, _geometry_model_fusion.BRepFace)
        for entity in _model_entities(ctx, data['faces'], kind='face'):
            face = face_caster.cast(entity)
            if face is None:
                raise ValueError('Draft faces must reference BRepFace entities')
            faces.append(face)
        inp = collection.createInput(faces, _model_resolve(ctx, data['plane']), chain)
        _model_ok(inp.setSingleAngle(_geometry_model_cast(bool, data.get('symmetric', False)),
                                     ctx.value(data['angle'])), 'setSingleAngle')
        inp.isDirectionFlipped = _geometry_model_cast(bool, data.get('reverse', False))
    elif mode == 'thread':
        if 'offset' in data and 'length' not in data:
            raise ValueError('Thread offset requires a partial thread length')
        collection = features.threadFeatures
        info = _model_ok(_geometry_model_fusion.ThreadInfo.create(
            False, _geometry_model_cast(bool, data['internal']),
            _model_json_text(data['threadType'], 'threadType'),
            _model_json_text(data['designation'], 'designation'),
            _model_json_text(data['class'], 'class'),
            _geometry_model_cast(bool, data.get('rightHanded', True))), 'ThreadInfo.create')
        inp = collection.createInput(ctx.collection(_model_entities(ctx, data['faces'], kind='face')), info)
        inp.isModeled = _geometry_model_cast(bool, data.get('modeled', False))
        inp.isFullLength = 'length' not in data
        if 'length' in data:
            inp.threadLength = ctx.value(data['length'])
            inp.threadOffset = ctx.value(data.get('offset', '0 mm'))
    else:
        entities = _model_entities(ctx, data['entities'])
        # Pattern and mirror API inputs must be homogeneous.
        types = {('Feature' if e.objectType.endswith('Feature') else e.objectType.split('::')[-1]) for e in entities}
        if len(types) != 1:
            raise ValueError('Pattern/mirror entities must have the same API type')
        if next(iter(types)) in ('ConstructionPlane', 'ConstructionAxis', 'ConstructionPoint') and len(entities) != 1:
            raise ValueError('Pattern/mirror accepts only one construction entity')
        entities = ctx.collection(entities)
        if mode == 'mirror':
            collection = features.mirrorFeatures
            inp = collection.createInput(entities, _model_resolve(ctx, data['plane']))
        elif mode == 'circular':
            collection = features.circularPatternFeatures
            inp = collection.createInput(entities, _model_resolve(ctx, data['axis']))
            inp.quantity = _model_quantity(ctx, data['quantity'])
            inp.totalAngle = ctx.value(data.get('angle', '360 deg'))
            inp.isSymmetric = _geometry_model_cast(bool, data.get('symmetric', False))
        elif mode == 'rectangular':
            if ('quantityTwo' in data or 'distanceTwo' in data or 'directionTwo' in data) and not all(k in data for k in ('quantityTwo', 'distanceTwo', 'directionTwo')):
                raise ValueError('Second direction requires directionTwo, quantityTwo, and distanceTwo')
            collection = features.rectangularPatternFeatures
            inp = collection.createInput(entities, _model_resolve(ctx, data['direction']), _model_quantity(ctx, data['quantity']), ctx.value(data['distance']), _model_distance_type(data))
            if 'quantityTwo' in data:
                inp.directionTwoEntity = _model_resolve(ctx, data['directionTwo'])
                inp.quantityTwo = _model_quantity(ctx, data['quantityTwo'])
                inp.distanceTwo = ctx.value(data['distanceTwo'])
        else:
            collection = features.pathPatternFeatures
            inp = collection.createInput(entities, _model_path(ctx, data['path']), _model_quantity(ctx, data['quantity']), ctx.value(data['distance']), _model_distance_type(data))
    if mode in ('extrude', 'revolve', 'sweep', 'loft'):
        _geometry_model_cast(_GeometryModelSolidFeatureInput, inp).isSolid = _geometry_model_cast(
            bool, data.get('solid', True))
    if participants is not None:
        _geometry_model_cast(_GeometryModelParticipantsFeatureInput, inp).participantBodies = participants
    if resolved_query is not None:
        ctx.assert_identity()
    feature = _model_add_feature(collection, mode, inp)
    reference = _model_created(ctx, feature, data.get('name'))
    health_state = _geometry_model_cast(int, feature.healthState)
    if multi_profile_extrude and health_state != _geometry_model_fusion.FeatureHealthStates.HealthyFeatureHealthState:
        raise RuntimeError('%s created a non-healthy multi-profile feature %s (healthState=%s): %s; inspect partial changes' %
                           (mode, feature.name, feature.healthState, feature.errorOrWarningMessage))
    if health_state == _geometry_model_fusion.FeatureHealthStates.ErrorFeatureHealthState:
        raise RuntimeError('%s created an unhealthy feature %s: %s; inspect partial changes' %
                           (mode, feature.name, feature.errorOrWarningMessage))
    body_refs = [ctx.ref(body) for body in _model_items(feature.bodies)]
    result: "JsonObject" = {'feature': reference, 'bodies': body_refs,
                             'healthState': int(health_state), 'message': feature.errorOrWarningMessage}
    if multi_profile_extrude:
        result.update({
            'profileRefs': [ctx.ref(profile) for profile in extrude_profiles],
            'profileCount': len(extrude_profiles),
            'bodyCount': len(body_refs),
            'profileBodyMapping': {
                'status': 'unavailable',
                'reason': 'Fusion does not expose a stable result-body to input-profile mapping; use the returned body refs as identities.',
            },
        })
    if resolved_query is not None:
        result['resolvedQuery'] = resolved_query
        result['selectionAssociativity'] = 'snapshot'
    if surface_variant:
        surface_result = _geometry_model_cast(
            _GeometryModelSurfaceResult, _surface_model_result)
        return surface_result(ctx, mode, data, feature, result)
    return result
