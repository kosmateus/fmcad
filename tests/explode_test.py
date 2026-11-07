"""Offline GM36 explode tests: deterministic plan math, phase ordering, and render restore."""
import json
import math
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from python_test_support import load_legacy_core

ROOT = Path(__file__).resolve().parents[1]
NS = types.SimpleNamespace


class Matrix:
    def __init__(self, cells=None):
        self.cells = list(cells) if cells else [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

    def asArray(self):
        return list(self.cells)

    def setWithArray(self, cells):
        self.cells = list(cells)
        return True

    @staticmethod
    def create():
        return Matrix()


class Occurrence:
    def __init__(self, ctx, name):
        self.objectType = 'adsk::fusion::Occurrence'
        self.name = self.entityToken = name
        self.fullPathName = name
        self.assemblyContext = None
        self.ctx = ctx
        self._transform = Matrix()

    @property
    def transform2(self):
        return self._transform

    @transform2.setter
    def transform2(self, value):
        self.ctx.trace.append('transform')
        self._transform = value


class Viewport:
    def __init__(self, ctx):
        self.ctx = ctx

    @property
    def parentDocument(self):
        return self.ctx.doc

    def saveAsImageFile(self, path, width, height):
        self.ctx.trace.append(('png', path, width, height))
        Path(path).write_bytes(b'fake PNG; not rendered geometry')
        return True


def load_module(modules=('core', 'explode')):
    adsk = types.ModuleType('adsk')
    adsk.core = types.ModuleType('adsk.core')
    adsk.fusion = types.ModuleType('adsk.fusion')
    adsk.core.Matrix3D = Matrix
    adsk.core.Point3D = adsk.core.Vector3D = NS(create=lambda x, y, z: NS(x=x, y=y, z=z))
    adsk.fusion.DesignTypes = NS(ParametricDesignType=1, DirectDesignType=0)
    module = types.ModuleType('gm36_under_test')
    with patch.dict(__import__('sys').modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
        if 'core' in modules:
            load_legacy_core(module.__dict__, ROOT)
        for name in modules:
            if name == 'core':
                continue
            exec(compile((ROOT / 'assets/cad' / (name + '.py')).read_text(), name + '.py', 'exec'), module.__dict__)
    return adsk, module


class Context:
    def __init__(self):
        self.trace = []
        self.created = []
        self.entities = {}
        self.component = None
        self.doc = NS(name='Explode test', creationId='explode-test')
        self.app = NS(activeViewport=None)
        self.design = NS(allComponents=NS(count=0, item=lambda i: None))

    def add(self, name, origin=(0, 0, 0)):
        occ = Occurrence(self, name)
        occ._transform.cells[3], occ._transform.cells[7], occ._transform.cells[11] = origin
        self.entities[name] = occ
        self.entities[occ.entityToken] = occ
        return occ

    def resolve(self, ref, kind=None):
        key = ref if isinstance(ref, str) else ref.get('token', ref.get('name'))
        entity = self.entities.get(key)
        if entity is None:
            raise ValueError('missing ref ' + str(key))
        if kind == 'occurrence' and not isinstance(entity, Occurrence):
            raise ValueError('expected occurrence')
        return entity

    def ref(self, entity):
        return {'token': entity.entityToken, 'kind': 'occurrence', 'name': entity.name}

    def length(self, expr):
        number, unit = expr.split()
        return float(number) * {'mm': 0.1, 'cm': 1, 'm': 100, 'in': 2.54}[unit]

    def angle(self, expr):
        number, unit = expr.split()
        return float(number) * {'deg': math.pi / 180, 'rad': 1}[unit]

    def point(self, value):
        return NS(**dict(zip(('x', 'y', 'z'), map(self.length, value))))

    def require_confirm(self, data):
        if data.get('confirm') is not True:
            raise ValueError('confirm required')

    def call(self, operation, data):
        return self.module.CAD_HANDLERS[operation](self, data)


class ExplodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.adsk, cls.module = load_module()

    def setUp(self):
        self.ctx = Context()
        self.ctx.module = self.module
        self.ctx.add('cover', origin=(0, 0, 0))
        self.ctx.add('pcb', origin=(1, 2, 3))

    def plan(self, **extra):
        data = {'schemaVersion': 1, 'occurrences': [
            {'ref': {'token': 'cover'}, 'axis': [0, 0, 1], 'distance': '30 mm', 'phase': 'release', 'label': 'cover'},
            {'ref': {'token': 'pcb'}, 'axis': [0, 0, 1], 'distance': '15 mm', 'phase': 'return', 'label': 'pcb'}],
            'phases': ['cock', 'release', 'return'], 'duration': '2 s', 'fps': 30}
        data.update(extra)
        return self.ctx.call('explode.plan', data)

    def test_frame_count_and_phase_order(self):
        result = self.plan()
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['frameCount'], 61)
        self.assertAlmostEqual(result['durationSeconds'], 2.0)
        self.assertEqual(result['fps'], 30)
        self.assertEqual([p['name'] for p in result['phaseSchedule']], ['cock', 'release', 'return'])
        self.assertEqual(result['order'][0]['label'], 'cover')
        self.assertEqual(result['order'][1]['label'], 'pcb')
        self.assertFalse(result['nativeStoryboardActionsCreated'])
        self.assertTrue(result['explodeIsNotServicePath'])

    def test_deterministic_poses_ease_and_trails(self):
        result = self.plan()
        self.assertEqual(len(result['poses']), result['frameCount'])
        first = result['poses'][0]['occurrences']
        self.assertEqual(first[0]['origin'], [0.0, 0.0, 0.0])
        self.assertAlmostEqual(first[1]['origin'][0], 1.0)
        last = result['poses'][-1]['occurrences']
        self.assertAlmostEqual(last[0]['origin'][2], 3.0)
        self.assertAlmostEqual(last[1]['origin'][2], 3.0 + 1.5)
        self.assertEqual(len(result['trails']), 2)
        self.assertEqual(len(result['trails'][0]['points']), 61)
        self.assertEqual(len(result['balloons']), 2)

    def test_smoothstep_easing_differs_from_linear(self):
        linear = self.plan(easing='linear')
        smooth = self.plan(easing='smoothstep')
        mid_linear = linear['poses'][35]['occurrences'][0]['origin'][2]
        mid_smooth = smooth['poses'][35]['occurrences'][0]['origin'][2]
        self.assertNotEqual(mid_linear, mid_smooth)

    def test_disconnection_precedence_violation_is_fail(self):
        result = self.plan(occurrences=[
            {'ref': {'token': 'cover'}, 'axis': [0, 0, 1], 'distance': '10 mm', 'phase': 'release', 'label': 'cover'},
            {'ref': {'token': 'pcb'}, 'axis': [0, 0, 1], 'distance': '10 mm', 'phase': 'release', 'label': 'pcb'}],
            disconnections=[{'name': 'clip', 'from': {'token': 'cover'}, 'to': {'token': 'pcb'}}])
        self.assertEqual(result['status'], 'fail')
        self.assertEqual(len(result['blockers']), 1)
        self.assertEqual(result['blockers'][0]['name'], 'clip')

    def test_disconnection_cycle_is_fail(self):
        result = self.plan(disconnections=[{'from': {'token': 'cover'}, 'to': {'token': 'pcb'}},
                                            {'from': {'token': 'pcb'}, 'to': {'token': 'cover'}}])
        self.assertEqual(result['status'], 'fail')
        self.assertTrue(result['cycles'])

    def test_invalid_inputs_rejected_without_mutation(self):
        base = self.plan
        invalid = [
            dict(duration=0), dict(fps=0), dict(fps=2.5), dict(easing='nope'),
            dict(occurrences=[{'ref': {'token': 'cover'}, 'axis': [0, 0, 1], 'distance': '-1 mm'}]),
            dict(occurrences=[{'ref': {'token': 'cover'}, 'axis': [0, 0, 0], 'distance': '1 mm'}]),
            dict(occurrences=[{'ref': {'token': 'missing'}, 'axis': [0, 0, 1], 'distance': '1 mm'}]),
            dict(phases=['cock', 'cock']),
            dict(occurrences=[{'ref': {'token': 'cover'}, 'axis': [0, 0, 1], 'distance': '1 mm', 'phase': 'nope'}],
                 phases=['a', 'b']),
        ]
        for extra in invalid:
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.plan(**extra)
        self.assertEqual(self.ctx.trace, [])


class RenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.adsk, cls.module = load_module()

    def setUp(self):
        self.ctx = Context()
        self.ctx.module = self.module
        self.ctx.app = NS(activeViewport=Viewport(self.ctx))
        self.ctx.doc = NS(name='Render test', creationId='render-test')
        self.ctx.add('cover', origin=(0, 0, 0))

    def render(self, **extra):
        data = {'schemaVersion': 1, 'occurrences': [
            {'ref': {'token': 'cover'}, 'axis': [0, 0, 1], 'distance': '30 mm', 'phase': 'release', 'label': 'cover'}],
            'phases': ['cock', 'release', 'return'], 'duration': '1 s', 'fps': 10, 'confirm': True}
        data.update(extra)
        return self.ctx.call('explode.render', data)

    def test_render_restores_original_transform(self):
        result = self.render()
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['restored'])
        self.assertEqual(result['restoreErrors'], [])
        cover = self.ctx.resolve({'token': 'cover'})
        self.assertEqual(cover.transform2.asArray()[11], 0.0)

    def test_restore_false_leaves_final_pose(self):
        result = self.render(restore=False)
        self.assertIsNone(result['restored'])
        cover = self.ctx.resolve({'token': 'cover'})
        self.assertAlmostEqual(cover.transform2.asArray()[11], 3.0)

    def test_frame_capture_produces_pngs(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            result = self.render(directory=directory, prefix='explode', width=640, height=480)
            self.assertEqual(result['status'], 'pass')
            self.assertEqual(len(result['frameFiles']), 11)
            self.assertTrue(all(Path(p).is_file() and Path(p).stat().st_size > 0 for p in result['frameFiles']))
            self.assertEqual(Path(result['frameFiles'][0]).name, 'explode-000.png')

    def test_failure_restores_and_preserves_error(self):
        original = self.ctx.app.activeViewport.saveAsImageFile
        self.ctx.app.activeViewport.saveAsImageFile = lambda *args: False
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            result = self.render(directory=directory)
            self.assertEqual(result['status'], 'fail')
            self.assertIn('Save explode frame', result['error'])
            self.assertTrue(result['restored'])
            self.assertEqual(result['restoreErrors'], [])
            cover = self.ctx.resolve({'token': 'cover'})
            self.assertEqual(cover.transform2.asArray()[11], 0.0)
        self.ctx.app.activeViewport.saveAsImageFile = original

    def test_restore_failure_reported_separately(self):
        def broken(self, value):
            raise RuntimeError('transform setter failed')
        self.ctx.trace.clear()
        real_setter = Occurrence.transform2.fset
        Occurrence.transform2 = property(Occurrence.transform2.fget, broken)
        try:
            result = self.render()
        finally:
            Occurrence.transform2 = property(Occurrence.transform2.fget, real_setter)
        self.assertEqual(result['status'], 'fail')
        self.assertTrue(any('transform setter failed' in e for e in result['restoreErrors']))

    def test_confirm_required(self):
        with self.assertRaises(ValueError):
            self.render(confirm=False)
        self.assertEqual(self.ctx.trace, [])


if __name__ == '__main__':
    unittest.main()
