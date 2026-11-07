"""Fixed GM07 native sketch-curve fixture; caller owns the scratch lifecycle."""
from typing import TypeAlias as _GM07TypeAlias, cast as _GM07Cast

_GM07JSON: _GM07TypeAlias = None | bool | int | float | str | list['_GM07JSON'] | dict[str, '_GM07JSON']

ARGS = {}
DOC_NAME = None


def _gm07_object(value: _GM07JSON, label: str) -> dict[str, _GM07JSON]:
    if not isinstance(value, dict):
        raise RuntimeError('GM07 fixture expected an object: ' + label)
    return value


def _gm07_call(operation: str, data: dict[str, _GM07JSON]) -> dict[str, _GM07JSON]:
    return _gm07_object(FMCAD.call(operation, data), operation)


def _gm07_design_state() -> dict[str, _GM07JSON]:
    root = FMCAD.root
    design = FMCAD.design
    return {
        'bodyCount': root.bRepBodies.count,
        'sketchCount': root.sketches.count,
        'occurrenceCount': root.allOccurrences.count,
        'timelineCount': design.timeline.count,
        'parameterCount': design.userParameters.count,
    }


def _gm07_profile_data(sketch: str, revision: str) -> dict[str, _GM07JSON]:
    geometry: list[_GM07JSON] = [
        {'type': 'line', 'start': ['0 cm', '0 cm', '0 cm'], 'end': ['2 cm', '0 cm', '0 cm']},
    ]
    loops: list[_GM07JSON] = [
        {'id': '0', 'geometryIndexes': [0], 'closed': False, 'closureGap': 2},
    ]
    sample_map: list[_GM07JSON] = [
        {'loop': '0', 'sample': 0, 'point': [0, 0, 0], 'index': 0, 'status': 'OPEN'},
        {'loop': '0', 'sample': 1, 'point': [2, 0, 0], 'index': 1, 'status': 'OPEN'},
    ]
    return {
        'schemaVersion': 1,
        'sketch': sketch,
        'frame': 'sketch',
        'tolerance': '0.001 mm',
        'maxSamples': 2000,
        'budgetMs': 10000,
        'geometry': geometry,
        'loops': loops,
        'sampleMap': sample_map,
        'provenance': {
            'path': None,
            'sha256': '0744ab221727c140108ddceaa15f36c4f03743725a58c0443fb8008cb577e0d6',
            'revision': revision,
            'columns': {'x': 'x', 'y': 'y'},
            'units': {'length': 'mm'},
            'status': 'DERIVED',
        },
    }


def run(_context: str) -> dict[str, _GM07JSON]:
    import adsk.core

    if ARGS.get('approved') is not True:
        raise RuntimeError('Explicit owner-approved GM07 fixture invocation is required')
    doc = FMCAD.doc
    creation_id = doc.creationId
    app = adsk.core.Application.get()
    fusion_version = app.version
    if creation_id != ARGS.get('creationId') or fusion_version != ARGS.get('expectedFusionVersion'):
        raise RuntimeError('Exact owner document and qualified Fusion version are required')
    prefix_value = ARGS.get('fixturePrefix')
    if not isinstance(prefix_value, str) or prefix_value != 'NQGM07CURVE01':
        raise ValueError('The fixed GM07 curve case requires its exact fixture prefix')
    prefix = prefix_value
    if app.activeDocument != doc or app.userInterface.activeCommand not in ('', 'SelectCommand'):
        raise RuntimeError('The exact scratch must already be active with no modeling command in progress')
    before = _gm07_call('document.status', {})
    if (before.get('creationId') != creation_id or before.get('saved') is not False or
            before.get('modified') is not False or before.get('fileId') is not None):
        raise RuntimeError('GM07 fixture requires the exact pristine unsaved scratch')
    design_before = _gm07_design_state()
    if any(design_before.get(key) != 0 for key in
           ('bodyCount', 'sketchCount', 'occurrenceCount', 'timelineCount', 'parameterCount')):
        raise RuntimeError('GM07 fixture refuses to adopt pre-existing geometry or parameters')

    sketch_name = prefix + '_Sketch'
    create_data: dict[str, _GM07JSON] = {'name': sketch_name, 'plane': 'XY'}
    create_result = _gm07_call('sketch.create', create_data)
    inspect_empty_data: dict[str, _GM07JSON] = {'sketch': sketch_name}
    inspect_empty = _gm07_call('sketch.inspect', inspect_empty_data)
    profile_data = _gm07_profile_data(sketch_name, 'live-gm07-' + creation_id)
    profile_file = _gm07_call('sketch.profile-file', profile_data)
    fitted = _gm07_call('curve.fit', profile_data)
    fit_entities = fitted.get('entities')
    if not isinstance(fit_entities, list) or len(fit_entities) != 1:
        raise RuntimeError('GM07 fixed input must create exactly one fitted native curve')
    inspect_fit_data: dict[str, _GM07JSON] = {
        'schemaVersion': 1, 'sketch': sketch_name, 'frame': 'sketch', 'entities': _GM07Cast(_GM07JSON, fit_entities),
    }
    inspected_fit = _gm07_call('curve.inspect', inspect_fit_data)
    offset_data: dict[str, _GM07JSON] = {
        'schemaVersion': 1, 'sketch': sketch_name, 'frame': 'sketch',
        'entities': _GM07Cast(_GM07JSON, fit_entities), 'distance': '1 mm', 'side': 'right',
    }
    offset = _gm07_call('curve.offset', offset_data)
    offset_entities = offset.get('entities')
    offset_parameter = offset.get('offsetParameter')
    if not isinstance(offset_entities, list) or len(offset_entities) != 1 or not isinstance(offset_parameter, str):
        raise RuntimeError('GM07 offset did not return one native entity and its offset parameter')
    inspect_offset_data: dict[str, _GM07JSON] = {
        'schemaVersion': 1, 'sketch': sketch_name, 'frame': 'sketch',
        'entities': _GM07Cast(_GM07JSON, offset_entities),
    }
    inspected_offset_before = _gm07_call('curve.inspect', inspect_offset_data)
    edit_data: dict[str, _GM07JSON] = {
        'schemaVersion': 1, 'frame': 'sketch', 'parameter': offset_parameter, 'distance': '2 mm',
    }
    edited = _gm07_call('curve.offset-edit', edit_data)
    inspected_offset_after = _gm07_call('curve.inspect', inspect_offset_data)
    after = _gm07_call('document.status', {})
    design_after = _gm07_design_state()
    if (after.get('creationId') != creation_id or after.get('saved') is not False or
            after.get('modified') is not True or after.get('fileId') is not None or
            app.activeDocument != doc or design_after.get('bodyCount') != 0 or
            design_after.get('occurrenceCount') != 0 or design_after.get('sketchCount') != 1):
        raise RuntimeError('GM07 changed an unexpected document or created a file/body/occurrence; inspect without retry')

    calls: list[_GM07JSON] = [
        {'operation': 'sketch.create', 'data': create_data, 'result': create_result},
        {'operation': 'sketch.inspect', 'data': inspect_empty_data, 'result': inspect_empty},
        {'operation': 'sketch.profile-file', 'data': profile_data, 'result': profile_file},
        {'operation': 'curve.fit', 'data': profile_data, 'result': fitted},
        {'operation': 'curve.inspect', 'data': inspect_fit_data, 'result': inspected_fit},
        {'operation': 'curve.offset', 'data': offset_data, 'result': offset},
        {'operation': 'curve.inspect', 'data': inspect_offset_data, 'result': inspected_offset_before},
        {'operation': 'curve.offset-edit', 'data': edit_data, 'result': edited},
        {'operation': 'curve.inspect', 'data': inspect_offset_data, 'result': inspected_offset_after},
    ]
    report: dict[str, _GM07JSON] = {
        'version': 1,
        'fixturePrefix': prefix,
        'fusionVersion': fusion_version,
        'document': {'name': doc.name, 'creationId': creation_id, 'before': before, 'after': after},
        'designBefore': design_before,
        'designAfter': design_after,
        'modelChangedByFixture': True,
        'nativeGeometry': True,
        'operations': _GM07Cast(_GM07JSON, calls),
        'cleanup': 'No file/cloud effects. This exact sketch fixture changes the scratch; owner must close and restore this exact unsaved document after result verification.',
        'limitations': ['Native sketch curves and offset are read back; sampled inspection is not a global geometric or manufacturing certificate.'],
    }
    FMCAD.emit(report)
    return report
