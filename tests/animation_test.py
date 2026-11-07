"""Offline math/fake SDK tests using the actual compiled assembly joint.drive.

No Fusion solver/kernel claims: fakes cover dispatch, validation and restoration.
"""
import copy
import json
import math
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

from assembly_test import Collection, Context, Entity


ROOT = Path(__file__).resolve().parents[1]
NS = types.SimpleNamespace


class Storyboard:
    # Deliberately has neither name nor id: mirrors the stable SDK surface.
    def __init__(self, manager):
        self.manager = manager
        self.end = 10
        self._position = 0
        self.isInPlayMode = False

    @property
    def isActive(self):
        return self.manager.activeStoryboard is self

    @property
    def playheadPosition(self):
        return self._position

    @playheadPosition.setter
    def playheadPosition(self, value):
        self._position = value
        self.manager.trace.append(('seek', value))

    def activate(self):
        self.manager.activeStoryboard = self
        self.manager.trace.append('activateBoard')
        return True

    def play(self, current, begin, end):
        self.manager.trace.append(('play', current, begin, end))
        self.isInPlayMode = True
        return True


class Manager:
    def __init__(self, trace):
        self.trace = trace
        self.isAnimationWorkspaceActive = False
        self._storyboards = Collection()
        self.storyboards.add = self.add
        self.activeStoryboard = self.add(True)

    @property
    def storyboards(self):
        return self._storyboards

    def add(self, clean):
        self.trace.append(('addBoard', clean))
        board = Storyboard(self)
        self.storyboards.values.append(board)
        return board

    def activateAnimationWorkspace(self):
        self.trace.append('workspace')
        self.isAnimationWorkspaceActive = True
        return True


class UninitializedManager(Manager):
    def __init__(self, trace):
        self.initialized = True
        super().__init__(trace)
        self.initialized = False

    @property
    def storyboards(self):
        self.trace.append('storyboardsGetter')
        if not self.initialized:
            raise RuntimeError('2 : InternalValidationError : assetRoot')
        return self._storyboards

    def activateAnimationWorkspace(self):
        result = super().activateAnimationWorkspace()
        self.initialized = True
        return result


class Viewport:
    def __init__(self, ctx):
        self.ctx = ctx
        self.parentDocument = ctx.doc
        self.state = NS(eye=(1, 2, 3), isFitView=False, isSmoothTransition=False)

    @property
    def camera(self):
        return copy.copy(self.state)

    @camera.setter
    def camera(self, value):
        self.ctx.trace.append('cameraRestore')
        self.state = copy.copy(value)

    def refresh(self):
        self.ctx.trace.append('refresh')
        return True

    def saveAsImageFile(self, path, width, height):
        self.ctx.trace.append(('png', path, width, height))
        Path(path).write_bytes(b'fake PNG; not rendered geometry')
        return True


class AnimationTests(unittest.TestCase):
    def setUp(self):
        self.ctx = Context()
        self.ns = self.ctx.ns
        exec(compile((ROOT / 'assets/cad/animation.py').read_text(), 'animation.py', 'exec'), self.ns)
        self.ctx.doc = NS(creationId='document-session-id', name='Design', isValid=True)
        self.ctx.app = NS(activeDocument=self.ctx.doc, userInterface=NS(activeCommand='SelectCommand', activeWorkspace=object()))
        self.ctx.app.activeViewport = Viewport(self.ctx)
        self.manager = self.ctx.design.animationManager = Manager(self.ctx.trace)
        self.ns['adsk'].fusion.Storyboards = type('Storyboards', (), {'item': Collection.item, 'add': Manager.add})
        self.ref = self.ctx.call('joint.cylindrical', {'name': 'J', 'occurrenceOne': 'A:1',
            'occurrenceTwo': 'B:1', 'point': 'origin', 'axis': 'Z'})['joint']
        self.joint = self.ctx.resolve(self.ref)
        self.motion = self.joint.jointMotion
        self.motion.rotationValue, self.motion.slideValue = .25, .75
        self.data = {'confirm': True, 'frameCount': 3, 'tracks': [{'joint': self.ref,
            'rotation': {'from': '0 deg', 'to': '90 deg'}, 'slide': {'from': '0 mm', 'to': '20 mm'}}]}
        self.board_ref = {'document': self.ctx.doc.creationId, 'index': 0}
        self.ns['adsk'].doEvents = lambda: self.ctx.trace.append('events')
        self.ctx.trace.clear()

    def sample(self, **kwargs):
        return self.ctx.call('motion.sample', dict(self.data, **kwargs))

    def test_catalog_contracts_and_alias(self):
        catalog = json.loads((ROOT / 'src/catalog/animation.json').read_text())
        self.assertEqual(len(catalog), 10)
        for op, entry in catalog.items():
            self.assertIn(op, self.ns['CAD_HANDLERS'])
            self.assertEqual(set(entry), {'summary', 'required', 'example', 'readOnly', 'inputs', 'limitations'})
            self.assertTrue(set(entry['required']) <= entry['example'].keys())
            self.assertTrue(set(entry['example']) <= entry['inputs'].keys())
            self.assertEqual(entry['readOnly'], op in ('animation.capabilities', 'animation.list', 'animation.inspect'))
        self.assertIs(self.ns['CAD_HANDLERS']['motion.sample'], self.ns['CAD_HANDLERS']['animation.joints'])

    def test_readonly_no_activation_and_no_board_name_id(self):
        caps = self.ctx.call('animation.capabilities', {})
        self.assertTrue(caps['available'])
        self.assertTrue(caps['createAvailable'])
        self.assertFalse(caps['actionCreation'])
        self.assertFalse(caps['stop'])
        self.manager.isAnimationWorkspaceActive = True
        rows = self.ctx.call('animation.list', {})['storyboards']
        self.assertEqual(rows[0]['ref'], self.board_ref)
        inspected = self.ctx.call('animation.inspect', {'storyboard': rows[0]['ref']})
        self.assertTrue(inspected['seekExposed'])
        self.assertEqual(inspected['end'], 10)
        self.assertEqual(self.ctx.trace, [])

    def test_capabilities_missing_manager_methods_are_honest(self):
        del self.ctx.design.animationManager
        self.assertFalse(self.ctx.call('animation.capabilities', {})['available'])
        with self.assertRaisesRegex(ValueError, 'animationManager'):
            self.ctx.call('animation.list', {})
        self.ctx.design.animationManager = NS(storyboards=NS(item=None, add=None))
        caps = self.ctx.call('animation.capabilities', {})
        self.assertFalse(caps['createAvailable'])
        self.assertFalse(caps['listAvailable'])

    def test_storyboard_ref_validation_before_mutation(self):
        self.manager.isAnimationWorkspaceActive = True
        for ref in ({'document': 'other', 'index': 0}, {'document': self.ctx.doc.creationId, 'index': True},
                    {'document': self.ctx.doc.creationId, 'index': -1}, {'document': self.ctx.doc.creationId, 'index': 1}):
            with self.assertRaises(ValueError):
                self.ctx.call('animation.activate', {'storyboard': ref, 'confirm': True, 'activate': True})
        self.assertEqual(self.ctx.trace, [])

    def test_capabilities_never_evaluate_uninitialized_collection_property(self):
        manager = self.ctx.design.animationManager = UninitializedManager(self.ctx.trace)
        with self.assertRaisesRegex(RuntimeError, 'assetRoot'):
            manager.storyboards
        self.ctx.trace.clear()
        result = self.ctx.call('animation.capabilities', {})
        self.assertTrue(result['available'])
        self.assertTrue(result['listAvailable'])
        self.assertTrue(result['createAvailable'])
        self.assertTrue(result['workspaceActivationAvailable'])
        self.assertEqual(result['collectionAccess'], 'notChecked')
        self.assertIsNone(result['count'])
        self.assertFalse(result['workspaceActive'])
        self.assertFalse(manager.initialized)
        self.assertEqual(self.ctx.trace, [])
        self.ns['adsk'].fusion.Storyboards.add = None
        self.assertFalse(self.ctx.call('animation.capabilities', {})['createAvailable'])
        self.assertEqual(self.ctx.trace, [])

    def test_inactive_discovery_requires_explicit_activation_without_getter(self):
        manager = self.ctx.design.animationManager = UninitializedManager(self.ctx.trace)
        self.ctx.trace.clear()
        for op, data in [('animation.list', {}), ('animation.inspect', {'storyboard': self.board_ref})]:
            with self.assertRaisesRegex(ValueError, 'animation.workspace.*confirm:true'):
                self.ctx.call(op, data)
        self.assertFalse(manager.initialized)
        self.assertEqual(self.ctx.trace, [])

    def test_workspace_activation_never_requires_collection_access(self):
        manager = self.ctx.design.animationManager = UninitializedManager(self.ctx.trace)
        self.ctx.trace.clear()
        result = self.ctx.call('animation.workspace', {'confirm': True})
        self.assertTrue(result['workspaceActive'])
        self.assertTrue(manager.initialized)
        self.assertEqual(self.ctx.trace, ['workspace'])
        self.ctx.call('animation.capabilities', {})
        self.assertEqual(self.ctx.trace, ['workspace'])
        rows = self.ctx.call('animation.list', {})['storyboards']
        self.assertEqual(rows[0]['ref'], self.board_ref)
        self.assertEqual(self.ctx.trace, ['workspace', 'storyboardsGetter'])
        self.ctx.call('animation.inspect', {'storyboard': self.board_ref})
        self.assertEqual(self.ctx.trace, ['workspace', 'storyboardsGetter', 'storyboardsGetter'])

    def test_workspace_only_works_without_any_storyboards_interface(self):
        class WorkspaceOnly:
            isAnimationWorkspaceActive = False

            def activateAnimationWorkspace(manager):
                self.ctx.trace.append('workspace')
                manager.isAnimationWorkspaceActive = True
                return True
        self.ctx.design.animationManager = WorkspaceOnly()
        result = self.ctx.call('animation.workspace', {'confirm': True})
        self.assertTrue(result['workspaceActive'])
        self.assertEqual(self.ctx.trace, ['workspace'])

    def test_uninitialized_mutations_require_opt_in_and_activate_before_getter(self):
        manager = self.ctx.design.animationManager = UninitializedManager(self.ctx.trace)
        self.ctx.trace.clear()
        with self.assertRaises(ValueError):
            self.ctx.call('animation.create', {'confirm': True})
        with self.assertRaises(ValueError):
            self.ctx.call('animation.create', {'confirm': False, 'activate': True})
        self.assertEqual(self.ctx.trace, [])
        result = self.ctx.call('animation.create', {'confirm': True, 'activate': True})
        self.assertEqual(result['ref']['index'], 1)
        self.assertTrue(manager.initialized)
        self.assertEqual(self.ctx.trace[:2], ['workspace', 'storyboardsGetter'])

    def test_active_but_uninitialized_discovery_is_not_reported_empty(self):
        manager = self.ctx.design.animationManager = UninitializedManager(self.ctx.trace)
        manager.isAnimationWorkspaceActive = True
        self.ctx.trace.clear()
        for op, data in [('animation.list', {}), ('animation.inspect', {'storyboard': self.board_ref})]:
            with self.assertRaisesRegex(RuntimeError, 'not initialized.*animation.workspace') as error:
                self.ctx.call(op, data)
            self.assertIn('assetRoot', str(error.exception.__cause__))
        self.assertFalse(manager.initialized)
        self.assertEqual(self.ctx.trace, ['storyboardsGetter', 'storyboardsGetter'])

    def test_failed_activation_does_not_probe_storyboards(self):
        manager = self.ctx.design.animationManager = UninitializedManager(self.ctx.trace)
        manager.activateAnimationWorkspace = lambda: False
        self.ctx.trace.clear()
        for op, data in [('animation.workspace', {'confirm': True}),
                         ('animation.create', {'confirm': True, 'activate': True})]:
            with self.assertRaisesRegex(RuntimeError, 'Activate Animation workspace'):
                self.ctx.call(op, data)
        self.assertFalse(manager.initialized)
        self.assertEqual(self.ctx.trace, [])

    def test_explicit_workspace_create_activate_seek_play_started(self):
        with self.assertRaisesRegex(ValueError, 'explicitly'):
            self.ctx.call('animation.create', {'confirm': True})
        self.assertEqual(self.ctx.trace, [])
        result = self.ctx.call('animation.create', {'confirm': True, 'activate': True, 'clean': False})
        self.assertEqual(result['ref']['index'], 1)
        self.assertIn(result['ref'], self.ctx.created)
        self.assertIn(('addBoard', False), self.ctx.trace)
        self.ctx.call('animation.activate', {'confirm': True, 'storyboard': result['ref']})
        self.ctx.call('animation.seek', {'confirm': True, 'storyboard': result['ref'], 'seconds': 2})
        result = self.ctx.call('animation.play', {'confirm': True, 'storyboard': result['ref'], 'end': 6})
        self.assertEqual(result['status'], 'started')
        self.assertFalse(result['completed'])
        self.assertIn(('play', False, 2, 6), self.ctx.trace)

    def test_native_invalid_times_and_unexposed_methods(self):
        self.manager.isAnimationWorkspaceActive = True
        for op, options in [('seek', {'seconds': float('nan')}), ('seek', {'seconds': 11}),
                            ('play', {'begin': 2, 'end': 1}), ('play', {'end': float('inf')})]:
            with self.assertRaises(ValueError):
                self.ctx.call('animation.' + op, dict(storyboard=self.board_ref, confirm=True, **options))
        board = self.manager.activeStoryboard
        board.play = None
        with self.assertRaisesRegex(ValueError, 'does not expose play'):
            self.ctx.call('animation.play', {'storyboard': self.board_ref, 'confirm': True})
        self.assertEqual(self.ctx.trace, [])

    def test_native_api_false_is_failure(self):
        self.manager.isAnimationWorkspaceActive = True
        self.manager.activeStoryboard.play = lambda *args: False
        with self.assertRaises(RuntimeError):
            self.ctx.call('animation.play', {'storyboard': self.board_ref, 'confirm': True})
        self.manager.storyboards.add = lambda clean: None
        with self.assertRaises(RuntimeError):
            self.ctx.call('animation.create', {'confirm': True})

    def test_linear_math_actual_compiled_drive_and_restore(self):
        called = []
        original = self.ns['CAD_HANDLERS']['joint.drive']
        def drive(ctx, data):
            called.append(data)
            result = original(ctx, data)
            ctx.app.activeViewport.state.eye = (7, 8, 9)
            return result
        self.ns['CAD_HANDLERS']['joint.drive'] = drive
        result = self.sample()
        self.assertTrue(result['passed'])
        self.assertTrue(result['restored'])
        self.assertEqual(len(called), 4)
        self.assertEqual([s['fraction'] for s in result['samples']], [0, .5, 1])
        for index, sample in enumerate(result['samples']):
            self.assertAlmostEqual(sample['joints'][0]['rotationValue'], index * math.pi / 4)
            self.assertEqual(sample['joints'][0]['slideValue'], index)
        self.assertEqual((self.motion.rotationValue, self.motion.slideValue), (.25, .75))
        self.assertEqual(self.ctx.app.activeViewport.state.eye, (1, 2, 3))
        self.assertNotIn('compute', self.ctx.trace)
        self.assertNotIn('events', self.ctx.trace)
        self.assertNotIn('refresh', self.ctx.trace)
        self.assertEqual(result['frameFiles'], [])

    def test_output_reads_actual_not_requested(self):
        original = self.ns['CAD_HANDLERS']['joint.drive']
        calls = []
        def drive(ctx, data):
            result = original(ctx, data)
            calls.append(data)
            if len(calls) <= 3:
                self.motion.rotationValue /= 2
            return result
        self.ns['CAD_HANDLERS']['joint.drive'] = drive
        result = self.sample()
        self.assertAlmostEqual(result['samples'][-1]['joints'][0]['rotationValue'], math.pi / 4)
        self.assertTrue(result['restored'])

    def test_full_invalid_prevalidation_has_no_changes(self):
        invalid = [dict(frameCount=n) for n in (True, 1, 241, 2.5)]
        invalid += [{'confirm': False}, {'restore': 'yes'}, {'realtime': 1}, {'delay': .2}, {'delay': .01},
                    {'delay': float('nan')}, {'tracks': []}, {'tracks': self.data['tracks'] * 2},
                    {'checks': {}}, {'width': 10}, {'prefix': 'oops'}, {'frameFiles': None}]
        for options in invalid:
            with self.subTest(options=options), self.assertRaises((ValueError, TypeError)):
                self.sample(**options)
        bad_tracks = [dict(self.data['tracks'][0], slide={'from': '0 mm', 'to': value})
                      for value in ('1000 mm', 'nan mm', 'inf mm', '5 deg', 5)]
        bad_tracks += [{'joint': self.ref}, {'joint': self.ref, 'rotation': {'from': '0 deg'}},
                       {'joint': 'root', 'rotation': {'from': '0 deg', 'to': '1 deg'}}]
        for track in bad_tracks:
            with self.subTest(track=track), self.assertRaises((ValueError, TypeError)):
                self.sample(tracks=[track])
        self.assertEqual(self.ctx.trace, [])
        self.assertEqual((self.motion.rotationValue, self.motion.slideValue), (.25, .75))

    def test_invalid_later_track_does_not_drive_first(self):
        ref = self.ctx.call('joint.slider', {'name': 'S', 'occurrenceOne': 'A:1', 'occurrenceTwo': 'B:1',
                                           'point': 'origin', 'axis': 'Z'})['joint']
        self.ctx.trace.clear()
        with self.assertRaises(ValueError):
            self.sample(tracks=self.data['tracks'] + [{'joint': ref, 'slide': {'from': '0 mm', 'to': '1000 mm'}}])
        self.assertEqual(self.motion.rotationValue, .25)
        self.assertEqual(self.ctx.trace, [])

    def test_untracked_degree_of_freedom_also_has_restorable_limits(self):
        self.motion.slideValue = 100
        with self.assertRaisesRegex(ValueError, 'Original slide'):
            self.sample(tracks=[{'joint': self.ref, 'rotation': {'from': '0 deg', 'to': '90 deg'}}])
        self.assertEqual(self.ctx.trace, [])
        self.motion.slideValue = .75
        self.motion.rotationLimits.minimumValue = float('nan')
        with self.assertRaisesRegex(ValueError, 'finite'):
            self.sample()
        self.assertEqual(self.ctx.trace, [])

    def test_reverse_tracks_and_frame_bounds(self):
        for count in (2, 240):
            result = self.sample(frameCount=count, tracks=[{'joint': self.ref,
                'rotation': {'from': '90 deg', 'to': '-90 deg'}}])
            self.assertEqual(len(result['samples']), count)
            self.assertAlmostEqual(result['samples'][0]['joints'][0]['rotationValue'], math.pi / 2)
            self.assertAlmostEqual(result['samples'][-1]['joints'][0]['rotationValue'], -math.pi / 2)

    def test_partial_setter_failure_restores_and_reports(self):
        original = self.ns['CAD_HANDLERS']['joint.drive']
        calls = []
        def drive(ctx, data):
            calls.append(data)
            result = original(ctx, data)
            if len(calls) == 2:
                raise RuntimeError('setter failed after mutation')
            return result
        self.ns['CAD_HANDLERS']['joint.drive'] = drive
        result = self.sample()
        self.assertFalse(result['passed'])
        self.assertIn('setter failed', result['error'])
        self.assertEqual(len(result['samples']), 1)
        self.assertTrue(result['restored'])
        self.assertEqual(result['restoreErrors'], [])
        self.assertEqual((self.motion.rotationValue, self.motion.slideValue), (.25, .75))
        self.assertIn('cameraRestore', self.ctx.trace)

    def test_primary_and_restore_failures_are_separate(self):
        def drive(ctx, data):
            self.motion.rotationValue = 3
            raise RuntimeError('drive unavailable')
        self.ns['CAD_HANDLERS']['joint.drive'] = drive
        result = self.sample()
        self.assertIn('drive unavailable', result['error'])
        self.assertFalse(result['restored'])
        self.assertTrue(any('joint restore' in e for e in result['restoreErrors']))
        self.assertIn('cameraRestore', self.ctx.trace)

    def test_restore_false_leaves_final_pose_explicitly(self):
        result = self.sample(restore=False)
        self.assertIsNone(result['restored'])
        self.assertFalse(result['restoreRequested'])
        self.assertAlmostEqual(self.motion.rotationValue, math.pi / 2)
        self.assertNotIn('cameraRestore', self.ctx.trace)

    def test_checks_prevalidated_and_evaluated_per_frame(self):
        calls = []
        def check(ctx, data):
            calls.append(self.motion.slideValue)
            return {'passed': self.motion.slideValue < 2}
        self.ns['CAD_HANDLERS']['check'] = check
        result = self.sample(checks=[{'measurement': 'offline fake'}])
        self.assertEqual(calls, [.75, 0, 1, 2])
        self.assertFalse(result['passed'])
        self.assertTrue(result['restored'])
        self.assertIsNone(result['error'])
        def invalid(ctx, data):
            raise ValueError('bad check')
        self.ns['CAD_HANDLERS']['check'] = invalid
        self.ctx.trace.clear()
        with self.assertRaisesRegex(ValueError, 'bad check'):
            self.sample(checks=[{}])
        self.assertEqual(self.ctx.trace, [])

    def test_real_check_handler_acceptance_and_mutation_rejection(self):
        exec(compile((ROOT / 'assets/cad/measure.py').read_text(), 'measure.py', 'exec'), self.ns)
        edge = Entity('BRepEdge', parentComponent=self.ctx.root, length=2)
        ref = self.ctx.ref(edge)
        check = {'measurement': {'operation': 'measure.length', 'data': {'ref': ref, 'units': 'mm'}},
                 'expected': '20 mm', 'tolerance': '0.1 mm'}
        result = self.sample(checks=[check])
        self.assertTrue(result['passed'])
        self.assertTrue(all(s['checks'][0]['actual']['value'] == 20 for s in result['samples']))
        self.ctx.trace.clear()
        with self.assertRaisesRegex(ValueError, 'scalar measure'):
            self.sample(checks=[{'measurement': {'operation': 'joint.drive',
                         'data': {'joint': self.ref, 'rotation': '30 deg'}}, 'min': '0 mm'}])
        self.assertEqual(self.ctx.trace, [])

    def test_mid_sample_check_exception_restores(self):
        calls = []
        def check(ctx, data):
            calls.append(True)
            if len(calls) == 3:
                raise RuntimeError('measurement failed')
            return {'passed': True}
        self.ns['CAD_HANDLERS']['check'] = check
        result = self.sample(checks=[{}])
        self.assertFalse(result['passed'])
        self.assertTrue(result['restored'])
        self.assertIn('measurement failed', result['error'])
        self.assertEqual(self.motion.rotationValue, .25)

    def test_camera_restore_failure_does_not_hide_successful_joint_restore(self):
        class BrokenCamera(Viewport):
            @Viewport.camera.setter
            def camera(self, value):
                raise RuntimeError('camera setter failed')
        self.ctx.app.activeViewport = BrokenCamera(self.ctx)
        result = self.sample()
        self.assertFalse(result['passed'])
        self.assertFalse(result['restored'])
        self.assertIsNone(result['error'])
        self.assertTrue(any('camera setter failed' in e for e in result['restoreErrors']))
        self.assertEqual(self.motion.rotationValue, .25)

    def test_restoration_verifies_values_even_if_handler_returns_success(self):
        original = self.ns['CAD_HANDLERS']['joint.drive']
        calls = []
        def drive(ctx, data):
            calls.append(data)
            if len(calls) <= 3:
                return original(ctx, data)
            return {'pretend': 'success'}
        self.ns['CAD_HANDLERS']['joint.drive'] = drive
        result = self.sample()
        self.assertIsNone(result['error'])
        self.assertFalse(result['restored'])
        self.assertTrue(any('differs from original' in e for e in result['restoreErrors']))

    def test_preconditions_no_changes(self):
        for obj, key, value in [(self.ctx.app, 'activeDocument', object()),
                                (self.ctx.app.userInterface, 'activeCommand', 'Extrude'),
                                (self.manager, 'isAnimationWorkspaceActive', True),
                                (self.ctx.doc, 'isValid', False),
                                (self.ctx.design.snapshots, 'hasPendingSnapshot', True),
                                (self.joint, 'isSuppressed', True)]:
            old = getattr(obj, key)
            setattr(obj, key, value)
            with self.assertRaises(ValueError):
                self.sample()
            setattr(obj, key, old)
        self.assertEqual(self.ctx.trace, [])

    def test_realtime_events_delay_guarded_and_bounded(self):
        with patch.object(self.ns['time'], 'sleep') as sleep:
            result = self.sample(realtime=True, delay=.01)
        self.assertTrue(result['passed'])
        self.assertEqual(sleep.call_count, 3)
        self.assertEqual(self.ctx.trace.count('refresh'), 3)
        self.assertEqual(self.ctx.trace.count('events'), 3)

    def test_document_or_command_change_aborts_and_reports_restore_block(self):
        for target, key, value in [(self.ctx.app, 'activeDocument', object()),
                                    (self.ctx.app.userInterface, 'activeCommand', 'Extrude'),
                                    (self.ctx.app.userInterface, 'activeWorkspace', object())]:
            old = getattr(target, key)
            self.ns['adsk'].doEvents = lambda: setattr(target, key, value)
            result = self.sample(realtime=True)
            self.assertFalse(result['passed'])
            self.assertFalse(result['restored'])
            self.assertEqual(len(result['samples']), 0)
            self.assertTrue(result['restoreErrors'])
            setattr(target, key, old)

    def test_paths_prevalidated_no_overwrite_or_arbitrary_default(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            existing = base / 'frame-002.png'
            existing.write_bytes(b'user data')
            invalid = [{'directory': directory}, {'directory': directory, 'prefix': '../escape'},
                       {'frameFiles': [str(base / 'x.png')] * 3},
                       {'frameFiles': [str(base / 'a.png'), str(base / 'b.png'), str(existing)]},
                       {'frameFiles': ['relative.png'] * 3}, {'directory': str(base / 'missing')},
                       {'frameFiles': [str(base / 'a.png')], 'directory': directory}]
            for options in invalid:
                with self.subTest(options=options), self.assertRaises(ValueError):
                    self.sample(**options)
            self.assertEqual(self.ctx.trace, [])
            self.assertEqual(existing.read_bytes(), b'user data')
            self.assertEqual(list(base.iterdir()), [existing])

    def test_png_targets_and_dimensions(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.sample(directory=directory, prefix='hinge', width=640, height=480)
            self.assertTrue(result['passed'])
            self.assertEqual(len(result['frameFiles']), 3)
            self.assertTrue(all(Path(p).stat().st_size > 0 for p in result['frameFiles']))
            self.assertEqual(Path(result['frameFiles'][0]).name, 'hinge-000.png')
            self.assertEqual([t[2:] for t in self.ctx.trace if isinstance(t, tuple) and t[0] == 'png'], [(640, 480)] * 3)

    def test_png_failure_restores_and_does_not_claim_export(self):
        with tempfile.TemporaryDirectory() as directory:
            self.ctx.app.activeViewport.saveAsImageFile = lambda *args: True
            result = self.sample(directory=directory)
            self.assertFalse(result['passed'])
            self.assertTrue(result['restored'])
            self.assertIn('no nonempty file', result['error'])
            self.assertEqual(result['frameFiles'], [])
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_explicit_frame_files(self):
        with tempfile.TemporaryDirectory() as directory:
            files = [str(Path(directory) / (name + '.png')) for name in ('start', 'middle', 'end')]
            result = self.sample(frameFiles=files)
            self.assertEqual(result['frameFiles'], files)
            self.assertTrue(result['passed'])

    def test_concurrent_file_creation_never_clobbered(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'frame-000.png'
            export = self.ctx.app.activeViewport.saveAsImageFile
            def race(path, width, height):
                target.write_bytes(b'concurrent user data')
                return export(path, width, height)
            self.ctx.app.activeViewport.saveAsImageFile = race
            result = self.sample(directory=directory)
            self.assertFalse(result['passed'])
            self.assertTrue(result['restored'])
            self.assertIn('FileExistsError', result['error'])
            self.assertEqual(target.read_bytes(), b'concurrent user data')
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_unavailable_hard_links_report_failure_without_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            module_os = self.ns.get('os', self.ns.get('_animation_os'))
            with patch.object(module_os, 'link', side_effect=OSError('hard links unsupported')):
                result = self.sample(directory=directory)
            self.assertFalse(result['passed'])
            self.assertTrue(result['restored'])
            self.assertIn('hard links unsupported', result['error'])
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
