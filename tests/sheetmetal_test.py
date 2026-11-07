"""GM32 offline tests: sheet-metal bend table, forming and flattening."""
import math
from pathlib import Path
import unittest

import model_test as model


ROOT = Path(__file__).resolve().parents[1]
NAMESPACE = dict(model.namespace)
NAMESPACE['CAD_HANDLERS'] = dict(model.HANDLERS)
exec(compile((ROOT / 'assets/cad/sheetmetal.py').read_text(), 'sheetmetal.py', 'exec'), NAMESPACE)
HANDLERS = NAMESPACE['CAD_HANDLERS']


class Context(model.Context):
    def call(self, operation, data):
        return HANDLERS[operation](self, data)


class SheetMetalTests(unittest.TestCase):
    def call(self, operation, data):
        return HANDLERS[operation](Context(), data)

    def bracket(self, **bend):
        segments = [{'type': 'flat', 'length': '20 mm'},
                    dict({'type': 'bend', 'radius': '2 mm', 'angle': '90 deg', 'axis': 'y'}, **bend),
                    {'type': 'flat', 'length': '20 mm'}]
        return {'schemaVersion': 1, 'thickness': '1 mm', 'segments': segments}

    def test_bend_table_from_k_factor(self):
        result = self.call('sheet.bends', self.bracket(K=0.5))
        row = result['bendTable'][0]
        self.assertAlmostEqual(row['neutralRadius'], 0.25, places=5)
        self.assertAlmostEqual(row['developedLength'], 0.25 * math.pi / 2, places=5)
        self.assertEqual(row['direction'], 'up')
        self.assertEqual(result['bendCount'], 1)

    def test_bend_table_from_explicit_allowance(self):
        allowance = 0.25 * math.pi / 2
        result = self.call('sheet.bends', self.bracket(allowance='%s mm' % (allowance * 10)))
        row = result['bendTable'][0]
        self.assertAlmostEqual(row['allowance'], allowance, places=5)
        self.assertAlmostEqual(row['neutralRadius'], 0.25, places=5)

    def test_bend_direction_sign(self):
        result = self.call('sheet.bends', self.bracket(angle='-90 deg', K=0.5))
        self.assertEqual(result['bendTable'][0]['direction'], 'down')

    def test_allowance_never_guessed(self):
        with self.assertRaises(ValueError):
            self.call('sheet.bends', self.bracket())
        with self.assertRaises(ValueError):
            self.call('sheet.bends', self.bracket(K=1.5))
        with self.assertRaises(ValueError):
            self.call('sheet.bends', self.bracket(K=0.5, allowance='1 mm'))

    def test_form_folds_neutral_axis_and_preserves_length(self):
        result = self.call('sheet.form', self.bracket(K=0.5))
        bend = 0.25 * math.pi / 2
        self.assertAlmostEqual(result['totalDevelopedLength'], 2.0 + bend + 2.0, places=5)
        end = result['formedCenterline'][-1]
        self.assertAlmostEqual(end[0], 2.25, places=5)
        self.assertAlmostEqual(end[1], 0.0, places=5)
        self.assertAlmostEqual(end[2], -2.25, places=5)
        self.assertEqual(result['representation'], 'external')
        self.assertFalse(result['nativeFlatPattern']['available'])
        self.assertEqual(len(result['correspondence']), 3)

    def test_flat_layout_developed_length_and_no_scaling(self):
        allowance = 0.25 * math.pi / 2
        result = self.call('sheet.flat', self.bracket(allowance='%s mm' % (allowance * 10)))
        self.assertTrue(result['developedEqualsFormedNeutral'])
        self.assertFalse(result['scaled'])
        self.assertAlmostEqual(result['totalDevelopedLength'], 2.0 + allowance + 2.0, places=5)

    def test_native_representation_blocked_not_faked(self):
        for operation in ('sheet.form', 'sheet.flat'):
            data = self.bracket(K=0.5)
            data['representation'] = 'native'
            result = self.call(operation, data)
            self.assertEqual(result['status'], 'blocked')
            self.assertFalse(result['success'])
            self.assertFalse(result['nativeFlatPattern']['available'])

    def test_invalid_segments_rejected(self):
        with self.assertRaises(ValueError):
            self.call('sheet.bends', {'schemaVersion': 1, 'thickness': '1 mm',
                                      'segments': [{'type': 'flat', 'length': '0 mm'}]})
        with self.assertRaises(ValueError):
            self.call('sheet.bends', {'schemaVersion': 1, 'thickness': '1 mm',
                                      'segments': [{'type': 'curve', 'length': '10 mm'}]})
        with self.assertRaises(ValueError):
            self.call('sheet.bends', {'schemaVersion': 2, 'thickness': '1 mm',
                                      'segments': self.bracket(K=0.5)['segments']})


if __name__ == '__main__':
    unittest.main()
