"""Fixed native axial fixture, retaining measured_fasteners.py test geometry."""
from typing import TypeAlias as _FastenerFixtureAlias

_FastenerFixtureJSON: _FastenerFixtureAlias = None | bool | int | float | str | list['_FastenerFixtureJSON'] | dict[str, '_FastenerFixtureJSON']

ARGS = {}
DOC_NAME = None


def _fastener_object(value: _FastenerFixtureJSON) -> dict[str, _FastenerFixtureJSON]:
    if not isinstance(value, dict):
        raise RuntimeError('Native fastener fixture requires a complete JSON object')
    return value


def _fastener_call(operation: str, data: dict[str, _FastenerFixtureJSON]) -> dict[str, _FastenerFixtureJSON]:
    return _fastener_object(FMCAD.call(operation, data))


def _fastener_provenance(metric: dict[str, _FastenerFixtureJSON], frame: _FastenerFixtureJSON, creation_id: str) -> bool:
    sources = metric.get('provenance')
    if metric.get('status') != 'measured' or metric.get('sourceVersion') != 1 or not isinstance(sources, list) or len(sources) < 4:
        return False
    for source in sources:
        if not isinstance(source, dict):
            return False
        identity = source.get('documentIdentity')
        if not isinstance(identity, dict) or source.get('sourceVersion') != 1 or not source.get('sourceRef') or source.get('frame') != frame or identity.get('creationId') != creation_id:
            return False
    return True


def run(_context: str) -> dict[str, _FastenerFixtureJSON]:
    import adsk.core
    doc = FMCAD.doc
    build = adsk.core.Application.get().version
    if ARGS.get('approved') is not True or ARGS.get('creationId') != doc.creationId or ARGS.get('expectedFusionVersion') != build:
        raise RuntimeError('Exact approved owned fastener document and Fusion build required')
    prefix = ARGS.get('fixturePrefix')
    if not isinstance(prefix, str) or not prefix or not prefix.isalnum() or prefix.upper() != prefix:
        raise ValueError('Uppercase alphanumeric fixture prefix required')
    before = _fastener_call('document.status', {})
    if before.get('creationId') != doc.creationId or before.get('saved') is not False or before.get('modified') is not False:
        raise RuntimeError('Fastener fixture requires a fresh unsaved unmodified document')
    if FMCAD.root.bRepBodies.count or FMCAD.root.sketches.count or FMCAD.root.allOccurrences.count or FMCAD.design.timeline.count:
        raise RuntimeError('Fastener fixture cannot adopt existing geometry')

    def point(name: str, x: float, y: float, z: float) -> dict[str, _FastenerFixtureJSON]:
        result = _fastener_call('datum.point', {'name': prefix + '_' + name, 'mode': 'coordinates',
            'point': [str(x) + ' mm', str(y) + ' mm', str(z) + ' mm']})
        if result.get('kind') != 'point' and result.get('objectType') != 'adsk::fusion::ConstructionPoint':
            raise RuntimeError('Native construction point reference is unavailable: ' + name)
        return result

    def axis(name: str, start: dict[str, _FastenerFixtureJSON], end: dict[str, _FastenerFixtureJSON]) -> dict[str, _FastenerFixtureJSON]:
        result = _fastener_call('datum.axis', {'name': prefix + '_' + name, 'mode': 'twoPoints', 'point1': start, 'point2': end})
        if result.get('kind') != 'axis' and result.get('objectType') != 'adsk::fusion::ConstructionAxis':
            raise RuntimeError('Native construction axis reference is unavailable: ' + name)
        return result

    screw_axis = axis('ScrewAxis', point('ScrewAxisStart', 0, 0, 0), point('ScrewAxisEnd', 0, 0, 1))
    hole_axis = axis('ReceptacleAxis', point('ReceptacleAxisStart', 0, 0, 0), point('ReceptacleAxisEnd', 0, 0, 1))
    head = point('HeadBearing', 0, 0, 0)
    tip = point('Tip', 0, 0, 10)
    screw_start = point('ScrewThreadStart', 0, 0, 4)
    screw_end = point('ScrewThreadEnd', 0, 0, 10)
    hole_start = point('HoleThreadStart', 0, 0, 5)
    hole_end = point('HoleThreadEnd', 0, 0, 13)
    bottom = point('HoleBottom', 0, 0, 13)
    layer_start = point('BracketStart', 0, 0, 0)
    layer_end = point('BracketEnd', 0, 0, 5)
    bottoming_tip = point('BottomingTip', 0, 0, 10)
    bottoming_bottom = point('BottomingHoleBottom', 0, 0, 8)
    short_tip = point('ShortTip', 0, 0, 8)
    short_end = point('ShortThreadEnd', 0, 0, 8)
    offset_axis = axis('MisalignedAxis', point('OffsetReceptacleOrigin', 0.2, 0, 0), point('OffsetReceptacleAxisEnd', 0.2, 0, 1))
    frame: dict[str, _FastenerFixtureJSON] = {'space': 'assembly', 'component': {'kind': 'component', 'name': 'root'}}

    def request(screw_tip: dict[str, _FastenerFixtureJSON], thread_end: dict[str, _FastenerFixtureJSON],
                receptacle_axis: dict[str, _FastenerFixtureJSON], hole_bottom: dict[str, _FastenerFixtureJSON],
                receptacle_end: _FastenerFixtureJSON) -> dict[str, _FastenerFixtureJSON]:
        return {'schemaVersion': 1, 'mode': 'native', 'native': {'schemaVersion': 1, 'frame': frame,
            'tolerance': {'axisOffset': '0.05 mm', 'axisAngle': '1 deg', 'minimumEngagement': '4 mm'},
            'screw': {'axis': screw_axis, 'headBearing': head, 'tip': screw_tip, 'threadStart': screw_start, 'threadEnd': thread_end},
            'receptacle': {'kind': 'blind', 'axis': receptacle_axis, 'threadStart': hole_start, 'threadEnd': receptacle_end, 'bottom': hole_bottom},
            'layers': [{'id': 'bracket', 'start': layer_start, 'end': layer_end}]},
            'declaredEvidence': {'operation': 'fastener.check', 'schemaVersion': 1, 'frame': 'component',
                'screw': {'length': '12 mm', 'threadLength': '10 mm'}, 'stack': [{'id': 'bracket', 'thickness': '5 mm'}],
                'minimumEngagement': '4 mm', 'receptacle': {'kind': 'tapped', 'depth': '8 mm'}}}

    body_count = FMCAD.root.bRepBodies.count
    timeline_count = FMCAD.design.timeline.count
    status_before = _fastener_call('document.status', {})
    baseline = _fastener_call('fastener.measured-check', request(tip, screw_end, hole_axis, bottom, hole_end))
    bottoming = _fastener_call('fastener.measured-check', request(bottoming_tip, screw_end, hole_axis, bottoming_bottom, hole_end))
    short = _fastener_call('fastener.measured-check', request(short_tip, short_end, hole_axis, bottom, hole_end))
    misaligned = _fastener_call('fastener.measured-check', request(tip, screw_end, offset_axis, bottom, hole_end))
    missing = _fastener_call('fastener.measured-check', request(tip, screw_end, hole_axis, bottom, None))
    native = _fastener_object(baseline.get('nativeMeasurements'))
    engagement = _fastener_object(_fastener_object(native.get('measurements')).get('actualEngagement'))
    provenance_complete = _fastener_provenance(engagement, native.get('frame'), doc.creationId)
    declared = _fastener_object(baseline.get('declaredEvidence'))
    coverage = _fastener_object(native.get('coverage'))
    after = _fastener_call('document.status', {})
    unchanged = body_count == FMCAD.root.bRepBodies.count and timeline_count == FMCAD.design.timeline.count and status_before == after
    statuses = {
        'declared-stack-is-separate': declared.get('status') == 'reported' and _fastener_object(declared.get('result')).get('status') == 'pass' and engagement.get('value') == 5,
        'baseline-native-engagement': baseline.get('status') == 'pass',
        'measurement-source-frame-and-coverage': provenance_complete and _fastener_object(native.get('frame')).get('space') == 'assembly' and
            coverage.get('status') == 'complete' and coverage.get('frameStatus') == 'measured',
        'bottoming-negative-even-with-legacy-pass': bottoming.get('status') == 'fail' and _fastener_object(declared.get('result')).get('status') == 'pass',
        'short-bolt-minimum-engagement-negative': short.get('status') == 'fail',
        'misaligned-native-axes-negative': misaligned.get('status') == 'fail',
        'missing-native-measurement-remains-unknown': missing.get('status') == 'unknown',
        'model-and-save-state-unchanged': unchanged}
    results: dict[str, _FastenerFixtureJSON] = {'declared-stack-is-separate': declared, 'baseline-native-engagement': baseline,
        'measurement-source-frame-and-coverage': baseline, 'bottoming-negative-even-with-legacy-pass': bottoming,
        'short-bolt-minimum-engagement-negative': short, 'misaligned-native-axes-negative': misaligned,
        'missing-native-measurement-remains-unknown': missing, 'model-and-save-state-unchanged': after}
    report: dict[str, _FastenerFixtureJSON] = {'featureId': 'measured-fasteners', 'fusionBuild': build,
        'nativeCasesStatus': 'pass' if all(statuses.values()) else 'fail',
        'document': {'name': doc.name, 'creationId': doc.creationId, 'savedBefore': before['saved'], 'modifiedBefore': before['modified']},
        'cases': {name: {'status': 'pass' if value else 'fail', 'result': results[name]} for name, value in statuses.items()},
        'modelUnchangedDuringEvidence': unchanged, 'bodyCountBefore': body_count, 'bodyCountAfter': FMCAD.root.bRepBodies.count,
        'timelineCountBefore': timeline_count, 'timelineCountAfter': FMCAD.design.timeline.count,
        'statusBefore': status_before, 'statusAfter': after, 'nativeQualified': False,
        'scratchCleanup': 'separate owner cleanup and exact restore required',
        'limitations': ['Measured axial datum geometry is separate from declared catalog lengths and thread evidence.',
            'No thread BRep, force/load or physical fastener/manufacturing qualification is claimed.',
            'No document lifecycle, save, file or cloud effects.']}
    FMCAD.emit(report)
    return report
