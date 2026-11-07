"""GM36: deterministic animation sequencing and film export.

``animation.sequence`` plans a presentation timeline over declared tracks
(camera, visibility, section, joint and occurrence) with an easing law,
timing and fps, producing a deterministic frame manifest. It is read-only:
nothing is mutated, no native storyboard action is authored. ``animation.export``
encodes already-rendered frame files into a film through a declared encoder;
with no declared (or unavailable) encoder it returns ``blocked`` and writes no
fake video file. Native storyboard action authoring is separate from playback
and is never claimed here.
"""
import math as _anim2_adapter_math
import os as _anim2_os
import shutil as _anim2_shutil
import subprocess as _anim2_subprocess
import tempfile as _anim2_tempfile


if _CAD_TYPE_CHECKING:
    class _Anim2Vector(_Protocol):
        @property
        def x(self) -> float: ...

        @property
        def y(self) -> float: ...

        @property
        def z(self) -> float: ...

    class _Anim2CameraState(_CadTypedDict):
        eye: list[float]
        target: list[float]
        up: list[float]

    class _Anim2CameraTrack(_CadTypedDict):
        type: Literal['camera']
        phase: int
        start: _Anim2CameraState
        end: _Anim2CameraState

    class _Anim2JointTrack(_CadTypedDict):
        type: Literal['joint']
        phase: int
        ref: JsonValue
        axes: dict[str, tuple[float, float]]
        rotation: bool
        slide: bool

    class _Anim2OccurrenceTrack(_CadTypedDict):
        type: Literal['occurrence']
        phase: int
        ref: JsonValue
        origin: list[float]
        axis: list[float]
        distance: float

    _Anim2ContinuousTrack: TypeAlias = _Anim2CameraTrack | _Anim2JointTrack | _Anim2OccurrenceTrack

    class _Anim2VisibilityTrack(_CadTypedDict):
        type: Literal['visibility']
        phase: int
        ref: JsonValue
        visible: bool

    class _Anim2SectionTrack(_CadTypedDict):
        type: Literal['section']
        phase: int
        name: str
        isLightBulbOn: bool

    _Anim2DiscreteTrack: TypeAlias = _Anim2VisibilityTrack | _Anim2SectionTrack

def _anim2_contract(ctx: "CadContext", operation: str, result: "JsonRecord",
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
               documentIdentity=identity, units={'length': 'cm', 'angle': 'rad', 'time': 's'},
               frame={'space': 'root', 'component': component},
               associativity='snapshot' if read_only else 'recipeRegeneration',
               method='GM36 deterministic animation sequence/film export',
               provenance={'requirement': 'GM36', 'source': 'docs/EXPLODE_ANIMATION.md'})
    out['warnings'] = list(_cad_cast("Sequence[JsonValue]", result.pop('warnings', [])))
    out['limitations'] = _ANIM2_LIMITS + list(_cad_cast("Sequence[str]", result.pop('limitations', [])))
    out['affected'] = list(_cad_cast("Sequence[JsonValue]", result.pop('affected', [])))
    out.update(result)
    return out


def _anim2_point(ctx: "CadContext", value: "JsonValue") -> "list[float]":
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError('camera eye/target require three length expressions')
    point = ctx.point(value)
    if isinstance(point, (list, tuple)):
        coordinates = _cad_cast("Sequence[JsonValue]", point)
        return [float(_cad_cast("int | float | str | bool", v)) for v in coordinates]
    vector = _cad_cast("_Anim2Vector", point)
    return [vector.x, vector.y, vector.z]


def animation_sequence(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('schemaVersion', 'tracks', 'duration', 'fps'),
                ('phases', 'easing', 'frame'))
    _anim2_version(data)
    tracks_value = data['tracks']
    if not isinstance(tracks_value, list) or not tracks_value:
        raise ValueError('tracks must be a nonempty array')
    tracks = _cad_cast("Sequence[JsonValue]", tracks_value)
    duration = _anim2_seconds(data['duration'])
    fps_value = data['fps']
    if type(fps_value) is not int or fps_value < 1:
        raise ValueError('fps must be a positive integer')
    fps = fps_value
    easing = _cad_cast(str, data.get('easing', 'linear'))
    if easing not in _ANIM2_EASINGS:
        raise ValueError('easing must be one of: ' + ', '.join(_ANIM2_EASINGS))
    phase_names = _anim2_phases(data)
    phase_index: dict[str, int] = {name: i for i, name in enumerate(phase_names)}
    frame_count, phase_span, schedule = _anim2_timing(duration, fps, phase_names)

    continuous: list[_Anim2ContinuousTrack] = []
    discrete: list[_Anim2DiscreteTrack] = []
    for track_value in tracks:
        if not isinstance(track_value, dict) or 'type' not in track_value:
            raise ValueError('tracks entries require a type')
        track = track_value
        kind = _cad_cast(str, track['type'])
        if kind not in _ANIM2_TRACK_TYPES:
            raise ValueError('track type must be one of: ' + ', '.join(_ANIM2_TRACK_TYPES))
        phase = _cad_cast(str, track.get('phase', phase_names[-1]))
        if phase not in phase_names:
            raise ValueError('track phase references an unknown phase: ' + phase)
        phase_idx = phase_index[phase]
        if kind == 'camera':
            for key in ('from', 'to'):
                camera_value = track.get(key)
                if not isinstance(camera_value, dict):
                    raise ValueError('camera tracks require from and to states')
                camera_state = camera_value
                for field in ('eye', 'target'):
                    if field not in camera_state:
                        raise ValueError('camera ' + key + ' requires eye and target')
                if 'up' not in camera_state:
                    raise ValueError('camera ' + key + ' requires up')
            start_value = _cad_cast("JsonObject", track['from'])
            end_value = _cad_cast("JsonObject", track['to'])
            start: _Anim2CameraState = {
                'eye': _anim2_point(ctx, start_value['eye']),
                'target': _anim2_point(ctx, start_value['target']),
                'up': _anim2_direction(start_value['up'])}
            end: _Anim2CameraState = {
                'eye': _anim2_point(ctx, end_value['eye']),
                'target': _anim2_point(ctx, end_value['target']),
                'up': _anim2_direction(end_value['up'])}
            continuous.append({'type': 'camera', 'phase': phase_idx, 'start': start, 'end': end})
        elif kind == 'joint':
            if 'ref' not in track:
                raise ValueError('joint tracks require a ref')
            axes: dict[str, tuple[float, float]] = {}
            if 'rotation' in track:
                rotation_range = _anim2_range(track['rotation'], 'rotation')
                axes['rotation'] = (ctx.angle(rotation_range['from']), ctx.angle(rotation_range['to']))
            if 'slide' in track:
                slide_range = _anim2_range(track['slide'], 'slide')
                axes['slide'] = (ctx.length(slide_range['from']), ctx.length(slide_range['to']))
            if not axes:
                raise ValueError('joint tracks require rotation and/or slide ranges')
            continuous.append({'type': 'joint', 'phase': phase_idx, 'ref': track['ref'],
                               'axes': axes, 'rotation': 'rotation' in axes, 'slide': 'slide' in axes})
        elif kind == 'occurrence':
            if 'ref' not in track or 'axis' not in track or 'distance' not in track:
                raise ValueError('occurrence tracks require ref, axis and distance')
            occurrence = ctx.resolve(track['ref'], 'occurrence')
            matrix = occurrence.transform2.asArray()
            origin = [float(matrix[3]), float(matrix[7]), float(matrix[11])]
            axis = _anim2_direction(track['axis'])
            distance = ctx.length(track['distance'])
            if distance < 0:
                raise ValueError('distance must be nonnegative')
            continuous.append({'type': 'occurrence', 'phase': phase_idx, 'ref': ctx.ref(occurrence),
                               'origin': origin, 'axis': axis, 'distance': distance})
        elif kind == 'visibility':
            if 'ref' not in track or 'visible' not in track or type(track['visible']) is not bool:
                raise ValueError('visibility tracks require ref and a boolean visible')
            visibility_track: _Anim2VisibilityTrack = {
                'type': 'visibility', 'phase': phase_idx, 'ref': track['ref'],
                'visible': track['visible']}
            discrete.append(visibility_track)
        else:  # section
            if 'name' not in track or 'isLightBulbOn' not in track or type(track['isLightBulbOn']) is not bool:
                raise ValueError('section tracks require name and a boolean isLightBulbOn')
            section_track: _Anim2SectionTrack = {
                'type': 'section', 'phase': phase_idx, 'name': _cad_cast(str, track['name']),
                'isLightBulbOn': track['isLightBulbOn']}
            discrete.append(section_track)

    frames: list[JsonRecord] = []
    visibility_state: dict[str, bool] = {}
    section_state: dict[str, bool] = {}
    for index in range(frame_count):
        time = index / fps
        camera: _Anim2CameraState | None = None
        joints: dict[str, JsonRecord] = {}
        occurrences: dict[str, list[float]] = {}
        for track in continuous:
            local = max(0.0, min(1.0, (time - track['phase'] * phase_span) / phase_span))
            fraction = _anim2_ease(easing, local)
            if track['type'] == 'camera':
                camera = {'eye': [round(v, 9) for v in _anim2_lerp(track['start']['eye'], track['end']['eye'], fraction)],
                          'target': [round(v, 9) for v in _anim2_lerp(track['start']['target'], track['end']['target'], fraction)],
                          'up': [round(v, 9) for v in _anim2_lerp(track['start']['up'], track['end']['up'], fraction)]}
            elif track['type'] == 'joint':
                joint: JsonRecord = {}
                if 'rotation' in track['axes']:
                    joint['rotation'] = round(track['axes']['rotation'][0] * (1 - fraction) + track['axes']['rotation'][1] * fraction, 9)
                if 'slide' in track['axes']:
                    joint['slide'] = round(track['axes']['slide'][0] * (1 - fraction) + track['axes']['slide'][1] * fraction, 9)
                joints[_anim2_ref_key(track['ref'])] = joint
            else:  # occurrence
                origin = [track['origin'][i] + track['axis'][i] * track['distance'] * fraction for i in range(3)]
                occurrences[_anim2_ref_key(track['ref'])] = [round(v, 9) for v in origin]
        for track in discrete:
            if index >= track['phase'] * phase_span * fps:
                if track['type'] == 'visibility':
                    visibility_state[_anim2_ref_key(track['ref'])] = track['visible']
                else:
                    section_state[track['name']] = track['isLightBulbOn']
        frame: JsonRecord = {'index': index, 'timeSeconds': round(time, 9),
                             'camera': _cad_cast("JsonValue", camera),
                             'joints': joints, 'occurrences': occurrences,
                             'visibility': dict(visibility_state), 'sections': dict(section_state)}
        frames.append(frame)

    return _anim2_contract(ctx, 'animation.sequence', {
        'frameCount': frame_count, 'durationSeconds': round(duration, 9), 'fps': fps,
        'frameDurationSeconds': round(1.0 / fps, 9), 'easing': easing,
        'phaseSchedule': schedule, 'frames': frames,
        'trackCount': len(tracks), 'nativeStoryboardActionsCreated': False,
        'affected': []}, status='pass', read_only=True)


def _anim2_resolve_program(program: str) -> "str | None":
    if _anim2_os.path.isabs(program) and _anim2_os.path.isfile(program) and _anim2_os.access(program, _anim2_os.X_OK):
        return program
    return _anim2_shutil.which(program)


def _anim2_frame_paths(frames: "JsonValue") -> "list[str]":
    if not isinstance(frames, list) or not frames:
        raise ValueError('frames must be a nonempty array of existing frame paths')
    frame_values = _cad_cast("Sequence[JsonValue]", frames)
    paths: list[str] = []
    for value in frame_values:
        if not isinstance(value, str) or not value.strip():
            raise ValueError('frames entries must be paths')
        if not _anim2_os.path.isfile(value):
            raise ValueError('frame does not exist: ' + value)
        if not value.lower().endswith('.png'):
            raise ValueError('frames must be PNG files: ' + value)
        paths.append(value)
    return paths


def animation_export(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('schemaVersion', 'frames', 'output', 'confirm'),
                ('encoder', 'fps', 'frame'))
    _anim2_version(data)
    ctx.require_confirm(data)
    frames = _anim2_frame_paths(data['frames'])
    output_value = data['output']
    if not isinstance(output_value, str) or not output_value.strip():
        raise ValueError('output must be a nonempty film path')
    output = output_value
    if _anim2_os.path.exists(output):
        raise ValueError('output already exists; overwriting is not supported')
    output_dir = _anim2_os.path.dirname(_anim2_os.path.abspath(output))
    if not _anim2_os.path.isdir(output_dir):
        raise ValueError('output parent directory does not exist')

    fps_value = data.get('fps')
    if fps_value is not None and (type(fps_value) is not int or fps_value < 1):
        raise ValueError('fps must be a positive integer')
    fps: int | None = fps_value

    encoder_value = data.get('encoder')
    if encoder_value is None:
        return _anim2_contract(ctx, 'animation.export', {
            'film': None, 'frameCount': len(frames), 'encoder': None,
            'reason': 'No encoder was declared; no video file was produced.',
            'fileWritten': False, 'playable': False,
            'limitations': ['Without a declared encoder no film file is written; a fake or empty video is never produced.'],
            'affected': []}, status='blocked', read_only=False)

    if not isinstance(encoder_value, dict) or 'name' not in encoder_value:
        raise ValueError('encoder requires a name')
    encoder = encoder_value
    name = encoder['name']
    if not isinstance(name, str) or not name.strip():
        raise ValueError('encoder.name must be nonempty')
    argv: list[str]
    concat_file: str | None = None
    if name == 'ffmpeg':
        if fps is None:
            raise ValueError('ffmpeg encoder requires fps')
        program = _anim2_resolve_program(_cad_cast(str, encoder.get('program', 'ffmpeg')))
        if program is None:
            return _anim2_contract(ctx, 'animation.export', {
                'film': None, 'frameCount': len(frames), 'encoder': {'name': name},
                'reason': 'ffmpeg executable was not found; no video file was produced.',
                'fileWritten': False, 'playable': False, 'affected': []},
                status='blocked', read_only=False)
        argv, concat_file = _anim2_ffmpeg_argv(program, frames, output, fps)
    else:
        command = encoder.get('command')
        if isinstance(command, list):
            argv = list(_cad_cast("Sequence[str]", command)) + list(frames) + [output]
        else:
            program = _anim2_resolve_program(_cad_cast(str, encoder.get('program', name)))
            if program is None:
                return _anim2_contract(ctx, 'animation.export', {
                    'film': None, 'frameCount': len(frames), 'encoder': {'name': name},
                    'reason': 'encoder executable was not found; no video file was produced.',
                    'fileWritten': False, 'playable': False, 'affected': []},
                    status='blocked', read_only=False)
            argv = [program] + list(_cad_cast("Sequence[str]", encoder.get('arguments', []))) + list(frames) + [output]
    try:
        result = _anim2_subprocess.run(argv, capture_output=True, text=True)
        if result.returncode != 0:
            return _anim2_contract(ctx, 'animation.export', {
                'film': None, 'frameCount': len(frames), 'encoder': {'name': name},
                'reason': 'encoder exited nonzero', 'stderr': result.stderr,
                'fileWritten': False, 'playable': False, 'affected': []},
                status='fail', read_only=False)
        if not _anim2_os.path.isfile(output) or _anim2_os.path.getsize(output) == 0:
            return _anim2_contract(ctx, 'animation.export', {
                'film': None, 'frameCount': len(frames), 'encoder': {'name': name},
                'reason': 'encoder produced no nonempty film file',
                'fileWritten': False, 'playable': False, 'affected': []},
                status='fail', read_only=False)
    except FileNotFoundError as exc:
        return _anim2_contract(ctx, 'animation.export', {
            'film': None, 'frameCount': len(frames), 'encoder': {'name': name},
            'reason': 'encoder executable not found', 'fileWritten': False,
            'playable': False, 'affected': []},
            status='blocked', read_only=False)
    finally:
        if concat_file is not None:
            try:
                _anim2_os.unlink(concat_file)
            except OSError:
                pass
    duration = round(len(frames) / fps, 9) if fps else None
    return _anim2_contract(ctx, 'animation.export', {
        'film': output, 'frameCount': len(frames), 'encoder': {'name': name},
        'fps': fps, 'durationSeconds': duration, 'fileWritten': True,
         'playable': _anim2_os.path.isfile(output) and _anim2_os.path.getsize(output) > 0,
        'affected': []}, status='pass', read_only=False)


CAD_HANDLERS.update({'animation.sequence': animation_sequence, 'animation.export': animation_export})


def _anim2_ffmpeg_argv(program: str, frames: "Sequence[str]", output: str,
                       fps: int) -> "tuple[list[str], str]":
    handle = _anim2_tempfile.NamedTemporaryFile(mode='w', prefix='.fmcad-frames-', suffix='.txt', delete=False)
    concat_file = handle.name
    try:
        for path in frames:
            handle.write("file '" + path.replace("'", "'\\''") + "'\n")
    finally:
        handle.close()
    argv: list[str] = [program, '-y', '-framerate', str(fps), '-f', 'concat', '-safe', '0',
            '-i', concat_file, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', output]
    return argv, concat_file
