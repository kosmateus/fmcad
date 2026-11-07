"""GM31 offline tests: draft, undercut, wall-map and manufacturing zone/check."""
import math
from pathlib import Path
import unittest

import model_test as model


ROOT = Path(__file__).resolve().parents[1]
NAMESPACE = dict(model.namespace)
NAMESPACE['CAD_HANDLERS'] = dict(model.HANDLERS)
exec(compile((ROOT / 'assets/cad/dfm.py').read_text(), 'dfm.py', 'exec'), NAMESPACE)
HANDLERS = NAMESPACE['CAD_HANDLERS']


class Context(model.Context):
    def call(self, operation, data):
        return HANDLERS[operation](self, data)


class DfmTests(unittest.TestCase):
    def call(self, operation, data):
        return HANDLERS[operation](Context(), data)

    def test_signed_draft_sign_convention(self):
        result = self.call('measure.draft', {'schemaVersion': 1,
            'faces': [{'name': 'wall', 'point': ['0 mm', '0 mm', '10 mm'], 'normal': [1, 0, 0]},
                      {'name': 'top', 'point': ['0 mm', '0 mm', '10 mm'], 'normal': [0, 0, 1]},
                      {'name': 'under', 'point': ['0 mm', '0 mm', '0 mm'], 'normal': [0, 0, -1]}],
            'pullDirections': [{'name': 'eject', 'axis': [0, 0, 1]}]})
        self.assertEqual(result['status'], 'pass')
        by_face = {r['face']: r for r in result['draftMap']}
        self.assertAlmostEqual(by_face['wall']['signedDraft'], 0.0, places=5)
        self.assertTrue(by_face['wall']['pullWall'])
        self.assertAlmostEqual(by_face['top']['signedDraft'], 90.0, places=5)
        self.assertFalse(by_face['top']['pullWall'])
        self.assertAlmostEqual(by_face['under']['signedDraft'], -90.0, places=5)
        self.assertTrue(result['demoldableIsNotDraftAlone'])

    def test_min_draft_violation_on_pull_wall(self):
        result = self.call('measure.draft', {'schemaVersion': 1,
            'faces': [{'name': 'wall', 'point': ['0 mm', '0 mm', '10 mm'], 'normal': [1, 0, 0]}],
            'pullDirections': [{'name': 'eject', 'axis': [0, 0, 1]}], 'minDraft': '1 deg'})
        self.assertFalse(result['demoldableByDraft'])
        self.assertTrue(result['draftMap'][0]['draftViolation'])

    def test_positive_draft_satisfies_min_draft(self):
        angle = math.radians(88.0)
        normal = [math.sin(angle), 0.0, math.cos(angle)]
        result = self.call('measure.draft', {'schemaVersion': 1,
            'faces': [{'name': 'drafted', 'point': ['0 mm', '0 mm', '10 mm'], 'normal': normal}],
            'pullDirections': [{'name': 'eject', 'axis': [0, 0, 1]}], 'minDraft': '1 deg'})
        self.assertAlmostEqual(result['draftMap'][0]['signedDraft'], 2.0, places=4)
        self.assertTrue(result['draftMap'][0]['drafts'])
        self.assertTrue(result['demoldableByDraft'])

    def test_undercut_detected_in_pull_direction(self):
        result = self.call('undercut.check', {'schemaVersion': 1,
            'faces': [{'name': 'lip', 'point': ['0 mm', '0 mm', '5 mm'], 'normal': [0, 0, -1]}],
            'pullDirections': [{'name': 'eject', 'axis': [0, 0, 1]}]})
        self.assertFalse(result['passed'])
        self.assertEqual(result['status'], 'fail')
        self.assertEqual(result['undercutCount'], 1)
        self.assertTrue(result['undercuts'][0]['undercut'])

    def test_no_undercut_passes(self):
        result = self.call('undercut.check', {'schemaVersion': 1,
            'faces': [{'name': 'side', 'point': ['0 mm', '0 mm', '5 mm'], 'normal': [0, 0, 1]}],
            'pullDirections': [{'name': 'eject', 'axis': [0, 0, 1]}]})
        self.assertTrue(result['passed'])
        self.assertEqual(result['status'], 'pass')

    def test_wall_map_void_continuity_not_material(self):
        result = self.call('measure.wall-map', {'schemaVersion': 1,
            'samples': [{'name': 'shell', 'point': ['0 mm', '0 mm', '0 mm'],
                         'opposite': ['2 mm', '0 mm', '0 mm'], 'continuity': 'solid'},
                        {'name': 'boss', 'point': ['10 mm', '0 mm', '0 mm'],
                         'opposite': ['14 mm', '0 mm', '0 mm'], 'continuity': 'void'}]})
        self.assertAlmostEqual(result['wallMap'][0]['thickness'], 0.2, places=5)
        self.assertFalse(result['wallMap'][0]['voidBacked'])
        self.assertTrue(result['wallMap'][1]['voidBacked'])
        self.assertIn('boss', result['unhandledAreas'])
        self.assertTrue(result['materialContinuityChecked'])

    def test_wall_map_thin_wall_and_uniformity(self):
        result = self.call('measure.wall-map', {'schemaVersion': 1,
            'samples': [{'name': 'a', 'point': ['0 mm', '0 mm', '0 mm'], 'opposite': ['2 mm', '0 mm', '0 mm']},
                        {'name': 'b', 'point': ['0 mm', '10 mm', '0 mm'], 'opposite': ['2 mm', '10 mm', '0 mm']}],
            'minThickness': '3 mm'})
        self.assertTrue(all(r['thinWall'] for r in result['wallMap']))
        self.assertTrue(result['uniform'])
        self.assertEqual(len(result['thinWallViolations']), 2)

    def test_manufacturing_zone_protection_defaults_and_warning(self):
        result = self.call('manufacturing.zone', {'schemaVersion': 1,
            'zones': [{'name': 'seal-groove', 'kind': 'seal'},
                      {'name': 'a-panel', 'kind': 'a-surface'},
                      {'name': 'boss', 'kind': 'fit', 'protected': False}]})
        by_name = {z['name']: z for z in result['zones']}
        self.assertTrue(by_name['seal-groove']['protected'])
        self.assertTrue(by_name['a-panel']['protected'])
        self.assertFalse(by_name['boss']['protected'])
        self.assertTrue(any('material' in w for w in result['warnings']))

    def test_manufacturing_check_protects_seal_from_global_change(self):
        base = {'schemaVersion': 1,
                'zones': [{'name': 'seal', 'kind': 'seal'}],
                'faces': [{'name': 'wall', 'point': ['0 mm', '0 mm', '10 mm'], 'normal': [1, 0, 0]}],
                'walls': [{'name': 'shell', 'point': ['0 mm', '0 mm', '0 mm'],
                           'opposite': ['2 mm', '0 mm', '0 mm'], 'continuity': 'solid'}],
                'pullDirections': [{'name': 'eject', 'axis': [0, 0, 1]}]}
        clean = self.call('manufacturing.check', base)
        self.assertTrue(clean['passed'])
        violated = self.call('manufacturing.check', dict(
            base, operations=[{'name': 'global-draft', 'touches': ['seal']}]))
        self.assertFalse(violated['passed'])
        self.assertEqual(violated['status'], 'fail')
        self.assertTrue(any(v['source'] == 'protected-zone' for v in violated['violations']))
        self.assertIn('seal', violated['protectedZones'])

    def test_native_method_returns_blocked_envelope(self):
        draft = self.call('measure.draft', {'schemaVersion': 1, 'method': 'native',
            'faces': [{'name': 'wall', 'point': ['0 mm', '0 mm', '10 mm'], 'normal': [1, 0, 0]}],
            'pullDirections': [{'name': 'eject', 'axis': [0, 0, 1]}]})
        self.assertEqual(draft['status'], 'blocked')
        self.assertFalse(draft['success'])
        self.assertTrue(draft['blocked'])
        self.assertEqual(draft['requestedMethod'], 'native')
        self.assertFalse(draft['nativeSampling']['available'])
        wall = self.call('measure.wall-map', {'schemaVersion': 1, 'method': 'native',
            'samples': [{'name': 'shell', 'point': ['0 mm', '0 mm', '0 mm'],
                         'opposite': ['2 mm', '0 mm', '0 mm'], 'continuity': 'solid'}]})
        self.assertEqual(wall['status'], 'blocked')
        self.assertFalse(wall['success'])
        self.assertTrue(wall['blocked'])
        self.assertFalse(wall['nativeSampling']['available'])

    def test_unknown_method_still_rejected(self):
        with self.assertRaises(ValueError):
            self.call('measure.draft', {'schemaVersion': 1, 'method': 'bogus',
                'faces': [{'name': 'wall', 'point': ['0 mm', '0 mm', '10 mm'], 'normal': [1, 0, 0]}],
                'pullDirections': [{'name': 'eject', 'axis': [0, 0, 1]}]})
        with self.assertRaises(ValueError):
            self.call('measure.wall-map', {'schemaVersion': 1, 'method': 'bogus',
                'samples': [{'name': 'shell', 'point': ['0 mm', '0 mm', '0 mm'],
                             'opposite': ['2 mm', '0 mm', '0 mm']}]})

    def test_invalid_inputs_rejected(self):
        with self.assertRaises(ValueError):
            self.call('measure.draft', {'schemaVersion': 1, 'faces': [], 'pullDirections': []})
        with self.assertRaises(ValueError):
            self.call('measure.draft', {'schemaVersion': 2,
                'faces': [{'point': ['0 mm', '0 mm', '0 mm'], 'normal': [0, 0, 1]}],
                'pullDirections': [{'axis': [0, 0, 1]}]})
        with self.assertRaises(ValueError):
            self.call('measure.wall-map', {'schemaVersion': 1,
                'samples': [{'point': ['0 mm', '0 mm', '0 mm']}]})
        with self.assertRaises(ValueError):
            self.call('manufacturing.zone', {'schemaVersion': 1,
                'zones': [{'name': 'x', 'kind': 'unknown'}]})


if __name__ == '__main__':
    unittest.main()
