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
import math as _explode_adapter_math

if _CAD_TYPE_CHECKING:
    from typing import NotRequired as _ExplodeNotRequired

    class _ExplodeSpec(_CadTypedDict):
        occurrence: adsk.fusion.Occurrence
        ref: JsonValue
        axis: list[float]
        distance: float
        phase: JsonValue
        label: JsonValue
        position: int
        origin: list[float]
        phaseIndex: _ExplodeNotRequired[int]

    class _ExplodePlannedSpec(_CadTypedDict):
        occurrence: adsk.fusion.Occurrence
        ref: JsonValue
        axis: list[float]
        distance: float
        phase: str
        label: JsonValue
        position: int
        origin: list[float]
        phaseIndex: int

    class _ExplodePathStat(_Protocol):
        @property
        def st_size(self) -> int: ...

    class _ExplodePath(_Protocol):
        @property
        def parent(self) -> "_ExplodePath": ...

        @property
        def suffix(self) -> str: ...

        def is_absolute(self) -> bool: ...

        def is_dir(self) -> bool: ...

        def resolve(self) -> "_ExplodePath": ...

        def exists(self) -> bool: ...

        def is_symlink(self) -> bool: ...

        def is_file(self) -> bool: ...

        def stat(self) -> _ExplodePathStat: ...

        def __truediv__(self, part: str, /) -> "_ExplodePath": ...

        def __str__(self) -> str: ...


def _explode_contract(ctx: "CadContext", operation: str, result: "JsonRecord",
                      status: str = 'pass', read_only: bool = True) -> "JsonRecord":
    identity = None
    if hasattr(ctx, 'doc') and getattr(getattr(ctx, 'doc', None), 'name', None) is not None:
        identity = {'creationId': getattr(ctx.doc, 'creationId', None), 'name': ctx.doc.name}
    component = None
    if hasattr(ctx, 'component') and hasattr(ctx, 'ref'):
        try:
            component = ctx.ref(ctx.component)
        except Exception:
            component = None
    out: JsonRecord = dict(schemaVersion=1, operation=operation, status=status, success=status == 'pass',
               documentIdentity=identity, units={'length': 'cm', 'time': 's'},
               frame={'space': 'root', 'component': component},
               associativity='snapshot' if read_only else 'recipeRegeneration',
               method='GM36 deterministic explode plan/render over occurrence instances',
               provenance={'requirement': 'GM36', 'source': 'docs/EXPLODE_ANIMATION.md'})
    out['warnings'] = list(_cad_cast("Sequence[JsonValue]", result.pop('warnings', [])))
    out['limitations'] = _EXPLODE_LIMITS + list(_cad_cast("Sequence[str]", result.pop('limitations', [])))
    out['affected'] = list(_cad_cast("Sequence[JsonValue]", result.pop('affected', [])))
    out.update(result)
    return out


def _explode_origin(occurrence: "adsk.fusion.Occurrence") -> "list[float]":
    matrix = occurrence.transform2.asArray()
    return [float(matrix[3]), float(matrix[7]), float(matrix[11])]


def _explode_specs(ctx: "CadContext", occurrences: "JsonValue") -> "list[_ExplodeSpec]":
    if not isinstance(occurrences, list) or not occurrences:
        raise ValueError('occurrences must be a nonempty array')
    occurrence_values = _cad_cast("Sequence[JsonValue]", occurrences)
    specs: list[_ExplodeSpec] = []
    seen: set[object] = set()
    for position, spec_value in enumerate(occurrence_values):
        if not isinstance(spec_value, dict) or 'ref' not in spec_value:
            raise ValueError('occurrence entries require a ref')
        spec = spec_value
        if 'axis' not in spec or 'distance' not in spec:
            raise ValueError('occurrence entries require axis and distance')
        occurrence = ctx.resolve(spec['ref'], 'occurrence')
        key = _explode_ref_key(ctx.ref(occurrence))
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


def _explode_plan_model(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    specs = _explode_specs(ctx, data['occurrences'])
    duration = _explode_seconds(data['duration'])
    fps_value = data['fps']
    if type(fps_value) is not int or fps_value < 1:
        raise ValueError('fps must be a positive integer')
    fps = fps_value
    easing = _cad_cast(str, data.get('easing', 'linear'))
    if easing not in _EXPLODE_EASINGS:
        raise ValueError('easing must be one of: ' + ', '.join(_EXPLODE_EASINGS))

    phases_value = data.get('phases', [])
    if not isinstance(phases_value, list):
        raise ValueError('phases must be an array of names')
    phases = _cad_cast("Sequence[JsonValue]", phases_value)
    phase_names: list[str] = []
    for phase in phases:
        if not isinstance(phase, str) or not phase.strip():
            raise ValueError('phases entries must be nonempty names')
        if phase in phase_names:
            raise ValueError('duplicate phase name: ' + phase)
        phase_names.append(phase)
    if not phase_names:
        phase_names = ['explode']
    phase_index: dict[str, int] = {name: i for i, name in enumerate(phase_names)}
    planned_specs: list[_ExplodePlannedSpec] = []
    for spec in specs:
        phase = _cad_cast(str, spec['phase']) if spec['phase'] is not None else phase_names[-1]
        if spec['phase'] is not None and phase not in phase_names:
            raise ValueError('occurrence phase references an unknown phase: ' + phase)
        spec['phase'] = phase
        spec['phaseIndex'] = phase_index[phase]
        planned_specs.append(_cad_cast("_ExplodePlannedSpec", spec))

    by_key: dict[object, _ExplodePlannedSpec] = {
        _explode_ref_key(spec['ref']): spec for spec in planned_specs}
    disconnection_values = data.get('disconnections', [])
    if not isinstance(disconnection_values, list):
        raise ValueError('disconnections must be an array')
    disconnections = _cad_cast("Sequence[JsonValue]", disconnection_values)
    edges: list[tuple[object, object, JsonValue, JsonValue, JsonValue]] = []
    for disc_value in disconnections:
        if not isinstance(disc_value, dict) or 'from' not in disc_value or 'to' not in disc_value:
            raise ValueError('disconnections entries require from and to occurrence refs')
        disc = disc_value
        source = ctx.resolve(disc['from'], 'occurrence')
        target = ctx.resolve(disc['to'], 'occurrence')
        source_key = _explode_ref_key(ctx.ref(source))
        target_key = _explode_ref_key(ctx.ref(target))
        if source_key not in by_key or target_key not in by_key:
            raise ValueError('disconnection references an occurrence not listed in occurrences')
        edges.append((source_key, target_key, disc.get('name'), ctx.ref(source), ctx.ref(target)))

    blockers: list[JsonRecord] = [{'from': sref, 'to': tref, 'name': name,
                 'message': 'disconnected-from occurrence must explode in an earlier phase'}
                for source, target, name, sref, tref in edges
                if by_key[source]['phaseIndex'] >= by_key[target]['phaseIndex']]

    adjacency: dict[object, list[object]] = {
        _explode_ref_key(spec['ref']): [] for spec in planned_specs}
    for source, target, _name, _sref, _tref in edges:
        adjacency[source].append(target)
    visited: set[object] = set()
    visiting: set[object] = set()
    cycles: list[str] = []

    def visit(node: object, stack: list[object]) -> None:
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

    for spec in planned_specs:
        visit(_explode_ref_key(spec['ref']), [])

    order: list[_ExplodePlannedSpec] = sorted(
        planned_specs, key=lambda spec: (spec['phaseIndex'], spec['position']))
    order_rows: list[JsonRecord] = [{'ref': spec['ref'], 'label': spec['label'], 'phase': spec['phase'],
                   'phaseIndex': spec['phaseIndex']} for spec in order]

    frame_count = int(_explode_adapter_math.floor(duration * fps)) + 1
    if frame_count < 2:
        raise ValueError('duration * fps must span at least one frame interval')
    phase_span = duration / len(phase_names)
    phase_schedule: list[JsonRecord] = [{'name': name, 'startTime': round(i * phase_span, 9),
                       'endTime': round((i + 1) * phase_span, 9),
                       'frameStart': int(i * phase_span * fps),
                       'frameEnd': min(frame_count - 1, int(_explode_adapter_math.ceil((i + 1) * phase_span * fps)))}
                      for i, name in enumerate(phase_names)]

    poses: list[JsonRecord] = []
    trails: list[JsonRecord] = []
    pose_origins: list[list[list[float]]] = []
    for index in range(frame_count):
        time = index / fps
        rows: list[JsonRecord] = []
        frame_origins: list[list[float]] = []
        for spec in planned_specs:
            start = spec['phaseIndex'] * phase_span
            local = max(0.0, min(1.0, (time - start) / phase_span))
            fraction = _explode_ease(easing, local)
            origin: list[float] = [spec['origin'][i] + spec['axis'][i] * spec['distance'] * fraction
                                   for i in range(3)]
            frame_origins.append([round(value, 9) for value in origin])
            rows.append({'ref': spec['ref'], 'label': spec['label'], 'phase': spec['phase'],
                         'origin': [round(v, 9) for v in origin], 'axis': spec['axis'],
                         'distance': spec['distance'], 'fraction': round(fraction, 9)})
        pose_origins.append(frame_origins)
        poses.append({'index': index, 'timeSeconds': round(time, 9), 'occurrences': rows})

    for spec in order:
        final = [spec['origin'][i] + spec['axis'][i] * spec['distance'] for i in range(3)]
        trails.append({'ref': spec['ref'], 'label': spec['label'],
                        'points': [frame[spec['position']] for frame in pose_origins]})

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


def explode_plan(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('schemaVersion', 'occurrences', 'duration', 'fps'),
                ('phases', 'disconnections', 'easing', 'frame'))
    _explode_version(data)
    result = _explode_plan_model(ctx, data)
    ok = not result['blockers'] and not result['cycles']
    return _explode_contract(ctx, 'explode.plan', result, status='pass' if ok else 'fail', read_only=True)


def _explode_frame_paths(data: "JsonObject", count: int) -> "list[_ExplodePath]":
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
    file_values = _cad_cast("Sequence[JsonValue]", files)
    paths: list[_ExplodePath] = []
    seen: set[str] = set()
    for value in file_values:
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


def explode_render(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('schemaVersion', 'occurrences', 'duration', 'fps', 'confirm'),
                ('phases', 'disconnections', 'easing', 'frame', 'restore',
                 'frameFiles', 'directory', 'prefix', 'width', 'height'))
    _explode_version(data)
    ctx.require_confirm(data)
    restore = data.get('restore', True)
    if type(restore) is not bool:
        raise ValueError('restore must be boolean')
    width_value, height_value = data.get('width', 1280), data.get('height', 720)
    if any(type(v) is not int or not 32 <= v <= 4096 for v in (width_value, height_value)):
        raise ValueError('Image dimensions must be integers in 32..4096')
    width, height = _cad_cast(int, width_value), _cad_cast(int, height_value)
    plan = _explode_plan_model(ctx, data)
    paths = _explode_frame_paths(data, _cad_cast(int, plan['frameCount']))
    if not paths and any(k in data for k in ('width', 'height')):
        raise ValueError('Image dimensions require frame targets')
    viewport = _cad_cast("adsk.core.Viewport | None", getattr(ctx.app, 'activeViewport', None))
    if paths and (viewport is None or getattr(viewport, 'parentDocument', ctx.doc) != ctx.doc):
        raise ValueError('Active viewport must belong to the target document for frame capture')

    specs = _explode_specs(ctx, data['occurrences'])
    by_ref: dict[object, _ExplodeSpec] = {}
    for spec in specs:
        by_ref[_explode_ref_key(spec['ref'])] = spec
    original: dict[int, list[float]] = {
        id(spec['occurrence']): list(spec['occurrence'].transform2.asArray()) for spec in specs}
    frames: list[str] = []
    error: str | None = None
    restore_errors: list[str] = []
    try:
        for pose in _cad_cast("Sequence[JsonObject]", plan['poses']):
            pose_rows = _cad_cast("Sequence[JsonObject]", pose['occurrences'])
            for row in pose_rows:
                spec = by_ref[_explode_ref_key(row['ref'])]
                matrix = adsk.core.Matrix3D.create()
                cells = list(original[id(spec['occurrence'])])
                origin = _cad_cast("Sequence[int | float]", row['origin'])
                cells[3], cells[7], cells[11] = origin[0], origin[1], origin[2]
                _cad_require_result(matrix.setWithArray(cells), 'Explode occurrence transform')
                spec['occurrence'].transform2 = matrix
            if paths:
                path = paths[_cad_cast(int, pose['index'])]
                if path.exists():
                    raise ValueError('Frame target appeared during rendering; refusing overwrite')
                frame_viewport = _cad_cast("adsk.core.Viewport", viewport)
                _cad_require_result(frame_viewport.saveAsImageFile(str(path), width, height), 'Save explode frame')
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
    result: JsonRecord = dict(plan)
    result.update(frameFiles=frames, error=error, restoreRequested=restore, restored=restored,
                  restoreErrors=restore_errors)
    status = 'pass' if (error is None and (restore is False or restored)) else 'fail'
    return _explode_contract(ctx, 'explode.render', result, status=status, read_only=False)


CAD_HANDLERS.update({'explode.plan': explode_plan, 'explode.render': explode_render})
