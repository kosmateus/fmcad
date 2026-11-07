"""Offline contract/numerical doubles only. NOT native Fusion qualification."""
import math
from pathlib import Path
from types import SimpleNamespace as Obj
import unittest

ROOT = Path(__file__).parents[1]
NS = {'math': math, 'CAD_HANDLERS': {}}
for path in ('domain/values.py', 'domain/geometry_curve.py', 'adapters/fusion/geometry_curve.py',
             'application/sketch_geometry_proof.py', 'adapters/fusion/sketch_geometry_proof.py'):
    exec(compile((ROOT / 'runtime/python/fmcad' / path).read_text(), path, 'exec'), NS)


class Point:
    def __init__(self, x, y, z=0):
        self.x, self.y, self.z = x, y, z

    def copy(self):
        return Point(self.x, self.y, self.z)

    def transformBy(self, transform):
        self.x += transform[0]
        self.y += transform[1]
        self.z += transform[2]
        return True

    @staticmethod
    def create(x, y, z):
        return Point(x, y, z)


class SketchPoint:
    def __init__(self, parent_sketch, geometry, world_geometry=None):
        self.parentSketch = parent_sketch
        self.geometry = geometry
        if world_geometry is not None:
            self.worldGeometry = world_geometry

    def createForAssemblyContext(self, occurrence):
        return self.proxy


class SketchCurve:
    def __init__(self, parent_sketch, geometry, world_geometry=None, construction=False):
        self.parentSketch = parent_sketch
        self.geometry = geometry
        self.isConstruction = construction
        if world_geometry is not None:
            self.worldGeometry = world_geometry

    def createForAssemblyContext(self, occurrence):
        return self.proxy


def shifted(point, delta):
    result = point.copy()
    result.transformBy(delta)
    return result


class LineEvaluator:
    def __init__(self, a, b):
        self.a, self.b = a, b

    def getParameterExtents(self):
        return True, 0, 1

    def getStrokes(self, start, end, tolerance):
        return True, [Point(*self.a), Point(*self.b)]

    def getCurvature(self, t):
        return True, Point(0, 0), 0

    def getFirstDerivative(self, t):
        return True, Point(*(b-a for a, b in zip(self.a, self.b)))


def rectangle(x=0, size=2, gap=0, y=0, parent_sketch=None):
    points = [[x, y, 0], [x+size, y, 0], [x+size, y+size, 0], [x, y+size, 0], [x, y+gap, 0]]
    return [SketchCurve(parent_sketch, Obj(evaluator=LineEvaluator(a, b)))
            for a, b in zip(points, points[1:])]


def profile(curves, area=4, centroid=None, hole=None):
    def profile_curves(lines):
        return [Obj(geometry=curve.geometry, reference='profile-curve') for curve in lines]
    loops = [Obj(isOuter=True, profileCurves=profile_curves(curves))]
    if hole:
        loops.append(Obj(isOuter=False, profileCurves=profile_curves(hole)))
    return Obj(profileLoops=loops, areaProperties=lambda accuracy: Obj(area=area, centroid=centroid or Point(1, 1)))


class Context:
    def __init__(self, sketch, entities=None):
        self.sketch = sketch
        self.entities = entities or {}
        self.doc = Obj(creationId='offline', name='double')
        self.component = sketch.parentComponent
        self.root = self.component

    def assert_identity(self):
        pass

    def resolve(self, ref, kind=None):
        return self.sketch if ref == 'sketch' else self.entities[ref]

    def ref(self, entity):
        return 'sketch' if entity is self.sketch else 'curve-' + str(id(entity))

    def length(self, expression):
        value, unit = expression.split(' ', 1)
        return float(value) / (10 if unit == 'mm' else 1)

    def point(self, values):
        return Point(*(self.length(v) for v in values))


def cad_require(result, operation):
    if result is None:
        raise ValueError(operation + ' failed')
    return result


NS.update(adsk=Obj(core=Obj(Base=object, Point3D=Point), fusion=Obj(
              SketchPoint=SketchPoint, SketchCurve=SketchCurve, BRepEdge=type('BRepEdge', (), {}),
              BRepFace=type('BRepFace', (), {}), BRepVertex=type('BRepVertex', (), {}),
              FeatureHealthStates=Obj(HealthyFeatureHealthState=0),
              CalculationAccuracy=Obj(HighCalculationAccuracy=2))),
          _cad_items=lambda value: list(value), _sketch_target=lambda ctx, ref: ctx.resolve(ref),
          _cad_require_result=cad_require,
          _sketch_identity=lambda ctx: {'creationId': ctx.doc.creationId})


class SketchProof(unittest.TestCase):
    def sketch(self, curves=None, profiles=None):
        sketch = Obj(healthState=0, parentComponent=Obj(name='component'), sketchCurves=[], profiles=profiles or [],
                   sketchToModelSpace=lambda p: shifted(p, [10, 20, 30]),
                   modelToSketchSpace=lambda p: shifted(p, [-10, -20, -30]))
        sketch.sketchCurves = curves or []
        return sketch

    def query(self, sketch, **extra):
        return NS['sketch_profile_query'](Context(sketch), {'schemaVersion': 1, 'sketch': 'sketch', **extra})

    def coordinate(self, center=Point(0, 0), radius=1, **extra):
        sketch = self.sketch()
        entity = SketchCurve(sketch, Obj(center=center, radius=radius),
                             Obj(center=shifted(center, [10, 20, 30]), radius=radius))
        return NS['sketch_coordinate_check'](Context(sketch, {'arc': entity}),
            {'schemaVersion': 1, 'sketch': 'sketch', 'expectations': [
                {'entity': 'arc', 'center': ['0 cm', '0 cm', '0 cm'], 'diameter': '2 cm'}], **extra})

    def test_health_is_not_geometry_shifted_center_or_bad_diameter(self):
        for result in (self.coordinate(center=Point(1, 0)), self.coordinate(radius=2)):
            self.assertEqual(result['healthStatus'], 'pass')
            self.assertEqual(result['geometryStatus'], 'fail')
            self.assertFalse(result['success'])
        self.assertEqual(self.coordinate()['geometryStatus'], 'pass')

    def test_point_roundtrip_and_native_world_geometry_are_independent(self):
        sketch = self.sketch()
        entity = SketchPoint(sketch, Point(1, 2), Point(999, 22, 30))
        result = NS['sketch_coordinate_check'](Context(sketch, {'point': entity}),
            {'schemaVersion': 1, 'sketch': 'sketch', 'expectations': [
                {'entity': 'point', 'point': ['1 cm', '2 cm', '0 cm']}]})
        self.assertEqual(result['geometryStatus'], 'fail')
        checks = result['analytic']['entities'][0]['checks']
        self.assertEqual([c['status'] for c in checks], ['pass', 'pass', 'fail'])

    def test_missing_world_geometry_is_unknown_not_pass(self):
        sketch = self.sketch()
        entity = SketchPoint(sketch, Point(0, 0))
        result = NS['sketch_coordinate_check'](Context(sketch, {'point': entity}),
            {'schemaVersion': 1, 'sketch': 'sketch', 'expectations': [{'entity': 'point', 'point': ['0 cm']*3}]})
        self.assertEqual(result['geometryStatus'], 'unknown')

    def test_explicit_curve_endpoint_checks_use_native_sketch_points(self):
        sketch = self.sketch()
        start = SketchPoint(sketch, Point(1, 2), Point(11, 22, 30))
        end = SketchPoint(sketch, Point(3, 4), Point(13, 24, 30))
        entity = SketchCurve(sketch, Obj(evaluator=LineEvaluator([1, 2, 0], [3, 4, 0])),
                             Obj(startPoint=end.worldGeometry, endPoint=end.worldGeometry))
        entity.startSketchPoint = start
        entity.endSketchPoint = end
        result = NS['sketch_coordinate_check'](Context(sketch, {'line': entity}), {
            'schemaVersion': 1, 'sketch': 'sketch', 'expectations': [
                {'entity': 'line', 'frame': 'model', 'start': ['11 cm', '22 cm', '30 cm']},
                {'entity': 'line', 'frame': 'world', 'end': ['13 cm', '24 cm', '30 cm']},
            ]})
        self.assertEqual(result['geometryStatus'], 'pass')

    def test_single_profile_area_centroid_counts_and_containment(self):
        curves = rectangle()
        result = self.query(self.sketch(curves, [profile(curves)]),
            query={'area': 4.0, 'centroid': ['1 cm', '1 cm', '0 cm'], 'contains': ['1 cm', '1 cm', '0 cm']},
            expected={'profiles': 1, 'loops': 1, 'outerLoops': 1, 'innerLoops': 0})
        self.assertEqual(result['geometryStatus'], 'pass')
        self.assertEqual(result['profile']['index'], 0)
        self.assertEqual(result['affected'], [])
        self.assertEqual(result['sampled']['method'], 'sampled')
        self.assertEqual(result['evidenceStatus'], 'partial')
        self.assertEqual(result['precision'], 'sampled')

    def test_microgap_and_duplicate_edge_fail_with_healthy_sketch(self):
        for curves in (rectangle(gap=.0002), rectangle()+rectangle()[:1]):
            result = self.query(self.sketch(curves, [profile(rectangle())]))
            self.assertEqual(result['healthStatus'], 'pass')
            self.assertEqual(result['geometryStatus'], 'fail')
            self.assertIsNone(result['profile'])

    def test_hole_containment_and_loop_counts(self):
        sketch = self.sketch()
        outer, hole = rectangle(size=4, parent_sketch=sketch), rectangle(x=1, y=1, size=1, parent_sketch=sketch)
        sketch = self.sketch(outer+hole, [profile(outer, area=15, hole=hole)])
        result = self.query(sketch, query={'contains': ['2 cm', '3 cm', '0 cm'], 'innerLoops': 1}, expected={'loops': 2})
        self.assertEqual(result['geometryStatus'], 'pass')
        result = self.query(sketch, query={'contains': ['1.5 cm', '1.5 cm', '0 cm']})
        self.assertEqual(result['selection']['reason'], 'noMatch')
        self.assertIsNone(result['profile'])

    def test_multiple_profiles_require_unique_query_never_fallback(self):
        a, b = rectangle(), rectangle(x=5, size=3)
        sketch = self.sketch(a+b, [profile(a), profile(b, area=9, centroid=Point(6.5, 1.5))])
        result = self.query(sketch)
        self.assertEqual(result['selection']['reason'], 'ambiguous')
        self.assertIsNone(result['profile'])
        self.assertEqual(self.query(sketch, query={'area': 9.0})['profile']['index'], 1)
        self.assertEqual(self.query(sketch, query={'index': 0})['profile']['index'], 0)
        self.assertIsNone(self.query(sketch, query={'area': 99.0})['profile'])

    def test_missing_topology_and_unknown_candidate_block_selection(self):
        a = rectangle()
        incomplete = Obj(areaProperties=lambda accuracy: Obj(area=4, centroid=Point(1, 1)))
        sketch = self.sketch(a, [profile(a), incomplete])
        result = self.query(sketch, query={'area': 4.0})
        self.assertEqual(result['selection']['reason'], 'incompleteEvidence')
        self.assertIsNone(result['profile'])
        self.assertEqual(result['geometryStatus'], 'unknown')

    def test_boundary_band_is_unknown(self):
        a = rectangle()
        self.assertEqual(self.query(self.sketch(a, [profile(a)]), query={'contains': ['0 cm', '1 cm', '0 cm']})['geometryStatus'], 'unknown')

    def test_native_circle_seam_parity_preserves_annular_material_and_inputs(self):
        import copy
        import json
        fixture = json.loads((ROOT / 'tests/fixtures/sketch-native-seam.json').read_text())
        loops = fixture['loops']
        original = copy.deepcopy(loops)
        contains = NS['proof_contains']
        self.assertEqual(contains(fixture['point'], loops, fixture['tolerance']), 'inside')
        self.assertEqual(contains([0.2, 0, 0], loops, fixture['tolerance']), 'outside')
        self.assertEqual(contains([1.2, 0, 0], loops, fixture['tolerance']), 'outside')
        self.assertEqual(contains([1, 0, 0], loops, fixture['tolerance']), 'unknown')
        self.assertEqual(loops, original)

    def test_open_or_ambiguous_sampled_seams_are_not_silently_closed(self):
        contains = NS['proof_contains']
        open_loop = [[[[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]]]
        self.assertEqual(contains([0.5, 0.5, 0], open_loop, 0.0001), 'unknown')
        ambiguous = [[[[0, 0, 0], [1, 0, 0], [0, 0, 0]], [[0, 0, 0], [0, 1, 0], [0, 0, 0]]]]
        self.assertEqual(contains([0.2, 0.2, 0], ambiguous, 0.0001), 'unknown')

    def test_expected_profile_count_mismatch(self):
        a = rectangle()
        self.assertIsNone(self.query(self.sketch(a, [profile(a)]), expected={'profiles': 2})['profile'])

    def test_global_sample_budget_is_enforced(self):
        a = rectangle()
        with self.assertRaisesRegex(ValueError, 'maxSamples'):
            self.query(self.sketch(a, [profile(a)]), maxSamples=10)

    def test_invalid_query_and_dimensions(self):
        for query in ({'index': True}, {'innerLoops': -1}, {'unknown': 1}):
            with self.assertRaises(ValueError):
                self.query(self.sketch(), query=query)
        with self.assertRaises(ValueError):
            self.coordinate(radius=float('nan'))

    def test_registration_is_explicit(self):
        registry = {}
        NS['register_sketch_geometry_proof'](registry)
        self.assertEqual(set(registry), {'sketch.coordinate-check', 'sketch.profile-query'})
        independent = {}
        values = ROOT / 'runtime/python/fmcad/domain/values.py'
        exec(compile(values.read_text(), str(values), 'exec'), independent)
        independent['CAD_HANDLERS'] = {}
        source = ROOT / 'runtime/python/fmcad/application/sketch_geometry_proof.py'
        exec(compile(source.read_text(), str(source), 'exec'), independent)
        self.assertEqual(independent['proof_status'](['pass', 'unknown']), 'unknown')
        self.assertNotIn('adsk', independent)

    def test_explicit_occurrence_and_nonroot_refusal(self):
        sketch = self.sketch()
        occurrence = Obj(component=sketch.parentComponent, transform2=[100, 200, 300])
        entity = SketchPoint(sketch, Point(1, 2), Point(111, 222, 330))
        entity.proxy = entity
        ctx = Context(sketch, {'point': entity, 'occ': occurrence})
        ctx.root = Obj(name='root')
        data = {'schemaVersion': 1, 'sketch': 'sketch', 'expectations': [
                {'entity': 'point', 'frame': 'world', 'point': ['111 cm', '222 cm', '330 cm']}]}
        with self.assertRaisesRegex(ValueError, 'explicit occurrence'):
            NS['sketch_coordinate_check'](ctx, data)
        result = NS['sketch_coordinate_check'](ctx, {**data, 'occurrence': 'occ'})
        self.assertEqual(result['geometryStatus'], 'pass')

    def test_feature_brep_body_membership_and_dimensions(self):
        sketch = self.sketch()
        body = Obj(parentComponent=sketch.parentComponent)
        point = SketchPoint(sketch, Point(0, 0), Point(10, 20, 30))
        class BRepEdge(NS['adsk'].fusion.BRepEdge):
            def __init__(self):
                self.body = body
                self.geometry = Obj(center=Point(10, 20, 30), radius=1)
        edge = BRepEdge()
        feature = Obj(bodies=[body])
        ctx = Context(sketch, {'point': point, 'edge': edge, 'feature': feature})
        data = {'schemaVersion': 1, 'sketch': 'sketch', 'expectations': [{'entity': 'point', 'point': ['0 cm']*3}],
                'featureBRep': {'feature': 'feature', 'expectations': [
                    {'entity': 'edge', 'center': ['10 cm', '20 cm', '30 cm'], 'diameter': '2 cm'}]}}
        result = NS['sketch_coordinate_check'](ctx, data)
        self.assertEqual(result['geometryStatus'], 'pass')
        feature.bodies = []
        self.assertEqual(NS['sketch_coordinate_check'](ctx, data)['geometryStatus'], 'fail')

    def test_branch_degeneracy_and_zero_area(self):
        for extra in (SketchCurve(None, Obj(evaluator=LineEvaluator([2, 0, 0], [3, -1, 0]))),
                      SketchCurve(None, Obj(evaluator=LineEvaluator([0, 0, 0], [0, 0, 0])))):
            a = rectangle()
            self.assertEqual(self.query(self.sketch(a+[extra], [profile(a)]))['geometryStatus'], 'fail')
        a = rectangle()
        self.assertEqual(self.query(self.sketch(a, [profile(a, area=0)]))['geometryStatus'], 'fail')

    def test_qualifier_is_opt_in_and_forbids_mutation_operations(self):
        native = {}
        path = ROOT / 'tests/fixtures/sketch-geometry-proof/native_qualification.py'
        exec(compile(path.read_text(), str(path), 'exec'), native)
        with self.assertRaisesRegex(ValueError, 'authorization'):
            native['qualify'](None, {}, lambda _: {})
        cases = {name: {'operation': 'sketch.geometry'} for name in native['REQUIRED_CASES']}
        with self.assertRaisesRegex(ValueError, 'read-only'):
            native['qualify'](None, cases, lambda _: {}, authorize_live=True)
        cases = {name: {'operation': 'sketch.coordinate-check', 'data': {'case': name},
                        'expected': {'healthStatus': 'pass', 'geometryStatus': status}}
                 for name, status in native['REQUIRED_CASES'].items()}
        state = {key: None for key in native['FINGERPRINT_FIELDS']}
        ctx = Obj(assert_identity=lambda: None,
                  doc=Obj(creationId='offline-fixture-double', name='not a native qualification'))
        def call(operation, data):
            state['geometry'] = 'unexpected-change'
            return cases[data['case']]['expected']
        ctx.call = call
        with self.assertRaisesRegex(RuntimeError, 'changed document'):
            native['qualify'](ctx, cases, lambda _: dict(state), authorize_live=True)


if __name__ == '__main__':
    unittest.main()
