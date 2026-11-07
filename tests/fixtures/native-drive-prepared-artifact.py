import sys
import types
import builtins
import pathlib
import json
import os
import io
import math
import enum
import time
import re
import tempfile
import collections

adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
adsk.core.ValueInput = types.SimpleNamespace(createByString=lambda value: ('expression', value))
adsk.fusion.DesignTypes = types.SimpleNamespace(ParametricDesignType=1, DirectDesignType=0)
adsk.fusion.JointMotionTypes = types.SimpleNamespace(RevoluteJointRotateMotionType=10)
adsk.fusion.FeatureHealthStates = types.SimpleNamespace(HealthyFeatureHealthState=0)
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
payload = json.loads(sys.stdin.read())


def denied(*args, **kwargs):
    raise AssertionError('prepared runtime attempted checkout filesystem access')


builtins.open = denied
io.open = denied
os.open = denied
for method in ('open', 'read_text', 'read_bytes', 'is_file', 'exists', 'stat', 'iterdir', 'glob', 'rglob'):
    setattr(pathlib.Path, method, denied)

baseline_ns = {}
exec(compile(payload['baseline'], '<baseline-bundle>', 'exec'), baseline_ns)
ns = {}
exec(compile(payload['artifact'], '<prepared-python-artifact>', 'exec'), ns)
registry = ns['CAD_HANDLERS']
expected = payload['handlers']
assert set(registry) - set(baseline_ns['CAD_HANDLERS']) == set(expected)
for name in expected:
    assert callable(registry[name])
    assert registry.owners[name] == 'native-drive'
assert registry['mechanism.drive-test'] is ns['mechanism_drive_test']
assert registry['mechanism.motion-link.create'] is ns['mechanism_motion_link_create']


class Motion:
    objectType = 'adsk::fusion::RevoluteJointMotion'

    def __init__(self, value):
        self.rotationValue = value
        self.rotationLimits = types.SimpleNamespace(
            isMinimumValueEnabled=False,
            isMaximumValueEnabled=False,
        )


class Occurrence:
    def __init__(self, component, joint):
        self.component = component
        self.isReferencedComponent = False
        self.joint = joint

    @property
    def transform2(self):
        occurrence = self

        class Matrix:
            def asArray(self):
                values = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]
                values[12] = occurrence.joint.jointMotion.rotationValue
                return values

        return Matrix()


class Joint:
    objectType = 'adsk::fusion::Joint'
    isValid = True
    isSuppressed = False
    assemblyContext = None

    def __init__(self, component, value):
        self.parentComponent = component
        self.jointMotion = Motion(value)
        self.occurrenceOne = None
        self.occurrenceTwo = None


class MotionLinkInput:
    def __init__(self, one, two):
        self.jointOne, self.jointTwo = one, two
        self.isValid = True


class MotionLink:
    objectType = 'adsk::fusion::MotionLink'
    entityToken = 'native-motion-link'
    name = 'Native MotionLink'
    isValid = True
    isSuppressed = False

    def __init__(self, owner, request, health=0):
        self.parentComponent = owner
        self.jointOne, self.jointTwo = request.jointOne, request.jointTwo
        self.motionOne, self.motionTwo = request.motionOne, request.motionTwo
        self.isReversed = request.isReversed
        self.valueOne = self._parameter(request.valueOne)
        self.valueTwo = self._parameter(request.valueTwo)
        self.healthState = health
        self.errorOrWarningMessage = 'mock warning' if health else ''

    @staticmethod
    def _parameter(value):
        _, expression = value
        number, unit = expression.split()
        actual = float(number) * {'rad': 1.0, 'deg': math.pi / 180.0}[unit]
        return types.SimpleNamespace(value=actual, expression=expression)


class MotionLinks:
    def __init__(self, owner):
        self.owner = owner
        self.created = []
        self.health = 0

    def createInput(self, one, two):
        self.input = MotionLinkInput(one, two)
        return self.input

    def add(self, request):
        link = MotionLink(self.owner, request, self.health)
        self.created.append(link)
        return link


component = types.SimpleNamespace()
component.motionLinks = MotionLinks(component)
driver = Joint(component, 0.0)
follower = Joint(component, 0.3)
ground = Occurrence(component, driver)
driver_occurrence = Occurrence(component, driver)
follower_occurrence = Occurrence(component, follower)
driver.occurrenceOne, driver.occurrenceTwo = ground, driver_occurrence
follower.occurrenceOne, follower.occurrenceTwo = ground, follower_occurrence
doc = types.SimpleNamespace(creationId='artifact-scratch', name='scratch', isValid=True)
workspace = object()
ctx = types.SimpleNamespace(
    doc=doc,
    app=types.SimpleNamespace(
        activeDocument=doc,
        userInterface=types.SimpleNamespace(activeWorkspace=workspace, activeCommand=''),
    ),
    design=types.SimpleNamespace(designType=0, allComponents=[component], animationManager=None),
    root=types.SimpleNamespace(allOccurrences=[ground, driver_occurrence, follower_occurrence]),
    component=component,
    created=[],
    resolve=lambda ref: {'driver-ref': driver, 'follower-ref': follower}[
        ref.get('token') if isinstance(ref, dict) else ref
    ],
    require_confirm=lambda data: None,
    ref=lambda value: 'fixture-ref',
    angle=lambda expression: float(expression.split()[0]) * {'rad': 1.0, 'deg': math.pi / 180.0}[expression.split()[1]],
)
setter_targets = []


def call(operation, data):
    assert operation == 'joint.drive'
    setter_targets.append(data['joint'])
    driver.jointMotion.rotationValue = float(data['rotation'].split()[0])
    # Test-only fake solver response; the handler never assigns the follower.
    follower.jointMotion.rotationValue = -2 * driver.jointMotion.rotationValue + 0.3
    return {'rotationValue': 999.0}


ctx.call = call
request = {
    'schemaVersion': 1,
    'confirm': True,
    'driver': 'driver-ref',
    'waypoints': [0.02, 0.04, 0.06],
    'followers': [{
        'joint': 'follower-ref',
        'coordinate': 'rotation',
        'ratio': -2,
        'phase': 0.3,
        'tolerance': 1e-6,
    }],
}
result = registry['mechanism.drive-test'](ctx, request)
assert result['status'] == 'pass' and result['restore']['status'] == 'pass'
assert result['nativeCapability']['qualified'] is False
assert result['nativeCapability']['status'] == 'unknown'
assert len(setter_targets) == len(request['waypoints']) + 1
assert set(setter_targets) == {'driver-ref'}, 'handler assigned a follower or another joint'
assert abs(follower.jointMotion.rotationValue - 0.3) < 1e-12
assert result['capture'] == result['restore']['readback']
assert result['actualSolver']['samples'][0]['actual']['joints']['follower:0']['rotation'] != 999.0

motion_link_request = {
    'schemaVersion': 1,
    'frame': 'component',
    'confirm': True,
    'jointOne': {'kind': 'joint', 'token': 'driver-ref'},
    'jointTwo': {'kind': 'joint', 'token': 'follower-ref'},
    'valueOne': '1 rad',
    'valueTwo': '2 rad',
    'isReversed': True,
}
before_link_setters = len(setter_targets)
motion_link_result = registry['mechanism.motion-link.create'](ctx, motion_link_request)
assert motion_link_result['status'] == 'pass'
assert motion_link_result['nativeMotionLink'] is True
assert motion_link_result['qualified'] is False
assert motion_link_result['readback']['status'] == 'pass'
assert motion_link_result['readback']['isReversed'] is True
assert motion_link_result['readback']['values']['jointOne']['value'] == 1.0
assert motion_link_result['readback']['values']['jointTwo']['value'] == 2.0
assert len(component.motionLinks.created) == 1
assert len(setter_targets) == before_link_setters, 'MotionLink creation commanded a joint'

component.motionLinks.health = 1
unhealthy = registry['mechanism.motion-link.create'](ctx, {
    **motion_link_request,
    'isReversed': False,
})
assert unhealthy['status'] == 'fail'
assert unhealthy['createdLinkRetained'] is True
assert len(component.motionLinks.created) == 2
assert len(setter_targets) == before_link_setters

cancel_calls = []


def cancel():
    cancel_calls.append('cancel')
    return True


cancel_port = ns['_NativeDriveFusionPort'](
    ctx,
    ns['_native_drive_plan'](request),
    cancelled=cancel,
)
cancel_result = ns['_native_drive_run'](ns['_native_drive_plan'](request), cancel_port)
assert cancel_calls == ['cancel']
assert cancel_result['outcome'] == 'cancelled'
assert cancel_result['restore']['status'] == 'pass'
assert setter_targets[-1] == 'driver-ref'
assert len(setter_targets) == len(request['waypoints']) + 2
print(len(registry))
