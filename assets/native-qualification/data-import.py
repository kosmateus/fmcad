"""Fixed native data-import/placement/COTS fixture; caller owns the scratch lifecycle."""
import hashlib as _di_hashlib
import json as _di_json
import os as _di_os
import tempfile as _di_tempfile
from typing import TypeAlias as _DITypeAlias, cast as _DICast

_DIJSON: _DITypeAlias = None | bool | int | float | str | list['_DIJSON'] | dict[str, '_DIJSON']
_DI_SOURCE = 'Owned synthetic Fusion fixed-run data-import fixture'
_DI_CONVENTION = 'row-major; column vectors; local-to-frame; parent * local'

ARGS = {}
DOC_NAME = None


def _di_object(value: _DIJSON, label: str) -> dict[str, _DIJSON]:
    if not isinstance(value, dict):
        raise RuntimeError('Data-import fixture expected an object: ' + label)
    return value


def _di_rows(value: _DIJSON, label: str) -> list[dict[str, _DIJSON]]:
    if not isinstance(value, list):
        raise RuntimeError('Data-import fixture expected rows: ' + label)
    rows: list[dict[str, _DIJSON]] = []
    for row in value:
        rows.append(_di_object(row, label))
    return rows


def _di_stable(value: _DIJSON) -> str:
    if isinstance(value, list):
        return '[' + ','.join(_di_stable(item) for item in value) + ']'
    if isinstance(value, dict):
        return '{' + ','.join(_di_json.dumps(key, ensure_ascii=False) + ':' +
                              _di_stable(value[key]) for key in sorted(value)) + '}'
    return _di_json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def _di_hash(value: _DIJSON) -> str:
    return _di_hashlib.sha256(_di_stable(value).encode('utf-8')).hexdigest()


def _di_file_hash(filename: str) -> str:
    digest = _di_hashlib.sha256()
    with open(filename, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _di_call(calls: list[_DIJSON], operation: str, data: dict[str, _DIJSON],
             component: str | None = None) -> dict[str, _DIJSON]:
    value = FMCAD.call(operation, data, component) if component is not None else FMCAD.call(operation, data)
    result = _di_object(value, operation)
    calls.append(_DICast(_DIJSON, {'operation': operation, 'result': result}))
    return result


def _di_expect(value: dict[str, _DIJSON], status: str, operation: str) -> None:
    if value.get('status') != status:
        raise RuntimeError(operation + ' returned ' + str(value.get('status')) + ', expected ' + status)


def _di_transform(frame: str, x_cm: float = 0) -> dict[str, _DIJSON]:
    matrix: list[_DIJSON] = [1, 0, 0, x_cm, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    return {'matrix': _DICast(_DIJSON, matrix), 'frame': frame, 'units': 'cm', 'convention': _DI_CONVENTION}


def _di_plan(operation: str, owner: str, revision: str, result: dict[str, _DIJSON],
             provenance: dict[str, _DIJSON], expected_revision: str | None = None,
             unresolved: list[_DIJSON] | None = None, warnings: list[_DIJSON] | None = None) -> dict[str, _DIJSON]:
    digest_value: dict[str, _DIJSON] = {
        'operation': operation, 'result': result, 'owner': owner, 'revision': revision,
    }
    plan: dict[str, _DIJSON] = {
        'version': 1,
        'operation': operation,
        'owner': owner,
        'revision': revision,
        'expectedRevision': expected_revision,
        'onExisting': 'error',
        'digest': _di_hash(_DICast(_DIJSON, digest_value)),
        'provenance': provenance,
        'result': result,
        'unresolved': _DICast(_DIJSON, unresolved if unresolved is not None else []),
        'warnings': _DICast(_DIJSON, warnings if warnings is not None else []),
        'maxItems': 10000,
        'budgetMs': 120000,
    }
    return plan


def _di_inline_provenance(records: list[dict[str, _DIJSON]], revision: str) -> dict[str, _DIJSON]:
    return {'path': None, 'sha256': _di_hash(_DICast(_DIJSON, records)), 'revision': revision, 'pathHost': 'inline'}


def _di_row_provenance(base: dict[str, _DIJSON], row: int, status: str = 'CONFIRMED') -> dict[str, _DIJSON]:
    return {**base, 'row': row, 'status': status, 'source': _DI_SOURCE, 'derivation': None}


def _di_param_plan(owner: str, revision: str, names: tuple[str, str]) -> dict[str, _DIJSON]:
    records: list[dict[str, _DIJSON]] = [
        {'name': names[0], 'expression': '5', 'unit': 'mm', 'comment': 'Synthetic live import',
         'status': 'CONFIRMED', 'source': _DI_SOURCE},
        {'name': names[1], 'expression': names[0] + ' * 2', 'unit': 'mm',
         'status': 'CONFIRMED', 'source': _DI_SOURCE},
    ]
    base = _di_inline_provenance(records, revision)
    parameters: list[_DIJSON] = []
    for index, row in enumerate(records):
        parameter: dict[str, _DIJSON] = {
            'name': _DICast(str, row['name']),
            'expression': '5 mm' if index == 0 else _DICast(str, row['expression']),
            'unit': 'mm',
            'provenance': _di_row_provenance(base, index + 1),
        }
        if row.get('comment') is not None:
            parameter['comment'] = row['comment']
        parameters.append(_DICast(_DIJSON, parameter))
    result: dict[str, _DIJSON] = {'parameters': _DICast(_DIJSON, parameters)}
    warnings: list[_DIJSON] = []
    warnings.append('Fusion validates expression grammar, units and the complete dependency graph before param.apply writes; offline preflight does not evaluate Fusion expressions.')
    return _di_plan('param.import', owner, revision, result, base, warnings=warnings)


def _di_catalog_records(prefix: str) -> list[dict[str, _DIJSON]]:
    top_id, part_id, cots_id = 'synthetic-assembly', 'synthetic-part', 'synthetic-cots'
    return [
        {'id': top_id, 'name': 'FMCAD_DI_' + prefix + '_Assembly', 'kind': 'assembly', 'quantity': 1,
         'parent': None, 'placement': {'frame': 'parent', 'translation': ['10 mm', '0 mm', '0 mm'],
         'rotation': [1, 0, 0, 0, 1, 0, 0, 0, 1]}, 'status': 'CONFIRMED', 'source': _DI_SOURCE},
        {'id': part_id, 'name': 'FMCAD_DI_' + prefix + '_Part', 'kind': 'part', 'quantity': 1,
         'parent': top_id, 'placement': {'frame': 'parent', 'translation': ['0 mm', '0 mm', '0 mm'],
         'rotation': [1, 0, 0, 0, 1, 0, 0, 0, 1]}, 'status': 'CONFIRMED', 'source': _DI_SOURCE},
        {'id': cots_id, 'name': 'FMCAD_DI_' + prefix + '_Sensor', 'kind': 'purchased', 'quantity': 1,
         'parent': None, 'placement': {'frame': 'parent', 'translation': ['0 mm', '0 mm', '0 mm'],
         'rotation': [1, 0, 0, 0, 1, 0, 0, 0, 1]},
         'mass': {'value': 3, 'unit': 'g', 'status': 'ESTIMATED', 'source': _DI_SOURCE},
         'status': 'CONFIRMED', 'source': _DI_SOURCE},
    ]


def _di_catalog_plan(owner: str, revision: str, records: list[dict[str, _DIJSON]],
                     operation: str = 'catalog.import') -> dict[str, _DIJSON]:
    provenance = _di_inline_provenance(records, revision)
    ids = ['synthetic-assembly', 'synthetic-part', 'synthetic-cots']
    names = [row['name'] for row in records]
    frames = [_di_transform('parent', 1), _di_transform('parent', 0), _di_transform('parent', 0)]
    items: list[_DIJSON] = []
    for index, row in enumerate(records):
        item: dict[str, _DIJSON] = {
            'id': row['id'], 'name': row['name'], 'kind': row['kind'], 'quantity': row['quantity'],
            'parent': row['parent'], 'placement': frames[index], 'status': 'CONFIRMED', 'source': _DI_SOURCE,
            'contents': _DICast(_DIJSON, []), 'mass': row.get('mass'), 'model': None,
            'provenance': _di_row_provenance(provenance, index + 1),
        }
        items.append(_DICast(_DIJSON, item))
    instances: list[_DIJSON] = [
        {'id': ids[0] + ':1', 'localKey': ids[0] + ':1', 'item': ids[0], 'parent': None, 'placement': frames[0]},
        {'id': ids[0] + ':1/' + ids[1] + ':1', 'localKey': ids[1] + ':1', 'item': ids[1],
         'parent': ids[0] + ':1', 'placement': frames[1]},
        {'id': ids[2] + ':1', 'localKey': ids[2] + ':1', 'item': ids[2], 'parent': None, 'placement': frames[2]},
    ]
    ledger: list[_DIJSON] = []
    for item_id in ids:
        ledger.append({'id': item_id, 'physical': 1, 'reference': 0, 'purchase': None, 'contents': 0,
                       'owners': _DICast(_DIJSON, []), 'allocation': None})
    result: dict[str, _DIJSON] = {
        'items': _DICast(_DIJSON, items),
        'instances': _DICast(_DIJSON, instances),
        'ledger': _DICast(_DIJSON, ledger),
        'differences': _DICast(_DIJSON, []),
        'bomProvenance': None,
        'counts': {'ids': 3, 'models': 0, 'instances': 3},
    }
    return _di_plan(operation, owner, revision, result, provenance)


def _di_placement_plan(owner: str, revision: str, records: list[dict[str, _DIJSON]]) -> dict[str, _DIJSON]:
    provenance = _di_inline_provenance(records, revision)
    poses: list[_DIJSON] = []
    for index, row in enumerate(records):
        x_mm = 25 if row['id'] == 'synthetic-assembly' else 0
        pose = {
            'id': row['id'], 'occurrence': row['occurrence'],
            'transform': _di_transform('root', x_mm / 10),
            'provenance': _di_row_provenance(provenance, index + 1),
        }
        poses.append(_DICast(_DIJSON, pose))
    result: dict[str, _DIJSON] = {
        'poses': _DICast(_DIJSON, poses), 'tolerance': 0.0001, 'angleTolerance': 0.00017453292519943296,
    }
    return _di_plan('placement.import', owner, revision, result, provenance)


def _di_cots_plan(owner: str, revision: str, expected_revision: str, step_path: str,
                  step_sha: str) -> dict[str, _DIJSON]:
    identity = _di_transform('component', 0)
    model: dict[str, _DIJSON] = {
        'path': step_path, 'representation': 'envelope', 'source': _DI_SOURCE,
        'status': 'ESTIMATED', 'sha256': step_sha,
    }
    impacts: dict[str, _DIJSON] = {}
    for key in ('matingParts', 'routings', 'refs', 'mass'):
        impacts[key] = {'status': 'known', 'items': _DICast(_DIJSON, []), 'source': 'Isolated synthetic fixture inventory'}
    result: dict[str, _DIJSON] = {
        'target': 'synthetic-cots',
        'model': model,
        'datums': _DICast(_DIJSON, [{'name': 'mount', 'old': identity, 'new': identity,
                                    'delta': _DICast(_DIJSON, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])}]),
        'delta': _DICast(_DIJSON, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        'occurrencePolicy': 'all', 'occurrences': _DICast(_DIJSON, []), 'childrenPolicy': 'error',
        'impacts': impacts, 'mass': {'value': 3, 'unit': 'g', 'status': 'ESTIMATED', 'source': _DI_SOURCE},
    }
    provenance: dict[str, _DIJSON] = {
        'sha256': _di_hash(_DICast(_DIJSON, result)), 'revision': revision, 'pathHost': 'Fusion fixed-run',
    }
    plan = _di_plan('cots.replace', owner, revision, result, provenance, expected_revision)
    _di_object(plan['result'], 'COTS plan')['model'] = {**model, 'fusionPath': step_path}
    return plan


def _di_write_owned_file(filename: str, content: str, owned: list[str]) -> None:
    if _di_os.path.lexists(filename):
        raise RuntimeError('Fixed fixture path already exists; do not overwrite: ' + filename)
    descriptor = _di_os.open(filename, _di_os.O_CREAT | _di_os.O_EXCL | _di_os.O_WRONLY, 0o600)
    owned.append(filename)
    try:
        with _di_os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            stream.write(content)
    except BaseException:
        raise


def _di_remove_owned(files: list[str]) -> list[_DIJSON]:
    removed: list[_DIJSON] = []
    for filename in files:
        if not _di_os.path.lexists(filename):
            continue
        if _di_os.path.islink(filename) or not _di_os.path.isfile(filename):
            raise RuntimeError('Refusing to clean a non-regular fixed fixture path: ' + filename)
        _di_os.remove(filename)
        removed.append(filename)
    return removed


def _di_design_state() -> dict[str, _DIJSON]:
    root = FMCAD.root
    design = FMCAD.design
    return {
        'bodyCount': root.bRepBodies.count,
        'sketchCount': root.sketches.count,
        'occurrenceCount': root.allOccurrences.count,
        'parameterCount': design.userParameters.count,
    }


def _di_placement_records(occurrence: dict[str, _DIJSON]) -> list[dict[str, _DIJSON]]:
    placement: dict[str, _DIJSON] = {
        'frame': 'root', 'translation': ['25 mm', '0 mm', '0 mm'],
        'rotation': _DICast(_DIJSON, [1, 0, 0, 0, 1, 0, 0, 0, 1]),
    }
    return [{'id': 'synthetic-assembly', 'occurrence': occurrence, 'placement': placement,
             'status': 'CONFIRMED', 'source': _DI_SOURCE}]


def _di_cleanup(files: list[str], directory: str, owns_directory: bool) -> list[_DIJSON]:
    removed: list[_DIJSON] = []
    for filename in files:
        if not _di_os.path.lexists(filename):
            continue
        if _di_os.path.islink(filename) or not _di_os.path.isfile(filename) or _di_os.path.dirname(filename) != directory:
            raise RuntimeError('Refusing to clean an unexpected data-import artifact: ' + filename)
        _di_os.remove(filename)
        removed.append(filename)
    if owns_directory and _di_os.path.isdir(directory):
        if _di_os.path.islink(directory) or _di_os.path.realpath(directory) != directory:
            raise RuntimeError('Owned data-import artifact directory changed; leave it for inspection')
        _di_os.rmdir(directory)
    return removed


def run(_context: str) -> dict[str, _DIJSON]:
    import adsk.core

    if ARGS.get('approved') is not True:
        raise RuntimeError('Explicit owner-approved data-import fixture invocation is required')
    doc = FMCAD.doc
    creation_id = doc.creationId
    app = adsk.core.Application.get()
    fusion_version = app.version
    if creation_id != ARGS.get('creationId') or fusion_version != ARGS.get('expectedFusionVersion'):
        raise RuntimeError('Exact owner document and qualified Fusion version are required')
    prefix_value = ARGS.get('fixturePrefix')
    if not isinstance(prefix_value, str) or prefix_value != 'NQGM07IMPORT01':
        raise ValueError('The fixed data-import fixture requires its exact fixture prefix')
    prefix = prefix_value
    if app.activeDocument != doc or app.userInterface.activeCommand not in ('', 'SelectCommand'):
        raise RuntimeError('The exact scratch must already be active with no modeling command in progress')

    calls: list[_DIJSON] = []
    before = _di_call(calls, 'document.status', {})
    if (before.get('creationId') != creation_id or before.get('saved') is not False or
            before.get('modified') is not False or before.get('fileId') is not None):
        raise RuntimeError('Data-import fixture requires the exact pristine unsaved scratch')
    design_before = _di_design_state()
    if any(design_before.get(key) != 0 for key in ('bodyCount', 'sketchCount', 'occurrenceCount', 'parameterCount')):
        raise RuntimeError('Data-import fixture refuses to adopt pre-existing geometry or parameters')

    temp_root = _di_os.path.realpath(_di_tempfile.gettempdir())
    artifact_directory = _di_os.path.join(temp_root, prefix + '_' + creation_id.replace('-', ''))
    if _di_os.path.lexists(artifact_directory):
        raise RuntimeError('Owned data-import temp directory already exists; inspect, do not overwrite')
    _di_os.mkdir(artifact_directory, 0o700)
    owns_directory = True
    artifacts: list[str] = []
    report: dict[str, _DIJSON]
    removed_files: list[_DIJSON] = []
    try:
        owner = prefix + '_owner'
        parameter_names = ('di_' + prefix + '_width', 'di_' + prefix + '_double')
        params = _di_call(calls, 'param.import', _di_param_plan(owner, 'parameters-r1', parameter_names))
        _di_expect(params, 'pass', 'param.import')
        read_parameters = _di_call(calls, 'param.inspect', {'names': _DICast(_DIJSON, list(parameter_names))})
        parameter_rows = _di_rows(read_parameters.get('parameters'), 'param.inspect')
        parameter_a_value = parameter_rows[0].get('value') if len(parameter_rows) > 0 else None
        parameter_b_value = parameter_rows[1].get('value') if len(parameter_rows) > 1 else None
        if (len(parameter_rows) != 2 or parameter_rows[0].get('name') != parameter_names[0] or
                parameter_rows[1].get('name') != parameter_names[1] or
                parameter_rows[0].get('expression') != '5 mm' or parameter_rows[1].get('expression') != parameter_names[0] + ' * 2' or
                not isinstance(parameter_a_value, (float, int)) or abs(float(parameter_a_value) - 0.5) > 1e-9 or
                not isinstance(parameter_b_value, (float, int)) or abs(float(parameter_b_value) - 1) > 1e-9):
            raise RuntimeError('Native imported parameter expressions or numeric readback differ from the fixed case')
        catalog_rows = _di_catalog_records(prefix)
        catalog_plan = _di_catalog_plan(owner, 'catalog-r1', catalog_rows)
        catalog_import = _di_call(calls, 'catalog.import', catalog_plan)
        _di_expect(catalog_import, 'pass', 'catalog.import')
        catalog_instances = _di_rows(catalog_import.get('instances'), 'catalog.import instances')
        if len(catalog_instances) != 3:
            raise RuntimeError('Native catalog import did not create the three expected occurrences')
        by_id = {str(row.get('id')): row for row in catalog_instances}
        id_map = _di_object(catalog_import.get('idMap'), 'catalog idMap')
        for instance_id in ('synthetic-assembly:1', 'synthetic-assembly:1/synthetic-part:1', 'synthetic-cots:1'):
            row = by_id.get(instance_id)
            if row is None:
                raise RuntimeError('Missing native catalog instance: ' + instance_id)
            observed = _di_call(calls, 'entity.inspect', {'ref': row.get('occurrence'), 'frame': 'root'})
            if observed.get('kind') != 'occurrence' or not observed.get('occurrencePath'):
                raise RuntimeError('Catalog occurrence readback is incomplete: ' + instance_id)
        for item_id, expected_name in (
            ('synthetic-assembly', 'FMCAD_DI_' + prefix + '_Assembly'),
            ('synthetic-part', 'FMCAD_DI_' + prefix + '_Part'),
            ('synthetic-cots', 'FMCAD_DI_' + prefix + '_Sensor'),
        ):
            id_entry = _di_object(id_map.get(item_id), 'catalog idMap ' + item_id)
            definition = id_entry.get('definition')
            if definition is None:
                raise RuntimeError('Catalog import returned no native definition for ' + item_id)
            observed_component = _di_call(calls, 'component.inspect', {'component': definition})
            component = _di_object(observed_component.get('component'), 'component.inspect ' + item_id)
            if component.get('name') != expected_name or observed_component.get('bodies') != []:
                raise RuntimeError('Catalog definition readback differs from the fixed owned item: ' + item_id)
        catalog_checked = _di_call(calls, 'catalog.check', _di_catalog_plan(
            owner, 'catalog-r1', catalog_rows, 'catalog.check'))
        _di_expect(catalog_checked, 'pass', 'catalog.check')
        if catalog_checked.get('differences') != [] or len(_di_rows(catalog_checked.get('instances'), 'catalog.check')) != 3:
            raise RuntimeError('Native catalog readback does not match the imported three-item plan')
        assembly_occurrence = _di_object(by_id['synthetic-assembly:1'].get('occurrence'), 'assembly occurrence')
        placement_records = _di_placement_records(assembly_occurrence)
        placement_import = _di_call(calls, 'placement.import', _di_placement_plan(owner, 'placement-r1', placement_records))
        _di_expect(placement_import, 'pass', 'placement.import')
        placed = _di_call(calls, 'placement.check', _di_placement_plan(owner, 'placement-r1', placement_records))
        _di_expect(placed, 'pass', 'placement.check')
        placement_rows = _di_rows(placed.get('poses'), 'placement.check')
        actual_placement = placement_rows[0].get('actual') if placement_rows else None
        if (len(placement_rows) != 1 or placement_rows[0].get('status') != 'pass' or
                not isinstance(actual_placement, list) or len(actual_placement) < 4 or
                not isinstance(actual_placement[3], (float, int)) or abs(float(actual_placement[3]) - 2.5) > 1e-9):
            raise RuntimeError('Native placement readback differs from the requested root X=25 mm')
        source_name = 'FMCAD_DI_' + prefix + '_StepSource'
        source_component = _di_call(calls, 'component.create', {'name': source_name})
        source_ref = source_component.get('component')
        if source_ref is None:
            raise RuntimeError('Synthetic STEP source component was not created')
        box = _di_call(calls, 'shape.box', {
            'name': 'SyntheticReplacementSolid', 'width': '11 mm', 'depth': '7 mm', 'height': '5 mm',
        }, source_name)
        bodies = _di_rows(box.get('bodies'), 'shape.box')
        if len(bodies) != 1:
            raise RuntimeError('Synthetic STEP source must have exactly one native body')
        source_inspected = _di_call(calls, 'component.inspect', {'component': source_ref})
        source_bodies = _di_rows(source_inspected.get('bodies'), 'component.inspect STEP source')
        if len(source_bodies) != 1:
            raise RuntimeError('Synthetic STEP source did not read back one native body')
        source_volume = _di_call(calls, 'measure.volume', {'ref': source_bodies[0], 'units': 'mm3'})
        source_volume_value = source_volume.get('value')
        if not isinstance(source_volume_value, (float, int)) or abs(float(source_volume_value) - 385) > 0.01:
            raise RuntimeError('Synthetic STEP source volume differs from 385 mm3')
        step_path = _di_os.path.join(artifact_directory, 'synthetic-replacement.step')
        if _di_os.path.lexists(step_path):
            raise RuntimeError('Fixed STEP path already exists; do not overwrite')
        artifacts.append(step_path)
        exported = _di_call(calls, 'export.step', {'path': step_path, 'ref': source_ref})
        export_bytes = exported.get('bytes')
        if exported.get('exists') is not True or not isinstance(export_bytes, int) or export_bytes <= 0:
            raise RuntimeError('Synthetic BRep STEP export did not return an owned nonempty file')
        step_hash = _di_file_hash(step_path)
        old_occurrence = by_id['synthetic-cots:1'].get('occurrence')
        old_occurrence_before = _di_call(calls, 'entity.inspect', {'ref': old_occurrence, 'frame': 'root'})
        replaced = _di_call(calls, 'cots.replace', _di_cots_plan(owner, 'cots-r2', 'catalog-r1', step_path, step_hash))
        _di_expect(replaced, 'unknown', 'cots.replace with unresolved material')
        unresolved = _di_rows(replaced.get('unresolved'), 'cots.replace unresolved')
        if not any(row.get('id') == 'synthetic-cots' and row.get('field') == 'replacement.material' and
                   row.get('status') == 'unknown' for row in unresolved):
            raise RuntimeError('COTS replacement must retain the explicit unknown material limitation')
        replacements = _di_rows(replaced.get('replacements'), 'cots.replace replacements')
        if len(replacements) != 1:
            raise RuntimeError('COTS replacement did not report exactly one replacement occurrence')
        replacement = replacements[0].get('after')
        if replacement is None:
            raise RuntimeError('COTS replacement returned no new occurrence reference')
        root_occurrences = _di_call(calls, 'entity.list', {'kind': 'occurrence', 'component': 'root'})
        path_rows = _di_rows(root_occurrences.get('entities'), 'root occurrence list')
        paths = [row.get('path') for row in path_rows]
        new_path = _di_object(replacement, 'replacement reference').get('path')
        if old_occurrence_before.get('occurrencePath') in paths or new_path not in paths:
            raise RuntimeError('Native COTS replacement did not remove the old path and expose the new one')
        replacement_name = 'FMCAD_DI_' + prefix + '_Sensor [cots-r2]'
        replacement_component = _di_call(calls, 'component.inspect', {'component': replacement_name})
        replacement_bodies = _di_rows(replacement_component.get('bodies'), 'replacement component bodies')
        if len(replacement_bodies) != 1:
            raise RuntimeError('Imported STEP did not create one replacement BRep body')
        replacement_volume = _di_call(calls, 'measure.volume', {
            'ref': replacement_bodies[0], 'units': 'mm3',
        })
        replacement_volume_value = replacement_volume.get('value')
        if (not isinstance(replacement_volume_value, (float, int)) or
                abs(float(replacement_volume_value) - float(source_volume_value)) > 0.05):
            raise RuntimeError('Replacement BRep volume differs from its owned STEP source')
        replacement_inspected = _di_call(calls, 'entity.inspect', {'ref': replacement, 'frame': 'root'})
        if replacement_inspected.get('kind') != 'occurrence' or replacement_inspected.get('occurrencePath') != new_path:
            raise RuntimeError('Replacement occurrence readback differs from its exact reference')
        after = _di_call(calls, 'document.status', {})
        design_after = _di_design_state()
        if (after.get('creationId') != creation_id or after.get('saved') is not False or
                after.get('fileId') is not None or app.activeDocument != doc):
            raise RuntimeError('Data-import fixture changed document identity or saved/cloud state')
        report = {
            'version': 1,
            'fixturePrefix': prefix,
            'fusionVersion': fusion_version,
            'document': {'name': doc.name, 'creationId': creation_id, 'before': before, 'after': after},
            'designBefore': design_before,
            'designAfter': design_after,
            'modelChangedByFixture': True,
            'nativeGeometry': True,
            'calls': _DICast(_DIJSON, calls),
            'paramReadback': _DICast(_DIJSON, parameter_rows),
            'catalogInstances': _DICast(_DIJSON, catalog_instances),
            'catalogDifferences': catalog_checked.get('differences'),
            'placementReadback': _DICast(_DIJSON, placement_rows),
            'cotsReadback': {
                'sourceVolumeMm3': source_volume_value,
                'replacementVolumeMm3': replacement_volume_value,
                'oldPath': old_occurrence_before.get('occurrencePath'),
                'newPath': new_path,
                'materialStatus': 'unknown',
            },
            'artifactDirectory': artifact_directory,
            'artifactPaths': _DICast(_DIJSON, artifacts),
            'cleanup': 'The temporary synthetic STEP file is removed by this source; caller closes/restores only the exact modified unsaved scratch after verifying the receipt.',
            'negativeCases': 'Expected-throw native preflight cases are not invoked inside this fixed run because cad-v1 records failed helper calls as unknown; they require a separately classified local test.',
            'limitations': ['COTS material remains explicitly unknown; imported STEP volume/readback is not supplier material validation.',
                'Expected-throw negative native cases are not covered by this fixed run.'],
        }
    finally:
        removed_files = _di_cleanup(artifacts, artifact_directory, owns_directory)

    if not removed_files and artifacts:
        raise RuntimeError('Synthetic data-import artifacts were not cleaned; inspect without retry')
    report['removedFiles'] = _DICast(_DIJSON, removed_files)
    report['artifactDirectoryRemoved'] = not _di_os.path.exists(artifact_directory)
    FMCAD.emit(_DICast(_DIJSON, report))
    return report
