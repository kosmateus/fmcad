"""Standalone compatibility Fusion context; deliberately no run entry point.

The manifest bundler replaces the value helpers below with the canonical pure
runtime/python units and installs their collision-detecting registry. Keeping
this standalone source supports retained offline family fixtures; SDK entities,
UnitsManager, document resolution and callbacks belong to this adapter, not DTOs.
"""
import contextlib
import enum
import json
import math
import re
from functools import wraps

import adsk.core
import adsk.fusion
from typing import TYPE_CHECKING, TYPE_CHECKING as _CAD_TYPE_CHECKING
from typing import TypeAlias as _CadTypeAlias, TypedDict as _CadTypedDict, cast as _cad_cast, overload as _cad_overload


if TYPE_CHECKING:
    CAD_HANDLERS: HandlerRegistry = HandlerRegistry()
else:
    CAD_HANDLERS = {}
if TYPE_CHECKING:
    CadEntity: _CadTypeAlias = adsk.core.Base

if TYPE_CHECKING:
    class _ParameterUpdate(_CadTypedDict):
        old: adsk.fusion.Parameter | None
        expression: str
        unit: str
        comment: str
        metadata: JsonRecord
        changed: bool


_CAD_ALIAS_GROUP = 'fmcad.aliases'
_CAD_PARAM_GROUP = 'fmcad.parameter'
_CAD_FRAME_GROUP = 'fmcad.frames'
# UnitsManager accepts compound unit descriptions. Use an explicit unit ratio,
# not '', which allows default/inferred units and is not a dimensional classifier.
_CAD_UNITLESS = 'cm/cm'
_CAD_KINDS = {
    'Component': 'component', 'Occurrence': 'occurrence', 'BRepBody': 'body',
    'BRepFace': 'face', 'BRepEdge': 'edge', 'BRepVertex': 'vertex',
    'Sketch': 'sketch', 'Profile': 'profile', 'ConstructionPlane': 'plane',
    'ConstructionAxis': 'axis', 'ConstructionPoint': 'point', 'SketchPoint': 'point',
    'UserParameter': 'parameter', 'ModelParameter': 'parameter',
}
_CAD_ORIGINS = {'XY': 'xYConstructionPlane', 'XZ': 'xZConstructionPlane',
                'YZ': 'yZConstructionPlane', 'X': 'xConstructionAxis',
                'Y': 'yConstructionAxis', 'Z': 'zConstructionAxis',
                'origin': 'originConstructionPoint'}


def _cad_items(collection: '_CadItemCollection[_CadItem] | list[_CadItem] | tuple[_CadItem, ...]') -> 'list[_CadItem]':
    if isinstance(collection, (list, tuple)):
        return list(collection)
    return [collection.item(i) for i in range(collection.count)]


def _cad_type(entity: 'adsk.core.Base') -> str:
    return entity.objectType.split('::')[-1]


def _cad_kind(entity: 'adsk.core.Base') -> str:
    name = _cad_type(entity)
    return _CAD_KINDS.get(name, 'feature' if name.endswith('Feature') else name)


def _cad_xyz(value: 'adsk.core.Point3D | adsk.core.Vector3D') -> list[float]:
    return [float(value.x), float(value.y), float(value.z)]


def _cad_json(value: object) -> 'JsonValue':
    """Do not stringify opaque Fusion objects and pretend they are useful data."""
    if isinstance(value, enum.Enum):
        return {'name': value.name, 'value': _cad_json(value.value)}
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError('Non-finite value cannot be serialized')
        return value
    if isinstance(value, (list, tuple)):
        return [_cad_json(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _cad_json(v) for k, v in value.items()}
    kind = _cad_type(value)
    if kind in ('Point3D', 'Vector3D'):
        return {'type': kind, 'xyz': _cad_xyz(value)}
    if kind == 'Matrix3D':
        return {'type': kind, 'matrix': list(value.asArray())}
    if kind == 'BoundingBox3D':
        return {'min': _cad_xyz(value.minPoint), 'max': _cad_xyz(value.maxPoint), 'units': 'cm'}
    raise TypeError('Unsupported serialization type: ' + kind)


def _cad_geometry(geometry: 'adsk.core.Base') -> 'JsonRecord':
    result: JsonRecord = {'type': _cad_type(geometry), 'lengthUnits': 'cm', 'angleUnits': 'rad'}
    for key in ('origin', 'center', 'normal', 'axis', 'direction', 'startPoint', 'endPoint'):
        if hasattr(geometry, key):
            result[key] = _cad_xyz(_cad_cast('adsk.core.Point3D | adsk.core.Vector3D', getattr(geometry, key)))
    for key in ('radius', 'majorRadius', 'minorRadius', 'halfAngle', 'startAngle', 'endAngle'):
        if hasattr(geometry, key):
            result[key] = float(_cad_cast('int | float', getattr(geometry, key)))
    if result['type'] in ('Point3D', 'Vector3D'):
        result['xyz'] = _cad_xyz(_cad_cast('adsk.core.Point3D | adsk.core.Vector3D', geometry))
    if result['type'] == 'Line3D':
        result['direction'] = _cad_direction([b - a for a, b in zip(_cad_cast('list[float]', result['startPoint']), _cad_cast('list[float]', result['endPoint']))])
    return result


def _cad_owner(entity: 'CadEntity') -> 'adsk.fusion.Component | None':
    native = _cad_cast('adsk.core.Base', getattr(entity, 'nativeObject', None) or entity)
    kind = _cad_kind(native)
    if kind == 'component':
        return _cad_cast('adsk.fusion.Component', native)
    if kind == 'occurrence':
        return _cad_cast('adsk.fusion.Occurrence', native).component
    if kind in ('plane', 'axis', 'point') and hasattr(native, 'component'):
        return _cad_cast('adsk.fusion.Component', getattr(native, 'component'))
    if hasattr(native, 'parentComponent'):
        return _cad_cast('adsk.fusion.Component', getattr(native, 'parentComponent'))
    if hasattr(native, 'body'):
        body = _cad_cast('adsk.fusion.BRepBody', getattr(native, 'body'))
        return _cad_cast('adsk.fusion.Component', getattr(body, 'parentComponent'))
    parent_sketch = _cad_cast('adsk.fusion.Sketch | None', getattr(native, 'parentSketch', None))
    if parent_sketch is not None:
        return _cad_cast('adsk.fusion.Component', getattr(parent_sketch, 'parentComponent'))
    return None


def _cad_unique(entities: 'list[_CadItem]', label: str) -> '_CadItem':
    unique: list[_CadItem] = []
    for entity in entities:
        if not any(entity == other for other in unique):
            unique.append(entity)
    if len(unique) != 1:
        raise ValueError('%s: expected one match, found %d' % (label, len(unique)))
    return unique[0]


def _cad_dedup(entities: 'list[_CadItem]') -> 'list[_CadItem]':
    """Deduplicate by object identity, preserving collection order."""
    unique: list[_CadItem] = []
    for entity in entities:
        if not any(entity == other for other in unique):
            unique.append(entity)
    return unique


def _cad_style_is_design_local(item: '_CadStyleItem', collection: '_CadItemCollection[_CadStyleItem] | list[_CadStyleItem] | tuple[_CadStyleItem, ...]') -> bool:
    """Whether a style item is design-local: a member of the design's collection.

    Fusion `Appearance.parent`/`Material.parent` is unreliable: a copy made via
    `Appearances.add`/`addByCopy` can still report a library/`MaterialLibrary`-typed
    parent, so parent/`Design.cast` cannot identify design-local assets. Design-local
    is instead membership in the design's `appearances`/`materials` collection — an
    item created via `add`/`addByCopy` is a member, a library entry is not.
    """
    return any(item == other for other in _cad_items(collection))


def _cad_style_resolve(matches: 'list[_CadStyleItem]', label: str, local_collection: '_CadItemCollection[_CadStyleItem] | list[_CadStyleItem] | tuple[_CadStyleItem, ...]', style_id: str) -> 'tuple[_CadStyleItem, JsonRecord]':
    """Resolve a non-unique style ID deterministically and disclose the choice.

    Fusion appearance/material IDs are not unique: the same id can occur on a
    design-local asset, on library entries, and on leftover copies from prior
    sessions, so `_cad_unique` (exactly one match) is wrong for styles. Precedence
    (after identity deduplication):
      1. reduce to design-local assets (members of the design's collection), so a
         design-local copy is preferred over a library entry sharing the id;
      2. within the survivors, select the canonical entry whose name equals the
         requested id over renamed copies;
      3. otherwise the first survivor in stable collection order.
    Returns (selected, resolution) where resolution discloses the selected identity,
    every candidate, and the applied precedence, so the choice is never silent.
    """
    candidates = _cad_dedup(matches)
    if not candidates:
        raise ValueError('%s: no match' % label)
    all_candidates = candidates
    precedence = 'unique' if len(candidates) == 1 else 'collection-order'
    if len(candidates) > 1:
        design_local = [item for item in candidates if _cad_style_is_design_local(item, local_collection)]
        if design_local:
            candidates = design_local
            precedence = 'design-local'
        if len(candidates) > 1:
            canonical = [item for item in candidates if getattr(item, 'name', None) == style_id]
            if len(canonical) == 1:
                candidates = canonical
                precedence = 'canonical-name'
            else:
                precedence = 'collection-order'
    selected = candidates[0]
    return selected, {
        'selected': {'id': selected.id, 'name': selected.name},
        'candidates': [{'id': item.id, 'name': item.name} for item in all_candidates],
        'ambiguous': len(all_candidates) > 1,
        'precedence': precedence,
    }


def _cad_require_result(result: '_CadItem | None', operation: str) -> '_CadItem':
    if result is None or result is False:
        raise RuntimeError(operation + ' failed; inspect the document for partial changes')
    return result


def _cad_fields(data: 'Mapping[str, object]', required: tuple[str, ...]=(), optional: tuple[str, ...]=()) -> None:
    missing = set(required) - data.keys()
    unknown = data.keys() - set(required) - set(optional)
    if missing or unknown:
        raise ValueError('Missing inputs: %s; unsupported inputs: %s' % (sorted(missing), sorted(unknown)))
    for key in ('confirm', 'overwrite', 'unique', 'replace', 'includeModel'):
        if key in data and type(data[key]) is not bool:
            raise ValueError(key + ' must be boolean')


@contextlib.contextmanager
def _cad_step_scope(ctx: 'CadContext', data: 'JsonObject', operation: str, native_only: bool=False, scope_keys: tuple[str, ...]=('component', 'occurrence')) -> 'Generator[JsonObject, None, None]':
    """Adopt a per-step component/occurrence scope for a mutating handler body.

    The atomic batch injects a resolved `component` (and optionally `occurrence`)
    into step `data`; honor it via `_scope` rather than silently reading the
    batch's base `ctx.component`. The resolved scope keys are stripped from the
    payload handed to the handler, so strict field validation does not reject the
    injected override. `native_only` handlers create native component geometry
    and reject an occurrence override fail-loud rather than coercing to a proxy
    context.
    """
    if not any(key in data for key in scope_keys):
        yield data
        return
    scope = _cad_cast('Callable[[JsonObject], tuple[adsk.fusion.Component, adsk.fusion.Occurrence | None]] | None',
                      getattr(ctx, '_scope', None))
    if scope is None:
        raise ValueError(operation + ' received a per-step scope override but the context has no scope resolver')
    component, occurrence = scope({key: data[key] for key in scope_keys if key in data})
    if native_only and occurrence is not None:
        raise ValueError(operation + ' creates native component geometry; per-step occurrence override is unsupported')
    saved = ctx.component, ctx.occurrence
    ctx.component, ctx.occurrence = component, occurrence
    try:
        yield {key: value for key, value in data.items() if key not in scope_keys}
    finally:
        ctx.component, ctx.occurrence = saved


def _cad_scoped_step(operation: str, native_only: bool=False, scope_keys: tuple[str, ...]=('component', 'occurrence')) -> 'Callable[[Callable[..., JsonValue]], Callable[..., JsonValue]]':
    """Decorator running a mutating handler under `_cad_step_scope`."""
    def decorate(handler: 'Callable[..., JsonValue]') -> 'Callable[..., JsonValue]':
        @wraps(handler)
        def wrapped(ctx: 'CadContext', data: 'JsonObject', *args: object, **kwargs: object) -> 'JsonValue':
            with _cad_step_scope(ctx, data, operation, native_only, scope_keys) as scoped:
                return handler(ctx, scoped, *args, **kwargs)
        setattr(wrapped, '_cad_native_only', native_only)
        return wrapped
    return decorate


class CadContext:
    def __init__(self, doc_name: str, component_ref: object=None, project_id: str | None=None, doc_id: str | None=None, doc_file_id: str | None=None, resolved_doc: 'adsk.core.Document | None'=None) -> None:
        self.app: adsk.core.Application = adsk.core.Application.get()
        self.doc: adsk.core.Document = resolved_doc if resolved_doc is not None else _cad_cast('adsk.core.Document', _document_target(self.app, doc_name, project_id))
        self.doc_id, self.doc_file_id = doc_id, doc_file_id
        self.assert_identity()
        if resolved_doc is not None and project_id is not None and self.doc.dataFile.parentProject.id != project_id:
            raise ValueError('Resolved document project differs from the exact pinned project')
        design = _cad_cast("_DesignCaster", adsk.fusion.Design).cast(
            self.doc.products.itemByProductType('DesignProductType'))
        if design is None:
            raise ValueError('Document has no Fusion Design product: ' + doc_name)
        self.design: adsk.fusion.Design = design
        self.root = self.design.rootComponent
        self.component: adsk.fusion.Component = self.root
        self.occurrence: adsk.fusion.Occurrence | None = None
        self.created: list[JsonValue] = []
        self._profile_selections: list[tuple[adsk.fusion.Profile, int]] = []
        if component_ref is not None:
            entity = self.resolve(component_ref)
            if _cad_kind(entity) == 'occurrence':
                occurrence = _cad_cast('adsk.fusion.Occurrence', entity)
                self.occurrence = occurrence
                self.component = occurrence.component
            elif _cad_kind(entity) == 'component':
                self.component = _cad_cast('adsk.fusion.Component', entity)
            else:
                raise ValueError('component_ref must resolve to a component or occurrence')

    def assert_identity(self) -> None:
        _document_assert_identity(self.doc, self.doc_id, self.doc_file_id)

    def activate_target(self) -> None:
        _document_activate_target(self.app, self.doc, self.doc_id, self.doc_file_id)

    def _scope(self, data: 'JsonObject') -> 'tuple[adsk.fusion.Component, adsk.fusion.Occurrence | None]':
        occurrence = self.occurrence
        component = self.component
        if data.get('component') is not None:
            component = self.resolve(data['component'], 'component')
            occurrence = None
        if data.get('occurrence') is not None:
            occurrence = self.resolve(data['occurrence'], 'occurrence')
            if data.get('component') is not None and occurrence.component != component:
                raise ValueError('Component and occurrence contexts disagree')
            component = occurrence.component
        return component, occurrence

    def _proxy(self, entity: 'CadEntity', occurrence: 'adsk.fusion.Occurrence | None') -> 'CadEntity':
        if occurrence is None or _cad_kind(entity) in ('component', 'parameter', 'occurrence'):
            return entity
        if _cad_cast('adsk.fusion.Occurrence | None', getattr(entity, 'assemblyContext', None)) == occurrence:
            return entity
        native = _cad_cast('adsk.core.Base', getattr(entity, 'nativeObject', None) or entity)
        if not hasattr(native, 'createForAssemblyContext'):
            raise ValueError('Entity cannot be represented in the requested occurrence context')
        create_proxy = _cad_cast('Callable[[adsk.fusion.Occurrence], adsk.core.Base]',
                                 getattr(native, 'createForAssemblyContext'))
        return _cad_require_result(create_proxy(occurrence), 'Create proxy')

    @_cad_overload
    def _entities(self, kind: "Literal['component']", component: "adsk.fusion.Component | None" = None,
                  occurrence: "adsk.fusion.Occurrence | None" = None) -> "Sequence[adsk.fusion.Component]": ...

    @_cad_overload
    def _entities(self, kind: "Literal['occurrence']", component: "adsk.fusion.Component | None" = None,
                  occurrence: "adsk.fusion.Occurrence | None" = None) -> "Sequence[adsk.fusion.Occurrence]": ...

    @_cad_overload
    def _entities(self, kind: "Literal['body']", component: "adsk.fusion.Component | None" = None,
                  occurrence: "adsk.fusion.Occurrence | None" = None) -> "Sequence[adsk.fusion.BRepBody]": ...

    @_cad_overload
    def _entities(self, kind: "Literal['face']", component: "adsk.fusion.Component | None" = None,
                  occurrence: "adsk.fusion.Occurrence | None" = None) -> "Sequence[adsk.fusion.BRepFace]": ...

    @_cad_overload
    def _entities(self, kind: "Literal['edge']", component: "adsk.fusion.Component | None" = None,
                  occurrence: "adsk.fusion.Occurrence | None" = None) -> "Sequence[adsk.fusion.BRepEdge]": ...

    @_cad_overload
    def _entities(self, kind: "Literal['vertex']", component: "adsk.fusion.Component | None" = None,
                  occurrence: "adsk.fusion.Occurrence | None" = None) -> "Sequence[adsk.fusion.BRepVertex]": ...

    @_cad_overload
    def _entities(self, kind: "Literal['sketch']", component: "adsk.fusion.Component | None" = None,
                  occurrence: "adsk.fusion.Occurrence | None" = None) -> "Sequence[adsk.fusion.Sketch]": ...

    @_cad_overload
    def _entities(self, kind: "Literal['profile']", component: "adsk.fusion.Component | None" = None,
                  occurrence: "adsk.fusion.Occurrence | None" = None) -> "Sequence[adsk.fusion.Profile]": ...

    @_cad_overload
    def _entities(self, kind: "Literal['parameter']", component: "adsk.fusion.Component | None" = None,
                  occurrence: "adsk.fusion.Occurrence | None" = None) -> "Sequence[adsk.fusion.Parameter]": ...

    @_cad_overload
    def _entities(self, kind: "Literal['plane']", component: "adsk.fusion.Component | None" = None,
                  occurrence: "adsk.fusion.Occurrence | None" = None) -> "Sequence[adsk.fusion.ConstructionPlane]": ...

    @_cad_overload
    def _entities(self, kind: "Literal['axis']", component: "adsk.fusion.Component | None" = None,
                  occurrence: "adsk.fusion.Occurrence | None" = None) -> "Sequence[adsk.fusion.ConstructionAxis]": ...

    @_cad_overload
    def _entities(self, kind: "Literal['point']", component: "adsk.fusion.Component | None" = None,
                  occurrence: "adsk.fusion.Occurrence | None" = None) -> "Sequence[adsk.fusion.ConstructionPoint | adsk.fusion.SketchPoint]": ...

    @_cad_overload
    def _entities(self, kind: "Literal['feature']", component: "adsk.fusion.Component | None" = None,
                  occurrence: "adsk.fusion.Occurrence | None" = None) -> "Sequence[adsk.fusion.Feature]": ...

    @_cad_overload
    def _entities(self, kind: str | None = None, component: "adsk.fusion.Component | None" = None,
                  occurrence: "adsk.fusion.Occurrence | None" = None) -> "Sequence[CadEntity]": ...

    def _entities(self, kind: str | None=None, component: 'adsk.fusion.Component | None'=None, occurrence: 'adsk.fusion.Occurrence | None'=None) -> 'Sequence[CadEntity]':
        component = component or self.component
        supported = set(_CAD_KINDS.values()) | {'feature'}
        if kind is not None and kind not in supported:
            raise ValueError('Unsupported kind: ' + str(kind))
        entities: list[adsk.core.Base] = []
        if kind == 'component':
            return _cad_cast('list[adsk.core.Base]', _cad_items(self.design.allComponents))
        if kind == 'occurrence':
            return _cad_cast('list[adsk.core.Base]', _cad_items(self.root.allOccurrences))
        if kind == 'parameter':
            return _cad_cast('list[adsk.core.Base]', _cad_items(self.design.allParameters))
        for k, prop in (('body', 'bRepBodies'), ('sketch', 'sketches'), ('feature', 'features'),
                        ('plane', 'constructionPlanes'), ('axis', 'constructionAxes'),
                        ('point', 'constructionPoints')):
            if kind is None or kind == k:
                entities.extend(_cad_items(_cad_cast('_CadItemCollection[adsk.core.Base]', getattr(component, prop))))
        if kind in ('face', 'edge', 'vertex'):
            for body in _cad_items(component.bRepBodies):
                entities.extend(_cad_items(_cad_cast('_CadItemCollection[adsk.core.Base]', getattr(body, {'face': 'faces', 'edge': 'edges', 'vertex': 'vertices'}[kind]))))
        if kind == 'profile':
            for sketch in _cad_items(component.sketches):
                entities.extend(_cad_items(sketch.profiles))
        if kind == 'point':
            for sketch in _cad_items(component.sketches):
                entities.extend(_cad_items(sketch.sketchPoints))
        return [self._proxy(entity, occurrence) for entity in entities]

    @_cad_overload
    def resolve(self, ref: object, kind: "Literal['component']") -> "adsk.fusion.Component": ...

    @_cad_overload
    def resolve(self, ref: object, kind: "Literal['occurrence']") -> "adsk.fusion.Occurrence": ...

    @_cad_overload
    def resolve(self, ref: object, kind: "Literal['body']") -> "adsk.fusion.BRepBody": ...

    @_cad_overload
    def resolve(self, ref: object, kind: "Literal['face']") -> "adsk.fusion.BRepFace": ...

    @_cad_overload
    def resolve(self, ref: object, kind: "Literal['edge']") -> "adsk.fusion.BRepEdge": ...

    @_cad_overload
    def resolve(self, ref: object, kind: "Literal['vertex']") -> "adsk.fusion.BRepVertex": ...

    @_cad_overload
    def resolve(self, ref: object, kind: "Literal['sketch']") -> "adsk.fusion.Sketch": ...

    @_cad_overload
    def resolve(self, ref: object, kind: "Literal['profile']") -> "adsk.fusion.Profile": ...

    @_cad_overload
    def resolve(self, ref: object, kind: "Literal['plane']") -> "adsk.fusion.ConstructionPlane": ...

    @_cad_overload
    def resolve(self, ref: object, kind: "Literal['axis']") -> "adsk.fusion.ConstructionAxis": ...

    @_cad_overload
    def resolve(self, ref: object, kind: "Literal['point']") -> "adsk.fusion.ConstructionPoint | adsk.fusion.SketchPoint": ...

    @_cad_overload
    def resolve(self, ref: object, kind: "Literal['parameter']") -> "adsk.fusion.Parameter": ...

    @_cad_overload
    def resolve(self, ref: object, kind: "Literal['feature']") -> "adsk.fusion.Feature": ...

    @_cad_overload
    def resolve(self, ref: object, kind: str | None = None) -> "CadEntity": ...

    def resolve(self, ref: object, kind: str | None=None) -> 'CadEntity':
        if not isinstance(ref, (str, dict)):
            raise TypeError('Entity reference must be a name or reference object')
        if isinstance(ref, dict) and 'query' in ref:
            return _entity_resolve_reference(self, _cad_cast('JsonObject', ref), kind)
        data: JsonObject = _cad_cast('JsonObject', {'name': ref} if isinstance(ref, str) else dict(_cad_cast('dict[object, object]', ref)))
        reference_kind = _cad_cast('str | None', data.get('kind'))
        if kind and reference_kind and kind != reference_kind:
            raise ValueError('Reference kind conflicts with required kind')
        kind = kind or reference_kind
        component, occurrence = self._scope(data)
        name = _cad_cast('str | None', data.get('name'))
        if data.get('token'):
            candidates = list(self.design.findEntityByToken(_cad_cast('str', data['token'])))
            if data.get('path') is not None:
                natives = [getattr(e, 'nativeObject', None) or e for e in candidates]
                candidates = [e for e in _cad_items(self.root.allOccurrences)
                              if e.fullPathName == _cad_cast('str', data['path']) and
                              (getattr(e, 'nativeObject', None) or e) in natives]
            explicit_scope = 'component' in data or 'occurrence' in data
            if explicit_scope:
                candidates = [e for e in candidates if _cad_owner(e) == component]
            candidates = [e for e in candidates if not kind or _cad_kind(e) == kind]
            entity = _cad_unique(candidates, 'Entity token')
            # A token is authoritative over a stale display name, not over context or kind.
            if occurrence is not None and _cad_owner(entity) == component:
                entity = self._proxy(entity, occurrence)
        elif kind == 'profile' and 'sketch' in data:
            sketch_ref = data['sketch']
            if isinstance(sketch_ref, str):
                sketch_ref = {'name': sketch_ref}
            sketch_ref = dict(_cad_cast('JsonObject', sketch_ref))
            for key in ('component', 'occurrence'):
                if key in data:
                    sketch_ref[key] = data[key]
            sketch = self.resolve(sketch_ref, 'sketch')
            profiles = _cad_items(sketch.profiles)
            if 'loopCount' in data:
                loops = _cad_cast('int', data['loopCount'])
                if type(loops) is not int or loops < 1 or 'index' in data:
                    raise ValueError('Profile loopCount must be a positive integer and cannot be combined with index')
                entity = _cad_unique([p for p in profiles if p.profileLoops.count == loops],
                                     'Sketch profiles with loopCount %d' % loops)
            elif 'index' in data:
                index = _cad_cast('int', data['index'])
                if type(index) is not int or index < 0 or index >= len(profiles):
                    raise ValueError('Profile index must be an explicit in-range zero-based integer')
                entity = profiles[index]
            else:
                entity = _cad_unique(profiles, 'Sketch profiles; supply an explicit index when ambiguous')
            entity = _cad_cast('adsk.fusion.Profile', self._proxy(entity, _cad_cast('adsk.fusion.Occurrence | None', getattr(sketch, 'assemblyContext', None))))
            if 'index' in data:
                self._profile_selections.append((entity, _cad_cast('int', data['index'])))
        elif name == 'root':
            entity = self.root
        elif name in _CAD_ORIGINS:
            entity = self._proxy(_cad_cast('adsk.core.Base', getattr(component, _CAD_ORIGINS[name])), occurrence)
        else:
            if not isinstance(name, str) or not name:
                raise ValueError('Reference requires token, name, or a profile sketch')
            candidates = list(self._entities(kind, component, occurrence))
            if kind is None:
                candidates += list(self._entities('component')) + list(self._entities('occurrence'))
            matches = [e for e in candidates if _cad_cast('str | None', getattr(e, 'name', None)) == name or
                       (_cad_kind(e) == 'occurrence' and _cad_cast('adsk.fusion.Occurrence', e).fullPathName == name)]
            alias = _cad_cast('adsk.core.Attribute | None', self.root.attributes.itemByName(_CAD_ALIAS_GROUP, name))
            if alias:
                target = self.resolve(_cad_cast(object, json.loads(alias.value)))
                if (not kind or _cad_kind(target) == kind) and (_cad_owner(target) == component or
                                                              _cad_kind(target) in ('component', 'occurrence', 'parameter')):
                    target_context = _cad_cast('adsk.fusion.Occurrence | None', getattr(target, 'assemblyContext', None))
                    if occurrence is None or target_context is None or target_context == occurrence:
                        matches.append(self._proxy(target, occurrence))
            entity = _cad_unique(matches, 'Reference ' + name)
        if kind and _cad_kind(entity) != kind:
            raise ValueError('Expected %s, got %s' % (kind, _cad_kind(entity)))
        if _cad_kind(entity) == 'profile' and data.get('token') and ('index' in data or 'loopCount' in data):
            if 'sketch' not in data:
                raise ValueError('An explicit profile index or loopCount requires a sketch reference')
            selected = self.resolve({k: v for k, v in data.items() if k != 'token'}, 'profile')
            if (_cad_cast('adsk.core.Base', getattr(selected, 'nativeObject', None) or selected)) != (_cad_cast('adsk.core.Base', getattr(entity, 'nativeObject', None) or entity)):
                raise ValueError('Profile token disagrees with explicit sketch/index or loopCount selection')
            if 'index' in data:
                self._profile_selections.append((_cad_cast('adsk.fusion.Profile', entity), _cad_cast(int, data['index'])))
        return entity

    def ref(self, entity: 'adsk.core.Base') -> 'JsonRecord':
        # Fusion exposes a root token that findEntityByToken may not resolve.
        if entity == self.root:
            return {'kind': 'component', 'name': 'root'}
        result: JsonRecord = {'token': _cad_cast('str | None', getattr(entity, 'entityToken', None)), 'kind': _cad_kind(entity),
                  'name': _cad_cast('str | None', getattr(entity, 'name', None))}
        owner = _cad_owner(entity)
        if owner is not None and owner != entity:
            result['component'] = self.ref(owner)
        occurrence = _cad_cast('adsk.fusion.Occurrence | None', getattr(entity, 'assemblyContext', None))
        if occurrence is not None and result['kind'] != 'occurrence':
            result['occurrence'] = self.ref(occurrence)
        if result['kind'] == 'occurrence':
            result['path'] = _cad_cast('adsk.fusion.Occurrence', entity).fullPathName
        if result['kind'] == 'profile':
            result['sketch'] = self.ref(_cad_cast('adsk.fusion.Profile', entity).parentSketch)
            for selected, index in self._profile_selections:
                if selected == entity:
                    result['index'] = index
                    break
        return result

    def describe(self, entity: 'adsk.core.Base') -> 'JsonRecord':
        result = self.ref(entity)
        result['objectType'] = entity.objectType
        for key in ('isValid', 'isVisible', 'isSolid', 'isSuppressed', 'errorOrWarningMessage'):
            if hasattr(entity, key):
                result[key] = _cad_json(_cad_cast(object, getattr(entity, key)))
        if hasattr(entity, 'healthState'):
            state = _cad_cast(int, getattr(entity, 'healthState'))
            states = adsk.fusion.FeatureHealthStates
            result['healthState'] = {'value': int(state), 'name': next((n for n in
                ('HealthyFeatureHealthState', 'WarningFeatureHealthState', 'ErrorFeatureHealthState',
                 'SuppressedFeatureHealthState') if hasattr(states, n) and _cad_cast(int, getattr(states, n)) == state), 'unknown')}
        if hasattr(entity, 'boundingBox'):
            bounding_box = _cad_cast('adsk.core.BoundingBox3D', getattr(entity, 'boundingBox'))
            result['boundingBox'] = _cad_json(bounding_box)
            if _cad_kind(entity) == 'profile':
                _cad_cast('JsonRecord', result['boundingBox'])['space'] = 'sketch'
        if hasattr(entity, 'geometry'):
            geometry_value = _cad_cast(object, getattr(entity, 'worldGeometry') if hasattr(entity, 'worldGeometry') else getattr(entity, 'geometry'))
            geometry = _cad_cast('adsk.core.Base | None', geometry_value)
            result['geometry'] = _cad_geometry(geometry) if geometry is not None else None
            if result['geometry'] is not None:
                result['geometry']['space'] = 'assembly' if _cad_cast('adsk.fusion.Occurrence | None', getattr(entity, 'assemblyContext', None)) else 'component local'
        for prop, unit in (('area', 'cm^2'), ('volume', 'cm^3'), ('length', 'cm')):
            if hasattr(entity, prop):
                result[prop] = {'value': float(_cad_cast('int | float', getattr(entity, prop))), 'units': unit}
        if _cad_kind(entity) == 'profile':
            profile = _cad_cast('adsk.fusion.Profile', entity)
            area = profile.areaProperties()
            result['area'] = {'value': area.area, 'units': 'cm^2'}
            _cad_cast('JsonRecord', result['area'])['accuracy'] = 'Fusion default low accuracy, approximately +/- 1%'
            result['centroid'] = {'xyz': _cad_xyz(area.centroid), 'units': 'cm', 'space': 'sketch'}
            result['loops'] = profile.profileLoops.count
            result['indexStability'] = 'Profile indices are topology-dependent; re-inspect after sketch edits'
        if _cad_kind(entity) == 'occurrence':
            result['transform'] = _cad_json(_cad_cast('object', _cad_cast('adsk.fusion.Occurrence', entity).transform2))
        if _cad_kind(entity) == 'parameter':
            result.update(_cad_parameter_info(self, _cad_cast('adsk.fusion.Parameter', entity)))
        return result

    def _expression(self, expression: object, units: str | None=None, unitless: bool=False) -> tuple[str, float]:
        if not isinstance(expression, str) or not expression.strip():
            raise ValueError('Dimension expressions must be nonempty strings with units or parameter references')
        expression = expression.strip()
        # Strip numeric literals first so the exponent in 1e3 is not mistaken for a unit.
        words = _cad_cast('list[str]', re.findall(r'[A-Za-z_][A-Za-z_0-9]*', re.sub(
            r'(?<![A-Za-z_0-9])(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?', '', expression)))
        constants = {'pi', 'PI', 'e', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
                     'atan2', 'sqrt', 'abs', 'min', 'max', 'floor', 'ceil', 'round', 'exp', 'log', 'ln'}
        if not unitless and not any(w not in constants for w in words):
            raise ValueError('Explicit units or a parameter reference are required: ' + expression)
        manager = self.design.unitsManager
        candidates = [units or _CAD_UNITLESS] if units is not None else ['cm', 'rad', _CAD_UNITLESS, 'cm^2', 'cm^3', 'kg', 's']
        valid = next((u for u in candidates if manager.isValidExpression(expression, u)), None)
        if valid is None:
            raise ValueError('Invalid or incompatible expression %r for units %r' % (expression, units))
        if units and manager.isValidExpression(expression, _CAD_UNITLESS):
            raise ValueError('Dimensionless expression cannot implicitly acquire units: ' + expression)
        value = manager.evaluateExpression(expression, valid)
        if not math.isfinite(value):
            raise ValueError('Expression evaluated to a non-finite value: ' + expression)
        # -1 is a valid signed dimension; validity was checked before evaluation.
        return expression, value

    def value(self, expression: object) -> 'adsk.core.ValueInput':
        expression, unused = self._expression(expression)
        return adsk.core.ValueInput.createByString(expression)

    def length(self, expression: object) -> float:
        return self._expression(expression, 'cm')[1]

    def angle(self, expression: object) -> float:
        return self._expression(expression, 'rad')[1]

    def point(self, coordinates: object) -> 'adsk.core.Point3D':
        if not isinstance(coordinates, (list, tuple)):
            raise ValueError('Point requires three length expressions')
        values = _cad_cast('list[object] | tuple[object, ...]', coordinates)
        if len(values) != 3:
            raise ValueError('Point requires three length expressions')
        point = adsk.core.Point3D.create(*(self.length(v) for v in values))
        return _cad_cast('adsk.core.Point3D', point)

    def collection(self, entities: 'Iterable[adsk.core.Base]') -> 'adsk.core.ObjectCollection':
        result = adsk.core.ObjectCollection.create()
        for entity in entities:
            _cad_require_result(result.add(entity), 'Add entity to collection')
        return result

    def call(self, operation: str, data: object) -> 'JsonValue':
        if hasattr(CAD_HANDLERS, 'dispatch'):
            return CAD_HANDLERS.dispatch(self, operation, data)
        if operation not in CAD_HANDLERS:
            raise ValueError('Unsupported CAD operation: ' + str(operation))
        if not isinstance(data, dict):
            raise TypeError('Operation data must be an object')
        return CAD_HANDLERS[operation](self, _cad_cast('JsonObject', data))

    def require_confirm(self, data: 'JsonObject') -> None:
        if data.get('confirm') is not True:
            raise ValueError('This operation requires confirm: true')


def _cad_entity_list(ctx: 'CadContext', data: 'JsonObject') -> 'JsonRecord':
    _cad_fields(data, optional=('kind', 'component', 'occurrence'))
    scope = _cad_cast('Callable[[JsonObject], tuple[adsk.fusion.Component, adsk.fusion.Occurrence | None]]',
                      getattr(ctx, '_scope'))
    component, occurrence = scope(data)
    entities = _cad_cast('Callable[[str | None, adsk.fusion.Component | None, adsk.fusion.Occurrence | None], Sequence[CadEntity]]',
                         getattr(ctx, '_entities'))
    kind = _cad_cast('str | None', data.get('kind'))
    return {'entities': [ctx.describe(e) for e in entities(kind, component, occurrence)]}


def _cad_entity_inspect(ctx: 'CadContext', data: 'JsonObject') -> 'JsonValue':
    return _cad_cast('JsonValue', _entity_inspect(ctx, data))


def _cad_direction(value: object) -> list[float]:
    if not isinstance(value, (list, tuple)) or len(value) != 3 or any(
            isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in value):
        raise ValueError('Direction must be three finite unitless numbers')
    norm = math.hypot(*value)
    if norm == 0 or not math.isfinite(norm):
        raise ValueError('Direction cannot be zero or have non-finite magnitude')
    return [x / norm for x in value]


def _cad_entity_find(ctx: 'CadContext', data: 'JsonObject') -> 'JsonValue':
    return _cad_cast('JsonValue', _entity_find(ctx, data))


def _cad_entity_alias(ctx: 'CadContext', data: 'JsonObject') -> 'JsonRecord':
    _cad_fields(data, ('ref', 'alias'), ('confirm',))
    alias = data['alias']
    if not isinstance(alias, str) or not alias or alias in _CAD_ORIGINS or alias == 'root' or alias.startswith('re:'):
        raise ValueError('Alias must be a nonempty non-reserved name')
    target = ctx.resolve(data['ref'])
    reference = ctx.ref(target)
    if not reference.get('token'):
        raise ValueError('Persistent alias requires an entity token')
    old = _cad_cast('adsk.core.Attribute | None', ctx.root.attributes.itemByName(_CAD_ALIAS_GROUP, alias))
    if old and data.get('confirm') is not True:
        old_target = ctx.resolve(_cad_cast(object, json.loads(old.value)))
        if old_target == target:
            return {'alias': alias, 'ref': reference, 'changed': False}
        ctx.require_confirm(data)
    _cad_require_result(ctx.root.attributes.add(_CAD_ALIAS_GROUP, alias, json.dumps(reference)), 'Store alias')
    return {'alias': alias, 'ref': reference, 'changed': True}


def _cad_active_selection(ctx: 'CadContext') -> 'adsk.core.Selections':
    if ctx.app.activeDocument != ctx.doc:
        raise ValueError('Selection operations require the target document to already be active')
    return ctx.app.userInterface.activeSelections


def _cad_selection_inspect(ctx: 'CadContext', data: 'JsonObject') -> 'JsonRecord':
    _cad_fields(data)
    selections = _cad_active_selection(ctx)
    return {'selections': [{'entity': ctx.describe(s.entity), 'point': _cad_xyz(s.point),
                            'pointUnits': 'cm'} for s in _cad_items(selections)]}


def _cad_selection_highlight(ctx: 'CadContext', data: 'JsonObject') -> 'JsonRecord':
    _cad_fields(data, ('refs',), ('replace',))
    selections = _cad_active_selection(ctx)
    refs = data['refs']
    if not isinstance(refs, list):
        raise ValueError('refs must be an array (empty array clears when replace is true)')
    entities = [ctx.resolve(ref) for ref in refs]
    if data.get('replace', True) is True:
        _cad_require_result(selections.clear(), 'Clear selection')
    for entity in entities:
        _cad_require_result(selections.add(entity), 'Highlight selection')
    return {'highlighted': [ctx.ref(e) for e in entities], 'selectionCount': selections.count}


def _cad_parameter_info(ctx: 'CadContext', parameter: 'adsk.fusion.Parameter') -> 'JsonRecord':
    attribute = _cad_cast('adsk.core.Attribute | None', parameter.attributes.itemByName(_CAD_PARAM_GROUP, 'metadata'))
    is_text = parameter.unit.lower() == 'text'
    return {'name': parameter.name, 'expression': parameter.expression, 'unit': parameter.unit,
            'value': parameter.textValue if is_text else parameter.value,
            'valueType': 'text' if is_text else 'numeric',
            'valueUnits': None if is_text else 'Fusion internal units (cm, rad, kg, s)',
            'comment': parameter.comment, 'metadata': _cad_cast('JsonValue', json.loads(attribute.value)) if attribute else {}}


def _cad_param_inspect(ctx: 'CadContext', data: 'JsonObject') -> 'JsonRecord':
    _cad_fields(data, optional=('names', 'includeModel'))
    names = data.get('names')
    if names is not None and (not isinstance(names, list) or any(not isinstance(n, str) for n in names)):
        raise ValueError('names must be an array of parameter names')
    names = _cad_cast('list[str] | None', names)
    parameters = _cad_items(ctx.design.allParameters if data.get('includeModel') is True else ctx.design.userParameters)
    if names is not None:
        parameters = [_cad_unique([p for p in parameters if p.name == n], 'Parameter ' + n) for n in names]
    return {'parameters': [_cad_parameter_info(ctx, p) for p in parameters]}


def _cad_param_dependencies(ctx: 'CadContext', data: 'JsonObject') -> 'JsonRecord':
    _cad_fields(data, optional=('name',))
    parameters = _cad_items(ctx.design.allParameters)
    if 'name' in data:
        name = _cad_cast('str', data['name'])
        parameters = [_cad_unique([p for p in parameters if p.name == name], 'Parameter ' + name)]
    result: list[JsonValue] = []
    for parameter in parameters:
        row: JsonRecord = {'name': parameter.name, 'expression': parameter.expression}
        for key, prop in (('dependsOn', 'dependencyParameters'), ('usedByParameters', 'dependentParameters')):
            row[key] = [p.name for p in _cad_items(_cad_cast('_CadItemCollection[_CadNamed]', getattr(parameter, prop)))] if hasattr(parameter, prop) else None
        result.append(row)
    return {'parameters': result, 'coverage': 'partial', 'limitations': [
        'Reports parameter equation dependencies exposed by Fusion, not every feature, geometry, script, or external design consumer.',
        'Null dependency lists mean the installed API does not expose that direction of dependency.']}


def _cad_param_apply(ctx: 'CadContext', data: 'JsonObject') -> 'JsonRecord':
    _cad_fields(data, ('parameters',), ('overwrite', 'confirm'))
    specifications = data['parameters']
    if not isinstance(specifications, list) or not specifications:
        raise ValueError('parameters must be a nonempty array')
    specifications = _cad_cast('list[object]', specifications)
    all_parameters: dict[str, adsk.fusion.Parameter] = {
        p.name: p for p in _cad_items(ctx.design.allParameters)}
    user_parameters: dict[str, adsk.fusion.Parameter] = {
        p.name: p for p in _cad_items(ctx.design.userParameters)}
    pending: dict[str, _ParameterUpdate] = {}
    for spec_value in specifications:
        if not isinstance(spec_value, dict):
            raise ValueError('Parameter entries accept name, expression, unit, comment, metadata only')
        spec = _cad_cast('dict[str, object]', spec_value)
        if set(spec) - {'name', 'expression', 'unit', 'comment', 'metadata'}:
            raise ValueError('Parameter entries accept name, expression, unit, comment, metadata only')
        name = spec.get('name')
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', name):
            raise ValueError('Parameter name must be an ASCII identifier')
        if name in pending:
            raise ValueError('Duplicate parameter in batch: ' + name)
        if name in all_parameters and name not in user_parameters:
            raise ValueError('Cannot overwrite a model parameter: ' + name)
        old = user_parameters.get(name)
        previous = _cad_parameter_info(ctx, old) if old else {}
        unit = spec.get('unit', previous.get('unit'))
        if not isinstance(unit, str):
            raise ValueError('New parameters require unit; use an empty string for unitless counts')
        if unit.lower() == 'text':
            raise ValueError('Text parameters are unsupported; param.apply handles numeric parameters only')
        if old and unit != old.unit:
            raise ValueError('Changing parameter unit is unsupported: ' + name)
        expression = spec.get('expression')
        if unit == '' and type(expression) in (int, float):
            if not math.isfinite(_cad_cast('int | float', expression)):
                raise ValueError('Unitless value must be finite')
            expression = str(expression)
        if not isinstance(expression, str) or not expression.strip():
            raise ValueError('Parameter expression must be a nonempty string; only unitless values may be numeric')
        comment = spec.get('comment', previous.get('comment', ''))
        metadata = dict(_cad_cast('JsonObject', previous.get('metadata', {})))
        additions = spec.get('metadata', {})
        if not isinstance(comment, str) or not isinstance(additions, dict):
            raise ValueError('comment must be text; metadata accepts protected, source, tolerance only')
        additions = _cad_cast('dict[str, JsonValue]', additions)
        if set(additions) - {'protected', 'source', 'tolerance'}:
            raise ValueError('comment must be text; metadata accepts protected, source, tolerance only')
        if 'protected' in additions and type(additions['protected']) is not bool:
            raise ValueError('metadata.protected must be boolean')
        if 'source' in additions and not isinstance(additions['source'], str):
            raise ValueError('metadata.source must be text')
        metadata.update(additions)
        metadata = _cad_cast('JsonRecord', _cad_json(metadata))
        changed = not old or (re.sub(r'\s+', '', expression) != re.sub(r'\s+', '', old.expression)
                              or comment != old.comment or metadata != previous['metadata'])
        if old and changed:
            if data.get('overwrite') is not True:
                raise ValueError('Updating %s requires overwrite: true' % name)
            if _cad_cast('JsonObject', previous['metadata']).get('protected') is True:
                ctx.require_confirm(data)
        pending[name] = {'old': old, 'expression': expression.strip(), 'unit': unit,
                         'comment': comment, 'metadata': metadata, 'changed': changed}
    expressions: dict[str, str] = {n: p.expression for n, p in all_parameters.items()}
    expressions.update({n: p['expression'] for n, p in pending.items()})
    expanded: dict[str, str] = {}
    visiting: set[str] = set()
    order: list[str] = []

    def expand(name: str) -> str:
        if name in expanded:
            return expanded[name]
        if name in visiting:
            raise ValueError('Cyclic parameter dependency involving ' + name)
        visiting.add(name)
        expression = expressions[name]
        if name not in pending and all_parameters[name].unit:
            # Preserve existing UI parameters' implicit display units before
            # substituting dependencies, without multiplying explicit units twice.
            expression = ctx.design.unitsManager.standardizeExpression(expression, all_parameters[name].unit)
            if not expression:
                raise ValueError('Cannot standardize existing parameter expression: ' + name)
        expression = re.sub(r'\b[A-Za-z_][A-Za-z_0-9]*\b',
                            lambda m: '(' + expand(m[0]) + ')' if m[0] in expressions else m[0], expression)
        visiting.remove(name)
        expanded[name] = expression
        if name in pending:
            order.append(name)
        return expression

    # Expansion validates forward references without adding temporary live parameters.
    for name in pending:
        expand(name)
    for name in order:
        spec = pending[name]
        evaluate = _cad_cast('Callable[[object, str | None, bool], tuple[str, float]]', getattr(ctx, '_expression'))
        evaluate(expanded[name], spec['unit'], spec['unit'] == '')
        tolerance = spec['metadata'].get('tolerance')
        if tolerance is not None:
            if not isinstance(tolerance, str):
                raise ValueError('metadata.tolerance must be a nonnegative expression in parameter units')
            if evaluate(tolerance, spec['unit'], spec['unit'] == '')[1] < 0:
                raise ValueError('metadata.tolerance cannot be negative')
    result: list[JsonValue] = []
    for name in order:
        spec = pending[name]
        parameter = spec['old']
        if spec['changed']:
            if parameter is None:
                parameter = _cad_require_result(ctx.design.userParameters.add(name,
                    adsk.core.ValueInput.createByString(spec['expression']), spec['unit'], spec['comment']), 'Create parameter ' + name)
                ctx.created.append(ctx.ref(parameter))
            else:
                parameter.expression = spec['expression']
                parameter.comment = spec['comment']
            if spec['metadata']:
                _cad_require_result(parameter.attributes.add(_CAD_PARAM_GROUP, 'metadata',
                                                            json.dumps(spec['metadata'])), 'Store parameter metadata')
        result.append(dict(_cad_parameter_info(ctx, _cad_cast('adsk.fusion.Parameter', parameter)), changed=spec['changed']))
    return {'parameters': result, 'prevalidated': True, 'atomic': False}


def _cad_datum_name(ctx: 'CadContext', data: 'JsonObject', collection: '_CadItemCollection[_CadNamed] | list[_CadNamed] | tuple[_CadNamed, ...]') -> str:
    name = data['name']
    if not isinstance(name, str) or not name.strip():
        raise ValueError('Datum name must be nonempty')
    if any(e.name == name for e in _cad_items(collection)):
        raise ValueError('Datum already exists: ' + name)
    return name


def _cad_datum_finish(ctx: 'CadContext', entity: 'adsk.fusion.ConstructionPlane | adsk.fusion.ConstructionAxis | adsk.fusion.ConstructionPoint', name: str) -> 'JsonRecord':
    entity = _cad_require_result(entity, 'Create datum')
    entity.name = name
    proxy = _cad_cast('Callable[[CadEntity, adsk.fusion.Occurrence | None], CadEntity]', getattr(ctx, '_proxy'))
    entity = _cad_cast('adsk.fusion.ConstructionPlane | adsk.fusion.ConstructionAxis | adsk.fusion.ConstructionPoint',
                       proxy(entity, ctx.occurrence))
    ctx.created.append(ctx.ref(entity))
    return ctx.describe(entity)


@_cad_scoped_step('datum.plane')
def _cad_datum_plane(ctx: 'CadContext', data: 'JsonObject') -> 'JsonRecord':
    _cad_fields(data, ('name',), ('mode', 'plane', 'offset', 'plane1', 'plane2', 'axis', 'angle'))
    planes = ctx.component.constructionPlanes
    name = _cad_datum_name(ctx, data, planes)
    mode = data.get('mode', 'offset')
    inp = planes.createInput()
    if ctx.occurrence is not None:
        inp.creationOccurrence = ctx.occurrence
    if mode == 'offset':
        _cad_fields(data, ('name', 'offset'), ('mode', 'plane'))
        plane = ctx.resolve(data.get('plane', 'XY'))
        ctx.length(data['offset'])
        ok = inp.setByOffset(plane, ctx.value(data['offset']))
    elif mode == 'mid':
        _cad_fields(data, ('name', 'plane1', 'plane2'), ('mode',))
        ok = inp.setByTwoPlanes(ctx.resolve(data['plane1']), ctx.resolve(data['plane2']))
    elif mode == 'angle':
        _cad_fields(data, ('name', 'axis', 'angle', 'plane'), ('mode',))
        ctx.angle(data['angle'])
        ok = inp.setByAngle(ctx.resolve(data['axis']), ctx.value(data['angle']), ctx.resolve(data['plane']))
    else:
        raise ValueError('Unsupported plane mode; accepted: offset, mid, angle')
    _cad_require_result(ok, 'Define datum plane')
    return _cad_datum_finish(ctx, planes.add(inp), name)


@_cad_scoped_step('datum.axis')
def _cad_datum_axis(ctx: 'CadContext', data: 'JsonObject') -> 'JsonRecord':
    _cad_fields(data, ('name', 'mode'), ('face', 'plane1', 'plane2', 'point1', 'point2', 'edge'))
    axes = ctx.component.constructionAxes
    name = _cad_datum_name(ctx, data, axes)
    mode = data['mode']
    inp = axes.createInput()
    if ctx.occurrence is not None:
        inp.creationOccurrence = ctx.occurrence
    if mode == 'circularFace':
        _cad_fields(data, ('name', 'mode', 'face'))
        ok = inp.setByCircularFace(ctx.resolve(data['face'], 'face'))
    elif mode == 'twoPlanes':
        _cad_fields(data, ('name', 'mode', 'plane1', 'plane2'))
        ok = inp.setByTwoPlanes(ctx.resolve(data['plane1']), ctx.resolve(data['plane2']))
    elif mode == 'twoPoints':
        _cad_fields(data, ('name', 'mode', 'point1', 'point2'))
        ok = inp.setByTwoPoints(ctx.resolve(data['point1']), ctx.resolve(data['point2']))
    elif mode == 'edge':
        _cad_fields(data, ('name', 'mode', 'edge'))
        ok = inp.setByEdge(ctx.resolve(data['edge']))
    else:
        raise ValueError('Unsupported axis mode; accepted: circularFace, twoPlanes, twoPoints, edge')
    _cad_require_result(ok, 'Define datum axis')
    return _cad_datum_finish(ctx, axes.add(inp), name)


@_cad_scoped_step('datum.point')
def _cad_datum_point(ctx: 'CadContext', data: 'JsonObject') -> 'JsonRecord':
    _cad_fields(data, ('name',), ('mode', 'point', 'plane1', 'plane2', 'plane3', 'ref'))
    points = ctx.component.constructionPoints
    name = _cad_datum_name(ctx, data, points)
    mode = data.get('mode', 'coordinates')
    inp = points.createInput()
    helpers: list[adsk.fusion.ConstructionPlane] = []
    if mode == 'coordinates':
        _cad_fields(data, ('name', 'point'), ('mode',))
        coordinates = _cad_cast('list[object] | tuple[object, ...]', data['point'])
        ctx.point(coordinates)
        # Three expression-driven offset planes keep all signed coordinates parametric,
        # including zero crossings where unsigned sketch dimensions become fragile.
        helper_names = [name + '__' + axis for axis in ('x', 'y', 'z')]
        for helper_name in helper_names:
            _cad_datum_name(ctx, {'name': helper_name}, ctx.component.constructionPlanes)
        for plane, expression, helper_name in zip(('YZ', 'XZ', 'XY'), coordinates, helper_names):
            base = _cad_cast('adsk.fusion.ConstructionPlane', getattr(ctx.component, _CAD_ORIGINS[plane]))
            normal = _cad_xyz(base.geometry.normal)
            coordinate_index = {'YZ': 0, 'XZ': 1, 'XY': 2}[plane]
            offset = expression if normal[coordinate_index] > 0 else '-(' + _cad_cast('str', expression) + ')'
            pi = ctx.component.constructionPlanes.createInput()
            _cad_require_result(pi.setByOffset(base, ctx.value(offset)), 'Define point helper plane')
            helper = _cad_require_result(ctx.component.constructionPlanes.add(pi), 'Create point helper plane')
            helper.name = helper_name
            helper.isLightBulbOn = False
            helpers.append(helper)
        ok = inp.setByThreePlanes(*helpers)
    elif mode == 'threePlanes':
        _cad_fields(data, ('name', 'plane1', 'plane2', 'plane3'), ('mode',))
        planes = [ctx.resolve(data[key]) for key in ('plane1', 'plane2', 'plane3')]
        if any(getattr(p, 'assemblyContext', None) is not None or _cad_owner(p) != ctx.component for p in planes):
            raise ValueError('Point threePlanes requires native planes in the selected component')
        ok = inp.setByThreePlanes(*planes)
    elif mode == 'reference':
        _cad_fields(data, ('name', 'ref'), ('mode',))
        point = ctx.resolve(data['ref'])
        if _cad_type(point) not in ('SketchPoint', 'BRepVertex'):
            raise ValueError('Point reference mode supports only SketchPoint or BRepVertex entities')
        if getattr(point, 'assemblyContext', None) is not None or _cad_owner(point) != ctx.component:
            raise ValueError('Point reference requires a native point/vertex in the selected component')
        ok = inp.setByPoint(point)
    else:
        raise ValueError('Unsupported point mode; accepted: coordinates, threePlanes, reference')
    _cad_require_result(ok, 'Define datum point')
    result = _cad_datum_finish(ctx, points.add(inp), name)
    if helpers:
        result['representation'] = 'intersection of three expression-driven offset planes'
        result['helpers'] = [ctx.ref(h) for h in helpers]
    return result


def _cad_datum_frame(ctx: 'CadContext', data: 'JsonObject') -> 'JsonRecord':
    _cad_fields(data, ('name', 'origin', 'xAxis', 'yAxis'), ('mode', 'confirm'))
    name = data['name']
    if not isinstance(name, str) or not name.strip():
        raise ValueError('Frame name must be nonempty')
    if data.get('mode', 'metadata') != 'metadata':
        raise ValueError('Only frame mode metadata is supported; no native custom frame is created')
    origin = ctx.point(data['origin'])
    x = _cad_direction(data['xAxis'])
    y = _cad_direction(data['yAxis'])
    if abs(sum(a * b for a, b in zip(x, y))) > 1e-9:
        raise ValueError('Frame xAxis and yAxis must be perpendicular')
    z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]]
    matrix = adsk.core.Matrix3D.create()
    _cad_require_result(matrix.setWithCoordinateSystem(origin, adsk.core.Vector3D.create(*x),
        adsk.core.Vector3D.create(*y), adsk.core.Vector3D.create(*z)), 'Define frame transform')
    result = {'name': name, 'kind': 'frame', 'representation': 'named transform metadata',
              'component': ctx.ref(ctx.component), 'matrix': list(matrix.asArray()), 'lengthUnits': 'cm',
              'originExpressions': data['origin'], 'xAxis': x, 'yAxis': y,
              'parametric': False, 'space': 'component local',
              'limitations': ['Snapshot transform; origin expressions are recorded but not regenerated automatically.',
                              'Not a native Fusion coordinate system or a resolvable modeling entity.',
                              'Fusion UserCoordinateSystem is preview-only and documented as unsuitable for distributed programs.']}
    old = _cad_cast('adsk.core.Attribute | None', ctx.component.attributes.itemByName(_CAD_FRAME_GROUP, name))
    if old:
        if json.loads(old.value) == result:
            return dict(result, changed=False)
        ctx.require_confirm(data)
    _cad_require_result(ctx.component.attributes.add(_CAD_FRAME_GROUP, name, json.dumps(result)), 'Store frame metadata')
    if old is None:
        ctx.created.append({'token': None, 'kind': 'frame', 'name': name, 'component': ctx.ref(ctx.component),
                            'representation': 'named transform metadata'})
    return dict(result, changed=True)


_CAD_CORE_HANDLERS: dict[str, CadHandler] = {
    'entity.list': _cad_entity_list, 'entity.inspect': _cad_entity_inspect,
    'entity.find': _cad_entity_find, 'entity.alias': _cad_entity_alias,
    'selection.inspect': _cad_selection_inspect, 'selection.highlight': _cad_selection_highlight,
    'param.apply': _cad_param_apply, 'param.inspect': _cad_param_inspect,
    'param.dependencies': _cad_param_dependencies,
    'datum.plane': lambda ctx, data: _datum_existing(ctx, data, 'plane') if 'schemaVersion' in data or 'frame' in data else _cad_datum_plane(ctx, data),
    'datum.axis': lambda ctx, data: _datum_existing(ctx, data, 'axis') if 'schemaVersion' in data or 'frame' in data else _cad_datum_axis(ctx, data),
    'datum.point': lambda ctx, data: _datum_existing(ctx, data, 'point') if 'schemaVersion' in data or 'frame' in data else _cad_datum_point(ctx, data),
    'datum.frame': lambda ctx, data: _datum_frame(ctx, data) if any(k in data for k in ('schemaVersion', 'frame', 'onExisting')) else _cad_datum_frame(ctx, data),
}
CAD_HANDLERS.update(_CAD_CORE_HANDLERS)
