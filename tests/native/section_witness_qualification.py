"""Opt-in native qualification in a caller-created, identity-pinned scratch.

Run only as trusted ``fmcad run --helpers cad-v1 --doc NAME --doc-id ID`` via
the shared broker. This runner NEVER creates/opens/closes/restores a document.
It creates feature fixtures only in the explicitly pinned ``FMCAD.doc`` and
verifies native measurements there. The caller must subsequently use the shared
broker: inspect ``doc list`` and verify this exact creationId is active, then
close with ``doc close --discard`` inside the same short exclusive sequence and
verify scratch removal/protected documents with another fresh ``doc list``.
No global active-document access or stale-ID cleanup is performed here.
"""
DOC_NAME = None
ARGS = {}
QUALIFIED_FUSION_VERSION = '2706.1.14'


def _require(condition, message):
    if not condition:
        raise RuntimeError(message)


def _cm(value):
    return format(float(value), '.12g') + ' cm'


def _one_body(result, label):
    bodies = result.get('bodies')
    _require(isinstance(bodies, list) and len(bodies) == 1,
             label + ' did not create exactly one solid body: ' + repr(result))
    return bodies[0]


def run(_context):
    import math
    import adsk.core
    import adsk.fusion

    if ARGS.get('approved') is not True:
        raise RuntimeError('Explicit native qualification approval is required')
    expected_id = ARGS.get('creationId')
    expected_build = ARGS.get('expectedFusionVersion')
    if not isinstance(expected_id, str) or not expected_id:
        raise ValueError('Fresh pinned scratch creationId is required')
    if expected_build != QUALIFIED_FUSION_VERSION:
        raise ValueError('Native qualification is pinned to Fusion ' + QUALIFIED_FUSION_VERSION)

    app = adsk.core.Application.get()
    doc = FMCAD.doc
    creation_id = str(doc.creationId)
    _require(creation_id == expected_id, 'Pinned scratch creationId changed before test')
    version = str(app.version)
    _require(version == expected_build == QUALIFIED_FUSION_VERSION,
             'Fusion build changed between probe and test: ' + version)
    before = FMCAD.call('document.status', {})
    _require(before.get('creationId') == creation_id and before.get('saved') is False and
             before.get('modified') is False,
             'Pinned scratch must be freshly read, unsaved and unmodified before the fixture')

    report = {'nativeQualified': False, 'fusionBuild': version,
              'document': {'name': str(doc.name), 'creationId': creation_id,
                           'fileId': before.get('fileId'), 'savedBefore': before['saved'],
                           'modifiedBefore': before['modified']},
              'activeBeforeId': ARGS.get('activeBeforeId'),
              'fixture': 'section-witnesses-shared-ring-v1', 'cases': {},
              'limitations': ['No global activeDocument read or restore is attempted.',
                              'The scratch must be created by a separate fmcad broker command.',
                              'A section series proves only requested discrete planes.']}
    passed = False
    failures = []
    unknowns = []

    def verify(condition, message, *, unknown=False):
        if condition:
            return
        (unknowns if unknown else failures).append(message)

    def expect_status(name, result, expected):
        observed = result.get('status')
        if observed != expected:
            verify(False, name + ' expected ' + expected + ', got ' + str(observed),
                   unknown=observed == 'unknown')

    try:
        ring = ARGS['ring']
        sector = ARGS['missingSector']
        sector_witness_bounds = ARGS['sectorWitness']
        gap = ARGS['gapBetweenPoints']
        prefix = ARGS['fixturePrefix']
        shape = lambda operation, data: FMCAD.call(operation, data)

        def create_body(operation, params, label):
            return _one_body(shape(operation, dict(params, name=prefix + '_' + label)), label)

        def extruded_box(label, bounds, plane):
            low, high = bounds['min'], bounds['max']
            sketch = shape('sketch.build', {
                'name': prefix + '_' + label + '_sketch', 'plane': plane,
                'geometry': [{'type': 'rectangle', 'name': 'box',
                              'start': [_cm(low[0]), _cm(low[1]), '0 mm'],
                              'end': [_cm(high[0]), _cm(high[1]), '0 mm']}]})
            return create_body('model.extrude', {
                'profile': sketch['profiles'][0], 'distance': _cm(high[2] - low[2]),
                'name': prefix + '_' + label}, label)

        good = create_body('shape.ring', {
            'outerRadius': _cm(ring['outerRadius']), 'innerRadius': _cm(ring['innerRadius']),
            'height': _cm(ring['height'])}, 'good')
        witness_min, witness_max = sector_witness_bounds['min'], sector_witness_bounds['max']
        _require(all(witness_min[i] >= sector['min'][i] and witness_max[i] <= sector['max'][i]
                     for i in range(3)), 'Sector witness must be wholly inside the missing-sector cutter')
        _require(witness_min[0] ** 2 + witness_min[1] ** 2 > ring['innerRadius'] ** 2 and
                 witness_max[0] ** 2 + witness_max[1] ** 2 < ring['outerRadius'] ** 2,
                 'Sector witness must be wholly inside the good ring material')
        sector_witness_plane = shape('datum.plane', {
            'name': prefix + '_sector_witness_plane', 'plane': 'XY',
            'offset': _cm(witness_min[2])})
        sector_witness = extruded_box('sector_witness', sector_witness_bounds, sector_witness_plane)
        void_radius = ring['innerRadius'] - .01
        void_near_edge = create_body('shape.cylinder', {
            'radius': _cm(void_radius), 'height': _cm(ring['height'])}, 'void_near_edge')
        void_bad = create_body('shape.cylinder', {
            'radius': _cm((ring['innerRadius'] + ring['outerRadius']) / 2),
            'height': _cm(ring['height'])}, 'void_bad')

        broken = create_body('shape.ring', {
            'outerRadius': _cm(ring['outerRadius']), 'innerRadius': _cm(ring['innerRadius']),
            'height': _cm(ring['height'])}, 'broken_base')
        cutter_min, cutter_max = sector['min'], sector['max']
        _require(all(abs(float(v)) < 1e-12 for v in cutter_min),
                 'Native box fixture expects the origin-anchored missing-sector bounds')
        sector_tool = create_body('shape.box', {
            'width': _cm(cutter_max[0] - cutter_min[0]),
            'depth': _cm(cutter_max[1] - cutter_min[1]),
            'height': _cm(cutter_max[2] - cutter_min[2])}, 'sector_tool')
        broken = _one_body(shape('model.combine', {'target': broken, 'tools': [sector_tool],
            'operation': 'cut', 'keepTools': False, 'name': prefix + '_missing_sector'}),
            'missing-sector cut')

        gap_min, gap_max = gap['min'], gap['max']
        gap_plane = shape('datum.plane', {'name': prefix + '_gap_plane', 'plane': 'XY',
                                          'offset': _cm(gap_min[2])})
        gap_tool = extruded_box('gap_cut_tool', gap, gap_plane)
        gap_body = create_body('shape.ring', {
            'outerRadius': _cm(ring['outerRadius']), 'innerRadius': _cm(ring['innerRadius']),
            'height': _cm(ring['height'])}, 'gap_base')
        gap_body = _one_body(shape('model.combine', {'target': gap_body, 'tools': [gap_tool],
            'operation': 'cut', 'keepTools': False, 'name': prefix + '_axial_gap'}), 'gap cut')
        gap_witness = extruded_box('gap_witness', gap, gap_plane)

        frame = {'space': 'assembly', 'component': {'kind': 'component', 'name': 'root'}}
        before_evidence = (FMCAD.root.bRepBodies.count, FMCAD.design.timeline.count)
        check = lambda target, witness, expect, tolerance: FMCAD.call('measure.witness-check', {
            'body': target, 'witness': witness, 'frame': frame, 'expect': expect,
            'volumeTolerance': tolerance})
        cases = [
            ('material-pass', check(good, sector_witness, 'material', '0.001 mm^3'), 'pass'),
            ('void-pass', check(good, void_near_edge, 'void', '150 mm^3'), 'pass'),
            ('void-fail', check(good, void_bad, 'void', '150 mm^3'), 'fail'),
            ('missing-sector-fail', check(broken, sector_witness, 'material', '0.001 mm^3'), 'fail'),
            ('gap-between-stations-fail', check(gap_body, gap_witness, 'material', '0.001 mm^3'), 'fail'),
        ]
        for name, result, expected_status in cases:
            report['cases'][name] = result
            expect_status(name, result, expected_status)
            if expected_status == 'pass' and result.get('status') == 'pass':
                FMCAD.require_pass(result)

        expect_status('missing-sector-fail', report['cases']['missing-sector-fail'], 'fail')
        expect_status('gap-between-stations-fail', report['cases']['gap-between-stations-fail'], 'fail')

        stations = [_cm(v) for v in ARGS['stations']]
        series = lambda ref, offsets: FMCAD.call('measure.section-series', {
            'body': ref, 'frame': frame, 'origin': ['0 mm', '0 mm', '0 mm'],
            'normal': [0, 0, 1], 'stations': offsets})
        ring_sections = series(good, stations)
        report['cases']['closed-ring-sections'] = ring_sections
        expect_status('closed-ring-sections', ring_sections, 'complete')
        verify(ring_sections.get('coverage') == 'partial',
               'Native ring section coverage must remain discrete/partial')
        for row in ring_sections.get('stations') or []:
            loops = row.get('loops') or []
            verify(sorted(loop['role'] for loop in loops) == ['inner', 'outer'],
                     'Annulus section must report one closed outer and inner loop')
            verify(all(loop.get('closed') is True for loop in loops),
                   'Annulus loops must be marked closed')
            if isinstance(row.get('area'), (int, float)):
                verify(abs(row['area'] - math.pi * (ring['outerRadius'] ** 2 - ring['innerRadius'] ** 2)) < 1e-4,
                       'Native annulus section area differs from shared fixture dimensions')
            else:
                verify(False, 'Native annulus section area is unavailable', unknown=True)

        broken_section = series(broken, [_cm((sector['min'][2] + sector['max'][2]) / 2)])
        report['cases']['closed-c-section-missing-sector'] = broken_section
        expect_status('closed-c-section-missing-sector', broken_section, 'complete')
        verify(broken_section.get('coverage') == 'partial',
               'Missing-sector section coverage must remain discrete/partial')
        broken_rows = broken_section.get('stations') or []
        broken_loops = broken_rows[0].get('loops') or [] if len(broken_rows) == 1 else []
        verify(len(broken_rows) == 1 and [loop['role'] for loop in broken_loops] == ['outer'] and
               all(loop.get('closed') is True for loop in broken_loops) and
               isinstance(broken_rows[0].get('area'), (int, float)) and broken_rows[0]['area'] > 0,
               'A missing-sector annulus must produce one closed C-shaped material outline',
               unknown=len(broken_rows) == 1 and broken_rows[0].get('area') is None)

        # A missing angular sector leaves a closed C-shaped section. Probe the
        # separate native open-wire contract with real transient line geometry.
        manager = adsk.fusion.TemporaryBRepManager.get()
        z = (sector['min'][2] + sector['max'][2]) / 2
        corners = [adsk.core.Point3D.create(0, 0, z),
                   adsk.core.Point3D.create(1, 0, z),
                   adsk.core.Point3D.create(1, 1, z),
                   adsk.core.Point3D.create(0, 1, z)]
        curves = [adsk.core.Line3D.create(corners[index], corners[index + 1])
                  for index in range(len(corners) - 1)]
        if not all(curves):
            report['cases']['native-open-wire-kernel-error'] = {
                'status': 'unknown', 'reason': 'Fusion could not create open-wire line geometry'}
            verify(False, 'Native open-wire line geometry could not be created', unknown=True)
        else:
            try:
                open_wire, open_edges = manager.createWireFromCurves(curves)
                if open_wire is None or open_wire.edges.count != len(curves) or len(open_edges) != len(curves):
                    raise RuntimeError('Fusion did not return the expected native open wire and edge map')
                kernel_error = None
                try:
                    open_face = manager.createFaceFromPlanarWires([open_wire])
                except Exception as error:
                    open_face = None
                    kernel_error = str(error)
                face_invalid = open_face is not None and getattr(open_face, 'isValid', True) is False
                face_failed = open_face is None or face_invalid
                report['cases']['native-open-wire-kernel-error'] = {
                    'status': 'rejected' if face_failed else 'unexpected-face',
                    'nativeWireEdges': open_wire.edges.count,
                    'faceBuilderReturnedNull': open_face is None and kernel_error is None,
                    'faceBuilderReturnedInvalidBody': face_invalid,
                    'faceBuilderError': kernel_error,
                }
                verify(face_failed, 'Fusion face builder unexpectedly accepted a native open wire')
            except Exception as error:
                report['cases']['native-open-wire-kernel-error'] = {
                    'status': 'unknown', 'reason': str(error)}
                verify(False, 'Native open-wire kernel result is unknown: ' + str(error), unknown=True)

        gap_sections = series(gap_body, stations)
        report['cases']['gap-stations-miss-defect'] = gap_sections
        expect_status('gap-stations-miss-defect', gap_sections, 'complete')
        verify(gap_sections.get('coverage') == 'partial',
               'Stations outside an unsampled axial gap are discrete evidence only')
        verify(all(value < gap_min[2] or value > gap_max[2] for value in ARGS['stations']),
               'Shared section stations must remain outside the deliberate axial gap')
        absent = series(good, ['30 mm'])
        report['cases']['empty-intersection'] = absent
        expect_status('empty-intersection', absent, 'unknown')
        absent_rows = absent.get('stations') or []
        verify(absent.get('coverage') == 'unknown' and len(absent_rows) == 1 and
               absent_rows[0].get('area') is None,
               'SDK no-intersection result must be unknown, not verified empty',
               unknown=not absent_rows or len(absent_rows) == 1 and absent_rows[0].get('area') is None)

        tangent = FMCAD.call('measure.section-series', {
            'body': good, 'frame': frame,
            'origin': [_cm(ring['outerRadius']), '0 mm', '0 mm'],
            'normal': [1, 0, 0], 'stations': ['0 mm']})
        report['cases']['tangent-degenerate-kernel-result'] = tangent
        expect_status('tangent-degenerate-kernel-result', tangent, 'unknown')
        tangent_rows = tangent.get('stations') or []
        verify(len(tangent_rows) == 1 and tangent_rows[0].get('area') is None and
               bool(tangent_rows[0].get('reason')),
               'A tangent/degenerate native section must remain unknown with its kernel reason',
               unknown=tangent.get('status') == 'unknown')

        try:
            # A deliberately mismatched frame must be rejected before Boolean.
            FMCAD.call('measure.witness-check', {'body': good, 'witness': sector_witness,
                'frame': {'space': 'component local', 'component': {'kind': 'component', 'name': 'root'}},
                'expect': 'material', 'volumeTolerance': '300 mm^3'})
        except ValueError as error:
            report['cases']['frame-mismatch'] = {'status': 'rejected', 'reason': str(error)}
        except Exception as error:
            report['cases']['frame-mismatch'] = {'status': 'unknown', 'reason': str(error)}
            verify(False, 'Frame mismatch was not proven before Boolean: ' + str(error), unknown=True)
        else:
            report['cases']['frame-mismatch'] = {'status': 'accepted'}
            verify(False, 'Mixed or mismatched frame was silently accepted')

        counts_after = (FMCAD.root.bRepBodies.count, FMCAD.design.timeline.count)
        verify(before_evidence == counts_after,
               'Measurement/witness operations mutated the prepared scratch model')
        status = FMCAD.call('document.status', {})
        verify(status.get('creationId') == creation_id and status.get('saved') is False,
               'Pinned scratch identity changed or was saved during native checks')
        report['modelUnchangedDuringEvidence'] = before_evidence == counts_after
        passed = not failures and not unknowns
        if failures:
            report['assertionFailures'] = failures
        if unknowns:
            report['unresolvedAssertions'] = unknowns
    except Exception as error:
        report['error'] = str(error)
    report['nativeCasesStatus'] = 'fail' if failures else 'unknown' if unknowns or not passed else 'pass'
    report['scratchCleanup'] = 'pending: caller must verify active identity, close --discard via broker, then doc list'
    # Native acceptance remains false until the separate brokered close/readback
    # proves that only this unsaved scratch was discarded and prior docs survived.
    report['nativeQualified'] = False
    FMCAD.emit(report)
    return report
