"""GM34 markings and labels: create/check with text, symbol and arrow.

Markings are evaluated as recipes or annotations, never translated and never
implicitly substituted with an image. A text/symbol mark preserves its user
content verbatim; an arrow mark carries an explicit flow direction.
``marking.create`` returns either an annotation descriptor or a gated
emboss/engrave geometry recipe, with source association, occupancy bounds and
feasibility/position warnings. ``marking.check`` verifies that MIN/MAX markings
are derived from a computed liquid level, that arrow directions come from a
defined flow, that no mark lands in an optical/seal protected zone, and that no
geometry request is silently replaced by an image. Native emboss/engrave
authoring is a separate gated path (``nativeAcceptance: notEvaluated``), never
faked as an image.
"""
import math


_MARK_KINDS = ('text', 'symbol', 'arrow')
_REPRESENTATIONS = ('annotation', 'emboss', 'engrave')
_PROTECTED_ZONES = ('optical', 'seal', 'a-surface')
_ZONE_KINDS = ('optical', 'seal', 'a-surface', 'fit', 'custom')
_SOURCE_STATUSES = ('CONFIRMED', 'ESTIMATED', 'OPEN')


def _point3(ctx, spec):
    point = ctx.point(spec)
    if isinstance(point, (list, tuple)):
        return [float(v) for v in point]
    return [float(point.x), float(point.y), float(point.z)]


def _vsub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def _vdot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _vnorm(a):
    return math.sqrt(_vdot(a, a))


def _deg(rad):
    return rad * 180.0 / math.pi


def _box_overlap(a, b):
    return all(a['min'][i] <= b['max'][i] and b['min'][i] <= a['max'][i] for i in range(3))


_MARKING_LIMITATIONS = [
    'User text/symbol content is preserved verbatim; no translation is applied.',
    'Native emboss/engrave geometry authoring is gated and reported as notEvaluated, never silently replaced by an image.',
    'Occupancy is an axis-aligned box from declared dimensions; text advance width and real glyph extents are not measured.',
    'MIN/MAX derivation and arrow/flow matching are verified against declared levels and flows, not a solver result.']


def _marking_contract(ctx, operation, result, status='pass', limitations=()):
    identity = None
    if hasattr(ctx, 'doc') and getattr(getattr(ctx, 'doc', None), 'name', None) is not None:
        identity = {'name': ctx.doc.name}
    merged = dict(schemaVersion=1, operation=operation, documentIdentity=identity,
                  units={'length': 'cm', 'angle': 'deg'},
                  frame={'space': 'component'}, associativity='snapshot',
                  warnings=[], method='GM34 marking evaluation',
                  limitations=list(_MARKING_LIMITATIONS) + list(limitations),
                  provenance={'requirement': 'GM34', 'source': 'docs/MARKING.md'}, affected=[])
    merged.update(result)
    merged['status'] = status
    if status == 'pass':
        merged['passed'] = True
    elif status in ('fail', 'blocked'):
        merged['passed'] = False
    merged['success'] = status in ('pass', 'unknown')
    return merged


def _parse_mark(ctx, spec, index):
    if not isinstance(spec, dict):
        raise ValueError('mark %d must be an object' % index)
    name = spec.get('id')
    if not isinstance(name, str) or not name:
        raise ValueError('mark %d requires an id' % index)
    kind = spec.get('kind')
    if kind not in _MARK_KINDS:
        raise ValueError('mark %r: unsupported kind %r' % (name, kind))
    representation = spec.get('representation')
    if representation not in _REPRESENTATIONS:
        raise ValueError('mark %r: unsupported representation %r' % (name, representation))
    content = spec.get('content')
    if kind in ('text', 'symbol'):
        if not isinstance(content, str) or not content.strip():
            raise ValueError('mark %r: text/symbol requires nonempty content' % name)
    elif 'content' in spec:
        raise ValueError('mark %r: arrow does not take content' % name)
    if 'position' not in spec:
        raise ValueError('mark %r requires a position' % name)
    position = _point3(ctx, spec['position'])
    dimensions = spec.get('dimensions')
    if not isinstance(dimensions, dict) or 'height' not in dimensions:
        raise ValueError('mark %r requires dimensions.height' % name)
    height = ctx.length(dimensions['height'])
    width = ctx.length(dimensions['width']) if 'width' in dimensions else height
    stroke = ctx.length(dimensions['stroke']) if 'stroke' in dimensions else 0.0
    depth = ctx.length(spec['depth']) if 'depth' in spec else None
    if height <= 0 or width < 0 or stroke < 0 or (depth is not None and depth < 0):
        raise ValueError('mark %r: height must be positive and width/stroke/depth nonnegative' % name)
    direction = None
    if kind == 'arrow':
        if 'direction' not in spec:
            raise ValueError('mark %r: arrow requires a flow direction' % name)
        direction = _cad_direction(spec['direction'])
    elif 'direction' in spec:
        direction = _cad_direction(spec['direction'])
    source = spec.get('source')
    if source is not None:
        if not isinstance(source, dict):
            raise ValueError('mark %r: source must be an object' % name)
        if source.get('status') not in (None,) + _SOURCE_STATUSES:
            raise ValueError('mark %r: unsupported source status %r' % (name, source.get('status')))
    reference = spec.get('reference')
    if reference is not None:
        if not isinstance(reference, dict) or reference.get('kind') != 'liquid-level' \
                or reference.get('bound') not in ('min', 'max'):
            raise ValueError("mark %r: reference must be {kind: 'liquid-level', bound: 'min'|'max'}" % name)
    resolved = spec.get('resolvedRepresentation')
    if resolved is not None and resolved not in ('annotation', 'emboss', 'engrave', 'image'):
        raise ValueError('mark %r: unsupported resolvedRepresentation %r' % (name, resolved))
    return {'id': name, 'kind': kind, 'representation': representation, 'content': content,
            'position': position, 'height': height, 'width': width, 'stroke': stroke, 'depth': depth,
            'direction': direction, 'font': spec.get('font'), 'source': source,
            'reference': reference, 'levelValue': spec.get('levelValue'),
            'resolvedRepresentation': resolved}


def _occupancy(mark):
    half_width = mark['width'] / 2.0
    half_height = mark['height'] / 2.0
    half_depth = ((mark['depth'] if mark['depth'] is not None else mark['stroke']) or 0.0) / 2.0
    pos = mark['position']
    return {'min': [pos[0] - half_width, pos[1] - half_height, pos[2] - half_depth],
            'max': [pos[0] + half_width, pos[1] + half_height, pos[2] + half_depth],
            'size': [mark['width'], mark['height'],
                     (mark['depth'] if mark['depth'] is not None else mark['stroke']) or 0.0],
            'units': 'cm'}


def _parse_region(ctx, spec, index, what):
    if not isinstance(spec, dict) or 'region' not in spec:
        raise ValueError('%s %d requires a region' % (what, index))
    region = spec['region']
    if not isinstance(region, dict) or 'min' not in region or 'max' not in region:
        raise ValueError('%s %d region requires min and max' % (what, index))
    low = _point3(ctx, region['min'])
    high = _point3(ctx, region['max'])
    if any(low[i] > high[i] for i in range(3)):
        raise ValueError('%s %d region has min > max' % (what, index))
    return {'name': spec.get('name'), 'kind': spec.get('kind'),
            'region': {'min': low, 'max': high}}


def _marking_create(ctx, data):
    _cad_fields(data, ('marks',), ('schemaVersion', 'zones', 'keepouts', 'frame'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('marking.create requires schemaVersion 1')
    marks = data['marks']
    if not isinstance(marks, list) or not marks:
        raise ValueError('marks must be a nonempty array')
    zones = [_parse_region(ctx, spec, i, 'zone') for i, spec in enumerate(data.get('zones', []))]
    keepouts = [_parse_region(ctx, spec, i, 'keepout') for i, spec in enumerate(data.get('keepouts', []))]
    protected = [z for z in zones if z.get('kind') in _PROTECTED_ZONES]
    rows = []
    violations = []
    for index, spec in enumerate(marks):
        mark = _parse_mark(ctx, spec, index)
        occupancy = _occupancy(mark)
        warnings = []
        zone_violations = [z['name'] for z in protected if _box_overlap(occupancy, z['region'])]
        keepout_violations = [k['name'] for k in keepouts if _box_overlap(occupancy, k['region'])]
        if mark['representation'] in ('emboss', 'engrave') and mark['depth'] is None:
            warnings.append('emboss/engrave depth is not declared; geometry recipe cannot be authored')
        if mark['kind'] in ('text', 'symbol') and not mark['font']:
            warnings.append('font/resource is not declared')
        if mark['source'] is None:
            warnings.append('no source association; the marking cannot be traced to a requirement')
        if mark['representation'] in ('emboss', 'engrave'):
            native_acceptance = 'notEvaluated'
            geometry_recipe = {'steps': ['sketch.text', 'model.extrude'], 'representation': mark['representation'],
                               'nativeAcceptance': 'notEvaluated'}
            annotation = None
        else:
            native_acceptance = 'annotation'
            geometry_recipe = None
            annotation = {'content': mark['content'], 'position': mark['position'], 'frame': data.get('frame')}
        feasible = not zone_violations and not keepout_violations
        row = {'id': mark['id'], 'kind': mark['kind'], 'representation': mark['representation'],
               'content': mark['content'], 'position': mark['position'], 'occupancy': occupancy,
               'direction': mark['direction'], 'depth': mark['depth'], 'font': mark['font'],
               'source': mark['source'], 'nativeAcceptance': native_acceptance,
               'annotation': annotation, 'geometryRecipe': geometry_recipe,
               'feasible': feasible, 'warnings': warnings,
               'zoneViolations': zone_violations, 'keepoutViolations': keepout_violations}
        if not feasible:
            violations.append({'mark': mark['id'], 'zone': zone_violations, 'keepout': keepout_violations})
        rows.append(row)
    status = 'fail' if violations else 'pass'
    return _marking_contract(ctx, 'marking.create', {
        'marks': rows,
        'annotationCount': sum(1 for r in rows if r['representation'] == 'annotation'),
        'geometryRecipeCount': sum(1 for r in rows if r['representation'] in ('emboss', 'engrave')),
        'warningCount': sum(len(r['warnings']) for r in rows),
        'violationCount': len(violations), 'violations': violations,
        'nativeAcceptance': 'notEvaluated',
        'zones': zones, 'keepouts': keepouts},
        status=status,
        limitations=['Feasibility and occupancy are declared-geometry evaluations; native emboss/engrave geometry is not authored here.'])


def _marking_check(ctx, data):
    _cad_fields(data, ('marks',),
                ('schemaVersion', 'levels', 'flows', 'zones', 'keepouts', 'tolerance', 'frame'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('marking.check requires schemaVersion 1')
    marks = data['marks']
    if not isinstance(marks, list) or not marks:
        raise ValueError('marks must be a nonempty array')
    tolerance = ctx.length(data.get('tolerance', '0 mm'))
    if tolerance < 0:
        raise ValueError('tolerance must be nonnegative')
    levels = data.get('levels')
    level_values = None
    if levels is not None:
        if not isinstance(levels, dict) or 'min' not in levels or 'max' not in levels:
            raise ValueError('levels must be {min, max, source?}')
        level_values = {'min': ctx.length(levels['min']), 'max': ctx.length(levels['max'])}
    flows = []
    for i, spec in enumerate(data.get('flows', [])):
        if not isinstance(spec, dict) or 'direction' not in spec:
            raise ValueError('flow %d requires a direction' % i)
        flows.append({'id': spec.get('id', 'flow-%d' % i), 'direction': _cad_direction(spec['direction'])})
    zones = [_parse_region(ctx, spec, i, 'zone') for i, spec in enumerate(data.get('zones', []))]
    protected = [z for z in zones if z.get('kind') in _PROTECTED_ZONES]
    keepouts = [_parse_region(ctx, spec, i, 'keepout') for i, spec in enumerate(data.get('keepouts', []))]
    rows = []
    violations = []
    unevaluable = []
    for index, spec in enumerate(marks):
        mark = _parse_mark(ctx, spec, index)
        occupancy = _occupancy(mark)
        check_rows = []
        reference = mark['reference']
        if reference is not None:
            bound = reference['bound']
            if level_values is None:
                unevaluable.append({'mark': mark['id'], 'reason': 'computed liquid level is not provided'})
            elif mark['levelValue'] is None:
                unevaluable.append({'mark': mark['id'], 'reason': 'levelValue is not declared'})
            else:
                actual = ctx.length(mark['levelValue'])
                expected = level_values[bound]
                ok = abs(actual - expected) <= tolerance
                check_rows.append({'check': 'level-derivation', 'bound': bound, 'actual': actual,
                                   'expected': expected, 'passed': ok})
                if not ok:
                    violations.append({'mark': mark['id'], 'kind': 'level', 'bound': bound,
                                       'message': 'MIN/MAX is not derived from the computed liquid level'})
        if mark['kind'] == 'arrow':
            if mark['direction'] is None:
                violations.append({'mark': mark['id'], 'kind': 'flow', 'message': 'arrow has no flow direction'})
                check_rows.append({'check': 'flow-derivation', 'passed': False})
            elif not flows:
                unevaluable.append({'mark': mark['id'], 'reason': 'no defined flows provided'})
            else:
                match = next((f for f in flows if abs(_vdot(mark['direction'], f['direction'])) > 1.0 - 1e-9), None)
                check_rows.append({'check': 'flow-derivation', 'actual': mark['direction'],
                                   'matched': match['id'] if match else None, 'passed': match is not None})
                if match is None:
                    violations.append({'mark': mark['id'], 'kind': 'flow',
                                       'message': 'arrow direction is not from a defined flow'})
        for zone in protected:
            if _box_overlap(occupancy, zone['region']):
                violations.append({'mark': mark['id'], 'kind': 'zone', 'zone': zone['name'],
                                   'message': 'mark inside protected %s zone' % zone.get('kind', zone['name'])})
                check_rows.append({'check': 'protected-zone', 'zone': zone['name'], 'passed': False})
        for keepout in keepouts:
            if _box_overlap(occupancy, keepout['region']):
                violations.append({'mark': mark['id'], 'kind': 'keepout', 'keepout': keepout['name'],
                                   'message': 'mark inside declared keepout region'})
                check_rows.append({'check': 'keepout', 'keepout': keepout['name'], 'passed': False})
        if mark['representation'] in ('emboss', 'engrave') and mark['resolvedRepresentation'] == 'image':
            violations.append({'mark': mark['id'], 'kind': 'substitution',
                               'message': 'geometry request was implicitly replaced by an image'})
            check_rows.append({'check': 'no-image-substitution', 'passed': False})
        passed = not any(v['mark'] == mark['id'] for v in violations)
        rows.append({'id': mark['id'], 'kind': mark['kind'], 'checks': check_rows,
                     'occupancy': occupancy, 'passed': passed})
    if violations:
        status = 'fail'
    elif unevaluable:
        status = 'unknown'
    else:
        status = 'pass'
    return _marking_contract(ctx, 'marking.check', {
        'marks': rows, 'violations': violations, 'violationCount': len(violations),
        'unevaluable': unevaluable, 'levels': levels, 'flows': flows},
        status=status,
        limitations=['MIN/MAX derivation is verified against declared level values, not recomputed fluid geometry.',
                     'Zone containment uses axis-aligned occupancy bounds, not native glyph outlines.'])


CAD_HANDLERS.update({
    'marking.create': _marking_create,
    'marking.check': _marking_check,
})
