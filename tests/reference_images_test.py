"""Real raster GM05 tests. Fixtures and all outputs stay inside the CLI repository."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

try:
    import numpy as np
    from PIL import Image, ImageDraw
    import scipy
except ImportError:
    np = None

ROOT = Path(__file__).resolve().parents[1]
if np is not None:
    spec = importlib.util.spec_from_file_location('reference_images', ROOT / 'assets/reference_images.py')
    ref = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ref)


@unittest.skipIf(np is None, 'GM05 raster tests require Pillow, NumPy and SciPy; use .venv/bin/python')
class ReferenceImagesTest(unittest.TestCase):
    def setUp(self):
        parent = ROOT / '.test-artifacts'
        parent.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='reference-', dir=parent)
        self.root = Path(self.temp.name)
        self.original = self.root / 'original.png'
        image = Image.new('RGB', (120, 80), 'white')
        draw = ImageDraw.Draw(image)
        draw.rectangle((10, 10, 30, 60), fill='black')
        draw.rectangle((70, 10, 90, 60), fill='black')
        image.save(self.original)
        self.hash = hashlib.sha256(self.original.read_bytes()).hexdigest()
        self.cam = {'projection': 'orthographic', 'orientation': 'front', 'frame': 'root',
                    'eye': ['0 mm', '0 mm', '200 mm'], 'target': ['0 mm', '0 mm', '0 mm'],
                    'up': [0, 1, 0], 'extents': ['120 mm', '160 mm']}
        self.input = {'schemaVersion': 1, 'original': {'path': str(self.original), 'status': 'CONFIRMED', 'uncertaintyPx': 0},
                      'frame': {'name': 'root', 'origin': ['0 mm'] * 3, 'xAxis': [1, 0, 0], 'yAxis': [0, 1, 0]},
                      'views': [{'id': 'front', 'orientation': 'front', 'crop': [0, 0, 60, 80], 'rotation': '0 deg', 'camera': self.cam},
                                {'id': 'rear', 'orientation': 'rear', 'crop': [60, 0, 60, 80], 'rotation': '0 deg', 'camera': {**self.cam, 'orientation': 'rear'}}],
                      'out': str(self.root / 'layout')}

    def tearDown(self):
        self.assertEqual(hashlib.sha256(self.original.read_bytes()).hexdigest(), self.hash)
        self.temp.cleanup()

    def layout(self):
        return ref.layout(self.input)

    def calibration_input(self):
        layout = self.layout()
        return {'schemaVersion': 1, 'layout': layout['reportPath'],
                'dimension': {'id': 'height', 'value': '100 mm', 'uncertainty': '0 mm', 'source': {'path': 'fixture', 'status': 'CONFIRMED'}},
                'controls': [{'view': 'front', 'segment': [[10, 10], [10, 60]], 'anchor': ['0 mm', '0 mm'], 'angle': '90 deg'},
                             {'view': 'rear', 'segment': [[70, 10], [70, 60]], 'anchor': ['0 mm', '0 mm'], 'angle': '90 deg'}],
                'tolerance': '0.01 mm', 'out': str(self.root / 'calibrate')}

    def comparison_input(self):
        calibration = ref.calibrate(self.calibration_input())
        render = self.root / 'render.png'
        with Image.open(self.original) as image:
            image.crop((0, 0, 60, 80)).save(render)
        return {'schemaVersion': 1, 'calibration': calibration['reportPath'],
                'comparisons': [{'view': 'front', 'render': str(render), 'camera': self.cam, 'tolerancePx': 0,
                                 'landmarks': [{'id': 'corner', 'reference': [10, 10], 'render': [10, 10]}]}],
                'out': str(self.root / 'compare')}

    def masks(self, comparison, shift=0, empty=False):
        a = Image.new('L', (120, 80))
        b = Image.new('L', (60, 80))
        if not empty:
            ImageDraw.Draw(a).rectangle((10, 10, 30, 60), fill=255)
            ImageDraw.Draw(b).rectangle((10 + shift, 10, 30 + shift, 60), fill=255)
        a.save(self.root / 'ref-mask.png')
        b.save(self.root / 'render-mask.png')
        comparison.update(referenceMask=str(self.root / 'ref-mask.png'), renderMask=str(self.root / 'render-mask.png'))

    def test_original_copy_and_oriented_multiview_crops(self):
        self.input['views'][0].update(rotation='90 deg', mirrorX=True)
        result = self.layout()
        self.assertEqual(Path(result['result']['originalCopy']['path']).read_bytes(), self.original.read_bytes())
        view = result['result']['views'][0]
        self.assertEqual(view['size'], [80, 60])
        matrix = np.array(view['originalToView'])
        np.testing.assert_allclose(np.array(view['viewToOriginal']) @ matrix, np.eye(3), atol=1e-12)
        with Image.open(view['path']) as crop:
            for p in [[10, 10], [30, 60], [0, 0]]:
                q = ref.mapped(matrix, p)
                self.assertEqual(crop.getpixel(tuple(round(v) for v in q))[:3], Image.open(self.original).getpixel(tuple(p)))
        with self.assertRaisesRegex(ValueError, 'NEW'):
            self.layout()

    def test_arbitrary_crop_rotation_and_units(self):
        self.input['views'][0]['rotation'] = '0.3 rad'
        layout = self.layout()
        view = layout['result']['views'][0]
        p = np.array([10., 20.])
        np.testing.assert_allclose(ref.mapped(np.array(view['viewToOriginal']), ref.mapped(np.array(view['originalToView']), p)), p)
        self.assertEqual(ref.quantity('1 in'), 25.4)
        self.assertEqual(ref.quantity('0.1 m'), 100)
        with self.assertRaisesRegex(ValueError, 'explicit'):
            ref.quantity(100)

    def test_common_height_one_scale_with_correct_plane_mapping(self):
        request = self.calibration_input()
        report = ref.calibrate(request)
        self.assertEqual(report['status'], 'pass')
        self.assertEqual(report['result']['scaleMmPerPixel'], 2)
        for row in report['result']['calibrations']:
            matrix = np.array(row['originalToPlaneMm'])
            np.testing.assert_allclose(ref.mapped(matrix, row['control']['segment'][0]), [0, 0], atol=1e-12)
            np.testing.assert_allclose(ref.mapped(matrix, row['control']['segment'][1]), [0, 100], atol=1e-12)
        self.assertFalse(report['result']['metricVerified'])

    def test_inconsistent_height_not_independently_refitted(self):
        request = self.calibration_input()
        request['controls'][1]['segment'][1][1] = 70
        result = ref.calibrate(request)
        self.assertEqual(result['status'], 'fail')
        self.assertTrue(result['result']['conflicts'])
        scales = [np.linalg.norm(np.array(c['viewToPlaneMm'])[:2, 0]) for c in result['result']['calibrations']]
        self.assertAlmostEqual(scales[0], scales[1])
        self.assertNotEqual(result['result']['checks'][0]['measuredMm'], 100)

    def test_independent_checks_do_not_refit(self):
        request = self.calibration_input()
        request['checks'] = [{'id': 'width', 'view': 'front', 'segment': [[10, 10], [30, 10]],
                              'dimension': {**request['dimension'], 'id': 'width', 'value': '50 mm'}}]
        result = ref.calibrate(request)
        self.assertEqual(result['result']['scaleMmPerPixel'], 2)
        self.assertEqual(result['result']['checks'][-1]['deviationMm'], -10)
        self.assertEqual(result['status'], 'fail')

    def test_perspective_estimated_and_explicit_top_conflict(self):
        self.input['original']['status'] = 'ESTIMATED'
        self.input['views'][0]['camera'] = {'projection': 'perspective', 'orientation': 'front', 'frame': 'root', 'perspectiveAngle': '40 deg'}
        self.input['conflicts'] = [{'views': ['front', 'rear'], 'reason': 'Contradictory top interpretation', 'source': {'path': 'brief', 'status': 'OPEN'}}]
        request = self.calibration_input()
        result = ref.calibrate(request)
        self.assertEqual(result['status'], 'fail')
        self.assertIn('ESTIMATED', result['result']['sourceStatuses'])
        self.assertTrue(any('perspective' in warning for warning in result['warnings']))

    def test_source_statuses_and_uncertainty(self):
        base = self.calibration_input()
        for status in ['CONFIRMED', 'ESTIMATED', 'OPEN', 'DERIVED']:
            with self.subTest(status=status):
                request = copy.deepcopy(base)
                request['out'] += '-' + status
                request['dimension']['source']['status'] = status
                if status == 'DERIVED':
                    request['dimension']['source']['derivedFrom'] = ['estimated-source']
                request['dimension']['uncertainty'] = '3 mm'
                report = ref.calibrate(request)
                self.assertEqual(report['status'], {'CONFIRMED': 'pass', 'OPEN': 'blocked'}.get(status, 'unknown'))
                self.assertEqual(report['result']['checks'][0]['uncertaintyMm'], 3)

    def test_landmark_overlay_and_known_shift(self):
        request = self.comparison_input()
        request['comparisons'][0]['landmarks'][0]['render'][0] += 3
        result = ref.compare(request)
        self.assertEqual(result['status'], 'fail')
        metric = result['result']['comparisons'][0]['metrics'][0]
        self.assertEqual(metric['deviationPx'], 3)
        self.assertEqual(metric['projectedDeviationMm'], 6)
        with Image.open(result['result']['comparisons'][0]['overlay']) as image:
            self.assertEqual(image.size, (60, 80))

    def test_silhouette_identical_shift_and_empty(self):
        base = self.comparison_input()
        for shift, empty in [(0, False), (3, False), (0, True)]:
            with self.subTest(shift=shift, empty=empty):
                request = copy.deepcopy(base)
                request['out'] += '-%s-%s' % (shift, empty)
                self.masks(request['comparisons'][0], shift, empty)
                result = ref.compare(request)
                metric = result['result']['comparisons'][0]['metrics'][-1]
                self.assertEqual(metric['maxPx'], None if empty else shift)
                self.assertEqual(result['status'], 'unknown' if empty else 'fail' if shift else 'pass')
                if not empty:
                    self.assertGreater(metric['sampleCount'], 0)

    def test_camera_conflict_and_missing_measurement_are_unknown(self):
        base = self.comparison_input()
        for kind in ['camera', 'missing', 'partial']:
            request = copy.deepcopy(base)
            request['out'] += '-' + kind
            if kind == 'camera':
                request['comparisons'][0]['camera'] = {**self.cam, 'orientation': 'rear'}
            elif kind == 'missing':
                del request['comparisons'][0]['landmarks']
            else:
                request['comparisons'][0]['renderToView'] = [[1, 0, 1], [0, 1, 0], [0, 0, 1]]
            result = ref.compare(request)
            self.assertEqual(result['status'], 'unknown')
            self.assertFalse(result['result']['geometryVerified'])

    def test_registration_and_roi(self):
        request = self.comparison_input()
        item = request['comparisons'][0]
        self.masks(item, 3)
        item['renderToView'] = [[1, 0, -3], [0, 1, 0], [0, 0, 1]]
        item['landmarks'][0]['render'][0] += 3
        roi = Image.new('L', (60, 80))
        ImageDraw.Draw(roi).rectangle((5, 5, 40, 70), fill=255)
        roi.save(self.root / 'roi.png')
        item['roiMask'] = str(self.root / 'roi.png')
        result = ref.compare(request)
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['result']['comparisons'][0]['coverageComplete'])

    def test_invalid_requests_leave_no_output(self):
        cases = [lambda r: r['views'][0].update(crop=[0, 0, 999, 80]),
                 lambda r: r['frame'].update(xAxis=[2, 0, 0]),
                 lambda r: r['views'][0].update(mirrorX='false'),
                 lambda r: r['views'][0]['camera'].update(projection='fake'),
                 lambda r: r['views'][0]['camera'].update(extents=['0 mm', '2 mm']),
                 lambda r: r['original'].update(sha256='0' * 64),
                 lambda r: r['original'].update(status='DERIVED'),
                 lambda r: r['views'][0].update(id='../escape')]
        for change in cases:
            request = copy.deepcopy(self.input)
            change(request)
            with self.assertRaises(ValueError):
                ref.layout(request)
            self.assertFalse(Path(request['out']).exists())

    def test_stale_crop_and_report_are_rejected(self):
        request = self.comparison_input()
        crop = self.root / 'layout/front.png'
        crop.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'sha256'):
            ref.compare(request)
        self.assertFalse(Path(request['out']).exists())

    def test_invalid_mask_and_registration(self):
        request = self.comparison_input()
        self.masks(request['comparisons'][0])
        Image.new('L', (60, 80), 12).save(self.root / 'render-mask.png')
        with self.assertRaisesRegex(ValueError, 'binary'):
            ref.compare(request)
        for matrix in [[[1, .2, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, 1]], [[1, 0, 0], [0, 1, 0], [.1, 0, 1]]]:
            with self.assertRaises(ValueError):
                ref.registration(matrix)


if __name__ == '__main__':
    unittest.main()
