"""GM34 offline tests: marking create/check with text, symbol and arrow."""
from pathlib import Path
import unittest

import model_test as model


ROOT = Path(__file__).resolve().parents[1]
NAMESPACE = dict(model.namespace)
NAMESPACE['CAD_HANDLERS'] = dict(model.HANDLERS)
exec(compile((ROOT / 'assets/cad/marking.py').read_text(), 'marking.py', 'exec'), NAMESPACE)
HANDLERS = NAMESPACE['CAD_HANDLERS']


class Context(model.Context):
    pass


class MarkingTests(unittest.TestCase):
    def call(self, operation, data):
        return HANDLERS[operation](Context(), data)

    def test_create_preserves_content_verbatim_and_returns_annotation(self):
        result = self.call('marking.create', {'schemaVersion': 1,
            'marks': [{'id': 'level-max', 'kind': 'text', 'representation': 'annotation',
                       'content': 'MAX 50%', 'position': ['0 mm', '20 mm', '0 mm'],
                       'dimensions': {'height': '3 mm', 'width': '8 mm'},
                       'font': 'ISO3098', 'source': {'item': 'tank', 'level': 'max', 'status': 'CONFIRMED'}}]})
        self.assertEqual(result['status'], 'pass')
        mark = result['marks'][0]
        self.assertEqual(mark['content'], 'MAX 50%')
        self.assertEqual(mark['nativeAcceptance'], 'annotation')
        self.assertIsNotNone(mark['annotation'])
        self.assertIsNone(mark['geometryRecipe'])
        self.assertEqual(result['annotationCount'], 1)
        self.assertEqual(result['geometryRecipeCount'], 0)

    def test_create_emboss_is_gated_recipe_not_an_image(self):
        result = self.call('marking.create', {'schemaVersion': 1,
            'marks': [{'id': 'logo', 'kind': 'text', 'representation': 'emboss',
                       'content': 'LOGO', 'position': ['0 mm', '0 mm', '0 mm'],
                       'dimensions': {'height': '5 mm'}, 'depth': '0.5 mm'}]})
        mark = result['marks'][0]
        self.assertEqual(mark['nativeAcceptance'], 'notEvaluated')
        self.assertEqual(mark['geometryRecipe']['representation'], 'emboss')
        self.assertIsNone(mark['annotation'])
        self.assertFalse(any('depth' in w for w in mark['warnings']))

    def test_create_emboss_missing_depth_warns(self):
        result = self.call('marking.create', {'schemaVersion': 1,
            'marks': [{'id': 'logo', 'kind': 'text', 'representation': 'emboss',
                       'content': 'LOGO', 'position': ['0 mm', '0 mm', '0 mm'],
                       'dimensions': {'height': '5 mm'}}]})
        self.assertTrue(any('depth' in w for w in result['marks'][0]['warnings']))

    def test_create_mark_in_optical_zone_fails(self):
        result = self.call('marking.create', {'schemaVersion': 1,
            'marks': [{'id': 'badge', 'kind': 'text', 'representation': 'annotation',
                       'content': 'BADGE', 'position': ['0 mm', '0 mm', '0 mm'],
                       'dimensions': {'height': '10 mm'}}],
            'zones': [{'name': 'lens', 'kind': 'optical',
                       'region': {'min': ['-5 mm', '-5 mm', '-5 mm'], 'max': ['5 mm', '5 mm', '5 mm']}}]})
        self.assertEqual(result['status'], 'fail')
        self.assertEqual(result['marks'][0]['zoneViolations'], ['lens'])

    def test_create_arrow_without_direction_rejected(self):
        with self.assertRaises(ValueError):
            self.call('marking.create', {'schemaVersion': 1,
                'marks': [{'id': 'flow', 'kind': 'arrow', 'representation': 'annotation',
                           'position': ['0 mm', '0 mm', '0 mm'], 'dimensions': {'height': '5 mm'}}]})

    def test_create_text_without_content_rejected(self):
        with self.assertRaises(ValueError):
            self.call('marking.create', {'schemaVersion': 1,
                'marks': [{'id': 'x', 'kind': 'text', 'representation': 'annotation',
                           'position': ['0 mm', '0 mm', '0 mm'], 'dimensions': {'height': '5 mm'}}]})

    def test_check_max_derived_from_level_passes(self):
        result = self.call('marking.check', {'schemaVersion': 1,
            'marks': [{'id': 'level-max', 'kind': 'text', 'representation': 'annotation',
                       'content': 'MAX', 'position': ['0 mm', '20 mm', '0 mm'],
                       'dimensions': {'height': '3 mm'},
                       'reference': {'kind': 'liquid-level', 'bound': 'max'}, 'levelValue': '20 mm'}],
            'levels': {'min': '0 mm', 'max': '20 mm'}})
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['marks'][0]['passed'])
        self.assertTrue(result['marks'][0]['checks'][0]['passed'])

    def test_check_min_not_derived_from_level_fails(self):
        result = self.call('marking.check', {'schemaVersion': 1,
            'marks': [{'id': 'level-max', 'kind': 'text', 'representation': 'annotation',
                       'content': 'MAX', 'position': ['0 mm', '20 mm', '0 mm'],
                       'dimensions': {'height': '3 mm'},
                       'reference': {'kind': 'liquid-level', 'bound': 'max'}, 'levelValue': '15 mm'}],
            'levels': {'min': '0 mm', 'max': '20 mm'}})
        self.assertEqual(result['status'], 'fail')
        self.assertTrue(any(v['kind'] == 'level' for v in result['violations']))

    def test_check_arrow_matches_defined_flow(self):
        result = self.call('marking.check', {'schemaVersion': 1,
            'marks': [{'id': 'flow-arrow', 'kind': 'arrow', 'representation': 'annotation',
                       'position': ['0 mm', '0 mm', '0 mm'], 'dimensions': {'height': '5 mm'},
                       'direction': [1, 0, 0]}],
            'flows': [{'id': 'pump-out', 'direction': [1, 0, 0]}]})
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['marks'][0]['checks'][0]['matched'], 'pump-out')

    def test_check_arrow_not_from_flow_fails(self):
        result = self.call('marking.check', {'schemaVersion': 1,
            'marks': [{'id': 'flow-arrow', 'kind': 'arrow', 'representation': 'annotation',
                       'position': ['0 mm', '0 mm', '0 mm'], 'dimensions': {'height': '5 mm'},
                       'direction': [1, 0, 0]}],
            'flows': [{'id': 'pump-out', 'direction': [0, 1, 0]}]})
        self.assertEqual(result['status'], 'fail')
        self.assertTrue(any(v['kind'] == 'flow' for v in result['violations']))

    def test_check_geometry_to_image_substitution_fails(self):
        result = self.call('marking.check', {'schemaVersion': 1,
            'marks': [{'id': 'logo', 'kind': 'text', 'representation': 'emboss',
                       'content': 'LOGO', 'position': ['0 mm', '0 mm', '0 mm'],
                       'dimensions': {'height': '5 mm'}, 'depth': '0.5 mm',
                       'resolvedRepresentation': 'image'}]})
        self.assertEqual(result['status'], 'fail')
        self.assertTrue(any(v['kind'] == 'substitution' for v in result['violations']))

    def test_check_missing_levels_is_unknown_not_fail(self):
        result = self.call('marking.check', {'schemaVersion': 1,
            'marks': [{'id': 'level-max', 'kind': 'text', 'representation': 'annotation',
                       'content': 'MAX', 'position': ['0 mm', '20 mm', '0 mm'],
                       'dimensions': {'height': '3 mm'},
                       'reference': {'kind': 'liquid-level', 'bound': 'max'}, 'levelValue': '20 mm'}]})
        self.assertEqual(result['status'], 'unknown')
        self.assertTrue(result['unevaluable'])

    def test_invalid_inputs_rejected(self):
        with self.assertRaises(ValueError):
            self.call('marking.create', {'schemaVersion': 1, 'marks': []})
        with self.assertRaises(ValueError):
            self.call('marking.create', {'schemaVersion': 2,
                'marks': [{'id': 'x', 'kind': 'text', 'representation': 'annotation',
                           'content': 'X', 'position': ['0 mm', '0 mm', '0 mm'],
                           'dimensions': {'height': '5 mm'}}]})
        with self.assertRaises(ValueError):
            self.call('marking.check', {'schemaVersion': 1, 'marks': []})


if __name__ == '__main__':
    unittest.main()
