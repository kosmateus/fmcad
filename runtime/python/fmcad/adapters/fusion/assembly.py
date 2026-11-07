"""Assembly placement, real as-built joints, and explicitly scoped history tools.

API signatures verified with Fusion apiDocumentation. No activation or implicit save.
"""

if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'assembly'

from typing import Callable as _assembly_fusion_Callable
from typing import Literal as _assembly_fusion_Literal
from typing import Protocol as _assembly_fusion_Protocol
from typing import TypedDict as _assembly_fusion_TypedDict
from typing import cast as _assembly_fusion_cast


def _assembly_fusion_expression(ctx: "CadContext", expression: object,
                                units: str | None = None, unitless: bool = False) -> "tuple[str, float]":
    evaluate = _assembly_fusion_cast(
        "_assembly_fusion_Callable[[object, str | None, bool], tuple[str, float]]",
        getattr(ctx, '_expression'))
    return evaluate(expression, units, unitless)


class _AssemblyLimitValues(_assembly_fusion_TypedDict):
    minimumValue: float
    maximumValue: float
    restValue: float
    isMinimumValueEnabled: bool
    isMaximumValueEnabled: bool
    isRestValueEnabled: bool


class _AssemblyLimitRead(_AssemblyLimitValues, total=False):
    units: str


class _AssemblyRotationLimits(_assembly_fusion_Protocol):
    @property
    def rotationLimits(self) -> 'adsk.fusion.JointLimits': ...


class _AssemblySlideLimits(_assembly_fusion_Protocol):
    @property
    def slideLimits(self) -> 'adsk.fusion.JointLimits': ...


class _AssemblyRotationValue(_assembly_fusion_Protocol):
    @property
    def rotationValue(self) -> float: ...

    @rotationValue.setter
    def rotationValue(self, value: float) -> None: ...


class _AssemblySlideValue(_assembly_fusion_Protocol):
    @property
    def slideValue(self) -> float: ...

    @slideValue.setter
    def slideValue(self, value: float) -> None: ...


class _AssemblyOccurrenceProxyFactory(_assembly_fusion_Protocol):
    def createForAssemblyContext(self, occurrence: 'adsk.fusion.Occurrence') -> 'adsk.fusion.Occurrence': ...


class _AssemblyJointInput(_assembly_fusion_Protocol):
    def setAsRigidJointMotion(self) -> bool: ...

    def setAsRevoluteJointMotion(self, rotationAxis: 'adsk.fusion.JointDirections',
                                 customRotationAxisEntity: 'adsk.core.Base | None' = None) -> bool: ...

    def setAsSliderJointMotion(self, sliderDirection: 'adsk.fusion.JointDirections',
                               customSliderDirectionEntity: 'adsk.core.Base | None' = None) -> bool: ...

    def setAsCylindricalJointMotion(self, rotationAxis: 'adsk.fusion.JointDirections',
                                    customRotationAxisEntity: 'adsk.core.Base | None' = None) -> bool: ...


class _AssemblyLinearCurve(_assembly_fusion_Protocol):
    @property
    def origin(self) -> 'adsk.core.Point3D': ...

    @property
    def direction(self) -> 'adsk.core.Vector3D': ...


def _assembly_set_joint_motion(
        joint_input: _AssemblyJointInput,
        mode: "_assembly_fusion_Literal['rigid', 'revolute', 'slider', 'cylindrical']",
        direction: 'adsk.fusion.JointDirections') -> bool:
    if mode == 'rigid':
        return joint_input.setAsRigidJointMotion()
    if mode == 'revolute':
        return joint_input.setAsRevoluteJointMotion(direction)
    if mode == 'slider':
        return joint_input.setAsSliderJointMotion(direction)
    return joint_input.setAsCylindricalJointMotion(direction)




def _assembly_top(ctx: "CadContext", ref: object) -> 'adsk.fusion.Occurrence':
    occurrence = ctx.resolve(ref, 'occurrence')
    if getattr(occurrence, 'assemblyContext', None) is not None or occurrence not in _cad_items(ctx.root.occurrences):
        raise ValueError('This operation supports direct root occurrences only; nested/proxy occurrences are unsupported')
    if occurrence.isReferencedComponent:
        raise ValueError('External referenced occurrences are unsupported')
    return occurrence


def _assembly_root_occurrence(ctx: "CadContext", ref: object) -> 'adsk.fusion.Occurrence':
    """Resolve a root-qualified occurrence; unlike _assembly_top, allow nested proxies."""
    occurrence = ctx.resolve(ref, 'occurrence')
    if occurrence in _cad_items(ctx.root.occurrences) and getattr(occurrence, 'assemblyContext', None) is None:
        if occurrence.isReferencedComponent:
            raise ValueError('External referenced occurrences are unsupported')
        return occurrence
    path = occurrence.fullPathName
    path_value = _assembly_fusion_cast(object, path)
    if not isinstance(path_value, str) or not path_value:
        raise ValueError('Occurrence must have an unambiguous root-context path')
    path = path_value
    matches = [o for o in _cad_items(ctx.root.allOccurrences) if o.fullPathName == path]
    occurrence = _cad_unique(matches, 'Root-context occurrence ' + path)
    parts = path.split('+')
    for depth in range(1, len(parts) + 1):
        ancestor = _cad_unique([o for o in _cad_items(ctx.root.allOccurrences)
                                if o.fullPathName == '+'.join(parts[:depth])], 'Occurrence path')
        if ancestor.isReferencedComponent:
            raise ValueError('External referenced occurrence or ancestor is unsupported')
    return occurrence


def _assembly_paths(ctx: "CadContext", component: 'adsk.fusion.Component') -> list[str]:
    return sorted(o.fullPathName for o in _cad_items(ctx.root.allOccurrences) if o.component == component)


def _assembly_root_proxy(ctx: "CadContext", occurrence: 'adsk.fusion.Occurrence',
                         parent_occurrence: 'adsk.fusion.Occurrence') -> 'adsk.fusion.Occurrence':
    create_for_context = _assembly_fusion_cast(
        object, getattr(occurrence, 'createForAssemblyContext', None))
    if create_for_context is not None:
        create_proxy = _assembly_fusion_cast(_AssemblyOccurrenceProxyFactory, occurrence)
        proxy = _cad_require_result(create_proxy.createForAssemblyContext(parent_occurrence),
                                    'Create root-context occurrence proxy')
        return proxy
    native = (_assembly_fusion_cast(
        'adsk.fusion.Occurrence | None', getattr(occurrence, 'nativeObject', None)) or occurrence)
    matches = [item for item in _cad_items(ctx.root.allOccurrences)
               if (_assembly_fusion_cast(
                   'adsk.fusion.Occurrence | None', getattr(item, 'nativeObject', None)) or item) == native]
    if not matches:
        raise RuntimeError('Created occurrence has no root-context proxy; inspect before continuing')
    return sorted(matches, key=lambda item: item.fullPathName)[0]


def _assembly_moved_proxy(ctx: "CadContext", occurrence: 'adsk.fusion.Occurrence',
                          predicted_paths: list[str]) -> 'adsk.fusion.Occurrence':
    matches = [item for item in _cad_items(ctx.root.allOccurrences)
               if item.fullPathName in predicted_paths]
    if not matches and occurrence in _cad_items(ctx.root.occurrences):
        return occurrence
    if not matches:
        raise RuntimeError('Reparented occurrence has no predicted root-context proxy; inspect before continuing')
    return sorted(matches, key=lambda item: item.fullPathName)[0]




def _assembly_external_component_reference(ctx: "CadContext", ref: "JsonValue") -> bool:
    if not isinstance(ref, dict) or not isinstance(ref.get('token'), str):
        return False
    reference = ref
    for occurrence in _cad_items(ctx.root.allOccurrences):
        if not getattr(occurrence, 'isReferencedComponent', False):
            continue
        component = occurrence.component
        if component.entityToken == reference['token']:
            return True
    return False


def _assembly_matrix(ctx: "CadContext", data: "JsonObject") -> 'adsk.core.Matrix3D':
    _cad_fields(data, optional=('translation', 'axis', 'angle'))
    if ('axis' in data) != ('angle' in data):
        raise ValueError('Rotation requires both axis and angle')
    translation = ctx.point(data.get('translation', ['0 mm', '0 mm', '0 mm']))
    matrix = adsk.core.Matrix3D.create()
    if 'angle' in data:
        angle = ctx.angle(data['angle'])
        axis = adsk.core.Vector3D.create(*_cad_direction(data['axis']))
        origin = _assembly_fusion_cast('adsk.core.Point3D', adsk.core.Point3D.create(0, 0, 0))
        _cad_require_result(matrix.setToRotation(angle, axis, origin), 'Rotation matrix')
    matrix.translation = adsk.core.Vector3D.create(translation.x, translation.y, translation.z)
    return matrix


def _assembly_capture_ready(ctx: "CadContext") -> bool:
    parametric = _assembly_fusion_cast(object, ctx.design.designType) == adsk.fusion.DesignTypes.ParametricDesignType
    if parametric:
        if ctx.design.timeline.markerPosition != ctx.design.timeline.count:
            raise ValueError('Move timeline marker to the end before assembly changes')
        if ctx.design.snapshots.hasPendingSnapshot:
            raise ValueError('Resolve existing pending positions before this operation; they will not be captured implicitly')
    return parametric


def _assembly_capture(ctx: "CadContext", parametric: bool) -> "JsonValue":
    if parametric and ctx.design.snapshots.hasPendingSnapshot:
        return ctx.ref(_cad_require_result(ctx.design.snapshots.add(), 'Capture assembly position'))
    return None


def _assembly_component(ctx: "CadContext", data: "JsonObject",
                        mode: str) -> "JsonValue":
    if mode == 'inspect':
        _cad_fields(data, optional=('component',))
        component = ctx.resolve(data['component'], 'component') if 'component' in data else ctx.component
        return {'component': ctx.describe(component), 'bodies': [ctx.ref(b) for b in _cad_items(component.bRepBodies)],
                'occurrences': [ctx.ref(o) for o in _cad_items(component.occurrences)]}
    if mode == 'rename':
        _cad_fields(data, ('component', 'name'))
        component = ctx.resolve(data['component'], 'component')
        name = _assembly_name(data['name'])
        component.name = name
        return {'component': ctx.ref(component), 'affectsAllInstances': True}
    if mode == 'reparent':
        _cad_fields(data, ('occurrence', 'target', 'confirm'), ('sharedParentPolicy',))
        _assembly_nested_options(data)
        ctx.require_confirm(data)
        occurrence = _assembly_root_occurrence(ctx, data['occurrence'])
        target = _assembly_root_occurrence(ctx, data['target'])
        source_paths = _assembly_paths(ctx, occurrence.component)
        target_paths = _assembly_paths(ctx, target.component)
        if '+' in occurrence.fullPathName and len(source_paths) > 1:
            raise ValueError('Nested reparent of a repeated source definition is unsupported')
        if len(target_paths) > 1 and data.get('sharedParentPolicy') != 'allInstances':
            raise ValueError('Repeated target requires sharedParentPolicy:allInstances')
        if occurrence == target or occurrence.component == target.component or any(
                o.component == target.component for o in _cad_items(occurrence.component.allOccurrences)):
            raise ValueError('Reparent would create a component cycle')
        _assembly_capture_ready(ctx)
        before = list(_entity_occurrence_matrix(ctx, occurrence))
        moved_name = occurrence.fullPathName.rsplit('+', 1)[-1]
        predicted_paths = sorted(path + '+' + moved_name for path in target_paths)
        moved_native = _cad_require_result(occurrence.moveToComponent(target), 'Reparent occurrence')
        moved = _assembly_moved_proxy(ctx, moved_native, predicted_paths)
        after = list(_entity_occurrence_matrix(ctx, moved))
        if any(abs(a-b) > 1e-7 for a, b in zip(before, after)):
            raise RuntimeError('Reparent world pose readback differs; mutation retained for inspection')
        return {'occurrence': ctx.ref(moved), 'worldPosePreserved': True,
                'affectedPaths': predicted_paths}
    _cad_fields(data, ('name',) + (('bodies', 'confirm') if mode == 'from_bodies' else ()), ('placement',))
    name = _assembly_name(data['name'])
    matrix = _assembly_matrix(ctx, _assembly_fusion_cast('JsonObject', data.get('placement', {})))
    if any(c.name == name for c in _cad_items(ctx.design.allComponents)):
        raise ValueError('Component name already exists')
    bodies = []
    if mode == 'from_bodies':
        ctx.require_confirm(data)
        if not isinstance(data['bodies'], list) or not data['bodies']:
            raise ValueError('bodies must be a nonempty array')
        bodies = [ctx.resolve(r, 'body') for r in data['bodies']]
        if any(b == previous for i, b in enumerate(bodies) for previous in bodies[:i]):
            raise ValueError('Duplicate bodies')
        if any(getattr(b, 'assemblyContext', None) is not None or b.parentComponent != ctx.root for b in bodies):
            raise ValueError('from_bodies supports native root bodies only')
    _assembly_capture_ready(ctx)
    occurrence = _cad_require_result(ctx.root.occurrences.addNewComponent(matrix), 'Create component')
    occurrence.component.name = name
    ctx.created.extend([ctx.ref(occurrence.component), ctx.ref(occurrence)])
    moved = [_cad_require_result(b.moveToComponent(occurrence), 'Move body to component') for b in bodies]
    return {'component': ctx.ref(occurrence.component), 'occurrence': ctx.ref(occurrence),
            'bodies': [ctx.ref(b) for b in moved], 'atomic': False}


def _assembly_occurrence(ctx: "CadContext", data: "JsonObject",
                         mode: str) -> "JsonValue":
    if mode in ('transform', 'align'):
        return _assembly_fusion_cast('JsonValue', _datum_occurrence(ctx, data, mode))
    if mode in ('add', 'duplicate'):
        source = 'component' if mode == 'add' else 'occurrence'
        _cad_fields(data, (source, 'copyMode'), ('placement', 'name', 'destination', 'placementSpace', 'sharedParentPolicy'))
        _assembly_nested_options(data)
        copy_mode = data['copyMode']
        if copy_mode not in ('linked', 'independent'):
            raise ValueError('copyMode must explicitly be linked or independent')
        if copy_mode == 'linked' and 'name' in data:
            raise ValueError('name would rename every linked instance; use component.rename explicitly')
        name = _assembly_name(data['name']) if 'name' in data else None
        original = _assembly_root_occurrence(ctx, data[source]) if mode == 'duplicate' else None
        if mode == 'add' and _assembly_external_component_reference(ctx, data[source]):
            raise ValueError('External component insertion/copy is unsupported')
        component = original.component if original else ctx.resolve(data[source], 'component')
        if component == ctx.root:
            raise ValueError('Cannot instance the root component')
        if any(o.component == component and o.isReferencedComponent for o in _cad_items(ctx.root.allOccurrences)):
            raise ValueError('External component insertion/copy is unsupported')
        destination = data.get('destination')
        if 'placementSpace' in data and 'placement' not in data:
            raise ValueError('placementSpace is only valid with placement')
        if 'placement' in data and destination not in (None, 'root') and data.get('placementSpace') not in ('root', 'parent'):
            raise ValueError('placementSpace root or parent is required for nested placement')
        if destination == 'root':
            parent = ctx.root
            parent_occurrence = None
        elif destination is not None:
            parent_occurrence = _assembly_root_occurrence(ctx, destination)
            parent = parent_occurrence.component
            if parent == component or any(o.component == parent for o in _cad_items(component.allOccurrences)):
                raise ValueError('Destination would create an occurrence cycle')
            if len(_assembly_paths(ctx, parent)) > 1 and data.get('sharedParentPolicy') != 'allInstances':
                raise ValueError('Repeated linked parent requires sharedParentPolicy:allInstances')
        else:
            parent, parent_occurrence = ctx.root, None
        if 'placement' in data:
            if parent_occurrence is None and 'placementSpace' in data:
                raise ValueError('placementSpace is only valid for nested placement')
            local = _entity_matrix(_assembly_matrix(
                ctx, _assembly_fusion_cast('JsonObject', data['placement'])).asArray())
            matrix_values = (_entity_multiply(_entity_inverse(_entity_occurrence_matrix(ctx, parent_occurrence)), local)
                             if parent_occurrence is not None and data['placementSpace'] == 'root' else local)
            matrix = adsk.core.Matrix3D.create()
            matrix.setWithArray(_assembly_fusion_cast('list[float]', matrix_values))
        elif parent_occurrence is not None and mode == 'duplicate':
            matrix_values = _entity_multiply(_entity_inverse(_entity_occurrence_matrix(ctx, parent_occurrence)),
                                             _entity_occurrence_matrix(
                                                 ctx, _assembly_fusion_cast('adsk.fusion.Occurrence', original)))
            matrix = adsk.core.Matrix3D.create()
            matrix.setWithArray(_assembly_fusion_cast('list[float]', matrix_values))
        elif mode == 'duplicate':
            matrix = _assembly_fusion_cast('adsk.fusion.Occurrence', original).transform2.copy()
        else:
            matrix = adsk.core.Matrix3D.create()
        _assembly_capture_ready(ctx)
        if copy_mode == 'linked':
            occurrence = _cad_require_result(
                parent.occurrences.addExistingComponent(component, matrix), 'Add occurrence')
        else:
            occurrence = _cad_require_result(
                parent.occurrences.addNewComponentCopy(component, matrix), 'Add occurrence')
        result_occurrence = _assembly_root_proxy(ctx, occurrence, parent_occurrence) if parent_occurrence is not None else occurrence
        if name is not None:
            result_occurrence.component.name = name
        ctx.created.append(ctx.ref(result_occurrence))
        if copy_mode == 'independent':
            ctx.created.append(ctx.ref(result_occurrence.component))
        return {'occurrence': ctx.ref(result_occurrence), 'component': ctx.ref(result_occurrence.component), 'copyMode': copy_mode,
                'affectedPaths': _assembly_paths(ctx, result_occurrence.component)}


_ASSEMBLY_LIMIT_VALUES = ('minimumValue', 'maximumValue', 'restValue')
_ASSEMBLY_LIMIT_FLAGS = ('isMinimumValueEnabled', 'isMaximumValueEnabled', 'isRestValueEnabled')


def _assembly_joint_direction(axis: str) -> 'adsk.fusion.JointDirections':
    if axis == 'X':
        return _assembly_fusion_cast('adsk.fusion.JointDirections', adsk.fusion.JointDirections.XAxisJointDirection)
    if axis == 'Y':
        return _assembly_fusion_cast('adsk.fusion.JointDirections', adsk.fusion.JointDirections.YAxisJointDirection)
    return _assembly_fusion_cast('adsk.fusion.JointDirections', adsk.fusion.JointDirections.ZAxisJointDirection)


def _assembly_limits_read(motion: 'adsk.fusion.JointMotion') -> dict[str, _AssemblyLimitRead]:
    result: dict[str, _AssemblyLimitRead] = {}
    for axis, units in (('rotation', 'rad'), ('slide', 'cm')):
        if axis == 'rotation':
            if not hasattr(motion, 'rotationLimits'):
                continue
            limits = _assembly_fusion_cast(_AssemblyRotationLimits, motion).rotationLimits
        else:
            if not hasattr(motion, 'slideLimits'):
                continue
            limits = _assembly_fusion_cast(_AssemblySlideLimits, motion).slideLimits
        result[axis] = {
            'minimumValue': limits.minimumValue,
            'maximumValue': limits.maximumValue,
            'restValue': limits.restValue,
            'isMinimumValueEnabled': limits.isMinimumValueEnabled,
            'isMaximumValueEnabled': limits.isMaximumValueEnabled,
            'isRestValueEnabled': limits.isRestValueEnabled,
            'units': units,
        }
    return result


def _assembly_limits_plan(ctx: "CadContext", motion: 'adsk.fusion.JointMotion',
                          data: object) -> 'list[tuple[adsk.fusion.JointLimits, dict[str, float | bool]]]':
    if not isinstance(data, dict):
        raise ValueError('limits must be an object')
    data = _assembly_fusion_cast('JsonObject', data)
    _cad_fields(data, optional=('rotation', 'slide'))
    if not data:
        raise ValueError('limits must specify rotation or slide')
    supported = {'RevoluteJointMotion': ('rotation',), 'SliderJointMotion': ('slide',),
                 'CylindricalJointMotion': ('rotation', 'slide')}.get(
                     _cad_type(_assembly_fusion_cast('adsk.core.Base', motion)), ())
    before = _assembly_limits_read(motion)
    plan: 'list[tuple[adsk.fusion.JointLimits, dict[str, float | bool]]]' = []
    for axis, changes in data.items():
        if axis not in supported:
            raise ValueError('Joint motion does not support limits for ' + axis)
        if not isinstance(changes, dict):
            raise ValueError(axis + ' limits must be an object')
        _cad_fields(changes, optional=_ASSEMBLY_LIMIT_VALUES + _ASSEMBLY_LIMIT_FLAGS)
        if not changes:
            raise ValueError(axis + ' limits must not be empty')
        state = _assembly_fusion_cast(
            'dict[str, float | bool]',
            {k: v for k, v in before[axis].items() if k != 'units'})
        for prop, value in changes.items():
            if prop in _ASSEMBLY_LIMIT_FLAGS:
                if type(value) is not bool:
                    raise ValueError(prop + ' must be boolean')
            else:
                value = (ctx.angle if axis == 'rotation' else ctx.length)(value)
                if not math.isfinite(value):
                    raise ValueError(prop + ' must be finite')
            state[prop] = value
        if any(not math.isfinite(state[p]) for p in _ASSEMBLY_LIMIT_VALUES):
            raise ValueError(axis + ' limit values must be finite')
        # Disabled stored values are retained, not replaced with invented bounds.
        if state['minimumValue'] > state['maximumValue']:
            raise ValueError(axis + ' minimumValue must be <= maximumValue')
        if state['isRestValueEnabled'] or 'restValue' in changes:
            if ((state['isMinimumValueEnabled'] and state['restValue'] < state['minimumValue']) or
                    (state['isMaximumValueEnabled'] and state['restValue'] > state['maximumValue'])):
                raise ValueError(axis + ' restValue is outside enabled limits')
        limits = (_assembly_fusion_cast(_AssemblyRotationLimits, motion).rotationLimits
                  if axis == 'rotation' else
                  _assembly_fusion_cast(_AssemblySlideLimits, motion).slideLimits)
        plan.append((limits, state))
    return plan


def _assembly_limits_write(limits: 'adsk.fusion.JointLimits',
                           state: dict[str, float | bool]) -> None:
    # Temporarily disable constraints to avoid invalid intermediate ranges; restore every flag.
    limits.isMinimumValueEnabled = False
    limits.isMaximumValueEnabled = False
    limits.isRestValueEnabled = False
    limits.minimumValue = _assembly_fusion_cast(float, state['minimumValue'])
    limits.maximumValue = _assembly_fusion_cast(float, state['maximumValue'])
    limits.restValue = _assembly_fusion_cast(float, state['restValue'])
    limits.isMinimumValueEnabled = _assembly_fusion_cast(bool, state['isMinimumValueEnabled'])
    limits.isMaximumValueEnabled = _assembly_fusion_cast(bool, state['isMaximumValueEnabled'])
    limits.isRestValueEnabled = _assembly_fusion_cast(bool, state['isRestValueEnabled'])
    if (limits.minimumValue != state['minimumValue'] or
            limits.maximumValue != state['maximumValue'] or
            limits.restValue != state['restValue'] or
            limits.isMinimumValueEnabled != state['isMinimumValueEnabled'] or
            limits.isMaximumValueEnabled != state['isMaximumValueEnabled'] or
            limits.isRestValueEnabled != state['isRestValueEnabled']):
        raise RuntimeError('Joint limits readback differs from requested state')


def _assembly_limits_apply(motion: 'adsk.fusion.JointMotion',
                           plan: 'list[tuple[adsk.fusion.JointLimits, dict[str, float | bool]]]') -> None:
    saved: 'list[tuple[adsk.fusion.JointLimits, dict[str, float | bool]]]' = []
    for limits, state in plan:
        saved.append((limits, {
            'minimumValue': limits.minimumValue,
            'maximumValue': limits.maximumValue,
            'restValue': limits.restValue,
            'isMinimumValueEnabled': limits.isMinimumValueEnabled,
            'isMaximumValueEnabled': limits.isMaximumValueEnabled,
            'isRestValueEnabled': limits.isRestValueEnabled,
        }))
    try:
        for limits, state in plan:
            _assembly_limits_write(limits, state)
    except Exception as error:
        errors: list[str] = []
        for limits, state in reversed(saved):
            for prop in _ASSEMBLY_LIMIT_FLAGS:
                try:
                    if prop == 'isMinimumValueEnabled':
                        limits.isMinimumValueEnabled = False
                    elif prop == 'isMaximumValueEnabled':
                        limits.isMaximumValueEnabled = False
                    else:
                        limits.isRestValueEnabled = False
                except Exception as restore_error:
                    errors.append(prop + ': ' + str(restore_error))
            for prop in _ASSEMBLY_LIMIT_VALUES:
                try:
                    if prop == 'minimumValue':
                        limits.minimumValue = _assembly_fusion_cast(float, state[prop])
                    elif prop == 'maximumValue':
                        limits.maximumValue = _assembly_fusion_cast(float, state[prop])
                    else:
                        limits.restValue = _assembly_fusion_cast(float, state[prop])
                except Exception as restore_error:
                    errors.append(prop + ': ' + str(restore_error))
            for prop in _ASSEMBLY_LIMIT_FLAGS:
                try:
                    if prop == 'isMinimumValueEnabled':
                        limits.isMinimumValueEnabled = _assembly_fusion_cast(bool, state[prop])
                    elif prop == 'isMaximumValueEnabled':
                        limits.isMaximumValueEnabled = _assembly_fusion_cast(bool, state[prop])
                    else:
                        limits.isRestValueEnabled = _assembly_fusion_cast(bool, state[prop])
                except Exception as restore_error:
                    errors.append(prop + ': ' + str(restore_error))
            try:
                if (limits.minimumValue != state['minimumValue'] or
                        limits.maximumValue != state['maximumValue'] or
                        limits.restValue != state['restValue'] or
                        limits.isMinimumValueEnabled != state['isMinimumValueEnabled'] or
                        limits.isMaximumValueEnabled != state['isMaximumValueEnabled'] or
                        limits.isRestValueEnabled != state['isRestValueEnabled']):
                    errors.append('Restored limits differ from original state')
            except Exception as read_error:
                errors.append(str(read_error))
        actual = None
        try:
            actual = _assembly_limits_read(motion)
        except Exception as read_error:
            errors.append('Readback: ' + str(read_error))
        raise RuntimeError('Joint limits mutation failed: ' + json.dumps({
            'error': str(error), 'rollback': {'restored': not errors, 'errors': errors},
            'limits': actual, 'atomic': False})) from error


def _assembly_joint_line(ctx: "CadContext", name: str, component: 'adsk.fusion.Component',
                         point: list[int | float], axis: list[float]) -> 'tuple[adsk.fusion.SketchLine, "JsonObject"]':
    # A sketch line along the requested axis is the carrier for a JointOrigin Z
    # axis. Fusion silently drops both ConstructionAxis and SketchLine handed to
    # an AsBuiltJoint custom direction entity, so a full (non-as-built) Joint's
    # JointOriginInput.zAxisEntity is used instead; it requires a linear edge in
    # the same component. The line also carries the sign through point order.
    direction = _cad_direction(axis)
    reference = [0.0, 1.0, 0.0] if abs(direction[0]) > 0.9 else [1.0, 0.0, 0.0]
    side = _cad_direction([direction[1] * reference[2] - direction[2] * reference[1],
                           direction[2] * reference[0] - direction[0] * reference[2],
                           direction[0] * reference[1] - direction[1] * reference[0]])
    positions = {'lineStart': point,
                 'lineEnd': [a + b for a, b in zip(point, direction)],
                 'lineSide': [a + b for a, b in zip(point, side)]}
    saved = ctx.component, ctx.occurrence
    ctx.component, ctx.occurrence = component, None
    try:
        for suffix in positions:
            _cad_datum_name(ctx, {'name': name + '__' + suffix}, component.constructionPoints)
        _cad_datum_name(ctx, {'name': name + '__linePlane'}, component.constructionPlanes)
        _cad_datum_name(ctx, {'name': name + '__lineSketch'}, component.sketches)
        point_refs: dict[str, "JsonValue"] = {
            suffix: _cad_datum_point(ctx, {
                'name': name + '__' + suffix,
                'point': [str(v) + ' cm' for v in position]})
            for suffix, position in positions.items()}
        plane_input = component.constructionPlanes.createInput()
        _cad_require_result(plane_input.setByThreePoints(
            *[ctx.resolve(ref, 'point') for ref in point_refs.values()]),
                            'Define joint axis sketch plane')
        plane = _cad_require_result(component.constructionPlanes.add(plane_input), 'Create joint axis sketch plane')
        plane.name = name + '__linePlane'
        ctx.created.append(ctx.ref(plane))
        sketch = _cad_require_result(component.sketches.addWithoutEdges(plane), 'Create joint axis sketch')
        sketch.name = name + '__lineSketch'
        ctx.created.append(ctx.ref(sketch))
        line = _cad_require_result(sketch.sketchCurves.sketchLines.addByTwoPoints(
            _assembly_fusion_cast('adsk.core.Point3D', adsk.core.Point3D.create(*positions['lineStart'])),
            _assembly_fusion_cast('adsk.core.Point3D', adsk.core.Point3D.create(*positions['lineEnd']))),
            'Create joint axis sketch line')
    finally:
        ctx.component, ctx.occurrence = saved
    return line, {'sketch': ctx.ref(sketch), 'plane': ctx.ref(plane), 'line': ctx.ref(line),
                  'points': list(point_refs.values())}


def _assembly_joint_origin(ctx: "CadContext", name: str, occurrence: 'adsk.fusion.Occurrence',
                           point_root: list[int | float], axis_root: list[int | float]) -> 'tuple[adsk.fusion.JointOrigin, "JsonObject"]':
    # Build one JointOrigin in the occurrence's component whose primary (Z) axis
    # is pinned to the requested root-frame direction. The origin sits on the
    # axis line and its Z axis is a sketch line along the axis. This is the only
    # reliable way to persist a custom axis, unlike point-based AsBuiltJoint
    # geometry, which is position-only and drops custom direction entities.
    component = occurrence.component
    conversion = _entity_inverse(_entity_occurrence_matrix(ctx, occurrence))
    local_point = _entity_xyz(conversion, point_root)
    local_axis = _cad_direction(_entity_xyz(conversion, axis_root, True))
    # Fusion orients a JointOrigin primary (Z) axis OPPOSITE to its zAxisEntity
    # sketch line direction (native evidence: a line drawn (0,0,0)->(1,0,0) reads
    # back rotationAxisVector [-1,0,0]). Draw the carrier line along -axis so the
    # read-back sign matches the requested direction.
    line, helpers = _assembly_joint_line(ctx, name, component, local_point, [-v for v in local_axis])
    geometry = _cad_require_result(adsk.fusion.JointGeometry.createByPoint(line.startSketchPoint), 'Joint origin geometry')
    origin_input = _cad_require_result(component.jointOrigins.createInput(geometry), 'Joint origin input')
    origin_input.zAxisEntity = line
    origin = _cad_require_result(component.jointOrigins.add(origin_input), 'Create joint origin')
    ctx.created.append(ctx.ref(origin))
    helpers['origin'] = ctx.ref(origin)
    return origin, helpers


def _assembly_regular_joint_origin(
        ctx: "CadContext", ref: "JsonValue", occurrence: 'adsk.fusion.Occurrence',
        label: str) -> 'tuple[dict[str, adsk.core.Base], list["JsonValue"]]':
    if not isinstance(ref, dict):
        raise ValueError(label + ' must be {ref:JointOrigin} or {point,xAxis,zAxis}')
    reference = ref
    if set(reference) == {'ref'}:
        origin = ctx.resolve(reference['ref'], 'JointOrigin')
        if _cad_owner(origin) != occurrence.component or getattr(origin, 'assemblyContext', None) is not None:
            raise ValueError(label + ' JointOrigin must be native to the matching input component')
        return {'origin': origin}, [ctx.ref(origin)]
    _cad_fields(reference, ('point', 'xAxis', 'zAxis'))
    point = ctx.resolve(reference['point'])
    x_axis = ctx.resolve(reference['xAxis'])
    z_axis = ctx.resolve(reference['zAxis'])
    for entity, expected in ((point, ('ConstructionPoint', 'SketchPoint', 'BRepVertex')),
                             (x_axis, ('ConstructionAxis', 'SketchLine', 'BRepEdge')),
                             (z_axis, ('ConstructionAxis', 'SketchLine', 'BRepEdge'))):
        if _cad_type(entity) not in expected or _cad_owner(entity) != occurrence.component or \
                getattr(entity, 'assemblyContext', None) is not None:
            raise ValueError(label + ' point and axes must be native references owned by the matching input component')
    return {'point': point, 'xAxis': x_axis, 'zAxis': z_axis}, [ctx.ref(point), ctx.ref(x_axis), ctx.ref(z_axis)]


def _assembly_regular_joint_origin_context(
        ctx: "CadContext", source: 'dict[str, adsk.core.Base]',
        occurrence: 'adsk.fusion.Occurrence', label: str) -> 'tuple[adsk.fusion.JointOrigin, list["JsonValue"]]':
    if 'origin' in source:
        origin = _assembly_fusion_cast('adsk.fusion.JointOrigin', source['origin'])
        return _cad_require_result(origin.createForAssemblyContext(occurrence), label + ' occurrence context'), [
            ctx.ref(origin)]
    geometry = _cad_require_result(adsk.fusion.JointGeometry.createByPoint(source['point']), label + ' geometry')
    origin_input = _cad_require_result(occurrence.component.jointOrigins.createInput(geometry), label + ' input')
    origin_input.xAxisEntity = source['xAxis']
    origin_input.zAxisEntity = source['zAxis']
    origin = _cad_require_result(occurrence.component.jointOrigins.add(origin_input), label + ' JointOrigin')
    ctx.created.append(ctx.ref(origin))
    return _cad_require_result(origin.createForAssemblyContext(occurrence), label + ' occurrence context'), [
        ctx.ref(source['point']), ctx.ref(source['xAxis']), ctx.ref(source['zAxis']), ctx.ref(origin)]


def _assembly_pose_snapshot(ctx: "CadContext") -> dict[str, list[int | float]]:
    rows: dict[str, list[int | float]] = {}
    for occurrence in _cad_items(ctx.root.allOccurrences):
        path = occurrence.fullPathName
        if path in rows:
            raise ValueError('Occurrence paths must be unique for pose protection: ' + path)
        rows[path] = _entity_occurrence_matrix(ctx, occurrence)
    return rows




def _assembly_joint_rigid_regular(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('name', 'mode', 'occurrenceOne', 'occurrenceTwo', 'confirm', 'originOne', 'originTwo',
                       'posePolicy', 'linearTolerance', 'angularTolerance'),
                ('angle', 'offset', 'isFlipped', 'groundingPolicy'))
    if data['confirm'] is not True:
        raise ValueError('Regular rigid joint requires confirm: true')
    if data['posePolicy'] not in ('preserve', 'moveSecond'):
        raise ValueError('posePolicy must be preserve or moveSecond')
    if data.get('groundingPolicy', 'reject') != 'reject':
        raise ValueError('groundingPolicy accepts only reject; automatic ungrounding is unsupported')
    if 'isFlipped' in data and type(data['isFlipped']) is not bool:
        raise ValueError('isFlipped must be boolean')
    angle = _assembly_fusion_cast(str, data.get('angle', '0 deg'))
    offset = _assembly_fusion_cast(str, data.get('offset', '0 mm'))
    ctx.angle(angle)
    ctx.length(offset)
    linear_tolerance = ctx.length(data['linearTolerance'])
    angular_tolerance = ctx.angle(data['angularTolerance'])
    if not math.isfinite(linear_tolerance) or linear_tolerance <= 0:
        raise ValueError('linearTolerance must be a positive finite length')
    if not math.isfinite(angular_tolerance) or angular_tolerance <= 0:
        raise ValueError('angularTolerance must be a positive finite angle')
    name = _assembly_name(data['name'])
    one, two = [_datum_occurrence_ref(ctx, data[k])
                for k in ('occurrenceOne', 'occurrenceTwo')]
    if one == two:
        raise ValueError('Regular rigid joint requires distinct occurrences')
    if one.fullPathName.startswith(two.fullPathName + '+') or two.fullPathName.startswith(one.fullPathName + '+'):
        raise ValueError('Regular rigid joint cannot connect an occurrence to its ancestor')
    for occurrence in (one, two):
        native = getattr(occurrence, 'nativeObject', None) or occurrence
        if getattr(native, 'isGrounded', False) or getattr(native, 'isGroundToParent', False):
            raise ValueError('Regular rigid joint rejects grounded input occurrences; it never ungrounds automatically')
    for component in _cad_items(ctx.design.allComponents):
        for collection_name in ('joints', 'asBuiltJoints'):
            collection = _assembly_fusion_cast(
                '_CadItemCollection[adsk.fusion.Joint | adsk.fusion.AsBuiltJoint] | None',
                getattr(component, collection_name, None))
            if collection is not None and any(existing.name == name for existing in _cad_items(collection)):
                raise ValueError('Joint name already exists: ' + name)
    _assembly_capture_ready(ctx)
    before = _assembly_pose_snapshot(ctx)
    source_one, refs_one = _assembly_regular_joint_origin(ctx, data['originOne'], one, 'originOne')
    source_two, refs_two = _assembly_regular_joint_origin(ctx, data['originTwo'], two, 'originTwo')
    origin_one, refs_one = _assembly_regular_joint_origin_context(ctx, source_one, one, 'originOne')
    origin_two, refs_two = _assembly_regular_joint_origin_context(ctx, source_two, two, 'originTwo')
    joints = ctx.root.joints
    native_origins = (origin_two, origin_one) if data['posePolicy'] == 'moveSecond' else (origin_one, origin_two)
    inp = _cad_require_result(joints.createInput(*native_origins), 'Regular rigid joint input')
    _cad_require_result(inp.setAsRigidJointMotion(), 'Define regular rigid joint')
    inp.angle = adsk.core.ValueInput.createByString(angle)
    inp.offset = adsk.core.ValueInput.createByString(offset)
    inp.isFlipped = _assembly_fusion_cast(bool, data.get('isFlipped', False))
    joint = _cad_require_result(joints.add(inp), 'Create regular rigid joint')
    ctx.created.append(ctx.ref(joint))
    joint.name = name
    _cad_require_result(ctx.design.computeAll(), 'Recompute regular rigid joint')
    if _assembly_fusion_cast(object, joint.healthState) != adsk.fusion.FeatureHealthStates.HealthyFeatureHealthState:
        raise RuntimeError('Regular rigid joint is unhealthy; created joint retained for inspection')
    after = _assembly_pose_snapshot(ctx)
    if set(before) != set(after):
        raise RuntimeError('Occurrence set changed while creating regular rigid joint; inspect partial changes')
    second_path = two.fullPathName
    pose_rows: list["JsonObject"] = []
    violations: list["JsonObject"] = []
    for path in before:
        linear_delta, angular_delta = _assembly_pose_delta(before[path], after[path])
        allowed = data['posePolicy'] == 'moveSecond' and (path == second_path or path.startswith(second_path + '+'))
        within = allowed or (linear_delta <= linear_tolerance and angular_delta <= angular_tolerance)
        row: "JsonObject" = {'path': path, 'linearDelta': linear_delta, 'angularDelta': angular_delta,
                              'allowedMove': allowed, 'withinTolerance': within}
        pose_rows.append(row)
        if not within:
            violations.append(row)
    if violations:
        raise RuntimeError('Regular rigid joint pose policy was violated; joint retained for inspection: ' +
                           json.dumps({'joint': ctx.ref(joint), 'posePolicy': data['posePolicy'],
                                        'violations': violations, 'automaticRestore': False}))
    result = _assembly_joint(ctx, {'joint': ctx.ref(joint)}, 'inspect')
    result.update(type='rigid', mode='regular', asBuilt=False, posePolicy=data['posePolicy'],
                  poses=pose_rows, originOne=refs_one, originTwo=refs_two,
                  requestedOccurrences=[ctx.ref(one), ctx.ref(two)],
                  requested={'angle': angle, 'offset': offset, 'isFlipped': data.get('isFlipped', False)},
                  linearTolerance=linear_tolerance, angularTolerance=angular_tolerance,
                  poseUnits={'linear': 'cm', 'angular': 'rad'}, groundingPolicy='reject',
                  associativity='native JointOrigins')
    return result


def _assembly_joint(ctx: "CadContext", data: "JsonObject",
                    mode: str) -> "JsonObject":
    _datum_version(data)
    if mode == 'rigid':
        rigid_mode = data.get('mode', 'asBuilt')
        if rigid_mode == 'regular':
            return _assembly_joint_rigid_regular(ctx, data)
        if rigid_mode != 'asBuilt':
            raise ValueError('joint.rigid mode must be asBuilt or regular')
    if mode in ('inspect', 'edit', 'drive', 'limits'):
        _cad_fields(data, ('joint',), () if mode == 'inspect' else (
            ('name', 'suppressed') if mode == 'edit' else (
                ('limits', 'confirm') if mode == 'limits' else ('rotation', 'slide'))))
        # Core tokens are authoritative and support Joint/AsBuiltJoint without kind enumeration.
        joint_entity = ctx.resolve(data['joint'])
        joint_kind = _cad_type(joint_entity)
        if joint_kind not in ('Joint', 'AsBuiltJoint'):
            raise ValueError('joint must resolve to a Joint or AsBuiltJoint token reference')
        joint = _assembly_fusion_cast(
            'adsk.fusion.Joint | adsk.fusion.AsBuiltJoint', joint_entity)
        if mode != 'inspect':
            if getattr(joint, 'assemblyContext', None) is not None:
                raise ValueError('Mutations require a native joint, not an occurrence proxy')
            owner = _cad_owner(joint)
            if owner not in _cad_items(ctx.design.allComponents):
                raise ValueError('Joint must belong to a native component in this design')
            if any(o.component == owner and o.isReferencedComponent for o in _cad_items(ctx.root.allOccurrences)):
                raise ValueError('External referenced joints are unsupported')
        if mode == 'edit':
            if not any(k in data for k in ('name', 'suppressed')):
                raise ValueError('Specify name or suppressed')
            if 'name' in data:
                _assembly_name(data['name'])
            if 'suppressed' in data and type(data['suppressed']) is not bool:
                raise ValueError('suppressed must be boolean')
            if 'suppressed' in data:
                if _assembly_fusion_cast(object, ctx.design.designType) != adsk.fusion.DesignTypes.ParametricDesignType:
                    raise ValueError('Suppression requires parametric history')
                suppressed = _assembly_fusion_cast(bool, data['suppressed'])
                if joint_kind == 'Joint':
                    _assembly_fusion_cast('adsk.fusion.Joint', joint).isSuppressed = suppressed
                else:
                    _assembly_fusion_cast('adsk.fusion.AsBuiltJoint', joint).isSuppressed = suppressed
            if 'name' in data:
                joint_name = _assembly_name(data['name'])
                if joint_kind == 'Joint':
                    _assembly_fusion_cast('adsk.fusion.Joint', joint).name = joint_name
                else:
                    _assembly_fusion_cast('adsk.fusion.AsBuiltJoint', joint).name = joint_name
        motion = joint.jointMotion
        if mode == 'limits':
            ctx.require_confirm(data)
            if 'limits' not in data:
                raise ValueError('Specify limits; use joint.inspect for read-only inspection')
            plan = _assembly_limits_plan(
                ctx, motion, _assembly_fusion_cast('JsonObject', data['limits']))
            _assembly_capture_ready(ctx)
            _assembly_limits_apply(motion, plan)
        snapshot: "JsonValue" = None
        coordinate_readback: "JsonObject" = {}
        if mode == 'drive':
            if not any(k in data for k in ('rotation', 'slide')):
                raise ValueError('Specify rotation or slide')
            values: dict[str, float] = {}
            for key, prop, evaluator in (('rotation', 'rotationValue', ctx.angle), ('slide', 'slideValue', ctx.length)):
                if key in data:
                    if not hasattr(motion, prop):
                        raise ValueError('Joint motion does not support ' + key)
                    value = evaluator(data[key])
                    if not math.isfinite(value):
                        raise ValueError(key + ' must be finite')
                    limits = (_assembly_fusion_cast(_AssemblyRotationLimits, motion).rotationLimits
                              if key == 'rotation' else
                              _assembly_fusion_cast(_AssemblySlideLimits, motion).slideLimits)
                    if (limits.isMinimumValueEnabled and value < limits.minimumValue) or (limits.isMaximumValueEnabled and value > limits.maximumValue):
                        raise ValueError(key + ' is outside joint limits')
                    values[prop] = value
            parametric = _assembly_capture_ready(ctx)
            for prop, value in values.items():
                setattr(motion, prop, value)
            coordinate_readback = {'evaluated': dict(values), 'beforeCapture': {
                prop: _assembly_fusion_cast(float, getattr(motion, prop)) for prop in values}}
            snapshot = _assembly_capture(ctx, parametric)
        result: "JsonObject" = _assembly_fusion_cast('JsonObject', {
                  'joint': ctx.describe(joint), 'motionType': _cad_type(motion),
                  'occurrences': [ctx.ref(o) if o else None
                                  for o in (joint.occurrenceOne, joint.occurrenceTwo)],
                  'limits': _assembly_limits_read(motion), 'units': 'cm/rad',
                  'parametricExpressions': False,
                  'scope': 'occurrence proxy' if getattr(joint, 'assemblyContext', None) is not None else
                           'native component definition; affects all instances'})
        if hasattr(motion, 'rotationValue'):
            result['rotationValue'] = _assembly_fusion_cast(
                _AssemblyRotationValue, motion).rotationValue
        if hasattr(motion, 'slideValue'):
            result['slideValue'] = _assembly_fusion_cast(
                _AssemblySlideValue, motion).slideValue
        if mode == 'drive':
            result.update(snapshot=snapshot, units='cm/rad', parametricExpressions=False,
                          coordinateReadback=coordinate_readback)
        return result
    optional = ('limits', 'confirm', 'point', 'axis', 'frame', 'associativity', 'schemaVersion')
    if mode == 'rigid':
        optional += ('mode',)
    _cad_fields(data, ('name', 'occurrenceOne', 'occurrenceTwo'), optional)
    if 'frame' in data:
        return _datum_joint_create(ctx, data, mode)
    if 'associativity' in data:
        raise ValueError('associativity is only an input for frame-derived joint helpers')
    if mode != 'rigid' and not all(k in data for k in ('point', 'axis')):
        raise ValueError('Joint requires point and axis, or an explicit frame')
    if mode == 'rigid' and any(k in data for k in ('point', 'axis')):
        raise ValueError('Rigid joint does not accept point or axis')
    if 'limits' in data:
        ctx.require_confirm(data)
        if mode == 'rigid':
            raise ValueError('Rigid joints do not support limits')
    elif 'confirm' in data:
        ctx.require_confirm(data)
    name = _assembly_name(data['name'])
    one, two = [_datum_occurrence_ref(ctx, data[k])
                for k in ('occurrenceOne', 'occurrenceTwo')]
    if one == two:
        raise ValueError('Joint requires distinct occurrences')
    if one.fullPathName.startswith(two.fullPathName + '+') or two.fullPathName.startswith(one.fullPathName + '+'):
        raise ValueError('Joint cannot connect an occurrence to its ancestor')
    if any(j.name == name for j in _cad_items(ctx.root.asBuiltJoints)):
        raise ValueError('Joint name already exists: ' + name)
    geometry: 'adsk.fusion.JointGeometry | None' = None
    custom_axis: 'adsk.fusion.ConstructionAxis | None' = None
    requested_axis: list[float] | None = None
    axis_origin_root: list[int | float] | None = None
    states: list[tuple[str, dict[str, float | bool]]] = []
    helpers_one: "JsonObject" = {}
    helpers_two: "JsonObject" = {}
    if mode != 'rigid':
        if isinstance(data['axis'], dict):
            axis_data = data['axis']
            if 'vector' in axis_data:
                raise ValueError('custom vectors are unsupported; create a datum axis first')
            _cad_fields(axis_data, ('ref',))
            custom_axis_entity = ctx.resolve(axis_data['ref'])
            if _cad_type(custom_axis_entity) != 'ConstructionAxis':
                raise ValueError('Custom joint axis must be an explicit ConstructionAxis reference')
            custom_axis = _assembly_fusion_cast('adsk.fusion.ConstructionAxis', custom_axis_entity)
            axis_context = _assembly_fusion_cast(
                'adsk.fusion.Occurrence | None', custom_axis.assemblyContext)
            if not ((_cad_owner(custom_axis) == ctx.root and axis_context is None) or axis_context in (one, two)):
                raise ValueError('Custom axis must belong to root or an input occurrence context')
            native_axis = (_assembly_fusion_cast(
                'adsk.fusion.ConstructionAxis | None',
                getattr(custom_axis, 'nativeObject', None)) or custom_axis)
            axis_geometry = _assembly_fusion_cast(
                'adsk.core.InfiniteLine3D | adsk.core.Line3D | None', native_axis.geometry)
            if axis_geometry is None or _cad_type(axis_geometry) not in ('InfiniteLine3D', 'Line3D'):
                raise ValueError('Custom joint axis requires line geometry (InfiniteLine3D)')
            axis_geometry = _assembly_fusion_cast(_AssemblyLinearCurve, axis_geometry)
            conversion = _entity_owner_matrix(ctx, _cad_owner(custom_axis), axis_context)
            requested_axis = _cad_direction(
                _entity_xyz(conversion, _cad_xyz(axis_geometry.direction), True))
            axis_origin_root = _entity_xyz(conversion, _cad_xyz(axis_geometry.origin))
        elif data['axis'] not in ('X', 'Y', 'Z'):
            raise ValueError('custom vectors are unsupported; axis must be X, Y, Z or {ref:constructionAxis}')
        point_entity = (ctx.root.originConstructionPoint if data['point'] == 'origin'
                        else ctx.resolve(data['point']))
        if _cad_type(point_entity) not in ('ConstructionPoint', 'SketchPoint', 'BRepVertex'):
            raise ValueError('point must be a construction/sketch point or BRep vertex')
        point = _assembly_fusion_cast(
            'adsk.fusion.ConstructionPoint | adsk.fusion.SketchPoint | adsk.fusion.BRepVertex',
            point_entity)
        context = _assembly_fusion_cast('adsk.fusion.Occurrence | None', point.assemblyContext)
        if not ((_cad_owner(point) == ctx.root and context is None) or
                (context in (one, two) and _cad_owner(point) == context.component)):
            raise ValueError('Joint point must be in root or one of the two occurrence contexts')
        if custom_axis is None:
            geometry = _cad_require_result(adsk.fusion.JointGeometry.createByPoint(point), 'Joint geometry')
    _assembly_capture_ready(ctx)
    if custom_axis is not None:
        # Full (non-as-built) Joint via two explicit JointOrigins whose primary
        # (Z) axis is pinned to the requested direction. A full Joint MOVES
        # occurrenceTwo to mate with occurrenceOne (per angle/offset/isFlipped),
        # unlike the pose-preserving AsBuiltJoint used for X/Y/Z axes.
        point_on_axis = _assembly_fusion_cast('list[int | float]', axis_origin_root)
        axis_direction = _assembly_fusion_cast('list[int | float]', requested_axis)
        origin_one, helpers_one = _assembly_joint_origin(
            ctx, name + '__one', one, point_on_axis, axis_direction)
        origin_two, helpers_two = _assembly_joint_origin(
            ctx, name + '__two', two, point_on_axis, axis_direction)
        joint_one = _cad_require_result(origin_one.createForAssemblyContext(one), 'Create joint origin context')
        joint_two = _cad_require_result(origin_two.createForAssemblyContext(two), 'Create joint origin context')
        joints = ctx.root.joints
        inp = _cad_require_result(joints.createInput(joint_one, joint_two), 'Joint input')
        _cad_require_result(_assembly_set_joint_motion(
            _assembly_fusion_cast(_AssemblyJointInput, inp),
            _assembly_fusion_cast("_assembly_fusion_Literal['revolute', 'slider', 'cylindrical']", mode),
            _assembly_fusion_cast('adsk.fusion.JointDirections',
                                  adsk.fusion.JointDirections.ZAxisJointDirection)),
            'Define joint motion')
        if 'limits' in data:
            limits_data = _assembly_fusion_cast('JsonObject', data['limits'])
            plan = _assembly_limits_plan(
                ctx, inp.jointMotion, limits_data)
            states = [(axis, state) for axis, (_, state) in zip(limits_data, plan)]
        joint = _cad_require_result(joints.add(inp), 'Create joint')
    else:
        joints = ctx.root.asBuiltJoints
        inp = _cad_require_result(joints.createInput(
            one, two, _assembly_fusion_cast('adsk.fusion.JointGeometry', geometry)),
            'As-built joint input')
        direction = (_assembly_joint_direction('Z') if mode == 'rigid' else
                     _assembly_joint_direction(_assembly_fusion_cast(str, data['axis'])))
        _cad_require_result(_assembly_set_joint_motion(
            _assembly_fusion_cast(_AssemblyJointInput, inp),
            _assembly_fusion_cast("_assembly_fusion_Literal['rigid', 'revolute', 'slider', 'cylindrical']", mode),
            direction), 'Define joint motion')
        if 'limits' in data:
            # Validate against input defaults before add, but never rely on native limit transfer.
            limits_data = _assembly_fusion_cast('JsonObject', data['limits'])
            plan = _assembly_limits_plan(
                ctx, inp.jointMotion, limits_data)
            states = [(axis, state) for axis, (_, state) in zip(limits_data, plan)]
        joint = _cad_require_result(joints.add(inp), 'Create as-built joint')
    ctx.created.append(ctx.ref(joint))
    joint.name = name
    if 'limits' in data:
        motion = joint.jointMotion
        try:
            _assembly_limits_apply(motion, [(
                _assembly_fusion_cast(_AssemblyRotationLimits, motion).rotationLimits
                if axis == 'rotation' else
                _assembly_fusion_cast(_AssemblySlideLimits, motion).slideLimits, state)
                for axis, state in states])
        except Exception as error:
            raise RuntimeError('Created joint limit application failed: ' + json.dumps({
                'joint': ctx.ref(joint), 'atomic': False, 'createdJointRetained': True,
                'error': str(error)})) from error
    result = _assembly_joint(ctx, {'joint': ctx.ref(joint)}, 'inspect')
    actual_limits = _assembly_fusion_cast('dict[str, dict[str, float | bool | str]]', result['limits'])
    if 'limits' in data and any(actual_limits[axis][prop] != value
                              for axis, state in states for prop, value in state.items()):
        raise RuntimeError('Created joint limits differ from input: ' + json.dumps({
            'joint': ctx.ref(joint), 'limits': actual_limits, 'atomic': False,
            'rollback': {'restored': False, 'errors': ['Created joint retained; inspect before continuing']}}))
    result.update(type=mode, asBuilt=custom_axis is None)
    if custom_axis is not None:
        result['directionEntity'] = [helpers_one, helpers_two]
    if 'schemaVersion' not in data and custom_axis is None and '+' not in one.fullPathName and '+' not in two.fullPathName:
        return result
    result['frameDiagnostics'] = _assembly_fusion_cast(
        'JsonValue', _datum_joint_frame(ctx, {'joint': ctx.ref(joint)}))
    result = _datum_contract(
        ctx, 'joint.' + mode, result, 'nativeReference', frame='root',
                             limitations=['As-built joint preserves current pose; motion limits are evaluated snapshots.' if custom_axis is None else
                                          'Custom-axis joints use a full Joint: occurrenceTwo is moved to mate with occurrenceOne (pose is not preserved), and each joint origin is placed on the requested axis line.'])
    if requested_axis is not None:
        # Read the motion axis back from the CREATED joint (never from the input,
        # where it is null). Fusion has no supported way to orient a point-based
        # AsBuiltJoint origin, so a full Joint with Z-axis-pinned JointOrigins is
        # used instead; still verify rotationAxisVector/slideDirectionVector after
        # create and treat signedDot < 1 as a fail.
        warnings = _assembly_fusion_cast(list[str], result.get('warnings', []))
        result.update(posePreserved=False,
                      warnings=warnings + [
                          'Custom-axis joints are full Joints: occurrenceTwo is repositioned to mate with occurrenceOne (pose is not preserved).'])
        frame_diagnostics = _assembly_fusion_cast('JsonObject', result['frameDiagnostics'])
        motion_axes = _assembly_fusion_cast('JsonObject', frame_diagnostics['motionAxes'])
        actual_axis = _assembly_fusion_cast(
            list[float] | None,
            motion_axes.get('slideDirectionVector' if mode == 'slider' else 'rotationAxisVector'))
        dot = sum(a*b for a, b in zip(requested_axis, actual_axis)) if actual_axis is not None else None
        result['directionDiagnostics'] = {'requestedRoot': requested_axis, 'actualRoot': actual_axis, 'signedDot': dot}
        if dot is None:
            warnings = _assembly_fusion_cast(list[str], result.get('warnings', []))
            result.update(status='unknown',
                          warnings=warnings + ['Native motion axis is unavailable; sign has not been verified.'])
            _assembly_fusion_cast('JsonObject', result['provenance'])['nativeAcceptance'] = 'unverified'
        elif dot < 1 - 1e-8:
            warnings = _assembly_fusion_cast(list[str], result.get('warnings', []))
            result.update(success=False, status='fail',
                          warnings=warnings + ['Created joint axis/sign differs from the requested datum axis; joint retained for inspection.'])
            _assembly_fusion_cast('JsonObject', result['provenance'])['nativeAcceptance'] = 'failed'
    return result


def _assembly_misc(ctx: "CadContext", data: "JsonObject",
                   mode: str) -> "JsonObject":
    if mode == 'parts':
        _cad_fields(data)
        rows: list["JsonObject"] = []
        for component in _cad_items(ctx.design.allComponents):
            occurrences = [o for o in _cad_items(ctx.root.allOccurrences) if o.component == component]
            if occurrences:
                row: "JsonObject" = {'component': ctx.ref(component), 'quantity': len(occurrences),
                    'occurrences': [ctx.ref(o) for o in occurrences], 'bodyCount': component.bRepBodies.count}
                rows.append(row)
                imported = (_assembly_fusion_cast(
                    'JsonValue', _di_get(component, 'item')) if '_di_get' in globals() else None)
                if imported:
                    row['catalog'] = imported
        return {'parts': rows, 'scope': 'all occurrence paths, including subassemblies; root excluded; not a manufacturing BOM'}
    if mode in ('ground', 'unground'):
        _cad_fields(data, ('occurrence',))
        occurrence = _assembly_top(ctx, data['occurrence'])
        _assembly_capture_ready(ctx)
        grounded = mode == 'ground'
        occurrence.isGrounded = grounded
        # Fusion defaults newly created occurrences to ground-to-parent
        # (isGroundToParent), not the legacy root grounding (isGrounded); placement
        # refuses both, so clear both to actually unground.
        if hasattr(occurrence, 'isGroundToParent'):
            occurrence.isGroundToParent = grounded
        return {'occurrence': ctx.ref(occurrence), 'grounded': occurrence.isGrounded}
    _cad_fields(data, ('occurrences',), ('includeChildren', 'name'))
    if not isinstance(data['occurrences'], list) or len(data['occurrences']) < 2:
        raise ValueError('At least two occurrences are required')
    occurrences = [_assembly_top(ctx, r) for r in data['occurrences']]
    if any(o == previous for i, o in enumerate(occurrences) for previous in occurrences[:i]):
        raise ValueError('Duplicate occurrences')
    if type(data.get('includeChildren', False)) is not bool:
        raise ValueError('includeChildren must be boolean')
    if 'name' in data:
        _assembly_name(data['name'])
    _assembly_capture_ready(ctx)
    include_children = _assembly_fusion_cast(bool, data.get('includeChildren', False))
    group = _cad_require_result(ctx.root.rigidGroups.add(ctx.collection(occurrences), include_children), 'Create rigid group')
    if 'name' in data:
        group.name = _assembly_name(data['name'])
    ctx.created.append(ctx.ref(group))
    return {'rigidGroup': ctx.ref(group)}


def _assembly_feature_plan(ctx: "CadContext", data: "JsonObject") -> 'tuple[adsk.fusion.Feature, list[tuple[adsk.fusion.ModelParameter, str]]]':
    from typing import cast as _assembly_feature_cast

    _cad_fields(data, ('feature',), ('name', 'parameters'))
    feature = ctx.resolve(data['feature'], 'feature')
    if 'name' in data:
        _assembly_name(data['name'])
    changes = data.get('parameters', {})
    if not isinstance(changes, dict) or not changes and 'name' not in data:
        raise ValueError('Specify name or a nonempty parameters object keyed by model parameter name')
    parameters: 'list[adsk.fusion.ModelParameter]' = []
    for candidate in _cad_items(ctx.design.allParameters):
        if hasattr(candidate, 'createdBy'):
            parameter = _assembly_feature_cast('adsk.fusion.ModelParameter', candidate)
            if parameter.createdBy == feature:
                parameters.append(parameter)
    plan: 'list[tuple[adsk.fusion.ModelParameter, str]]' = []
    for name, expression in changes.items():
        parameter = _cad_unique([p for p in parameters if p.name == name], 'Feature parameter ' + name)
        if hasattr(ctx, 'expression'):
            _assembly_fusion_expression(ctx, expression, parameter.unit, parameter.unit == '')
        else:
            _assembly_feature_cast(
                'Callable[[object, str | None, bool], tuple[str, float]]',
                getattr(ctx, '_expression'))(expression, parameter.unit,
                                             parameter.unit == '')
        plan.append((parameter, _assembly_feature_cast(str, expression)))
    return feature, plan


def _assembly_history(ctx: "CadContext", data: "JsonObject", mode: str) -> "JsonValue":
    if mode == 'dependencies':
        return ctx.call('param.dependencies', data)
    if mode in ('edit', 'preview'):
        feature, plan = _assembly_feature_plan(ctx, data)
        changes = [{'parameter': p.name, 'before': p.expression, 'after': expression} for p, expression in plan]
        if mode == 'edit':
            for parameter, expression in plan:
                parameter.expression = expression
            if 'name' in data:
                feature.name = _assembly_fusion_cast(str, data['name'])
        return {'feature': ctx.describe(feature), 'parameters': changes, 'proposedName': data.get('name'),
                'applied': mode == 'edit', 'atomic': False, 'scope': 'feature name/model parameter expressions only; no geometry simulation or rebuild prediction'}
    if mode in ('inspect', 'suppress', 'unsuppress'):
        _cad_fields(data, ('feature',))
        feature = ctx.resolve(data['feature'], 'feature')
        if mode != 'inspect':
            if _assembly_fusion_cast(object, ctx.design.designType) != adsk.fusion.DesignTypes.ParametricDesignType:
                raise ValueError('Feature suppression requires parametric history')
            feature.isSuppressed = mode == 'suppress'
        return {'feature': ctx.describe(feature), 'parameters': [
            {'name': p.name, 'expression': p.expression, 'unit': p.unit}
            for p in _cad_items(ctx.design.allParameters) if getattr(p, 'createdBy', None) == feature]}
    if mode == 'check':
        return _assembly_history_check(ctx, data)
    _cad_fields(data)
    if mode == 'list':
        return {'features': [ctx.describe(f) for f in _cad_items(ctx.component.features)]}
    if mode == 'recompute':
        _cad_require_result(ctx.design.computeAll(), 'Recompute design')
    return _assembly_history_check(ctx, {}, recomputed=mode == 'recompute')


def _assembly_history_group(ctx: "CadContext", path: object) -> 'adsk.fusion.TimelineGroup':
    if not isinstance(path, str) or not path:
        raise ValueError('scope.group requires a nonempty timeline path')
    parts = path.split('/')
    if any(not part.isdecimal() or str(int(part)) != part for part in parts):
        raise ValueError('scope.group path must contain canonical zero-based indexes')
    items = _cad_items(ctx.design.timeline)
    item: 'adsk.fusion.TimelineObject | None' = None
    for depth, part in enumerate(parts):
        index = int(part)
        if index >= len(items):
            raise ValueError('scope.group path index is out of range')
        item = items[index]
        if depth < len(parts) - 1:
            if getattr(item, 'isGroup', False) is not True:
                raise ValueError('scope.group path crosses a non-group timeline item')
            group = _assembly_fusion_cast('adsk.fusion.TimelineGroup', item)
            items = [group.item(i) for i in range(group.count)]
    if getattr(item, 'isGroup', False) is not True:
        raise ValueError('scope.group must identify a TimelineGroup')
    return _assembly_fusion_cast('adsk.fusion.TimelineGroup', item)


def _assembly_history_check(ctx: "CadContext", data: "JsonObject",
                            recomputed: bool = False) -> "JsonObject":
    _cad_fields(data, optional=('scope', 'recursive', 'allowSuppressed'))
    recursive = data.get('recursive', True)
    if type(recursive) is not bool:
        raise ValueError('recursive must be boolean')
    scope = data.get('scope', 'root')
    owner = None
    if scope == 'root':
        items = _cad_items(ctx.design.timeline)
        scope_result = {'root': ctx.ref(ctx.root)}
    elif isinstance(scope, dict) and set(scope) == {'component'}:
        owner = ctx.resolve(scope['component'], 'component')
        items = _cad_items(ctx.design.timeline)
        scope_result = {'component': ctx.ref(owner)}
    elif isinstance(scope, dict) and set(scope) == {'group'}:
        group = _assembly_history_group(ctx, scope['group'])
        items = [group]
        scope_result = {'group': scope['group']}
    else:
        raise ValueError("scope must be 'root', {component:REF}, or {group:TIMELINE_PATH}")
    allowed_refs = data.get('allowSuppressed', [])
    if not isinstance(allowed_refs, list):
        raise ValueError('allowSuppressed must be an array of feature refs')
    allowed = [ctx.resolve(ref, 'feature') for ref in allowed_refs]
    rows = _measure_health(ctx, items, owner=owner, recursive=recursive,
                           allow_suppressed=allowed)
    leaves = [row for row in rows if not row.get('isGroup') and not row.get('duplicate')]
    unvisited = sum(_assembly_fusion_cast(int, row.get('unvisitedChildren', 0)) for row in rows)
    unknown_leaves = sum(not row.get('isGroup') and not row.get('duplicate') and
                         (row.get('state') == 'unknown' or owner is not None and
                          _assembly_fusion_cast(bool, row.get('ownerUnknown', False)))
                         for row in rows)
    healthy = _measure_health_passed(rows, require_owner=owner is not None) and not unvisited
    status = 'unknown' if unvisited or unknown_leaves else ('pass' if healthy else 'fail')
    return {'timeline': rows, 'markerPosition': ctx.design.timeline.markerPosition,
            'recomputed': recomputed, 'healthy': healthy, 'status': status,
            'recursive': recursive, 'scope': scope_result,
            'allowSuppressed': [ctx.ref(entity) for entity in allowed],
            'coverage': {'visitedLeaves': len(leaves), 'unknownLeaves': unknown_leaves,
                         'unvisitedChildren': unvisited}}


def _assembly_handler(
        function: "_assembly_fusion_Callable[[CadContext, JsonObject, str], JsonValue]",
        mode: str) -> "CadHandler":
    def handler(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
        return function(ctx, data, mode)
    return handler


for _family, _function, _modes in (
        ('component', _assembly_component, ('inspect', 'create', 'rename', 'reparent', 'from_bodies')),
        ('occurrence', _assembly_occurrence, ('add', 'duplicate', 'transform', 'align')),
        ('joint', _assembly_joint, ('rigid', 'revolute', 'slider', 'cylindrical', 'inspect', 'edit', 'drive', 'limits')),
        ('assembly', _assembly_misc, ('parts', 'ground', 'unground', 'rigid_group')),
        # feature.inspect/feature.edit are registered once by feature.py (GM09 v1)
        # with a payload-shape dispatch back to the legacy handlers below.
        ('feature', _assembly_history, ('list', 'suppress', 'unsuppress', 'dependencies')),
        ('history', _assembly_history, ('check', 'recompute')),
        ('change', _assembly_history, ('preview',))):
    CAD_HANDLERS.update({_family + '.' + mode: _assembly_handler(_function, mode) for mode in _modes})

_fmcad_assembly_runtime_loaded = True
