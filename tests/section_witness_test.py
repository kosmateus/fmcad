"""Offline contract tests; SDK doubles do not qualify native geometry."""
import copy
import json
import math
from pathlib import Path
from types import SimpleNamespace as NS
import unittest

ROOT = Path(__file__).resolve().parents[1]
SHAPES = json.loads((ROOT / 'tests/fixtures/section_witness_shapes.json').read_text())


class Body:
    isSolid = True
    isValid = True
    nativeObject = None
    assemblyContext = None
    def __init__(self, volume=None):
        ring = SHAPES['ring']
        self.volume = volume if volume is not None else math.pi * (ring['outerRadius'] ** 2 - ring['innerRadius'] ** 2) * ring['height']


class Manager:
    residual = 0.0
    failure = False

    def copy(self, body):
        return copy.copy(body)

    def booleanOperation(self, target, tool, operation):
        target.volume = self.residual
        return not self.failure


class Context:
    def __init__(self):
        ring = SHAPES['ring']
        self.bodies = {'ring': Body(), 'witness': Body(),
                       'void': Body(math.pi * ring['voidRadius'] ** 2 * ring['height'])}

    def resolve(self, ref, kind):
        return self.bodies[ref]

    def length(self, value):
        return float(value)

    def _expression(self, value, unit):
        return value, float(value.split()[0])

    def point(self, point):
        return NS(x=point[0], y=point[1], z=point[2])


def load():
    manager = Manager()
    frame = {'space': 'assembly', 'component': 'root'}

    def fields(data, required=(), optional=()):
        if set(required) - set(data) or set(data) - set(required) - set(optional):
            raise ValueError('Invalid fields')

    def validate_frame(ctx, declared, actual):
        if declared != actual:
            raise ValueError('Frame mismatch')

    ns = {'adsk': NS(fusion=NS(TemporaryBRepManager=NS(get=lambda: manager),
                              BooleanTypes=NS(DifferenceBooleanType='difference', IntersectionBooleanType='intersection')),
                     core=NS(Point3D=NS(create=lambda *v: v), Vector3D=NS(create=lambda *v: v),
                             Plane=NS(create=lambda p, n: (p, n)))),
          '_cad_fields': fields, '_measure_space': lambda ctx, entities: frame,
          '_measure_frame_context': validate_frame,
          '_cad_xyz': lambda p: [p.x, p.y, p.z], '_cad_direction': lambda v: v,
          '_cad_items': list, '_cad_type': lambda g: g.type,
          '_cad_geometry': lambda g: {'type': g.type}}
    for layer in ('domain', 'adapters/fusion', 'application'):
        path = ROOT / 'runtime/python/fmcad' / layer / 'section_witness.py'
        exec(compile(path.read_text(), str(path), 'exec'), ns)
    return ns, manager, frame


class SectionWitnessTests(unittest.TestCase):
    def setUp(self):
        self.ns, self.manager, self.frame = load()
        self.ctx = Context()
        self.request = dict(body='ring', witness='witness', frame=self.frame,
                            expect='material', volumeTolerance='0 cm^3')

    def witness(self):
        return self.ns['_measure_witness_check'](self.ctx, self.request)

    def test_finite_good_ring_and_void(self):
        for expect in ('material', 'void'):
            self.request['expect'] = expect
            self.request['witness'] = 'witness' if expect == 'material' else 'void'
            original_volume = self.ctx.bodies[self.request['witness']].volume
            result = self.witness()
            self.assertEqual(result['status'], 'pass')
            self.assertFalse(result['precisionDetail']['exact'])
            self.assertFalse(result['coverageDetail']['sampled'])
            self.assertEqual(self.ctx.bodies[self.request['witness']].volume, original_volume)

    def test_missing_sector_and_gap_between_sample_points(self):
        # Shared dimensions, but computed residuals here are a test oracle, not
        # a substitute for native ring Boolean qualification.
        gap = SHAPES['gapBetweenPoints']
        wedge = SHAPES['missingSector']
        sector_guard = math.prod(high - low for low, high in zip(wedge['min'], wedge['max']))
        gap_volume = math.prod(high - low for low, high in zip(gap['min'], gap['max']))
        residuals = [sector_guard, gap_volume]
        for residual in residuals:
            self.manager.residual = residual
            self.assertEqual(self.witness()['status'], 'fail')

    def test_kernel_failure_and_invalid_result_are_unknown(self):
        self.manager.failure = True
        failed = self.witness()
        self.assertEqual(failed['status'], 'unknown')
        self.assertIsNone(failed['passed'])
        self.manager.failure = False
        self.ctx.bodies['witness'].isValid = False
        with self.assertRaisesRegex(RuntimeError, 'copy'):
            self.witness()

    def test_frame_and_solid_validation(self):
        self.request['frame'] = {'space': 'component local', 'component': 'child'}
        with self.assertRaisesRegex(ValueError, 'Frame'):
            self.witness()
        self.request['frame'] = self.frame
        self.ctx.bodies['ring'].isSolid = False
        with self.assertRaisesRegex(ValueError, 'solid'):
            self.witness()

    def test_sampling_fields_rejected(self):
        self.request['points'] = SHAPES['samplePoints']
        with self.assertRaises(ValueError):
            self.witness()

    def test_station_none_open_and_kernel_failure(self):
        request = dict(body='ring', frame=self.frame, origin=[0, 0, 0], normal=[0, 0, 1],
                       stations=SHAPES['stations'])
        for mode in ('none', 'open', 'failure'):
            def intersect(*args):
                if mode == 'failure':
                    raise RuntimeError('kernel failure')
                return None if mode == 'none' else NS(isValid=True, edges=[1])
            self.manager.planeIntersection = intersect
            self.manager.createFaceFromPlanarWires = lambda wires: None
            result = self.ns['_measure_section_series'](self.ctx, request)
            self.assertEqual(result['status'], 'unknown')
            self.assertEqual(result['coverageDetail']['complete'], 0)
            self.assertEqual(result['coverage'], 'unknown')
            self.assertTrue(all(row['area'] is None for row in result['stations']))

    def test_closed_outer_inner_loops(self):
        outer = NS(geometry=NS(type='Circle3D', radius=SHAPES['ring']['outerRadius']))
        inner = NS(geometry=NS(type='Circle3D', radius=SHAPES['ring']['innerRadius']))
        loops = [NS(isOuter=True, edges=[outer]), NS(isOuter=False, edges=[inner])]
        wire = NS(isValid=True, edges=[outer, inner])
        self.manager.planeIntersection = lambda *args: wire
        self.manager.createWireFromCurves = lambda curves: (curves, [])
        def face(wires):
            if wires[0] is wire:
                ring = SHAPES['ring']
                area = math.pi * (ring['outerRadius'] ** 2 - ring['innerRadius'] ** 2)
                return NS(isValid=True, area=area, faces=[NS(loops=loops)])
            return NS(isValid=True, area=math.pi * wires[0][0].radius ** 2)
        self.manager.createFaceFromPlanarWires = face
        result = self.ns['_measure_section_series'](self.ctx, dict(body='ring', frame=self.frame,
                 origin=[0, 0, 0], normal=[0, 0, 1], stations=[1]))
        self.assertEqual(result['status'], 'complete')
        self.assertEqual([loop['role'] for loop in result['stations'][0]['loops']], ['outer', 'inner'])
        self.assertEqual([loop['diameter'] for loop in result['stations'][0]['loops']],
                         [2 * SHAPES['ring']['outerRadius'], 2 * SHAPES['ring']['innerRadius']])
        self.assertEqual(result['coverage'], 'partial')
        self.assertFalse(result['coverageDetail']['continuous'])

    def test_budgets_and_nonfinite(self):
        self.request['limits'] = {'kernelCalls': 2}
        self.assertEqual(self.witness()['status'], 'unknown')
        self.request['limits'] = {'bytes': 1}
        with self.assertRaisesRegex(ValueError, 'byte'):
            self.witness()
        self.request.pop('limits')
        for residual in (-1, math.nan, math.inf):
            self.manager.residual = residual
            result = self.witness()
            self.assertEqual(result['status'], 'unknown')
            self.assertIsNone(result['passed'])

    def test_station_and_edge_limits(self):
        request = dict(body='ring', frame=self.frame, origin=[0, 0, 0], normal=[0, 0, 1],
                       stations=[0, 1], limits={'stations': 1})
        with self.assertRaisesRegex(ValueError, 'station'):
            self.ns['_measure_section_series'](self.ctx, request)
        request.update(stations=[1], limits={'edges': 1})
        self.manager.planeIntersection = lambda *args: NS(isValid=True, edges=[1, 2])
        result = self.ns['_measure_section_series'](self.ctx, request)
        self.assertEqual(result['status'], 'unknown')
        self.assertIn('edge limit', result['stations'][0]['reason'])

    def test_failed_boolean_invalidates_result(self):
        def boolean(target, tool, operation):
            target.isValid = False
            return True
        self.manager.booleanOperation = boolean
        self.assertEqual(self.witness()['status'], 'unknown')


class ExistingMeasurementFrameTests(unittest.TestCase):
    """Exercise the retained real measurement frame helpers, not replacements."""

    def test_real_measurement_context_and_proxy_copy(self):
        import measure_test as retained
        fixture = retained.MeasureTests()
        fixture.setUp()
        ns = dict(retained.NS)
        for layer in ('domain', 'adapters/fusion', 'application'):
            path = ROOT / 'runtime/python/fmcad' / layer / 'section_witness.py'
            exec(compile(path.read_text(), str(path), 'exec'), ns)
        frame = ns['_measure_space'](fixture.ctx, [fixture.body])
        budget = ns['_SectionWitnessBudget']({})
        # Existing fixture bodies predate isValid readback; native bodies have it.
        fixture.body.isValid = True
        original_copy = retained.MANAGER.copy
        def valid_copy(body):
            result = original_copy(body)
            result.isValid = True
            return result
        retained.MANAGER.copy = valid_copy
        actual, bodies = ns['_section_witness_operands'](fixture.ctx,
                            [fixture.ctx.ref(fixture.body)], frame, budget)
        self.assertEqual(frame, actual)
        self.assertIsNot(bodies[0], fixture.body)
        self.assertEqual(budget.calls, 1)
        with self.assertRaises(ValueError):
            ns['_section_witness_operands'](fixture.ctx, [fixture.ctx.ref(fixture.body)],
                                            'component local', ns['_SectionWitnessBudget']({}))


class NativeRunnerSafetyTests(unittest.TestCase):
    def test_native_runner_uses_existing_pinned_scratch_and_never_restores_global_document(self):
        path = ROOT / 'tests/native/section_witness_qualification.py'
        source = path.read_text()
        compile(source, str(path), 'exec')
        self.assertIn("FMCAD.doc", source)
        self.assertIn("creationId", source)
        self.assertIn("close --discard", source)
        self.assertNotIn('app.activeDocument', source)
        self.assertNotIn('app.documents.add', source)
        self.assertNotIn('doc.close(', source)
        self.assertNotIn('previous.activate', source)

    def test_native_fixture_distinguishes_closed_c_boundary_from_real_open_wire(self):
        source = (ROOT / 'tests/native/section_witness_qualification.py').read_text()
        self.assertIn("closed-c-section-missing-sector", source)
        self.assertIn("native-open-wire-kernel-error", source)
        self.assertIn("createWireFromCurves(curves)", source)
        self.assertIn("createFaceFromPlanarWires([open_wire])", source)
        self.assertIn("tangent-degenerate-kernel-result", source)
        self.assertIn("faceBuilderReturnedInvalidBody", source)
        self.assertIn("QUALIFIED_FUSION_VERSION = '2706.1.14'", source)
        self.assertIn('def expect_status(name, result, expected):', source)
        self.assertIn("report['assertionFailures'] = failures", source)
        self.assertIn("report['unresolvedAssertions'] = unknowns", source)
        self.assertIn("sector_witness_plane = shape('datum.plane'", source)
        self.assertIn("sector_witness = extruded_box('sector_witness', sector_witness_bounds, sector_witness_plane)", source)
        self.assertNotIn("FMCAD.call('measure.contains'", source)

        ring = SHAPES['ring']
        sector = SHAPES['missingSector']
        witness = SHAPES['sectorWitness']
        for index in range(3):
            self.assertGreaterEqual(witness['min'][index], sector['min'][index])
            self.assertLessEqual(witness['max'][index], sector['max'][index])
        self.assertGreater(witness['min'][0] ** 2 + witness['min'][1] ** 2,
                           ring['innerRadius'] ** 2)
        self.assertLess(witness['max'][0] ** 2 + witness['max'][1] ** 2,
                        ring['outerRadius'] ** 2)
        self.assertGreater(witness['min'][2], 0)
        self.assertLess(witness['max'][2], ring['height'])

        gap = SHAPES['gapBetweenPoints']
        self.assertTrue(all(value < gap['min'][2] or value > gap['max'][2]
                            for value in SHAPES['stations']))
        self.assertGreater(math.prod(high - low for low, high in zip(gap['min'], gap['max'])), 0)


if __name__ == '__main__':
    unittest.main()
