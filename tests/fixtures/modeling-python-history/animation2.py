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
import math
import os
import shutil
import subprocess
import tempfile

import adsk.core
import adsk.fusion


_ANIM2_EASINGS = ('linear', 'smoothstep', 'easeIn', 'easeOut', 'easeInOut')
_ANIM2_TRACK_TYPES = ('camera', 'visibility', 'section', 'joint', 'occurrence')
_ANIM2_LIMITS = [
    'The sequence is a deterministic evaluated frame manifest, not a native storyboard action sequence.',
    'Native storyboard action authoring is separate from playback and is never claimed here.',
    'Film export runs the declared encoder on the Fusion machine; no fake video file is produced without one.',
    'Camera/visibility/section values are interpolated or stepped plan data, not a rendered-view equivalence proof.',
]


def _anim2_contract(ctx, operation, result, status='pass', read_only=True):
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
               documentIdentity=identity, units={'length': 'cm', 'angle': 'rad', 'time': 's'},
               frame={'space': 'root', 'component': component},
               associativity='snapshot' if read_only else 'recipeRegeneration',
               method='GM36 deterministic animation sequence/film export',
               provenance={'requirement': 'GM36', 'source': 'docs/EXPLODE_ANIMATION.md'})
    out['warnings'] = list(result.pop('warnings', []))
    out['limitations'] = _ANIM2_LIMITS + list(result.pop('limitations', []))
    out['affected'] = list(result.pop('affected', []))
    out.update(result)
    return out


def _anim2_number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(label + ' must be a finite number')
    return float(value)


def _anim2_seconds(value):
    if isinstance(value, str):
        parts = value.strip().split()
        if len(parts) != 2:
            raise ValueError('duration must be a finite positive number of seconds or "<n> s"/"<n> ms"')
        number, unit = _anim2_number(float(parts[0]), 'duration'), parts[1]
        seconds = number if unit == 's' else number / 1000.0 if unit == 'ms' else None
        if seconds is None:
            raise ValueError('duration unit must be s or ms')
    else:
        seconds = _anim2_number(value, 'duration')
    if seconds <= 0:
        raise ValueError('duration must be positive')
    return seconds


def _anim2_direction(value):
    if not isinstance(value, (list, tuple)) or len(value) != 3 or any(
            isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in value):
        raise ValueError('axis must be three finite unitless numbers')
    norm = math.hypot(*value)
    if norm == 0:
        raise ValueError('axis cannot be zero')
    return [x / norm for x in value]


def _anim2_ease(name, t):
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
    raise ValueError('easing must be one of: ' + ', '.join(_ANIM2_EASINGS))


def _anim2_point(ctx, value):
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError('camera eye/target require three length expressions')
    point = ctx.point(value)
    if isinstance(point, (list, tuple)):
        return [float(v) for v in point]
    return [float(point.x), float(point.y), float(point.z)]


def _anim2_version(data):
    if data.get('schemaVersion') != 1:
        raise ValueError('GM36 animation operations require schemaVersion:1')


def _anim2_lerp(a, b, t):
    return [a[i] + (b[i] - a[i]) * t for i in range(3)]


def _anim2_phases(data):
    phases = data.get('phases', [])
    if not isinstance(phases, list):
        raise ValueError('phases must be an array of names')
    names = []
    for phase in phases:
        if not isinstance(phase, str) or not phase.strip():
            raise ValueError('phases entries must be nonempty names')
        if phase in names:
            raise ValueError('duplicate phase name: ' + phase)
        names.append(phase)
    return names if names else ['sequence']


def _anim2_timing(duration, fps, phase_names):
    frame_count = int(math.floor(duration * fps)) + 1
    if frame_count < 2:
        raise ValueError('duration * fps must span at least one frame interval')
    phase_span = duration / len(phase_names)
    schedule = [{'name': name, 'startTime': round(i * phase_span, 9),
                 'endTime': round((i + 1) * phase_span, 9),
                 'frameStart': int(i * phase_span * fps),
                 'frameEnd': min(frame_count - 1, int(math.ceil((i + 1) * phase_span * fps)))}
                for i, name in enumerate(phase_names)]
    return frame_count, phase_span, schedule


def animation_sequence(ctx, data):
    _cad_fields(data, ('schemaVersion', 'tracks', 'duration', 'fps'),
                ('phases', 'easing', 'frame'))
    _anim2_version(data)
    tracks = data['tracks']
    if not isinstance(tracks, list) or not tracks:
        raise ValueError('tracks must be a nonempty array')
    duration = _anim2_seconds(data['duration'])
    fps = data['fps']
    if type(fps) is not int or fps < 1:
        raise ValueError('fps must be a positive integer')
    easing = data.get('easing', 'linear')
    if easing not in _ANIM2_EASINGS:
        raise ValueError('easing must be one of: ' + ', '.join(_ANIM2_EASINGS))
    phase_names = _anim2_phases(data)
    phase_index = {name: i for i, name in enumerate(phase_names)}
    frame_count, phase_span, schedule = _anim2_timing(duration, fps, phase_names)

    continuous, discrete = [], []
    for track in tracks:
        if not isinstance(track, dict) or 'type' not in track:
            raise ValueError('tracks entries require a type')
        kind = track['type']
        if kind not in _ANIM2_TRACK_TYPES:
            raise ValueError('track type must be one of: ' + ', '.join(_ANIM2_TRACK_TYPES))
        phase = track.get('phase', phase_names[-1])
        if phase not in phase_names:
            raise ValueError('track phase references an unknown phase: ' + phase)
        phase_idx = phase_index[phase]
        if kind == 'camera':
            for key in ('from', 'to'):
                if key not in track or not isinstance(track[key], dict):
                    raise ValueError('camera tracks require from and to states')
                for field in ('eye', 'target'):
                    if field not in track[key]:
                        raise ValueError('camera ' + key + ' requires eye and target')
                if 'up' not in track[key]:
                    raise ValueError('camera ' + key + ' requires up')
            start = {'eye': _anim2_point(ctx, track['from']['eye']),
                     'target': _anim2_point(ctx, track['from']['target']),
                     'up': _anim2_direction(track['from']['up'])}
            end = {'eye': _anim2_point(ctx, track['to']['eye']),
                   'target': _anim2_point(ctx, track['to']['target']),
                   'up': _anim2_direction(track['to']['up'])}
            continuous.append({'type': 'camera', 'phase': phase_idx, 'start': start, 'end': end})
        elif kind == 'joint':
            if 'ref' not in track:
                raise ValueError('joint tracks require a ref')
            axes = {}
            if 'rotation' in track:
                _anim2_range(track['rotation'], 'rotation')
                axes['rotation'] = (ctx.angle(track['rotation']['from']), ctx.angle(track['rotation']['to']))
            if 'slide' in track:
                _anim2_range(track['slide'], 'slide')
                axes['slide'] = (ctx.length(track['slide']['from']), ctx.length(track['slide']['to']))
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
            discrete.append({'type': 'visibility', 'phase': phase_idx, 'ref': track['ref'],
                             'visible': track['visible']})
        else:  # section
            if 'name' not in track or 'isLightBulbOn' not in track or type(track['isLightBulbOn']) is not bool:
                raise ValueError('section tracks require name and a boolean isLightBulbOn')
            discrete.append({'type': 'section', 'phase': phase_idx, 'name': track['name'],
                             'isLightBulbOn': track['isLightBulbOn']})

    frames = []
    visibility_state, section_state = {}, {}
    for index in range(frame_count):
        time = index / fps
        camera = None
        joints = {}
        occurrences = {}
        for track in continuous:
            local = max(0.0, min(1.0, (time - track['phase'] * phase_span) / phase_span))
            fraction = _anim2_ease(easing, local)
            if track['type'] == 'camera':
                camera = {'eye': [round(v, 9) for v in _anim2_lerp(track['start']['eye'], track['end']['eye'], fraction)],
                          'target': [round(v, 9) for v in _anim2_lerp(track['start']['target'], track['end']['target'], fraction)],
                          'up': [round(v, 9) for v in _anim2_lerp(track['start']['up'], track['end']['up'], fraction)]}
            elif track['type'] == 'joint':
                joint = {}
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
        frames.append({'index': index, 'timeSeconds': round(time, 9),
                       'camera': camera, 'joints': joints, 'occurrences': occurrences,
                       'visibility': dict(visibility_state), 'sections': dict(section_state)})

    return _anim2_contract(ctx, 'animation.sequence', {
        'frameCount': frame_count, 'durationSeconds': round(duration, 9), 'fps': fps,
        'frameDurationSeconds': round(1.0 / fps, 9), 'easing': easing,
        'phaseSchedule': schedule, 'frames': frames,
        'trackCount': len(tracks), 'nativeStoryboardActionsCreated': False,
        'affected': []}, status='pass', read_only=True)


def _anim2_range(value, label):
    if not isinstance(value, dict) or 'from' not in value or 'to' not in value:
        raise ValueError(label + ' requires from and to expressions')


def _anim2_ref_key(ref):
    if isinstance(ref, dict):
        return ref.get('token') or ref.get('name') or str(ref)
    return str(ref)


def _anim2_resolve_program(program):
    if os.path.isabs(program) and os.path.isfile(program) and os.access(program, os.X_OK):
        return program
    return shutil.which(program)


def _anim2_frame_paths(frames):
    if not isinstance(frames, list) or not frames:
        raise ValueError('frames must be a nonempty array of existing frame paths')
    paths = []
    for value in frames:
        if not isinstance(value, str) or not value.strip():
            raise ValueError('frames entries must be paths')
        if not os.path.isfile(value):
            raise ValueError('frame does not exist: ' + value)
        if not value.lower().endswith('.png'):
            raise ValueError('frames must be PNG files: ' + value)
        paths.append(value)
    return paths


def animation_export(ctx, data):
    _cad_fields(data, ('schemaVersion', 'frames', 'output', 'confirm'),
                ('encoder', 'fps', 'frame'))
    _anim2_version(data)
    ctx.require_confirm(data)
    frames = _anim2_frame_paths(data['frames'])
    output = data['output']
    if not isinstance(output, str) or not output.strip():
        raise ValueError('output must be a nonempty film path')
    if os.path.exists(output):
        raise ValueError('output already exists; overwriting is not supported')
    output_dir = os.path.dirname(os.path.abspath(output))
    if not os.path.isdir(output_dir):
        raise ValueError('output parent directory does not exist')

    encoder = data.get('encoder')
    fps = data.get('fps')
    if fps is not None and (type(fps) is not int or fps < 1):
        raise ValueError('fps must be a positive integer')

    if encoder is None:
        return _anim2_contract(ctx, 'animation.export', {
            'film': None, 'frameCount': len(frames), 'encoder': None,
            'reason': 'No encoder was declared; no video file was produced.',
            'fileWritten': False, 'playable': False,
            'limitations': ['Without a declared encoder no film file is written; a fake or empty video is never produced.'],
            'affected': []}, status='blocked', read_only=False)

    if not isinstance(encoder, dict) or 'name' not in encoder:
        raise ValueError('encoder requires a name')
    name = encoder['name']
    if not isinstance(name, str) or not name.strip():
        raise ValueError('encoder.name must be nonempty')
    if name == 'ffmpeg':
        if fps is None:
            raise ValueError('ffmpeg encoder requires fps')
        program = _anim2_resolve_program(encoder.get('program', 'ffmpeg'))
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
            argv = list(command) + list(frames) + [output]
            concat_file = None
        else:
            program = _anim2_resolve_program(encoder.get('program', name))
            if program is None:
                return _anim2_contract(ctx, 'animation.export', {
                    'film': None, 'frameCount': len(frames), 'encoder': {'name': name},
                    'reason': 'encoder executable was not found; no video file was produced.',
                    'fileWritten': False, 'playable': False, 'affected': []},
                    status='blocked', read_only=False)
            argv = [program] + list(encoder.get('arguments', [])) + list(frames) + [output]
            concat_file = None
    try:
        result = subprocess.run(argv, capture_output=True, text=True)
        if result.returncode != 0:
            return _anim2_contract(ctx, 'animation.export', {
                'film': None, 'frameCount': len(frames), 'encoder': {'name': name},
                'reason': 'encoder exited nonzero', 'stderr': result.stderr,
                'fileWritten': False, 'playable': False, 'affected': []},
                status='fail', read_only=False)
        if not os.path.isfile(output) or os.path.getsize(output) == 0:
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
                os.unlink(concat_file)
            except OSError:
                pass
    duration = round(len(frames) / fps, 9) if fps else None
    return _anim2_contract(ctx, 'animation.export', {
        'film': output, 'frameCount': len(frames), 'encoder': {'name': name},
        'fps': fps, 'durationSeconds': duration, 'fileWritten': True,
        'playable': os.path.isfile(output) and os.path.getsize(output) > 0,
        'affected': []}, status='pass', read_only=False)


def _anim2_ffmpeg_argv(program, frames, output, fps):
    handle = tempfile.NamedTemporaryFile(mode='w', prefix='.fmcad-frames-', suffix='.txt', delete=False)
    concat_file = handle.name
    try:
        for path in frames:
            handle.write("file '" + path.replace("'", "'\\''") + "'\n")
    finally:
        handle.close()
    argv = [program, '-y', '-framerate', str(fps), '-f', 'concat', '-safe', '0',
            '-i', concat_file, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', output]
    return argv, concat_file


CAD_HANDLERS.update({'animation.sequence': animation_sequence, 'animation.export': animation_export})
