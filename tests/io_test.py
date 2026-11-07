"""Offline API-contract stubs, not Fusion kernel or live export validation."""
import copy
import json
import math
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
from capture_png import png_bytes

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/cad/io.py'


class Items:
    def __init__(self, values=()):
        self.values = list(values)

    @property
    def count(self):
        return len(self.values)

    def item(self, index):
        return self.values[index]


class Point:
    def __init__(self, x, y, z):
        self.x, self.y, self.z = x, y, z

    @staticmethod
    def create(*xyz):
        return Point(*xyz)


class Matrix:
    def __init__(self):
        self.cells = [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]]

    @staticmethod
    def create():
        return Matrix()

    def getCell(self, row, col):
        return self.cells[row][col]

    def setCell(self, row, col, value):
        self.cells[row][col] = value
        return True

    def asArray(self):
        return sum(self.cells, [])


class Camera:
    def __init__(self):
        self.eye, self.target, self.upVector = Point(10, 0, 0), Point(0, 0, 0), Point(0, 0, 1)
        self.cameraType, self._perspectiveAngle = 0, 0.7
        self.extents = [20, 15]
        self.isFitView = False
        self.isSmoothTransition = False

    @staticmethod
    def create():
        return Camera()

    def getExtents(self):
        if self.cameraType != 0:
            raise AssertionError('getExtents is orthographic-only')
        return True, *self.extents

    def setExtents(self, width, height):
        if self.cameraType != 0:
            raise AssertionError('setExtents is orthographic-only')
        self.extents = [width, height]
        return True

    @property
    def perspectiveAngle(self):
        if self.cameraType == 0:
            raise RuntimeError('perspectiveAngle is invalid for orthographic camera')
        return self._perspectiveAngle

    @perspectiveAngle.setter
    def perspectiveAngle(self, value):
        if self.cameraType == 0:
            raise RuntimeError('perspectiveAngle is invalid for orthographic camera')
        self._perspectiveAngle = value


class Viewport:
    def __init__(self, doc):
        self.parentDocument = doc
        self._camera = Camera()
        self.writes = 0
        self.capture_count = 0
        self.fail_image = False

    @property
    def camera(self):
        return copy.deepcopy(self._camera)

    @camera.setter
    def camera(self, value):
        self.writes += 1
        self._camera = copy.deepcopy(value)

    def saveAsImageFile(self, filename, width, height):
        if self.fail_image:
            return False
        self.capture_count += 1
        Path(filename).write_bytes(png_bytes(width or 64, height or 48, self.capture_count))
        return True


class DeferredProjectionViewport(Viewport):
    """Hypothesis fixture: projection conversion overwrites framing on assignment."""
    def __init__(self, doc):
        super().__init__(doc)
        self.fail_write_at = None
        self.applied = []

    @property
    def camera(self):
        result = super().camera
        result.source_projection = result.cameraType
        result.isFitView = False
        result.isSmoothTransition = False
        return result

    @camera.setter
    def camera(self, value):
        self.writes += 1
        if self.writes == self.fail_write_at:
            raise RuntimeError('Injected viewport assignment failure')
        result = copy.deepcopy(value)
        if value.source_projection != value.cameraType:
            result.extents = [2 * math.tan(result._perspectiveAngle / 2)] * 2
        self._camera = result
        self.applied.append(copy.deepcopy(result))


def entity(kind, name):
    return types.SimpleNamespace(objectType='adsk::fusion::' + kind, name=name, entityToken=name,
                                 isLightBulbOn=True, isVisible=True, isTransient=False,
                                 assemblyContext=None, nativeObject=None)


class IOTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fmcad-io-')
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.root = entity('Component', 'root')
        self.root.allOccurrences = Items()
        self.root.boundingBox = types.SimpleNamespace(minPoint=Point(0, 0, 0), maxPoint=Point(1, 2, 3))
        self.body = entity('BRepBody', 'Body')
        self.body.preciseBoundingBox = copy.deepcopy(self.root.boundingBox)
        self.root.bRepBodies = Items([self.body])
        self.other = entity('BRepBody', 'Other')
        self.entities = {e.name: e for e in (self.root, self.body, self.other)}
        self.doc = types.SimpleNamespace(name='Test', creationId='test-id', dataFile=None,
                                         isModified=True, allDocumentReferences=Items())
        self.doc.close = lambda *args: self.fail('Must not close the user document')
        self.doc.save = lambda *args: self.fail('Must not save the user document')
        self.app = types.SimpleNamespace(activeDocument=self.doc, materialLibraries=Items())
        self.viewport = Viewport(self.doc)
        self.app.activeViewport = self.viewport
        self.doc.activate = lambda: setattr(self.app, 'activeDocument', self.doc) or True
        self.exports = []
        self.options = []

        def option(kind, filename, geometry):
            result = types.SimpleNamespace(kind=kind, filename=filename, geometry=geometry, unitType=None)
            self.options.append(result)
            return result

        def execute(options):
            self.exports.append(options)
            Path(options.filename).write_bytes(b'offline-export-stub')
            return True

        self.manager = types.SimpleNamespace(
            createFusionArchiveExportOptions=lambda p, g: option('native', p, g),
            createSTEPExportOptions=lambda p, g: option('step', p, g),
            createSTLExportOptions=lambda g, p: option('stl', p, g),
            createC3MFExportOptions=lambda g, p: option('3mf', p, g), execute=execute)
        self.design = types.SimpleNamespace(rootComponent=self.root, exportManager=self.manager,
                                           appearances=Items(), materials=Items())
        self.imports, self.closed = [], []

        def new_document(options):
            self.imports.append(options)
            imported = types.SimpleNamespace(name='Imported', creationId='new-id',
                products=types.SimpleNamespace(itemByProductType=lambda _: self.design))
            imported.close = lambda save: self.closed.append((imported, save)) or True
            self.app.activeDocument = imported
            return imported

        self.app.importManager = types.SimpleNamespace(importToNewDocument=new_document,
            importToTarget2=lambda options, target: Items([self.body]))
        for name in ('STEP', 'FusionArchive', 'IGES', 'SAT', 'SMT'):
            setattr(self.app.importManager, 'create' + name + 'ImportOptions', lambda p: p)
        adsk = types.ModuleType('adsk')
        adsk.core = types.ModuleType('adsk.core')
        adsk.fusion = types.ModuleType('adsk.fusion')
        adsk.core.Point3D = adsk.core.Vector3D = Point
        adsk.core.Camera, adsk.core.Matrix2D = Camera, Matrix
        adsk.core.CameraTypes = types.SimpleNamespace(OrthographicCameraType=0, PerspectiveCameraType=1,
                                                     PerspectiveWithOrthoFacesCameraType=2)
        adsk.core.ViewOrientations = types.SimpleNamespace(FrontViewOrientation=1, TopViewOrientation=2)
        adsk.fusion.Design = types.SimpleNamespace(cast=lambda value: value)
        adsk.fusion.DistanceUnits = types.SimpleNamespace(MillimeterDistanceUnits=1, CentimeterDistanceUnits=2, InchDistanceUnits=3)
        self.module = types.ModuleType('io_under_test')
        self.adsk = adsk
        with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
            values = ROOT / 'runtime/python/fmcad/domain/values.py'
            exec(compile(values.read_text(), str(values), 'exec'), self.module.__dict__)
            exec(compile((ROOT / 'assets/cad/core.py').read_text(), '<core>', 'exec'), self.module.__dict__)
            exec(compile((ROOT / 'assets/cad/measure.py').read_text(), '<measure>', 'exec'), self.module.__dict__)
            self.core_handlers = set(self.module.CAD_HANDLERS)
            exec(compile(SOURCE.read_text(), str(SOURCE), 'exec'), self.module.__dict__)
        self.ctx = types.SimpleNamespace(app=self.app, doc=self.doc, root=self.root, design=self.design,
                                         component=self.root, occurrence=None, created=[])
        self.ctx.ref = lambda e: {'token': e.entityToken, 'name': e.name}

        def resolve(ref, kind=None):
            key = ref if isinstance(ref, str) else ref.get('token', ref.get('name'))
            if key not in self.entities:
                raise ValueError('Missing ref')
            found = self.entities[key]
            if kind and self.module._cad_kind(found) != kind:
                raise ValueError('Wrong kind')
            return found

        self.ctx.resolve = resolve
        self.ctx.require_confirm = lambda d: self.module.CadContext.require_confirm(self.ctx, d)

        def length(value):
            if not isinstance(value, str):
                raise ValueError('Explicit units required')
            amount, unit = value.split()
            return float(amount) * {'mm': 0.1, 'cm': 1, 'in': 2.54}[unit]

        self.ctx.length = length
        self.ctx.angle = lambda value: float(value.split()[0]) * {'deg': math.pi / 180, 'rad': 1}[value.split()[1]]
        self.ctx.point = lambda xyz: Point(*(length(v) for v in xyz))
        self.ctx.call = lambda op, d: self.module.CAD_HANDLERS[op](self.ctx, d)

    def call(self, op, **data):
        return self.ctx.call(op, data)

    def path(self, name):
        return str(self.folder / name)

    def input(self, name):
        path = self.folder / name
        path.write_bytes(b'offline-input-stub')
        return str(path)

    def test_catalog_parity_examples_and_flags(self):
        catalog = json.loads((ROOT / 'src/catalog/io.json').read_text())
        self.assertEqual(set(catalog), set(self.module.CAD_HANDLERS) - self.core_handlers)
        self.assertEqual(len(catalog), 28)
        for entry in catalog.values():
            self.assertEqual(set(entry), {'summary', 'required', 'example', 'readOnly', 'limitations', 'inputs'})
            self.assertIs(type(entry['readOnly']), bool)
            self.assertLessEqual(set(entry['required']), set(entry['example']))
            self.assertLessEqual(set(entry['example']), set(entry['inputs']))
        for op in ('camera.set', 'camera.restore', 'shot.pack', 'export.verify', 'checkpoint.open'):
            self.assertFalse(catalog[op]['readOnly'])
        self.assertTrue(catalog['camera.save']['readOnly'])

    def test_bundle_compiles_without_live_fusion(self):
        core = ROOT / 'assets/cad/core.py'
        files = [core] + sorted(p for p in core.parent.glob('*.py') if p != core)
        compile('\n\n'.join(p.read_text() for p in files), '<cad-bundle>', 'exec')
        self.assertNotIn('run', self.module.__dict__)

    def test_visibility_restore_and_prevalidation(self):
        result = self.call('visibility.hide', refs=['Body', 'Other'])
        self.assertFalse(self.body.isLightBulbOn)
        self.call('visibility.restore', state=result['restoreState'])
        self.assertTrue(self.body.isLightBulbOn)
        with self.assertRaises(ValueError):
            self.call('visibility.hide', refs=['Body', 'missing'])
        self.assertTrue(self.body.isLightBulbOn)
        self.call('visibility.isolate', refs=['Body'], scope=['Body', 'Other'])
        self.assertTrue(self.body.isLightBulbOn)
        self.assertFalse(self.other.isLightBulbOn)

    def test_visibility_requires_explicit_scope_and_same_document(self):
        with self.assertRaisesRegex(ValueError, 'scope'):
            self.call('visibility.isolate', refs=['Body'])
        state = self.call('visibility.hide', refs=['Body'])['restoreState']
        state['document']['creationId'] = 'another-doc'
        with self.assertRaisesRegex(ValueError, 'different document'):
            self.call('visibility.restore', state=state)

    def test_camera_save_readonly_and_restore(self):
        before = self.call('camera.save')['state']
        self.assertEqual(self.viewport.writes, 0)
        result = self.call('camera.set', eye=['20 cm', '0 cm', '0 cm'], extents=['30 cm', '20 cm'])
        self.assertEqual(result['state']['eye'], [20, 0, 0])
        self.call('camera.restore', state=before)
        self.assertEqual(self.call('camera.save')['state'], before)

    def test_camera_rejects_wrong_document_parallel_up_and_bad_extents(self):
        with self.assertRaisesRegex(ValueError, 'parallel'):
            self.call('camera.set', up=[1, 0, 0])
        with self.assertRaisesRegex(ValueError, 'positive'):
            self.call('camera.set', extents=['0 cm', '10 cm'])
        self.assertEqual(self.viewport.writes, 0)
        self.app.activeDocument = object()
        with self.assertRaisesRegex(ValueError, 'already be active'):
            self.call('camera.save')
        self.assertEqual(self.viewport.writes, 0)

    def test_camera_projection_switch_requires_appropriate_framing(self):
        with self.assertRaisesRegex(ValueError, 'requires perspectiveAngle'):
            self.call('camera.set', projection='perspective')
        state = self.call('camera.set', projection='perspective', perspectiveAngle='45 deg')['state']
        self.assertAlmostEqual(state['perspectiveAngle'], math.pi / 4)
        with self.assertRaisesRegex(ValueError, 'requires extents'):
            self.call('camera.set', projection='orthographic')
        self.call('camera.set', projection='orthographic', extents=['10 cm', '10 cm'])
        self.assertNotIn('perspectiveAngle', self.call('camera.save')['state'])

    def test_camera_extents_api_contract(self):
        with patch.object(Camera, 'getExtents', autospec=True, return_value=(True, 30., 12.)) as get:
            state = self.call('camera.save')['state']
            self.assertEqual(state['extents'], [30., 12.])
            self.assertEqual(len(get.call_args.args), 1)  # self only; no output arguments.
        with patch.object(Camera, 'setExtents', autospec=True, return_value=True) as set_extents:
            self.call('camera.restore', state=state)
            self.assertEqual(set_extents.call_args.args[1:], (30., 12.))
            self.assertEqual(set_extents.call_args.args[0].cameraType, 0)
            self.call('camera.set', extents=['300 mm', '120 mm'])
            self.assertEqual(set_extents.call_args.args[1:], (30., 12.))
        with patch.object(Camera, 'getExtents', return_value=(False, 30., 12.)):
            with self.assertRaisesRegex(RuntimeError, 'Read camera extents'):
                self.call('camera.save')
        with patch.object(Camera, 'setExtents', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'Set camera extents'):
                self.call('camera.restore', state=state)

    def test_camera_lens_side_effects_do_not_replace_explicit_pose(self):
        original = self.call('camera.save')['state']
        setter = Camera.perspectiveAngle.fset

        def set_angle(camera, angle):
            setter(camera, angle)
            camera.eye = Point(100, 100, 100)
            camera.target = Point(1, 1, 1)

        self.viewport._camera.native_context = 'viewport'
        with patch.object(Camera, 'perspectiveAngle', property(Camera.perspectiveAngle.fget, set_angle)):
            changed = self.call('camera.set', projection='perspective', perspectiveAngle='40 deg',
                                eye=['8 cm', '6 cm', '5 cm'], target=['1 cm', '0.6 cm', '0.5 cm'],
                                up=[0, 0, 1], fit=False)['state']
            self.assertEqual(changed['eye'], [8, 6, 5])
            self.assertEqual(changed['target'], [1, 0.6, 0.5])
            self.assertAlmostEqual(changed['perspectiveAngle'], math.radians(40))
            self.assertNotIn('extents', changed)
            for camera_type in (1, 2):
                for fail in (False, True):
                    with self.subTest(camera_type=camera_type, fail=fail):
                        self.viewport._camera.cameraType = camera_type
                        before = self.call('camera.save')['state']
                        self.viewport.fail_image = fail
                        shots = [{'path': self.path('shot.png'), 'camera': {
                            'eye': ['40 cm', '0 cm', '0 cm'], 'perspectiveAngle': '60 deg'}}]
                        if fail:
                            shots[0]['path'] = self.path('failed.png')
                            with self.assertRaisesRegex(RuntimeError, 'Save image'):
                                self.call('shot.pack', shots=shots)
                        else:
                            shots[0]['path'] = self.path(str(camera_type) + '.png')
                            self.assertTrue(self.call('shot.pack', shots=shots)['cameraRestored'])
                        self.assertEqual(self.call('camera.save')['state'], before)
                        self.assertEqual(self.viewport.camera.native_context, 'viewport')
        set_extents = Camera.setExtents

        def set_orthographic_extents(camera, width, height):
            result = set_extents(camera, width, height)
            camera.eye = Point(200, 200, 200)
            return result

        with patch.object(Camera, 'setExtents', set_orthographic_extents):
            self.call('camera.restore', state=original)
        self.assertEqual(self.call('camera.save')['state'], original)

    def test_shot_failure_restores_camera(self):
        before = self.call('camera.save')['state']
        self.viewport.fail_image = True
        with self.assertRaisesRegex(RuntimeError, 'Save image'):
            self.call('shot.pack', shots=[{'path': self.path('a.png'), 'camera': {'eye': ['40 cm', '0 cm', '0 cm']}}])
        self.assertEqual(self.call('camera.save')['state'], before)

    def test_camera_deferred_projection_restore_is_idempotent(self):
        self.viewport = DeferredProjectionViewport(self.doc)
        self.app.activeViewport = self.viewport
        self.viewport._camera.extents = [15.366880495122542, 17.744145180927614]
        original = self.call('camera.save')['state']
        changed = self.call('camera.set', projection='perspective', perspectiveAngle='40 deg',
                            eye=['8 cm', '6 cm', '5 cm'])['state']
        # Establish that the previous one-assignment path really loses extents.
        prepared = self.module._io_camera_from_state(self.ctx, original)
        self.assertEqual(prepared.getExtents(), (True, *original['extents']))
        self.viewport.camera = prepared
        self.assertAlmostEqual(self.viewport.camera.getExtents()[1], 0.7279404685324047)
        self.assertNotEqual(self.call('camera.save')['state'], original)
        self.call('camera.restore', state=changed)
        writes = self.viewport.writes
        restored = self.call('camera.restore', state=original)['state']
        self.assertEqual(self.viewport.writes - writes, 2)
        self.assertEqual(restored, original)
        self.assertEqual(self.viewport.applied[-2].cameraType, 0)
        self.assertNotEqual(self.viewport.applied[-2].extents, original['extents'])
        self.assertEqual(self.viewport.applied[-1].extents, original['extents'])
        self.assertEqual(self.call('camera.restore', state=original)['state'], original)
        self.assertEqual(self.viewport.writes - writes, 3)
        self.assertTrue(all(not c.isFitView and not c.isSmoothTransition for c in self.viewport.applied))

    def test_camera_does_not_reassign_settled_projection(self):
        # Keep the settled projection untouched in the native probe's pose stage.
        def set_projection(camera, value):
            self.assertNotEqual(camera.__dict__['cameraType'], value,
                                'Must not repeat cameraType on a settled projection')
            camera.__dict__['cameraType'] = value

        original = self.call('camera.save')['state']
        with patch.object(Camera, 'cameraType', property(
                lambda c: c.__dict__['cameraType'], set_projection), create=True):
            changed = self.call('camera.set', projection='perspective', perspectiveAngle='40 deg',
                                eye=['8 cm', '6 cm', '5 cm'])['state']
            self.assertEqual(changed['eye'], [8, 6, 5])
            self.assertEqual(self.call('camera.restore', state=changed)['state'], changed)
            self.assertEqual(self.call('camera.restore', state=original)['state'], original)
            self.assertEqual(self.call('camera.restore', state=original)['state'], original)

    def test_camera_commits_changed_fov_before_explicit_pose(self):
        class LensViewport(Viewport):
            @Viewport.camera.setter
            def camera(self, value):
                lens_changed = (value.cameraType != self._camera.cameraType or
                                value._perspectiveAngle != self._camera._perspectiveAngle)
                Viewport.camera.fset(self, value)
                if lens_changed and value.cameraType != 0:
                    # Native live-camera-probe recorded this displaced eye.x
                    # after assignment, despite a prepared eye.x of 8.
                    self._camera.eye.x = 4.846468387236471

        self.viewport = LensViewport(self.doc)
        self.app.activeViewport = self.viewport
        original = self.call('camera.save')['state']
        for angle in ('40 deg', '60 deg'):
            with self.subTest(angle=angle):
                writes = self.viewport.writes
                changed = self.call('camera.set', projection='perspective', perspectiveAngle=angle,
                                    eye=['8 cm', '6 cm', '5 cm'])['state']
                self.assertEqual(self.viewport.writes - writes, 2)
                self.assertEqual(changed['eye'], [8, 6, 5])
                self.assertAlmostEqual(changed['perspectiveAngle'], self.ctx.angle(angle))
                self.assertEqual(self.call('camera.restore', state=changed)['state'], changed)
        self.assertEqual(self.call('camera.restore', state=original)['state'], original)

    def test_camera_deferred_projection_failure_rolls_back(self):
        self.viewport = DeferredProjectionViewport(self.doc)
        self.app.activeViewport = self.viewport
        original = self.call('camera.save')['state']
        changed = self.call('camera.set', projection='perspective', perspectiveAngle='40 deg')['state']
        for stage in (1, 2):
            with self.subTest(stage=stage):
                self.viewport.fail_write_at = self.viewport.writes + stage
                with self.assertRaisesRegex(RuntimeError, 'Injected viewport assignment'):
                    self.call('camera.restore', state=original)
                self.assertEqual(self.call('camera.save')['state'], changed)
        self.viewport.fail_write_at = None
        set_extents = Camera.setExtents
        calls = []

        def fail_after_projection(camera, width, height):
            calls.append((width, height))
            return False if len(calls) == 1 else set_extents(camera, width, height)

        with patch.object(Camera, 'setExtents', fail_after_projection):
            with self.assertRaisesRegex(RuntimeError, 'Set camera extents'):
                self.call('camera.restore', state=original)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.call('camera.save')['state'], changed)
        writes = self.viewport.writes
        with self.assertRaisesRegex(ValueError, 'positive'):
            self.call('camera.restore', state=dict(original, extents=[0, 1]))
        self.assertEqual(self.viewport.writes, writes)

    def test_shots_deferred_projection_restores_after_success_and_failure(self):
        self.viewport = DeferredProjectionViewport(self.doc)
        self.app.activeViewport = self.viewport
        original = self.call('camera.save')['state']
        for fail in (False, True):
            with self.subTest(fail=fail):
                self.viewport.fail_image = fail
                shots = [{'path': self.path(str(fail) + '.png'), 'camera': {
                    'projection': 'perspective', 'perspectiveAngle': '40 deg',
                    'eye': ['8 cm', '6 cm', '5 cm']}}]
                if fail:
                    with self.assertRaisesRegex(RuntimeError, 'Save image'):
                        self.call('shot.pack', shots=shots)
                else:
                    self.assertTrue(self.call('shot.pack', shots=shots)['cameraRestored'])
                self.assertEqual(self.call('camera.save')['state'], original)

    def test_shots_outputs_and_duplicate_guard(self):
        result = self.call('shot.pack', shots=[{'path': self.path('a.png')}])
        self.assertTrue(result['images'][0]['exists'])
        with self.assertRaisesRegex(ValueError, 'distinct'):
            self.call('shot.pack', shots=[{'path': self.path('b.png')}] * 2)
        self.assertFalse(Path(self.path('b.png')).exists())

    def test_visual_pair_not_metric_or_overlay(self):
        left, right = self.input('left.png'), self.input('right.png')
        result = self.call('view.compare', left=left, right=right)
        self.assertFalse(result['metricVerification'])
        self.assertEqual(len(result['images']), 2)
        with self.assertRaisesRegex(ValueError, 'composit'):
            self.call('view.compare', left=left, right=right, mode='overlay')

    def test_shot_primary_and_cleanup_failure_combinations(self):
        for render_fails in (False, True):
            for restore_fails in (False, True):
                with self.subTest(render=render_fails, restore=restore_fails):
                    primary = ValueError('injected render failure')
                    secondary = RuntimeError('injected camera restore failure')
                    path = self.path(f'{render_fails}-{restore_fails}.png')
                    render = self.viewport.saveAsImageFile

                    def image(*args):
                        if render_fails:
                            raise primary
                        return render(*args)

                    with patch.object(self.viewport, 'saveAsImageFile', side_effect=image), patch.object(
                            self.module, '_io_camera_apply', side_effect=secondary if restore_fails else None) as restore:
                        if not render_fails and not restore_fails:
                            self.assertTrue(self.call('shot.pack', shots=[{'path': path}])['cameraRestored'])
                        else:
                            with self.assertRaises(Exception) as raised:
                                self.call('shot.pack', shots=[{'path': path}])
                            if restore_fails:
                                payload = json.loads(str(raised.exception).split(': ', 1)[1])
                                self.assertEqual(payload, {'primaryError': {
                                    'type': 'ValueError', 'message': str(primary)} if render_fails else None,
                                    'cleanupErrors': [{'action': 'Restore original camera',
                                        'type': 'RuntimeError', 'message': str(secondary)}]})
                                self.assertIs(raised.exception.__cause__, primary if render_fails else secondary)
                            else:
                                self.assertIs(raised.exception, primary)
                        restore.assert_called_once()
                    self.assertEqual(Path(path).exists(), not render_fails)

    def test_late_shot_camera_failure_keeps_prefix_and_restores_camera(self):
        before = self.call('camera.save')['state']
        first, second = self.path('prefix.png'), self.path('invalid-camera.png')
        with self.assertRaisesRegex(ValueError, 'Unsupported orientation'):
            self.call('shot.pack', shots=[
                {'path': first, 'camera': {'eye': ['5 cm', '0 cm', '0 cm']}},
                {'path': second, 'camera': {'orientation': 'invalid'}}])
        self.assertTrue(Path(first).is_file())
        self.assertFalse(Path(second).exists())
        self.assertEqual(self.call('camera.save')['state'], before)

    def test_export_paths_overwrite_and_confirm(self):
        path = self.input('out.step')
        for extra in ({}, {'overwrite': True}, {'overwrite': True, 'confirm': 'true'}):
            with self.assertRaises(ValueError):
                self.call('export.step', path=path, **extra)
        self.assertEqual(len(self.exports), 0)
        result = self.call('export.step', path=path, overwrite=True, confirm=True)
        self.assertTrue(result['exists'])
        self.assertFalse(result['geometryVerified'])
        with self.assertRaisesRegex(ValueError, 'absolute'):
            self.call('export.step', path='relative.step')
        with self.assertRaisesRegex(ValueError, 'parent'):
            self.call('export.step', path=self.path('missing/out.step'))

    def test_native_external_references_fail_before_export(self):
        self.doc.allDocumentReferences = Items([object()])
        with self.assertRaisesRegex(ValueError, 'external references'):
            self.call('export.native', path=self.path('out.f3d'))
        self.assertEqual(self.options, [])
        self.doc.allDocumentReferences = Items()
        self.root.allOccurrences = Items([types.SimpleNamespace(isReferencedComponent=True)])
        with self.assertRaisesRegex(ValueError, 'self-contained'):
            self.call('checkpoint.create', path=self.path('out.f3d'))
        with self.assertRaisesRegex(ValueError, 'F3Z'):
            self.call('export.native', path=self.path('out.f3z'))
        self.assertEqual(self.exports, [])

    def test_mesh_units_and_no_implicit_filenames(self):
        with self.assertRaisesRegex(ValueError, 'explicit units'):
            self.call('export.mesh', path=self.path('out.stl'))
        self.call('export.mesh', path=self.path('out.stl'), units='mm', ref='Body')
        option = self.exports[-1]
        self.assertEqual(option.unitType, 1)
        self.assertFalse(option.sendToPrintUtility)
        self.assertFalse(option.isOneFilePerBody)
        self.call('export.mesh', path=self.path('out.3mf'))
        self.assertEqual(self.exports[-1].kind, '3mf')

    def test_parts_prevalidate_all_paths(self):
        with self.assertRaisesRegex(ValueError, 'distinct'):
            self.call('export.parts', parts=[{'ref': 'root', 'format': 'step', 'path': self.path('same.step')}] * 2)
        self.assertEqual(self.exports, [])
        with self.assertRaises(ValueError):
            self.call('export.parts', parts=[{'ref': 'root', 'format': 'step', 'path': self.path('good.step')},
                                            {'ref': 'missing', 'format': 'step', 'path': self.path('bad.step')}])
        self.assertEqual(self.exports, [])

    def test_false_export_not_silent_and_missing_output_not_success(self):
        self.manager.execute = lambda _: False
        with self.assertRaisesRegex(RuntimeError, 'Export'):
            self.call('export.step', path=self.path('out.step'))
        self.manager.execute = lambda _: True
        with self.assertRaisesRegex(RuntimeError, 'missing or empty'):
            self.call('export.step', path=self.path('out.step'))

    def test_checkpoint_create_list_inspect_open_preserves_unsaved_doc(self):
        path = self.path('checkpoint.f3d')
        self.assertFalse(self.call('checkpoint.create', path=path)['userDocumentSaved'])
        self.assertEqual(len(self.call('checkpoint.list', directory=str(self.folder))['checkpoints']), 1)
        self.assertGreater(self.call('checkpoint.inspect', path=path)['bytes'], 0)
        result = self.call('checkpoint.open', path=path)
        self.assertTrue(result['newUnsavedDocument'])
        self.assertTrue(self.doc.isModified)
        self.assertEqual(self.closed, [])
        self.assertIsNot(self.app.activeDocument, self.doc)

    def test_import_component_and_unsupported_mesh_history(self):
        result = self.call('import.file', path=self.input('source.step'), mode='component')
        self.assertFalse(result['historyReconstructed'])
        self.assertEqual(result['created'], self.ctx.created)
        for extension in ('stl', 'f3z'):
            with self.assertRaisesRegex(ValueError, 'history'):
                self.call('import.file', path=self.input('source.' + extension), mode='new')
        self.assertEqual(self.imports, [])

    def test_verify_file_check_separate_from_actual_reimport(self):
        result = self.call('export.verify', path=self.path('missing.step'))
        self.assertFalse(result['exists'])
        self.assertEqual(self.imports, [])
        source = self.input('source.step')
        result = self.call('export.verify', path=source, reimport=True)
        self.assertTrue(result['reimported'])
        self.assertTrue(result['comparison']['withinTolerance'])
        self.assertFalse(result['geometryVerified'])
        self.assertEqual(len(self.imports), 1)
        self.assertEqual(len(self.closed), 1)
        self.assertFalse(self.closed[0][1])
        self.assertIs(self.app.activeDocument, self.doc)

    def test_reimport_failure_closes_only_owned_doc_and_restores_activation(self):
        self.adsk.fusion.Design.cast = lambda _: None
        with self.assertRaisesRegex(ValueError, 'Design product'):
            self.call('export.verify', path=self.input('source.step'), reimport=True)
        self.assertEqual(len(self.closed), 1)
        self.assertIs(self.app.activeDocument, self.doc)

    def test_verify_rf01_15_uses_geometry_union_not_visible_graphics(self):
        def cube(name, x):
            body = entity('BRepBody', name)
            body.preciseBoundingBox = types.SimpleNamespace(
                minPoint=Point(x, 0, 0), maxPoint=Point(x + 1, 1, 1))
            body.boundingBox = types.SimpleNamespace(
                minPoint=Point(-99, -99, -99), maxPoint=Point(99, 99, 99))
            body.isLightBulbOn = body.isVisible = False
            return body

        source = entity('Component', 'A')
        source.bRepBodies = Items([cube('direct', 0)])
        proxy = cube('placed', 2)
        source.allOccurrences = Items([types.SimpleNamespace(bRepBodies=Items([proxy]))])
        source.boundingBox = types.SimpleNamespace(minPoint=Point(-100, -100, -100),
                                                  maxPoint=Point(100, 100, 100))
        imported_root = entity('Component', 'Imported root')
        imported_root.bRepBodies = Items([cube('first', 0), cube('second', 2)])
        imported_root.allOccurrences = Items()
        imported_root.boundingBox = types.SimpleNamespace(minPoint=Point(-0.002, -0.002, -0.002),
                                                         maxPoint=Point(3.002, 1.002, 1.002))
        self.entities['A'] = source
        self.design.rootComponent = imported_root
        path = self.input('identical-cubes.step')
        for explicit in (False, True):
            with self.subTest(explicit=explicit):
                self.ctx.component = self.root if explicit else source
                result = self.call('export.verify', path=path, reimport=True,
                                   **({'ref': 'A'} if explicit else {}))
                self.assertEqual(result['comparison'], {
                    'method': 'axis-aligned bounding box only', 'units': 'cm',
                    'source': [0, 0, 0, 3, 1, 1], 'reimport': [0, 0, 0, 3, 1, 1],
                    'absoluteDeltas': [0] * 6, 'tolerance': 0.001, 'withinTolerance': True})
                self.assertFalse(result['geometryVerified'])
                self.assertIn('topology', result['limitations'][0])
                self.assertIn('mass', result['limitations'][0])
                self.assertFalse(proxy.isLightBulbOn)
                self.assertIs(self.app.activeDocument, self.doc)
        # A real geometric extent difference must still fail the unchanged tolerance.
        imported_root.bRepBodies.item(1).preciseBoundingBox.maxPoint.x = 3.01
        result = self.call('export.verify', path=path, reimport=True, ref='A')
        self.assertFalse(result['comparison']['withinTolerance'])
        self.assertAlmostEqual(result['comparison']['absoluteDeltas'][3], 0.01)

    def test_verify_refuses_empty_or_invalid_brep_bounds_on_either_side(self):
        path = self.input('invalid-bounds.step')
        valid = copy.deepcopy(self.body.preciseBoundingBox)
        for side in ('source', 'imported'):
            for case in ('empty', 'null', 'inverted', 'nan', 'infinite', 'overflow'):
                with self.subTest(side=side, case=case):
                    bad = entity('Component', 'Bad')
                    body = entity('BRepBody', 'Bad body')
                    body.preciseBoundingBox = copy.deepcopy(valid)
                    bad.bRepBodies, bad.allOccurrences = Items([body]), Items()
                    bad.boundingBox = valid  # A plausible graphics box must not rescue invalid geometry.
                    if case == 'empty':
                        bad.bRepBodies = Items()
                    elif case == 'null':
                        body.preciseBoundingBox = None
                    elif case == 'inverted':
                        body.preciseBoundingBox.minPoint.x = 2
                    elif case in ('nan', 'infinite'):
                        body.preciseBoundingBox.maxPoint.x = math.nan if case == 'nan' else math.inf
                    else:
                        body.preciseBoundingBox.minPoint.x = -1e308
                        body.preciseBoundingBox.maxPoint.x = 1e308
                    self.ctx.component = bad if side == 'source' else self.root
                    self.design.rootComponent = bad if side == 'imported' else self.root
                    self.imports.clear()
                    self.closed.clear()
                    with self.assertRaisesRegex(ValueError, 'nonempty|no geometric|invalid|non-finite'):
                        self.call('export.verify', path=path, reimport=True)
                    self.assertEqual(len(self.imports), int(side == 'imported'))
                    self.assertEqual(len(self.closed), int(side == 'imported'))
                    self.assertIs(self.app.activeDocument, self.doc)

    def test_verify_cleanup_failures_are_independent_and_keep_primary(self):
        path = self.input('cleanup.step')
        original_import = self.app.importManager.importToNewDocument
        for comparison_fails in (False, True):
            for close_mode in ('ok', 'false', 'throw'):
                for activate_mode in ('ok', 'false', 'throw'):
                    with self.subTest(compare=comparison_fails, close=close_mode, activate=activate_mode):
                        events, owned = [], []
                        primary = ValueError('injected comparison failure')
                        # Prior active document deliberately differs from scoped source.
                        prior = types.SimpleNamespace(close=lambda *_: self.fail('Wrong document close'))
                        self.app.activeDocument = prior

                        def cleanup(mode, label):
                            events.append(label)
                            if mode == 'throw':
                                raise OSError('injected ' + label)
                            return mode != 'false'

                        def activate():
                            ok = cleanup(activate_mode, 'activate')
                            if ok:
                                self.app.activeDocument = prior
                            return ok

                        prior.activate = activate

                        def new_document(options):
                            doc = original_import(options)
                            owned.append(doc)

                            def close(save):
                                self.assertIs(save, False)
                                return cleanup(close_mode, 'close')

                            doc.close = close
                            # An unrelated document becomes active during comparison;
                            # cleanup must use the returned import, never activeDocument.
                            self.app.activeDocument = self.doc
                            return doc

                        def cast(value):
                            if comparison_fails:
                                raise primary
                            return value

                        with patch.object(self.app.importManager, 'importToNewDocument', new_document), patch.object(
                                self.adsk.fusion.Design, 'cast', cast):
                            if not comparison_fails and close_mode == activate_mode == 'ok':
                                self.assertTrue(self.call('export.verify', path=path, reimport=True)['reimported'])
                            else:
                                with self.assertRaises(Exception) as raised:
                                    self.call('export.verify', path=path, reimport=True)
                                if close_mode == activate_mode == 'ok':
                                    self.assertIs(raised.exception, primary)
                                else:
                                    payload = json.loads(str(raised.exception).split(': ', 1)[1])
                                    self.assertEqual(payload['primaryError'], {
                                        'type': 'ValueError', 'message': str(primary)} if comparison_fails else None)
                                    expected = []
                                    for mode, label, action in (
                                            (close_mode, 'close', 'Close verification-owned temporary document'),
                                            (activate_mode, 'activate', 'Restore previously active document')):
                                        if mode != 'ok':
                                            expected.append({'action': action,
                                                'type': 'OSError' if mode == 'throw' else 'RuntimeError',
                                                'message': 'injected ' + label if mode == 'throw' else
                                                    action + ' failed; inspect the document for partial changes'})
                                    self.assertEqual(payload['cleanupErrors'], expected)
                                    if comparison_fails:
                                        self.assertIs(raised.exception.__cause__, primary)
                        self.assertEqual(len(owned), 1)
                        self.assertEqual(events, ['close', 'activate'])
                        if activate_mode == 'ok':
                            self.assertIs(self.app.activeDocument, prior)

    def test_verify_import_failure_restores_prior_without_guessing_owned_document(self):
        path = self.input('import-failure.step')
        for mode in ('false', 'throw'):
            with self.subTest(mode=mode):
                self.app.activeDocument = self.doc
                unknown = types.SimpleNamespace(close=lambda *_: self.fail('Unknown ownership'))
                primary = OSError('injected import failure')

                def fail_import(options):
                    self.app.activeDocument = unknown
                    if mode == 'throw':
                        raise primary
                    return False

                with patch.object(self.app.importManager, 'importToNewDocument', fail_import):
                    with self.assertRaises(Exception) as raised:
                        self.call('export.verify', path=path, reimport=True)
                if mode == 'throw':
                    self.assertIs(raised.exception, primary)
                else:
                    self.assertIn('Verification reimport', str(raised.exception))
                self.assertIs(self.app.activeDocument, self.doc)
                self.assertEqual(self.closed, [])

    def test_verify_without_previous_active_document_still_closes_import(self):
        self.app.activeDocument = None
        self.call('export.verify', path=self.input('no-prior.step'), reimport=True)
        self.assertEqual(len(self.closed), 1)

    def test_verify_import_and_activation_failure_preserve_import_exception(self):
        primary = OSError('injected import failure')
        secondary = ValueError('injected activation failure')
        with patch.object(self.app.importManager, 'importToNewDocument', side_effect=primary), patch.object(
                self.doc, 'activate', side_effect=secondary) as activate:
            with self.assertRaisesRegex(RuntimeError, '^I/O cleanup failed: ') as raised:
                self.call('export.verify', path=self.input('both-fail.step'), reimport=True)
        activate.assert_called_once_with()
        self.assertIs(raised.exception.__cause__, primary)
        self.assertEqual(json.loads(str(raised.exception).split(': ', 1)[1]), {
            'primaryError': {'type': 'OSError', 'message': str(primary)},
            'cleanupErrors': [{'action': 'Restore previously active document',
                               'type': 'ValueError', 'message': str(secondary)}]})
        self.assertEqual(self.closed, [])

    def test_appearance_and_material_are_distinct(self):
        appearance = types.SimpleNamespace(id='visual', name='Visual')
        material = types.SimpleNamespace(id='physical', name='Physical')
        self.design.appearances = Items([appearance])
        self.design.materials = Items([material])
        self.body.appearance, self.body.material = None, None
        self.call('appearance.assign', refs=['Body'], id='visual')
        self.assertIsNone(self.body.material)
        self.call('material.assign', refs=['Body'], id='physical')
        self.assertIs(self.body.appearance, appearance)
        self.assertIs(self.body.material, material)
        self.assertEqual(self.call('appearance.list')['items'][0]['id'], 'visual')
        self.assertEqual(self.call('material.list')['items'][0]['id'], 'physical')

    def test_section_real_creation_and_actionable_unsupported(self):
        sections = Items()
        analyses = types.SimpleNamespace(sectionAnalyses=sections, isLightBulbOn=True)
        self.design.analyses = analyses
        self.entities['Plane'] = entity('ConstructionPlane', 'Plane')
        with self.assertRaisesRegex(ValueError, 'update Fusion'):
            self.call('section.view', mode='create', name='Cut', plane='Plane')
        sections.createInput = lambda p, d: (p, d)

        def add(inp):
            section = entity('SectionAnalysis', 'Section')
            sections.values.append(section)
            return section

        sections.add = add
        result = self.call('section.view', mode='create', name='Cut', plane='Plane', offset='5 mm')
        self.assertEqual(result['representation'], 'real section analysis')
        self.call('section.view', mode='hide', name='Cut')
        self.assertFalse(sections.item(0).isLightBulbOn)
        self.assertTrue(analyses.isLightBulbOn)

    def test_reference_calibrates_scale_rotation_and_anchor(self):
        canvas = entity('Canvas', 'Canvas')
        canvas.transform = Matrix()
        self.entities['Canvas'] = canvas
        result = self.call('reference.image', mode='calibrate', ref={'token': 'Canvas'},
                           segment=[['1 cm', '2 cm'], ['3 cm', '2 cm']], length='4 cm',
                           anchor=['10 cm', '20 cm'], angle='90 deg')
        matrix = canvas.transform

        def transformed(x, y):
            return [matrix.getCell(r, 0) * x + matrix.getCell(r, 1) * y + matrix.getCell(r, 2) for r in range(2)]

        self.assertAlmostEqual(transformed(1, 2)[0], 10)
        self.assertAlmostEqual(transformed(1, 2)[1], 20)
        self.assertAlmostEqual(transformed(3, 2)[0], 10)
        self.assertAlmostEqual(transformed(3, 2)[1], 24)
        self.assertFalse(result['metricVerification'])
        with self.assertRaisesRegex(ValueError, 'Insert > Canvas'):
            self.call('reference.image', mode='insert')

    def test_reference_zero_segment_does_not_change_transform(self):
        canvas = entity('Canvas', 'Canvas')
        canvas.transform = Matrix()
        self.entities['Canvas'] = canvas
        previous = canvas.transform
        with self.assertRaisesRegex(ValueError, 'positive'):
            self.call('reference.image', mode='calibrate', ref='Canvas',
                      segment=[['0 cm', '0 cm']] * 2, length='10 cm', anchor=['0 cm', '0 cm'])
        self.assertIs(canvas.transform, previous)


if __name__ == '__main__':
    unittest.main()
