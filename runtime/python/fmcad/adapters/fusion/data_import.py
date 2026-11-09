"""GM-02 document adapters. Uses the core resolver, param.apply and import.file.

Matrices are row-major, column-vector local-to-parent transforms in cm.
Data parsing remains on the CLI host. Runtime preflight precedes writes; SDK
failures are partial, not a promise of global rollback. Never retries or saves.
"""
import hashlib as _di_hashlib
import time as _di_time
from pathlib import Path as _DIPath


if _CAD_TYPE_CHECKING:
    from typing import NotRequired as _DiNotRequired

    class _DiAttributeCollection(_Protocol):
        def itemByName(self, groupName: str, name: str, /) -> adsk.core.Attribute | None: ...

        def add(self, groupName: str, name: str, value: str, /) -> adsk.core.Attribute: ...

    class _DiPlan(_CadTypedDict):
        version: Literal[1]
        operation: Literal['param.import', 'catalog.import', 'catalog.check', 'placement.import', 'placement.check', 'cots.replace']
        owner: str | None
        revision: str | None
        expectedRevision: str | None
        onExisting: Literal['error', 'reuse', 'update']
        digest: str
        provenance: JsonRecord
        result: JsonRecord
        unresolved: list[JsonRecord]
        warnings: list[str]
        maxItems: int
        budgetMs: int
        observed: _DiNotRequired[JsonValue]
        _deadline: _DiNotRequired[float]

    class _DiFrame(_CadTypedDict):
        occurrence: _DiNotRequired[JsonValue]
        datum: _DiNotRequired[str]
        component: _DiNotRequired[JsonValue]

    class _DiTransform(_CadTypedDict):
        matrix: list[int | float]
        frame: Literal['parent', 'root'] | _DiFrame
        units: str
        convention: str

    class _DiStoredDatum(_CadTypedDict):
        component: JsonValue
        matrix: list[int | float]
        space: str
        lengthUnits: str

    class _DiModel(_CadTypedDict, total=False):
        path: str
        fusionPath: str
        sha256: str
        missing: bool
        representation: str
        source: str | None
        status: str
        revision: str | None
        includedItems: list[str]

    class _DiMaterial(_CadTypedDict, total=False):
        id: str
        library: str
        description: str

    class _DiParameterRow(_CadTypedDict):
        name: str
        expression: str
        unit: str
        provenance: JsonRecord
        comment: _DiNotRequired[str]

    class _DiParameterResult(_CadTypedDict):
        parameters: list[_DiParameterRow]

    class _DiCatalogItem(_CadTypedDict):
        id: str
        name: str
        kind: str
        quantity: int
        parent: str | None
        placement: _DiTransform | None
        contents: list[JsonRecord]
        mass: JsonRecord | None
        model: _DiModel | None
        provenance: JsonRecord
        material: _DiNotRequired[_DiMaterial]
        purchaseQuantity: _DiNotRequired[int]
        allocation: _DiNotRequired[JsonRecord]
        functionalGroups: _DiNotRequired[list[str]]
        motionMembership: _DiNotRequired[list[str]]
        geometry: _DiNotRequired[JsonRecord]

    class _DiCatalogInstance(_CadTypedDict):
        id: str
        localKey: str
        item: str
        parent: str | None
        placement: _DiTransform | None

    class _DiManifestInstance(_CadTypedDict):
        id: str
        item: str
        parent: str | None
        occurrence: JsonRecord
        localMatrix: list[int | float]
        componentName: str
        actualMatrix: _DiNotRequired[list[int | float]]

    class _DiIdMapEntry(_CadTypedDict):
        definition: JsonRecord | None
        occurrences: list[JsonRecord]

    class _DiCatalogResult(_CadTypedDict):
        items: list[_DiCatalogItem]
        instances: list[_DiCatalogInstance]
        ledger: list[JsonRecord]
        differences: list[JsonRecord]
        bomProvenance: JsonRecord | None
        counts: JsonRecord

    class _DiGeometryState(_CadTypedDict):
        bodies: list[JsonRecord]
        features: list[JsonRecord]
        sketches: list[JsonRecord]
        importedOccurrences: list[JsonRecord]
        material: str | None

    class _DiPlacementRow(_CadTypedDict):
        id: str
        occurrence: JsonValue
        transform: _DiTransform | None
        provenance: JsonRecord

    class _DiPlacementResult(_CadTypedDict):
        poses: list[_DiPlacementRow]
        tolerance: float
        angleTolerance: float

    class _DiCotsDatum(_CadTypedDict):
        name: str
        old: _DiTransform
        new: _DiTransform
        delta: list[int | float]

    class _DiCotsImpact(_CadTypedDict):
        status: Literal['known', 'unknown']
        items: list[JsonValue]
        source: _DiNotRequired[str]

    class _DiCotsImpacts(_CadTypedDict):
        matingParts: _DiCotsImpact
        routings: _DiCotsImpact
        refs: _DiCotsImpact
        mass: _DiCotsImpact

    class _DiCotsResult(_CadTypedDict):
        target: str
        model: _DiModel
        datums: list[_DiCotsDatum]
        delta: list[int | float]
        occurrencePolicy: Literal['all', 'selected']
        occurrences: list[JsonValue]
        childrenPolicy: Literal['error', 'preserve']
        impacts: _DiCotsImpacts
        mass: JsonRecord | None

    class _DiItemMetadata(_CadTypedDict):
        owner: str
        revision: str
        digest: str
        id: _DiNotRequired[str]
        item: _DiNotRequired[_DiCatalogItem]
        geometry: _DiNotRequired[JsonValue]
        occurrence: _DiNotRequired[JsonValue]
        placement: _DiNotRequired[JsonValue]

    class _DiPlacementMetadata(_CadTypedDict):
        owner: str
        revision: str
        digest: str
        matrix: list[int | float]
        provenance: JsonRecord

    class _DiCatalogManifest(_CadTypedDict):
        owner: str
        revision: str
        digest: str
        instances: list[_DiManifestInstance]
        idMap: dict[str, _DiIdMapEntry]
        structure: list[JsonRecord]
        requestedInstances: list[_DiCatalogInstance]
        ledger: list[JsonRecord]
        provenance: JsonRecord


def _di_budget(plan: "_DiPlan") -> None:
    if _di_time.monotonic() > plan.get('_deadline', float('inf')):
        raise TimeoutError('Data import budget exhausted; inspect partial state before retry')


def _di_get(entity: "CadEntity", name: str) -> "JsonObject | None":
    attributes_value = getattr(entity, 'attributes', None)
    if attributes_value is None:
        raise ValueError('Data-import metadata target has no attributes collection')
    attributes = _cad_cast("_DiAttributeCollection", attributes_value)
    value = attributes.itemByName(_DI_GROUP, name)
    if value is None:
        return None
    stored = _cad_cast("JsonValue", json.loads(value.value))
    return _di_json_object(stored, 'Stored import metadata')


def _di_put(entity: "CadEntity", name: str, value: "JsonValue") -> None:
    attributes_value = getattr(entity, 'attributes', None)
    if attributes_value is None:
        raise ValueError('Data-import metadata target has no attributes collection')
    attributes = _cad_cast("_DiAttributeCollection", attributes_value)
    _cad_require_result(attributes.add(_DI_GROUP, name, json.dumps(value, allow_nan=False)), 'Store import ownership')


def _di_native(entity: "CadEntity") -> "CadEntity":
    return _cad_cast("adsk.core.Base", getattr(entity, 'nativeObject', None) or entity)


def _di_matrix(a: "Sequence[int | float]") -> "adsk.core.Matrix3D":
    matrix = adsk.core.Matrix3D.create()
    _cad_require_result(matrix.setWithArray(_di_rigid(a)), 'Set rigid matrix')
    return matrix


def _di_world(occurrence: "adsk.fusion.Occurrence | None") -> "list[int | float]":
    if occurrence is None:
        return _di_eye()
    parent = _cad_cast("adsk.fusion.Occurrence | None", getattr(occurrence, 'assemblyContext', None))
    native = _cad_cast("adsk.fusion.Occurrence", _di_native(occurrence))
    local = list(native.transform2.asArray())
    return _di_mul(_di_world(parent), local)


def _di_model_preflight(ctx: "CadContext", model: "_DiModel | None") -> None:
    if model is None:
        return
    if model.get('missing'):
        model_path = model.get('path')
        if not isinstance(model_path, str):
            raise ValueError('Missing model: path is not text')
        raise ValueError('Missing model: ' + model_path)
    fusion_path = model.get('fusionPath')
    if not isinstance(fusion_path, str):
        raise ValueError('Model is not accessible on Fusion host')
    local = _DIPath(fusion_path)
    if not local.is_file():
        raise ValueError('Model is not accessible on Fusion host: ' + str(local))
    digest = _di_hashlib.sha256()
    with local.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    sha256 = model.get('sha256')
    model_path = model.get('path')
    if not isinstance(sha256, str) or not isinstance(model_path, str):
        raise ValueError('Model preflight requires CLI path and SHA256')
    if digest.hexdigest() != sha256:
        raise ValueError('Model changed since CLI preflight: ' + model_path)
    _io_import_options(ctx, local)


def _di_import_model(ctx: "CadContext", model: "_DiModel | None",
                     component: "adsk.fusion.Component") -> None:
    if model is None:
        return
    fusion_path = model.get('fusionPath')
    if not isinstance(fusion_path, str):
        raise ValueError('Model is not accessible on Fusion host')
    before_component, before_occurrence = ctx.component, ctx.occurrence
    try:
        ctx.component, ctx.occurrence = component, None
        ctx.call('import.file', {'path': fusion_path, 'mode': 'component'})
        if component.bRepBodies.count + sum(o.component.bRepBodies.count for o in _cad_items(component.allOccurrences)) == 0:
            raise RuntimeError('Imported model contains no BRep bodies; no geometry acceptance claimed')
    finally:
        ctx.component, ctx.occurrence = before_component, before_occurrence


def _di_material_preflight(ctx: "CadContext", item: "_DiCatalogItem") -> None:
    material = item.get('material')
    if material is None or not material.get('id'):
        return
    material_id = material.get('id')
    if not isinstance(material_id, str):
        return
    library_id = material.get('library')
    source: adsk.fusion.Design | adsk.core.MaterialLibrary = ctx.design
    if library_id:
        source = _cad_unique([lib for lib in _cad_items(ctx.app.materialLibraries) if lib.id == library_id], 'Material library')
    found = _cad_unique([candidate for candidate in _cad_items(source.materials)
                         if candidate.id == material_id], 'Material ID')
    if source != ctx.design and any(m.id == found.id or m.name == found.name for m in _cad_items(ctx.design.materials)):
        raise ValueError('Material library conflicts with local ID/name; explicitly select the local material')


def _di_geometry_state(component: "adsk.fusion.Component") -> "JsonRecord":
    bodies: list[JsonRecord] = []
    for body in _cad_items(component.bRepBodies):
        bodies.append({'token': body.entityToken, 'name': body.name, 'volume': body.volume,
                       'faces': body.faces.count, 'edges': body.edges.count,
                       'bounds': [_cad_xyz(body.boundingBox.minPoint), _cad_xyz(body.boundingBox.maxPoint)]})
    features: list[JsonRecord] = []
    for feature in _cad_items(component.features):
        parameter_rows = None
        if hasattr(feature, 'parameters'):
            parameters = _cad_cast("_CadItemCollection[adsk.fusion.Parameter]",
                                  getattr(feature, 'parameters'))
            parameter_rows = [{'name': parameter.name, 'expression': parameter.expression,
                               'unit': parameter.unit} for parameter in _cad_items(parameters)]
        features.append({'token': feature.entityToken, 'parameters': parameter_rows})
    sketches: list[JsonRecord] = [
        {'token': sketch.entityToken} for sketch in _cad_items(component.sketches)]
    imported_occurrences: list[JsonRecord] = []
    # Local nested occurrences cannot expose entityToken in Fusion. Bind
    # through their owning definition, exact sibling name and component.
    for occurrence in _cad_items(component.occurrences):
        if _di_get(occurrence, 'occurrence') is None:
            imported_occurrences.append({
                'name': occurrence.name, 'componentToken': occurrence.component.entityToken,
                'matrix': list(occurrence.transform2.asArray()),
                'state': _di_geometry_state(occurrence.component),
            })
    material = _cad_cast("adsk.core.Material | None", getattr(component, 'material', None))
    return {'bodies': bodies, 'features': features, 'sketches': sketches,
            'importedOccurrences': imported_occurrences,
            'material': material.id if material is not None else None}


def _di_geometry_rows_match(ctx: "CadContext", saved_rows: "Sequence[JsonRecord]",
                            actual_rows: "Sequence[JsonRecord]",
                            entities: "Sequence[CadEntity]") -> bool:
    if len(saved_rows) != len(entities):
        return False
    for old in saved_rows:
        token = old.get('token')
        if not isinstance(token, str):
            return False
        entity = ctx.resolve({'token': token})
        if entity not in entities:
            return False
        current = actual_rows[entities.index(entity)]
        if {key: value for key, value in old.items() if key != 'token'} != {
                key: value for key, value in current.items() if key != 'token'}:
            return False
    return True


def _di_geometry_matches(ctx: "CadContext", component: "adsk.fusion.Component",
                         saved: "JsonValue") -> bool:
    if not isinstance(saved, dict) or not saved:
        return False
    saved_record = _di_json_object(saved, 'saved geometry')
    _cad_fields(saved_record, ('bodies', 'features', 'sketches', 'importedOccurrences', 'material'))
    bodies = _di_json_records(saved_record['bodies'], 'saved bodies')
    features = _di_json_records(saved_record['features'], 'saved features')
    sketches = _di_json_records(saved_record['sketches'], 'saved sketches')
    imported_saved = _di_json_records(saved_record['importedOccurrences'], 'saved imported occurrences')
    material_value = saved_record['material']
    if material_value is not None and not isinstance(material_value, str):
        return False
    saved_state = _cad_cast("_DiGeometryState", {
        'bodies': bodies, 'features': features, 'sketches': sketches,
        'importedOccurrences': imported_saved, 'material': material_value,
    })
    actual = _cad_cast("_DiGeometryState", _di_json_object(
        _cad_cast("JsonValue", _di_geometry_state(component)), 'actual geometry'))
    if actual['material'] != saved_state['material']:
        return False
    imported: list[adsk.fusion.Occurrence] = [
        occurrence for occurrence in _cad_items(component.occurrences)
        if _di_get(occurrence, 'occurrence') is None]
    if len(imported) != len(saved_state['importedOccurrences']):
        return False
    for row in saved_state['importedOccurrences']:
        token = row.get('token')
        if isinstance(token, str):
            occurrence = _cad_cast("adsk.fusion.Occurrence", _di_native(ctx.resolve({'token': token})))
        else:
            name, component_token = row.get('name'), row.get('componentToken')
            if not isinstance(name, str) or not isinstance(component_token, str):
                return False
            occurrence = _cad_unique([o for o in imported if o.name == name and
                o.component == ctx.resolve({'token': component_token}, 'component')],
                'Imported local occurrence')
        matrix_value = row.get('matrix')
        nested_state = row.get('state')
        if not isinstance(matrix_value, list) or not occurrence or occurrence not in imported:
            return False
        matrix = _di_rigid(matrix_value)
        if (not _di_same(matrix, list(occurrence.transform2.asArray())) or
                nested_state is None or not _di_geometry_matches(ctx, occurrence.component, nested_state)):
            return False
    # Entity tokens are locators, not immutable strings. Resolve old tokens and
    # compare objects, while checking observed topology/shape/feature parameters.
    body_entities: list[CadEntity] = []
    body_entities.extend(_cad_items(component.bRepBodies))
    feature_entities: list[CadEntity] = []
    feature_entities.extend(_cad_items(component.features))
    sketch_entities: list[CadEntity] = []
    sketch_entities.extend(_cad_items(component.sketches))
    return (
        _di_geometry_rows_match(ctx, saved_state['bodies'], actual['bodies'], body_entities) and
        _di_geometry_rows_match(ctx, saved_state['features'], actual['features'], feature_entities) and
        _di_geometry_rows_match(ctx, saved_state['sketches'], actual['sketches'], sketch_entities))


def _di_parameter(ctx: "CadContext", plan: "_DiPlan") -> "JsonRecord":
    parameter_result = _cad_cast("_DiParameterResult", plan['result'])
    parameters: list[JsonRecord] = []
    for row in parameter_result['parameters']:
        _di_budget(plan)
        old = ctx.design.allParameters.itemByName(row['name'])
        if old:
            owned = _di_get(old, 'parameter')
            if owned is None:
                raise ValueError('Parameter is unowned: ' + row['name'])
            _di_existing(owned, plan, row['name'])
            current = _cad_parameter_info(ctx, old)
            if owned['state'] != current:
                raise ValueError('Parameter changed outside import: ' + row['name'])
        parameter_data: JsonRecord = {'name': row['name'], 'expression': row['expression'], 'unit': row['unit']}
        if 'comment' in row:
            parameter_data['comment'] = row['comment']
        parameter_data['metadata'] = {'source': json.dumps(row['provenance'], sort_keys=True)}
        parameters.append(parameter_data)
    # This existing handler preflights all expressions/forward dependencies/units
    # before the first parameter mutation. It is intentionally the only engine.
    result = _cad_cast("JsonRecord", ctx.call(
        'param.apply', {'parameters': parameters, 'overwrite': plan['onExisting'] == 'update'}))
    for row in parameter_result['parameters']:
        cad_parameter = _di_required_user_parameter(
            ctx.design.userParameters.itemByName(row['name']), row['name'])
        _di_put(cad_parameter, 'parameter', _di_metadata(
            plan, state=_cad_parameter_info(ctx, cad_parameter), provenance=row['provenance']))
    return dict(result, associativity='nativeExpression', regeneration='Fusion expression solver; reimport explicitly for source revisions')


def _di_required_user_parameter(value: object, name: str) -> "adsk.fusion.UserParameter":
    if value is None:
        raise RuntimeError('Parameter disappeared after param.apply: ' + name)
    return _cad_cast("adsk.fusion.UserParameter", value)


def _di_catalog_state(ctx: "CadContext", manifest: "_DiCatalogManifest") -> "tuple[list[_DiManifestInstance], list[JsonRecord]]":
    differences: list[JsonRecord] = []
    instances: list[_DiManifestInstance] = []
    for row in manifest['instances']:
        try:
            occurrence = ctx.resolve(row['occurrence'], 'occurrence')
            native = _cad_cast("adsk.fusion.Occurrence", _di_native(occurrence))
            own = _di_get(native, 'occurrence')
            if not own or own['owner'] != manifest['owner']:
                raise ValueError('Occurrence ownership changed')
            actual = list(native.transform2.asArray())
            if not _di_same(actual, row['localMatrix']):
                differences.append({'id': row['id'], 'field': 'placement', 'status': 'fail', 'actual': actual, 'expected': row['localMatrix']})
            if occurrence.component.name != row['componentName']:
                differences.append({'id': row['id'], 'field': 'componentName', 'status': 'fail'})
            item = _di_get(occurrence.component, 'item')
            if not item or not _di_geometry_matches(ctx, occurrence.component, item.get('geometry')):
                differences.append({'id': row['id'], 'field': 'geometry', 'status': 'fail', 'reason': 'Imported definition changed; no silent reuse'})
            instances.append(_cad_cast("_DiManifestInstance",
                                       dict(row, occurrence=ctx.ref(occurrence), actualMatrix=actual)))
        except Exception as error:
            differences.append({'id': row['id'], 'status': 'fail', 'error': str(error)})
    # Detect additions, deletion, or reassignment of owned occurrences, including
    # occurrences added under a repeatedly-instanced assembly definition.
    expected_paths: set[str] = set()
    for row in manifest['instances']:
        path = row['occurrence'].get('path')
        if not isinstance(path, str):
            differences.append({'id': row['id'], 'status': 'fail', 'error': 'Owned occurrence metadata has no path'})
            continue
        expected_paths.add(path)
    for occurrence in _cad_items(ctx.root.allOccurrences):
        own = _di_get(_di_native(occurrence), 'occurrence')
        occurrence_ref = ctx.ref(occurrence)
        occurrence_path = occurrence_ref.get('path')
        if (own and own['owner'] == manifest['owner'] and isinstance(occurrence_path, str) and
                occurrence_path not in expected_paths):
            differences.append({'occurrence': occurrence_ref, 'status': 'fail', 'error': 'Unexpected owned occurrence path'})
    return instances, differences


def _di_catalog(ctx: "CadContext", plan: "_DiPlan", check: bool = False) -> "JsonRecord":
    data = _cad_cast("_DiCatalogResult", plan['result'])
    key = 'catalog:' + str(plan['owner'])
    old = _di_get(ctx.root, key)
    if check:
        if old is None:
            return {'status': 'unknown', 'differences': data['differences'], 'unresolved': [{'field': 'catalog', 'reason': 'No owned catalog manifest in this document'}]}
        actual, differences = _di_catalog_state(ctx, _cad_cast("_DiCatalogManifest", old))
        expected = {r['id']: r for r in data['instances']}
        for actual_row in actual:
            row = expected.pop(actual_row['id'], None)
            if row is None or (row['item'], row['parent']) != (actual_row['item'], actual_row['parent']):
                differences.append({'id': actual_row['id'], 'status': 'fail', 'reason': 'Catalog instance mismatch'})
            elif row['placement'] is None:
                differences.append({'id': actual_row['id'], 'status': 'unknown', 'reason': 'Missing requested placement'})
            else:
                actual_matrix = actual_row.get('actualMatrix')
                if not isinstance(actual_matrix, list):
                    differences.append({'id': actual_row['id'], 'status': 'unknown', 'reason': 'Current placement is unavailable'})
                elif not _di_same(row['placement']['matrix'], actual_matrix):
                    differences.append({'id': actual_row['id'], 'status': 'fail', 'reason': 'Requested pose differs from current model'})
        differences.extend({'id': k, 'status': 'fail', 'reason': 'Missing instance'} for k in expected)
        differences.extend(data['differences'])
        return _cad_cast("JsonRecord", dict(data, instances=[_cad_cast("JsonRecord", row) for row in actual],
            differences=differences, status='fail' if any(d['status'] == 'fail' for d in differences)
            else ('unknown' if differences or plan['unresolved'] else 'pass')))
    _di_existing(old, plan, key)
    if data['differences']:
        raise ValueError('BOM differences must be resolved before catalog import')
    if any(r['placement'] is None for r in data['instances']):
        raise ValueError('Missing placement: refusing to infer origin, roll or lens offset')
    for item in data['items']:
        _di_budget(plan)
        _di_model_preflight(ctx, item['model'])
        if not old:
            _di_material_preflight(ctx, item)
    if old:
        actual, differences = _di_catalog_state(ctx, _cad_cast("_DiCatalogManifest", old))
        if differences:
            raise ValueError('Catalog state conflict: ' + json.dumps(differences))
        # A catalog revision can update metadata without secretly rebuilding CAD.
        structure = [{k: r.get(k) for k in ('id', 'name', 'parent', 'quantity', 'model', 'placement', 'material')} for r in data['items']]
        if structure != old['structure'] or data['instances'] != old['requestedInstances']:
            raise ValueError('Geometry/structure update requires explicit placement import or cots replace; catalog update changes metadata only')
        if plan['onExisting'] == 'reuse':
            return _cad_cast("JsonRecord", dict(data, idMap=old['idMap'], instances=actual,
                                                 reused=True, associativity='importedReference'))
    else:
        names = {c.name for c in _cad_items(ctx.design.allComponents)}
        requested_names = [r['name'] for r in data['items']]
        if len(set(requested_names)) != len(requested_names) or any(n in names for n in requested_names):
            raise ValueError('Catalog component names must be unique and unused; unowned components cannot be adopted')
    capture = _assembly_capture_ready(ctx)
    ctx.assert_identity()
    definitions: dict[str, adsk.fusion.Component] = {}
    actual: list[_DiManifestInstance] = []
    by_instance: dict[str, adsk.fusion.Occurrence] = {}
    local_occurrences: dict[tuple[str | None, str], adsk.fusion.Occurrence] = {}
    copied_materials: dict[tuple[str | None, str], JsonObject] = {}
    if old:
        manifest_old = _cad_cast("_DiCatalogManifest", old)
        definitions = {item_id: ctx.resolve(row['definition'], 'component')
                       for item_id, row in manifest_old['idMap'].items()
                       if row['definition'] is not None}
        actual = manifest_old['instances']
    else:
        items: dict[str, _DiCatalogItem] = {item['id']: item for item in data['items']}
        for row in data['instances']:
            _di_budget(plan)
            item = items[row['item']]
            parent: adsk.fusion.Occurrence | None = by_instance[row['parent']] if row['parent'] is not None else None
            component = parent.component if parent else ctx.root
            parent_item = next((instance['item'] for instance in data['instances']
                                if instance['id'] == row['parent']), None) if parent is not None else None
            local_key = (parent_item, row['localKey'])
            placement = row['placement']
            if placement is None:
                raise ValueError('Missing placement: refusing to infer origin, roll or lens offset')
            local = placement['matrix']
            created_occurrence = local_key not in local_occurrences
            if local_key in local_occurrences:
                native = local_occurrences[local_key]
            else:
                if row['item'] in definitions:
                    native = _cad_require_result(component.occurrences.addExistingComponent(definitions[row['item']], _di_matrix(local)), 'Add linked catalog occurrence')
                else:
                    native = _cad_require_result(component.occurrences.addNewComponent(_di_matrix(local)), 'Create catalog definition')
                    definitions[row['item']] = native.component
                    native.component.name = item['name']
                    ctx.created.append(ctx.ref(native.component))
                    _di_put(native.component, 'item', _di_metadata(
                        plan, id=item['id'], item=_cad_cast("JsonRecord", item)))
                    _di_import_model(ctx, item['model'], native.component)
                    material = item.get('material')
                    material_id = material.get('id') if material is not None else None
                    if isinstance(material_id, str) and material_id:
                        library_id = material.get('library') if material is not None else None
                        key_material = (library_id, material_id)
                        selection = copied_materials.get(key_material)
                        if selection is None:
                            selection = {'id': material_id}
                            if isinstance(library_id, str):
                                selection['library'] = library_id
                        assigned = _di_json_object(
                            ctx.call('material.assign', dict(selection, refs=[ctx.ref(native.component)])),
                            'Material assignment result')
                        assigned_id = assigned.get('id')
                        if not isinstance(assigned_id, str):
                            raise ValueError('Material assignment returned no ID')
                        copied_materials[key_material] = {'id': assigned_id}
                _di_put(native, 'occurrence', _di_metadata(plan, item=row['item'], localKey=row['localKey']))
                local_occurrences[local_key] = native
            occurrence = (_cad_require_result(native.createForAssemblyContext(parent), 'Create nested occurrence proxy')
                          if parent is not None else native)
            if created_occurrence:
                ctx.created.append(ctx.ref(occurrence))
            observed_local = list(native.transform2.asArray())
            if not _di_same(local, observed_local):
                raise RuntimeError('Catalog occurrence placement readback mismatch')
            by_instance[row['id']] = occurrence
            actual.append({'id': row['id'], 'item': row['item'], 'parent': row['parent'], 'occurrence': ctx.ref(occurrence),
                           'localMatrix': observed_local, 'componentName': item['name']})
            print('FMCAD_PROGRESS ' + json.dumps({'operation': plan['operation'], 'completed': len(actual), 'total': len(data['instances'])}))
    id_map: dict[str, _DiIdMapEntry] = {
        item['id']: {'definition': ctx.ref(definitions[item['id']]) if item['id'] in definitions else None,
                     'occurrences': [row['occurrence'] for row in actual if row['item'] == item['id']]}
        for item in data['items']}
    for item in data['items']:
        if item['id'] in definitions:
            _di_put(definitions[item['id']], 'item', _di_metadata(
                plan, id=item['id'], item=_cad_cast("JsonRecord", item),
                geometry=_di_geometry_state(definitions[item['id']])))
    id_map_record: JsonRecord = {
        item_id: _cad_cast("JsonRecord", entry) for item_id, entry in id_map.items()}
    metadata: JsonRecord = {
        'instances': [_cad_cast("JsonRecord", row) for row in actual],
        'idMap': id_map_record,
        'ledger': data['ledger'],
        'requestedInstances': [_cad_cast("JsonRecord", row) for row in data['instances']],
        'structure': [{key: item.get(key) for key in
                       ('id', 'name', 'parent', 'quantity', 'model', 'placement', 'material')}
                      for item in data['items']],
    }
    manifest = _di_metadata(plan, **metadata)
    _di_put(ctx.root, key, manifest)
    snapshot = _assembly_capture(ctx, capture)
    result: JsonRecord = _cad_cast("JsonRecord", dict(data))
    result.update(idMap=id_map_record,
                  instances=[_cad_cast("JsonRecord", row) for row in actual],
                  notExecuted=[{'id': item['id'], 'reason': 'No physical/reference occurrence requested; definition retained as catalog data'}
                               for item in data['items'] if item['id'] not in definitions],
                  associativity='importedReference', metadataOnly=old is not None, snapshot=snapshot)
    return result


def _di_unconstrained(ctx: "CadContext", occurrence: "adsk.fusion.Occurrence") -> None:
    native = _cad_cast("adsk.fusion.Occurrence", _di_native(occurrence))
    # isGrounded is unavailable on unqualified nested natives in Fusion.
    if native.isReferencedComponent or occurrence.isGrounded or native.isGroundToParent:
        raise ValueError('External/grounded occurrence cannot be changed')
    # Descendant constraints also constrain a parent assembly's placement.
    component = native.component
    subtree: list[CadEntity] = [native]
    subtree.extend(_di_native(child) for child in _cad_items(component.allOccurrences))
    for component in _cad_items(ctx.design.allComponents):
        for joint in _cad_items(component.joints):
            if not joint.isSuppressed and any(
                    _di_native(participant) in subtree
                    for participant in (joint.occurrenceOne, joint.occurrenceTwo)):
                raise ValueError('Occurrence participates in an active joint/rigid group; edit its driving relationship explicitly')
        for joint in _cad_items(component.asBuiltJoints):
            if not joint.isSuppressed and any(
                    _di_native(participant) in subtree
                    for participant in (joint.occurrenceOne, joint.occurrenceTwo)):
                raise ValueError('Occurrence participates in an active joint/rigid group; edit its driving relationship explicitly')
        for group in _cad_items(component.rigidGroups):
            if not group.isSuppressed and any(
                    _di_native(participant) in subtree for participant in _cad_items(group.occurrences)):
                raise ValueError('Occurrence participates in an active joint/rigid group; edit its driving relationship explicitly')


def _di_pose_plan(ctx: "CadContext", rows: "Sequence[_DiPlacementRow]") -> "list[tuple[_DiPlacementRow, adsk.fusion.Occurrence, list[int | float], list[int | float]]]":
    resolved: list[tuple[_DiPlacementRow, adsk.fusion.Occurrence]] = [
        (row, ctx.resolve(row['occurrence'], 'occurrence'))
        for row in rows]
    paths = [occurrence.fullPathName for _, occurrence in resolved]
    if len(set(paths)) != len(paths):
        raise ValueError('Duplicate resolved occurrence path')
    targets: dict[str, tuple[_DiPlacementRow, adsk.fusion.Occurrence]] = {
        occurrence.fullPathName: (row, occurrence) for row, occurrence in resolved}
    cache: dict[str, list[int | float]] = {}
    visiting: set[str] = set()

    def world(occurrence: "adsk.fusion.Occurrence | None") -> "list[int | float]":
        if occurrence is None:
            return _di_eye()
        key = occurrence.fullPathName
        if key in cache:
            return cache[key]
        if key in visiting:
            raise ValueError('Placement frame dependency cycle')
        visiting.add(key)
        if key in targets:
            target_row = targets[key][0]
            if target_row['transform'] is None:
                raise ValueError('Missing complete placement: ' + target_row['id'])
            transform = target_row['transform']
            frame = transform['frame']
            if frame == 'parent':
                parent_context = _cad_cast(
                    "adsk.fusion.Occurrence | None", getattr(occurrence, 'assemblyContext', None))
                basis = world(parent_context)
            elif frame == 'root':
                basis = _di_eye()
            else:
                frame_occurrence_ref = frame.get('occurrence')
                frame_occurrence = (ctx.resolve(frame_occurrence_ref, 'occurrence')
                                    if frame_occurrence_ref is not None else None)
                basis = world(frame_occurrence)
                datum_name = frame.get('datum')
                if datum_name is not None:
                    owner = frame_occurrence.component if frame_occurrence is not None else ctx.root
                    attribute = owner.attributes.itemByName(_CAD_FRAME_GROUP, datum_name)
                    if not attribute:
                        raise ValueError('Named datum frame does not exist: ' + datum_name)
                    datum_value = _cad_cast("JsonValue", json.loads(attribute.value))
                    datum_record = _di_json_object(datum_value, 'Stored named datum frame')
                    _cad_fields(datum_record, ('component', 'matrix', 'space', 'lengthUnits'))
                    datum = _cad_cast("_DiStoredDatum", datum_record)
                    if (datum['space'] != 'component local' or datum['lengthUnits'] != 'cm' or
                            ctx.resolve(datum['component'], 'component') != owner):
                        raise ValueError('Named datum identity, space or units mismatch')
                    basis = _di_mul(basis, _di_rigid(datum['matrix']))
            value = _di_mul(basis, _di_rigid(transform['matrix']))
        else:
            native = _cad_cast("adsk.fusion.Occurrence", _di_native(occurrence))
            parent_context = _cad_cast(
                "adsk.fusion.Occurrence | None", getattr(occurrence, 'assemblyContext', None))
            value = _di_mul(world(parent_context), list(native.transform2.asArray()))
        visiting.remove(key)
        cache[key] = value
        return value

    result: list[tuple[_DiPlacementRow, adsk.fusion.Occurrence,
                       list[int | float], list[int | float]]] = []
    for row, occurrence in resolved:
        desired_world = world(occurrence)
        parent_context = _cad_cast(
            "adsk.fusion.Occurrence | None", getattr(occurrence, 'assemblyContext', None))
        local = _di_mul(_di_inverse(world(parent_context)), desired_world)
        result.append((row, occurrence, local, desired_world))
    return result


def _di_placement(ctx: "CadContext", plan: "_DiPlan", check: bool = False) -> "JsonRecord":
    data = _cad_cast("_DiPlacementResult", plan['result'])
    if any(r['transform'] is None for r in data['poses']) and check:
        return {'status': 'unknown', 'poses': [], 'unresolved': plan['unresolved']}
    planned = _di_pose_plan(ctx, data['poses'])
    if check:
        measured: list[JsonRecord] = []
        for row, occurrence, local, world in planned:
            delta = _di_mul(_di_inverse(world), _di_world(occurrence))
            distance = math.hypot(delta[3], delta[7], delta[11])
            angle = math.acos(max(-1., min(1., (delta[0] + delta[5] + delta[10] - 1) / 2)))
            measured.append({'id': row['id'], 'occurrence': ctx.ref(occurrence), 'distance': distance, 'units': 'cm', 'angle': angle, 'angleUnits': 'rad', 'frame': 'root',
                             'status': 'pass' if distance <= data['tolerance'] and angle <= data['angleTolerance'] else 'fail', 'actual': _di_world(occurrence), 'expected': world})
        return {'poses': measured, 'status': 'fail' if any(r['status'] == 'fail' for r in measured) else ('unknown' if plan['unresolved'] else 'pass')}
    all_occurrences = _cad_items(ctx.root.allOccurrences)
    native_plan: list[tuple[_DiPlacementRow, adsk.fusion.Occurrence, list[int | float]]] = []
    for row, occurrence, local, world in planned:
        _di_budget(plan)
        native = _cad_cast("adsk.fusion.Occurrence", _di_native(occurrence))
        _di_unconstrained(ctx, occurrence)
        old = _di_get(native, 'placement')
        if old:
            _di_existing(old, plan, row['id'])
            placement_metadata = _di_placement_metadata(old)
            if not _di_same(placement_metadata['matrix'], list(native.transform2.asArray())):
                raise ValueError('Placement changed outside owned import')
        else:
            owned = _di_get(native, 'occurrence')
            if not owned or owned['owner'] != plan['owner']:
                raise ValueError('Placement cannot adopt an unowned occurrence')
        for other in all_occurrences:
            if _di_native(other) == native:
                target = next((candidate for candidate in planned
                               if candidate[1].fullPathName == other.fullPathName), None)
                if target is None or not _di_same(target[2], local):
                    raise ValueError('Nested linked occurrence changes require every affected path with the same local pose')
        if not any(p[1] == native for p in native_plan):
            native_plan.append((row, native, local))
    capture = _assembly_capture_ready(ctx)
    ctx.assert_identity()
    for row, native, local in native_plan:
        _di_budget(plan)
        native.transform2 = _di_matrix(local)
        if not _di_same(local, list(native.transform2.asArray())):
            raise RuntimeError('Placement readback mismatch')
        _di_put(native, 'placement', _di_metadata(plan, matrix=local, provenance=row['provenance']))
    snapshot = _assembly_capture(ctx, capture)
    return _cad_cast("JsonRecord", {
        'poses': [{'id': row['id'], 'occurrence': ctx.ref(occurrence), 'actual': _di_world(occurrence),
                   'units': 'cm', 'frame': 'root'}
                  for row, occurrence, local, world in planned],
        'snapshot': snapshot, 'associativity': 'snapshot',
        'invalidated': ['catalog placement check', 'mating parts', 'routings', 'clearance', 'mass CG/inertia'],
    })


def _di_replace(ctx: "CadContext", plan: "_DiPlan") -> "JsonRecord":
    data = _cad_cast("_DiCotsResult", plan['result'])
    components: list[adsk.fusion.Component] = [
        candidate for candidate in _cad_items(ctx.design.allComponents)
        if (_di_get(candidate, 'item') or {}).get('id') == data['target']
        and (_di_get(candidate, 'item') or {}).get('owner') == plan['owner']
        and (_di_get(candidate, 'item') or {}).get('revision') == plan['expectedRevision']]
    component = _cad_unique(components, 'Owned replacement item ' + data['target'])
    old_value = _di_get(component, 'item')
    if old_value is None:
        raise ValueError('Owned COTS item metadata is missing')
    old = _di_item_metadata(old_value)
    if plan['expectedRevision'] != old['revision']:
        raise ValueError('COTS replacement requires matching expectedRevision')
    old_item = old.get('item')
    if old_item is None or old_item['kind'] not in ('purchased', 'pcba'):
        raise ValueError('COTS replacement requires purchased/pcba catalog item')
    if not _di_geometry_matches(ctx, component, old.get('geometry')):
        raise ValueError('COTS geometry changed outside owned import; explicit reconciliation required')
    candidates: list[adsk.fusion.Occurrence] = [
        occurrence for occurrence in _cad_items(ctx.root.allOccurrences)
        if occurrence.component == component]
    selected: list[adsk.fusion.Occurrence] = (candidates if data['occurrencePolicy'] == 'all' else [
        ctx.resolve(ref, 'occurrence') for ref in data['occurrences']])
    if not selected or len({o.fullPathName for o in selected}) != len(selected) or any(o.component != component for o in selected):
        raise ValueError('Selected occurrences must be unique paths of the owned target component')
    selected_paths = {o.fullPathName for o in selected}
    if len(selected) > plan['maxItems']:
        raise ValueError('COTS affected occurrence count exceeds maxItems')
    for occurrence in selected:
        _di_unconstrained(ctx, occurrence)
        own = _di_get(_di_native(occurrence), 'occurrence')
        if not own or own['owner'] != plan['owner']:
            raise ValueError('Unowned occurrence cannot be replaced')
        # Removing a native nested occurrence removes all its assembly proxies.
        if any(_di_native(o) == _di_native(occurrence) and o.fullPathName not in selected_paths for o in candidates):
            raise ValueError('Selected policy omits linked nested paths; select every shared native path or make the assembly independent first')
    children: list[adsk.fusion.Occurrence] = [
        occurrence for occurrence in _cad_items(component.occurrences)
        if _di_get(occurrence, 'occurrence')]
    if children:
        included_items = data['model'].get('includedItems')
        if data['childrenPolicy'] != 'preserve' or included_items is None:
            raise ValueError('Physical children require childrenPolicy:preserve and explicit model.includedItems to prevent duplicate contents')
        for child in children:
            child_data = _di_get(child, 'occurrence')
            if child_data is None:
                raise ValueError('Physical child ownership metadata disappeared')
            if child_data['owner'] != plan['owner'] or child_data['item'] in included_items:
                raise ValueError('Cannot preserve foreign or already-included physical contents')
    # Do not destroy user geometry or associative downstream references silently.
    for body in _cad_items(component.bRepBodies):
        body_context: object = getattr(body, 'assemblyContext', None)
        if body_context is not None:
            raise ValueError('Replacement requires native source bodies')
    _di_model_preflight(ctx, data['model'])
    capture = _assembly_capture_ready(ctx)
    ctx.assert_identity()
    # Import once into a new definition. All old occurrences remain until the
    # replacement has been imported successfully and complete poses are known.
    first = selected[0]
    first_native = _cad_cast("adsk.fusion.Occurrence", _di_native(first))
    first_parent = _cad_cast("adsk.fusion.Occurrence | None", getattr(first, 'assemblyContext', None))
    parent_component: adsk.fusion.Component = first_parent.component if first_parent is not None else ctx.root
    matrix = _di_mul(list(first_native.transform2.asArray()), data['delta'])
    seed = _cad_require_result(parent_component.occurrences.addNewComponent(_di_matrix(matrix)), 'Create replacement component')
    seed_component = seed.component
    seed_component.name = component.name + ' [' + _di_plan_text(plan, 'revision') + ']'
    seed_context = seed.createForAssemblyContext(first_parent) if first_parent is not None else seed
    ctx.created.extend([ctx.ref(seed.component), ctx.ref(seed_context)])
    _di_import_model(ctx, data['model'], seed_component)
    child_replacements: list[tuple[adsk.fusion.Occurrence, adsk.fusion.Occurrence]] = []
    for child in children:
        _di_budget(plan)
        replacement = _cad_require_result(seed.component.occurrences.addExistingComponent(child.component,
            _di_matrix(_di_mul(_di_inverse(data['delta']), list(child.transform2.asArray())))), 'Preserve physical COTS child')
        ctx.created.append(ctx.ref(replacement.createForAssemblyContext(seed_context)))
        child_metadata = _di_get(child, 'occurrence')
        if child_metadata is None:
            raise ValueError('Physical child ownership metadata disappeared')
        child_metadata['replaces'] = ctx.ref(child.createForAssemblyContext(first))
        _di_put(replacement, 'occurrence', child_metadata)
        child_replacements.append((child, replacement))
    item = _cad_cast("JsonRecord", dict(old_item))
    item['model'] = _cad_cast("JsonRecord", dict(data['model']))
    item['mass'] = data['mass']
    # The old part's assigned material is not evidence for the new vendor file.
    item.pop('material', None)
    impacts = _cad_cast("JsonRecord", data['impacts'])
    _di_put(seed_component, 'item', _di_metadata(
        plan, id=data['target'], item=item, geometry=_di_geometry_state(seed_component),
        replaces=ctx.ref(component), invalidated=impacts))
    natives: list[adsk.fusion.Occurrence] = []
    replacements: list[JsonRecord] = []
    new_natives: list[tuple[adsk.fusion.Occurrence, adsk.fusion.Occurrence]] = []
    for occurrence in selected:
        _di_budget(plan)
        native = _cad_cast("adsk.fusion.Occurrence", _di_native(occurrence))
        if native in natives:
            continue
        natives.append(native)
        parent = _cad_cast("adsk.fusion.Occurrence | None", getattr(occurrence, 'assemblyContext', None))
        parent_component = parent.component if parent is not None else ctx.root
        replacement = seed if native == first_native else _cad_require_result(parent_component.occurrences.addExistingComponent(seed_component,
            _di_matrix(_di_mul(list(native.transform2.asArray()), data['delta']))), 'Add replacement occurrence')
        actual = replacement.createForAssemblyContext(parent) if parent is not None else replacement
        if replacement != seed:
            ctx.created.append(ctx.ref(actual))
        _di_put(replacement, 'occurrence', _di_metadata(plan, item=data['target'], replaces=ctx.ref(occurrence)))
        new_natives.append((native, replacement))
        replacements.append({'before': ctx.ref(occurrence), 'after': ctx.ref(actual), 'localMatrix': list(replacement.transform2.asArray())})
    datum_checks: list[JsonRecord] = []
    occurrence_map: list[JsonRecord] = []
    child_map: list[JsonRecord] = []
    for occurrence in selected:
        occurrence_native = _cad_cast("adsk.fusion.Occurrence", _di_native(occurrence))
        replacement = next(new for old, new in new_natives if old == occurrence_native)
        parent = _cad_cast("adsk.fusion.Occurrence | None", getattr(occurrence, 'assemblyContext', None))
        actual = replacement.createForAssemblyContext(parent) if parent is not None else replacement
        for datum in data['datums']:
            expected = _di_mul(_di_world(occurrence), datum['old']['matrix'])
            observed = _di_mul(_di_world(actual), datum['new']['matrix'])
            if not _di_same(expected, observed):
                raise RuntimeError('Replacement datum readback mismatch; old occurrences retained')
            datum_checks.append({'occurrence': ctx.ref(actual), 'datum': datum['name'], 'status': 'pass', 'expected': expected, 'actual': observed, 'frame': 'root', 'units': 'cm'})
        occurrence_map.append({'before': ctx.ref(occurrence), 'after': ctx.ref(actual)})
        for child, new_child in child_replacements:
            before_child = child.createForAssemblyContext(occurrence)
            after_child = new_child.createForAssemblyContext(actual)
            if not _di_same(_di_world(before_child), _di_world(after_child)):
                raise RuntimeError('Physical child placement readback mismatch; old COTS retained')
            child_map.append({'before': ctx.ref(before_child), 'after': ctx.ref(after_child), 'worldMatrix': _di_world(after_child), 'frame': 'root', 'units': 'cm'})
    for native in natives:
        _di_budget(plan)
        _cad_require_result(native.deleteMe(), 'Remove replaced owned occurrence')
    snapshot = _assembly_capture(ctx, capture)
    previous_material = old_item.get('material')
    return _cad_cast("JsonRecord", {
        'replacements': replacements, 'occurrenceMap': occurrence_map, 'childMap': child_map,
        'datumChecks': datum_checks, 'selectedPaths': sorted(selected_paths), 'datumMap': data['datums'],
        'preservedDatumTransform': data['delta'], 'impacts': impacts, 'mass': data['mass'],
        'snapshot': snapshot, 'associativity': 'importedReference',
        'material': {'previous': previous_material, 'replacement': None, 'status': 'unknown',
                     'reason': 'Imported material has not been reconciled with supplier evidence'},
        'unresolved': [{'id': data['target'], 'field': 'replacement.material', 'status': 'unknown'}],
        'invalidated': ['catalog occurrence refs', 'geometry refs', 'mating parts', 'routings', 'mass/CG/inertia checks'],
        'limitations': ['Replacement creates a new imported definition; geometric refs are invalidated, not remapped. Datums are explicit input evidence, not native construction constraints.'],
    })


def _di_handler(ctx: "CadContext", value: "JsonObject") -> "JsonRecord":
    # Execution bookkeeping must not contaminate the reusable wire request.
    plan = _di_plan(dict(value))
    operation = plan['operation']
    ctx.assert_identity()
    before = len(ctx.created)
    plan['_deadline'] = time.monotonic() + plan['budgetMs'] / 1000
    try:
        if operation == 'param.import':
            result = _di_parameter(ctx, plan)
        elif operation.startswith('catalog.'):
            result = _di_catalog(ctx, plan, operation.endswith('.check'))
        elif operation.startswith('placement.'):
            result = _di_placement(ctx, plan, operation.endswith('.check'))
        else:
            result = _di_replace(ctx, plan)
    except Exception as error:
        return {'status': 'blocked' if len(ctx.created) == before else 'fail', 'error': str(error), 'atomic': False,
                'created': ctx.created[before:], 'mutationMayHaveOccurred': True, 'notExecuted': 'Inspect current document before retry; mutations are not automatically replayed',
                'documentIdentity': _io_identity(ctx), 'provenance': plan['provenance'], 'operation': operation,
                'units': 'cm', 'frame': 'explicit per row', 'associativity': 'nativeExpression' if operation == 'param.import' else 'importedReference',
                'warnings': plan['warnings'], 'unresolved': plan['unresolved'], 'method': 'data adapter preflight/execution',
                'limitations': ['No global rollback. No automatic retry.']}
    extra_unresolved = _di_json_records(result.get('unresolved', []), 'Unresolved item')
    result.setdefault('status', 'unknown' if plan['unresolved'] or extra_unresolved else 'pass')
    result.update(documentIdentity=_io_identity(ctx), operation=operation, atomic=False, units='per parameter; internal cm,rad,kg,s' if operation == 'param.import' else 'cm', frame='explicit per row',
                  provenance=plan['provenance'], warnings=plan['warnings'],
                  unresolved=plan['unresolved'] + extra_unresolved, method='data adapter through existing CAD handlers')
    result.setdefault('associativity', 'snapshot' if operation.startswith('placement.') else 'importedReference')
    result.setdefault('limitations', ['Native kernel and API failures are non-atomic; no automatic retry or save.',
                                    'Source confidence is retained. Geometry guards compare observed topology, bounds, volume and exposed feature parameters; they are not exact BRep equivalence certificates.'])
    return result


_DI_HANDLERS: dict[str, "CadHandler"] = {
    name: _di_handler for name in ('param.import', 'catalog.import', 'catalog.check',
                                   'placement.import', 'placement.check', 'cots.replace')
}
CAD_HANDLERS.update(_DI_HANDLERS)
