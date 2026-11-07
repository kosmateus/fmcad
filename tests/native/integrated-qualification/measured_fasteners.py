"""Native axial measurement cases on one caller-pinned disposable scratch."""
ARGS = {}


def run(_context):
    import adsk.core

    if ARGS.get('approved') is not True:
        raise RuntimeError('Explicit native qualification opt-in is required')
    doc = FMCAD.doc
    creation_id = str(doc.creationId)
    if creation_id != ARGS.get('creationId'):
        raise RuntimeError('Pinned scratch creationId mismatch')
    fusion_build = str(adsk.core.Application.get().version)
    if fusion_build != ARGS.get('expectedFusionVersion'):
        raise RuntimeError('Fusion build differs from the fresh qualified build receipt')
    before = FMCAD.call('document.status', {})
    if before.get('creationId') != creation_id or before.get('saved') is not False or before.get('modified') is not False:
        raise RuntimeError('Measured fasteners require a fresh unsaved, unmodified scratch')
    prefix = ARGS.get('fixturePrefix')
    if not isinstance(prefix, str) or not prefix or not prefix.isalnum() or prefix.upper() != prefix:
        raise ValueError('fixturePrefix must be nonempty uppercase alphanumeric text')

    def point(name, coordinates):
        result = FMCAD.call('datum.point', {'name': prefix + '_' + name,
            'mode': 'coordinates', 'point': [str(value) + ' mm' for value in coordinates]})
        if result.get('kind') != 'point' and result.get('objectType') != 'adsk::fusion::ConstructionPoint':
            raise RuntimeError('Native datum point did not return a point reference: ' + name)
        return result

    def axis(name, start, end):
        result = FMCAD.call('datum.axis', {'name': prefix + '_' + name,
            'mode': 'twoPoints', 'point1': start, 'point2': end})
        if result.get('kind') != 'axis' and result.get('objectType') != 'adsk::fusion::ConstructionAxis':
            raise RuntimeError('Native datum axis did not return an axis reference: ' + name)
        return result

    screw_axis_start = point('ScrewAxisStart', [0, 0, 0])
    screw_axis_end = point('ScrewAxisEnd', [0, 0, 1])
    receptacle_axis_start = point('ReceptacleAxisStart', [0, 0, 0])
    receptacle_axis_end = point('ReceptacleAxisEnd', [0, 0, 1])
    screw_axis = axis('ScrewAxis', screw_axis_start, screw_axis_end)
    receptacle_axis = axis('ReceptacleAxis', receptacle_axis_start, receptacle_axis_end)
    head = point('HeadBearing', [0, 0, 0])
    tip = point('Tip', [0, 0, 10])
    screw_start = point('ScrewThreadStart', [0, 0, 4])
    screw_end = point('ScrewThreadEnd', [0, 0, 10])
    hole_start = point('HoleThreadStart', [0, 0, 5])
    hole_end = point('HoleThreadEnd', [0, 0, 13])
    hole_bottom = point('HoleBottom', [0, 0, 13])
    layer_start = point('BracketStart', [0, 0, 0])
    layer_end = point('BracketEnd', [0, 0, 5])

    def request(*, screw_tip=tip, screw_thread_end=screw_end, receptacle_axis_ref=receptacle_axis,
                bottom=hole_bottom, thread_end=hole_end):
        return {
            'schemaVersion': 1, 'mode': 'native',
            'native': {
                'schemaVersion': 1,
                'frame': {'space': 'assembly', 'component': {'kind': 'component', 'name': 'root'}},
                'tolerance': {'axisOffset': '0.05 mm', 'axisAngle': '1 deg', 'minimumEngagement': '4 mm'},
                'screw': {'axis': screw_axis, 'headBearing': head, 'tip': screw_tip,
                          'threadStart': screw_start, 'threadEnd': screw_thread_end},
                'receptacle': {'kind': 'blind', 'axis': receptacle_axis_ref,
                               'threadStart': hole_start, 'threadEnd': thread_end, 'bottom': bottom},
                'layers': [{'id': 'bracket', 'start': layer_start, 'end': layer_end}],
            },
            'declaredEvidence': {
                'operation': 'fastener.check', 'schemaVersion': 1, 'frame': 'component',
                'screw': {'length': '12 mm', 'threadLength': '10 mm'},
                'stack': [{'id': 'bracket', 'thickness': '5 mm'}],
                'minimumEngagement': '4 mm',
                'receptacle': {'kind': 'tapped', 'depth': '8 mm'},
            },
        }

    baseline = FMCAD.call('fastener.measured-check', request())
    bottoming_tip = point('BottomingTip', [0, 0, 10])
    bottoming_bottom = point('BottomingHoleBottom', [0, 0, 8])
    bottoming = FMCAD.call('fastener.measured-check', request(screw_tip=bottoming_tip,
        bottom=bottoming_bottom))
    short_tip = point('ShortTip', [0, 0, 8])
    short_thread_end = point('ShortThreadEnd', [0, 0, 8])
    short_bolt = FMCAD.call('fastener.measured-check', request(screw_tip=short_tip,
        screw_thread_end=short_thread_end))
    offset_origin = point('OffsetReceptacleOrigin', [0.2, 0, 0])
    offset_second = point('OffsetReceptacleAxisEnd', [0.2, 0, 1])
    misaligned_axis = axis('MisalignedAxis', offset_origin, offset_second)
    misaligned = FMCAD.call('fastener.measured-check', request(receptacle_axis_ref=misaligned))
    missing = FMCAD.call('fastener.measured-check', request(thread_end=None))

    body_count_before_reads = FMCAD.root.bRepBodies.count
    timeline_count_before_reads = FMCAD.design.timeline.count
    status_before_reads = FMCAD.call('document.status', {})
    native_result = baseline.get('nativeMeasurements', {})
    engagement = native_result.get('measurements', {}).get('actualEngagement', {})
    provenance = engagement.get('provenance') or []
    frame = native_result.get('frame') or {}
    provenance_complete = (engagement.get('status') == 'measured' and engagement.get('sourceVersion') == 1 and len(provenance) >= 4 and all(
        source.get('sourceVersion') == 1 and source.get('sourceRef') and
        source.get('frame') == frame and source.get('documentIdentity', {}).get('creationId') == creation_id
        for source in provenance))
    statuses = {
        'declared-stack-is-separate': baseline.get('declaredEvidence', {}).get('status') == 'reported' and
            baseline.get('declaredEvidence', {}).get('result', {}).get('status') == 'pass' and
            engagement.get('value') == 5,
        'baseline-native-engagement': baseline.get('status') == 'pass',
        'measurement-source-frame-and-coverage': provenance_complete and
            frame.get('space') == 'assembly' and native_result.get('coverage', {}).get('status') == 'complete' and
            native_result.get('coverage', {}).get('frameStatus') == 'measured',
        'bottoming-negative-even-with-legacy-pass': bottoming.get('status') == 'fail' and
            baseline.get('declaredEvidence', {}).get('result', {}).get('status') == 'pass',
        'short-bolt-minimum-engagement-negative': short_bolt.get('status') == 'fail',
        'misaligned-native-axes-negative': misaligned.get('status') == 'fail',
        'missing-native-measurement-remains-unknown': missing.get('status') == 'unknown',
    }
    after = FMCAD.call('document.status', {})
    body_count = FMCAD.root.bRepBodies.count
    timeline_count = FMCAD.design.timeline.count
    model_unchanged = (body_count == body_count_before_reads and timeline_count == timeline_count_before_reads and
                       status_before_reads.get('modified') == after.get('modified') and
                       status_before_reads.get('saved') == after.get('saved') and after.get('creationId') == creation_id)
    statuses['model-and-save-state-unchanged'] = model_unchanged
    failed = any(value is False for value in statuses.values())
    report = {
        'featureId': 'measured-fasteners',
        'nativeCasesStatus': 'fail' if failed else 'pass',
        'fusionBuild': fusion_build,
        'document': {'name': str(doc.name), 'creationId': creation_id,
                     'savedBefore': before['saved'], 'modifiedBefore': before['modified']},
        'cases': {key: {'status': 'pass' if value else 'fail', 'result': result}
                  for key, value, result in (
                      ('declared-stack-is-separate', statuses['declared-stack-is-separate'], baseline.get('declaredEvidence')),
                      ('baseline-native-engagement', statuses['baseline-native-engagement'], baseline),
                      ('measurement-source-frame-and-coverage', statuses['measurement-source-frame-and-coverage'], baseline),
                      ('bottoming-negative-even-with-legacy-pass', statuses['bottoming-negative-even-with-legacy-pass'], bottoming),
                      ('short-bolt-minimum-engagement-negative', statuses['short-bolt-minimum-engagement-negative'], short_bolt),
                      ('misaligned-native-axes-negative', statuses['misaligned-native-axes-negative'], misaligned),
                      ('missing-native-measurement-remains-unknown', statuses['missing-native-measurement-remains-unknown'], missing),
                      ('model-and-save-state-unchanged', statuses['model-and-save-state-unchanged'], after),
                  )},
        'modelUnchangedDuringEvidence': model_unchanged,
        'nativeQualified': False,
        'scratchCleanup': 'pending: caller must verify exact active creationId, discard only this scratch, then read back inventory',
    }
    FMCAD.emit(report)
    return report
