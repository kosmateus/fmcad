"""In-memory tests; no raster files, CAD, or cleanup operations."""

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

try:
    import numpy as np
    import scipy  # noqa: F401
    from shapely import hausdorff_distance
    from shapely.geometry import LineString, Polygon, box
    from shapely.ops import unary_union
    _HAVE_RASTER = True
except ImportError:
    _HAVE_RASTER = False


spec = importlib.util.spec_from_file_location(
    'image_shared_boundaries', Path(__file__).resolve().parents[1] / 'assets/image_shared_boundaries.py')
if _HAVE_RASTER:
    shared = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(shared)
else:
    shared = None


@unittest.skipUnless(_HAVE_RASTER, 'shared-boundary tests require numpy, SciPy and Shapely; use .venv/bin/python')
class SharedBoundariesTest(unittest.TestCase):
    def test_geometric_distance_not_chord_parameter_mismatch(self):
        # All points lie on one straight cubic, but have deliberately uneven
        # chord-parameter speed along it. Fixed handles are a valid fit.
        p = np.array([[0., 0.], [0.1, 0.], [1., 0.], [3., 0.], [10., 0.]])
        with patch.object(shared.np.linalg, 'lstsq', return_value=(np.array([1., 1.]),)):
            segments = shared._cubic_fit(p, np.array([1., 0.]), np.array([-1., 0.]), .01, 1)
        self.assertEqual(len(segments), 1)
        self.assertLess(shared._sampled_deviation(p, shared._sample(segments, .001)), 1e-10)

    def test_conflicts_exclude_unrelated_shell_and_allow_junction_endpoints(self):
        samples = [
            [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
            [[2, 2], [4, 4]], [[2, 4], [4, 2]],
            [[6, 6], [7, 7]], [[7, 7], [8, 6]],
            [[6, 2], [8, 4], [6, 4], [8, 2]],
        ]
        chains = [dict(regions=[1, i+2]) for i in range(len(samples))]
        self.assertEqual(shared._conflicting_chains(chains, samples, [1]), {1, 2, 5})

    def test_local_retry_keeps_unaffected_curve_controls(self):
        labels = np.zeros((40, 60), np.int32)
        labels[4:16, 4:16] = 1
        labels[24:36, 44:56] = 2
        original = shared.vectorize_shared(labels)
        target = next(c['id'] for c in original['chains'] if 2 in c['regions'])
        fit = shared._fit_chain
        calls = []
        def initially_bad(points, error, *args):
            calls.append(error)
            segments = fit(points, error, *args)
            if len(calls) == target + 1:
                segments[0][1][0][0] += 10
            return segments
        with patch.object(shared, '_fit_chain', side_effect=initially_bad):
            result = shared.vectorize_shared(labels)
        self.assertEqual(len(calls), len(original['chains'])+1)
        for chain, previous, tolerance in zip(result['chains'], original['chains'],
                                               result['diagnostics']['chain_tolerances_px']):
            self.assertEqual(tolerance, .175 if chain['id'] == target else .35)
            if chain['id'] != target:
                self.assertEqual(chain, previous)
        self.assert_partition(result, 60, 40)

    def test_indexed_sampled_metric_matches_geos(self):
        a = np.array([[0., 0.], [2., 0.], [3., 1.], [4., 0.]])
        b = np.array([[0., 0.1], [1., 0.2], [3., 0.8], [4., 0.]])
        self.assertAlmostEqual(shared._sampled_deviation(a, b),
                               hausdorff_distance(LineString(a), LineString(b), densify=0.25), places=12)

    def assert_partition(self, result, width, height):
        regions = {}
        for path in result['paths']:
            segments = path['segments']
            for a, b in zip(segments, segments[1:] + segments[:1]):
                self.assertEqual(a[1][-1], b[1][0])
            shell, holes = regions.setdefault(path['region'], ([], []))
            (holes if path['is_hole'] else shell).append(shared._sample(segments, 0.002))
        polygons = [Polygon(shells[0], holes) for shells, holes in regions.values()]
        self.assertTrue(all(p.is_valid for p in polygons))
        union = unary_union(polygons)
        self.assertAlmostEqual(sum(p.area for p in polygons), union.area, places=7)
        self.assertLess(union.symmetric_difference(box(0, 0, width, height)).area, 1e-8)

    def test_shared_controls_are_exactly_reversed(self):
        y, x = np.indices((80, 100))
        labels = np.where(x < 48 + 8 * np.sin(y / 15), 7, 23).astype(np.int32)
        result = shared.vectorize_shared(labels, scale=4)
        occurrences = {}
        for path in result['paths']:
            offset = 0
            for ref in path['chain_refs']:
                chain = result['chains'][ref['chain']]
                n = len(chain['segments'])
                actual = path['segments'][offset:offset + n]
                expected = shared._reverse(chain['segments']) if ref['reversed'] else chain['segments']
                self.assertEqual(actual, expected)
                occurrences.setdefault(ref['chain'], []).append(actual)
                offset += n
        internal = [c for c in result['chains'] if -1 not in c['regions']]
        self.assertEqual(result['sharedEdges'], len(internal))
        for chain in internal:
            a, b = occurrences[chain['id']]
            self.assertEqual(a, shared._reverse(b))
        self.assert_partition(result, 25, 20)

    def test_closed_holes_and_disconnected_same_label(self):
        labels = np.zeros((80, 100), dtype=np.int32)
        labels[8:72, 8:72] = 5
        labels[24:56, 24:56] = 0
        labels[15:30, 80:95] = 5
        result = shared.vectorize_shared(labels, scale=4)
        foreground = [p for p in result['paths'] if p['label'] == 5]
        self.assertEqual(sum(p['is_hole'] for p in foreground), 1)
        self.assertEqual(len({p['region'] for p in foreground}), 2)
        self.assert_partition(result, 25, 20)

    def test_circle_is_cubic_and_periodic(self):
        y, x = np.indices((160, 160))
        labels = (((x + 0.5 - 80) ** 2 + (y + 0.5 - 80) ** 2) < 55 ** 2).astype(np.int32)
        result = shared.vectorize_shared(labels, scale=4)
        path = next(p for p in result['paths'] if p['label'] == 1)
        self.assertTrue(all(kind == 'C' for kind, _ in path['segments']))
        self.assertLess(len(path['segments']), 40)
        first, last = np.array(path['segments'][0][1]), np.array(path['segments'][-1][1])
        np.testing.assert_allclose(shared._unit(first[1] - first[0]),
                                   shared._unit(last[-1] - last[-2]), atol=1e-10)
        self.assertLessEqual(result['diagnostics']['max_sampled_fit_deviation_px'],
                             result['diagnostics']['tolerance_used_px'] + 1e-10)
        self.assert_partition(result, 40, 40)

    def test_rectangle_corners_are_not_rounded(self):
        labels = np.zeros((64, 80), dtype=np.int32)
        labels[8:56, 12:68] = 1
        result = shared.vectorize_shared(labels, scale=4)
        segments = next(p['segments'] for p in result['paths'] if p['label'] == 1)
        self.assertEqual(len(segments), 4)
        self.assertTrue(all(s[0] == 'L' for s in segments))
        self.assertEqual({tuple(s[1][0]) for s in segments}, {(3., 2.), (17., 2.), (17., 14.), (3., 14.)})
        self.assert_partition(result, 20, 16)

    def test_subpixel_rectangle_remains_an_exact_rectangle(self):
        labels = np.zeros((5, 5), dtype=np.int32)
        labels[2, 2] = 1
        result = shared.vectorize_shared(labels, scale=4)
        segments = next(p['segments'] for p in result['paths'] if p['label'] == 1)
        self.assertEqual(len(segments), 4)
        self.assertTrue(all(kind == 'L' for kind, _ in segments))
        self.assertEqual({tuple(s[1][0]) for s in segments},
                         {(0.5, 0.5), (0.75, 0.5), (0.75, 0.75), (0.5, 0.75)})
        self.assert_partition(result, 1.25, 1.25)

    def test_three_color_junction(self):
        labels = np.ones((48, 64), dtype=np.int32)
        labels[:, 32:] = 2
        labels[24:, 32:] = 3
        result = shared.vectorize_shared(labels, scale=4)
        self.assertEqual(result['sharedEdges'], 3)
        self.assertEqual({p['label'] for p in result['paths']}, {1, 2, 3})
        self.assert_partition(result, 16, 12)

    def test_curved_three_color_junction_and_nested_hole(self):
        y, x = np.indices((160, 200))
        labels = np.where(x < 92 + 12 * np.sin(y / 30), 1, np.where(y < 80, 2, 3)).astype(np.int32)
        labels[(x - 38) ** 2 + (y - 75) ** 2 < 22 ** 2] = 0
        result = shared.vectorize_shared(labels, scale=4)
        self.assertTrue(any(kind == 'C' for p in result['paths'] for kind, _ in p['segments']))
        self.assertTrue(any(p['is_hole'] for p in result['paths']))
        self.assert_partition(result, 50, 40)

    def test_unit_scale_curve_does_not_fall_back_to_short_lines(self):
        y, x = np.indices((80, 80))
        labels = ((x + 0.5 - 40) ** 2 + (y + 0.5 - 40) ** 2 < 27 ** 2).astype(np.int32)
        result = shared.vectorize_shared(labels)
        segments = next(p['segments'] for p in result['paths'] if p['label'] == 1)
        self.assertTrue(all(kind == 'C' for kind, _ in segments))
        self.assert_partition(result, 80, 80)

    def test_retries_are_bounded_deterministic_and_pure(self):
        labels = np.ones((8, 12), dtype=np.int32)
        original = labels.copy()
        fit = shared._fit_chain
        tolerances = []

        def initially_bad(points, error, *args):
            tolerances.append(error)
            segments = fit(points, error, *args)
            if len(tolerances) == 1:
                segments[0][1][0][0] += 10
            return segments

        with patch.object(shared, '_fit_chain', side_effect=initially_bad):
            result = shared.vectorize_shared(labels)
        self.assertEqual(tolerances, [0.35, 0.175])
        self.assertEqual(result['diagnostics']['attempts'], 2)
        self.assertEqual(result['diagnostics']['tolerance_used_px'], 0.175)
        self.assert_partition(result, 12, 8)
        np.testing.assert_array_equal(labels, original)
        with patch.object(shared, '_fit_chain', side_effect=ValueError('forced invalid fit')) as mocked:
            with self.assertRaisesRegex(ValueError, 'after 3 attempts: forced invalid fit'):
                shared.vectorize_shared(labels)
            self.assertEqual([c.args[1] for c in mocked.call_args_list], [0.35, 0.175, 0.0875])
        np.testing.assert_array_equal(labels, original)
        self.assertEqual(shared.vectorize_shared(labels), shared.vectorize_shared(labels))

    def test_constant_and_single_cell(self):
        for labels in (np.zeros((1, 1), dtype=np.int8), np.full((8, 12), 42, dtype=np.uint32)):
            result = shared.vectorize_shared(labels)
            self.assertEqual(result['sharedEdges'], 0)
            self.assertEqual(len(result['paths']), 1)
            self.assert_partition(result, labels.shape[1], labels.shape[0])

    def test_pinches_fail_explicitly(self):
        for labels in (np.array([[1, 0], [0, 1]]),):
            with self.assertRaisesRegex(ValueError, 'touching|pinched'):
                shared.vectorize_shared(labels)

    def test_four_distinct_labels_meet_safely(self):
        labels = np.array([[1, 2], [3, 4]])
        self.assert_partition(shared.vectorize_shared(labels), 2, 2)

    def test_local_diagonal_repair_preserves_source(self):
        labels = np.ones((12, 12), dtype=np.int32)
        labels[3:6, 3:6] = 2
        labels[6:9, 6:9] = 2
        original = labels.copy()
        repaired, report = shared.repair_junctions(labels)
        self.assertEqual(len(report['changedPixels']), 1)
        np.testing.assert_array_equal(labels, original)
        self.assert_partition(shared.vectorize_shared(repaired, scale=2), 6, 6)

    def test_protected_fragments_join_only_with_same_source_provenance(self):
        labels = np.ones((6,6), np.int32)
        labels[2,2] = 2
        labels[3:5,3:5] = 2
        protected = labels == 2
        groups = np.where(labels == 2, 7, 1).astype(np.int32)
        with self.assertRaisesRegex(ValueError, 'Unresolved'):
            shared.repair_junctions(labels, protected=protected, allow_component_joins=False)
        repaired, report = shared.repair_junctions(labels, protected=protected,
            allow_component_joins=False, join_groups=groups)
        self.assertEqual(shared.ndimage.label(repaired == 2)[1], 1)
        np.testing.assert_array_equal(repaired[protected], labels[protected])
        self.assertEqual(report['removedNoiseCells'], 0)

    def test_invalid_labels_and_ranges(self):
        invalid = [[], np.ones((2, 2), dtype=float), np.ones((2, 2), dtype=bool),
                   np.ones(3, dtype=int), np.empty((0, 2), dtype=int), np.array([[-1]]),
                   np.array([[2 ** 31]], dtype=np.uint64), np.array([[1j]])]
        for labels in invalid:
            with self.subTest(labels=str(labels)), self.assertRaises(ValueError):
                shared.vectorize_shared(labels)
        oversized = np.broadcast_to(np.array(0, dtype=np.uint8), (8001, 8000))
        with self.assertRaisesRegex(ValueError, '64 million'):
            shared.vectorize_shared(oversized)
        for kwargs in [dict(scale=0), dict(scale=float('inf')), dict(scale=True),
                       dict(scale=10 ** 1000), dict(scale=None), dict(scale='4'),
                       dict(fit_error_px=-1), dict(fit_error_px=float('nan')),
                       dict(corner_angle=180), dict(corner_angle=0), dict(scale=1j)]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                shared.vectorize_shared(np.zeros((2, 2), dtype=int), **kwargs)


if __name__ == '__main__':
    unittest.main()
