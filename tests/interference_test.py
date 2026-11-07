"""GM19 offline tests: clearance grid planning/classification and motion envelopes."""
import json
import types
import unittest

import model_test as model

NAMESPACE = dict(model.namespace)
NAMESPACE['CAD_HANDLERS'] = dict(model.HANDLERS)
exec(compile((model.ROOT / 'assets/cad/interference.py').read_text(), 'interference.py', 'exec'), NAMESPACE)
HANDLERS = NAMESPACE['CAD_HANDLERS']


def _key(ref):
    return ref if isinstance(ref, str) else ref.get('token', ref.get('name'))


class InterferenceContext(model.Context):
    def __init__(self, pair_results=None, bounds=None):
        super().__init__()
        self.doc = types.SimpleNamespace(name='Doc', creationId='id-1')
        self.pair_results = pair_results or {}
        self.bounds = bounds or {}
        self.joints = {}
        self.calls = []
        self.fail_restore = set()
        self.inspect_overrides = {}
        self.inspect_sequences = {}
        self.drive_counts = {}

    def call(self, op, data):
        self.calls.append((op, data))
        if op == 'assembly.clearance':
            key = tuple(sorted((_key(data['a']), _key(data['b']))))
            result = self.pair_results.get(key)
            if result is None:
                raise ValueError('no scripted pair result for ' + str(key))
            return dict(result)
        if op == 'measure.distance':
            return {'points': [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]], 'units': 'cm'}
        if op == 'measure.bounds':
            ref = _key(data['ref'])
            if ref not in self.bounds:
                raise ValueError('no scripted bounds for ' + ref)
            return self.bounds[ref]
        if op == 'joint.inspect':
            key = _key(data['joint'])
            sequence = self.inspect_sequences.get(key)
            if sequence:
                return dict(sequence.pop(0))
            if key in self.inspect_overrides:
                return dict(self.inspect_overrides[key])
            return dict(self.joints.setdefault(key, {'rotationValue': 0.0}))
        if op == 'joint.drive':
            key = _key(data['joint'])
            state = {}
            if 'rotation' in data:
                state['rotationValue'] = self.angle(data['rotation'])
            if 'slide' in data:
                state['slideValue'] = self.length(data['slide'])
            count = self.drive_counts.get(key, 0)
            self.drive_counts[key] = count + 1
            if key in self.fail_restore and count >= 2 and state.get('rotationValue', state.get('slideValue')) == 0.0:
                raise RuntimeError('restore rejected')
            self.joints[key] = state
            return dict(state)
        raise ValueError('unexpected call ' + op)


def clearance_result(interferes, distance_cm=0.05, overlap_cm3=0.0):
    return {'interferes': interferes,
            'overlapVolume': {'value': overlap_cm3, 'units': 'cm^3', 'dimension': 'volume'},
            'distance': {'value': distance_cm, 'units': 'cm', 'dimension': 'length'},
            'clearancePassed': not interferes}


def clearance_result_mm(interferes, distance_mm=20.0, overlap_mm3=0.0):
    # assembly.clearance from the live kernel reports distance in mm; the offline
    # cm mock masked the units bug in _grid_expected_pass and worstCaseGap.
    return {'interferes': interferes,
            'overlapVolume': {'value': overlap_mm3, 'units': 'mm^3', 'dimension': 'volume'},
            'distance': {'value': distance_mm, 'units': 'mm', 'dimension': 'length'},
            'clearancePassed': not interferes}


class InterferenceTests(unittest.TestCase):
    def test_catalog_and_manual_cover_interference_operations(self):
        catalog = json.loads((model.ROOT / 'src/catalog/interference.json').read_text())
        manual = json.loads((model.ROOT / 'src/manual/interference.json').read_text())
        self.assertEqual(set(catalog), set(manual))
        self.assertEqual(set(catalog), {'clearance.grid', 'motion.envelope'})
        for operation, entry in catalog.items():
            self.assertEqual(entry['readOnly'], operation != 'clearance.grid')
            self.assertTrue(entry['envelope'])
        for operation, entry in manual.items():
            self.assertTrue(any(s['title'].startswith('Return Contract') for s in entry['sections']))
            self.assertTrue(entry['audit']['sources'] and entry['audit']['verified'] and entry['audit']['tests'])

    def test_grid_pair_expansion_and_plan(self):
        ctx = InterferenceContext(pair_results={
            ('body-a', 'body-b'): clearance_result(False),
            ('body-a', 'body-c'): clearance_result(False),
            ('body-b', 'body-c'): clearance_result(False)})
        result = HANDLERS['clearance.grid'](ctx, {'schemaVersion': 1, 'frame': 'component',
            'instances': ['body-a', 'body-b', 'body-c'], 'minimum': '0 mm'})
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['plan']['pairCount'], 3)
        self.assertEqual(result['plan']['totalChecks'], 3)
        self.assertEqual(result['coverage']['tested'], 3)
        self.assertFalse(result['coverage']['continuousVerified'])

    def test_grid_expected_contact_is_not_deleted(self):
        ctx = InterferenceContext(pair_results={
            ('body-a', 'body-b'): clearance_result(True, distance_cm=0.0, overlap_cm3=0.1)})
        result = HANDLERS['clearance.grid'](ctx, {'schemaVersion': 1, 'frame': 'component',
            'pairs': [{'a': 'body-a', 'b': 'body-b'}],
            'expectedContacts': [{'a': 'body-a', 'b': 'body-b', 'cause': 'seal face',
                                  'clearance': {'min': '0 mm', 'max': '0.05 mm'}}]})
        self.assertEqual(result['status'], 'pass')
        pair = result['results'][0]
        self.assertTrue(pair['expected'])
        self.assertEqual(pair['cause'], 'seal face')
        self.assertEqual(pair['status'], 'tested')
        self.assertTrue(pair['passed'])

    def test_grid_expected_contact_in_mm_is_converted_before_compare(self):
        ctx = InterferenceContext(pair_results={
            ('body-a', 'body-b'): clearance_result_mm(False, distance_mm=20.0)})
        result = HANDLERS['clearance.grid'](ctx, {'schemaVersion': 1, 'frame': 'component',
            'pairs': [{'a': 'body-a', 'b': 'body-b'}],
            'expectedContacts': [{'a': 'body-a', 'b': 'body-b', 'cause': 'seal',
                                  'clearance': {'min': '19 mm', 'max': '21 mm'}}]})
        self.assertEqual(result['status'], 'pass')
        pair = result['results'][0]
        self.assertTrue(pair['expected'])
        self.assertTrue(pair['passed'])

    def test_grid_worst_case_gap_reports_cm_from_mm_distance(self):
        ctx = InterferenceContext(pair_results={
            ('body-a', 'body-b'): clearance_result_mm(False, distance_mm=20.0)})
        result = HANDLERS['clearance.grid'](ctx, {'schemaVersion': 1, 'frame': 'component',
            'pairs': [{'a': 'body-a', 'b': 'body-b'}]})
        self.assertEqual(result['worstCaseGap']['units'], 'cm')
        self.assertAlmostEqual(result['worstCaseGap']['value'], 2.0, places=6)

    def test_grid_unexpected_interference_fails(self):
        ctx = InterferenceContext(pair_results={('body-a', 'body-b'): clearance_result(True, distance_cm=0.0, overlap_cm3=0.5)})
        result = HANDLERS['clearance.grid'](ctx, {'schemaVersion': 1, 'frame': 'component',
            'pairs': [{'a': 'body-a', 'b': 'body-b'}]})
        self.assertEqual(result['status'], 'fail')
        pair = result['results'][0]
        self.assertFalse(pair['expected'])
        self.assertEqual(pair['status'], 'failed')

    def test_grid_cartesian_is_a_product_not_a_diagonal(self):
        ctx = InterferenceContext(pair_results={('body-a', 'body-b'): clearance_result(False)})
        result = HANDLERS['clearance.grid'](ctx, {'schemaVersion': 1, 'frame': 'component',
            'pairs': [{'a': 'body-a', 'b': 'body-b'}], 'samples': 3,
            'joints': [{'joint': 'j1', 'rotation': {'from': '0 deg', 'to': '90 deg'}},
                       {'joint': 'j2', 'rotation': {'from': '0 deg', 'to': '180 deg'}}]})
        self.assertEqual(result['plan']['configCount'], 9)
        self.assertEqual(result['plan']['totalChecks'], 9)
        self.assertEqual(result['coverage']['tested'], 9)
        self.assertTrue(result['poseRestored'])

    def test_joint_reference_objects_are_restored_by_stable_identity(self):
        ctx = InterferenceContext(pair_results={('body-a', 'body-b'): clearance_result(False)})
        ctx.joints['j1'] = {'rotationValue': 0.25}
        result = HANDLERS['clearance.grid'](ctx, {'schemaVersion': 1, 'frame': 'component',
            'pairs': [{'a': 'body-a', 'b': 'body-b'}], 'samples': 2,
            'joints': [{'joint': {'token': 'j1'}, 'rotation': {'from': '0 deg', 'to': '90 deg'}}]})
        self.assertTrue(result['poseRestored'])
        self.assertTrue(any(op == 'joint.drive' and data['joint'] == {'token': 'j1'}
                            and data['rotation'] == '0.25 rad' for op, data in ctx.calls))

    def test_duplicate_joint_reference_ranges_rejected_before_sdk_calls(self):
        ctx = InterferenceContext()
        with self.assertRaisesRegex(ValueError, 'one range per distinct joint ref'):
            HANDLERS['clearance.grid'](ctx, {'schemaVersion': 1, 'frame': 'component',
                'pairs': [{'a': 'body-a', 'b': 'body-b'}],
                'joints': [{'joint': {'token': 'j1'}, 'rotation': {'from': '0 deg', 'to': '90 deg'}},
                           {'joint': {'token': 'j1'}, 'rotation': {'from': '0 deg', 'to': '45 deg'}}]})
        self.assertEqual(ctx.calls, [])

    def test_grid_budget_exceeds_is_unknown_without_testing(self):
        ctx = InterferenceContext(pair_results={('body-a', 'body-b'): clearance_result(False)})
        result = HANDLERS['clearance.grid'](ctx, {'schemaVersion': 1, 'frame': 'component',
            'instances': ['body-a', 'body-b', 'body-c'], 'budget': {'maxChecks': 1}})
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['results'], [])
        self.assertEqual(result['coverage']['unknown'], 3)

    def test_grid_broad_phase_prunes_disjoint_instances(self):
        bounds = {'body-a': {'min': [0, 0, 0], 'max': [1, 1, 1]},
                  'body-b': {'min': [0.5, 0.5, 0.5], 'max': [1.5, 1.5, 1.5]},
                  'body-c': {'min': [100, 100, 100], 'max': [101, 101, 101]}}
        ctx = InterferenceContext(bounds=bounds, pair_results={
            ('body-a', 'body-b'): clearance_result(False),
            ('body-a', 'body-c'): clearance_result(False),
            ('body-b', 'body-c'): clearance_result(False)})
        result = HANDLERS['clearance.grid'](ctx, {'schemaVersion': 1, 'frame': 'component',
            'instances': ['body-a', 'body-b', 'body-c'], 'broadPhase': True})
        self.assertEqual(result['plan']['broadPhasePruned'], 2)
        self.assertEqual(result['plan']['pairCount'], 1)

    def test_broad_phase_rejects_joints_or_positive_minimum_before_any_measurement(self):
        for extra in ({'joints': [{'joint': 'j1', 'rotation': {'from': '0 deg', 'to': '90 deg'}}]},
                      {'minimum': '1 mm'}):
            with self.subTest(extra=extra):
                ctx = InterferenceContext()
                with self.assertRaisesRegex(ValueError, 'broadPhase'):
                    HANDLERS['clearance.grid'](ctx, {'schemaVersion': 1, 'frame': 'component',
                        'pairs': [{'a': 'body-a', 'b': 'body-b'}], 'broadPhase': True, **extra})
                self.assertEqual(ctx.calls, [])

    def test_joint_restore_uses_readback_and_attempts_remaining_joints(self):
        ctx = InterferenceContext(pair_results={('body-a', 'body-b'): clearance_result(False)})
        ctx.joints.update(j1={'rotationValue': 0.0}, j2={'rotationValue': 0.0})
        ctx.fail_restore.add('j1')
        result = HANDLERS['clearance.grid'](ctx, {'schemaVersion': 1, 'frame': 'component',
            'pairs': [{'a': 'body-a', 'b': 'body-b'}], 'samples': 2,
            'joints': [{'joint': 'j1', 'rotation': {'from': '0 deg', 'to': '90 deg'}},
                       {'joint': 'j2', 'rotation': {'from': '0 deg', 'to': '90 deg'}}]})
        self.assertEqual(result['status'], 'fail')
        self.assertFalse(result['poseRestored'])
        self.assertTrue(any(error['joint'] == 'j1' for error in result['restoreErrors']))
        self.assertTrue(any(op == 'joint.drive' and data['joint'] == 'j2' and data['rotation'] == '0 rad'
                            for op, data in ctx.calls))
        self.assertTrue(any(op == 'joint.inspect' and data['joint'] == 'j2' for op, data in ctx.calls))

    def test_joint_restore_mismatch_is_not_reported_restored(self):
        ctx = InterferenceContext(pair_results={('body-a', 'body-b'): clearance_result(False)})
        ctx.joints['j1'] = {'rotationValue': 0.25}
        ctx.inspect_sequences['j1'] = [{'rotationValue': 0.25}, {'rotationValue': 0.5}]
        result = HANDLERS['clearance.grid'](ctx, {'schemaVersion': 1, 'frame': 'component',
            'pairs': [{'a': 'body-a', 'b': 'body-b'}], 'samples': 2,
            'joints': [{'joint': 'j1', 'rotation': {'from': '0 deg', 'to': '90 deg'}}]})
        self.assertFalse(result['poseRestored'])
        self.assertTrue(any(error.get('stage') == 'readback' and error.get('actual') == 0.5
                            for error in result['restoreErrors']))

    def test_envelope_translation_conservative(self):
        ctx = InterferenceContext()
        result = HANDLERS['motion.envelope'](ctx, {'schemaVersion': 1, 'frame': 'component',
            'motion': {'type': 'translation', 'axis': [1, 0, 0], 'from': '0 mm', 'to': '20 mm'},
            'bounds': {'min': [0, 0, 0], 'max': [10, 10, 10]}, 'representation': 'conservative'})
        self.assertEqual(result['status'], 'pass')
        self.assertFalse(result['continuousVerified'])
        self.assertEqual(result['conservativeEnvelope']['min'], [0.0, 0.0, 0.0])
        self.assertEqual(result['conservativeEnvelope']['max'], [12.0, 10.0, 10.0])

    def test_envelope_translation_sampled(self):
        ctx = InterferenceContext()
        result = HANDLERS['motion.envelope'](ctx, {'schemaVersion': 1, 'frame': 'component',
            'motion': {'type': 'translation', 'axis': [1, 0, 0], 'from': '0 mm', 'to': '20 mm'},
            'bounds': {'min': [0, 0, 0], 'max': [10, 10, 10]}, 'representation': 'sampled', 'samples': 5})
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['sampleCount'], 5)
        self.assertEqual(result['sampledEnvelope']['max'][0], 12.0)

    def test_envelope_rotation_sampled_and_conservative(self):
        ctx = InterferenceContext()
        result = HANDLERS['motion.envelope'](ctx, {'schemaVersion': 1, 'frame': 'component',
            'motion': {'type': 'rotation', 'axis': [0, 0, 1], 'from': '0 deg', 'to': '360 deg'},
            'bounds': {'min': [0, 0, 0], 'max': [10, 10, 10]}, 'representation': 'conservative'})
        self.assertEqual(result['status'], 'pass')
        self.assertIn('sampledEnvelope', result)
        self.assertIn('conservativeEnvelope', result)
        self.assertFalse(result['continuousVerified'])

    def test_envelope_certified_requires_coverage_proof(self):
        ctx = InterferenceContext()
        result = HANDLERS['motion.envelope'](ctx, {'schemaVersion': 1, 'frame': 'component',
            'motion': {'type': 'translation', 'axis': [1, 0, 0], 'from': '0 mm', 'to': '20 mm'},
            'bounds': {'min': [0, 0, 0], 'max': [10, 10, 10]}, 'representation': 'certified'})
        self.assertEqual(result['status'], 'unknown')
        self.assertFalse(result['continuousVerified'])
        self.assertFalse(result['certified'])

    def test_envelope_certified_with_path(self):
        ctx = InterferenceContext()
        result = HANDLERS['motion.envelope'](ctx, {'schemaVersion': 1, 'frame': 'component',
            'motion': {'type': 'translation', 'axis': [1, 0, 0], 'from': '0 mm', 'to': '20 mm'},
            'bounds': {'min': [0, 0, 0], 'max': [10, 10, 10]}, 'representation': 'certified',
            'certifiedPath': [{'from': '0 mm', 'to': '20 mm', 'verified': True}]})
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['continuousVerified'])
        self.assertTrue(result['certified'])


if __name__ == '__main__':
    unittest.main()
