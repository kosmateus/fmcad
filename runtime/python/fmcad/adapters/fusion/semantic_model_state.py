"""Read-only Fusion observations, independent of entity/datum transform helpers.

This adapter uses root.allOccurrences proxies for root-space transform2 and
nativeObject transform2 ONLY for the separate native-chain observation.
"""
from typing import Protocol as _SemanticFusionProtocol, TypeVar as _SemanticFusionTypeVar
from typing import cast as _semantic_fusion_cast
from typing import TYPE_CHECKING as _SEMANTIC_FUSION_TYPE_CHECKING


_SemanticFusionItem = _SemanticFusionTypeVar('_SemanticFusionItem')


if _SEMANTIC_FUSION_TYPE_CHECKING:
    class _SemanticFusionOccurrence(_SemanticFusionProtocol):
        fullPathName: str


def _semantic_fusion_items(collection: "_CadItemCollection[_SemanticFusionItem]") -> "list[_SemanticFusionItem]":
    return [collection.item(i) for i in range(collection.count)]


def _semantic_fusion_xyz(point: "adsk.core.Point3D | adsk.core.Vector3D") -> list[float]:
    return [float(point.x), float(point.y), float(point.z)]


def _semantic_fusion_document(document: "adsk.core.Document") -> "JsonRecord":
    file = document.dataFile if document.isSaved else None
    return {'creationId': document.creationId,
            'fileId': file.id if file else None,
            'version': file.versionNumber if file else None}


def _semantic_fusion_occurrence(ctx: "CadContext", path: "JsonValue") -> "adsk.fusion.Occurrence":
    if not isinstance(path, list) or not path or not all(isinstance(p, str) and p for p in path):
        raise ValueError('An explicit nonempty root-qualified occurrence path is required')
    occurrence_path = _semantic_fusion_cast('list[str]', path)
    matches: list[adsk.fusion.Occurrence] = []
    for item in _semantic_fusion_items(ctx.root.allOccurrences):
        occurrence = _semantic_fusion_cast('_SemanticFusionOccurrence', item)
        if occurrence.fullPathName.split('+') == occurrence_path:
            matches.append(item)
    if len(matches) != 1:
        raise ValueError('Occurrence path must resolve uniquely')
    return matches[0]


def _semantic_fusion_pair(ctx: "CadContext", data: "JsonObject") -> "tuple[adsk.fusion.BRepBody, adsk.fusion.BRepBody, adsk.fusion.Occurrence | None]":
    body = ctx.resolve(data['ref'], 'body')
    native = _semantic_fusion_cast('adsk.fusion.BRepBody', getattr(body, 'nativeObject', None) or body)
    path_value = data['instance']
    if not isinstance(path_value, list):
        raise ValueError('An explicit occurrence path array is required')
    path = _semantic_fusion_cast('list[str]', path_value)
    occurrence = _semantic_fusion_occurrence(ctx, path) if path else None
    if occurrence is None:
        if native.parentComponent != ctx.root:
            raise ValueError('A non-root body requires an explicit instance')
        proxy = native
    else:
        if native.parentComponent != occurrence.component:
            raise ValueError('Body source and occurrence component disagree')
        supplied_context = _semantic_fusion_cast(
            'adsk.fusion.Occurrence | None', getattr(body, 'assemblyContext', None))
        if supplied_context is not None and supplied_context.fullPathName != occurrence.fullPathName:
            raise ValueError('Body proxy context disagrees with explicit instance')
        proxy = native.createForAssemblyContext(occurrence)
    return native, proxy, occurrence


def _semantic_fusion_witnesses(native: "adsk.fusion.BRepBody",
                               occurrence: "adsk.fusion.Occurrence | None",
                               limit: int) -> "list[JsonRecord]":
    witnesses: list[JsonRecord] = []
    for vertex in _semantic_fusion_items(native.vertices)[:limit]:
        proxy = vertex.createForAssemblyContext(occurrence) if occurrence else vertex
        witnesses.append({'nativePoint': _semantic_fusion_xyz(vertex.geometry),
                          'proxyPoint': _semantic_fusion_xyz(proxy.geometry)})
    return witnesses


def _semantic_fusion_frame_observation(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    ctx.assert_identity()
    if not isinstance(data.get('sourceId'), str) or not data['sourceId']:
        raise ValueError('Explicit sourceId is required')
    datum_source = data.get('datumSource')
    if not isinstance(datum_source, dict) or not datum_source.get('kind') or datum_source.get('version') is None:
        raise ValueError('Independent datumSource kind/version provenance is required')
    datum_source_record = datum_source
    native, proxy, occurrence = _semantic_fusion_pair(ctx, data)
    path = _semantic_fusion_cast('list[str]', data['instance'])
    chain: list[list[int | float]] = []
    for depth in range(1, len(path)+1):
        qualified = _semantic_fusion_occurrence(ctx, path[:depth])
        local = getattr(qualified, 'nativeObject', None)
        # Top-level occurrences are native in root; nested proxies must expose
        # nativeObject. Never silently compose already root-qualified proxies.
        if depth > 1 and local is None:
            raise ValueError('Nested native occurrence observation unavailable')
        chain.append(list((local or qualified).transform2.asArray()))
    observation: "JsonRecord" = {
        'instance': path,
        'source': {'id': data['sourceId'],
                   'document': _semantic_fusion_document(native.parentComponent.parentDesign.parentDocument)},
        'document': _semantic_fusion_document(ctx.design.parentDocument),
        'datumToRoot': list(_semantic_fusion_cast('list[JsonValue]', data['datumToRoot'])),
        'datumSource': dict(datum_source_record),
        'proxyToRoot': list(occurrence.transform2.asArray()) if occurrence else list(_SEMANTIC_IDENTITY),
        'nativeChain': chain,
        'brepWitnesses': _semantic_fusion_witnesses(native, occurrence, 16),
        'visibility': {'nativeLightBulb': native.isLightBulbOn, 'proxyVisible': proxy.isVisible},
        'observedBy': {'native': 'nativeObject.transform2 chain',
                       'proxy': 'root.allOccurrences.transform2 (already root qualified)',
                       'brep': 'native/proxy BRepVertex.geometry', 'lengthUnit': 'cm'},
    }
    ctx.assert_identity()
    return observation


def _semantic_fusion_entities(ctx: "CadContext", request: "JsonObject") -> "list[JsonRecord]":
    ctx.assert_identity()
    document = _semantic_fusion_document(ctx.design.parentDocument)
    scope_value = request.get('scope')
    if not isinstance(scope_value, dict):
        raise ValueError('Scope must be an object')
    scope = scope_value
    if scope.get('document') != document or scope.get('kind') != 'explicit-bindings':
        raise ValueError('Scope must pin the actual document and explicit-bindings coverage')
    entities: list[JsonRecord] = []
    bindings_value = request.get('bindings')
    if not isinstance(bindings_value, list) or any(not isinstance(binding, dict) for binding in bindings_value):
        raise ValueError('Explicit semantic bindings must be an array of objects')
    bindings = _semantic_fusion_cast('list[JsonObject]', bindings_value)
    for binding in bindings:
        native, proxy, occurrence = _semantic_fusion_pair(ctx, binding)
        box = native.boundingBox  # Geometry observations are component-local, not pose-dependent.
        component = native.parentComponent
        attributes = sorted([{'group': a.groupName, 'name': a.name, 'value': a.value}
                             for a in _semantic_fusion_items(native.attributes)],
                            key=lambda a: (a['group'], a['name']))
        entity_record: "JsonRecord" = {
            'role': binding['role'], 'instance': binding['instance'],
            'source': {'id': binding['sourceId'],
                       'document': _semantic_fusion_document(component.parentDesign.parentDocument)},
            # Tokens are diagnostics, NOT semantic identity and never used to
            # merge repeated instances. Caller binds role/sourceId explicitly.
            'observedTokens': {'body': native.entityToken,
                               'occurrence': occurrence.entityToken if occurrence else None},
            'geometry': {'volumeCm3': native.volume, 'areaCm2': native.area,
                         'boundsCm': [_semantic_fusion_xyz(box.minPoint), _semantic_fusion_xyz(box.maxPoint)]},
            'pose': list(occurrence.transform2.asArray()) if occurrence else list(_SEMANTIC_IDENTITY),
            'attributes': attributes,
            'topology': {'faces': native.faces.count, 'edges': native.edges.count,
                         'vertices': native.vertices.count, 'shells': native.shells.count},
            'visibility': {'nativeLightBulb': native.isLightBulbOn, 'proxyVisible': proxy.isVisible},
        }
        entities.append(entity_record)
    ctx.assert_identity()
    return entities
