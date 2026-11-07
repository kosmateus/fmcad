"""Offline GM30 contracts: sections, visibility.finalize, camera orientation and shot.pack presentation."""
import copy
import json
import math
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from python_test_support import load_legacy_core

from io_test import Items, Point, Camera, Viewport, entity

ROOT = Path(__file__).resolve().parents[1]


class Matrix3D:
    def __init__(self, cells=None):
        self.cells = list(cells) if cells else [0.0] * 16
        if not cells:
            self._identity()

    @staticmethod
    def create():
        return Matrix3D()

    def _identity(self):
        self.cells = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

    def asArray(self):
        return list(self.cells)

    def setWithArray(self, cells):
        self.cells = list(cells)
        return True

    def setWithCoordinateSystem(self, origin, xAxis, yAxis, zAxis):
        # column-major basis: column 0 = xAxis, column 1 = yAxis, column 2 = zAxis
        for col, axis in enumerate((xAxis, yAxis, zAxis)):
            self.cells[col] = axis.x
            self.cells[4 + col] = axis.y
            self.cells[8 + col] = axis.z
        self.cells[3] = origin.x
        self.cells[7] = origin.y
        self.cells[11] = origin.z
        self.cells[12] = self.cells[13] = self.cells[14] = 0.0
        self.cells[15] = 1.0
        return True

    def getAsCoordinateSystem(self):
        x = Point(self.cells[0], self.cells[4], self.cells[8])
        y = Point(self.cells[1], self.cells[5], self.cells[9])
        z = Point(self.cells[2], self.cells[6], self.cells[10])
        origin = Point(self.cells[3], self.cells[7], self.cells[11])
        return origin, x, y, z


class Color:
    def __init__(self, r=0, g=0, b=0, a=255):
        self.red, self.green, self.blue, self.opacity = r, g, b, a

    @staticmethod
    def create(*rgba):
        return Color(*rgba)


class Section:
    def __init__(self, name):
        self.objectType = 'adsk::fusion::SectionAnalysis'
        self.name = self.entityToken = name
        self.isLightBulbOn = True
        self.isVisible = True
        self.isHatchShown = True
        self.sectionColor = None
        self.transform = Matrix3D()
        self.initialPosition = Matrix3D()
        self.nativeObject = self.assemblyContext = None
        self.flip_calls = 0

    def flip(self):
        self.flip_calls += 1
        cells = list(self.transform.cells)
        for i in range(3):
            cells[2 + 4 * i] = -cells[2 + 4 * i]
        self.transform.cells = cells
        return True


class NoOpSection(Section):
    def __init__(self, name):
        super().__init__(name)
        self._bulb = True

    @property
    def isLightBulbOn(self):
        return self._bulb

    @isLightBulbOn.setter
    def isLightBulbOn(self, _value):
        pass


class UnreadableSection(Section):
    @property
    def isLightBulbOn(self):
        raise RuntimeError('section visibility readback unavailable')

    @isLightBulbOn.setter
    def isLightBulbOn(self, _value):
        pass


class RestoreFailSection(Section):
    def __init__(self, name):
        self._bulb = True
        super().__init__(name)

    @property
    def isLightBulbOn(self):
        return self._bulb

    @isLightBulbOn.setter
    def isLightBulbOn(self, value):
        if self._bulb is False and value is True:
            raise RuntimeError('section restore injected failure')
        self._bulb = value


class Vec(Point):
    pass


def _adsk():
    adsk = types.ModuleType('adsk')
    adsk.core = types.ModuleType('adsk.core')
    adsk.fusion = types.ModuleType('adsk.fusion')
    adsk.core.Point3D = Point
    adsk.core.Vector3D = Vec
    adsk.core.Matrix3D = Matrix3D
    adsk.core.Color = Color
    adsk.core.Camera = Camera
    adsk.core.CameraTypes = types.SimpleNamespace(OrthographicCameraType=0, PerspectiveCameraType=1,
                                                  PerspectiveWithOrthoFacesCameraType=2)
    adsk.core.ViewOrientations = types.SimpleNamespace(
        FrontViewOrientation=1, BackViewOrientation=2, TopViewOrientation=3, BottomViewOrientation=4,
        LeftViewOrientation=5, RightViewOrientation=6, IsoTopLeftViewOrientation=7,
        IsoTopRightViewOrientation=8, IsoBottomLeftViewOrientation=9, IsoBottomRightViewOrientation=10)
    adsk.fusion.FeatureHealthStates = types.SimpleNamespace(
        HealthyFeatureHealthState=0, WarningFeatureHealthState=1, ErrorFeatureHealthState=2,
        SuppressedFeatureHealthState=3)
    adsk.fusion.SectionAnalysis = types.SimpleNamespace(cast=lambda s: s)
    adsk.fusion.Design = types.SimpleNamespace(cast=lambda d: d)
    return adsk


def load_module():
    adsk = _adsk()
    module = types.ModuleType('presentation_under_test')
    with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
        load_legacy_core(module.__dict__, ROOT)
        for relative in (
                'runtime/python/fmcad/domain/capture_integrity.py',
                'runtime/python/fmcad/domain/io.py',
                'runtime/python/fmcad/adapters/fusion/io.py'):
            source = ROOT / relative
            exec(compile(source.read_text(), str(source), 'exec'), module.__dict__)
        exec(compile((ROOT / 'assets/cad/presentation.py').read_text(), '<presentation>', 'exec'), module.__dict__)
    return adsk, module


class Context:
    def __init__(self, adsk, module):
        self.adsk, self.module = adsk, module
        self.doc = types.SimpleNamespace(creationId='test-id', name='Test', dataFile=None)
        self.root = entity('Component', 'root')
        self.root.allOccurrences = Items()
        self.body = entity('BRepBody', 'Body')
        self.other = entity('BRepBody', 'Other')
        self.root.bRepBodies = Items([self.body, self.other])
        self.root.sketches = Items()
        self.root.constructionPlanes = Items()
        self.entities = {'root': self.root, 'Body': self.body, 'Other': self.other}
        self.app = types.SimpleNamespace(activeDocument=self.doc, materialLibraries=Items())
        self.viewport = Viewport(self.doc)
        self.app.activeViewport = self.viewport
        self.doc.activate = lambda: True
        self.design = types.SimpleNamespace(rootComponent=self.root)
        self.sections = Items()
        self.analyses = types.SimpleNamespace(sectionAnalyses=self.sections, isLightBulbOn=True)
        self.design.analyses = self.analyses
        self.design.computeAll = lambda: True
        self.timeline = Items()
        self.design.timeline = self.timeline
        self.design.activeComponent = self.root
        self.design.activateRootComponent = lambda: setattr(self.design, 'activeComponent', self.root) or True
        self.created = []
        self.component = self.root
        self.occurrence = None

    def ctx(self):
        ctx = types.SimpleNamespace(app=self.app, doc=self.doc, root=self.root, design=self.design,
                                    component=self.root, occurrence=None, created=self.created)
        ctx.assert_identity = lambda: None

        def ref(entity):
            if entity is self.root:
                return {'kind': 'component', 'name': 'root'}
            return {'token': getattr(entity, 'entityToken', None), 'kind': self.module._cad_kind(entity),
                    'name': getattr(entity, 'name', None)}

        ctx.ref = ref
        ctx.length = lambda v: float(v.split()[0]) * {'mm': 0.1, 'cm': 1, 'in': 2.54}[v.split()[1]]
        ctx.angle = lambda v: float(v.split()[0]) * {'deg': math.pi / 180, 'rad': 1}[v.split()[1]]
        ctx.point = lambda xyz: Point(*(ctx.length(v) for v in xyz))
        ctx.require_confirm = lambda d: None
        ctx.call = lambda op, d: self.module.CAD_HANDLERS[op](ctx, d)

        def resolve(ref, kind=None):
            key = ref if isinstance(ref, str) else ref.get('token', ref.get('name'))
            if key not in self.entities:
                raise ValueError('Missing ref ' + str(key))
            found = self.entities[key]
            if kind and self.module._cad_kind(found) != kind:
                raise ValueError('Wrong kind')
            return found

        ctx.resolve = resolve
        return ctx


class SectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.adsk, cls.module = load_module()

    def setUp(self):
        self.fix = Context(self.adsk, self.module)
        self.section = Section('Inspection section')
        self.fix.sections = Items([self.section])
        self.fix.analyses.sectionAnalyses = self.fix.sections
        self.fix.design.analyses = self.fix.analyses
        self.ctx = self.fix.ctx()

    def call(self, op, **data):
        return self.ctx.call(op, data)

    def test_inspect_reads_transform_orientation_hatch(self):
        result = self.call('section.inspect', name='Inspection section')
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['frame']['cutDirection'], [0, 0, 1])
        self.assertTrue(result['isHatchShown'])

    def test_edit_absolute_orientation_and_hatch(self):
        result = self.call('section.edit', name='Inspection section',
                           transform={'origin': ['0 mm', '0 mm', '5 mm'], 'xAxis': [1, 0, 0],
                                      'yAxis': [0, 1, 0], 'zAxis': [0, 0, 1]}, hatch=False)
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['orientationMatch']['zAxisAligned'])
        self.assertFalse(result['after']['isHatchShown'])
        self.assertEqual(result['after']['frame']['origin'], [0, 0, 0.5])

    def test_flip_is_an_operation_that_negates_cut_direction(self):
        before = self.call('section.inspect', name='Inspection section')['frame']['cutDirection']
        result = self.call('section.edit', name='Inspection section', flip=True)
        self.assertEqual(self.section.flip_calls, 1)
        after = result['after']['frame']['cutDirection']
        self.assertAlmostEqual(after[2], -before[2])
        self.assertIn('flip', result['changed'])

    def test_blocked_when_section_api_unavailable(self):
        self.fix.design.analyses = types.SimpleNamespace()
        self.ctx = self.fix.ctx()
        with self.assertRaisesRegex(ValueError, 'cannot access sections'):
            self.call('section.inspect', name='Inspection section')


class FinalizeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.adsk, cls.module = load_module()

    def setUp(self):
        self.fix = Context(self.adsk, self.module)
        self.sketch = entity('Sketch', 'Sketch1')
        self.fix.entities['Sketch1'] = self.sketch
        self.ctx = self.fix.ctx()

    def call(self, op, **data):
        return self.ctx.call(op, data)

    def test_finalize_leaves_state_on_healthy(self):
        result = self.call('visibility.finalize', hide=['Sketch1'], show=['Body'], recompute=True, checkHealth=True)
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['leftRequestedState'])
        self.assertFalse(self.sketch.isLightBulbOn)
        self.assertTrue(self.fix.body.isLightBulbOn)
        self.assertTrue(result['recomputed'])

    def test_finalize_fails_and_restores_on_unhealthy_history(self):
        self.fix.timeline = Items([types.SimpleNamespace(name='Broken', healthState=2, errorOrWarningMessage='boom')])
        self.fix.design.timeline = self.fix.timeline
        result = self.call('visibility.finalize', hide=['Sketch1'], show=['Body'], recompute=True, checkHealth=True)
        self.assertEqual(result['status'], 'fail')
        self.assertTrue(result['restored'])
        self.assertTrue(self.sketch.isLightBulbOn)
        self.assertEqual(result['restoreErrors'], [])

    def test_finalize_restores_on_recompute_failure(self):
        self.fix.design.computeAll = lambda: False
        result = self.call('visibility.finalize', hide=['Sketch1'], show=['Body'], recompute=True, checkHealth=False)
        self.assertEqual(result['status'], 'fail')
        self.assertTrue(result['restored'])
        self.assertTrue(self.sketch.isLightBulbOn)


class CameraOrientationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.adsk, cls.module = load_module()

    def setUp(self):
        self.fix = Context(self.adsk, self.module)
        self.ctx = self.fix.ctx()

    def call(self, op, **data):
        return self.ctx.call(op, data)

    def test_orientation_with_target_is_accepted(self):
        result = self.call('camera.set', orientation='front', target=['1 cm', '2 cm', '3 cm'], fit=True)
        self.assertEqual(result['state']['target'], [1, 2, 3])

    def test_orientation_with_eye_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'orientation cannot be combined'):
            self.call('camera.set', orientation='front', eye=['1 cm', '2 cm', '3 cm'])

    def test_orientation_with_up_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'orientation cannot be combined'):
            self.call('camera.set', orientation='front', up=[0, 0, 1])


class ShotPresentationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.adsk, cls.module = load_module()

    def setUp(self):
        self.fix = Context(self.adsk, self.module)
        self.section = Section('Cut')
        self.fix.sections = Items([self.section])
        self.fix.analyses.sectionAnalyses = self.fix.sections
        self.fix.design.analyses = self.fix.analyses
        child_component = entity('Component', 'Child')
        child_occurrence = entity('Occurrence', 'Child')
        child_occurrence.component = child_component
        child_occurrence.activate = lambda: setattr(self.fix.design, 'activeComponent', child_component) or True
        self.fix.root.allOccurrences = Items([child_occurrence])
        self.fix.entities['Child'] = child_component
        self.child = child_component
        import tempfile
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ctx = self.fix.ctx()

    def call(self, op, **data):
        return self.ctx.call(op, data)

    def path(self, name):
        return str(Path(self.temp.name) / name)

    def test_shot_restores_visibility_sections_and_active_component(self):
        result = self.call('shot.pack', shots=[{
            'path': self.path('a.png'),
            'visibility': [{'ref': 'Body', 'isLightBulbOn': False}],
            'sections': [{'name': 'Cut', 'isLightBulbOn': False}],
            'activeComponent': 'Child'}])
        self.assertTrue(result['cameraRestored'])
        self.assertTrue(result['presentationRestored'])
        self.assertTrue(self.fix.body.isLightBulbOn)
        self.assertTrue(self.section.isLightBulbOn)
        self.assertIs(self.fix.design.activeComponent, self.fix.root)

    def test_second_shot_failure_keeps_first_file_and_restores(self):
        with self.assertRaises(Exception):
            self.call('shot.pack', shots=[
                {'path': self.path('first.png'), 'visibility': [{'ref': 'Body', 'isLightBulbOn': False}]},
                {'path': self.path('second.png'), 'visibility': [{'ref': 'Body', 'isLightBulbOn': False}],
                 'camera': {'orientation': 'invalid'}}])
        self.assertTrue(Path(self.path('first.png')).is_file())
        self.assertFalse(Path(self.path('second.png')).exists())
        self.assertTrue(self.fix.body.isLightBulbOn)

    def test_multiple_shots_restore_each_shots_visibility(self):
        result = self.call('shot.pack', shots=[
            {'path': self.path('a.png'), 'visibility': [{'ref': 'Body', 'isLightBulbOn': False}]},
            {'path': self.path('b.png'), 'visibility': [{'ref': 'Other', 'isLightBulbOn': False}]}])
        self.assertTrue(result['cameraRestored'])
        self.assertTrue(self.fix.body.isLightBulbOn)
        self.assertTrue(self.fix.other.isLightBulbOn)

    def test_capture_policy_does_not_upgrade_section_noop_setter_to_capture_success(self):
        section = NoOpSection('No-op section')
        self.fix.analyses.sectionAnalyses = Items([section])
        self.fix.design.analyses = self.fix.analyses
        result = self.call('shot.pack', shots=[{
            'path': self.path('noop.png'),
            'sections': [{'name': 'No-op section', 'isLightBulbOn': False}],
        }])
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['presentationCapture']['status'], 'unsupported')
        self.assertEqual(result['presentationRestoration']['status'], 'restored')
        self.assertTrue(result['presentationRestored'])
        self.assertTrue(section.isLightBulbOn)

    def test_missing_section_readback_is_unknown_after_independent_restore_attempt(self):
        section = UnreadableSection('Unreadable section')
        self.fix.analyses.sectionAnalyses = Items([section])
        self.fix.design.analyses = self.fix.analyses
        result = self.call('shot.pack', shots=[{
            'path': self.path('unreadable.png'),
            'sections': [{'name': 'Unreadable section', 'isLightBulbOn': False}],
        }])
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['presentationRestoration']['status'], 'unknown')
        self.assertIsNone(result['presentationRestored'])

    def test_section_restore_failure_keeps_image_and_fails_closed(self):
        section = RestoreFailSection('Restore failure')
        self.fix.analyses.sectionAnalyses = Items([section])
        self.fix.design.analyses = self.fix.analyses
        with self.assertRaisesRegex(RuntimeError, 'Section visibility failed'):
            self.call('shot.pack', shots=[{
                'path': self.path('restore-failure.png'),
                'sections': [{'name': 'Restore failure', 'isLightBulbOn': False}],
            }])
        self.assertTrue(Path(self.path('restore-failure.png')).is_file())
        self.assertFalse(section.isLightBulbOn)


if __name__ == '__main__':
    unittest.main()
