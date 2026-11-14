"""GM31: manufacturing rules, draft/undercut and wall-thickness maps.

Draft, undercut and wall-thickness evaluation runs on *declared* face/wall
samples (point + unit normal) rather than pretending to ray-cast a native
B-Rep. The signed draft of a face under a pull direction is ``90 deg - angle
(normal, pull)``: positive leans toward the pull, negative leans away. A face
whose normal is nearly perpendicular to the pull is a "pull wall" and must
meet ``minDraft``; a positive draft alone never proves demoldability. Wall-map
distinguishes a solid opposite wall from an opposite point *behind a void*
(``continuity: void``), so a hidden void is not reported as material thickness.
``undercut.check`` and ``manufacturing.check`` reuse ``measure.draft`` and
``measure.wall-map`` through ``ctx.call``. This is a geometric/recipe
evaluation; no mold-flow or CAE result is claimed.
"""
import math

import adsk.core
import adsk.fusion


# --- vector helpers (cm internal) -------------------------------------------------

def _point3(ctx, spec):
    p = ctx.point(spec)
    if isinstance(p, (list, tuple)):
        return [float(v) for v in p]
    return [float(p.x), float(p.y), float(p.z)]


def _vsub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def _vdot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _vnorm(a):
    return math.sqrt(_vdot(a, a))


def _deg(rad):
    return rad * 180.0 / math.pi


_ZONE_KINDS = {'a-surface', 'fit', 'seal', 'optical', 'parting', 'gate', 'ejector', 'weld', 'custom'}
_PROTECTED_DEFAULT = {'a-surface', 'seal', 'optical'}


# --- envelope --------------------------------------------------------------------

def _dfm_contract(ctx, operation, result, status='pass'):
    identity = None
    if hasattr(ctx, 'doc') and getattr(getattr(ctx, 'doc', None), 'name', None) is not None:
        identity = {'name': ctx.doc.name}
    component = None
    if hasattr(ctx, 'component') and hasattr(ctx, 'ref'):
        try:
            component = ctx.ref(ctx.component)
        except Exception:
            component = None
    merged = dict(schemaVersion=1, operation=operation, documentIdentity=identity,
                  units={'length': 'cm', 'angle': 'deg'},
                  frame={'space': 'component', 'component': component}, associativity='snapshot',
                  warnings=[], method='GM31 local analytic manufacturing evaluation',
                  limitations=['Draft/undercut/wall-thickness are computed from declared face and wall samples; native B-Rep ray sampling is a separate gated path.',
                               'A positive draft alone never proves demoldability; parting lines, slides and mold flow are not solved.',
                               'Wall thickness behind a void is reported as void-backed, not as material thickness.',
                               'No mold-flow, thermal or CAE result is claimed.',
                               'Declared face refs are snapshots; native refs must be revalidated after any topology change.'],
                  provenance={'requirement': 'GM31', 'source': 'docs/DFM.md'}, affected=[])
    merged.update(result)
    merged.setdefault('status', status)
    merged['success'] = merged['status'] == 'pass'
    return merged


def _dfm_blocked_method(ctx, operation, method):
    """Gated native sampling request -> honest blocked envelope, never faked."""
    return _dfm_contract(ctx, operation, {
        'requestedMethod': method, 'blocked': True,
        'nativeSampling': {'available': False,
                           'reason': 'Native B-Rep face/wall sampling is a gated availability; it is not faked. Use the analytic declared-sample method.'}},
        status='blocked')


# --- declared-sample parsers -----------------------------------------------------

def _parse_face(ctx, spec, index):
    if not isinstance(spec, dict) or 'point' not in spec or 'normal' not in spec:
        raise ValueError('face %d requires point and normal' % index)
    return {'name': spec.get('name'), 'point': _point3(ctx, spec['point']),
            'normal': _cad_direction(spec['normal'])}


def _parse_pull(ctx, spec, index):
    if isinstance(spec, (list, tuple)):
        return {'name': 'pull-%d' % index, 'axis': _cad_direction(spec)}
    if not isinstance(spec, dict) or 'axis' not in spec:
        raise ValueError('pullDirection %d requires an axis' % index)
    return {'name': spec.get('name', 'pull-%d' % index), 'axis': _cad_direction(spec['axis'])}


# --- measure.draft ---------------------------------------------------------------

def _measure_draft(ctx, data):
    _cad_fields(data, ('faces', 'pullDirections'),
                ('minDraft', 'pullWallWindow', 'draftTolerance', 'method', 'frame', 'schemaVersion'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('measure.draft requires schemaVersion 1')
    faces = data['faces']
    pulls = data['pullDirections']
    if not isinstance(faces, list) or not faces:
        raise ValueError('faces must be a nonempty array')
    if not isinstance(pulls, list) or not pulls:
        raise ValueError('pullDirections must be a nonempty array')
    method = data.get('method', 'analytic')
    if method == 'native':
        return _dfm_blocked_method(ctx, 'measure.draft', 'native')
    if method != 'analytic':
        raise ValueError('method must be analytic or native')
    min_draft = ctx.angle(data.get('minDraft', '0 deg'))
    window = ctx.angle(data.get('pullWallWindow', '30 deg'))
    tolerance = ctx.angle(data.get('draftTolerance', '0.1 deg'))
    if min_draft < 0 or window < 0 or tolerance < 0:
        raise ValueError('draft angles must be nonnegative')
    parsed_faces = [_parse_face(ctx, spec, i) for i, spec in enumerate(faces)]
    parsed_pulls = [_parse_pull(ctx, spec, i) for i, spec in enumerate(pulls)]
    rows = []
    for pull in parsed_pulls:
        for face in parsed_faces:
            dot = max(-1.0, min(1.0, _vdot(face['normal'], pull['axis'])))
            signed = 90.0 - _deg(math.acos(dot))
            pull_wall = abs(signed) <= _deg(window)
            violation = pull_wall and abs(signed) < _deg(min_draft)
            rows.append({'face': face['name'], 'pull': pull['name'], 'signedDraft': signed,
                         'signedDraftUnits': 'deg', 'normalDotPull': dot, 'pullWall': pull_wall,
                         'drafts': not violation, 'draftViolation': violation})
    violations = [r for r in rows if r['draftViolation']]
    return _dfm_contract(ctx, 'measure.draft', {
        'draftMap': rows, 'minDraft': {'value': _deg(min_draft), 'units': 'deg'},
        'pullWallWindow': {'value': _deg(window), 'units': 'deg'},
        'draftTolerance': {'value': _deg(tolerance), 'units': 'deg'},
        'faceCount': len(parsed_faces), 'pullCount': len(parsed_pulls),
        'violationCount': len(violations), 'draftViolations': violations,
        'demoldableByDraft': not violations, 'demoldableIsNotDraftAlone': True})


# --- undercut.check --------------------------------------------------------------

def _undercut_check(ctx, data):
    _cad_fields(data, ('faces', 'pullDirections'), ('undercutThreshold', 'frame', 'schemaVersion'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('undercut.check requires schemaVersion 1')
    faces = data['faces']
    pulls = data['pullDirections']
    if not isinstance(faces, list) or not faces:
        raise ValueError('faces must be a nonempty array')
    if not isinstance(pulls, list) or not pulls:
        raise ValueError('pullDirections must be a nonempty array')
    threshold = ctx.angle(data.get('undercutThreshold', '3 deg'))
    if threshold < 0:
        raise ValueError('undercutThreshold must be nonnegative')
    draft = ctx.call('measure.draft', {'schemaVersion': 1, 'faces': faces, 'pullDirections': pulls})
    rows = []
    for row in draft['draftMap']:
        undercut = row['signedDraft'] < -_deg(threshold)
        rows.append({'face': row['face'], 'pull': row['pull'], 'signedDraft': row['signedDraft'],
                     'signedDraftUnits': 'deg', 'undercut': undercut})
    undercuts = [r for r in rows if r['undercut']]
    passed = not undercuts
    return _dfm_contract(ctx, 'undercut.check', {
        'passed': passed, 'undercuts': undercuts, 'undercutCount': len(undercuts),
        'undercutThreshold': {'value': _deg(threshold), 'units': 'deg'},
        'demoldable': passed, 'demoldableIsNotDraftAlone': True,
        'method': 'directional undercut: signed draft more negative than the threshold'},
        status='pass' if passed else 'fail')


# --- measure.wall-map ------------------------------------------------------------

def _measure_wall_map(ctx, data):
    _cad_fields(data, ('samples',), ('minThickness', 'maxThickness', 'method', 'frame', 'schemaVersion'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('measure.wall-map requires schemaVersion 1')
    samples = data['samples']
    if not isinstance(samples, list) or not samples:
        raise ValueError('samples must be a nonempty array')
    method = data.get('method', 'declared')
    if method == 'native':
        return _dfm_blocked_method(ctx, 'measure.wall-map', 'native')
    if method != 'declared':
        raise ValueError('method must be declared or native')
    min_t = ctx.length(data.get('minThickness', '0 mm'))
    max_t = None if data.get('maxThickness') is None else ctx.length(data['maxThickness'])
    if min_t < 0 or (max_t is not None and max_t < min_t):
        raise ValueError('thickness limits are invalid')
    rows = []
    for index, spec in enumerate(samples):
        if not isinstance(spec, dict) or 'point' not in spec:
            raise ValueError('wall sample %d requires a point' % index)
        continuity = spec.get('continuity', 'solid')
        if continuity not in ('solid', 'void'):
            raise ValueError('wall sample %d continuity must be solid or void' % index)
        point = _point3(ctx, spec['point'])
        opposite = None
        if 'opposite' in spec:
            opposite = _point3(ctx, spec['opposite'])
            thickness = _vnorm(_vsub(opposite, point))
        elif 'thickness' in spec:
            thickness = ctx.length(spec['thickness'])
        else:
            raise ValueError('wall sample %d requires opposite or thickness' % index)
        if thickness < 0:
            raise ValueError('wall sample %d thickness must be nonnegative' % index)
        void_backed = continuity == 'void'
        thin = (not void_backed) and min_t > 0 and thickness < min_t
        thick = (not void_backed) and max_t is not None and thickness > max_t
        rows.append({'name': spec.get('name'), 'point': point, 'opposite': opposite,
                     'thickness': thickness, 'continuity': continuity, 'voidBacked': void_backed,
                     'thinWall': thin, 'thickWall': thick})
    thin = [r for r in rows if r['thinWall']]
    thick = [r for r in rows if r['thickWall']]
    voided = [r for r in rows if r['voidBacked']]
    solid = [r['thickness'] for r in rows if not r['voidBacked']]
    uniform = len(solid) > 0 and (max(solid) - min(solid)) < 1e-9
    violations = [dict(r, kind='thin') for r in thin] + [dict(r, kind='thick') for r in thick]
    return _dfm_contract(ctx, 'measure.wall-map', {
        'wallMap': rows, 'minThickness': min_t, 'maxThickness': max_t,
        'thinWallViolations': thin, 'thickWallViolations': thick, 'violations': violations,
        'voidBackedSamples': voided, 'materialContinuityChecked': True,
        'uniform': uniform, 'unhandledAreas': [r['name'] for r in voided if r.get('name')],
        'accuracy': {'method': method, 'samples': len(rows)}})


# --- zones -----------------------------------------------------------------------

def _zone_row(ctx, spec, index):
    if not isinstance(spec, dict):
        raise ValueError('zone %d must be an object' % index)
    name = spec.get('name')
    if not isinstance(name, str) or not name:
        raise ValueError('zone %d requires a name' % index)
    kind = spec.get('kind')
    if kind not in _ZONE_KINDS:
        raise ValueError('zone %r: unsupported kind %r' % (name, kind))
    protected = spec.get('protected', kind in _PROTECTED_DEFAULT)
    if type(protected) is not bool:
        raise ValueError('zone %r: protected must be boolean' % name)
    pulls = spec.get('pullDirections', [])
    if not isinstance(pulls, list):
        raise ValueError('zone %r: pullDirections must be an array' % name)
    axes = [_cad_direction(p if isinstance(p, (list, tuple)) else p['axis']) for p in pulls]
    return {'name': name, 'kind': kind, 'protected': protected, 'pullDirections': axes}


def _manufacturing_zone(ctx, data):
    _cad_fields(data, ('zones',), ('process', 'material', 'sampling', 'frame', 'schemaVersion'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('manufacturing.zone requires schemaVersion 1')
    zones = data['zones']
    if not isinstance(zones, list) or not zones:
        raise ValueError('zones must be a nonempty array')
    rows = [_zone_row(ctx, spec, i) for i, spec in enumerate(zones)]
    warnings = []
    if not data.get('material'):
        warnings.append('material is not declared; draft/thickness rules cannot be tied to a specific material or process')
    sampling = data.get('sampling', {})
    if not isinstance(sampling, dict):
        raise ValueError('sampling must be an object')
    method = sampling.get('method', 'declared')
    if method not in ('declared', 'uniform', 'adaptive'):
        raise ValueError('sampling.method must be declared, uniform or adaptive')
    tolerance = ctx.length(sampling['tolerance']) if 'tolerance' in sampling else None
    return _dfm_contract(ctx, 'manufacturing.zone', {
        'zones': rows, 'process': data.get('process'), 'material': data.get('material'),
        'sampling': {'method': method, 'tolerance': tolerance},
        'warnings': warnings,
        'accuracy': {'method': method, 'note': 'uniform/adaptive native sampling is gated; only declared samples are evaluated'}})


# --- manufacturing.check ---------------------------------------------------------

def _manufacturing_check(ctx, data):
    _cad_fields(data, ('zones', 'faces', 'walls', 'pullDirections'),
                ('operations', 'minDraft', 'minThickness', 'maxThickness', 'undercutThreshold',
                 'process', 'material', 'sampling', 'frame', 'schemaVersion'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('manufacturing.check requires schemaVersion 1')
    zones = data['zones']
    if not isinstance(zones, list) or not zones:
        raise ValueError('zones must be a nonempty array')
    zone_rows = [_zone_row(ctx, spec, i) for i, spec in enumerate(zones)]
    draft_data = {'schemaVersion': 1, 'faces': data['faces'], 'pullDirections': data['pullDirections']}
    if 'minDraft' in data:
        draft_data['minDraft'] = data['minDraft']
    wall_data = {'schemaVersion': 1, 'samples': data['walls']}
    if 'minThickness' in data:
        wall_data['minThickness'] = data['minThickness']
    if 'maxThickness' in data:
        wall_data['maxThickness'] = data['maxThickness']
    undercut_data = {'schemaVersion': 1, 'faces': data['faces'], 'pullDirections': data['pullDirections']}
    if 'undercutThreshold' in data:
        undercut_data['undercutThreshold'] = data['undercutThreshold']
    draft = ctx.call('measure.draft', draft_data)
    wall = ctx.call('measure.wall-map', wall_data)
    undercut = ctx.call('undercut.check', undercut_data)
    protected = {z['name'] for z in zone_rows if z['protected']}
    op_violations = []
    for spec in data.get('operations', []):
        if not isinstance(spec, dict):
            raise ValueError('operations must be objects')
        for touched in spec.get('touches', []):
            if touched in protected:
                op_violations.append({'operation': spec.get('name'), 'zone': touched,
                                      'message': 'global operation touches protected zone %r' % touched})
    violations = []
    violations.extend(dict(v, source='draft') for v in draft['draftViolations'])
    violations.extend(dict(v, source='wall-thickness') for v in wall['violations'])
    violations.extend(dict(v, source='undercut') for v in undercut['undercuts'])
    violations.extend(dict(v, source='protected-zone') for v in op_violations)
    unhandled = []
    unhandled.extend({'area': name, 'reason': 'void-backed wall sample'} for name in wall['unhandledAreas'])
    passed = not violations
    return _dfm_contract(ctx, 'manufacturing.check', {
        'passed': passed, 'violations': violations, 'violationCount': len(violations),
        'zones': zone_rows, 'draft': draft, 'wallMap': wall, 'undercut': undercut,
        'protectedZones': sorted(protected), 'unhandledAreas': unhandled,
        'process': data.get('process'), 'material': data.get('material'),
        'accuracy': {'method': data.get('sampling', {}).get('method', 'declared'),
                     'note': 'declared-sample evaluation; native sampling is gated'}},
        status='pass' if passed else 'fail')


CAD_HANDLERS.update({
    'measure.draft': _measure_draft,
    'measure.wall-map': _measure_wall_map,
    'undercut.check': _undercut_check,
    'manufacturing.zone': _manufacturing_zone,
    'manufacturing.check': _manufacturing_check,
})
