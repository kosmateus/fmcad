"""Offline SDK stubs only. No Fusion import, discovery, configuration or network."""
import copy
import contextlib
import enum
import io
import json
import pathlib
import struct
import tempfile
import sys
import types
import unittest
from unittest.mock import patch
from capture_png import png_bytes

ROOT = pathlib.Path(__file__).resolve().parents[1]
NS = {}
exec(compile((ROOT / 'assets/cad/identity.py').read_text(), 'identity.py', 'exec'), NS)
exec(compile((ROOT / 'assets/review.py').read_text(), 'review.py', 'exec'), NS)


class CameraTypes(enum.IntEnum):
    OrthographicCameraType = 0
    PerspectiveCameraType = 1
    PerspectiveWithOrthoFacesCameraType = 2


class XYZ:
    def __init__(self, *xyz):
        self.xyz = xyz

    def asArray(self):
        return self.xyz

    @staticmethod
    def create(*xyz):
        return XYZ(*xyz)


class Camera:
    def __init__(self):
        self.cameraType = CameraTypes.OrthographicCameraType
        self.eye, self.target, self.upVector = XYZ(11, 12, 13), XYZ(1, 2, 3), XYZ(0, 0, 1)
        self.extents = (21, 17)
        self.perspectiveAngle = 0.7
        self.isFitView = False
        self.isSmoothTransition = False
        self.viewOrientation = 0

    def getExtents(self):
        return True, *self.extents

    def setExtents(self, width, height):
        self.extents = (width, height)
        return True

    create = staticmethod(lambda: Camera())


class Viewport:
    def __init__(self):
        self._camera = Camera()
        self._style = 7
        self.captures = []
        self.fail_capture = None
        self.fail_restore_style = False
        self.fail_restore_camera = False
        self.capture_hook = None

    @property
    def camera(self):
        return copy.deepcopy(self._camera)

    @camera.setter
    def camera(self, value):
        prepared = copy.deepcopy(value)
        if self.fail_restore_camera and len(self.captures) == 8 and not value.isFitView:
            raise RuntimeError('camera restore injected failure')
        if prepared.cameraType != self._camera.cameraType:
            # Mimic projection conversion shifting pose and scale on first apply.
            prepared.eye = XYZ(999, 999, 999)
            prepared.extents = (0.4, 0.4)
        if value.isFitView:
            directions = [(0, -1, 0), (0, 1, 0), (-1, 0, 0), (1, 0, 0),
                          (0, 0, 1), (0, 0, -1), (-1, -1, 1), (1, -1, -1)]
            prepared.target = XYZ(0, 0, 0)
            prepared.eye = XYZ(*(10*x for x in directions[value.viewOrientation-1]))
            # Actual Fusion 2705 reports arbitrary even after a correct named view.
            prepared.viewOrientation = 0
            prepared.extents = (40, 30)
        self._camera = prepared

    @property
    def visualStyle(self):
        return self._style

    @visualStyle.setter
    def visualStyle(self, value):
        if self.fail_restore_style and value == 7:
            raise RuntimeError('style restore injected failure')
        self._style = value

    def refresh(self):
        return True

    def saveAsImageFile(self, filename, width, height):
        self.captures.append((filename, self.camera, self.visualStyle))
        pathlib.Path(filename).write_bytes(png_bytes(width, height, len(self.captures)))
        if self.capture_hook:
            self.capture_hook(filename)
        return len(self.captures) != self.fail_capture


class Document:
    def __init__(self, app, name):
        self.app, self.name = app, name
        self.creationId = name + '-id'
        self.dataFile = types.SimpleNamespace(id=name + '-file', versionNumber=5)
        self.isSaved, self.isModified = True, False
        self.products = types.SimpleNamespace(itemByProductType=lambda _: self)
        self.allDocumentReferences = types.SimpleNamespace(count=0)
        self.viewport = Viewport()
        self.colors = True
        self.activate_count = 0
        self.fail_activation = False

    def activate(self):
        self.activate_count += 1
        if self.fail_activation:
            return False
        self.app.activeDocument = self
        return True


class App:
    def __init__(self):
        self.userInterface = types.SimpleNamespace(activeCommand='SelectCommand')
        self.version = 'offline-stub-build'
        self.original, self.target = Document(self, 'Original'), Document(self, 'Target')
        self.documents = [self.original, self.target]
        self.activeDocument = self.original

    @property
    def activeViewport(self):
        return self.activeDocument.viewport

    @property
    def isComponentColorsDisplayed(self):
        return self.activeDocument.colors

    @isComponentColorsDisplayed.setter
    def isComponentColorsDisplayed(self, value):
        self.activeDocument.colors = value


CORE = types.SimpleNamespace(CameraTypes=CameraTypes, Camera=Camera, Point3D=XYZ, Vector3D=XYZ,
                             ViewOrientations=types.SimpleNamespace(**{name + 'ViewOrientation': i + 1 for i, (_, name) in enumerate(NS['VIEWS'])}),
                             VisualStyles=types.SimpleNamespace(ShadedWithVisibleEdgesOnlyVisualStyle=3))
FUSION = types.SimpleNamespace(Design=types.SimpleNamespace(cast=lambda value: value))


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fmcad-review-python-')
        self.addCleanup(self.temp.cleanup)
        self.out = pathlib.Path(self.temp.name)
        self.app = App()
        self.args = {'requestId': 'unique', 'doc': 'Target', 'docId': 'Target-id', 'docFileId': None,
                     'out': str(self.out), 'fusionOut': str(self.out), 'width': 640, 'height': 480}

    def run_review(self):
        (self.out / 'request.json').write_text(json.dumps(self.args))
        return NS['capture_review'](self.app, CORE, FUSION, self.args)

    def assert_restored(self, target_camera, original_camera):
        self.assertIs(self.app.activeDocument, self.app.original)
        for doc, state in [(self.app.target, target_camera), (self.app.original, original_camera)]:
            self.assertTrue(NS['near_state'](NS['camera_state'](doc.viewport.camera, CORE), state))
            self.assertEqual(doc.viewport.visualStyle, 7)
            self.assertTrue(doc.colors)

    def states(self):
        return tuple(NS['camera_state'](doc.viewport.camera, CORE) for doc in (self.app.target, self.app.original))

    def test_all_views_preserve_perspective_projection_pose_and_dirty_state(self):
        self.app.target.viewport._camera.cameraType = CameraTypes.PerspectiveCameraType
        self.app.original.viewport._camera.cameraType = CameraTypes.PerspectiveWithOrthoFacesCameraType
        self.app.target.isModified = True
        states = self.states()
        report = self.run_review()
        self.assertTrue(report['success'], report)
        self.assertTrue(report['requiresVisualReview'])
        self.assertEqual(report['fusionBuild'], 'offline-stub-build')
        self.assertEqual(report['documentIdentity']['version'], 5)
        self.assertTrue(report['documentAfter']['isModified'])
        self.assertEqual([r['name'] for r in report['views']], [name for name, _ in NS['VIEWS']])
        self.assertEqual(len(list(self.out.glob('*.png'))), 8)
        self.assertEqual([c.viewOrientation for _, c, _ in self.app.target.viewport.captures], [0]*8)
        self.assertEqual(report['orientationVerification']['status'], 'verified')
        self.assertTrue(all(c.cameraType == CameraTypes.OrthographicCameraType and style == 3 for _, c, style in self.app.target.viewport.captures))
        self.assert_restored(*states)

    def test_same_document_restores_orthographic_extents(self):
        self.app.activeDocument = self.app.target
        state = self.states()[0]
        self.assertTrue(self.run_review()['success'])
        self.assertTrue(NS['near_state'](NS['camera_state'](self.app.target.viewport.camera, CORE), state))
        self.assertEqual(self.app.target.activate_count, 0)

    def test_vector_validation_rejects_duplicate_view_despite_enum_label(self):
        report = self.run_review()
        self.assertTrue(report['success'])
        rows = copy.deepcopy(report['views'])
        rows[1]['camera'] = copy.deepcopy(rows[0]['camera'])
        with self.assertRaisesRegex(RuntimeError, 'Opposed view'):
            NS['verify_view_directions'](rows)

    def test_unsaved_document_identity_is_explicit(self):
        self.app.target.dataFile = None
        self.app.target.isSaved = False
        self.app.target.isModified = True
        report = self.run_review()
        self.assertTrue(report['success'], report)
        self.assertEqual(report['documentIdentity'], {'name': 'Target', 'creationId': 'Target-id',
                         'fileId': None, 'version': None, 'isSaved': False, 'isModified': True})

    def test_false_capture_keeps_completed_and_failed_staging_image_and_restores(self):
        self.app.target.viewport.fail_capture = 3
        states = self.states()
        report = self.run_review()
        self.assertFalse(report['success'])
        self.assertEqual([r['status'] for r in report['views']], ['captured', 'captured', 'attempted'])
        self.assertEqual(report['restoration']['status'], 'restored')
        self.assertTrue((self.out / '_capture/left.png').exists())
        self.assertTrue((self.out / 'front.png').exists())
        self.assert_restored(*states)

    def test_restore_failure_does_not_skip_other_restorations_or_report_success(self):
        self.app.target.viewport.fail_restore_camera = True
        self.app.target.viewport.fail_restore_style = True
        report = self.run_review()
        self.assertFalse(report['success'])
        self.assertEqual(report['restoration']['status'], 'failed')
        self.assertEqual(len(report['views']), 8)
        self.assertIs(self.app.activeDocument, self.app.original)
        self.assertTrue(self.app.target.colors)
        steps = {r['name']: r['status'] for r in report['restoration']['steps']}
        self.assertEqual(steps['target.camera'], 'failed')
        self.assertEqual(steps['target.style'], 'failed')
        self.assertEqual(steps['target.colors'], 'restored')
        self.assertEqual(steps['original.camera'], 'restored')

    def test_active_command_identity_and_duplicate_name_rejected_before_activation(self):
        for fault in ('command', 'identity', 'file_id', 'duplicate', 'dimensions'):
            with self.subTest(fault=fault):
                self.app = App()
                self.args.update(docId='Target-id', docFileId=None, width=640)
                if fault == 'command':
                    self.app.userInterface.activeCommand = 'ExtrudeCommand'
                elif fault == 'identity':
                    self.args['docId'] = 'other'
                elif fault == 'file_id':
                    self.args['docFileId'] = 'wrong'
                elif fault == 'duplicate':
                    self.app.documents.append(Document(self.app, 'Target'))
                else:
                    self.args['width'] = True
                report = self.run_review()
                self.assertFalse(report['success'])
                self.assertEqual(report['restoration']['status'], 'not-needed')
                self.assertEqual(self.app.target.activate_count, 0)
                self.assertEqual(self.app.target.viewport.captures, [])

    def test_new_output_collision_is_not_overwritten(self):
        def collision(_):
            (self.out / 'front.png').write_bytes(b'foreign')
        self.app.target.viewport.capture_hook = collision
        report = self.run_review()
        self.assertFalse(report['success'])
        self.assertEqual((self.out / 'front.png').read_bytes(), b'foreign')
        self.assertEqual(report['restoration']['status'], 'restored')

    def test_original_activation_failure_is_truthful(self):
        self.app.original.fail_activation = True
        report = self.run_review()
        self.assertFalse(report['success'])
        self.assertEqual(report['restoration']['status'], 'failed')
        self.assertIs(self.app.activeDocument, self.app.target)
        self.assertTrue(any(e['stage'] == 'restore.activeDocument' for e in report['errors']))

    def test_silent_camera_restore_mismatch_is_not_accepted(self):
        state = self.states()[0]
        viewport = self.app.target.viewport
        viewport.refresh = lambda: setattr(viewport._camera, 'eye', XYZ(100, 100, 100))
        with self.assertRaisesRegex(RuntimeError, 'readback mismatch'):
            NS['restore_camera'](viewport, state, CORE)

    def test_invalid_png_is_failed_and_retained(self):
        self.app.target.viewport.capture_hook = lambda filename: pathlib.Path(filename).write_bytes(b'bad image')
        report = self.run_review()
        self.assertFalse(report['success'])
        self.assertEqual(report['restoration']['status'], 'restored')
        self.assertFalse((self.out / 'front.png').exists())
        self.assertEqual((self.out / '_capture/front.png').read_bytes(), b'bad image')

    def test_run_persists_full_failure_after_restoration_and_prints_same_report(self):
        self.app.target.viewport.fail_capture = 2
        (self.out / 'request.json').write_text(json.dumps(self.args))
        core = types.ModuleType('adsk.core')
        core.__dict__.update(vars(CORE))
        core.Application = types.SimpleNamespace(get=lambda: self.app)
        fusion = types.ModuleType('adsk.fusion')
        fusion.__dict__.update(vars(FUSION))
        adsk = types.ModuleType('adsk')
        adsk.core, adsk.fusion = core, fusion
        output = io.StringIO()
        with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': core, 'adsk.fusion': fusion}), patch.dict(NS, {'ARGS': self.args}), contextlib.redirect_stdout(output):
            NS['run']('')
        report = json.loads((self.out / 'backend-report.json').read_text())
        terminal = json.loads(output.getvalue().removeprefix('FMCAD_RESULT '))
        self.assertEqual(report, terminal)
        self.assertFalse(report['success'])
        self.assertEqual(report['restoration']['status'], 'restored')
        self.assertEqual(len(report['views']), 2)

    def test_dirty_change_during_capture_stops_and_is_reported(self):
        self.app.target.viewport.capture_hook = lambda _: setattr(self.app.target, 'isModified', True)
        report = self.run_review()
        self.assertFalse(report['success'])
        self.assertEqual(len(report['views']), 1)
        self.assertTrue(report['documentAfter']['isModified'])
        self.assertTrue(any(e['stage'] == 'documentAfter' for e in report['errors']))

    def test_preexisting_output_and_bad_mapping_rejected(self):
        (self.out / 'front.png').write_bytes(b'keep')
        report = self.run_review()
        self.assertFalse(report['success'])
        self.assertEqual(self.app.target.activate_count, 0)
        self.assertEqual((self.out / 'front.png').read_bytes(), b'keep')
        (self.out / 'front.png').unlink()
        (self.out / 'request.json').write_text('{}')
        report = NS['capture_review'](self.app, CORE, FUSION, self.args)
        self.assertFalse(report['success'])
        self.assertEqual(self.app.target.activate_count, 0)


if __name__ == '__main__':
    unittest.main()
