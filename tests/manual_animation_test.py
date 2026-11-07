"""All animation manual examples with actual handlers, fake SDK, local temporary PNGs."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import animation_test as fixtures
from manual_assembly_test import ROOT, manual, validate_manual


class ManualAnimationTests(unittest.TestCase):
    def fixture(self):
        fixture = fixtures.AnimationTests()
        fixture.setUp()
        fixture.ctx.entities['audit_joint'] = fixture.joint
        edge = fixtures.Entity('BRepEdge', 'AuditEdge', parentComponent=fixture.ctx.root, length=2)
        fixture.ctx.entities['audit_edge'] = edge
        exec(compile((ROOT / 'assets/cad/measure.py').read_text(), 'measure.py', 'exec'), fixture.ns)
        return fixture

    def test_catalog_coverage_metadata_and_outer_validator(self):
        validate_manual(self, 'animation')
        self.assertEqual(len(manual('animation')), 10)

    def test_every_example_with_actual_checks_and_file_modes(self):
        row_keys = {'ref', 'isActive', 'end', 'playheadPosition', 'isInPlayMode',
                    'methods', 'seekExposed', 'limitations'}
        for operation, entry in manual('animation').items():
            for example in entry['examples']:
                with self.subTest(operation=operation, example=example['label']):
                    fixture = self.fixture()
                    sampling = operation in ('motion.sample', 'animation.joints')
                    if not sampling:
                        fixture.manager.isAnimationWorkspaceActive = True
                    data = copy.deepcopy(example['data'])
                    # Substitute explicitly documented environment prerequisites, not input semantics.
                    with tempfile.TemporaryDirectory(dir=ROOT / 'tests', prefix='manual-animation-') as directory:
                        if 'directory' in data:
                            data['directory'] = directory
                        if 'frameFiles' in data:
                            data['frameFiles'] = [str(Path(directory) / Path(p).name) for p in data['frameFiles']]
                        output = fixture.ctx.call(operation, data)
                        if sampling:
                            self.assertEqual(set(output), {'status', 'passed', 'samples', 'frameFiles', 'error',
                                'restoreRequested', 'restored', 'restoreErrors', 'units',
                                'continuousMotionVerified', 'nativeStoryboardActionsCreated', 'limitations'})
                            self.assertTrue(output['passed'], output)
                            self.assertEqual(len(output['samples']), data['frameCount'])
                            for row in output['samples']:
                                self.assertEqual(set(row), {'index', 'fraction', 'joints', 'checks'} |
                                                 ({'frameFile'} if output['frameFiles'] else set()))
                                self.assertEqual(set(row['joints'][0]), {'joint', 'rotationValue', 'slideValue'})
                                for check in row['checks']:
                                    self.assertEqual(set(check), {'id', 'source', 'actual', 'acceptance', 'passed', 'status'})
                                    self.assertEqual(check['actual']['value'], 20)
                                    self.assertEqual(check['actual']['units'], 'mm')
                                    self.assertTrue(check['passed'])
                            for file in output['frameFiles']:
                                self.assertGreater(Path(file).stat().st_size, 0)
                            self.assertEqual(output['restored'], True if data.get('restore', True) else None)
                        elif operation == 'animation.capabilities':
                            self.assertEqual(set(output), {'available', 'profile', 'workspaceActive', 'listAvailable',
                                'createAvailable', 'workspaceActivationAvailable', 'collectionAccess', 'count',
                                'actionCreation', 'videoPublish', 'stop', 'limitations', 'nativeExamples'})
                            self.assertIsNone(output['count'])
                        elif operation == 'animation.workspace':
                            self.assertEqual(set(output), {'workspaceActive'})
                        elif operation == 'animation.list':
                            self.assertEqual(set(output), {'storyboards', 'limitations'})
                            self.assertEqual(set(output['storyboards'][0]), row_keys - {'limitations'})
                        else:
                            self.assertEqual(set(output), row_keys | ({'status', 'completed'}
                                             if operation == 'animation.play' else set()))
                            if operation == 'animation.play':
                                self.assertFalse(output['completed'])
                        json.dumps(output, allow_nan=False)

    def test_nested_check_unknown_fields_and_mutations_rejected_before_motion(self):
        fixture = self.fixture()
        data = copy.deepcopy(manual('animation')['motion.sample']['examples'][0]['data'])
        original = fixture.motion.rotationValue
        for check in (
            {'measurement': {'operation': 'joint.drive', 'data': {'joint': 'audit_joint', 'rotation': '10 deg'}}, 'min': '0 deg'},
            {'measurement': {'operation': 'measure.length', 'data': {'ref': 'audit_edge'}}, 'expected': '20 mm', 'min': '0 mm'},
            {'measurement': {'operation': 'measure.length', 'data': {'ref': 'audit_edge', 'unknown': True}}, 'min': '0 mm'},
        ):
            with self.assertRaises(ValueError):
                fixture.ctx.call('motion.sample', dict(data, checks=[check]))
            self.assertEqual(fixture.motion.rotationValue, original)

    def test_source_bug_later_proxy_rejected_only_after_earlier_motion(self):
        fixture = self.fixture()
        second = fixture.ctx.call('joint.slider', dict(name='ProxyFixture', occurrenceOne='A:1',
                        occurrenceTwo='B:1', point='origin', axis='X'))['joint']
        fixture.ctx.resolve(second).assemblyContext = fixture.ctx.entities['A:1']
        original = fixture.motion.rotationValue
        output = fixture.ctx.call('motion.sample', {'confirm': True, 'frameCount': 2, 'restore': False,
            'tracks': [{'joint': fixture.ref, 'rotation': {'from': '0 deg', 'to': '45 deg'}},
                       {'joint': second, 'slide': {'from': '0 mm', 'to': '10 mm'}}]})
        self.assertFalse(output['passed'])
        self.assertIn('native joint', output['error'])
        self.assertEqual(output['samples'], [])
        self.assertNotEqual(fixture.motion.rotationValue, original)
        self.assertIsNone(output['restored'])

    def test_source_bug_restore_false_still_requires_restorable_original_values(self):
        fixture = self.fixture()
        fixture.motion.slideValue = 100
        with self.assertRaisesRegex(ValueError, 'Original slide.*cannot safely restore'):
            fixture.ctx.call('animation.joints', {'confirm': True, 'frameCount': 2, 'restore': False,
                'tracks': [{'joint': fixture.ref, 'slide': {'from': '0 mm', 'to': '10 mm'}}]})
        self.assertEqual(fixture.motion.slideValue, 100)

    def test_real_storyboard_output_reference_wiring(self):
        fixture = self.fixture()
        fixture.ctx.call('animation.workspace', {'confirm': True})
        boards = fixture.ctx.call('animation.list', {})
        inspected = fixture.ctx.call('animation.inspect', {'storyboard': boards['storyboards'][0]['ref']})
        fixture.ctx.call('animation.activate', {'storyboard': inspected['ref'], 'confirm': True})
        result = fixture.ctx.call('animation.seek', {'storyboard': inspected['ref'], 'seconds': -1, 'confirm': True})
        self.assertEqual(result['playheadPosition'], -1)


if __name__ == '__main__':
    unittest.main()
