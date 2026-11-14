"""GM36: deterministic explode planning and rendering.

``explode.plan`` computes a deterministic per-frame pose schedule and a frame
manifest from real occurrence references, per-instance explosion axes and
distances, ordered phases (cock/release/return), disconnection precedence, an
easing law and timing/fps. It never mutates the document. ``explode.render``
applies the same schedule by moving the occurrence transforms (instances, not
loose body copies; a moving parent occurrence carries its nested content
natively), optionally capturing PNG frames, and restores the original
transforms by default in ``finally`` (restoration failure is reported
separately, not claimed as rollback). Exploding an assembly is not a proof of a
service/withdrawal path; native storyboard action authoring is a separate
feature and is never claimed here.
"""
import math

import adsk.core
import adsk.fusion


_EXPLODE_EASINGS = ('linear', 'smoothstep', 'easeIn', 'easeOut', 'easeInOut')
_EXPLODE_LIMITS = [
    'Explosion poses are deterministic interpolations of occurrence transforms; they are not a continuous collision or service-path proof.',
    'Instances are moved, never loose body copies; a moving parent occurrence carries its nested content natively.',
    'Native storyboard action authoring is separate from playback; these frames do not create a native action sequence.',
    'Restoration is not rollback; a restore failure is reported separately and the original error is preserved.',
]


def _explode_contract(ctx, operation, result, status='pass', read_only=True):
    identity = None
    if hasattr(ctx, 'doc') and getattr(getattr(ctx, 'doc', None), 'name', None) is not None:
        identity = {'creationId': getattr(ctx.doc, 'creationId', None), 'name': ctx.doc.name}
    component = None
    if hasattr(ctx, 'component') and hasattr(ctx, 'ref'):
        try:
            component = ctx.ref(ctx.component)
        except Exception:
            component = None
    out = dict(schemaVersion=1, operation=operation, status=status, success=status == 'pass',
               documentIdentity=identity, units={'length': 'cm', 'time': 's'},
               frame={'space': 'root', 'component': component},
               associativity='snapshot' if read_only else 'recipeRegeneration',
               method='GM36 deterministic explode plan/render over occurrence instances',
               provenance={'requirement': 'GM36', 'source': 'docs/EXPLODE_ANIMATION.md'})
    out['warnings'] = list(result.pop('warnings', []))
    out['limitations'] = _EXPLODE_LIMITS + list(result.pop('limitations', []))
    out['affected'] = list(result.pop('affected', []))
    out.update(result)
    return out


def _explode_number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(label + ' must be a finite number')
    return float(value)


def _explode_seconds(value):
    if isinstance(value, str):
        parts = value.strip().split()
        if len(parts) != 2:
            raise ValueError('duration must be a finite positive number of seconds or "<n> s"/"<n> ms"')
        number, unit = _explode_number(float(parts[0]), 'duration'), parts[1]
        seconds = number if unit == 's' else number / 1000.0 if unit == 'ms' else None
        if seconds is None:
            raise ValueError('duration unit must be s or ms')
    else:
        seconds = _explode_number(value, 'duration')
    if seconds <= 0:
        raise ValueError('duration must be positive')
    return seconds


def _explode_direction(value):
    if not isinstance(value, (list, tuple)) or len(value) != 3 or any(
            isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in value):
        raise ValueError('axis must be three finite unitless numbers')
    norm = math.hypot(*value)
    if norm == 0:
        raise ValueError('axis cannot be zero')
    return [x / norm for x in value]


def _explode_ease(name, t):
    if name == 'linear':
        return t
    if name == 'smoothstep':
        return t * t * (3 - 2 * t)
    if name == 'easeIn':
        return t * t
    if name == 'easeOut':
        return 1 - (1 - t) * (1 - t)
    if name == 'easeInOut':
        return 2 * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 2 / 2
    raise ValueError('easing must be one of: ' + ', '.join(_EXPLODE_EASINGS))


def _explode_origin(occurrence):
    matrix = occurrence.transform2.asArray()
    return [float(matrix[3]), float(matrix[7]), float(matrix[11])]


def _explode_version(data):
    if data.get('schemaVersion') != 1:
        raise ValueError('GM36 explode operations require schemaVersion:1')


def _explode_specs(ctx, occurrences):
    if not isinstance(occurrences, list) or not occurrences:
        raise ValueError('occurrences must be a nonempty array')
    specs = []
    seen = set()
    for position, spec in enumerate(occurrences):
        if not isinstance(spec, dict) or 'ref' not in spec:
            raise ValueError('occurrence entries require a ref')
        if 'axis' not in spec or 'distance' not in spec:
            raise ValueError('occurrence entries require axis and distance')
        occurrence = ctx.resolve(spec['ref'], 'occurrence')
        key = _ref_key(ctx.ref(occurrence))
        if key in seen:
            raise ValueError('duplicate occurrence reference')
        seen.add(key)
        axis = _explode_direction(spec['axis'])
        distance = ctx.length(spec['distance'])
        if distance < 0:
            raise ValueError('distance must be nonnegative')
        label = spec.get('label')
        if label is not None and (not isinstance(label, str) or not label.strip()):
            raise ValueError('label must be nonempty text')
        specs.append({'occurrence': occurrence, 'ref': ctx.ref(occurrence), 'axis': axis,
                      'distance': distance, 'phase': spec.get('phase'), 'label': label,
                      'position': position, 'origin': _explode_origin(occurrence)})
    return specs


def _explode_plan_model(ctx, data):
    specs = _explode_specs(ctx, data['occurrences'])
    duration = _explode_seconds(data['duration'])
    fps = data['fps']
    if type(fps) is not int or fps < 1:
        raise ValueError('fps must be a positive integer')
    easing = data.get('easing', 'linear')
    if easing not in _EXPLODE_EASINGS:
        raise ValueError('easing must be one of: ' + ', '.join(_EXPLODE_EASINGS))

    phases = data.get('phases', [])
    if not isinstance(phases, list):
        raise ValueError('phases must be an array of names')
    phase_names = []
    for phase in phases:
        if not isinstance(phase, str) or not phase.strip():
            raise ValueError('phases entries must be nonempty names')
        if phase in phase_names:
            raise ValueError('duplicate phase name: ' + phase)
        phase_names.append(phase)
    if not phase_names:
        phase_names = ['explode']
    phase_index = {name: i for i, name in enumerate(phase_names)}
    for spec in specs:
        if spec['phase'] is not None and spec['phase'] not in phase_names:
            raise ValueError('occurrence phase references an unknown phase: ' + spec['phase'])
        spec['phase'] = spec['phase'] if spec['phase'] is not None else phase_names[-1]
        spec['phaseIndex'] = phase_index[spec['phase']]

    by_key = {_ref_key(s['ref']): s for s in specs}
    disconnections = data.get('disconnections', [])
    if not isinstance(disconnections, list):
        raise ValueError('disconnections must be an array')
    edges = []
    for disc in disconnections:
        if not isinstance(disc, dict) or 'from' not in disc or 'to' not in disc:
            raise ValueError('disconnections entries require from and to occurrence refs')
        source = ctx.resolve(disc['from'], 'occurrence')
        target = ctx.resolve(disc['to'], 'occurrence')
        source_key = _ref_key(ctx.ref(source))
        target_key = _ref_key(ctx.ref(target))
        if source_key not in by_key or target_key not in by_key:
            raise ValueError('disconnection references an occurrence not listed in occurrences')
        edges.append((source_key, target_key, disc.get('name'), ctx.ref(source), ctx.ref(target)))

    blockers = [{'from': sref, 'to': tref, 'name': name,
                 'message': 'disconnected-from occurrence must explode in an earlier phase'}
                for source, target, name, sref, tref in edges
                if by_key[source]['phaseIndex'] >= by_key[target]['phaseIndex']]

    adjacency = {_ref_key(s['ref']): [] for s in specs}
    for source, target, _name, _sref, _tref in edges:
        adjacency[source].append(target)
    visited, visiting = set(), set()
    cycles = []

    def visit(node, stack):
        if node in visiting:
            cycles.append('cycle: ' + ' -> '.join(str(x) for x in stack + [node]))
            return
        if node in visited:
            return
        visiting.add(node)
        for nxt in adjacency.get(node, []):
            visit(nxt, stack + [node])
        visiting.remove(node)
        visited.add(node)

    for spec in specs:
        visit(_ref_key(spec['ref']), [])

    order = sorted(specs, key=lambda s: (s['phaseIndex'], s['position']))
    order_rows = [{'ref': s['ref'], 'label': s['label'], 'phase': s['phase'],
                   'phaseIndex': s['phaseIndex']} for s in order]

    frame_count = int(math.floor(duration * fps)) + 1
    if frame_count < 2:
        raise ValueError('duration * fps must span at least one frame interval')
    phase_span = duration / len(phase_names)
    phase_schedule = [{'name': name, 'startTime': round(i * phase_span, 9),
                       'endTime': round((i + 1) * phase_span, 9),
                       'frameStart': int(i * phase_span * fps),
                       'frameEnd': min(frame_count - 1, int(math.ceil((i + 1) * phase_span * fps)))}
                      for i, name in enumerate(phase_names)]

    poses, trails = [], []
    for index in range(frame_count):
        time = index / fps
        rows = []
        for spec in specs:
            start = spec['phaseIndex'] * phase_span
            local = max(0.0, min(1.0, (time - start) / phase_span))
            fraction = _explode_ease(easing, local)
            origin = [spec['origin'][i] + spec['axis'][i] * spec['distance'] * fraction for i in range(3)]
            rows.append({'ref': spec['ref'], 'label': spec['label'], 'phase': spec['phase'],
                         'origin': [round(v, 9) for v in origin], 'axis': spec['axis'],
                         'distance': spec['distance'], 'fraction': round(fraction, 9)})
        poses.append({'index': index, 'timeSeconds': round(time, 9), 'occurrences': rows})

    for spec in order:
        final = [spec['origin'][i] + spec['axis'][i] * spec['distance'] for i in range(3)]
        trails.append({'ref': spec['ref'], 'label': spec['label'],
                       'points': [pose['occurrences'][spec['position']]['origin'] for pose in poses]})

    return {'order': order_rows, 'phaseSchedule': phase_schedule, 'frameCount': frame_count,
            'durationSeconds': round(duration, 9), 'fps': fps,
            'frameDurationSeconds': round(1.0 / fps, 9), 'easing': easing,
            'poses': poses, 'trails': trails,
            'balloons': [{'ref': s['ref'], 'label': s['label'],
                          'position': [round(s['origin'][i] + s['axis'][i] * s['distance'], 9) for i in range(3)]}
                         for s in order],
            'blockers': blockers, 'cycles': cycles,
            'nativeStoryboardActionsCreated': False, 'explodeIsNotServicePath': True,
            'affected': [s['ref'] for s in order]}


def explode_plan(ctx, data):
    _cad_fields(data, ('schemaVersion', 'occurrences', 'duration', 'fps'),
                ('phases', 'disconnections', 'easing', 'frame'))
    _explode_version(data)
    result = _explode_plan_model(ctx, data)
    ok = not result['blockers'] and not result['cycles']
    return _explode_contract(ctx, 'explode.plan', result, status='pass' if ok else 'fail', read_only=True)


def _explode_frame_paths(data, count):
    if 'frameFiles' in data and any(k in data for k in ('directory', 'prefix')):
        raise ValueError('Use frameFiles OR directory/prefix')
    if 'prefix' in data and 'directory' not in data:
        raise ValueError('prefix requires directory')
    files = data.get('frameFiles')
    if 'directory' in data:
        from pathlib import Path
        directory = data['directory']
        prefix = data.get('prefix', 'frame')
        if not isinstance(directory, str) or not Path(directory).is_dir():
            raise ValueError('directory must be an existing directory')
        files = [str(Path(directory) / ('%s-%03d.png' % (prefix, i))) for i in range(count)]
    if files is None and 'frameFiles' not in data:
        return []
    if not isinstance(files, list) or len(files) != count:
        raise ValueError('frameFiles must have exactly frameCount paths')
    import os
    from pathlib import Path
    paths, seen = [], set()
    for value in files:
        if not isinstance(value, str) or not value.strip():
            raise ValueError('Frame target must be a PNG path')
        path = Path(value)
        if path.suffix.lower() != '.png' or not path.parent.is_dir():
            raise ValueError('Frame target must be a PNG path with an existing parent')
        key = os.path.normcase(str(path.resolve())).casefold()
        if key in seen or path.exists():
            raise ValueError('Duplicate or existing frame target; overwriting is not supported')
        seen.add(key)
        paths.append(path)
    return paths


def explode_render(ctx, data):
    _cad_fields(data, ('schemaVersion', 'occurrences', 'duration', 'fps', 'confirm'),
                ('phases', 'disconnections', 'easing', 'frame', 'restore',
                 'frameFiles', 'directory', 'prefix', 'width', 'height'))
    _explode_version(data)
    ctx.require_confirm(data)
    restore = data.get('restore', True)
    if type(restore) is not bool:
        raise ValueError('restore must be boolean')
    width, height = data.get('width', 1280), data.get('height', 720)
    if any(type(v) is not int or not 32 <= v <= 4096 for v in (width, height)):
        raise ValueError('Image dimensions must be integers in 32..4096')
    plan = _explode_plan_model(ctx, data)
    paths = _explode_frame_paths(data, plan['frameCount'])
    if not paths and any(k in data for k in ('width', 'height')):
        raise ValueError('Image dimensions require frame targets')
    viewport = getattr(ctx.app, 'activeViewport', None)
    if paths and (viewport is None or getattr(viewport, 'parentDocument', ctx.doc) != ctx.doc):
        raise ValueError('Active viewport must belong to the target document for frame capture')

    specs = _explode_specs(ctx, data['occurrences'])
    by_ref = {}
    for spec in specs:
        by_ref[_ref_key(spec['ref'])] = spec
    original = {id(s['occurrence']): s['occurrence'].transform2.asArray() for s in specs}
    frames, error, restore_errors = [], None, []
    try:
        for pose in plan['poses']:
            for row in pose['occurrences']:
                spec = by_ref[_ref_key(row['ref'])]
                matrix = adsk.core.Matrix3D.create()
                cells = list(original[id(spec['occurrence'])])
                cells[3], cells[7], cells[11] = row['origin'][0], row['origin'][1], row['origin'][2]
                _cad_require_result(matrix.setWithArray(cells), 'Explode occurrence transform')
                spec['occurrence'].transform2 = matrix
            if paths:
                path = paths[pose['index']]
                if path.exists():
                    raise ValueError('Frame target appeared during rendering; refusing overwrite')
                _cad_require_result(viewport.saveAsImageFile(str(path), width, height), 'Save explode frame')
                if not path.is_file() or path.stat().st_size == 0:
                    raise RuntimeError('Frame export returned no nonempty file')
                frames.append(str(path))
    except Exception as exc:
        error = type(exc).__name__ + ': ' + str(exc)
    finally:
        if restore:
            for spec in reversed(specs):
                try:
                    matrix = adsk.core.Matrix3D.create()
                    _cad_require_result(matrix.setWithArray(list(original[id(spec['occurrence'])])),
                                        'Restore occurrence transform')
                    spec['occurrence'].transform2 = matrix
                except Exception as exc:
                    restore_errors.append('occurrence restore: ' + type(exc).__name__ + ': ' + str(exc))
            for spec in specs:
                try:
                    actual = spec['occurrence'].transform2.asArray()
                    if any(abs(actual[i] - original[id(spec['occurrence'])][i]) > 1e-9 for i in range(16)):
                        restore_errors.append('Restored transform differs from original for ' + str(spec['ref']))
                except Exception as exc:
                    restore_errors.append('occurrence verification: ' + str(exc))
    restored = not restore_errors if restore else None
    result = dict(plan)
    result.update(frameFiles=frames, error=error, restoreRequested=restore, restored=restored,
                  restoreErrors=restore_errors)
    status = 'pass' if (error is None and (restore is False or restored)) else 'fail'
    return _explode_contract(ctx, 'explode.render', result, status=status, read_only=False)


def _ref_key(ref):
    if isinstance(ref, dict):
        return ref.get('token') or ref.get('name') or str(ref)
    return str(ref)


CAD_HANDLERS.update({'explode.plan': explode_plan, 'explode.render': explode_render})
