"""Pinned section/witness fixture; retains section_witness_shapes.json geometry."""
from typing import TypeAlias as _SectionTypeAlias, cast as _SectionCast

_SectionJSON: _SectionTypeAlias = None | bool | int | float | str | list['_SectionJSON'] | dict[str, '_SectionJSON']

ARGS = {}
DOC_NAME = None


def _section_object(value: _SectionJSON) -> dict[str, _SectionJSON]:
    if not isinstance(value, dict):
        raise RuntimeError('Native section fixture requires a JSON object')
    return value


def _section_rows(value: _SectionJSON) -> list[dict[str, _SectionJSON]]:
    if not isinstance(value, list):
        raise RuntimeError('Native section fixture requires complete result rows')
    return [_section_object(row) for row in value]


def _section_call(operation: str, data: dict[str, _SectionJSON]) -> dict[str, _SectionJSON]:
    return _section_object(FMCAD.call(operation, data))


def _section_body(result: dict[str, _SectionJSON]) -> dict[str, _SectionJSON]:
    rows = _section_rows(result.get('bodies'))
    if len(rows) != 1 or rows[0].get('kind') != 'body' or not isinstance(rows[0].get('token'), str):
        raise RuntimeError('Native fixture did not create exactly one referenced body')
    return rows[0]


def run(_context: str) -> dict[str, _SectionJSON]:
    import math
    import adsk.core
    import adsk.fusion

    doc = FMCAD.doc
    build = adsk.core.Application.get().version
    if ARGS.get('approved') is not True or ARGS.get('creationId') != doc.creationId or ARGS.get('expectedFusionVersion') != build:
        raise RuntimeError('Exact approved owned document and current Fusion build required')
    prefix = ARGS.get('fixturePrefix')
    if not isinstance(prefix, str) or not prefix or not prefix.isalnum() or prefix.upper() != prefix:
        raise ValueError('Uppercase alphanumeric fixture prefix required')
    before = _section_call('document.status', {})
    if before.get('creationId') != doc.creationId or before.get('saved') is not False or before.get('modified') is not False:
        raise RuntimeError('Section fixture requires a fresh unsaved unmodified document')
    if FMCAD.root.bRepBodies.count or FMCAD.root.sketches.count or FMCAD.root.allOccurrences.count or FMCAD.design.timeline.count:
        raise RuntimeError('Section fixture must not adopt existing model geometry')

    def body(operation: str, data: dict[str, _SectionJSON], label: str) -> dict[str, _SectionJSON]:
        return _section_body(_section_call(operation, {**data, 'name': prefix + '_' + label}))

    def ring(label: str) -> dict[str, _SectionJSON]:
        return body('shape.ring', {'outerRadius': '2 cm', 'innerRadius': '1 cm', 'height': '2 cm'}, label)

    def witness_box(label: str, z: str, height: str) -> dict[str, _SectionJSON]:
        plane = _section_call('datum.plane', {'name': prefix + '_' + label + '_plane', 'plane': 'XY', 'offset': z})
        sketch = _section_call('sketch.build', {'name': prefix + '_' + label + '_sketch', 'plane': plane,
            'geometry': [{'type': 'rectangle', 'name': 'box', 'start': ['1.2 cm', '0 cm', '0 cm'],
                          'end': ['1.8 cm', '0.2 cm', '0 cm']}]})
        profiles = sketch.get('profiles')
        if not isinstance(profiles, list) or len(profiles) != 1:
            raise RuntimeError('Witness sketch must produce one native profile')
        return body('model.extrude', {'profile': profiles[0], 'distance': height}, label)

    good = ring('good')
    sector_witness = witness_box('sector_witness', '0.2 cm', '0.2 cm')
    void_good = body('shape.cylinder', {'radius': '0.99 cm', 'height': '2 cm'}, 'void_near_edge')
    void_bad = body('shape.cylinder', {'radius': '1.5 cm', 'height': '2 cm'}, 'void_bad')
    broken_base = ring('broken_base')
    cutter = body('shape.box', {'width': '3 cm', 'depth': '0.3 cm', 'height': '2 cm'}, 'sector_tool')
    broken = body('model.combine', {'target': broken_base, 'tools': [cutter], 'operation': 'cut', 'keepTools': False}, 'missing_sector')
    gap_tool = witness_box('gap_cut_tool', '0.95 cm', '0.1 cm')
    gap_base = ring('gap_base')
    gap_body = body('model.combine', {'target': gap_base, 'tools': [gap_tool], 'operation': 'cut', 'keepTools': False}, 'axial_gap')
    gap_witness = witness_box('gap_witness', '0.95 cm', '0.1 cm')

    frame: dict[str, _SectionJSON] = {'space': 'assembly', 'component': {'kind': 'component', 'name': 'root'}}
    body_count = FMCAD.root.bRepBodies.count
    timeline_count = FMCAD.design.timeline.count
    status_before = _section_call('document.status', {})
    cases: dict[str, _SectionJSON] = {}
    failures: list[_SectionJSON] = []
    unknowns: list[_SectionJSON] = []

    def verify(condition: bool, message: str, unknown: bool = False) -> None:
        if not condition:
            (unknowns if unknown else failures).append(message)

    def expected(name: str, value: dict[str, _SectionJSON], status: str) -> None:
        cases[name] = value
        verify(value.get('status') == status, name + ': unexpected native status ' + str(value.get('status')),
               value.get('status') == 'unknown' and status != 'unknown')

    def check(target: dict[str, _SectionJSON], witness: dict[str, _SectionJSON], expect: str, tolerance: str) -> dict[str, _SectionJSON]:
        return _section_call('measure.witness-check', {'body': target, 'witness': witness, 'frame': frame,
            'expect': expect, 'volumeTolerance': tolerance})

    expected('material-pass', check(good, sector_witness, 'material', '0.001 mm^3'), 'pass')
    expected('void-pass', check(good, void_good, 'void', '150 mm^3'), 'pass')
    expected('void-fail', check(good, void_bad, 'void', '150 mm^3'), 'fail')
    expected('missing-sector-fail', check(broken, sector_witness, 'material', '0.001 mm^3'), 'fail')
    expected('gap-between-stations-fail', check(gap_body, gap_witness, 'material', '0.001 mm^3'), 'fail')

    def series(target: dict[str, _SectionJSON], stations: list[_SectionJSON]) -> dict[str, _SectionJSON]:
        return _section_call('measure.section-series', {'body': target, 'frame': frame,
            'origin': ['0 cm', '0 cm', '0 cm'], 'normal': [0, 0, 1], 'stations': stations})

    ring_sections = series(good, ['0.5 cm', '1.5 cm'])
    expected('closed-ring-sections', ring_sections, 'complete')
    verify(ring_sections.get('coverage') == 'partial', 'Ring series must remain discrete/partial')
    for station in _section_rows(ring_sections.get('stations')):
        loops = _section_rows(station.get('loops'))
        verify(sorted(str(loop.get('role')) for loop in loops) == ['inner', 'outer'] and
               all(loop.get('closed') is True for loop in loops), 'Annulus requires closed inner/outer loops')
        area = station.get('area')
        verify(isinstance(area, (int, float)) and abs(area - 3 * math.pi) < 1e-4, 'Native annulus area unavailable or incorrect', area is None)

    broken_sections = series(broken, ['1 cm'])
    expected('closed-c-section-missing-sector', broken_sections, 'complete')
    broken_rows = _section_rows(broken_sections.get('stations'))
    verify(len(broken_rows) == 1 and broken_sections.get('coverage') == 'partial', 'Missing-sector section must be discrete')
    if len(broken_rows) == 1:
        loops = _section_rows(broken_rows[0].get('loops'))
        area = broken_rows[0].get('area')
        verify([loop.get('role') for loop in loops] == ['outer'] and all(loop.get('closed') is True for loop in loops) and
               isinstance(area, (int, float)) and area > 0, 'Missing-sector outline must be one closed C-shape', area is None)

    # Retained native transient open-wire test: this never enters document BRep.
    manager = adsk.fusion.TemporaryBRepManager.get()
    corners: list[adsk.core.Point3D] = []
    for x, y in [(0, 0), (1, 0), (1, 1), (0, 1)]:
        point = adsk.core.Point3D.create(x, y, 1)
        if point is None:
            raise RuntimeError('Native open-wire point creation failed')
        corners.append(point)
    curves: list[adsk.core.Curve3D] = [adsk.core.Line3D.create(corners[i], corners[i + 1]) for i in range(3)]
    try:
        wire, edges = manager.createWireFromCurves(curves)
        wire_count = wire.edges.count
        verify(wire_count == 3 and len(edges) == 3, 'Native open-wire edge map differs')
        error_message: str | None = None
        try:
            face = _SectionCast('adsk.fusion.BRepBody | None', manager.createFaceFromPlanarWires([wire]))
            accepted = face is not None and face.isValid
        except Exception as error:
            accepted = False
            error_message = str(error)
        cases['native-open-wire-kernel-error'] = {'status': 'unexpected-face' if accepted else 'rejected',
            'nativeWireEdges': wire_count, 'faceBuilderError': error_message}
        verify(not accepted, 'Native face builder accepted an open wire')
    except Exception as error:
        cases['native-open-wire-kernel-error'] = {'status': 'unknown', 'reason': str(error)}
        verify(False, 'Native open-wire kernel result unavailable', True)

    gap_sections = series(gap_body, ['0.5 cm', '1.5 cm'])
    expected('gap-stations-miss-defect', gap_sections, 'complete')
    verify(gap_sections.get('coverage') == 'partial', 'Unsampled axial gap must not become finite coverage')
    absent = series(good, ['3 cm'])
    expected('empty-intersection', absent, 'unknown')
    absent_rows = _section_rows(absent.get('stations'))
    verify(absent.get('coverage') == 'unknown' and len(absent_rows) == 1 and absent_rows[0].get('area') is None,
           'No intersection must not become verified empty')
    tangent = _section_call('measure.section-series', {'body': good, 'frame': frame,
        'origin': ['2 cm', '0 cm', '0 cm'], 'normal': [1, 0, 0], 'stations': ['0 cm']})
    expected('tangent-degenerate-kernel-result', tangent, 'unknown')
    tangent_rows = _section_rows(tangent.get('stations'))
    verify(len(tangent_rows) == 1 and tangent_rows[0].get('area') is None and bool(tangent_rows[0].get('reason')),
           'Tangent kernel ambiguity must retain its reason')
    try:
        _section_call('measure.witness-check', {'body': good, 'witness': sector_witness,
            'frame': {'space': 'component local', 'component': {'kind': 'component', 'name': 'root'}},
            'expect': 'material', 'volumeTolerance': '300 mm^3'})
    except ValueError as error:
        cases['frame-mismatch'] = {'status': 'rejected', 'reason': str(error)}
    except Exception as error:
        cases['frame-mismatch'] = {'status': 'unknown', 'reason': str(error)}
        verify(False, 'Wrong-frame refusal was not proven before Boolean', True)
    else:
        cases['frame-mismatch'] = {'status': 'accepted'}
        verify(False, 'Wrong coordinate frame was silently accepted')
    status_after = _section_call('document.status', {})
    unchanged = (body_count == FMCAD.root.bRepBodies.count and timeline_count == FMCAD.design.timeline.count and status_before == status_after)
    verify(unchanged, 'Native evidence operations changed the document')
    report: dict[str, _SectionJSON] = {'featureId': 'section-witnesses', 'fusionBuild': build,
        'document': {'name': doc.name, 'creationId': doc.creationId, 'savedBefore': before['saved'], 'modifiedBefore': before['modified']},
        'fixture': 'section-witnesses-shared-ring-v1', 'cases': cases,
        'nativeCasesStatus': 'fail' if failures else 'unknown' if unknowns else 'pass',
        'assertionFailures': failures, 'unresolvedAssertions': unknowns, 'modelUnchangedDuringEvidence': unchanged,
        'bodyCountBefore': body_count, 'bodyCountAfter': FMCAD.root.bRepBodies.count,
        'timelineCountBefore': timeline_count, 'timelineCountAfter': FMCAD.design.timeline.count,
        'statusBefore': status_before, 'statusAfter': status_after, 'nativeQualified': False,
        'scratchCleanup': 'separate owner cleanup and exact restore required',
        'limitations': ['Discrete section planes are partial coverage, never finite-solid proof.',
            'Expected unknown intersections and degenerate/tangent kernel results remain unknown.',
            'This program never creates/opens/closes/saves documents or writes files/cloud.']}
    FMCAD.emit(report)
    return report
