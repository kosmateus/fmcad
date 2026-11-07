"""Offline shared pixel and presentation-readback policy tests."""
import hashlib
import json
import pathlib
import types
import unittest

from capture_png import png_bytes
from review_test import App, CORE, FUSION

ROOT = pathlib.Path(__file__).resolve().parents[1]
POLICY = {}
exec(compile((ROOT / 'runtime/python/fmcad/domain/capture_integrity.py').read_text(),
             'capture_integrity.py', 'exec'), POLICY)
exec(compile((ROOT / 'runtime/python/fmcad/domain/review.py').read_text(),
             'review.py', 'exec'), POLICY)
exec(compile((ROOT / 'runtime/python/fmcad/adapters/fusion/identity.py').read_text(),
             'identity.py', 'exec'), POLICY)
exec(compile((ROOT / 'runtime/python/fmcad/adapters/fusion/legacy_review.py').read_text(),
             'legacy_review.py', 'exec'), POLICY)


class PixelPolicyTests(unittest.TestCase):
    def decode(self, data):
        return POLICY['decode_capture_png'](data, 32, 32)

    def frame(self, name, data, direction):
        return {'name': name, 'bytes': data, 'width': 32, 'height': 32,
                'direction': direction}

    def test_png_decoding_is_independent_of_encoded_hash(self):
        first = png_bytes(32, 32, 4, compression_level=1)
        second = png_bytes(32, 32, 4, compression_level=9)
        self.assertNotEqual(hashlib.sha256(first).hexdigest(), hashlib.sha256(second).hexdigest())
        self.assertEqual(self.decode(first)['pixelDigest'], self.decode(second)['pixelDigest'])
        with self.assertRaisesRegex(ValueError, 'CRC'):
            self.decode(first[:-1] + bytes([first[-1] ^ 1]))

    def test_blank_exact_duplicate_near_duplicate_and_similar_frames(self):
        blank = png_bytes(32, 32, blank=True)
        picture = png_bytes(32, 32, 2)
        near = png_bytes(32, 32, 2, variant_delta=1)
        blank_result = POLICY['analyze_capture_pixels']([
            self.frame('empty', blank, [0, -1, 0]),
            self.frame('part', picture, [0, 1, 0]),
        ])
        self.assertEqual(blank_result['status'], 'failed')
        self.assertEqual(blank_result['views'][0]['status'], 'blank')

        duplicate = POLICY['analyze_capture_pixels']([
            self.frame('front', picture, [0, -1, 0]),
            self.frame('same-front', picture, [0, -1, 0]),
        ])
        self.assertEqual(duplicate['status'], 'failed')
        self.assertEqual(duplicate['duplicatePairs'][0]['kind'], 'exact-decoded-pixels')

        near_duplicate = POLICY['analyze_capture_pixels']([
            self.frame('front', picture, [0, -1, 0]),
            self.frame('front-noise', near, [0, -1, 0]),
        ])
        self.assertEqual(near_duplicate['status'], 'failed')
        self.assertEqual(near_duplicate['duplicatePairs'][0]['kind'], 'near-identical-pixels')

        legitimate = POLICY['analyze_capture_pixels']([
            self.frame('front', picture, [0, -1, 0]),
            self.frame('back', near, [0, 1, 0]),
        ])
        self.assertEqual(legitimate['status'], 'review-required')
        self.assertEqual(legitimate['duplicatePairs'], [])
        self.assertEqual(legitimate['similarPairs'][0]['reason'], 'similar-pixels')

    def test_presentation_readback_distinguishes_unsupported_unknown_and_failure(self):
        self.assertEqual(POLICY['capture_restore_status'](True, supported=False), 'unsupported')
        self.assertEqual(POLICY['capture_restore_status'](True, readable=False), 'unknown')
        self.assertEqual(POLICY['capture_restore_status'](True, False), 'failed')
        self.assertEqual(POLICY['capture_restore_status'](True, True), 'restored')
        self.assertEqual(POLICY['capture_apply_status'](False, True), 'unsupported')


class CanonicalReviewRecipeTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.temp = tempfile.TemporaryDirectory(prefix='fmcad-capture-integrity-')
        self.addCleanup(self.temp.cleanup)
        self.app = App()
        self.out = pathlib.Path(self.temp.name)
        self.args = {
            'requestId': 'custom-recipe-request', 'doc': 'Target', 'docId': 'Target-id',
            'docFileId': None, 'out': str(self.out), 'fusionOut': str(self.out),
            'width': 32, 'height': 32,
            'recipes': [
                {'name': 'roi-top', 'kind': 'roi', 'orientation': 'top',
                 'target': [0, 0, 0], 'extents': [2, 3]},
                {'name': 'detail-front', 'kind': 'detail', 'orientation': 'front',
                 'target': [1, 2, 3], 'scale': 0.25},
                {'name': 'section-left', 'kind': 'section', 'orientation': 'left',
                 'sectionName': 'Existing cut', 'visible': False},
            ],
        }
        section = types.SimpleNamespace(name='Existing cut', isLightBulbOn=True)
        class Sections:
            count = 1
            def item(self, index):
                return section
        analyses = types.SimpleNamespace(sectionAnalyses=Sections(), isLightBulbOn=True)
        self.app.target.analyses = analyses
        self.app.target.products = types.SimpleNamespace(
            itemByProductType=lambda _: self.app.target)
        self.app.target.products.itemByProductType = lambda _: self.app.target
        self.app.section = section
        (self.out / 'request.json').write_text(json.dumps(self.args))

    def test_roi_detail_and_existing_section_recipes_preserve_identity_and_restore(self):
        original_camera = POLICY['camera_state'](self.app.original.viewport.camera, CORE)
        target_camera = POLICY['camera_state'](self.app.target.viewport.camera, CORE)
        report = POLICY['capture_review'](self.app, CORE, FUSION, self.args)
        self.assertTrue(report['success'], report)
        self.assertEqual(report['documentIdentity']['creationId'], 'Target-id')
        self.assertEqual(report['fusionBuild'], 'offline-stub-build')
        self.assertEqual([row['name'] for row in report['views']],
                         ['roi-top', 'detail-front', 'section-left'])
        self.assertEqual(report['orientationVerification']['status'], 'readback-only')
        self.assertEqual(report['views'][0]['framingReadback']['extents'], [2, 3])
        self.assertEqual(report['views'][1]['framingReadback']['kind'], 'detail')
        self.assertEqual(report['views'][2]['sectionReadback']['status'], 'verified')
        self.assertTrue(self.app.section.isLightBulbOn)
        self.assertEqual(report['restoration']['status'], 'restored')
        self.assertEqual(report['documentAfter'], report['documentIdentity'])
        self.assertTrue(POLICY['near_state'](
            POLICY['camera_state'](self.app.original.viewport.camera, CORE), original_camera))
        self.assertTrue(POLICY['near_state'](
            POLICY['camera_state'](self.app.target.viewport.camera, CORE), target_camera))


if __name__ == '__main__':
    unittest.main()
