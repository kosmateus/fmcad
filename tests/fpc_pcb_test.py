"""GM26 offline tests: FPC fold/flatten, PCB exchange/check, ports, connectors, packing, keepouts."""
import math
from pathlib import Path
import unittest

import model_test as model


ROOT = Path(__file__).resolve().parents[1]
NAMESPACE = dict(model.namespace)
NAMESPACE['CAD_HANDLERS'] = dict(model.HANDLERS)
exec(compile((ROOT / 'assets/cad/fpc_pcb.py').read_text(), 'fpc_pcb.py', 'exec'), NAMESPACE)
HANDLERS = NAMESPACE['CAD_HANDLERS']


class FpcPcbTests(unittest.TestCase):
    def call(self, operation, data):
        return HANDLERS[operation](model.Context(), data)

    def test_fpc_fold_preserves_neutral_length(self):
        data = {'schemaVersion': 1, 'chain': [{'type': 'line', 'length': '10 mm'},
                {'type': 'bend', 'radius': '2 mm', 'angle': '90 deg', 'axis': 'y'},
                {'type': 'line', 'length': '10 mm'}]}
        result = self.call('fpc.fold', data)
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['neutralLengthPreserved'])
        self.assertFalse(result['scaled'])
        expected = 1.0 + 0.2 * (math.pi / 2) + 1.0
        self.assertAlmostEqual(result['flatNeutralLength'], expected, places=5)
        self.assertEqual(result['flatNeutralLength'], result['foldedNeutralLength'])

    def test_fpc_fold_then_flatten_round_trip(self):
        chain = [{'type': 'line', 'length': '10 mm'},
                 {'type': 'bend', 'radius': '3 mm', 'angle': '45 deg', 'axis': 'y'},
                 {'type': 'line', 'length': '5 mm'}]
        folded = self.call('fpc.fold', {'schemaVersion': 1, 'chain': chain})
        flat = self.call('fpc.flatten', {'schemaVersion': 1, 'chain': chain})
        self.assertAlmostEqual(folded['foldedNeutralLength'], flat['flatNeutralLength'], places=6)
        self.assertFalse(flat['scaled'])

    def test_pcb_exchange_distinguishes_step_center_from_lens_datum(self):
        data = {'schemaVersion': 1,
                'source': {'datum': {'name': 'step-center', 'type': 'step-center', 'origin': ['0 mm', '0 mm', '0 mm']}},
                'target': {'datum': {'name': 'lens-datum', 'type': 'lens', 'origin': ['2 mm', '1 mm', '0 mm']}}}
        result = self.call('pcb.mechanical-exchange', data)
        self.assertFalse(result['compatibleDatum'])
        self.assertAlmostEqual(result['datumOffset'][0], 0.2, places=5)
        self.assertTrue(any('STEP' in w for w in result['warnings']))

    def test_pcb_check_requires_both_height_zones(self):
        board = {'thickness': '1.6 mm', 'outline': [['0 mm', '0 mm'], ['20 mm', '0 mm'],
                 ['20 mm', '20 mm'], ['0 mm', '20 mm']],
                 'holes': [{'center': ['5 mm', '5 mm', '0 mm'], 'type': 'round', 'diameter': '2 mm'}],
                 'heightZones': [{'side': 'top'}]}
        result = self.call('pcb.check', {'schemaVersion': 1, 'board': board})
        self.assertFalse(result['passed'])
        self.assertTrue(any('bottom' in v for v in result['violations']))
        board['heightZones'].append({'side': 'bottom'})
        result = self.call('pcb.check', {'schemaVersion': 1, 'board': board})
        self.assertTrue(result['passed'])

    def test_port_define_validation(self):
        data = {'schemaVersion': 1, 'name': 'PWR',
                'frame': {'origin': ['0 mm', '0 mm', '0 mm'], 'normal': [0, 0, 1], 'pin1': ['1 mm', '0 mm', '0 mm']},
                'matingStroke': '5 mm'}
        result = self.call('port.define', data)
        self.assertEqual(result['normal'], [0, 0, 1])
        self.assertAlmostEqual(result['matingStroke'], 0.5, places=5)

    def test_connector_mate_check_detects_shared_key_hazard(self):
        data = {'schemaVersion': 1,
                'connectors': [{'name': 'POWER_M', 'gender': 'male', 'pinCount': 4, 'key': '4pin-k'},
                               {'name': 'POWER_F', 'gender': 'female', 'pinCount': 4, 'key': '4pin-k'},
                               {'name': 'DATA_F', 'gender': 'female', 'pinCount': 4, 'key': '4pin-k'}],
                'intendedPairs': [['POWER_M', 'POWER_F']],
                'forbiddenPairs': [['POWER_M', 'DATA_F']]}
        result = self.call('connector.mate-check', data)
        self.assertTrue(result['intended'][0]['mates'])
        self.assertTrue(result['forbidden'][0]['canReachSeating'])
        self.assertFalse(result['passed'])
        self.assertEqual(result['status'], 'fail')

    def test_connector_mate_check_poka_yoke_key_mismatch_is_safe(self):
        data = {'schemaVersion': 1,
                'connectors': [{'name': 'POWER_M', 'gender': 'male', 'pinCount': 4, 'key': 'pwr-k'},
                               {'name': 'POWER_F', 'gender': 'female', 'pinCount': 4, 'key': 'pwr-k'},
                               {'name': 'DATA_F', 'gender': 'female', 'pinCount': 4, 'key': 'data-k'}],
                'intendedPairs': [['POWER_M', 'POWER_F']],
                'forbiddenPairs': [['POWER_M', 'DATA_F']]}
        result = self.call('connector.mate-check', data)
        self.assertTrue(result['passed'])
        self.assertFalse(result['forbidden'][0]['canReachSeating'])

    def test_pack_cross_section_shape_fit_not_just_area(self):
        cavity = [['0 mm', '0 mm'], ['10 mm', '0 mm'], ['10 mm', '10 mm'], ['0 mm', '10 mm']]
        good = self.call('pack.cross-section', {'schemaVersion': 1, 'cavity': cavity,
            'items': [{'center': ['5 mm', '5 mm', '0 mm'], 'radius': '2 mm'}], 'reserve': 0.3})
        self.assertTrue(good['passed'])
        self.assertEqual(good['reserve']['denominator'], 'cavity area')
        # Equal area but a square that pokes outside the cavity must fail shape fit.
        outside = [['8 mm', '8 mm'], ['16 mm', '8 mm'], ['16 mm', '16 mm'], ['8 mm', '16 mm']]
        bad = self.call('pack.cross-section', {'schemaVersion': 1, 'cavity': cavity,
            'items': [{'outline': outside}], 'reserve': 0.0})
        self.assertFalse(bad['passed'])
        self.assertTrue(bad['shapeFitViolations'])

    def test_keepout_check_outside_board(self):
        board = {'outline': [['0 mm', '0 mm'], ['20 mm', '0 mm'], ['20 mm', '20 mm'], ['0 mm', '20 mm']]}
        inside = self.call('keepout.check', {'schemaVersion': 1, 'board': board,
            'keepouts': [{'name': 'K1', 'outline': [['2 mm', '2 mm'], ['8 mm', '2 mm'], ['8 mm', '8 mm'], ['2 mm', '8 mm']]}]})
        self.assertTrue(inside['passed'])
        outside = self.call('keepout.check', {'schemaVersion': 1, 'board': board,
            'keepouts': [{'name': 'K2', 'outline': [['15 mm', '15 mm'], ['25 mm', '15 mm'], ['25 mm', '25 mm'], ['15 mm', '25 mm']]}]})
        self.assertFalse(outside['passed'])
        self.assertTrue(outside['violations'])


if __name__ == '__main__':
    unittest.main()
