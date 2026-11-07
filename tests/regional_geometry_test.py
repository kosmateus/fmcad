"""Offline analytic CSG/adapter tests; deliberately NOT native qualification."""
import copy
import importlib.util
import json
import math
from pathlib import Path
from types import SimpleNamespace
from typing import cast
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('regional_solids', ROOT / 'tests/fixtures/regional_geometry_solids.py')
solids = importlib.util.module_from_spec(spec)
spec.loader.exec_module(solids)


class RegionalGeometryTest(unittest.TestCase):
    def setUp(self):
        self.manager = solids.Manager()
        self.root = SimpleNamespace(name='root', allOccurrences=[])
        self.child = SimpleNamespace(name='child', allOccurrences=[])
        self.doc = SimpleNamespace(name='regional-offline', dataFile=None, isValid=True)
        self.entities = {'root': self.root, 'child': self.child}
        self.ns = {
            'CAD_HANDLERS': {},
            '_CAD_TYPE_CHECKING': False,
            '_cad_cast': cast,
            'math': math,
            'adsk': SimpleNamespace(fusion=SimpleNamespace(
                TemporaryBRepManager=SimpleNamespace(get=lambda: self.manager),
                BooleanTypes=SimpleNamespace(DifferenceBooleanType='difference',
                    IntersectionBooleanType='intersection', UnionBooleanType='union'))),
            '_cad_kind': lambda e: 'body' if isinstance(e, solids.Body) else 'component',
            '_cad_owner': lambda e: e.parentComponent if isinstance(e, solids.Body) else e,
            '_cad_items': list,
            '_cad_require_result': self.require,
        }
        for file in ('adapters/fusion/measure.py', 'domain/regional_geometry.py',
                     'adapters/fusion/regional_geometry.py', 'application/regional_geometry.py'):
            path = ROOT / 'runtime/python/fmcad' / file
            exec(compile(path.read_text(), str(path), 'exec'), self.ns)
        self.ctx = SimpleNamespace(doc=self.doc, root=self.root, resolve=self.resolve,
                                   ref=self.ref, _expression=self.expression)
        self.add('before', (0, 0, 0, 2, 2, 2))
        self.add('after', (0, 0, 0, 3, 2, 2))
        self.add('allowed', (2, 0, 0, 3, 2, 2))
        self.data = {'before': 'before', 'after': 'after',
                     'frame': {'space': 'assembly', 'component': 'root'},
                     'allowed': {'include': ['allowed']}}

    @staticmethod
    def require(value, label):
        if value is None or value is False:
            raise RuntimeError(label)
        return value

    @staticmethod
    def expression(value, unit, unitless=False):
        number, declared = value.split()
        if declared != unit:
            raise ValueError('dimensional mismatch')
        return value, float(number)

    def resolve(self, ref, kind=None):
        return self.entities[ref]

    def ref(self, entity):
        return next(key for key, value in self.entities.items() if value is entity)

    def add(self, name, *boxes, owner=None, occurrence=None):
        self.entities[name] = solids.Body(boxes, self.root if owner is None else owner, occurrence)
        return self.entities[name]

    def run_compare(self, data=None, operation='geometry.compare-region'):
        return self.ns['regional_geometry_fusion_handler'](self.ctx, self.data if data is None else data, operation)

    def test_allowed_change_and_no_live_mutations(self):
        saved = {k: copy.deepcopy(e.boxes) for k, e in self.entities.items() if isinstance(e, solids.Body)}
        result = self.run_compare()
        self.assertEqual(result['status'], 'pass', result)
        self.assertFalse(result['comparison']['equal'])
        self.assertEqual(result['delta']['added']['insideAllowed']['volume'], 4)
        self.assertEqual(result['delta']['added']['total']['bounds'], [[2, 0, 0], [3, 2, 2]])
        self.assertEqual(result['units'], {'length': 'cm', 'volume': 'cm^3'})
        self.assertEqual(result['precision'], 'pass')
        self.assertEqual(len(result['provenance']), 3)
        json.dumps(result, allow_nan=False)
        for name, boxes in saved.items():
            self.assertEqual(self.entities[name].boxes, boxes)
            self.assertFalse(self.entities[name].temporary)

    def test_same_volume_different_shapes_cannot_cancel(self):
        self.add('after', (1, 0, 0, 3, 2, 2))
        result = self.run_compare()
        self.assertEqual(result['status'], 'fail', result)
        self.assertEqual(result['delta']['removed']['outsideAllowed']['volume'], 4)
        self.assertEqual(result['delta']['added']['insideAllowed']['volume'], 4)
        self.assertFalse(result['controls']['outsideAllowedUnchanged'])

    def test_additional_external_edit_is_visible(self):
        self.add('after', (0, 0, 0, 3, 2, 2), (5, 5, 5, 6, 6, 6))
        result = self.run_compare()
        self.assertEqual(result['status'], 'fail', result)
        self.assertEqual(result['delta']['added']['outsideAllowed']['volume'], 1)
        self.assertEqual(result['delta']['added']['outsideAllowed']['bounds'], [[5, 5, 5], [6, 6, 6]])

    def test_overlapping_union_counts_once(self):
        self.add('mask-a', (2, 0, 0, 3, 1.5, 2))
        self.add('mask-b', (2, 0.5, 0, 3, 2, 2))
        self.data['allowed']['include'] = ['mask-a', 'mask-b']
        result = self.run_compare()
        self.assertEqual(result['status'], 'pass', result)
        self.assertEqual(result['delta']['added']['insideAllowed']['volume'], 4)
        self.assertIn('union', self.manager.calls)

    def test_real_hole_and_gap_not_filled(self):
        self.add('hole', (2, 0.5, 0.5, 3, 1.5, 1.5))
        self.data['allowed']['exclude'] = ['hole']
        result = self.run_compare()
        self.assertEqual(result['status'], 'fail', result)
        self.assertEqual(result['delta']['added']['outsideAllowed']['volume'], 1)
        self.assertEqual(result['delta']['added']['insideAllowed']['volume'], 3)
        self.add('sector-a', (2, 0, 0, 3, 0.5, 2))
        self.add('sector-b', (2, 1.5, 0, 3, 2, 2))
        self.data['allowed'] = {'include': ['sector-a', 'sector-b']}
        result = self.run_compare()
        self.assertEqual(result['status'], 'fail', result)
        self.assertEqual(result['delta']['added']['outsideAllowed']['volume'], 2)

    def test_protected_wins_over_allowed_overlap(self):
        self.data['protected'] = {'include': ['allowed']}
        result = self.run_compare()
        self.assertEqual(result['status'], 'fail', result)
        self.assertTrue(result['controls']['outsideAllowedUnchanged'])
        self.assertFalse(result['controls']['protectedUnchanged'])
        self.assertEqual(result['delta']['added']['insideProtected']['volume'], 4)

    def test_protected_union_with_hole(self):
        self.add('protected', (0, 0, 0, 4, 4, 4))
        self.data['protected'] = {'include': ['protected', 'protected'], 'exclude': ['allowed']}
        self.assertEqual(self.run_compare()['status'], 'pass')

    def test_empty_allowed_means_no_changes_and_delta_defaults_to_equality(self):
        self.data['allowed'] = {'include': []}
        self.assertEqual(self.run_compare()['status'], 'fail')
        del self.data['allowed']
        self.assertEqual(self.run_compare(operation='geometry.delta')['status'], 'fail')
        self.data['after'] = 'before'
        self.assertEqual(self.run_compare(operation='geometry.delta')['status'], 'pass')

    def test_boolean_failure_exception_invalid_are_unknown(self):
        for failure in ('false', 'raise', 'invalid'):
            with self.subTest(failure=failure):
                self.manager.failure = failure
                result = self.run_compare()
                self.assertEqual(result['status'], 'unknown', result)
                self.assertIsNone(result['passed'])
                self.assertIsNone(result['delta'])
                self.assertFalse(result['success'])

    def test_missing_stale_surface_and_incomplete_identity_unknown(self):
        for mutation in ('missing', 'invalid', 'surface', 'entity-token', 'revision'):
            with self.subTest(mutation=mutation):
                original = self.entities['after']
                if mutation == 'missing':
                    del self.entities['after']
                elif mutation == 'invalid':
                    original.isValid = False
                elif mutation == 'surface':
                    original.isSolid = False
                elif mutation == 'entity-token':
                    original.entityToken = None
                else:
                    original.revisionId = None
                self.assertEqual(self.run_compare()['status'], 'unknown')
                self.entities['after'] = original
                original.isValid, original.isSolid = True, True
                if mutation == 'entity-token':
                    original.entityToken = 'restored-entity-token'
                elif mutation == 'revision':
                    original.revisionId = 'revision-1'

    def test_stale_body_identity_and_document_drift_after_read(self):
        for drift in ('entity-token', 'revision', 'document'):
            port = self.ns['RegionalGeometryFusionPort'](self.ctx)
            original = port.compare
            def compare(*args):
                value = original(*args)
                if drift == 'entity-token':
                    self.entities['after'].entityToken += '-changed'
                elif drift == 'revision':
                    self.entities['after'].revisionId += '-changed'
                else:
                    self.doc.name += '-changed'
                return value
            port.compare = compare
            result = self.ns['regional_geometry_compare'](self.data, port)
            self.assertEqual(result['status'], 'unknown', result)
            self.assertEqual(result['reason'], 'stale')

    def test_budget_unknown_and_no_native_turn_after_exhaustion(self):
        self.data['operationBudget'] = 1
        result = self.run_compare()
        self.assertEqual(result['reason'], 'budget-exhausted')
        self.assertEqual(result['budget']['operationsUsed'], 1)
        self.assertEqual(self.manager.calls, [])
        self.assertIsNone(result['passed'])

    def test_indivisible_call_over_deadline_is_unknown(self):
        port = self.ns['RegionalGeometryFusionPort'](self.ctx)
        times = iter([0, 0, 20, 20])
        result = self.ns['regional_geometry_compare'](self.data, port, clock=lambda: next(times))
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['reason'], 'budget-exhausted')

    def test_explicit_instances_transform_copies_and_pin_provenance(self):
        transform = [1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        occurrence = SimpleNamespace(transform2=SimpleNamespace(asArray=lambda: transform))
        self.root.allOccurrences = [occurrence]
        source = self.add('mask-native', (0, 0, 0, 1, 2, 2), owner=self.child)
        proxy = self.add('mask-proxy', (0, 0, 0, 1, 2, 2), owner=self.child, occurrence=occurrence)
        proxy.nativeObject = source
        self.data['allowed']['include'] = ['mask-proxy']
        result = self.run_compare()
        self.assertEqual(result['status'], 'pass', result)
        self.assertEqual(result['provenance'][-1]['transform'][3], 2)
        self.assertEqual(source.boxes, [(0, 0, 0, 1, 2, 2)])
        self.data['allowed']['include'] = ['mask-native']
        self.assertEqual(self.run_compare()['status'], 'unknown')

    def test_occurrence_pose_drift_is_unknown(self):
        transform = [1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        occurrence = SimpleNamespace(transform2=SimpleNamespace(asArray=lambda: transform))
        self.root.allOccurrences = [occurrence]
        native = self.add('mask-native', (0, 0, 0, 1, 2, 2), owner=self.child)
        proxy = self.add('mask-proxy', (0, 0, 0, 1, 2, 2), owner=self.child, occurrence=occurrence)
        proxy.nativeObject = native
        self.data['allowed']['include'] = ['mask-proxy']
        port = self.ns['RegionalGeometryFusionPort'](self.ctx)
        describe = port.describe
        def drift(*args):
            result = describe(*args)
            transform[3] += 1
            return result
        port.describe = drift
        result = self.ns['regional_geometry_compare'](self.data, port)
        self.assertEqual(result['status'], 'unknown', result)
        self.assertEqual(result['reason'], 'stale')

    def test_units_and_points_samples_not_silently_accepted(self):
        for key, value in (('units', 'mm'), ('method', 'sampled'), ('samplingBudget', 10)):
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    self.run_compare(dict(self.data, **{key: value}))
        for descriptor in ({'type': 'box', 'min': [0, 0, 0], 'max': [1, 1, 1]},
                           {'points': [[0, 0, 0]]}, {'include': [[0, 0, 0]]}):
            with self.assertRaises(ValueError):
                self.run_compare(dict(self.data, allowed=descriptor))

    def test_nonfinite_measurement_unknown(self):
        port = self.ns['RegionalGeometryFusionPort'](self.ctx)
        port.describe = lambda body: {'volume': float('nan'), 'empty': True, 'bounds': None}
        result = self.ns['regional_geometry_compare'](self.data, port)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['reason'], 'invalid-measurement')

    def test_reference_retargeted_after_read_is_unknown(self):
        port = self.ns['RegionalGeometryFusionPort'](self.ctx)
        original = port.describe
        def retarget(*args):
            value = original(*args)
            self.entities['after'] = solids.Body([(0, 0, 0, 3, 2, 2)], self.root)
            return value
        port.describe = retarget
        result = self.ns['regional_geometry_compare'](self.data, port)
        self.assertEqual(result['status'], 'unknown', result)
        self.assertEqual(result['reason'], 'stale')

    def test_same_source_geometry_in_two_instances_not_conflated(self):
        def instance(x):
            matrix = [1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
            return SimpleNamespace(transform2=SimpleNamespace(asArray=lambda: matrix))
        first, second = instance(0), instance(1)
        self.root.allOccurrences = [first, second]
        native = self.add('native', (0, 0, 0, 2, 2, 2), owner=self.child)
        for name, occurrence in (('before', first), ('after', second)):
            proxy = self.add(name, *native.boxes, owner=self.child, occurrence=occurrence)
            proxy.nativeObject = native
        result = self.run_compare()
        self.assertEqual(result['status'], 'fail', result)
        self.assertEqual(result['delta']['added']['insideAllowed']['volume'], 4)
        self.assertEqual(result['delta']['removed']['outsideAllowed']['volume'], 4)
        self.assertEqual(result['comparison']['translationDelta']['value'], 1)

    def test_component_local_is_explicit_and_cannot_mix_root(self):
        self.data['frame'] = {'space': 'component local', 'component': 'child'}
        for key in ('before', 'after', 'allowed'):
            self.entities[key].parentComponent = self.child
        result = self.run_compare()
        self.assertEqual(result['status'], 'pass', result)
        self.entities['allowed'].parentComponent = self.root
        self.assertEqual(self.run_compare()['status'], 'unknown')

    def test_native_fixture_is_consent_gated_without_import_side_effects(self):
        scope = {}
        source = ROOT / 'tests/fixtures/regional-geometry-native.py'
        exec(compile(source.read_text(), str(source), 'exec'), scope)
        with self.assertRaisesRegex(RuntimeError, 'Explicit consent'):
            scope['qualify_regional_geometry']()

    def test_inconsistent_partition_or_empty_flag_cannot_pass(self):
        for failure in ('empty-flag', 'partition'):
            with self.subTest(failure=failure):
                port = self.ns['RegionalGeometryFusionPort'](self.ctx)
                original = port.describe
                calls = 0
                def describe(body):
                    nonlocal calls
                    calls += 1
                    result = original(body)
                    if failure == 'empty-flag':
                        result['empty'] = not result['empty']
                    elif calls == 6:
                        # Added.total is four cm³ but its claimed allowed
                        # partition is corrupt. Do not infer a covered set.
                        result.update(volume=5, empty=False)
                    return result
                port.describe = describe
                result = self.ns['regional_geometry_compare'](self.data, port)
                self.assertEqual(result['status'], 'unknown', result)
                self.assertIsNone(result['delta'])
                self.assertIsNone(result['passed'])

    def test_analytic_mm_and_cm_construct_same_normalized_solid(self):
        # Native source construction owns unit parsing. No regional scalar
        # override can reinterpret the dimensions of a resolved BRep body.
        def dimensions(values, factor):
            return tuple(value * factor for value in values)
        self.add('after', dimensions((0, 0, 0, 20, 20, 20), .1))
        result = self.run_compare()
        self.assertEqual(result['status'], 'pass', result)
        self.assertTrue(result['comparison']['equal'])
        self.assertEqual(result['delta']['added']['total']['volume'], 0)


if __name__ == '__main__':
    unittest.main()
