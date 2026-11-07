"""Offline GM36 animation tests: sequence frame manifest and film export encoder gating."""
import math
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from explode_test import Context, Occurrence, Matrix, load_module

ROOT = Path(__file__).resolve().parents[1]
NS = types.SimpleNamespace


def load_animation2():
    return load_module(('core', 'explode', 'animation2'))


class SequenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.adsk, cls.module = load_animation2()

    def setUp(self):
        self.ctx = Context()
        self.ctx.module = self.module
        self.ctx.add('occ', origin=(0, 0, 0))

    def call(self, **data):
        data.setdefault('schemaVersion', 1)
        data.setdefault('duration', '2 s')
        data.setdefault('fps', 30)
        return self.ctx.call('animation.sequence', data)

    def test_camera_dolly_and_visibility_step(self):
        result = self.call(tracks=[
            {'type': 'camera', 'phase': 'intro',
             'from': {'eye': ['0 cm', '0 cm', '30 cm'], 'target': ['0 cm', '0 cm', '0 cm'], 'up': [0, 0, 1]},
             'to': {'eye': ['10 cm', '0 cm', '30 cm'], 'target': ['0 cm', '0 cm', '0 cm'], 'up': [0, 0, 1]}},
            {'type': 'visibility', 'phase': 'reveal', 'ref': 'Sketch1', 'visible': False}],
            phases=['intro', 'reveal'])
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['frameCount'], 61)
        self.assertEqual(result['frames'][0]['camera']['eye'], [0.0, 0.0, 30.0])
        self.assertEqual(result['frames'][-1]['camera']['eye'], [10.0, 0.0, 30.0])
        self.assertEqual(result['frames'][0]['visibility'], {})
        self.assertTrue(result['frames'][-1]['visibility']['Sketch1'] is False)
        self.assertFalse(result['nativeStoryboardActionsCreated'])

    def test_joint_and_occurrence_interpolation(self):
        result = self.call(duration='1 s', fps=10, tracks=[
            {'type': 'joint', 'ref': {'token': 'j1'}, 'rotation': {'from': '0 deg', 'to': '90 deg'}},
            {'type': 'occurrence', 'ref': {'token': 'occ'}, 'axis': [0, 0, 1], 'distance': '20 mm'}])
        self.assertEqual(result['frameCount'], 11)
        self.assertEqual(result['frames'][0]['joints']['j1']['rotation'], 0.0)
        self.assertAlmostEqual(result['frames'][-1]['joints']['j1']['rotation'], math.pi / 2)
        self.assertAlmostEqual(result['frames'][-1]['occurrences']['occ'][2], 2.0)

    def test_section_discrete_step(self):
        result = self.call(duration='1 s', fps=10, phases=['a', 'b'], tracks=[
            {'type': 'section', 'phase': 'b', 'name': 'Cut', 'isLightBulbOn': False}])
        self.assertEqual(result['frames'][0]['sections'], {})
        self.assertFalse(result['frames'][-1]['sections']['Cut'])

    def test_read_only_no_native_mutation(self):
        self.call(tracks=[{'type': 'camera',
                           'from': {'eye': ['0 cm', '0 cm', '30 cm'], 'target': ['0 cm', '0 cm', '0 cm'], 'up': [0, 0, 1]},
                           'to': {'eye': ['0 cm', '0 cm', '30 cm'], 'target': ['0 cm', '0 cm', '0 cm'], 'up': [0, 0, 1]}}])
        self.assertEqual(self.ctx.trace, [])

    def test_invalid_tracks_rejected(self):
        invalid = [
            dict(tracks=[]),
            dict(tracks=[{'type': 'nope'}]),
            dict(tracks=[{'type': 'camera'}], fps=0),
            dict(tracks=[{'type': 'visibility', 'ref': 'X'}]),
            dict(tracks=[{'type': 'joint', 'ref': {'token': 'j1'}}]),
            dict(tracks=[{'type': 'occurrence', 'ref': {'token': 'occ'}, 'axis': [0, 0, 0], 'distance': '1 mm'}]),
        ]
        for data in invalid:
            with self.subTest(data=data), self.assertRaises(ValueError):
                self.call(**data)
        self.assertEqual(self.ctx.trace, [])


class ExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.adsk, cls.module = load_animation2()

    def setUp(self):
        import tempfile
        self.ctx = Context()
        self.ctx.module = self.module
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        self.frames = []
        for i in range(3):
            path = self.dir / ('frame-%03d.png' % i)
            path.write_bytes(b'fake frame')
            self.frames.append(str(path))

    def export(self, **extra):
        data = {'schemaVersion': 1, 'frames': self.frames,
                'output': str(self.dir / 'film.mp4'), 'confirm': True}
        data.update(extra)
        return self.ctx.call('animation.export', data)

    def test_no_encoder_is_blocked_without_file(self):
        result = self.export()
        self.assertEqual(result['status'], 'blocked')
        self.assertIsNone(result['film'])
        self.assertFalse(result['fileWritten'])
        self.assertFalse((self.dir / 'film.mp4').exists())

    def test_ffmpeg_encoder_produces_playable_file(self):
        captured = {}

        def run(argv, capture_output, text):
            captured['argv'] = list(argv)
            Path(argv[-1]).write_bytes(b'\x00\x00\x00\x18ftypmp42nonempty')
            return NS(returncode=0, stderr='')

        with patch('shutil.which', return_value='/usr/bin/ffmpeg'), patch('subprocess.run', side_effect=run):
            result = self.export(encoder={'name': 'ffmpeg'}, fps=30)
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['fileWritten'])
        self.assertTrue(result['playable'])
        self.assertIn('-f', captured['argv'])
        self.assertIn('concat', captured['argv'])
        self.assertIn('libx264', captured['argv'])
        self.assertTrue((self.dir / 'film.mp4').exists())
        self.assertGreater((self.dir / 'film.mp4').stat().st_size, 0)

    def test_unavailable_program_is_blocked(self):
        with patch('shutil.which', return_value=None):
            result = self.export(encoder={'name': 'ffmpeg'}, fps=30)
        self.assertEqual(result['status'], 'blocked')
        self.assertIsNone(result['film'])

    def test_generic_command_appends_frames_and_output(self):
        captured = {}

        def run(argv, capture_output, text):
            captured['argv'] = list(argv)
            Path(argv[-1]).write_bytes(b'video')
            return NS(returncode=0, stderr='')

        with patch('subprocess.run', side_effect=run):
            result = self.export(encoder={'name': 'custom', 'command': ['enc', '-x']})
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(captured['argv'][:2], ['enc', '-x'])
        self.assertEqual(captured['argv'][-4:-1], self.frames)
        self.assertEqual(captured['argv'][-1], str(self.dir / 'film.mp4'))

    def test_nonzero_exit_is_fail(self):
        with patch('shutil.which', return_value='/usr/bin/ffmpeg'), \
             patch('subprocess.run', return_value=NS(returncode=1, stderr='boom')):
            result = self.export(encoder={'name': 'ffmpeg'}, fps=30)
        self.assertEqual(result['status'], 'fail')
        self.assertFalse(result['fileWritten'])

    def test_empty_output_is_fail(self):
        def run(argv, capture_output, text):
            Path(argv[-1]).write_bytes(b'')
            return NS(returncode=0, stderr='')

        with patch('shutil.which', return_value='/usr/bin/ffmpeg'), patch('subprocess.run', side_effect=run):
            result = self.export(encoder={'name': 'ffmpeg'}, fps=30)
        self.assertEqual(result['status'], 'fail')
        self.assertFalse(result['playable'])

    def test_existing_output_rejected(self):
        (self.dir / 'film.mp4').write_bytes(b'')
        with self.assertRaises(ValueError):
            self.export(encoder={'name': 'ffmpeg'}, fps=30)


if __name__ == '__main__':
    unittest.main()
