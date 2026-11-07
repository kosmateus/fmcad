"""Fusion adapter: GM08 surface features, availability gates and continuity evidence.

SDK signatures verified against public Autodesk documentation (TrimFeatures/PatchFeatures/
StitchFeatures/ExtendFeatures/OffsetFeatures, Component.createOpenProfile/createBRepEdgeProfile).
Continuity evidence is only reported where an evaluator actually measures it; everything
else is explicit unknown. Requests that the installed SDK cannot perform are blocked,
never silently substituted. See docs/SURFACE.md.
"""
import re as _geometry_surface_re
import time as _geometry_surface_time

import adsk.core as _geometry_surface_core
import adsk.fusion as _geometry_surface_fusion
from collections.abc import Hashable as _GeometrySurfaceHashable, Iterable as _GeometrySurfaceIterable, Mapping as _GeometrySurfaceMapping
from typing import TYPE_CHECKING as _GeometrySurface_TYPE_CHECKING, Literal as _GeometrySurfaceLiteral
from typing import Protocol as _GeometrySurfaceProtocol, cast as _geometry_surface_cast


if _GeometrySurface_TYPE_CHECKING:
    class _GeometrySurfacePatchInput(_GeometrySurfaceProtocol):
        @property
        def interiorProfile(self) -> object: ...

        @interiorProfile.setter
        def interiorProfile(self, value: object) -> None: ...


    class _GeometrySurfaceSketchCurveCast(_GeometrySurfaceProtocol):
        @staticmethod
        def cast(arg: "_geometry_surface_core.Base") -> "_geometry_surface_fusion.SketchCurve | None": ...


    class _GeometrySurfaceBRepEdgeCast(_GeometrySurfaceProtocol):
        @staticmethod
        def cast(arg: "_geometry_surface_core.Base") -> "_geometry_surface_fusion.BRepEdge | None": ...


    class _GeometrySurfaceNamedEdge(_GeometrySurfaceProtocol):
        @property
        def name(self) -> "str | None": ...


def _surface_identity(ctx: "CadContext") -> "JsonObject":
    ctx.assert_identity()
    return {'creationId': getattr(ctx.doc, 'creationId', None), 'name': ctx.doc.name}


def _surface_contract(ctx: "CadContext", operation: str, result: "JsonObject", status: str = 'pass',
                      readOnly: bool = False, associativity: str | None = None,
                      warnings: "list[str] | None" = None, limitations: "list[str] | None" = None,
                      **extra: "JsonValue") -> "JsonObject":
    ctx.assert_identity()
    return dict(schemaVersion=1, operation=operation, status=status, success=status == 'pass',
                documentIdentity=_surface_identity(ctx),
                units={'length': 'cm', 'angle': 'rad', 'curvature': '1/cm'},
                frame={'space': 'component', 'component': ctx.ref(ctx.component)},
                associativity=result.pop('associativity', associativity or ('nativeExpression' if not readOnly else 'snapshot')),
                 warnings=list(_geometry_surface_cast('_GeometrySurfaceIterable[str]',
                                                      result.pop('warnings', warnings or []))),
                method='Public Fusion surface feature SDK with explicit availability gates (GM08)',
                 limitations=_SURFACE_LIMITS + list(_geometry_surface_cast(
                     '_GeometrySurfaceIterable[str]', result.pop('limitations', limitations or []))),
                provenance={'requirement': 'GM08', 'source': 'docs/SURFACE.md'},
                 affected=list(_geometry_surface_cast('_GeometrySurfaceIterable[JsonValue]',
                                                      result.pop('affected', []))), **extra, **result)


def _surface_blocked(ctx: "CadContext", operation: str, reason: str) -> "JsonObject":
    return _surface_contract(ctx, operation, {}, status='blocked', readOnly=True,
                             warnings=[reason],
                             limitations=['requestedRepresentation not available through the installed SDK; '
                                          'an explicit alternative must be chosen, none was silently substituted'])


def _surface_resolve_curves(ctx: "CadContext", refs: object) -> "list[_geometry_surface_core.Base]":
    if not isinstance(refs, list) or not refs:
        raise ValueError('curves must be a nonempty reference array')
    curves = [ctx.resolve(ref) for ref in _geometry_surface_cast('list[object]', refs)]
    for curve in curves:
        if not (_geometry_surface_cast('_GeometrySurfaceSketchCurveCast', adsk.fusion.SketchCurve).cast(curve)
                or _geometry_surface_cast('_GeometrySurfaceBRepEdgeCast', adsk.fusion.BRepEdge).cast(curve)):
            raise ValueError('Open profiles require sketch curves or model edges')
        if getattr(curve, 'assemblyContext', None) is not None or _cad_owner(curve) != ctx.component:
            raise ValueError('Surface creation requires native input geometry in the selected component; cross-occurrence creation is unsupported')
    kinds = {_cad_type(curve) for curve in curves}
    if len(kinds) != 1:
        raise ValueError('Open profile curves must be homogeneous sketch curves or BRep edges')
    return curves


def _surface_open_profile(ctx: "CadContext", ref: object) -> "_geometry_surface_fusion.Profile":
    _cad_fields(_geometry_surface_cast('JsonObject', ref), ('kind', 'curves'), ())
    if _geometry_surface_cast('JsonObject', ref)['kind'] != 'openProfile':
        raise ValueError('Open profile descriptor kind must be openProfile')
    curves = _surface_resolve_curves(ctx, _geometry_surface_cast('JsonObject', ref)['curves'])
    collection = ctx.collection(curves)
    if _geometry_surface_cast('_GeometrySurfaceSketchCurveCast', adsk.fusion.SketchCurve).cast(curves[0]):
        profile = _cad_require_result(ctx.component.createOpenProfile(collection), 'Component.createOpenProfile')
    else:
        profile = _cad_require_result(ctx.component.createBRepEdgeProfile(collection), 'Component.createBRepEdgeProfile')
    return _cad_require_result(profile, 'Open profile result')


def _surface_model_preflight(ctx: "CadContext", data: "JsonObject",
                             mode: "_GeometrySurfaceLiteral['loft', 'sweep', 'revolve']") -> "JsonObject | None":
    collections = {'loft': 'loftFeatures', 'sweep': 'sweepFeatures', 'revolve': 'revolveFeatures'}
    if not hasattr(ctx.component.features, collections[mode]):
        return _surface_blocked(ctx, 'model.' + mode, 'Native surface ' + mode + ' collection is not available in the installed SDK')
    if mode == 'loft':
        for condition in _geometry_surface_cast('_GeometrySurfaceMapping[str, JsonValue]',
                                                data.get('endConditions') or {}).values():
            if _geometry_surface_cast('JsonObject', condition).get('type') != 'free':
                return _surface_blocked(ctx, 'model.loft', 'LoftFeatureInput exposes no public end-condition API; '
                                        'direction/tangent/smooth conditions are blocked, free remains supported')
    return None


def _surface_loft_conditions(ctx: "CadContext", inp: "_geometry_surface_fusion.LoftFeatureInput",
                             data: "JsonObject") -> None:
    for condition in _geometry_surface_cast('_GeometrySurfaceMapping[str, JsonValue]',
                                            data.get('endConditions') or {}).values():
        if _geometry_surface_cast('JsonObject', condition).get('type') != 'free':
            raise ValueError('Non-free loft end conditions are unavailable through the installed SDK')


def _surface_model_result(ctx: "CadContext", mode: str, data: "JsonObject",
                          feature: "_geometry_surface_fusion.Feature", result: "JsonObject") -> "JsonObject":
    status = 'pass' if int(_geometry_surface_cast('int', feature.healthState)) == 0 else 'fail'
    warnings = [feature.errorOrWarningMessage] if feature.errorOrWarningMessage else []
    payload: JsonObject = dict(result)
    payload['affected'] = [result['feature']] + list(_geometry_surface_cast('list[JsonValue]', result['bodies']))
    return _surface_contract(ctx, 'model.' + mode, payload, status=status,
                             warnings=warnings, associativity='nativeExpression',
                             surfaceVariant=True, isSolid=False,
                             limitations=['Solid:false variants reuse the public model feature inputs with isSolid=False; '
                                          'open profiles use Component.createOpenProfile/createBRepEdgeProfile.',
                                          'Loft end conditions other than free are blocked (no public API).'])


def _surface_fields(data: "JsonObject", required: "tuple[str, ...]" = (),
                    optional: "tuple[str, ...]" = ()) -> None:
    _cad_fields(data, required, ('schemaVersion', 'frame') + optional)
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('GM08 surface commands require schemaVersion:1 and frame:component')
    if data.get('onExisting', 'error') != 'error':
        raise ValueError('onExisting supports error only')
    if data.get('representation', 'native') != 'native':
        raise ValueError('Only native representation is implemented; alternatives must be explicit and are not substituted')


def _surface_protected(ctx: "CadContext", data: "JsonObject", operation: str) -> "str | JsonObject | None":
    if not data.get('protected'):
        return None
    if operation in ('surface.stitch', 'surface.trim', 'surface.extend', 'surface.offset'):
        return _surface_blocked(ctx, operation, 'Protected zones have no native API on ' + operation +
                                '; explicit unchained selections are the supported alternative')
    return 'Protected zones are not applicable: ' + operation + ' does not modify existing geometry'


@_cad_scoped_step('surface.patch', native_only=True)
def _surface_patch(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _surface_fields(data, ('boundary',), ('interior', 'continuity', 'weight', 'reverse', 'name', 'onExisting', 'protected'))
    if data.get('continuity', 'G0') != 'G0' or data.get('weight') or data.get('reverse'):
        return _surface_blocked(ctx, 'surface.patch', 'Boundary continuity conditions (G1/G2, weight, reverse) have no public PatchFeatureInput API')
    if 'interior' in data:
        if not hasattr(adsk.fusion, 'PatchFeatureInput') or not hasattr(adsk.fusion.PatchFeatureInput, 'interiorProfile'):
            return _surface_blocked(ctx, 'surface.patch', 'Interior curve/point guidance is not exposed by the installed PatchFeatureInput')
    protected = _surface_protected(ctx, data, 'surface.patch')
    boundary = data['boundary']
    if isinstance(boundary, dict) and (boundary.get('kind') == 'path' or 'curves' in boundary):
        boundary = _model_path(ctx, boundary)
    else:
        boundary = ctx.resolve(boundary, 'profile')
    features = ctx.component.features
    if not hasattr(features, 'patchFeatures'):
        return _surface_blocked(ctx, 'surface.patch', 'patchFeatures is not available in the installed SDK')
    inp = _model_ok(features.patchFeatures.createInput(
        boundary, _geometry_surface_cast('_geometry_surface_fusion.FeatureOperations',
                                         adsk.fusion.FeatureOperations.NewBodyFeatureOperation)),
        'PatchFeatures.createInput')
    if 'interior' in data and hasattr(inp, 'interiorProfile'):
        interior = data['interior']
        if isinstance(interior, list):
            _geometry_surface_cast('_GeometrySurfacePatchInput', inp).interiorProfile = ctx.collection([
                ctx.resolve(ref) for ref in interior])
        elif isinstance(interior, dict):
            _geometry_surface_cast('_GeometrySurfacePatchInput', inp).interiorProfile = _model_path(ctx, interior)
        else:
            _geometry_surface_cast('_GeometrySurfacePatchInput', inp).interiorProfile = ctx.resolve(interior)
    feature = _model_ok(features.patchFeatures.add(inp), 'surface.patch')
    _model_created(ctx, feature, _geometry_surface_cast('str | None', data.get('name')))
    result: JsonObject = {'feature': ctx.ref(feature), 'bodies': [ctx.ref(body) for body in _model_items(feature.bodies)],
              'healthState': int(_geometry_surface_cast('int', feature.healthState)), 'message': feature.errorOrWarningMessage,
              'warnings': [protected] if isinstance(protected, str) else [],
              'limitations': ['Patch boundary must already be closed; the SDK may chain a single seed curve automatically.']}
    return _surface_contract(ctx, 'surface.patch', result,
                             status='pass' if int(_geometry_surface_cast('int', feature.healthState)) == 0 else 'fail')


@_cad_scoped_step('surface.stitch', native_only=True)
def _surface_stitch(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _surface_fields(data, ('bodies', 'tolerance'), ('expectSolid', 'name', 'onExisting', 'protected'))
    blocked = _surface_protected(ctx, data, 'surface.stitch')
    if blocked and isinstance(blocked, dict):
        return blocked
    if ctx.length(data['tolerance']) <= 0:
        raise ValueError('Stitch tolerance must be a positive length expression')
    features = ctx.component.features
    if not hasattr(features, 'stitchFeatures'):
        return _surface_blocked(ctx, 'surface.stitch', 'stitchFeatures is not available in the installed SDK')
    bodies = _geometry_surface_cast('list[_geometry_surface_fusion.BRepBody]',
                                    _model_entities(ctx, data['bodies'], kind='body'))
    if any(body.isSolid for body in bodies):
        raise ValueError('Stitch requires open surface bodies')
    inp = _model_ok(features.stitchFeatures.createInput(ctx.collection(bodies), ctx.value(data['tolerance'])), 'StitchFeatures.createInput')
    feature = _model_ok(features.stitchFeatures.add(inp), 'surface.stitch')
    _model_created(ctx, feature, _geometry_surface_cast('str | None', data.get('name')))
    actual = [body for body in _model_items(feature.bodies)]
    warnings: list[str] = []
    status = 'pass'
    if data.get('expectSolid') is True and not all(body.isSolid for body in actual):
        status = 'fail'
        warnings.append('expectSolid:true but the stitch result is not entirely solid')
    elif data.get('expectSolid') is False and all(body.isSolid for body in actual):
        status = 'fail'
        warnings.append('expectSolid:false but the stitch result is entirely solid')
    free = [edge for body in actual for edge in _surface_free_edges(body)]
    return _surface_contract(ctx, 'surface.stitch', _geometry_surface_cast('JsonObject', {
        'feature': ctx.ref(feature), 'bodies': [ctx.ref(body) for body in actual],
        'freeEdges': [ctx.ref(edge) for edge in free],
        'healthState': int(_geometry_surface_cast('int', feature.healthState)),
        'message': feature.errorOrWarningMessage, 'warnings': warnings}), status=status)


def _surface_trim_cells(inp: "_geometry_surface_fusion.TrimFeatureInput") -> "list[JsonObject]":
    cells = _cad_items(inp.bRepCells)
    return [{'index': i, 'selected': bool(getattr(cell, 'isSelected', False))} for i, cell in enumerate(cells)]


@_cad_scoped_step('surface.trim', native_only=True)
def _surface_trim(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _surface_fields(data, ('tool', 'mode'), ('plan', 'removeCells', 'name', 'onExisting', 'protected'))
    blocked = _surface_protected(ctx, data, 'surface.trim')
    if blocked and isinstance(blocked, dict):
        return blocked
    features = ctx.component.features
    if not hasattr(features, 'trimFeatures'):
        return _surface_blocked(ctx, 'surface.trim', 'trimFeatures is not available in the installed SDK')
    tool = ctx.resolve(data['tool'])
    if data['mode'] == 'plan':
        if 'plan' in data or 'removeCells' in data:
            raise ValueError('Plan mode cannot select cells')
        inp = _model_ok(features.trimFeatures.createInput(tool), 'TrimFeatures.createInput')
        plan = _geometry_surface_cast('JsonObject', {'plan': {'schemaVersion': 1, 'operation': 'surface.trim', 'documentIdentity': _surface_identity(ctx),
                         'tool': ctx.ref(tool), 'cells': _surface_trim_cells(inp), 'cellCount': inp.bRepCells.count}})
        try:
            _model_ok(inp.cancel(), 'TrimFeatureInput.cancel')
        except Exception as primary:
            raise RuntimeError('Trim plan could not be cancelled; the native trim transaction may be left open: ' + str(primary))
        plan['warnings'] = ['Planning started a native partial compute and cancelled it; the operation is not read-only.']
        return _surface_contract(ctx, 'surface.trim', plan, status='pass', associativity='snapshot')
    if not data.get('plan') or not isinstance(data['plan'], dict):
        raise ValueError('Apply requires a reviewed plan from trim plan mode')
    plan = data['plan']
    if plan.get('schemaVersion') != 1 or plan.get('operation') != 'surface.trim' or plan.get('documentIdentity') != _surface_identity(ctx):
        raise ValueError('Plan schema or document identity mismatch; replan before applying')
    if ctx.resolve(plan.get('tool')) != tool:
        raise ValueError('Plan belongs to a different tool')
    remove = data.get('removeCells')
    if (not isinstance(remove, list) or not remove or any(not isinstance(i, int) or i < 0 for i in remove)
            or len(set(_geometry_surface_cast('list[int]', remove))) != len(remove)):
        raise ValueError('removeCells must be nonempty unique cell indexes')
    inp = _model_ok(features.trimFeatures.createInput(tool), 'TrimFeatures.createInput')
    cells = _cad_items(inp.bRepCells)
    if len(cells) != plan.get('cellCount'):
        _model_ok(inp.cancel(), 'TrimFeatureInput.cancel')
        raise ValueError('Cell count changed since the plan was made; replan before applying')
    if any(i >= len(cells) for i in _geometry_surface_cast('list[int]', remove)):
        _model_ok(inp.cancel(), 'TrimFeatureInput.cancel')
        raise ValueError('removeCells contains an index outside the planned cells')
    for index in _geometry_surface_cast('list[int]', remove):
        cells[index].isSelected = True
    feature = _model_ok(features.trimFeatures.add(inp), 'surface.trim')
    _model_created(ctx, feature, _geometry_surface_cast('str | None', data.get('name')))
    return _surface_contract(ctx, 'surface.trim', {'feature': ctx.ref(feature), 'before': plan['cells'],
        'removedCells': _geometry_surface_cast('list[int]', remove), 'bodies': [ctx.ref(body) for body in _model_items(feature.bodies)],
        'healthState': int(_geometry_surface_cast('int', feature.healthState)), 'message': feature.errorOrWarningMessage},
        status='pass' if int(_geometry_surface_cast('int', feature.healthState)) == 0 else 'fail',
        limitations=['Cell identity is positional per plan; replan after any geometry change.'])


@_cad_scoped_step('surface.extend', native_only=True)
def _surface_extend(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _surface_fields(data, ('edges', 'distance'), ('type', 'tangentChain', 'name', 'onExisting', 'protected'))
    blocked = _surface_protected(ctx, data, 'surface.extend')
    if blocked and isinstance(blocked, dict):
        return blocked
    extend_type = data.get('type', 'natural')
    if _geometry_surface_cast('_GeometrySurfaceHashable', extend_type) not in _SURFACE_EXTEND_ENUM:
        raise ValueError('Extend type must be natural, tangent or perpendicular')
    distance = ctx.length(data['distance'])
    if _geometry_surface_cast('str', extend_type) in ('natural', 'tangent') and distance <= 0:
        raise ValueError('Natural and tangent extend require a positive distance')
    edges = _geometry_surface_cast('list[_geometry_surface_fusion.BRepEdge]',
                                   _model_entities(ctx, data['edges'], kind='edge'))
    owners = {id(edge.body) for edge in edges}
    if len(owners) != 1:
        raise ValueError('Extend edges must all come from one open body')
    body = edges[0].body
    if body.isSolid:
        raise ValueError('Extend requires outer edges of an open surface body')
    if any(edge.faces.count != 1 for edge in edges):
        raise ValueError('Only outer (single-face) edges of an open body can be extended')
    features = ctx.component.features
    if not hasattr(features, 'extendFeatures'):
        return _surface_blocked(ctx, 'surface.extend', 'extendFeatures is not available in the installed SDK')
    if _geometry_surface_cast('str', extend_type) == 'natural':
        enum = _geometry_surface_cast('_geometry_surface_fusion.SurfaceExtendTypes',
                                      _geometry_surface_fusion.SurfaceExtendTypes.NaturalSurfaceExtendType)
    elif _geometry_surface_cast('str', extend_type) == 'tangent':
        enum = _geometry_surface_cast('_geometry_surface_fusion.SurfaceExtendTypes',
                                      _geometry_surface_fusion.SurfaceExtendTypes.TangentSurfaceExtendType)
    else:
        enum = _geometry_surface_cast('_geometry_surface_fusion.SurfaceExtendTypes',
                                      _geometry_surface_fusion.SurfaceExtendTypes.PerpendicularSurfaceExtendType)
    inp = _model_ok(features.extendFeatures.createInput(ctx.collection(edges), ctx.value(data['distance']), enum,
        _geometry_surface_cast('bool', data.get('tangentChain', False))), 'ExtendFeatures.createInput')
    feature = _model_ok(features.extendFeatures.add(inp), 'surface.extend')
    _model_created(ctx, feature, _geometry_surface_cast('str | None', data.get('name')))
    return _surface_contract(ctx, 'surface.extend', {'feature': ctx.ref(feature), 'bodies': [ctx.ref(body) for body in _model_items(feature.bodies)],
        'healthState': int(_geometry_surface_cast('int', feature.healthState)), 'message': feature.errorOrWarningMessage},
        status='pass' if int(_geometry_surface_cast('int', feature.healthState)) == 0 else 'fail')


@_cad_scoped_step('surface.offset', native_only=True)
def _surface_offset(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _surface_fields(data, ('faces', 'distance'), ('tangentChain', 'name', 'onExisting', 'protected'))
    blocked = _surface_protected(ctx, data, 'surface.offset')
    if blocked and isinstance(blocked, dict):
        return blocked
    ctx.length(data['distance'])
    faces = _geometry_surface_cast('list[_geometry_surface_fusion.BRepFace]',
                                   _model_entities(ctx, data['faces'], kind='face'))
    features = ctx.component.features
    if not hasattr(features, 'offsetFeatures'):
        return _surface_blocked(ctx, 'surface.offset', 'offsetFeatures is not available in the installed SDK')
    inp = _model_ok(features.offsetFeatures.createInput(ctx.collection(faces), ctx.value(data['distance']),
        _geometry_surface_cast('_geometry_surface_fusion.FeatureOperations',
                               _geometry_surface_fusion.FeatureOperations.NewBodyFeatureOperation),
        _geometry_surface_cast('bool', data.get('tangentChain', False))), 'OffsetFeatures.createInput')
    feature = _model_ok(features.offsetFeatures.add(inp), 'surface.offset')
    _model_created(ctx, feature, _geometry_surface_cast('str | None', data.get('name')))
    return _surface_contract(ctx, 'surface.offset', {'feature': ctx.ref(feature), 'bodies': [ctx.ref(body) for body in _model_items(feature.bodies)],
        'healthState': int(_geometry_surface_cast('int', feature.healthState)), 'message': feature.errorOrWarningMessage},
        status='pass' if int(_geometry_surface_cast('int', feature.healthState)) == 0 else 'fail',
        limitations=['Signed distance follows the face normal; zero copies. The source body is untouched.'])


def _surface_free_edges(body: "_geometry_surface_fusion.BRepBody") -> "list[_geometry_surface_fusion.BRepEdge]":
    return [edge for edge in _model_items(body.edges) if edge.faces.count == 1]


_CURVATURE_UNIT_TO_1CM = {'1/cm': 1.0, '1/mm': 10.0, '1/m': 0.01, '1/in': 1.0 / 2.54, '1/ft': 1.0 / 30.48}


def _surface_curvature_tolerance(expression: object) -> float:
    """Curvature is inverse length; tolerance expressions are parsed locally into
    internal 1/cm units because UnitsManager has no verified inverse-length spec."""
    if not isinstance(expression, str) or not expression.strip():
        raise ValueError('curvatureTolerance must be a nonempty string')
    match = _geometry_surface_re.fullmatch(r'\s*(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\s*(1/cm|1/mm|1/m|1/in|1/ft)\s*', expression)
    if not match:
        raise ValueError('curvatureTolerance must be a nonnegative number with an inverse-length unit (1/cm, 1/mm, 1/m, 1/in, 1/ft)')
    return float(match.group(1)) * _CURVATURE_UNIT_TO_1CM[match.group(2)]


def _surface_check_budget(data: "JsonObject") -> "tuple[int, int, float]":
    samples = data.get('samples', 17)
    if not isinstance(samples, int) or not 2 <= samples <= 1001:
        raise ValueError('samples must be an integer in 2..1001')
    max_items = data.get('maxItems', 1000)
    budget = data.get('budgetMs', 10000)
    if not isinstance(max_items, int) or not 1 <= max_items <= 10000 or not isinstance(budget, int) or not 1 <= budget <= 120000:
        raise ValueError('Invalid check budget')
    return samples, max_items, _geometry_surface_time.monotonic() + budget / 1000


def _surface_seam_measure(ctx: "CadContext", edge_a: "_geometry_surface_fusion.BRepEdge",
                          face_a: "_geometry_surface_fusion.BRepFace", edge_b: "_geometry_surface_fusion.BRepEdge",
                          face_b: "_geometry_surface_fusion.BRepFace", reverse: "JsonValue", samples: int,
                          tolerance: float, angle_tolerance: float, curvature_tolerance: float,
                          deadline: float) -> "JsonObject":
    evaluator_a, evaluator_b = edge_a.geometry.evaluator, edge_b.geometry.evaluator
    surface_a, surface_b = face_a.geometry.evaluator, face_b.geometry.evaluator
    ok, start_a, end_a = evaluator_a.getParameterExtents()
    ok_b, start_b, end_b = evaluator_b.getParameterExtents()
    if not (ok and ok_b):
        raise ValueError('Seam edges have no bounded parameter range')
    gaps: list[float]
    angles: list[float]
    curvature: list[float]
    gaps, angles, curvature = [], [], []
    unknown: list[JsonObject] = []
    for i in range(samples):
        if _geometry_surface_time.monotonic() > deadline:
            raise ValueError('Seam evidence budget exceeded')
        t_a = start_a + (end_a - start_a) * i / (samples - 1)
        t_b = start_b + (end_b - start_b) * i / (samples - 1)
        ok_a, point_a = evaluator_a.getPointAtParameter(t_a)
        ok_b, point_b = evaluator_b.getPointAtParameter(t_b)
        if not (ok_a and ok_b):
            unknown.append({'sample': i, 'reason': 'getPointAtParameter failed'})
            continue
        gaps.append(_geometry_surface_math.hypot(*(a - b for a, b in zip(_cad_xyz(point_a), _cad_xyz(point_b)))))
        try:
            ok_pa, param_a = surface_a.getParameterAtPoint(point_a)
            ok_pb, param_b = surface_b.getParameterAtPoint(point_b)
            if not (ok_pa and ok_pb):
                raise ValueError('Surface getParameterAtPoint failed')
            ok_na, normal_a = surface_a.getNormalAtParameter(param_a)
            ok_nb, normal_b = surface_b.getNormalAtParameter(param_b)
            if not (ok_na and ok_nb):
                raise ValueError('Surface getNormalAtParameter failed')
            normal_a = _cad_xyz(normal_a)
            normal_b = _cad_xyz(normal_b)
            if reverse:
                normal_b = [-v for v in normal_b]
            dot = max(-1.0, min(1.0, sum(a * b for a, b in zip(normal_a, normal_b)) / (_geometry_surface_math.hypot(*normal_a) * _geometry_surface_math.hypot(*normal_b) or 1)))
            angles.append(_geometry_surface_math.degrees(_geometry_surface_math.acos(dot)))
            ok_ca, _, max_curv_a, min_curv_a = surface_a.getCurvature(param_a)
            ok_cb, _, max_curv_b, min_curv_b = surface_b.getCurvature(param_b)
            if not (ok_ca and ok_cb):
                raise ValueError('Surface getCurvature failed')
            curvature.append(_surface_g2_deviation(max_curv_a, min_curv_a, max_curv_b, min_curv_b))
        except Exception as exc:
            unknown.append({'sample': i, 'reason': str(exc)})
    def aggregate(values: list[float], limit: float) -> "tuple[str, float | None, float]":
        if len(values) == samples:
            return ('fail' if max(values) > limit else 'pass', max(values), limit)
        if not values:
            return ('unknown', None, limit)
        return ('unknown' if max(values) <= limit else 'fail', max(values), limit)
    gap_status, gap_max, _ = aggregate(gaps, tolerance)
    angle_status, angle_max, _ = aggregate(angles, angle_tolerance)
    curvature_status, curvature_max, _ = aggregate(curvature, curvature_tolerance)
    status = 'fail' if 'fail' in (gap_status, angle_status, curvature_status) else 'unknown' if 'unknown' in (gap_status, angle_status, curvature_status) else 'pass'
    return {'status': status, 'samples': samples,
            'G0': {'status': gap_status, 'gapCm': gap_max, 'toleranceCm': tolerance, 'samples': len(gaps)},
            'G1': {'status': angle_status, 'angleDeg': angle_max, 'toleranceDeg': angle_tolerance, 'samples': len(angles)},
            'G2': {'status': curvature_status, 'deviationInvCm': curvature_max, 'toleranceInvCm': curvature_tolerance, 'samples': len(curvature)},
            'unknown': unknown, 'method': 'Edge-parameter arc-length fractions; face evaluator normals and principal curvature values'}




def _surface_check(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _surface_fields(data, ('bodies',), ('expectSolid', 'expectClosed', 'allowedOpenEdges', 'seams',
                                        'samples', 'tolerance', 'angleTolerance', 'curvatureTolerance', 'maxItems', 'budgetMs'))
    samples, max_items, deadline = _surface_check_budget(data)
    tolerance = ctx.length(data.get('tolerance', '0.001 mm'))
    angle_tolerance = ctx.angle(data.get('angleTolerance', '0.1 deg'))
    curvature_tolerance = _surface_curvature_tolerance(data.get('curvatureTolerance', '0.001 1/cm'))
    if not tolerance > 0 or not angle_tolerance > 0 or not curvature_tolerance >= 0:
        raise ValueError('Check tolerances require positive tolerances (curvature may be zero)')
    bodies = _geometry_surface_cast('list[_geometry_surface_fusion.BRepBody]',
                                    _model_entities(ctx, data['bodies'], kind='body'))
    evidence, status, warnings = _geometry_surface_cast('list[JsonObject]', []), 'pass', _geometry_surface_cast('list[str]', [])
    for body in bodies:
        free = _surface_free_edges(body)
        row = _geometry_surface_cast('JsonObject', {'body': ctx.ref(body), 'isSolid': body.isSolid, 'edgeCount': body.edges.count,
               'freeEdges': [ctx.ref(edge) for edge in free[:max_items]], 'freeEdgeCount': len(free)})
        if data.get('expectSolid') is not None and body.isSolid != data['expectSolid']:
            row['status'] = 'fail'
            status = 'fail'
        else:
            row['status'] = 'pass'
        if data.get('expectClosed') is True:
            allowed = _geometry_surface_cast('_GeometrySurfaceIterable[JsonValue]', data.get('allowedOpenEdges', []))
            allowed_identity = {
                _geometry_surface_cast('_GeometrySurfaceHashable', ref.get('token'))
                if isinstance(ref, dict) and ref.get('token')
                else (ref if isinstance(ref, str) else None)
                for ref in allowed
            }
            open_edges = [edge for edge in free if edge.entityToken not in allowed_identity and
                          (not hasattr(edge, 'name') or
                           _geometry_surface_cast('_GeometrySurfaceNamedEdge', edge).name not in allowed_identity)]
            row['status'] = 'fail' if open_edges else row['status']
            status = 'fail' if open_edges else status
            if open_edges:
                warnings.append('expectClosed:true but %d free edges are not in allowedOpenEdges' % len(open_edges))
            unmatched = [identity for identity in allowed_identity if identity is not None and
                         identity not in {edge.entityToken for edge in free} and identity not in {
                             _geometry_surface_cast('_GeometrySurfaceNamedEdge', edge).name
                             for edge in free if hasattr(edge, 'name')}]
            if unmatched:
                row['unmatchedAllowedEdges'] = len(unmatched)
        evidence.append(row)
        if len(free) > max_items:
            warnings.append('Free-edge report truncated to maxItems=%d' % max_items)
    seam_results = _geometry_surface_cast('list[JsonObject]', [])
    for spec in _geometry_surface_cast('_GeometrySurfaceIterable[JsonValue]', data.get('seams', [])):
        _cad_fields(_geometry_surface_cast('JsonObject', spec), ('edgeA', 'faceA', 'edgeB', 'faceB'), ('reverse',))
        edge_a, edge_b = (ctx.resolve(_geometry_surface_cast('JsonObject', spec)['edgeA'], 'edge'),
                          ctx.resolve(_geometry_surface_cast('JsonObject', spec)['edgeB'], 'edge'))
        face_a, face_b = (ctx.resolve(_geometry_surface_cast('JsonObject', spec)['faceA'], 'face'),
                          ctx.resolve(_geometry_surface_cast('JsonObject', spec)['faceB'], 'face'))
        if not any(f == face_a for f in _model_items(edge_a.faces)) or not any(f == face_b for f in _model_items(edge_b.faces)):
            raise ValueError('Seam faces must be adjacent to their declared edges')
        measured = _surface_seam_measure(ctx, edge_a, face_a, edge_b, face_b,
                                         _geometry_surface_cast('JsonObject', spec).get('reverse', False),
                                         samples, tolerance, angle_tolerance, curvature_tolerance, deadline)
        measured.update({'edgeA': ctx.ref(edge_a), 'edgeB': ctx.ref(edge_b),
                         'reverse': _geometry_surface_cast('JsonObject', spec).get('reverse', False)})
        seam_results.append(measured)
        if measured['status'] == 'fail':
            status = 'fail'
        elif measured['status'] == 'unknown' and status == 'pass':
            status = 'unknown'
    return _surface_contract(ctx, 'surface.check', _geometry_surface_cast('JsonObject', {
                              'bodies': evidence, 'seams': seam_results, 'warnings': warnings}),
                             status=status, readOnly=True, associativity='snapshot',
                             limitations=['Free edges are counted per inspected body, not across the whole design.',
                                          'Continuity evidence is sampled at equal arc-length fractions; pass does not certify continuous G1/G2.',
                                          'G2 compares principal curvature values (|k1_a - k1_b| and |k2_a - k2_b|); zero-curvature faces yield deviation 0.'])
