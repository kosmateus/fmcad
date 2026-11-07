"""Stable storyboard API plus bounded, synchronous joint sampling.

Reviewed installed fusion.py AnimationManager, Storyboard and Storyboards.
No native action construction, video publishing, guessed stop, or simulation API.
"""
import math as _animation_math
import os as _animation_os
import re as _animation_re
import tempfile as _animation_tempfile
import time as _animation_time
from pathlib import Path as _AnimationPath


if _CAD_TYPE_CHECKING:
    class _AnimationJointMotion(_Protocol):
        rotationValue: float
        slideValue: float
        rotationLimits: adsk.fusion.JointLimits
        slideLimits: adsk.fusion.JointLimits

def _animation_joint_value(motion: "_AnimationJointMotion", key: str) -> float:
    return motion.rotationValue if key == 'rotation' else motion.slideValue


def _animation_guard(ctx: "CadContext", workspace: "object | None" = None) -> None:
    if ctx.app.activeDocument != ctx.doc or not ctx.doc.isValid:
        raise ValueError('Target document must remain active and valid')
    # Fail closed for interactive commands; never terminate a user command.
    if ctx.app.userInterface.activeCommand not in ('', 'SelectCommand'):
        raise ValueError('Close the active command before animation/motion changes')
    if workspace is not None and ctx.app.userInterface.activeWorkspace != workspace:
        raise ValueError('Workspace changed during sampling; no automatic switch or restoration')


def _animation_manager(ctx: "CadContext") -> "adsk.fusion.AnimationManager | None":
    return _cad_cast("adsk.fusion.AnimationManager | None", getattr(ctx.design, 'animationManager', None))


def _animation_row(ctx: "CadContext", board: "adsk.fusion.Storyboard",
                   index: int) -> "JsonRecord":
    descriptor = _cad_cast("property | None", getattr(type(board), 'playheadPosition', None))
    return {'ref': {'document': ctx.doc.creationId, 'index': index},
            'isActive': getattr(board, 'isActive', None), 'end': getattr(board, 'end', None),
            'playheadPosition': getattr(board, 'playheadPosition', None),
            'isInPlayMode': getattr(board, 'isInPlayMode', None),
            'methods': {name: callable(getattr(board, name, None)) for name in ('activate', 'play')},
            'seekExposed': descriptor is not None and descriptor.fset is not None}


def _animation_native(ctx: "CadContext", data: "JsonObject", mode: str) -> "JsonRecord":
    required = ('storyboard',) if mode in ('inspect', 'activate', 'play', 'seek') else ()
    if mode == 'seek':
        required += ('seconds',)
    if mode in ('create', 'activate', 'play', 'seek', 'workspace'):
        required += ('confirm',)
    optional = {'create': ('clean', 'activate'), 'activate': ('activate',),
                'play': ('activate', 'begin', 'end'), 'seek': ('activate',)}.get(mode, ())
    _cad_fields(data, required, optional)
    for key in ('clean', 'activate'):
        if key in data and type(data[key]) is not bool:
            raise ValueError(key + ' must be boolean')
    manager = _animation_manager(ctx)
    if mode == 'capabilities':
        # Read class metadata only: the instance getter can raise assetRoot until
        # the Animation workspace has initialized the document's animation data.
        descriptor = getattr(type(manager), 'storyboards', None)
        exposed = isinstance(descriptor, property) and descriptor.fget is not None
        boards_type = getattr(adsk.fusion, 'Storyboards', None)
        return {'available': manager is not None, 'profile': 'stable-distributed',
                'workspaceActive': getattr(manager, 'isAnimationWorkspaceActive', None),
                'listAvailable': exposed and callable(getattr(boards_type, 'item', None)),
                'createAvailable': exposed and callable(getattr(boards_type, 'add', None)),
                'workspaceActivationAvailable': callable(getattr(type(manager), 'activateAnimationWorkspace', None)),
                'collectionAccess': 'notChecked', 'count': None,
                'actionCreation': False, 'videoPublish': False, 'stop': False,
                'limitations': _ANIMATION_LIMITATIONS,
                'nativeExamples': [{'operation': 'animation.list', 'data': {}},
                                   {'operation': 'animation.create', 'data': {'confirm': True, 'clean': True, 'activate': True}},
                                   {'operation': 'animation.seek', 'data': {'confirm': True, 'seconds': 0,
                                    'storyboard': {'document': ctx.doc.creationId, 'index': 0}}}]}
    if manager is None:
        raise ValueError('Installed API does not expose Design.animationManager')
    board: adsk.fusion.Storyboard | None = None
    index: int | None = None
    if 'storyboard' in data:
        ref = _cad_cast("JsonObject", data['storyboard'])
        _cad_fields(ref, ('document', 'index'))
        index = _cad_cast(int, ref['index'])
        if ref['document'] != ctx.doc.creationId:
            raise ValueError('Storyboard reference belongs to a different document')
        if type(index) is not int or index < 0:
            raise ValueError('Storyboard index out of range; relist storyboards')
    if mode not in ('list', 'inspect'):
        ctx.require_confirm(data)
        _animation_guard(ctx)
        if mode == 'workspace' or data.get('activate', False) and not manager.isAnimationWorkspaceActive:
            activate = getattr(manager, 'activateAnimationWorkspace', None)
            if not callable(activate):
                raise ValueError('Workspace activation API unavailable')
            _cad_require_result(activate(), 'Activate Animation workspace')
        if mode == 'workspace':
            return {'workspaceActive': manager.isAnimationWorkspaceActive}
    if not manager.isAnimationWorkspaceActive:
        raise ValueError('Storyboard access requires an active Animation workspace; run animation.workspace '
                         'with confirm:true explicitly, then retry (mutating operations also accept activate:true)')
    try:
        boards = manager.storyboards
    except RuntimeError as exc:
        if 'assetRoot' not in str(exc):
            raise
        raise RuntimeError('Storyboard data is not initialized (assetRoot); run animation.workspace '
                           'with confirm:true explicitly, then retry. ' + str(exc)) from exc
    if mode == 'list':
        return {'storyboards': [_animation_row(ctx, b, i) for i, b in enumerate(_cad_items(boards))],
                'limitations': _ANIMATION_LIMITATIONS}
    if index is not None:
        if index >= boards.count:
            raise ValueError('Storyboard index out of range; relist storyboards')
        board = _cad_require_result(boards.item(index), 'Read storyboard')
    if mode == 'inspect':
        inspect_board = _cad_cast("adsk.fusion.Storyboard", board)
        inspect_index = _cad_cast(int, index)
        return dict(_animation_row(ctx, inspect_board, inspect_index), limitations=_ANIMATION_LIMITATIONS)
    method = {'create': 'add', 'activate': 'activate', 'play': 'play'}.get(mode)
    target = boards if mode == 'create' else board
    if method is not None and not callable(getattr(target, method, None)):
        raise ValueError('Installed stable API does not expose ' + method)
    seconds: int | float = 0
    begin: int | float = 0
    end: int | float = 0
    if mode == 'seek':
        seek_board = _cad_cast("adsk.fusion.Storyboard", board)
        descriptor = _cad_cast("property | None", getattr(type(seek_board), 'playheadPosition', None))
        if descriptor is None or descriptor.fset is None:
            raise ValueError('Installed stable API does not expose writable playheadPosition')
        seconds = _animation_number(data['seconds'], 'seconds')
        if seconds != -1 and not 0 <= seconds <= seek_board.end:
            raise ValueError('seconds must be -1 (scratch zone) or within storyboard duration')
    if mode == 'play':
        play_board = _cad_cast("adsk.fusion.Storyboard", board)
        begin = _animation_number(data.get('begin', play_board.playheadPosition), 'begin')
        end = _animation_number(data.get('end', play_board.end), 'end')
        if not 0 <= begin < end <= play_board.end:
            raise ValueError('Playback requires 0 <= begin < end <= storyboard.end')
    if mode in ('play', 'seek') and not _cad_cast("adsk.fusion.Storyboard", board).isActive:
        raise ValueError('Activate the target storyboard explicitly first')
    if mode == 'create':
        board = _cad_require_result(boards.add(_cad_cast(bool, data.get('clean', True))), 'Create storyboard')
        index = next(i for i, item in enumerate(_cad_items(boards)) if item == board)
    elif mode == 'activate':
        _cad_require_result(_cad_cast("adsk.fusion.Storyboard", board).activate(), 'Activate storyboard')
    else:
        if mode == 'seek':
            _cad_cast("adsk.fusion.Storyboard", board).playheadPosition = seconds
        else:
            _cad_require_result(_cad_cast("adsk.fusion.Storyboard", board).play(False, begin, end),
                                'Start storyboard playback')
    result: JsonRecord = dict(_animation_row(ctx, _cad_cast("adsk.fusion.Storyboard", board),
                                             _cad_cast(int, index)), limitations=_ANIMATION_LIMITATIONS)
    if mode == 'create':
        ctx.created.append(result['ref'])
    if mode == 'play':
        result.update(status='started', completed=False)
    return result


def _animation_paths(data: "JsonObject", count: int) -> "list[_AnimationPath]":
    if 'frameFiles' in data and any(k in data for k in ('directory', 'prefix')):
        raise ValueError('Use frameFiles OR directory/prefix')
    if 'prefix' in data and 'directory' not in data:
        raise ValueError('prefix requires directory')
    files = data.get('frameFiles')
    if 'directory' in data:
        directory_value = data['directory']
        if not isinstance(directory_value, str) or not _AnimationPath(directory_value).is_absolute() or not _AnimationPath(directory_value).is_dir():
            raise ValueError('directory must be an existing absolute Fusion-machine directory')
        directory = directory_value
        prefix = data.get('prefix', 'frame')
        if not isinstance(prefix, str) or not _animation_re.fullmatch(r'[A-Za-z0-9_-]{1,64}', prefix):
            raise ValueError('prefix must contain 1..64 ASCII letters, digits, underscores or hyphens')
        files = [str(_AnimationPath(directory) / ('%s-%03d.png' % (prefix, i))) for i in range(count)]
    if files is None and 'frameFiles' not in data:
        return []
    if not isinstance(files, list) or len(files) != count:
        raise ValueError('frameFiles must have exactly frameCount paths')
    path_values = _cad_cast("Sequence[JsonValue]", files)
    paths: list[_AnimationPath] = []
    seen: set[str] = set()
    for value in path_values:
        if not isinstance(value, str) or not value.strip():
            raise ValueError('Frame target must be an absolute PNG path')
        path = _AnimationPath(value)
        if not path.is_absolute() or path.suffix.lower() != '.png' or not path.parent.is_dir():
            raise ValueError('Frame target must be an absolute PNG path with an existing parent')
        key = _animation_os.path.normcase(str(path.resolve())).casefold()
        if key in seen or path.exists() or path.is_symlink():
            raise ValueError('Duplicate or existing frame target; overwriting is not supported')
        seen.add(key)
        paths.append(path)
    return paths


def _animation_sample(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('tracks', 'frameCount', 'confirm'),
                ('restore', 'checks', 'frameFiles', 'directory', 'prefix', 'realtime', 'delay', 'width', 'height'))
    ctx.require_confirm(data)
    count_value = data['frameCount']
    if type(count_value) is not int or not 2 <= count_value <= 240:
        raise ValueError('frameCount must be an integer in 2..240')
    count = count_value
    for key in ('restore', 'realtime'):
        if key in data and type(data[key]) is not bool:
            raise ValueError(key + ' must be boolean')
    realtime = _cad_cast(bool, data.get('realtime', False))
    restore = _cad_cast(bool, data.get('restore', True))
    delay = _animation_number(data.get('delay', 0), 'delay')
    if not 0 <= delay <= .1 or delay and not realtime:
        raise ValueError('delay must be 0..0.1 seconds and requires realtime:true when nonzero')
    width_value, height_value = data.get('width', 1280), data.get('height', 720)
    if any(type(v) is not int or not 32 <= v <= 4096 for v in (width_value, height_value)):
        raise ValueError('Image dimensions must be integers in 32..4096')
    width, height = _cad_cast(int, width_value), _cad_cast(int, height_value)
    paths = _animation_paths(data, count)
    if not paths and any(k in data for k in ('width', 'height')):
        raise ValueError('Image dimensions require frame targets')
    tracks_value = data['tracks']
    if not isinstance(tracks_value, list) or not 1 <= len(tracks_value) <= 64:
        raise ValueError('tracks must contain 1..64 explicit joint tracks')
    tracks = _cad_cast("list[JsonObject]", tracks_value)
    plan: list[tuple[JsonValue, adsk.fusion.Joint | adsk.fusion.AsBuiltJoint,
                     dict[str, tuple[list[float], str]], dict[str, tuple[float, str]]]] = []
    joints: list[adsk.fusion.Joint | adsk.fusion.AsBuiltJoint] = []
    for track in tracks:
        _cad_fields(track, ('joint',), ('rotation', 'slide'))
        joint_entity = ctx.resolve(track['joint'])
        if _cad_type(joint_entity) not in ('Joint', 'AsBuiltJoint'):
            raise ValueError('Tracks require distinct Joint/AsBuiltJoint objects')
        joint = _cad_cast("adsk.fusion.Joint | adsk.fusion.AsBuiltJoint", joint_entity)
        if joint in joints:
            raise ValueError('Tracks require distinct Joint/AsBuiltJoint objects')
        if getattr(joint, 'isSuppressed', False):
            raise ValueError('Cannot sample a suppressed joint')
        joints.append(joint)
        motion = joint.jointMotion
        values: dict[str, tuple[list[float], str]] = {}
        original: dict[str, tuple[float, str]] = {}
        for key, evaluator, unit in (('rotation', ctx.angle, 'rad'), ('slide', ctx.length, 'cm')):
            prop = key + 'Value'
            if hasattr(motion, prop):
                typed_motion = _cad_cast("_AnimationJointMotion", motion)
                value = typed_motion.rotationValue if key == 'rotation' else typed_motion.slideValue
                original[key] = (_cad_cast(float, _animation_number(value, prop)), unit)
                limits = typed_motion.rotationLimits if key == 'rotation' else typed_motion.slideLimits
                for enabled, bound in ((limits.isMinimumValueEnabled, 'minimumValue'),
                                       (limits.isMaximumValueEnabled, 'maximumValue')):
                    if enabled:
                        bound_value = limits.minimumValue if bound == 'minimumValue' else limits.maximumValue
                        _animation_number(bound_value, key + ' ' + bound)
                if (limits.isMinimumValueEnabled and original[key][0] < limits.minimumValue) or (
                        limits.isMaximumValueEnabled and original[key][0] > limits.maximumValue):
                    raise ValueError('Original ' + key + ' is outside joint limits; cannot safely restore')
            if key not in track:
                continue
            track_range = track[key]
            _cad_fields(track_range, ('from', 'to'))
            if key not in original:
                raise ValueError('Joint does not expose ' + prop)
            range_record = _cad_cast("JsonObject", track_range)
            start, finish = [evaluator(range_record[k]) for k in ('from', 'to')]
            typed_motion = _cad_cast("_AnimationJointMotion", motion)
            limits = typed_motion.rotationLimits if key == 'rotation' else typed_motion.slideLimits
            motion_samples: list[float] = [start if i == 0 else finish if i == count - 1 else
                       start * (1 - i / (count - 1)) + finish * (i / (count - 1)) for i in range(count)]
            for value in motion_samples:
                _animation_number(value, key)
                if (limits.isMinimumValueEnabled and value < limits.minimumValue) or (
                        limits.isMaximumValueEnabled and value > limits.maximumValue):
                    raise ValueError(key + ' is outside joint limits')
            values[key] = (motion_samples, unit)
        if not values:
            raise ValueError('Each track requires rotation and/or slide from/to expressions')
        plan.append((track['joint'], joint, values, original))
    checks_value = data.get('checks', [])
    if not isinstance(checks_value, list) or len(checks_value) > 64:
        raise ValueError('checks must be an array of at most 64 check inputs')
    checks = _cad_cast("list[JsonObject]", checks_value)
    _animation_guard(ctx)
    manager = _animation_manager(ctx)
    if manager is not None and manager.isAnimationWorkspaceActive:
        raise ValueError('Joint sampling requires leaving Animation workspace explicitly; avoids native recording')
    workspace = _cad_cast("object | None", ctx.app.userInterface.activeWorkspace)
    if workspace is None:
        raise ValueError('Cannot guard sampling without an active workspace')
    _assembly_capture_ready(ctx)
    viewport = ctx.app.activeViewport
    if viewport.parentDocument != ctx.doc:
        raise ValueError('Viewport belongs to a different document')
    camera = viewport.camera
    # check only dispatches allowed scalar measurements; validate before any motion.
    for check in checks:
        ctx.call('check', check)
    samples: list[JsonRecord] = []
    files: list[str] = []
    error: str | None = None
    restore_errors: list[str] = []
    try:
        for index in range(count):
            _animation_guard(ctx, workspace)
            for ref, joint, values, original in plan:
                ctx.call('joint.drive', dict(joint=ref, **{
                    key: format(series[index], '.17g') + ' ' + unit for key, (series, unit) in values.items()}))
            if realtime:
                _cad_require_result(viewport.refresh(), 'Refresh motion preview')
                adsk.doEvents()
                _animation_guard(ctx, workspace)
                if delay:
                    _animation_time.sleep(delay)
            check_results: list[JsonValue] = [ctx.call('check', check) for check in checks]
            row: JsonRecord = {'index': index, 'fraction': index / (count - 1), 'joints': [
                {'joint': ref, **{key + 'Value': _animation_number(
                    _animation_joint_value(_cad_cast("_AnimationJointMotion", joint.jointMotion), key), key)
                    for key in original}} for ref, joint, values, original in plan],
                   'checks': check_results}
            samples.append(row)
            if paths:
                path = paths[index]
                if path.exists() or path.is_symlink():
                    raise ValueError('Frame target appeared during sampling; refusing overwrite')
                # The SDK exporter can overwrite. Publish an owned temporary PNG
                # with an atomic no-replace hard link instead of racing existence checks.
                with _animation_tempfile.TemporaryDirectory(prefix='.fmcad-motion-', dir=str(path.parent)) as temporary:
                    image = _AnimationPath(temporary) / 'frame.png'
                    _cad_require_result(viewport.saveAsImageFile(str(image), width, height), 'Save motion frame')
                    if not image.is_file() or image.stat().st_size == 0:
                        raise RuntimeError('Frame export returned no nonempty file')
                    _animation_os.link(str(image), str(path))
                    files.append(str(path))
                    row['frameFile'] = str(path)
    except Exception as exc:
        error = type(exc).__name__ + ': ' + str(exc)
    finally:
        if restore:
            for ref, joint, values, original in reversed(plan):
                try:
                    _animation_guard(ctx, workspace)
                    ctx.call('joint.drive', dict(joint=ref, **{
                        key: format(value, '.17g') + ' ' + unit for key, (value, unit) in original.items()}))
                except Exception as exc:
                    restore_errors.append('joint restore: ' + type(exc).__name__ + ': ' + str(exc))
            for ref, joint, values, original in plan:
                try:
                    for key, (value, unit) in original.items():
                        motion = _cad_cast("_AnimationJointMotion", joint.jointMotion)
                        if not _animation_math.isclose(_animation_joint_value(motion, key), value,
                                                       rel_tol=1e-9, abs_tol=1e-9):
                            restore_errors.append('Restored ' + key + ' differs from original for ' + str(ref))
                except Exception as exc:
                    restore_errors.append('joint verification: ' + str(exc))
            try:
                _animation_guard(ctx, workspace)
                camera.isSmoothTransition = False
                camera.isFitView = False
                viewport.camera = camera
            except Exception as exc:
                restore_errors.append('camera restore: ' + type(exc).__name__ + ': ' + str(exc))
    passed = error is None and not restore_errors and all(
        check['passed'] for sample in samples
        for check in _cad_cast("list[JsonObject]", sample['checks']))
    return {'status': 'pass' if passed else 'fail', 'passed': passed, 'samples': samples,
            'frameFiles': files, 'error': error, 'restoreRequested': restore,
            'restored': not restore_errors if restore else None, 'restoreErrors': restore_errors,
            'units': {'rotationValue': 'rad', 'slideValue': 'cm'},
            'continuousMotionVerified': False, 'nativeStoryboardActionsCreated': False,
            'limitations': ['Kinematic joint samples only; not FEA, dynamics, contact solving or continuous collision verification.',
                            'Actual values can differ from requested tracks due to assembly constraints.',
                            'Restoration is not rollback: joint.drive may capture position snapshots; document may remain modified.',
                            'Only explicit tracked joints are restored; solver-coupled untracked state is not verified.',
                            'Camera assignment is attempted, not a rendered-view equivalence proof.',
                            'No recompute, save, document close, background thread or automatic workspace switch.',
                            'Frame targets are native Fusion-machine paths; none are written by default. Existing files are never intentionally overwritten.',
                            'PNG publication requires filesystem hard-link support for atomic no-overwrite; no overwrite fallback.']}


def _animation_handler(mode: str) -> "CadHandler":
    def handler(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
        return _animation_native(ctx, data, mode)
    handler.__name__ = '<lambda>'
    return handler


CAD_HANDLERS.update({'animation.' + mode: _animation_handler(mode) for mode in
                     ('capabilities', 'list', 'inspect', 'create', 'activate', 'play', 'seek', 'workspace')})
CAD_HANDLERS.update({'motion.sample': _animation_sample, 'animation.joints': _animation_sample})
