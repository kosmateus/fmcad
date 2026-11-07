"""SDK-free bounded driver plans and measured phase comparisons (rad/cm)."""
import math as _native_drive_math
from typing import TYPE_CHECKING as _NATIVE_DRIVE_TYPE_CHECKING, Literal as _NativeDriveLiteral
from typing import TypedDict as _NativeDriveTypedDict, cast as _native_drive_cast


if _NATIVE_DRIVE_TYPE_CHECKING:
    class _NativeDriveFollower(_NativeDriveTypedDict):
        joint: "JsonValue"
        coordinate: _NativeDriveLiteral['rotation', 'slide']
        ratio: int | float
        phase: int | float
        tolerance: int | float

    class _NativeDrivePlan(_NativeDriveTypedDict):
        schemaVersion: int
        confirm: bool
        driver: "JsonValue"
        waypoints: list[int | float]
        followers: list[_NativeDriveFollower]
        budgetSeconds: int | float
        driverTolerance: int | float
        restoreTolerance: int | float

    class _NativeMotionLinkPlan(_NativeDriveTypedDict):
        jointOne: "JsonValue"
        jointTwo: "JsonValue"
        valueOne: str
        valueTwo: str
        isReversed: bool

    class _NativeDriveSnapshot(_NativeDriveTypedDict):
        joints: dict[str, dict[str, int | float]]
        transforms: dict[str, dict[str, int | float]]


def _native_drive_number(value: object, name: str) -> "int | float":
    if type(value) not in (int, float):
        raise ValueError(name + ' must be a finite number')
    number = _native_drive_cast('int | float', value)
    if not _native_drive_math.isfinite(number):
        raise ValueError(name + ' must be a finite number')
    return number


def _native_drive_plan(data: "JsonValue") -> "_NativeDrivePlan":
    required = {'schemaVersion', 'confirm', 'driver', 'waypoints', 'followers'}
    optional = {'budgetSeconds', 'driverTolerance', 'restoreTolerance'}
    if not isinstance(data, dict) or not required <= data.keys() or data.keys() - required - optional:
        raise ValueError('drive-test requires confirm, driver, waypoints, followers; unknown fields refused')
    if data['confirm'] is not True:
        raise ValueError('drive-test requires confirm:true')
    if data['schemaVersion'] != 1:
        raise ValueError('drive-test requires schemaVersion:1')
    points = data['waypoints']
    if not isinstance(points, list) or not 2 <= len(points) <= 240:
        raise ValueError('waypoints must contain 2..240 absolute driver angles in radians')
    points = [_native_drive_number(v, 'waypoint') for v in points]
    if not any(abs(v - points[0]) > 1e-6 for v in points):
        raise ValueError('waypoints must exercise nonzero motion')
    followers = data['followers']
    if not isinstance(followers, list) or not 1 <= len(followers) <= 32:
        raise ValueError('followers must contain 1..32 observations')
    normalized: list[_NativeDriveFollower] = []
    for follower in followers:
        if not isinstance(follower, dict) or set(follower) != {'joint', 'coordinate', 'ratio', 'phase', 'tolerance'}:
            raise ValueError('follower requires joint, coordinate, ratio, phase, tolerance')
        if follower['coordinate'] not in ('rotation', 'slide'):
            raise ValueError('coordinate must be rotation or slide')
        follower_data = follower
        ratio = _native_drive_number(follower_data['ratio'], 'ratio')
        phase = _native_drive_number(follower_data['phase'], 'phase')
        tolerance = _native_drive_number(follower_data['tolerance'], 'tolerance')
        item = _native_drive_cast('_NativeDriveFollower', dict(follower_data))
        item['ratio'] = ratio
        item['phase'] = phase
        item['tolerance'] = tolerance
        if ratio == 0 or tolerance <= 0:
            raise ValueError('ratio must be nonzero and tolerance positive')
        normalized.append(item)
    # Strictly below pi: measured wrapped angles can only be lifted locally.
    # Conservatively bound the declared motion; wrong actual ratios remain unknown
    # when their measured increments are ambiguous, never lifted toward expected.
    for a, b in zip(points, points[1:]):
        if abs(b - a) >= _native_drive_math.pi / 2:
            raise ValueError('driver waypoint increments must be less than pi/2')
        for item in normalized:
            if item['coordinate'] == 'rotation' and abs((b - a) * item['ratio']) >= _native_drive_math.pi / 2:
                raise ValueError('expected follower increments must be less than pi/2')
    plan = _native_drive_cast('JsonObject', dict(data, waypoints=points, followers=normalized))
    settings: dict[str, int | float] = {}
    for key, default, maximum in (('budgetSeconds', 10, 30), ('driverTolerance', 1e-7, .01),
                                  ('restoreTolerance', 1e-7, .001)):
        value = _native_drive_number(data.get(key, default), key)
        if not 0 < value <= maximum:
            raise ValueError(key + ' must be positive and <= ' + str(maximum))
        settings[key] = value
        plan[key] = value
    excursion = max(points) - min(points)
    if excursion <= 2 * settings['driverTolerance']:
        raise ValueError('driver excursion must exceed twice its tolerance')
    for item in normalized:
        if abs(item['ratio']) * excursion <= 2 * item['tolerance']:
            raise ValueError('expected follower excursion must exceed twice its tolerance')
        for point in points:
            _native_drive_number(item['ratio'] * point + item['phase'], 'expected follower')
    return _native_drive_cast('_NativeDrivePlan', plan)


def _native_motion_link_plan(data: "JsonValue") -> "_NativeMotionLinkPlan":
    required = {'schemaVersion', 'frame', 'confirm', 'jointOne', 'jointTwo', 'valueOne', 'valueTwo'}
    optional = {'isReversed'}
    if not isinstance(data, dict) or not required <= data.keys() or data.keys() - required - optional:
        raise ValueError('motion-link requires confirm, two joint refs and two angle values; unknown fields refused')
    if type(data['schemaVersion']) is not int or data['schemaVersion'] != 1 or data['frame'] != 'component':
        raise ValueError('motion-link requires schemaVersion:1 and frame:component')
    if data['confirm'] is not True:
        raise ValueError('motion-link requires confirm:true')
    for key in ('jointOne', 'jointTwo'):
        ref = data[key]
        reference_keys = _native_drive_cast('dict[object, JsonValue]', ref) if isinstance(ref, dict) else {}
        if not ((isinstance(ref, str) and ref.strip()) or
                (isinstance(ref, dict) and ref and all(isinstance(k, str) for k in reference_keys))):
            raise ValueError(key + ' must be a nonempty native joint reference')
    if data['jointOne'] == data['jointTwo']:
        raise ValueError('motion-link requires two distinct joints')
    values: list[str] = []
    for key in ('valueOne', 'valueTwo'):
        value = data[key]
        if (not isinstance(value, str) or not value.strip() or len(value) > 256 or
                any(ord(char) < 32 or ord(char) == 127 for char in value)):
            raise ValueError(key + ' must be a bounded angle expression')
        values.append(value)
    reversed_direction = data.get('isReversed', False)
    if type(reversed_direction) is not bool:
        raise ValueError('isReversed must be boolean')
    return _native_drive_cast('_NativeMotionLinkPlan', {
        'jointOne': data['jointOne'], 'jointTwo': data['jointTwo'],
        'valueOne': values[0], 'valueTwo': values[1], 'isReversed': reversed_direction})


def _native_drive_lift(previous_raw: "int | float", previous_phase: "int | float",
                       raw: "int | float") -> float:
    """Lift solely from actual adjacent observations, never from an expected track."""
    delta = (raw - previous_raw + _native_drive_math.pi) % (2 * _native_drive_math.pi) - _native_drive_math.pi
    if abs(delta) >= _native_drive_math.pi / 2:
        raise ValueError('measured angular step is ambiguous; use finer waypoints')
    return previous_phase + delta


def _native_drive_restore_check(before: "_NativeDriveSnapshot", after: "_NativeDriveSnapshot",
                                tolerance: "int | float") -> list[str]:
    errors: list[str] = []
    for family in ('joints', 'transforms'):
        if set(before[family]) != set(after[family]):
            errors.append(family + ' observation identity changed')
            continue
        for key, original in before[family].items():
            actual = after[family][key]
            if set(original) != set(actual) or any(
                    abs(_native_drive_number(actual[k], 'restore readback') - value) > tolerance
                    for k, value in original.items()):
                errors.append(family + ' restore differs: ' + str(key))
    return errors
