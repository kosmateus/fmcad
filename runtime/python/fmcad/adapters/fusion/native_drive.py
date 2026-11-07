"""Fusion adapters for driver-only experiments and explicit native MotionLinks.

Registration is owned by the isolated native-drive family descriptor; wiring it
into the canonical manifest remains deferred to the coordinated integration slot.
"""
import math as _native_drive_adapter_math
import time as _native_drive_adapter_time
from typing import TYPE_CHECKING as _NativeDriveAdapterTypeChecking
from typing import Callable as _NativeDriveCallable, Protocol as _NativeDriveAdapterProtocol
from typing import cast as _native_drive_adapter_cast


if _NativeDriveAdapterTypeChecking:
    class _NativeDriveRotationLimits(_NativeDriveAdapterProtocol):
        isMinimumValueEnabled: bool
        minimumValue: float
        isMaximumValueEnabled: bool
        maximumValue: float

    class _NativeDriveRotationMotion(_NativeDriveAdapterProtocol):
        rotationValue: float
        rotationLimits: _NativeDriveRotationLimits

    class _NativeDriveJointMotion(_NativeDriveAdapterProtocol):
        rotationValue: float
        slideValue: float

    class _NativeDriveAnimationManager(_NativeDriveAdapterProtocol):
        isAnimationWorkspaceActive: bool

    class _NativeDriveAnimationDesign(_NativeDriveAdapterProtocol):
        animationManager: _NativeDriveAnimationManager | None

    class _NativeDriveMotionValue(_NativeDriveAdapterProtocol):
        value: float
        expression: str | None

    class _NativeDriveMotionLinkInput(_NativeDriveAdapterProtocol):
        isValid: bool
        motionOne: int
        valueOne: "adsk.core.ValueInput"
        motionTwo: int
        valueTwo: "adsk.core.ValueInput"
        isReversed: bool

    class _NativeDriveMotionLink(_NativeDriveAdapterProtocol):
        isValid: bool
        isSuppressed: bool
        isReversed: bool
        jointOne: "adsk.fusion.Joint"
        jointTwo: "adsk.fusion.Joint"
        motionOne: int
        motionTwo: int
        valueOne: _NativeDriveMotionValue
        valueTwo: _NativeDriveMotionValue
        healthState: int
        errorOrWarningMessage: str

    class _NativeDriveMotionLinks(_NativeDriveAdapterProtocol):
        def createInput(self, jointOne: "adsk.fusion.Joint", jointTwo: "adsk.fusion.Joint") -> _NativeDriveMotionLinkInput | None: ...

        def add(self, linkInput: _NativeDriveMotionLinkInput) -> _NativeDriveMotionLink | None: ...

    class _NativeDriveMotionLinkOwner(_NativeDriveAdapterProtocol):
        motionLinks: _NativeDriveMotionLinks | None

    class _NativeDriveJointMotionTypes(_NativeDriveAdapterProtocol):
        RevoluteJointRotateMotionType: int

    class _NativeDriveFusionNamespace(_NativeDriveAdapterProtocol):
        JointMotionTypes: _NativeDriveJointMotionTypes


class _NativeDriveFusionPort:
    def __init__(self, ctx: "CadContext", plan: "_NativeDrivePlan",
                 cancelled: "_NativeDriveCallable[[], bool] | None" = None) -> None:
        self.ctx, self.plan = ctx, plan
        self.cancel_callback = cancelled
        self.workspace: "adsk.core.Workspace | None" = ctx.app.userInterface.activeWorkspace
        self.joints: dict[str, "adsk.fusion.Joint"] = {}
        self.occurrences: dict[str, "adsk.fusion.Occurrence"] = {}
        refs: list[tuple[str, JsonValue]] = [('driver', plan['driver'])] + [
            ('follower:' + str(i), f['joint']) for i, f in enumerate(plan['followers'])]
        for key, ref in refs:
            resolved = ctx.resolve(ref)
            joint_type = _cad_type(resolved)
            if joint_type not in ('Joint', 'AsBuiltJoint'):
                raise ValueError('Observations require unsuppressed Joint/AsBuiltJoint objects')
            joint = _native_drive_cast('adsk.fusion.Joint', resolved)
            if getattr(joint, 'isSuppressed', False):
                raise ValueError('Observations require unsuppressed Joint/AsBuiltJoint objects')
            if joint in self.joints.values():
                raise ValueError('Driver and followers must be distinct native joints')
            if getattr(joint, 'assemblyContext', None) is not None:
                raise ValueError('Occurrence proxy joints are unsupported')
            owner = _cad_owner(joint)
            if owner not in _cad_items(ctx.design.allComponents):
                raise ValueError('Joint must belong to this design')
            if any(o.component == owner and o.isReferencedComponent for o in _cad_items(ctx.root.allOccurrences)):
                raise ValueError('External referenced joints are unsupported')
            self.joints[key] = joint
            occurrences = (
                _native_drive_adapter_cast('adsk.fusion.Occurrence | None', joint.occurrenceOne),
                _native_drive_adapter_cast('adsk.fusion.Occurrence | None', joint.occurrenceTwo),
            )
            for occurrence in occurrences:
                if occurrence is not None and occurrence not in self.occurrences.values():
                    self.occurrences[str(len(self.occurrences))] = occurrence
        if not self.occurrences:
            raise ValueError('No occurrence transforms available for independent observation')
        driver_motion_value = self.joints['driver'].jointMotion
        if not hasattr(driver_motion_value, 'rotationValue'):
            raise ValueError('Driver must expose rotationValue')
        driver_motion = _native_drive_adapter_cast(
            '_NativeDriveRotationMotion', driver_motion_value)
        for i, follower in enumerate(plan['followers']):
            follower_motion = self.joints['follower:' + str(i)].jointMotion
            if (follower['coordinate'] == 'rotation' and not hasattr(follower_motion, 'rotationValue')) or (
                    follower['coordinate'] == 'slide' and not hasattr(follower_motion, 'slideValue')):
                raise ValueError('Follower does not expose selected coordinate')
        limits = driver_motion.rotationLimits
        values = plan['waypoints'] + [driver_motion.rotationValue]
        for value in values:
            if (limits.isMinimumValueEnabled and value < limits.minimumValue or
                    limits.isMaximumValueEnabled and value > limits.maximumValue):
                raise ValueError('Driver waypoint/captured pose violates joint limits')
        self.guard()
        _assembly_capture_ready(ctx)

    def guard(self) -> None:
        ctx = self.ctx
        if ctx.app.activeDocument != ctx.doc or not ctx.doc.isValid:
            raise ValueError('Target document changed or became invalid; no writes to another document')
        ui = ctx.app.userInterface
        if self.workspace is None or ui.activeWorkspace != self.workspace or ui.activeCommand not in ('', 'SelectCommand'):
            raise ValueError('Workspace or interactive command changed')
        try:
            manager = _native_drive_adapter_cast(
                '_NativeDriveAnimationDesign', ctx.design).animationManager
        except AttributeError:
            manager = None
        if manager is not None and manager.isAnimationWorkspaceActive:
            raise ValueError('Leave Animation workspace before driver testing')
        if any(not joint.isValid or getattr(joint, 'isSuppressed', False) for joint in self.joints.values()):
            raise ValueError('Observed joint became invalid or suppressed')

    def read(self) -> "_NativeDriveSnapshot":
        joints: dict[str, dict[str, int | float]] = {}
        transforms: dict[str, dict[str, int | float]] = {}
        for key, joint in self.joints.items():
            motion = _native_drive_adapter_cast('_NativeDriveJointMotion', joint.jointMotion)
            observed: dict[str, int | float] = {}
            if hasattr(motion, 'rotationValue'):
                observed['rotation'] = _native_drive_number(motion.rotationValue, 'rotation')
            if hasattr(motion, 'slideValue'):
                observed['slide'] = _native_drive_number(motion.slideValue, 'slide')
            joints[key] = observed
        for key, occurrence in self.occurrences.items():
            matrix = occurrence.transform2
            transforms[key] = {str(i): _native_drive_number(value, 'transform')
                               for i, value in enumerate(matrix.asArray())}
            if len(transforms[key]) != 16:
                raise ValueError('Occurrence transform must contain 16 values')
        return _native_drive_adapter_cast('_NativeDriveSnapshot', {
            'joints': joints, 'transforms': transforms})

    def drive_driver(self, value: int | float) -> None:
        # Reuse the native setter's limit, capture and ownership checks, but never
        # accept its echoed result as an observation. This is the sole setter.
        self.ctx.call('joint.drive', {'joint': self.plan['driver'], 'rotation': format(value, '.17g') + ' rad'})

    def cancelled(self) -> bool:
        # Synchronous SDK turns cannot claim remote cancellation support. A local
        # application-supplied callback is optional; normal broker cancellation is
        # outside this turn. No guessed context cancellation property is used.
        return self.cancel_callback() if self.cancel_callback is not None else False

    def clock(self) -> float:
        return _native_drive_adapter_time.monotonic()


def _native_drive_motion_link_capture_ready(ctx: "CadContext") -> None:
    design_type = _native_drive_adapter_cast(
        'adsk.fusion.DesignTypes', adsk.fusion.DesignTypes.ParametricDesignType)
    if ctx.design.designType == design_type:
        if ctx.design.timeline.markerPosition != ctx.design.timeline.count:
            raise ValueError('Move the timeline marker to the end before creating a MotionLink')
        if ctx.design.snapshots.hasPendingSnapshot:
            raise ValueError('Resolve pending positions before creating a MotionLink')


def mechanism_drive_test(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    plan = _native_drive_plan(data)
    ctx.require_confirm(data)
    port = _NativeDriveFusionPort(ctx, plan)
    result = _native_drive_run(plan, port)
    result['documentIdentity'] = {'creationId': ctx.doc.creationId, 'name': ctx.doc.name}
    result['observations'] = {'joints': {key: ctx.ref(joint) for key, joint in port.joints.items()},
                              'occurrences': {key: ctx.ref(occurrence) for key, occurrence in port.occurrences.items()}}
    return result


def mechanism_motion_link_create(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    plan = _native_motion_link_plan(data)
    ctx.require_confirm(data)
    if not ctx.doc.isValid or ctx.app.activeDocument != ctx.doc:
        raise ValueError('The exact pinned design must be the active valid document')
    ui = ctx.app.userInterface
    if ui.activeCommand not in ('', 'SelectCommand'):
        raise ValueError('Finish the active Fusion command before creating a MotionLink')
    try:
        manager = _native_drive_adapter_cast(
            '_NativeDriveAnimationDesign', ctx.design).animationManager
    except AttributeError:
        manager = None
    if manager is not None and manager.isAnimationWorkspaceActive:
        raise ValueError('MotionLink creation is unavailable in Animation workspace')

    joints: list["adsk.fusion.Joint"] = []
    owners: list["adsk.fusion.Component"] = []
    for key in ('jointOne', 'jointTwo'):
        resolved = ctx.resolve(plan[key])
        if _cad_type(resolved) not in ('Joint', 'AsBuiltJoint'):
            raise ValueError(key + ' must resolve to an unsuppressed Joint or AsBuiltJoint')
        joint = _native_drive_adapter_cast('adsk.fusion.Joint', resolved)
        if not joint.isValid or getattr(joint, 'isSuppressed', False):
            raise ValueError(key + ' must resolve to an unsuppressed Joint or AsBuiltJoint')
        if getattr(joint, 'assemblyContext', None) is not None:
            raise ValueError('Occurrence proxy joints are unsupported')
        owner = _cad_owner(joint)
        if owner not in _cad_items(ctx.design.allComponents):
            raise ValueError('Joints must belong to the pinned design')
        if any(o.component == owner and o.isReferencedComponent for o in _cad_items(ctx.root.allOccurrences)):
            raise ValueError('Externally referenced joints are unsupported')
        motion = joint.jointMotion
        if _cad_type(motion) != 'RevoluteJointMotion':
            raise ValueError('MotionLink creation currently requires revolute joints')
        joints.append(joint)
        owners.append(owner)
    if joints[0] == joints[1]:
        raise ValueError('MotionLink requires two distinct joints')
    if owners[0] != owners[1]:
        raise ValueError('MotionLink joints must belong to the same native component')

    values: list[float] = [ctx.angle(plan['valueOne']), ctx.angle(plan['valueTwo'])]
    if any(not _native_drive_adapter_math.isfinite(value) or value <= 0 for value in values):
        raise ValueError('MotionLink rotation values must be finite positive angles')
    _native_drive_motion_link_capture_ready(ctx)
    try:
        links = _native_drive_adapter_cast(
            '_NativeDriveMotionLinkOwner', owners[0]).motionLinks
    except AttributeError:
        links = None
    try:
        motion_type = _native_drive_adapter_cast(
            '_NativeDriveFusionNamespace', adsk.fusion).JointMotionTypes.RevoluteJointRotateMotionType
    except AttributeError:
        motion_type = None
    if links is None or motion_type is None:
        return {'schemaVersion': 1, 'operation': 'mechanism.motion-link.create',
                'status': 'blocked', 'success': False, 'nativeMotionLink': False,
                'qualified': False, 'reason': 'The pinned Fusion runtime does not expose the documented MotionLinks creation API.',
                'documentIdentity': {'creationId': ctx.doc.creationId, 'name': ctx.doc.name},
                'limitations': ['No link was created; API availability is not native solver evidence.']}

    typed_links = links
    link_input = _cad_require_result(typed_links.createInput(joints[0], joints[1]), 'MotionLinks.createInput')
    if not link_input.isValid:
        raise ValueError('MotionLinks.createInput returned an invalid input')
    link_input.motionOne = motion_type
    link_input.valueOne = _cad_require_result(adsk.core.ValueInput.createByString(plan['valueOne']), 'MotionLink valueOne')
    link_input.motionTwo = motion_type
    link_input.valueTwo = _cad_require_result(adsk.core.ValueInput.createByString(plan['valueTwo']), 'MotionLink valueTwo')
    link_input.isReversed = plan['isReversed']
    link = _cad_require_result(typed_links.add(link_input), 'MotionLinks.add')
    link_ref = ctx.ref(_native_drive_adapter_cast('adsk.core.Base', link))
    ctx.created.append(link_ref)

    try:
        value_one, value_two = link.valueOne, link.valueTwo
        actual_one = _native_drive_number(value_one.value, 'MotionLink.valueOne')
        actual_two = _native_drive_number(value_two.value, 'MotionLink.valueTwo')
        healthy = link.healthState == adsk.fusion.FeatureHealthStates.HealthyFeatureHealthState
        exact = (link.isValid and not link.isSuppressed and link.jointOne == joints[0] and link.jointTwo == joints[1] and
                 link.motionOne == motion_type and link.motionTwo == motion_type and
                 link.isReversed is plan['isReversed'] and
                 abs(actual_one - values[0]) <= 1e-10 and abs(actual_two - values[1]) <= 1e-10 and healthy)
        error_message: str | None
        try:
            error_message = link.errorOrWarningMessage
        except AttributeError:
            error_message = None
        readback: "JsonObject" = {'status': 'pass' if exact else 'fail',
                    'joints': {'jointOne': ctx.ref(link.jointOne), 'jointTwo': ctx.ref(link.jointTwo)},
                    'motions': {'jointOne': int(link.motionOne), 'jointTwo': int(link.motionTwo)},
                    'values': {'jointOne': {'value': actual_one, 'expression': getattr(value_one, 'expression', None), 'units': 'rad'},
                               'jointTwo': {'value': actual_two, 'expression': getattr(value_two, 'expression', None), 'units': 'rad'}},
                    'isReversed': link.isReversed, 'isSuppressed': link.isSuppressed,
                    'healthState': int(link.healthState),
                     'errorOrWarningMessage': error_message}
    except Exception as exc:
        return {'schemaVersion': 1, 'operation': 'mechanism.motion-link.create',
                'status': 'unknown', 'success': False, 'nativeMotionLink': True,
                'motionLink': link_ref, 'qualified': False, 'createdLinkRetained': True,
                'readback': {'status': 'unknown', 'errors': [type(exc).__name__ + ': ' + str(exc)]},
                'documentIdentity': {'creationId': ctx.doc.creationId, 'name': ctx.doc.name},
                'limitations': ['MotionLink was created but independent readback failed; inspect before continuing.']}

    return {'schemaVersion': 1, 'operation': 'mechanism.motion-link.create',
            'status': readback['status'], 'success': readback['status'] == 'pass',
            'nativeMotionLink': True, 'motionLink': link_ref, 'readback': readback,
            'qualified': False, 'createdLinkRetained': True,
            'documentIdentity': {'creationId': ctx.doc.creationId, 'name': ctx.doc.name},
            'limitations': ['Native link creation/readback is not a solver, geometry or drive-test qualification.']}
