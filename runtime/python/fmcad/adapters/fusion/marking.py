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
import math as _marking_adapter_math


if _CAD_TYPE_CHECKING:
    _MarkingKind: TypeAlias = Literal['text', 'symbol', 'arrow']
    _MarkingRepresentation: TypeAlias = Literal['annotation', 'emboss', 'engrave']
    _MarkingResolvedRepresentation: TypeAlias = Literal['annotation', 'emboss', 'engrave', 'image']
    _MarkingBound: TypeAlias = Literal['min', 'max']

    class _MarkingVector(_Protocol):
        @property
        def x(self) -> float: ...

        @property
        def y(self) -> float: ...

        @property
        def z(self) -> float: ...

    class _MarkingParsed(_CadTypedDict):
        id: str
        kind: _MarkingKind
        representation: _MarkingRepresentation
        content: JsonValue
        position: list[float]
        height: float
        width: float
        stroke: float
        depth: float | None
        direction: list[float] | None
        font: JsonValue
        source: JsonValue
        reference: JsonValue
        levelValue: JsonValue
        resolvedRepresentation: JsonValue

    class _MarkingRegion(_CadTypedDict):
        name: JsonValue
        kind: JsonValue
        region: JsonObject

    class _MarkingFlow(_CadTypedDict):
        id: JsonValue
        direction: list[float]


def _marking_point3(ctx: "CadContext", spec: "JsonValue") -> "list[float]":
    point = ctx.point(spec)
    if isinstance(point, (list, tuple)):
        values = _cad_cast("Sequence[JsonValue]", point)
        return [float(_cad_cast("int | float | str | bool", value)) for value in values]
    vector = _cad_cast("_MarkingVector", point)
    return [vector.x, vector.y, vector.z]


def _marking_contract(ctx: "CadContext", operation: str, result: "JsonRecord",
                      status: str = 'pass', limitations: "Sequence[str]" = ()) -> "JsonRecord":
    identity = None
    if hasattr(ctx, 'doc') and getattr(getattr(ctx, 'doc', None), 'name', None) is not None:
        identity = {'name': ctx.doc.name}
    merged: JsonRecord = dict(schemaVersion=1, operation=operation, documentIdentity=identity,
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


def _marking_parse_mark(ctx: "CadContext", spec: "JsonValue", index: int) -> "_MarkingParsed":
    if not isinstance(spec, dict):
        raise ValueError('mark %d must be an object' % index)
    spec_record = spec
    name = spec_record.get('id')
    if not isinstance(name, str) or not name:
        raise ValueError('mark %d requires an id' % index)
    kind = spec_record.get('kind')
    if kind not in _MARK_KINDS:
        raise ValueError('mark %r: unsupported kind %r' % (name, kind))
    kind_value = kind
    representation = spec_record.get('representation')
    if representation not in _REPRESENTATIONS:
        raise ValueError('mark %r: unsupported representation %r' % (name, representation))
    representation_value = representation
    content = spec_record.get('content')
    if kind_value in ('text', 'symbol'):
        if not isinstance(content, str) or not content.strip():
            raise ValueError('mark %r: text/symbol requires nonempty content' % name)
    elif 'content' in spec_record:
        raise ValueError('mark %r: arrow does not take content' % name)
    if 'position' not in spec_record:
        raise ValueError('mark %r requires a position' % name)
    position = _marking_point3(ctx, spec_record['position'])
    dimensions = spec_record.get('dimensions')
    if not isinstance(dimensions, dict) or 'height' not in dimensions:
        raise ValueError('mark %r requires dimensions.height' % name)
    height = ctx.length(dimensions['height'])
    width = ctx.length(dimensions['width']) if 'width' in dimensions else height
    stroke = ctx.length(dimensions['stroke']) if 'stroke' in dimensions else 0.0
    depth = ctx.length(spec_record['depth']) if 'depth' in spec_record else None
    if height <= 0 or width < 0 or stroke < 0 or (depth is not None and depth < 0):
        raise ValueError('mark %r: height must be positive and width/stroke/depth nonnegative' % name)
    direction = None
    if kind_value == 'arrow':
        if 'direction' not in spec_record:
            raise ValueError('mark %r: arrow requires a flow direction' % name)
        direction = _cad_direction(spec_record['direction'])
    elif 'direction' in spec_record:
        direction = _cad_direction(spec_record['direction'])
    source = spec_record.get('source')
    if source is not None:
        if not isinstance(source, dict):
            raise ValueError('mark %r: source must be an object' % name)
        if source.get('status') not in (None,) + _MARKING_SOURCE_STATUSES:
            raise ValueError('mark %r: unsupported source status %r' % (name, source.get('status')))
    reference = spec_record.get('reference')
    if reference is not None:
        if not isinstance(reference, dict):
            raise ValueError("mark %r: reference must be {kind: 'liquid-level', bound: 'min'|'max'}" % name)
        if reference.get('kind') != 'liquid-level' or reference.get('bound') not in ('min', 'max'):
            raise ValueError("mark %r: reference must be {kind: 'liquid-level', bound: 'min'|'max'}" % name)
    resolved = spec_record.get('resolvedRepresentation')
    if resolved is not None and resolved not in ('annotation', 'emboss', 'engrave', 'image'):
        raise ValueError('mark %r: unsupported resolvedRepresentation %r' % (name, resolved))
    return {'id': name, 'kind': kind_value, 'representation': representation_value, 'content': content,
            'position': position, 'height': height, 'width': width, 'stroke': stroke, 'depth': depth,
            'direction': direction, 'font': spec_record.get('font'), 'source': source,
            'reference': reference, 'levelValue': spec_record.get('levelValue'),
            'resolvedRepresentation': resolved}


def _marking_parse_region(ctx: "CadContext", spec: "JsonValue", index: int,
                          what: str) -> "_MarkingRegion":
    if not isinstance(spec, dict) or 'region' not in spec:
        raise ValueError('%s %d requires a region' % (what, index))
    spec_record = spec
    region = spec_record['region']
    if not isinstance(region, dict) or 'min' not in region or 'max' not in region:
        raise ValueError('%s %d region requires min and max' % (what, index))
    region_record = region
    low = _marking_point3(ctx, region_record['min'])
    high = _marking_point3(ctx, region_record['max'])
    if any(low[i] > high[i] for i in range(3)):
        raise ValueError('%s %d region has min > max' % (what, index))
    return {'name': spec_record.get('name'), 'kind': spec_record.get('kind'),
            'region': {'min': low, 'max': high}}


def _marking_create(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('marks',), ('schemaVersion', 'zones', 'keepouts', 'frame'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('marking.create requires schemaVersion 1')
    marks_value = data['marks']
    if not isinstance(marks_value, list) or not marks_value:
        raise ValueError('marks must be a nonempty array')
    marks = _cad_cast("Sequence[JsonValue]", marks_value)
    zone_values = _cad_cast("Sequence[JsonValue]", data.get('zones', []))
    keepout_values = _cad_cast("Sequence[JsonValue]", data.get('keepouts', []))
    zones: list[_MarkingRegion] = [_marking_parse_region(ctx, spec, i, 'zone')
                                   for i, spec in enumerate(zone_values)]
    keepouts: list[_MarkingRegion] = [_marking_parse_region(ctx, spec, i, 'keepout')
                                      for i, spec in enumerate(keepout_values)]
    protected = [z for z in zones if z.get('kind') in _PROTECTED_ZONES]
    rows: list[JsonRecord] = []
    violations: list[JsonRecord] = []
    for index, spec in enumerate(marks):
        mark = _marking_parse_mark(ctx, spec, index)
        occupancy = _occupancy(_cad_cast("JsonObject", mark))
        warnings: list[str] = []
        zone_violations: list[JsonValue] = [z['name'] for z in protected
                                            if _marking_box_overlap(occupancy, z['region'])]
        keepout_violations: list[JsonValue] = [k['name'] for k in keepouts
                                               if _marking_box_overlap(occupancy, k['region'])]
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
            annotation: JsonValue = None
        else:
            native_acceptance = 'annotation'
            geometry_recipe: JsonValue = None
            annotation = {'content': mark['content'], 'position': mark['position'], 'frame': data.get('frame')}
        feasible = not zone_violations and not keepout_violations
        row: JsonRecord = {'id': mark['id'], 'kind': mark['kind'], 'representation': mark['representation'],
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
        'warningCount': sum(len(_cad_cast("Sequence[JsonValue]", r['warnings'])) for r in rows),
        'violationCount': len(violations), 'violations': violations,
        'nativeAcceptance': 'notEvaluated',
        'zones': _cad_cast("JsonValue", zones), 'keepouts': _cad_cast("JsonValue", keepouts)},
        status=status,
        limitations=['Feasibility and occupancy are declared-geometry evaluations; native emboss/engrave geometry is not authored here.'])


def _marking_check(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('marks',),
                ('schemaVersion', 'levels', 'flows', 'zones', 'keepouts', 'tolerance', 'frame'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('marking.check requires schemaVersion 1')
    marks_value = data['marks']
    if not isinstance(marks_value, list) or not marks_value:
        raise ValueError('marks must be a nonempty array')
    marks = _cad_cast("Sequence[JsonValue]", marks_value)
    tolerance = ctx.length(data.get('tolerance', '0 mm'))
    if tolerance < 0:
        raise ValueError('tolerance must be nonnegative')
    levels_value = data.get('levels')
    levels: JsonValue = levels_value
    level_values: dict[str, float] | None = None
    if levels_value is not None:
        if not isinstance(levels_value, dict) or 'min' not in levels_value or 'max' not in levels_value:
            raise ValueError('levels must be {min, max, source?}')
        levels = levels_value
        level_values = {'min': ctx.length(levels['min']), 'max': ctx.length(levels['max'])}
    flows_value = _cad_cast("Sequence[JsonValue]", data.get('flows', []))
    flows: list[_MarkingFlow] = []
    for i, spec_value in enumerate(flows_value):
        if not isinstance(spec_value, dict) or 'direction' not in spec_value:
            raise ValueError('flow %d requires a direction' % i)
        spec = spec_value
        flows.append({'id': spec.get('id', 'flow-%d' % i), 'direction': _cad_direction(spec['direction'])})
    zone_values = _cad_cast("Sequence[JsonValue]", data.get('zones', []))
    zones: list[_MarkingRegion] = [_marking_parse_region(ctx, spec, i, 'zone')
                                   for i, spec in enumerate(zone_values)]
    protected = [z for z in zones if z.get('kind') in _PROTECTED_ZONES]
    keepout_values = _cad_cast("Sequence[JsonValue]", data.get('keepouts', []))
    keepouts: list[_MarkingRegion] = [_marking_parse_region(ctx, spec, i, 'keepout')
                                      for i, spec in enumerate(keepout_values)]
    rows: list[JsonRecord] = []
    violations: list[JsonRecord] = []
    unevaluable: list[JsonRecord] = []
    for index, spec in enumerate(marks):
        mark = _marking_parse_mark(ctx, spec, index)
        occupancy = _occupancy(_cad_cast("JsonObject", mark))
        check_rows: list[JsonValue] = []
        reference = mark['reference']
        if reference is not None:
            reference_record = _cad_cast("JsonObject", reference)
            bound = _cad_cast("_MarkingBound", reference_record['bound'])
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
                match = next((f for f in flows if abs(_marking_vdot(mark['direction'], f['direction'])) > 1.0 - 1e-9), None)
                check_rows.append({'check': 'flow-derivation', 'actual': mark['direction'],
                                   'matched': match['id'] if match else None, 'passed': match is not None})
                if match is None:
                    violations.append({'mark': mark['id'], 'kind': 'flow',
                                       'message': 'arrow direction is not from a defined flow'})
        for zone in protected:
            if _marking_box_overlap(occupancy, zone['region']):
                violations.append({'mark': mark['id'], 'kind': 'zone', 'zone': zone['name'],
                                   'message': 'mark inside protected %s zone' % zone.get('kind', zone['name'])})
                check_rows.append({'check': 'protected-zone', 'zone': zone['name'], 'passed': False})
        for keepout in keepouts:
            if _marking_box_overlap(occupancy, keepout['region']):
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
        'unevaluable': unevaluable, 'levels': levels, 'flows': _cad_cast("JsonValue", flows)},
        status=status,
        limitations=['MIN/MAX derivation is verified against declared level values, not recomputed fluid geometry.',
                     'Zone containment uses axis-aligned occupancy bounds, not native glyph outlines.'])


CAD_HANDLERS.update({
    'marking.create': _marking_create,
    'marking.check': _marking_check,
})
