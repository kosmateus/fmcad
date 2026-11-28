"""GM30 sections, views and reversible presentation epilogue.

Section analysis editing uses the documented SectionAnalysis API: ``flip()`` is
an operation (it mutates the transform), not a boolean property, and an
absolute orientation request is compared against the documented
``getAsCoordinateSystem`` frame after applying. ``visibility.finalize`` composes
hide/recompute/health and intentionally leaves the requested presentation state
on success; on any error it restores its own temporary presentation changes and
reports a restoration failure separately without undoing recompute/geometry.
See docs/PRESENTATION.md.
"""
import math


_PRESENTATION_LIMITS = [
    'Section creation/editing requires installed SectionAnalyses API; otherwise inspect/edit are blocked.',
    'Presentation restore undoes only visibility/section/camera state, never recompute or geometry.',
    'Recompute/checkHealth is a real mutation, not a read-only inspection.',
]


def _presentation_identity(ctx):
    ctx.assert_identity()
    return {'creationId': getattr(ctx.doc, 'creationId', None), 'name': ctx.doc.name}


def _presentation_contract(ctx, operation, result, status='pass', read_only=False, warnings=None, limitations=None):
    base = {
        'schemaVersion': 1, 'operation': operation, 'status': status, 'success': status == 'pass',
        'documentIdentity': _presentation_identity(ctx),
        'units': {'length': 'cm', 'angle': 'rad'},
        'frame': {'space': 'component', 'component': ctx.ref(ctx.component)},
        'associativity': 'snapshot' if read_only else 'nativeProperty',
        'warnings': list(result.pop('warnings', warnings or [])),
        'method': 'Public Fusion section/camera/visibility SDK with explicit availability gates (GM30)',
        'limitations': _PRESENTATION_LIMITS + list(result.pop('limitations', limitations or [])),
        'provenance': {'requirement': 'GM30', 'source': 'docs/PRESENTATION.md'},
        'affected': list(result.pop('affected', [])),
        'restoreErrors': list(result.pop('restoreErrors', [])),
    }
    merged = dict(base)
    merged.update(result)
    merged['status'] = status
    merged['success'] = status == 'pass'
    return merged


def _presentation_blocked(ctx, operation, reason):
    return _presentation_contract(ctx, operation, {}, status='blocked', read_only=True,
                                  warnings=[reason],
                                  limitations=['The requested representation is not available through the installed SDK.'])


def _section_collection(ctx):
    if not hasattr(ctx.design, 'analyses') or not hasattr(ctx.design.analyses, 'sectionAnalyses'):
        raise ValueError('Installed API cannot access sections; update Fusion or use Inspect > Section Analysis in the UI')
    return ctx.design.analyses, ctx.design.analyses.sectionAnalyses


def _section_find(ctx, name):
    if not isinstance(name, str) or not name.strip():
        raise ValueError('name must be nonempty')
    analyses, sections = _section_collection(ctx)
    return analyses, _cad_unique([s for s in _cad_items(sections) if s.name == name], 'Section name')


def _unit(v):
    norm = math.hypot(*v)
    if norm == 0 or not math.isfinite(norm):
        return [0.0, 0.0, 0.0]
    return [x / norm for x in v]


def _mat_frame(cells):
    if not isinstance(cells, (list, tuple)) or len(cells) != 16:
        raise ValueError('Matrix must be 16 values in Matrix3D.asArray row-major order')
    origin = [float(cells[3]), float(cells[7]), float(cells[11])]
    x = _unit([float(cells[0]), float(cells[4]), float(cells[8])])
    y = _unit([float(cells[1]), float(cells[5]), float(cells[9])])
    z = _unit([float(cells[2]), float(cells[6]), float(cells[10])])
    return {'origin': origin, 'xAxis': x, 'yAxis': y, 'zAxis': z, 'cutDirection': z}


def _color_info(color):
    if color is None:
        return None
    return {'color': [int(color.red), int(color.green), int(color.blue), int(getattr(color, 'opacity', 255))]}


def _section_state(section):
    return {'name': section.name,
            'transform': list(section.transform.asArray()) if hasattr(section.transform, 'asArray') else None,
            'initialPosition': list(section.initialPosition.asArray()) if hasattr(section, 'initialPosition') and hasattr(section.initialPosition, 'asArray') else None,
            'frame': _mat_frame(list(section.transform.asArray())) if hasattr(section.transform, 'asArray') else None,
            'sectionColor': _color_info(getattr(section, 'sectionColor', None)),
            'isHatchShown': getattr(section, 'isHatchShown', None),
            'isLightBulbOn': getattr(section, 'isLightBulbOn', None),
            'isVisible': getattr(section, 'isVisible', None)}


def section_inspect(ctx, data):
    _cad_fields(data, ('name',))
    analyses, section = _section_find(ctx, data['name'])
    result = _section_state(section)
    result['ref'] = ctx.ref(section)
    result['analysesLightBulbOn'] = getattr(analyses, 'isLightBulbOn', None)
    return _presentation_contract(ctx, 'section.inspect', result, read_only=True,
                                  limitations=['The transform is read in cm component space; cut direction is the transform Z axis.'])


def _matrix_from_descriptor(ctx, spec):
    if isinstance(spec, dict):
        allowed = {'origin', 'xAxis', 'yAxis', 'zAxis'}
        if set(spec) - allowed:
            raise ValueError('transform descriptor accepts origin/xAxis/yAxis/zAxis only')
        if any(k not in spec for k in ('origin', 'xAxis', 'yAxis', 'zAxis')):
            raise ValueError('transform descriptor requires origin, xAxis, yAxis, and zAxis')
        origin = ctx.point(spec['origin'])
        x = adsk.core.Vector3D.create(*_cad_direction(spec['xAxis']))
        y = adsk.core.Vector3D.create(*_cad_direction(spec['yAxis']))
        z = adsk.core.Vector3D.create(*_cad_direction(spec['zAxis']))
        matrix = adsk.core.Matrix3D.create()
        _cad_require_result(matrix.setWithCoordinateSystem(origin, x, y, z), 'Define section transform')
        return matrix, list(matrix.asArray())
    if isinstance(spec, (list, tuple)):
        if len(spec) != 16 or any(type(v) not in (int, float) or not math.isfinite(v) for v in spec):
            raise ValueError('transform array must be 16 finite numbers in row-major order')
        matrix = adsk.core.Matrix3D.create()
        _cad_require_result(matrix.setWithArray(list(spec)), 'Define section transform')
        return matrix, list(spec)
    raise ValueError('transform must be a 16-number array or an {origin,xAxis,yAxis,zAxis} descriptor')


def section_edit(ctx, data):
    _cad_fields(data, ('name',), ('transform', 'sectionColor', 'hatch', 'flip'))
    analyses, section = _section_find(ctx, data['name'])
    before = _section_state(section)
    before['ref'] = ctx.ref(section)
    changed = []
    requested_frame = None
    if 'transform' in data:
        matrix, cells = _matrix_from_descriptor(ctx, data['transform'])
        section.transform = matrix
        changed.append('transform')
        requested_frame = _mat_frame(cells)
    if 'sectionColor' in data:
        value = data['sectionColor']
        if value is None:
            section.sectionColor = None
        else:
            if not isinstance(value, (list, tuple)) or len(value) not in (3, 4) or \
                    any(type(v) is not int or not 0 <= v <= 255 for v in value):
                raise ValueError('sectionColor must be null or [r,g,b] / [r,g,b,a] integers 0..255')
            rgba = list(value) + [255] if len(value) == 3 else list(value)
            section.sectionColor = adsk.core.Color.create(*rgba)
        changed.append('sectionColor')
    if 'hatch' in data:
        if type(data['hatch']) is not bool:
            raise ValueError('hatch must be boolean')
        section.isHatchShown = data['hatch']
        changed.append('hatch')
    if 'flip' in data:
        if type(data['flip']) is not bool:
            raise ValueError('flip must be boolean')
        if data['flip']:
            _cad_require_result(section.flip(), 'Flip section cut direction')
            changed.append('flip')
    after = _section_state(section)
    after['ref'] = ctx.ref(section)
    orientation_match = None
    if requested_frame is not None:
        actual = _mat_frame(list(section.transform.asArray()))
        orientation_match = {
            'requested': requested_frame, 'actual': actual,
            'xAxisAligned': _dot_close(requested_frame['xAxis'], actual['xAxis']),
            'yAxisAligned': _dot_close(requested_frame['yAxis'], actual['yAxis']),
            'zAxisAligned': _dot_close(requested_frame['zAxis'], actual['zAxis'])}
    result = {'name': section.name, 'changed': changed, 'before': before, 'after': after,
              'orientationMatch': orientation_match,
              'affected': [{'ref': ctx.ref(section), 'before': before, 'after': after}],
              'limitations': ['flip() mutates the transform Z axis and is applied before the final readback; '
                              'the documented frame is compared to the requested absolute orientation.']}
    return _presentation_contract(ctx, 'section.edit', result)


def _dot_close(a, b):
    return abs(sum(x * y for x, y in zip(a, b))) > 1 - 1e-9


_HEALTH_NAMES = ('HealthyFeatureHealthState', 'WarningFeatureHealthState',
                 'ErrorFeatureHealthState', 'SuppressedFeatureHealthState')


def _health_name(state):
    if state is None:
        return None
    states = adsk.fusion.FeatureHealthStates
    return next((n for n in _HEALTH_NAMES if hasattr(states, n) and getattr(states, n) == state), 'unknown')


def _health_check(ctx):
    timeline = getattr(ctx.design, 'timeline', None)
    if timeline is None:
        return {'available': False, 'items': [], 'unhealthy': [], 'warningItems': []}
    items = []
    unhealthy, warning_items = [], []
    for i in range(timeline.count):
        item = timeline.item(i)
        state = _health_name(getattr(item, 'healthState', None))
        row = {'name': item.name, 'state': state,
               'message': getattr(item, 'errorOrWarningMessage', '')}
        items.append(row)
        if state == 'ErrorFeatureHealthState':
            unhealthy.append(row)
        elif state == 'WarningFeatureHealthState':
            warning_items.append(row)
    return {'available': True, 'items': items, 'unhealthy': unhealthy, 'warningItems': warning_items}


def _vis_chain(entity):
    chain = [entity]
    seen = {id(entity)}
    current = entity
    while True:
        parent = getattr(current, 'assemblyContext', None)
        if parent is None or id(parent) in seen:
            break
        chain.append(parent)
        seen.add(id(parent))
        current = parent
    return chain


def _vis_snapshot(entities):
    rows = []
    seen = []
    for entity in entities:
        for target in _vis_chain(entity):
            if not any(target is other for other in seen):
                seen.append(target)
                rows.append((target, getattr(target, 'isLightBulbOn', None)))
    return rows


def _vis_restore(rows):
    errors = []
    for target, value in rows:
        if value is None:
            continue
        try:
            target.isLightBulbOn = value
        except Exception as error:
            errors.append({'type': type(error).__name__, 'message': str(error)})
    return errors


def visibility_finalize(ctx, data):
    _cad_fields(data, (), ('hide', 'show', 'recompute', 'checkHealth'))
    hide_refs = data.get('hide', [])
    show_refs = data.get('show', [])
    if not isinstance(hide_refs, list) or not isinstance(show_refs, list):
        raise ValueError('hide and show must be arrays')
    if not hide_refs and not show_refs:
        raise ValueError('visibility.finalize requires hide and/or show refs')
    recompute = data.get('recompute', True)
    check_health = data.get('checkHealth', True)
    if type(recompute) is not bool or type(check_health) is not bool:
        raise ValueError('recompute and checkHealth must be boolean')
    to_hide = [ctx.resolve(ref) for ref in hide_refs]
    to_show = [ctx.resolve(ref) for ref in show_refs]
    for entity in to_hide + to_show:
        if not hasattr(entity, 'isLightBulbOn'):
            raise ValueError('Target lacks isLightBulbOn; select bodies, occurrences, sketches, or construction geometry')
    snapshot = _vis_snapshot(to_hide + to_show)
    applied = []
    recomputed = False
    health = None
    try:
        for entity in to_hide:
            entity.isLightBulbOn = False
            applied.append(ctx.ref(entity))
        for entity in to_show:
            entity.isLightBulbOn = True
            applied.append(ctx.ref(entity))
        recomputed = False
        if recompute:
            _cad_require_result(ctx.design.computeAll(), 'Recompute design')
            recomputed = True
        health = _health_check(ctx)
        healthy = not health['unhealthy']
        if check_health and not healthy:
            raise _UnhealthyHistory(health)
        result = {'applied': applied, 'hidden': [ctx.ref(e) for e in to_hide],
                  'shown': [ctx.ref(e) for e in to_show], 'recomputed': recomputed,
                  'leftRequestedState': True, 'health': health,
                  'restored': False,
                  'limitations': ['The requested presentation state is intentionally left in place on success.',
                                  'Ancestor/folder visibility is only touched for the explicitly listed entities and their occurrence parents.']}
        return _presentation_contract(ctx, 'visibility.finalize', result, status='pass')
    except BaseException as error:
        restore_errors = _vis_restore(snapshot)
        unhealthy = [u['name'] for u in (error.health['unhealthy'] if isinstance(error, _UnhealthyHistory) else [])]
        result = {'applied': applied, 'restored': not bool(restore_errors), 'restoreErrors': restore_errors,
                  'health': health, 'recomputed': recomputed,
                  'error': {'type': type(error).__name__, 'message': str(error)},
                  'warnings': ['Unhealthy timeline history: ' + ', '.join(unhealthy)] if unhealthy else []}
        return _presentation_contract(ctx, 'visibility.finalize', result, status='fail',
                                      limitations=['Presentation changes were restored; recompute/geometry were not undone.',
                                                   'checkHealth:true reports unhealthy history as a failed control, not a silent pass.'])


class _UnhealthyHistory(Exception):
    def __init__(self, health):
        super().__init__('Unhealthy timeline history')
        self.health = health


CAD_HANDLERS.update({
    'section.inspect': section_inspect,
    'section.edit': section_edit,
    'visibility.finalize': visibility_finalize,
})
