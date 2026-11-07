"""Fixed caller-owned sketch proof, based on the retained typed sketch plan."""
from typing import TypeAlias as _SketchProofTypeAlias

_SketchProofJSON: _SketchProofTypeAlias = None | bool | int | float | str | list['_SketchProofJSON'] | dict[str, '_SketchProofJSON']

ARGS = {}
DOC_NAME = None


def _proof_object(value: _SketchProofJSON) -> dict[str, _SketchProofJSON]:
    if not isinstance(value, dict):
        raise RuntimeError('Sketch fixture requires a complete JSON object')
    return value


def _proof_call(operation: str, data: dict[str, _SketchProofJSON]) -> dict[str, _SketchProofJSON]:
    return _proof_object(FMCAD.call(operation, data))


def run(_context: str) -> dict[str, _SketchProofJSON]:
    import math
    import adsk.core
    doc = FMCAD.doc
    build = adsk.core.Application.get().version
    if ARGS.get('approved') is not True or ARGS.get('creationId') != doc.creationId or ARGS.get('expectedFusionVersion') != build:
        raise RuntimeError('Exact approved fresh sketch document and Fusion build required')
    prefix = ARGS.get('fixturePrefix')
    if not isinstance(prefix, str) or not prefix or not prefix.isalnum() or prefix.upper() != prefix:
        raise ValueError('Uppercase alphanumeric fixture prefix required')
    before = _proof_call('document.status', {})
    if before.get('creationId') != doc.creationId or before.get('saved') is not False or before.get('modified') is not False:
        raise RuntimeError('Sketch proof requires a fresh unmodified unsaved scratch')
    if FMCAD.root.bRepBodies.count or FMCAD.root.sketches.count or FMCAD.root.allOccurrences.count or FMCAD.design.timeline.count:
        raise RuntimeError('Sketch proof cannot adopt existing geometry')
    names = {label: prefix + '_' + label for label in ['single', 'ambiguous', 'annulus', 'microgap', 'duplicate']}
    for name in names.values():
        _proof_call('sketch.create', {'name': name, 'plane': 'XY'})

    def circle(name: str, center: list[_SketchProofJSON], radius: str) -> dict[str, _SketchProofJSON]:
        return {'type': 'circle', 'name': name, 'center': center, 'radius': radius}

    def geometry(label: str, values: list[_SketchProofJSON]) -> dict[str, _SketchProofJSON]:
        return _proof_call('sketch.geometry', {'sketch': names[label], 'inferencePolicy': 'explicit', 'geometry': values})

    single = geometry('single', [circle('qualifiedCircle', ['10 mm', '20 mm', '0 mm'], '10 mm')])
    geometry('ambiguous', [circle('left', ['0 mm', '0 mm', '0 mm'], '5 mm'), circle('right', ['20 mm', '0 mm', '0 mm'], '5 mm')])
    geometry('annulus', [circle('outer', ['0 mm', '0 mm', '0 mm'], '10 mm'), circle('inner', ['0 mm', '0 mm', '0 mm'], '5 mm')])
    geometry('microgap', [
        {'type': 'line', 'name': 'bottom', 'start': ['0 mm', '0 mm', '0 mm'], 'end': ['10 mm', '0 mm', '0 mm']},
        {'type': 'line', 'name': 'right', 'start': ['10 mm', '0 mm', '0 mm'], 'end': ['10 mm', '10 mm', '0 mm']},
        {'type': 'line', 'name': 'top', 'start': ['10 mm', '10 mm', '0 mm'], 'end': ['0 mm', '10 mm', '0 mm']},
        {'type': 'line', 'name': 'left-short', 'start': ['0 mm', '10 mm', '0 mm'], 'end': ['0.05 mm', '0 mm', '0 mm']}])
    geometry('duplicate', [circle('firstStroke', ['0 mm', '0 mm', '0 mm'], '5 mm'), circle('duplicateStroke', ['0 mm', '0 mm', '0 mm'], '5 mm')])
    refs = _proof_object(single.get('refs'))
    entity = _proof_object(refs.get('qualifiedCircle'))
    counts_before: dict[str, _SketchProofJSON] = {'sketches': FMCAD.root.sketches.count, 'bodies': FMCAD.root.bRepBodies.count, 'timeline': FMCAD.design.timeline.count}
    status_before = _proof_call('document.status', {})
    cases: dict[str, _SketchProofJSON] = {}
    failures: list[_SketchProofJSON] = []
    unknowns: list[_SketchProofJSON] = []

    def verify(condition: bool, message: str, unknown: bool = False) -> None:
        if not condition:
            (unknowns if unknown else failures).append(message)

    def coordinates(center: list[_SketchProofJSON], diameter: str) -> dict[str, _SketchProofJSON]:
        return _proof_call('sketch.coordinate-check', {'schemaVersion': 1, 'sketch': names['single'], 'expectations': [
            {'entity': entity, 'center': center, 'diameter': diameter}]})

    for name, center, diameter, expected in [
        ('coordinate-positive', ['10 mm', '20 mm', '0 mm'], '20 mm', 'pass'),
        ('shifted-center-negative', ['11 mm', '20 mm', '0 mm'], '20 mm', 'fail'),
        ('bad-diameter-negative', ['10 mm', '20 mm', '0 mm'], '18 mm', 'fail')]:
        # Explicitly typed copy preserves the public JSON contract for dimensions.
        point: list[_SketchProofJSON] = [value for value in center]
        result = coordinates(point, diameter)
        cases[name] = result
        verify(result.get('healthStatus') == 'pass', name + ': sketch health is not known healthy')
        verify(result.get('geometryStatus') == expected, name + ': geometry verdict differs', result.get('geometryStatus') == 'unknown')

    def query(label: str, criteria: dict[str, _SketchProofJSON], expected: dict[str, _SketchProofJSON]) -> dict[str, _SketchProofJSON]:
        return _proof_call('sketch.profile-query', {'schemaVersion': 1, 'sketch': names[label], 'query': criteria, 'expected': expected})

    microgap = query('microgap', {'index': 0}, {'profiles': 0})
    duplicate = query('duplicate', {'index': 0}, {})
    for name, value in [('microgap-negative', microgap), ('duplicate-edge-negative', duplicate)]:
        cases[name] = value
        verify(value.get('profile') is None and value.get('geometryStatus') == 'fail', name + ': bad topology selected a profile', value.get('geometryStatus') == 'unknown')
    one: dict[str, _SketchProofJSON] = {'profiles': 1, 'loops': 1, 'outerLoops': 1, 'innerLoops': 0}
    two: dict[str, _SketchProofJSON] = {'profiles': 2, 'loops': 2, 'outerLoops': 2, 'innerLoops': 0}
    annulus: dict[str, _SketchProofJSON] = {'profiles': 2, 'loops': 3, 'outerLoops': 2, 'innerLoops': 1}
    material = query('annulus', {'area': math.pi * 0.75, 'contains': ['7.5 mm', '0 mm', '0 mm'], 'outerLoops': 1, 'innerLoops': 1}, annulus)
    void = query('annulus', {'area': math.pi * 0.75, 'contains': ['2 mm', '0 mm', '0 mm'], 'outerLoops': 1, 'innerLoops': 1}, annulus)
    unique = query('single', {'area': math.pi, 'centroid': ['10 mm', '20 mm', '0 mm'], 'outerLoops': 1, 'innerLoops': 0}, one)
    ambiguous = query('ambiguous', {'area': math.pi * 0.25, 'outerLoops': 1, 'innerLoops': 0}, two)
    selected = query('ambiguous', {'area': math.pi * 0.25, 'centroid': ['0 mm', '0 mm', '0 mm'], 'outerLoops': 1, 'innerLoops': 0}, two)
    missing = query('microgap', {'index': 0}, {'profiles': 1})
    for name, value in [('hole-inside-material-positive', material), ('unambiguous-profile-selection-positive', unique),
                        ('multiple-profiles-explicitly-selected-positive', selected)]:
        cases[name] = value
        verify(value.get('geometryStatus') == 'pass' and isinstance(value.get('profile'), dict), name + ': no unique native profile proof', value.get('geometryStatus') == 'unknown')
        verify(value.get('precision') == 'sampled' and value.get('evidenceStatus') == 'partial', name + ': sampled evidence became exact')
    cases['hole-inside-void-negative'] = void
    cases['multiple-profiles-ambiguous-negative'] = ambiguous
    cases['missing-or-incomplete-topology-no-first-profile-fallback'] = missing
    verify(void.get('profile') is None and _proof_object(void.get('selection')).get('reason') == 'noMatch', 'Hole void incorrectly selected material')
    verify(ambiguous.get('profile') is None and _proof_object(ambiguous.get('selection')).get('reason') == 'ambiguous', 'Ambiguous profiles used first-profile fallback')
    verify(missing.get('profile') is None and missing.get('geometryStatus') in ['fail', 'unknown'], 'Missing topology used first-profile fallback')
    status_after = _proof_call('document.status', {})
    counts_after: dict[str, _SketchProofJSON] = {'sketches': FMCAD.root.sketches.count, 'bodies': FMCAD.root.bRepBodies.count, 'timeline': FMCAD.design.timeline.count}
    unchanged = counts_before == counts_after and status_before == status_after
    cases['read-only-proof-preserves-scratch-state'] = {'status': 'pass' if unchanged else 'fail',
        'countsBefore': counts_before, 'countsAfter': counts_after, 'statusBefore': status_before, 'statusAfter': status_after}
    verify(unchanged, 'Sketch proof measurements changed the document')
    report: dict[str, _SketchProofJSON] = {'featureId': 'sketch-geometry-proof', 'fusionBuild': build,
        'document': {'name': doc.name, 'creationId': doc.creationId, 'savedBefore': before['saved'], 'modifiedBefore': before['modified']},
        'nativeCasesStatus': 'fail' if failures else 'unknown' if unknowns else 'pass', 'cases': cases,
        'assertionFailures': failures, 'unresolvedAssertions': unknowns, 'modelUnchangedDuringEvidence': unchanged,
        'nativeQualified': False, 'scratchCleanup': 'separate owner cleanup and exact restore required',
        'limitations': ['Native coordinate/analytic evidence is distinct from sampled profile topology and containment.',
            'Sampled profile selection remains partial; no manufacturing or continuous finite-solid claim.',
            'No document lifecycle, save, file or cloud effects.']}
    FMCAD.emit(report)
    return report
