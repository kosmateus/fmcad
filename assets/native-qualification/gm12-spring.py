"""Fixed GM12 spring/helix recipe and engineering-result fixture."""
from typing import TypeAlias as _GM12TypeAlias, cast as _GM12Cast

_GM12JSON: _GM12TypeAlias = None | bool | int | float | str | list['_GM12JSON'] | dict[str, '_GM12JSON']

ARGS = {}
DOC_NAME = None


def _gm12_object(value: _GM12JSON, label: str) -> dict[str, _GM12JSON]:
    if not isinstance(value, dict):
        raise RuntimeError('GM12 fixture expected an object: ' + label)
    return value


def _gm12_call(operation: str, data: dict[str, _GM12JSON]) -> dict[str, _GM12JSON]:
    return _gm12_object(FMCAD.call(operation, data), operation)


def _gm12_design_state() -> dict[str, _GM12JSON]:
    root = FMCAD.root
    design = FMCAD.design
    return {
        'bodyCount': root.bRepBodies.count,
        'sketchCount': root.sketches.count,
        'occurrenceCount': root.allOccurrences.count,
        'timelineCount': design.timeline.count,
        'timelineMarker': design.timeline.markerPosition,
        'parameterCount': design.userParameters.count,
    }


def run(_context: str) -> dict[str, _GM12JSON]:
    import adsk.core

    if ARGS.get('approved') is not True:
        raise RuntimeError('Explicit owner-approved GM12 test invocation is required')
    doc = FMCAD.doc
    creation_id = doc.creationId
    app = adsk.core.Application.get()
    fusion_version = app.version
    if creation_id != ARGS.get('creationId') or fusion_version != ARGS.get('expectedFusionVersion'):
        raise RuntimeError('Exact owner document and qualified Fusion version are required')
    prefix = ARGS.get('fixturePrefix')
    if not isinstance(prefix, str) or len(prefix) < 8 or len(prefix) > 32 or not prefix.isalnum() or prefix.upper() != prefix:
        raise ValueError('A bounded uppercase alphanumeric fixture prefix is required')
    if app.activeDocument != doc or app.userInterface.activeCommand not in ('', 'SelectCommand'):
        raise RuntimeError('The exact scratch must already be active with no modeling command in progress')

    before = _gm12_call('document.status', {})
    if (before.get('creationId') != creation_id or before.get('saved') is not False or
            before.get('modified') is not False or before.get('fileId') is not None):
        raise RuntimeError('GM12 methods require the exact pristine unsaved scratch')
    design_before = _gm12_design_state()
    if any(design_before.get(key) != 0 for key in ('bodyCount', 'sketchCount', 'occurrenceCount',
                                                    'timelineCount', 'timelineMarker', 'parameterCount')):
        raise RuntimeError('GM12 fixture refuses to adopt pre-existing model geometry or parameters')

    inputs: dict[str, dict[str, _GM12JSON]] = {
        'curve.helix': {
            'schemaVersion': 1, 'frame': 'component', 'radius': '4 mm', 'pitch': '5.75 mm',
            'turns': 8, 'hand': 'right', 'startPhase': '30 deg', 'tolerance': '0.01 mm',
        },
        'shape.spring': {
            'schemaVersion': 1, 'frame': 'component', 'name': 'GM12_Spring',
            'wireDiameter': '0.5 mm', 'meanDiameter': '8 mm', 'activeCoils': 6,
            'totalCoils': 8, 'freeLength': '35 mm', 'shearModulus': '77000 N/mm^2',
            'density': '7850 kg/m^3', 'endStyle': 'ground', 'hand': 'right',
        },
        'spring.evaluate': {
            'schemaVersion': 1, 'frame': 'component', 'wireDiameter': '0.5 mm',
            'meanDiameter': '8 mm', 'activeCoils': 6, 'totalCoils': 8,
            'freeLength': '35 mm', 'shearModulus': '77000 N/mm^2', 'density': '7850 kg/m^3',
            'installedLength': '27 mm', 'compressedLength': '17 mm',
        },
        'spring.configure': {
            'schemaVersion': 1, 'frame': 'component', 'wireDiameter': '0.5 mm',
            'meanDiameter': '8 mm', 'activeCoils': 6, 'totalCoils': 8,
            'freeLength': '35 mm', 'installedLength': '27 mm', 'compressedLength': '17 mm',
            'guide': {'kind': 'rod', 'diameter': '7.4 mm'},
        },
    }
    operations = ['curve.helix', 'shape.spring', 'spring.evaluate', 'spring.configure']
    results: dict[str, _GM12JSON] = {}
    for operation in operations:
        results[operation] = _gm12_call(operation, inputs[operation])

    after = _gm12_call('document.status', {})
    design_after = _gm12_design_state()
    unchanged = (before.get('creationId') == after.get('creationId') == creation_id and
                 before.get('saved') == after.get('saved') is False and
                 before.get('modified') == after.get('modified') is False and
                 before.get('fileId') is None and after.get('fileId') is None and
                 design_before == design_after and app.activeDocument == doc)
    report: dict[str, _GM12JSON] = {
        'version': 1,
        'fixturePrefix': prefix,
        'fusionVersion': fusion_version,
        'document': {'name': doc.name, 'creationId': creation_id, 'before': before, 'after': after},
        'designBefore': design_before,
        'designAfter': design_after,
        'modelUnchanged': unchanged,
        'operations': _GM12Cast(_GM12JSON, operations),
        'inputs': _GM12Cast(_GM12JSON, inputs),
        'results': results,
        'nativeGeometry': False,
        'cleanup': 'No persistent CAD objects or document/file effects were created; exact scratch remains open and unchanged.',
        'limitations': _GM12Cast(_GM12JSON,
            ['Helix and spring geometry are sampled recipe results, not a native BRep or manufacturing certificate.']),
    }
    if not unchanged:
        raise RuntimeError('GM12 test changed the exact scratch; stop and inspect without retry')
    FMCAD.emit(report)
    return report
