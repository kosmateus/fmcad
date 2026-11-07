"""GM27 offline tests: assembly sequence, service path-check, tool access, fixture access."""
import math
from pathlib import Path
import unittest

import model_test as model


ROOT = Path(__file__).resolve().parents[1]
NAMESPACE = dict(model.namespace)
NAMESPACE['CAD_HANDLERS'] = dict(model.HANDLERS)
exec(compile((ROOT / 'assets/cad/sequence.py').read_text(), 'sequence.py', 'exec'), NAMESPACE)
HANDLERS = NAMESPACE['CAD_HANDLERS']


class SequenceTests(unittest.TestCase):
    def call(self, operation, data):
        return HANDLERS[operation](model.Context(), data)

    def test_assembly_order_and_media_not_rigidized(self):
        data = {'schemaVersion': 1, 'parts': ['base', 'connector', 'shaft', 'housing'],
                'dependencies': [['base', 'connector'], ['connector', 'shaft'], ['shaft', 'housing']],
                'removedParts': ['connector'],
                'disconnectedMedia': [{'name': 'PWR-cable', 'connects': ['connector', 'shaft']}],
                'serviceStates': [{'part': 'shaft', 'requires': [{'media': 'PWR-cable', 'state': 'disconnected'}]}]}
        result = self.call('assembly.sequence', data)
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['order'], ['base', 'connector', 'shaft', 'housing'])
        self.assertEqual(result['disassemblyOrder'], ['housing', 'shaft', 'connector', 'base'])
        self.assertFalse(result['mediaRigidized'])
        self.assertEqual(result['blockers']['shaft'], ['connector'])
        removals = {r['part']: r for r in result['removals']}
        self.assertEqual(removals['connector']['removeBlockers'], ['shaft'])
        self.assertEqual(removals['connector']['disconnections'], ['PWR-cable'])
        self.assertEqual(removals['connector']['servicePrerequisites'], [])
        self.assertEqual(result['cycles'], [])

    def test_trapped_screw_requires_cover_removal_first(self):
        data = {'schemaVersion': 1, 'parts': ['housing', 'screw', 'cover'],
                'dependencies': [['screw', 'cover'], ['housing', 'cover']],
                'removedParts': ['screw']}
        result = self.call('assembly.sequence', data)
        self.assertEqual(result['status'], 'pass')
        removals = {r['part']: r for r in result['removals']}
        self.assertEqual(removals['screw']['removeBlockers'], ['cover'])

    def test_service_states_with_real_disconnections(self):
        data = {'schemaVersion': 1, 'parts': ['head', 'ring', 'power', 'chassis'],
                'dependencies': [['chassis', 'head'], ['chassis', 'ring'], ['chassis', 'power']],
                'removedParts': ['head', 'ring', 'power'],
                'serviceStates': [
                    {'part': 'head', 'requires': [{'media': 'head-media', 'state': 'disconnected'}]},
                    {'part': 'ring', 'requires': [{'media': 'ring-media', 'state': 'disconnected'}]},
                    {'part': 'power', 'requires': [{'state': 'powerOff'}, {'media': 'power-cable', 'state': 'disconnected'}]}]}
        result = self.call('assembly.sequence', data)
        removals = {r['part']: r for r in result['removals']}
        self.assertEqual(removals['power']['servicePrerequisites'],
                         [{'state': 'powerOff'}, {'media': 'power-cable', 'state': 'disconnected'}])
        self.assertEqual(removals['head']['servicePrerequisites'],
                         [{'media': 'head-media', 'state': 'disconnected'}])

    def test_dependency_cycle_is_fail(self):
        data = {'schemaVersion': 1, 'parts': ['a', 'b', 'c'],
                'dependencies': [['a', 'b'], ['b', 'c'], ['c', 'a']]}
        result = self.call('assembly.sequence', data)
        self.assertEqual(result['status'], 'fail')
        self.assertTrue(result['cycles'])

    def test_unknown_part_and_duplicate_names_rejected(self):
        with self.assertRaises(ValueError):
            self.call('assembly.sequence', {'schemaVersion': 1, 'parts': ['a'],
                                            'dependencies': [['a', 'b']]})
        with self.assertRaises(ValueError):
            self.call('assembly.sequence', {'schemaVersion': 1, 'parts': ['a', 'a']})

    def test_tank_withdrawal_is_feasible(self):
        data = {'schemaVersion': 1, 'part': {'name': 'tank', 'outline': [['-10 mm', '0 mm'], ['10 mm', '0 mm'],
                ['10 mm', '20 mm'], ['-10 mm', '20 mm']]}, 'direction': [0, 1], 'distance': '30 mm',
                'obstacles': [{'name': 'wall', 'outline': [['15 mm', '0 mm'], ['30 mm', '0 mm'],
                                                           ['30 mm', '50 mm'], ['15 mm', '50 mm']]}]}
        result = self.call('service.path-check', data)
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['feasible'])
        self.assertFalse(result['blocked'])
        self.assertEqual(result['blockers'], [])
        self.assertAlmostEqual(result['minClearance'], 0.5, places=4)

    def test_trapped_part_blocked_along_sweep(self):
        data = {'schemaVersion': 1, 'part': {'name': 'plug', 'outline': [['-5 mm', '0 mm'], ['5 mm', '0 mm'],
                ['5 mm', '10 mm'], ['-5 mm', '10 mm']]}, 'direction': [0, 1], 'distance': '20 mm',
                'obstacles': [{'name': 'cage', 'outline': [['-3 mm', '12 mm'], ['3 mm', '12 mm'],
                                                           ['3 mm', '30 mm'], ['-3 mm', '30 mm']]}]}
        result = self.call('service.path-check', data)
        self.assertEqual(result['status'], 'fail')
        self.assertFalse(result['feasible'])
        self.assertTrue(result['blocked'])
        self.assertIn('cage', result['blockers'])
        self.assertLess(result['minClearance'], 0)

    def test_d6x40_tool_reaches_fastener(self):
        data = {'schemaVersion': 1, 'tool': {'diameter': '6 mm', 'length': '40 mm'},
                'target': {'origin': ['0 mm', '0 mm', '0 mm'], 'axis': [0, 0, 1], 'engagementDepth': '4 mm'},
                'entry': {'origin': ['0 mm', '0 mm', '30 mm'], 'direction': [0, 0, -1]},
                'obstacles': [{'name': 'rib', 'point': ['6 mm', '0 mm', '15 mm'], 'radius': '2 mm'}]}
        result = self.call('tool.access', data)
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['reachable'])
        self.assertTrue(result['lengthSufficient'])
        self.assertTrue(result['axisAligned'])
        self.assertAlmostEqual(result['reach'], 2.6, places=4)
        self.assertEqual(result['blockers'], [])

    def test_trapped_screw_blocked_by_boss(self):
        data = {'schemaVersion': 1, 'tool': {'diameter': '6 mm', 'length': '40 mm'},
                'target': {'origin': ['0 mm', '0 mm', '0 mm'], 'axis': [0, 0, 1], 'engagementDepth': '4 mm'},
                'entry': {'origin': ['0 mm', '0 mm', '30 mm'], 'direction': [0, 0, -1]},
                'obstacles': [{'name': 'boss', 'point': ['1 mm', '0 mm', '10 mm'], 'radius': '2 mm'}]}
        result = self.call('tool.access', data)
        self.assertEqual(result['status'], 'fail')
        self.assertFalse(result['reachable'])
        self.assertIn('boss', result['blockers'])

    def test_tool_too_short_or_misaligned(self):
        base = {'schemaVersion': 1, 'tool': {'diameter': '6 mm', 'length': '40 mm'},
                'target': {'origin': ['0 mm', '0 mm', '0 mm'], 'axis': [0, 0, 1], 'engagementDepth': '4 mm'},
                'entry': {'origin': ['0 mm', '0 mm', '30 mm'], 'direction': [0, 0, -1]}}
        short = dict(base, tool={'diameter': '6 mm', 'length': '20 mm'})
        self.assertFalse(self.call('tool.access', short)['lengthSufficient'])
        side = dict(base, entry={'origin': ['0 mm', '0 mm', '30 mm'], 'direction': [1, 0, 0]})
        result = self.call('tool.access', side)
        self.assertFalse(result['axisAligned'])
        self.assertFalse(result['reachable'])

    def test_fixture_seats_with_pin_and_datum(self):
        data = {'schemaVersion': 1,
                'part': {'name': 'pcb', 'features': [
                    {'name': 'pinA', 'kind': 'pin', 'origin': ['0 mm', '0 mm', '0 mm'], 'diameter': '2 mm'},
                    {'name': 'datA', 'kind': 'datum', 'origin': ['10 mm', '0 mm', '0 mm'], 'direction': [0, 0, 1]}]},
                'fixture': {'approach': {'direction': [0, 0, 1]}, 'features': [
                    {'name': 'holeA', 'kind': 'hole', 'origin': ['0 mm', '0 mm', '0 mm'], 'diameter': '2.1 mm'},
                    {'name': 'datA', 'kind': 'datum', 'origin': ['10 mm', '0 mm', '0 mm'], 'direction': [0, 0, 1]}]},
                'pairs': [['pinA', 'holeA'], ['datA', 'datA']]}
        result = self.call('fixture.access', data)
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['seatPossible'])
        self.assertTrue(all(p['fits'] for p in result['pairs']))

    def test_fixture_pin_too_large_and_misaligned_datum(self):
        data = {'schemaVersion': 1,
                'part': {'name': 'pcb', 'features': [
                    {'name': 'pinA', 'kind': 'pin', 'origin': ['0 mm', '0 mm', '0 mm'], 'diameter': '2.5 mm'},
                    {'name': 'datA', 'kind': 'datum', 'origin': ['0 mm', '0 mm', '0 mm'], 'direction': [0, 0, 1]}]},
                'fixture': {'approach': {'direction': [0, 0, 1]}, 'features': [
                    {'name': 'holeA', 'kind': 'hole', 'origin': ['0 mm', '0 mm', '0 mm'], 'diameter': '2.1 mm'},
                    {'name': 'datA', 'kind': 'datum', 'origin': ['2 mm', '0 mm', '0 mm'], 'direction': [0, 0, 1]}]},
                'pairs': [['pinA', 'holeA'], ['datA', 'datA']], 'tolerance': '0.5 mm'}
        result = self.call('fixture.access', data)
        self.assertEqual(result['status'], 'fail')
        self.assertFalse(result['seatPossible'])
        self.assertEqual(len(result['blockers']), 2)

    def test_fixture_unknown_feature_rejected(self):
        data = {'schemaVersion': 1,
                'part': {'name': 'pcb', 'features': [{'name': 'pinA', 'kind': 'pin', 'origin': ['0 mm', '0 mm', '0 mm'], 'diameter': '2 mm'}]},
                'fixture': {'approach': {'direction': [0, 0, 1]}, 'features': [{'name': 'holeA', 'kind': 'hole', 'origin': ['0 mm', '0 mm', '0 mm'], 'diameter': '2.1 mm'}]},
                'pairs': [['pinA', 'missing']]}
        with self.assertRaises(ValueError):
            self.call('fixture.access', data)


if __name__ == '__main__':
    unittest.main()
