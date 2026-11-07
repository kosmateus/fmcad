"""Offline mechanism and native-drive adapter contract tests with fake SDK objects."""
import json
import math
import types
import unittest

import model_test as model

NAMESPACE = dict(model.namespace)
NAMESPACE['CAD_HANDLERS'] = dict(model.HANDLERS)
exec(compile((model.ROOT / 'assets/cad/mechanism.py').read_text(), 'mechanism.py', 'exec'), NAMESPACE)
exec(compile((model.ROOT / 'runtime/python/fmcad/domain/native_drive.py').read_text(), 'native_drive_domain.py', 'exec'), NAMESPACE)
exec(compile((model.ROOT / 'runtime/python/fmcad/adapters/fusion/native_drive.py').read_text(), 'native_drive.py', 'exec'), NAMESPACE)
exec(compile((model.ROOT / 'runtime/python/fmcad/application/native_drive_handlers.py').read_text(), 'native_drive_handlers.py', 'exec'), NAMESPACE)
HANDLERS = NAMESPACE['CAD_HANDLERS']


class MotionLinkInput:
    def __init__(self, joint_one, joint_two):
        self.jointOne, self.jointTwo = joint_one, joint_two
        self.isValid = True
        self.motionOne = self.motionTwo = None
        self.valueOne = self.valueTwo = None
        self.isReversed = False


class MotionLink:
    def __init__(self, owner, motion_input, health_state=0):
        self.objectType = 'adsk::fusion::MotionLink'
        self.entityToken = 'native-motion-link'
        self.name = 'Native MotionLink'
        self.parentComponent = owner
        self.isValid = True
        self.isSuppressed = False
        self.jointOne, self.jointTwo = motion_input.jointOne, motion_input.jointTwo
        self.motionOne, self.motionTwo = motion_input.motionOne, motion_input.motionTwo
        self.isReversed = motion_input.isReversed
        self.valueOne = types.SimpleNamespace(value=angle_value(motion_input.valueOne),
                                              expression=motion_input.valueOne[1])
        self.valueTwo = types.SimpleNamespace(value=angle_value(motion_input.valueTwo),
                                              expression=motion_input.valueTwo[1])
        self.healthState = health_state
        self.errorOrWarningMessage = 'mock warning' if health_state else ''


def angle_value(value_input):
    _, expression = value_input
    number, unit = expression.split()
    return float(number) * {'rad': 1, 'deg': math.pi / 180}[unit]


class MotionLinks:
    def __init__(self, owner):
        self.owner = owner
        self.created_count = 0
        self.input = None
        self.health_state = 0

    def createInput(self, joint_one, joint_two):
        self.input = MotionLinkInput(joint_one, joint_two)
        return self.input

    def add(self, motion_input):
        self.created_count += 1
        return MotionLink(self.owner, motion_input, self.health_state)


def motion_link_context():
    owner = model.Entity('Component', name='MotionLinkOwner')
    links = MotionLinks(owner)
    owner.motionLinks = links
    owner.allOccurrences = []
    joints = [model.Entity('Joint', name='JointOne'), model.Entity('Joint', name='JointTwo')]
    for joint in joints:
        joint.parentComponent = owner
        joint.isValid = True
        joint.isSuppressed = False
        joint.jointMotion = types.SimpleNamespace(objectType='adsk::fusion::RevoluteJointMotion')
    context = model.Context()
    context.component = context.root = owner
    context.design = types.SimpleNamespace(allComponents=[owner], designType=0, animationManager=None)
    context.doc = types.SimpleNamespace(isValid=True, name='FMCAD_NATIVE_DRIVE_TEST', creationId='drive-test-doc')
    context.app = types.SimpleNamespace(activeDocument=context.doc,
                                        userInterface=types.SimpleNamespace(activeCommand='SelectCommand'))
    context.entities = {'joint-one': joints[0], 'joint-two': joints[1]}
    context.resolve = lambda ref, kind=None: context.entities[ref.get('token')]
    model.adsk.fusion.DesignTypes = types.SimpleNamespace(ParametricDesignType=1, DirectDesignType=0)
    model.adsk.fusion.JointMotionTypes = types.SimpleNamespace(RevoluteJointRotateMotionType=10)
    return context, links, joints


class MechanismTests(unittest.TestCase):
    def call(self, operation, data):
        return HANDLERS[operation](model.Context(), data)

    def test_catalog_and_manual_cover_mechanism_operations(self):
        catalog = json.loads((model.ROOT / 'src/catalog/mechanism.json').read_text())
        manual = json.loads((model.ROOT / 'src/manual/mechanism.json').read_text())
        self.assertEqual(set(catalog), set(manual))
        legacy = {'mechanism.couple', 'mechanism.inspect', 'mechanism.stop-check'}
        self.assertEqual(set(catalog), set(manual))
        self.assertTrue(legacy <= set(catalog))
        self.assertIn('mechanism.drive-test', catalog)
        for operation in legacy:
            entry = catalog[operation]
            self.assertTrue(entry['readOnly'])
            self.assertTrue(entry['envelope'])
        self.assertFalse(catalog['mechanism.drive-test']['readOnly'])
        self.assertTrue(catalog['mechanism.drive-test']['envelope'])
        self.assertFalse(catalog['mechanism.motion-link.create']['readOnly'])
        self.assertTrue(catalog['mechanism.motion-link.create']['documentPin'])
        self.assertFalse(catalog['mechanism.motion-link.create']['batchAllowed'])
        link_manual = manual['mechanism.motion-link.create']
        self.assertTrue(any(s['title'] == 'Mutation and Evidence Boundary' for s in link_manual['sections']))
        self.assertTrue(link_manual['audit']['sources'] and link_manual['audit']['tests'])
        for operation in legacy:
            entry = manual[operation]
            self.assertTrue(any(s['title'].startswith('Return Contract') for s in entry['sections']))
            self.assertIsInstance(entry['audit']['gaps'], list)
            self.assertIsInstance(entry['audit']['bugs'], list)
            self.assertTrue(entry['audit']['sources'] and entry['audit']['verified'] and entry['audit']['tests'])
        self.assertTrue(any(s['title'] == 'Driver-Only Sample' for s in manual['mechanism.drive-test']['sections']))
        self.assertIn('coordinated broker runtime', manual['mechanism.drive-test']['sections'][-1]['text'])

    def test_external_gear_flips_sign_and_unwraps(self):
        result = self.call('mechanism.couple', {'schemaVersion': 1, 'frame': 'component',
            'coupling': {'type': 'rotation', 'driverTeeth': 20, 'drivenTeeth': 40, 'external': True},
            'driverRange': {'from': '0 deg', 'to': '720 deg'}, 'samples': 16})
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['sign'], -1)
        self.assertAlmostEqual(result['ratio'], -0.5, places=12)
        track = result['evaluated']['track']
        self.assertTrue(result['evaluated']['unwrapped'])
        self.assertAlmostEqual(track[0]['driver']['value'], 0.0, places=9)
        self.assertAlmostEqual(track[-1]['driver']['value'], 4 * math.pi, places=6)
        self.assertAlmostEqual(track[-1]['driven']['value'], -2 * math.pi, places=6)

    def test_internal_gear_keeps_positive_ratio(self):
        result = self.call('mechanism.couple', {'schemaVersion': 1, 'frame': 'component',
            'coupling': {'type': 'rotation', 'driverTeeth': 40, 'drivenTeeth': 20, 'external': False},
            'driverRange': {'from': '0 deg', 'to': '360 deg'}})
        self.assertEqual(result['sign'], 1)
        self.assertAlmostEqual(result['ratio'], 2.0, places=12)

    def test_native_representation_does_not_infer_motion_link_from_api_presence(self):
        result = self.call('mechanism.couple', {'schemaVersion': 1, 'frame': 'component',
            'coupling': {'type': 'rotation', 'ratio': 1},
            'driverRange': {'from': '0 deg', 'to': '90 deg'}, 'representation': 'native'})
        self.assertEqual(result['status'], 'blocked')
        self.assertFalse(result['nativeMotionLink'])
        self.assertEqual(result['representation'], 'explicit')

    def test_native_motion_link_uses_documented_create_and_reads_back(self):
        context, links, joints = motion_link_context()
        request = {'schemaVersion': 1, 'frame': 'component', 'confirm': True,
                   'jointOne': {'kind': 'joint', 'token': 'joint-one'},
                   'jointTwo': {'kind': 'joint', 'token': 'joint-two'},
                   'valueOne': '1 rad', 'valueTwo': '2 rad', 'isReversed': True}
        result = HANDLERS['mechanism.motion-link.create'](context, request)
        self.assertEqual(links.created_count, 1)
        self.assertEqual(links.input.jointOne, joints[0])
        self.assertEqual(links.input.jointTwo, joints[1])
        self.assertEqual(links.input.motionOne, 10)
        self.assertEqual(links.input.motionTwo, 10)
        self.assertTrue(links.input.isReversed)
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['nativeMotionLink'])
        self.assertFalse(result['qualified'])
        self.assertEqual(result['readback']['values']['jointOne']['value'], 1)
        self.assertEqual(result['readback']['values']['jointTwo']['value'], 2)
        self.assertTrue(result['readback']['isReversed'])
        self.assertEqual(len(context.created), 1)

    def test_native_motion_link_rejects_confirmation_units_and_non_revolute_before_add(self):
        context, links, _ = motion_link_context()
        base = {'schemaVersion': 1, 'frame': 'component', 'confirm': True,
                'jointOne': {'kind': 'joint', 'token': 'joint-one'},
                'jointTwo': {'kind': 'joint', 'token': 'joint-two'},
                'valueOne': '1 rad', 'valueTwo': '1 rad'}
        with self.assertRaises(ValueError):
            HANDLERS['mechanism.motion-link.create'](context, {**base, 'confirm': False})
        with self.assertRaises(ValueError):
            HANDLERS['mechanism.motion-link.create'](context, {**base, 'valueTwo': '1 mm'})
        context.entities['joint-two'].jointMotion.objectType = 'adsk::fusion::SliderJointMotion'
        with self.assertRaises(ValueError):
            HANDLERS['mechanism.motion-link.create'](context, base)
        self.assertEqual(links.created_count, 0)

    def test_native_motion_link_reports_unhealthy_readback_without_rollback(self):
        context, links, _ = motion_link_context()
        links.health_state = 1
        request = {'schemaVersion': 1, 'frame': 'component', 'confirm': True,
                   'jointOne': {'kind': 'joint', 'token': 'joint-one'},
                   'jointTwo': {'kind': 'joint', 'token': 'joint-two'},
                   'valueOne': '1 rad', 'valueTwo': '1 rad'}
        result = HANDLERS['mechanism.motion-link.create'](context, request)
        self.assertEqual(result['status'], 'fail')
        self.assertEqual(result['readback']['status'], 'fail')
        self.assertTrue(result['createdLinkRetained'])
        self.assertEqual(links.created_count, 1)

    def test_screw_lead_matches_displacement_per_revolution(self):
        result = self.call('mechanism.couple', {'schemaVersion': 1, 'frame': 'component',
            'coupling': {'type': 'screw', 'lead': '5 mm'},
            'driverRange': {'from': '0 deg', 'to': '360 deg'}, 'samples': 16})
        self.assertEqual(result['type'], 'screw')
        self.assertAlmostEqual(result['lead'], 0.5, places=12)  # 5 mm -> cm
        track = result['evaluated']['track']
        self.assertAlmostEqual(track[-1]['driven']['value'], 0.5, places=9)

    def test_measured_residuals_and_engagement(self):
        result = self.call('mechanism.couple', {'schemaVersion': 1, 'frame': 'component',
            'coupling': {'type': 'rotation', 'ratio': -0.5},
            'driverRange': {'from': '0 deg', 'to': '90 deg'}, 'samples': 4,
            'drivenMeasured': ['0 deg', '-15 deg', '-30 deg', '-45 deg']})
        self.assertTrue(result['evaluated']['engaged'])
        self.assertAlmostEqual(result['evaluated']['maxResidual']['value'], 0.0, places=9)

    def test_inspect_reports_residual(self):
        result = self.call('mechanism.inspect', {'schemaVersion': 1, 'frame': 'component',
            'coupling': {'type': 'rotation', 'ratio': -0.5, 'zeroPhase': '0 deg'},
            'driverValue': '90 deg', 'drivenValue': '-45 deg', 'tolerance': '0.01 deg'})
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['engaged'])
        self.assertAlmostEqual(result['residual']['value'], 0.0, places=9)

    def test_inspect_disengaged_beyond_tolerance(self):
        result = self.call('mechanism.inspect', {'schemaVersion': 1, 'frame': 'component',
            'coupling': {'type': 'rotation', 'ratio': -0.5, 'zeroPhase': '0 deg'},
            'driverValue': '90 deg', 'drivenValue': '-30 deg', 'tolerance': '0.01 deg'})
        self.assertEqual(result['status'], 'fail')
        self.assertFalse(result['engaged'])

    def test_stop_check_program_limit_before_hard_stop(self):
        data = {'schemaVersion': 1, 'frame': 'component',
                'coupling': {'type': 'rotation', 'ratio': -0.5},
                'limits': {'working': {'min': '0 deg', 'max': '200 deg'}, 'program': {'max': '180 deg'}, 'hard': {'max': '200 deg'}},
                'stopSurfaces': [{'clearance': '0.2 mm'}], 'sensorWindow': {'from': '0 deg', 'to': '170 deg'},
                'tolerance': '0.01 deg', 'driverValue': '200 deg', 'drivenValue': '-100 deg'}
        result = self.call('mechanism.stop-check', data)
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['programLimitIsNotPhysicalStop'])
        statuses = {c['check']: c['status'] for c in result['checks']}
        self.assertEqual(statuses['program-vs-hard'], 'pass')
        self.assertEqual(statuses['engagement'], 'pass')

    def test_stop_check_program_limit_is_not_a_physical_stop(self):
        data = {'schemaVersion': 1, 'frame': 'component',
                'coupling': {'type': 'rotation', 'ratio': -0.5},
                'limits': {'program': {'max': '220 deg'}, 'hard': {'max': '200 deg'}}}
        result = self.call('mechanism.stop-check', data)
        self.assertEqual(result['status'], 'fail')
        statuses = {c['check']: c['status'] for c in result['checks']}
        self.assertEqual(statuses['program-vs-hard'], 'fail')

    def test_stop_check_engagement_fails_when_slipped(self):
        data = {'schemaVersion': 1, 'frame': 'component',
                'coupling': {'type': 'rotation', 'ratio': -0.5},
                'limits': {'program': {'max': '180 deg'}, 'hard': {'max': '200 deg'}},
                'tolerance': '0.01 deg', 'driverValue': '200 deg', 'drivenValue': '-90 deg'}
        result = self.call('mechanism.stop-check', data)
        statuses = {c['check']: c['status'] for c in result['checks']}
        self.assertEqual(statuses['engagement'], 'fail')
        self.assertEqual(result['status'], 'fail')

    def test_invalid_inputs_rejected(self):
        with self.assertRaises(ValueError):
            self.call('mechanism.couple', {'schemaVersion': 1, 'frame': 'component',
                'coupling': {'type': 'screw', 'lead': '0 mm'}, 'driverRange': {'from': '0 deg', 'to': '360 deg'}})
        with self.assertRaises(ValueError):
            self.call('mechanism.couple', {'schemaVersion': 1, 'frame': 'component',
                'coupling': {'type': 'rotation'}, 'driverRange': {'from': '0 deg', 'to': '360 deg'}})
        with self.assertRaises(ValueError):
            self.call('mechanism.couple', {'schemaVersion': 2, 'frame': 'component',
                'coupling': {'type': 'rotation', 'ratio': 1}, 'driverRange': {'from': '0 deg', 'to': '360 deg'}})


if __name__ == '__main__':
    unittest.main()
