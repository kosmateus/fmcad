"""Fixed, source-pinned containment fixture; caller owns document lifecycle."""
from typing import TypeAlias as _FixtureTypeAlias

_FixtureJSON: _FixtureTypeAlias = None | bool | int | float | str | list['_FixtureJSON'] | dict[str, '_FixtureJSON']

ARGS = {}
DOC_NAME = None


def _fixture_call(operation: str, data: "dict[str, _FixtureJSON]") -> "dict[str, _FixtureJSON]":
    value = FMCAD.call(operation, data)
    if not isinstance(value, dict):
        raise RuntimeError('Native fixture operation did not return a JSON object: ' + operation)
    return value


def _fixture_rows(value: "_FixtureJSON") -> "list[dict[str, _FixtureJSON]]":
    if not isinstance(value, list):
        raise RuntimeError('Native containment results are incomplete')
    rows: list[dict[str, _FixtureJSON]] = []
    for row in value:
        if not isinstance(row, dict):
            raise RuntimeError('Native containment result row is not an object')
        rows.append(row)
    return rows


def run(_context: str) -> "dict[str, _FixtureJSON]":
    import adsk.core
    if ARGS.get('approved') is not True:
        raise RuntimeError('Explicit native fixture opt-in is required')
    doc = FMCAD.doc
    creation_id = doc.creationId
    fusion_build = adsk.core.Application.get().version
    if creation_id != ARGS.get('creationId') or fusion_build != ARGS.get('expectedFusionVersion'):
        raise RuntimeError('Exact owned document and qualified Fusion version required')
    prefix = ARGS.get('fixturePrefix')
    if not isinstance(prefix, str) or not prefix or not prefix.isalnum() or prefix.upper() != prefix:
        raise ValueError('An uppercase alphanumeric fixture prefix is required')
    before = _fixture_call('document.status', {})
    if before.get('creationId') != creation_id or before.get('saved') is not False or before.get('modified') is not False:
        raise RuntimeError('Containment fixture requires a fresh unmodified unsaved owned scratch')
    if FMCAD.root.bRepBodies.count or FMCAD.root.sketches.count or FMCAD.root.allOccurrences.count or FMCAD.design.timeline.count:
        raise RuntimeError('Containment fixture must not adopt any existing geometry')
    created = _fixture_call('shape.box', {'name': prefix + '_Body', 'width': '10 mm', 'depth': '10 mm', 'height': '10 mm'})
    bodies = created.get('bodies')
    if created.get('healthState') != 0 or not isinstance(bodies, list) or len(bodies) != 1:
        raise RuntimeError('Native containment fixture did not create one healthy body')
    body = bodies[0]
    if not isinstance(body, dict) or body.get('kind') != 'body' or not isinstance(body.get('token'), str):
        raise RuntimeError('Native containment fixture lacks its exact created body reference')
    body_count = FMCAD.root.bRepBodies.count
    timeline_count = FMCAD.design.timeline.count
    status_before = _fixture_call('document.status', {})
    measured = _fixture_call('measure.contains', {
        'schemaVersion': 1, 'frame': 'component', 'region': {'type': 'body', 'ref': body},
        'points': [['5 mm', '5 mm', '5 mm'], ['12 mm', '5 mm', '5 mm'], ['0 mm', '5 mm', '5 mm']],
        'boundaryTolerance': '0.01 mm', 'method': 'native'})
    status_after = _fixture_call('document.status', {})
    classifications = [row.get('classification') for row in _fixture_rows(measured.get('results'))]
    expected: "list[_FixtureJSON]" = ['inside', 'outside', 'boundary']
    unchanged = (FMCAD.root.bRepBodies.count == body_count and FMCAD.design.timeline.count == timeline_count and
                 status_before.get('saved') == status_after.get('saved') and
                 status_before.get('modified') == status_after.get('modified'))
    native_pass = measured.get('status') == 'pass' and measured.get('method') == 'native' and classifications == expected
    native_unknown = measured.get('status') == 'unknown'
    report: dict[str, _FixtureJSON] = {
        'featureId': 'containment', 'nativeCasesStatus': 'pass' if native_pass and unchanged else 'unknown' if native_unknown else 'fail',
        'fusionBuild': fusion_build, 'document': {'name': doc.name, 'creationId': creation_id,
            'savedBefore': before['saved'], 'modifiedBefore': before['modified']},
        'cases': {
            'native-body-inside-outside-boundary': {'status': 'pass' if native_pass else 'unknown' if native_unknown else 'fail',
                'expected': expected, 'observed': classifications, 'result': measured},
            'temporary-copy-leaves-document-unchanged': {'status': 'pass' if unchanged else 'fail',
                'bodyCountBefore': body_count, 'bodyCountAfter': FMCAD.root.bRepBodies.count,
                'timelineCountBefore': timeline_count, 'timelineCountAfter': FMCAD.design.timeline.count,
                'statusBefore': status_before, 'statusAfter': status_after}},
        'modelUnchangedDuringEvidence': unchanged, 'createdBody': body, 'nativeQualified': False,
        'scratchCleanup': 'separate owner cleanup and exact restore required',
        'limitations': ['Native classification of the declared three points only; no finite-volume coverage or manufacturing claim.',
                         'Unsupported/unknown native containment remains unknown. No document create/open/close/save is performed.']}
    FMCAD.emit(report)
    return report
