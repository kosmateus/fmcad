"""CWG governance gap tests (X-12..X-15).

These close the §6 "data requiring clarification" gaps by asserting that the
handlers preserve each conflict/ambiguity as OPEN rather than silently resolving
it. They run the real assets/cad handlers offline against the fixtures under
tests/fixtures/cwg/.
"""
import json
from pathlib import Path
import unittest

import model_test as model


ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / 'tests' / 'fixtures' / 'cwg'

NAMESPACE = dict(model.namespace)
NAMESPACE['CAD_HANDLERS'] = dict(model.HANDLERS)
for module in ('seal.py', 'thread.py', 'fpc_pcb.py', 'checking.py'):
    exec(compile((ROOT / 'assets' / 'cad' / module).read_text(), module, 'exec'), NAMESPACE)
HANDLERS = NAMESPACE['CAD_HANDLERS']


class Context(model.Context):
    def call(self, operation, data):
        return HANDLERS[operation](self, data)


def load(name):
    return json.loads((FIX / name).read_text())


class X12DockAmbiguityTests(unittest.TestCase):
    def call(self, operation, data):
        return HANDLERS[operation](Context(), data)

    def test_fixture_flags_fixed_vs_floating_direction_open(self):
        fixture = load('cwg-dock-ambiguity.json')
        self.assertEqual(fixture['status'], 'OPEN')
        self.assertEqual(len(fixture['candidateDirections']), 2)
        self.assertEqual(fixture['ambiguity']['reason'], 'The fixed vs floating dock half direction is not determined by the source data and must not be silently assigned.')

    def test_dock_handler_reports_float_and_never_resolves_direction(self):
        connect = [
            {'event': 'lead-in', 'at': '0 mm'},
            {'event': 'locator-engage', 'at': '2 mm'},
            {'event': 'seal-contact', 'at': '4 mm'},
            {'event': 'valve-open', 'at': '4.6 mm'},
            {'event': 'both-valve-open', 'at': '5 mm'},
        ]
        # Candidate B (floating seal half) declares float travel; the handler keeps
        # it as a declared input and applies it worst-case, never resolving which
        # half floats.
        result = self.call('dock.sequence-check', {
            'schemaVersion': 1, 'frame': 'component', 'connect': connect,
            'float': '0.5 mm', 'axialTolerance': '0.1 mm', 'minimumSealBeforeOpen': '0.5 mm'})
        self.assertEqual(result['float']['value'], 0.5)  # mm
        self.assertFalse(any('fixedHalf' in k for k in result))
        # The declared float makes the worst-case margin smaller than the nominal.
        self.assertLess(result['worstCaseMargin']['value'], result['sealBeforeOpenMargin']['value'])
        self.assertAlmostEqual(result['sealBeforeOpenMargin']['value'], 0.6, places=6)  # mm

    def test_ambiguous_float_direction_changes_acceptance(self):
        connect = [
            {'event': 'lead-in', 'at': '0 mm'},
            {'event': 'seal-contact', 'at': '4 mm'},
            {'event': 'valve-open', 'at': '4.6 mm'},
        ]
        fixed_base = self.call('dock.sequence-check', {
            'schemaVersion': 1, 'frame': 'component', 'connect': connect,
            'axialTolerance': '0.1 mm', 'minimumSealBeforeOpen': '0.5 mm'})
        floating_base = self.call('dock.sequence-check', {
            'schemaVersion': 1, 'frame': 'component', 'connect': connect,
            'float': '0.5 mm', 'axialTolerance': '0.1 mm', 'minimumSealBeforeOpen': '0.5 mm'})
        # Nominal margin 0.6 mm: fixed base passes, floating base fails. The data
        # does not choose between them, so the ambiguity is material and stays open.
        self.assertEqual(fixed_base['status'], 'pass')
        self.assertEqual(floating_base['status'], 'fail')


class X13PlugThreadTests(unittest.TestCase):
    def call(self, operation, data):
        return HANDLERS[operation](Context(), data)

    def test_fixture_leaves_starts_pitch_lead_open(self):
        fixture = load('cwg-plug-thread.json')
        self.assertEqual(fixture['status'], 'OPEN')
        self.assertIsNone(fixture['thread']['starts'])
        self.assertIsNone(fixture['thread']['lead'])

    def test_custom_profile_absent_starts_is_not_silently_single_start(self):
        result = self.call('thread.custom-profile', {
            'schemaVersion': 1, 'frame': 'component', 'majorDiameter': '72 mm', 'pitch': '3 mm'})
        self.assertEqual(result['status'], 'unknown')
        self.assertIsNone(result['profile']['starts'])
        self.assertIsNone(result['profile']['lead'])
        self.assertIsNone(result['profile']['turnsPerLength'])

    def test_custom_profile_resolves_only_with_explicit_starts(self):
        one = self.call('thread.custom-profile', {
            'schemaVersion': 1, 'frame': 'component', 'majorDiameter': '72 mm', 'pitch': '3 mm', 'starts': 1})
        three = self.call('thread.custom-profile', {
            'schemaVersion': 1, 'frame': 'component', 'majorDiameter': '72 mm', 'pitch': '3 mm', 'starts': 3})
        self.assertEqual(one['status'], 'pass')
        self.assertAlmostEqual(one['profile']['lead']['value'], 3.0)  # mm
        self.assertEqual(three['status'], 'pass')
        self.assertAlmostEqual(three['profile']['lead']['value'], 9.0)  # mm

    def test_pair_check_unresolved_starts_is_not_silently_matched(self):
        result = self.call('thread.pair-check', {
            'schemaVersion': 1, 'frame': 'component',
            'external': {'majorDiameter': '72 mm', 'pitch': '3 mm', 'starts': 3},
            'internal': {'majorDiameter': '72 mm', 'pitch': '3 mm'}})
        self.assertEqual(result['status'], 'fail')
        self.assertTrue(any(c['check'] == 'starts' and c['status'] == 'fail' for c in result['checks']))


class X14Pcb05Tests(unittest.TestCase):
    def call(self, operation, data):
        return HANDLERS[operation](Context(), data)

    def test_fixture_marks_stackup_and_outline_open(self):
        fixture = load('cwg-pcb05.json')
        self.assertEqual(fixture['status'], 'OPEN')
        self.assertIsNone(fixture['pcb05']['stackup'])
        self.assertEqual(fixture['pcb05']['outlineResolution'], 'OPEN')
        self.assertTrue(fixture['pcb05']['branchedOutline'])

    def test_branched_outline_is_never_folded_as_a_whole(self):
        # A single declared branch (neutral-axis chain) folds; the 250 mm branched
        # envelope is never silently flattened into that single fold.
        chain = [{'type': 'line', 'length': '30 mm'},
                 {'type': 'bend', 'radius': '3 mm', 'angle': '90 deg', 'axis': 'y'},
                 {'type': 'line', 'length': '30 mm'}]
        result = self.call('fpc.fold', {
            'schemaVersion': 1, 'chain': chain,
            'outline': [['0 mm', '0 mm'], ['250 mm', '0 mm'], ['250 mm', '35 mm'], ['0 mm', '35 mm']],
            'rigidIslands': 4})
        expected = 3.0 + 0.3 * (3.141592653589793 / 2) + 3.0  # cm
        self.assertAlmostEqual(result['flatNeutralLength'], expected, places=5)
        self.assertTrue(result['neutralLengthPreserved'])
        self.assertNotIn('islandFolds', result)
        self.assertNotIn('branchFolds', result)

    def test_pcb02_local_reserve_is_a_zone_not_uniform_height(self):
        fixture = load('cwg-pcb05.json')
        local = fixture['pcb02']['localZones'][0]
        self.assertEqual(local['status'], 'OPEN')
        self.assertEqual(local['reserve'], '20x18x4')
        board = {'thickness': '1.0 mm',
                 'outline': [['0 mm', '0 mm'], ['50 mm', '0 mm'], ['50 mm', '44 mm'], ['0 mm', '44 mm']],
                 'holes': [],
                 'heightZones': [{'side': 'top'}, {'side': 'bottom'}]}
        result = self.call('pcb.check', {'schemaVersion': 1, 'board': board})
        self.assertTrue(result['passed'])
        self.assertEqual(result['heightZones'], ['bottom', 'top'])


class X15OpenGatesTests(unittest.TestCase):
    def call(self, operation, data):
        return HANDLERS[operation](Context(), data)

    def test_fixture_lists_open_items(self):
        fixture = load('cwg-open-gates.json')
        self.assertEqual(fixture['status'], 'OPEN')
        kinds = {item['id']: item['kind'] for item in fixture['openItems']}
        self.assertIn('ebom-full-production', kinds)
        self.assertIn('routing-flex', kinds)

    def test_check_set_keeps_open_sources_stale_not_pass(self):
        fixture = load('cwg-open-gates.json')
        result = self.call('check.set', {'schemaVersion': 1, 'checks': fixture['deliverChecklist']})
        self.assertNotEqual(result['status'], 'pass')
        self.assertTrue(result['executionSucceededIsNotCheckPassed'])
        outcomes = {item['id']: item['outcome'] for item in result['items']}
        self.assertEqual(outcomes['routing-open'], 'stale')
        self.assertEqual(outcomes['ebom-full-production'], 'stale')

    def test_deliver_does_not_accept_open_routing_or_ebom(self):
        fixture = load('cwg-open-gates.json')
        result = self.call('deliver', {
            'schemaVersion': 1, 'checks': fixture['deliverChecklist'], 'gate': 'G7'})
        self.assertFalse(result['accepted'])
        self.assertNotEqual(result['status'], 'pass')


if __name__ == '__main__':
    unittest.main()
