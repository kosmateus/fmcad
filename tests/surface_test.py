"""Offline API-shape and evaluator evidence tests for GM08 surface commands, not native kernel acceptance."""
import math
import pathlib
import sys
import types
import unittest
from python_test_support import load_legacy_core


ROOT = pathlib.Path(__file__).resolve().parents[1]
TRACE = []


class Collection:
    def __init__(self, values=()):
        self.values = list(values)

    @property
    def count(self):
        return len(self.values)

    def item(self, index):
        return self.values[index]

    def __iter__(self):
        return iter(self.values)


class Point:
    def __init__(self, x, y, z):
        self.x, self.y, self.z = x, y, z

    @staticmethod
    def create(x, y, z):
        return Point(x, y, z)


class Vector:
    def __init__(self, x, y, z):
        self.x, self.y, self.z = x, y, z


class ValueInput(tuple):
    @staticmethod
    def createByString(expression):
        assert isinstance(expression, str)
        return ValueInput(('expression', expression))

    @staticmethod
    def createByReal(value):
        return ValueInput(('number', value))


class Entity:
    serial = 0

    def __init__(self, kind='BRepBody', name=None, component=None):
        Entity.serial += 1
        self.objectType = 'adsk::fusion::' + kind
        self.entityToken = str(Entity.serial)
        self.name = name or self.entityToken
        self.assemblyContext = None
        self.parentComponent = component
        self.healthState = 0
        self.errorOrWarningMessage = ''


class Body(Entity):
    def __init__(self, component, isSolid=False, edges=()):
        super().__init__('BRepBody', component=component)
        self.isSolid = isSolid
        self.edges = Collection(edges)
        self.faces = Collection()


class Edge(Entity):
    def __init__(self, component, faces=(), geometry=None, body=None):
        super().__init__('BRepEdge', component=component)
        self.faces = Collection(faces)
        self.body = body or types.SimpleNamespace(parentComponent=component, isSolid=False)
        self.geometry = geometry or types.SimpleNamespace(evaluator=LineEvaluator())


class Face(Entity):
    def __init__(self, component, evaluator=None):
        super().__init__('BRepFace', component=component)
        self.geometry = types.SimpleNamespace(evaluator=evaluator or PlaneEvaluator())


class LineEvaluator:
    def __init__(self, start=(0, 0, 0), end=(1, 0, 0), point_failure=False):
        self.start, self.end = start, end
        self.point_failure = point_failure

    def getParameterExtents(self):
        return True, 0.0, 1.0

    def getPointAtParameter(self, t):
        if self.point_failure:
            return False, None
        a, b = self.start, self.end
        return True, Point(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)

    def getFirstDerivative(self, t):
        a, b = self.start, self.end
        return True, Vector(x=b[0] - a[0], y=b[1] - a[1], z=b[2] - a[2])


class PlaneEvaluator:
    def __init__(self, normal=(0, 0, 1), tangent=(1, 0, 0), failing=False, curvature=(0.0, 0.0), normal_failure=False):
        self.normal, self.tangent, self.failing = normal, tangent, failing
        self.curvature, self.normal_failure = curvature, normal_failure

    def getParameterAtPoint(self, point):
        return True, types.SimpleNamespace(u=point.x, v=point.y)

    def getNormalAtParameter(self, param):
        if self.normal_failure:
            return False, None
        return True, Vector(*self.normal)

    def getCurvature(self, param):
        if self.failing:
            raise RuntimeError('SurfaceEvaluator unavailable')
        return True, Vector(*self.tangent), self.curvature[0], self.curvature[1]


class TrimInput:
    def __init__(self, tool, cells):
        self.tool, self.bRepCells = tool, Collection([Cell() for unused in range(cells)])
        self.cancelled = False

    def cancel(self):
        self.cancelled = True
        TRACE.append(('trim', 'cancel'))
        return True


class Cell:
    def __init__(self):
        self.isSelected = False


class TrimFeatures:
    def __init__(self, cells_per_input=(2, 2)):
        self.cells_per_input = list(cells_per_input)
        self.inputs = []

    def createInput(self, tool):
        TRACE.append(('trim', 'createInput', tool))
        inp = TrimInput(tool, self.cells_per_input[min(len(self.inputs), len(self.cells_per_input) - 1)])
        self.inputs.append(inp)
        return inp

    def add(self, inp):
        TRACE.append(('trim', 'add'))
        feature = Entity('TrimFeature')
        feature.bodies = Collection([Body(inp.tool.parentComponent, isSolid=False)])
        return feature


class SimpleFeatures:
    def __init__(self, component, feature_kind='PatchFeature', bodies=()):
        self.component, self.kind = component, feature_kind
        self.bodies = list(bodies)

    def createInput(self, *args):
        TRACE.append((self.kind, 'createInput', args))
        return types.SimpleNamespace()

    def add(self, inp):
        TRACE.append((self.kind, 'add'))
        feature = Entity(self.kind)
        feature.bodies = Collection(self.bodies)
        return feature


class Features(types.SimpleNamespace):
    pass


class Profile(Entity):
    def __init__(self, component):
        super().__init__('Profile', component=component)


def make_cast(kind):
    return lambda entity: entity if getattr(entity, 'objectType', '').endswith('::' + kind) else None


def sketch_curve_cast(entity):
    return entity if getattr(entity, 'objectType', '').split('::')[-1].startswith('Sketch') else None


adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
adsk.core.Point3D = Point
adsk.core.ValueInput = ValueInput
for kind in ('BRepEdge', 'BRepBody', 'BRepFace', 'ConstructionPlane', 'BRepVertex'):
    setattr(adsk.fusion, kind, types.SimpleNamespace(cast=make_cast(kind)))
adsk.fusion.SketchCurve = types.SimpleNamespace(cast=sketch_curve_cast)
adsk.fusion.FeatureOperations = types.SimpleNamespace(NewBodyFeatureOperation='NewBodyFeatureOperation')
adsk.fusion.SurfaceExtendTypes = types.SimpleNamespace(NaturalSurfaceExtendType='natural', TangentSurfaceExtendType='tangent', PerpendicularSurfaceExtendType='perpendicular')
adsk.fusion.FeatureHealthStates = types.SimpleNamespace(ErrorFeatureHealthState=2)
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
namespace = {'CAD_HANDLERS': {}}
load_legacy_core(namespace, ROOT)
exec(compile((ROOT / 'assets/cad/model.py').read_text(), 'model.py', 'exec'), namespace)
exec(compile((ROOT / 'assets/cad/surface.py').read_text(), 'surface.py', 'exec'), namespace)
HANDLERS = namespace['CAD_HANDLERS']


class Context:
    def __init__(self):
        self.created = []
        self.entities = {}
        self.component = Entity('Component', name='Selected')
        self.component.features = Features()
        self.doc = types.SimpleNamespace(creationId='surface-fixture', name='SurfaceFixture')
        self.design = types.SimpleNamespace()

    def assert_identity(self):
        pass

    def ref(self, entity):
        self.entities[entity.entityToken] = entity
        return {'token': entity.entityToken, 'kind': entity.objectType.split('::')[-1], 'name': entity.name}

    def resolve(self, ref, kind=None):
        if isinstance(ref, str):
            return self.entities[ref]
        return self.entities[ref.get('token', ref.get('name'))]

    def value(self, expression):
        assert isinstance(expression, str) and expression
        return ValueInput.createByString(expression)

    def length(self, expression):
        number, unit = expression.split()
        if unit not in ('mm', 'cm', 'in'):
            raise ValueError('Incompatible length units')
        return float(number) * {'mm': 0.1, 'cm': 1, 'in': 2.54}[unit]

    def angle(self, expression):
        number, unit = expression.split()
        if unit not in ('deg', 'rad'):
            raise ValueError('Incompatible angle units')
        return float(number) * {'deg': math.pi / 180, 'rad': 1}[unit]

    def _expression(self, expression, units=None):
        number, unit = expression.split()
        if not float(number) or unit not in ('mm', 'cm', 'in', 'deg', 'rad', '1/cm'):
            raise ValueError('Unsupported expression unit')
        return expression, float(number)

    def collection(self, entities):
        return Collection(entities)

    def register(self, name, entity):
        self.entities[name] = entity
        self.entities[entity.entityToken] = entity
        return entity


def make_ctx_with_bodies(solid=False):
    ctx = Context()
    body = ctx.register('Surface', Body(ctx.component, isSolid=solid))
    edge_one = Edge(ctx.component, faces=[Face(ctx.component)])
    edge_two = Edge(ctx.component, faces=[Face(ctx.component), Face(ctx.component)])
    body.edges = Collection([edge_one, edge_two])
    ctx.register('edge-free', edge_one)
    ctx.register('edge-shared', edge_two)
    return ctx, body


class SurfaceTests(unittest.TestCase):
    def setUp(self):
        TRACE.clear()

    def call(self, operation, data):
        result = HANDLERS[operation](self.ctx, data)
        import json
        json.dumps(result)
        return result

    def test_all_surface_operations_registered(self):
        for operation in ('surface.patch', 'surface.stitch', 'surface.trim', 'surface.extend', 'surface.offset', 'surface.check'):
            self.assertIn(operation, HANDLERS)

    def test_open_profile_sketch_edges_and_mixed_rejection(self):
        ctx = Context()
        ctx.component.createOpenProfile = lambda collection: Profile(ctx.component)
        ctx.component.createBRepEdgeProfile = lambda collection: Profile(ctx.component)
        sketch = ctx.register('curve', Entity('SketchLine', component=ctx.component))
        edge = ctx.register('edge', Edge(ctx.component))
        self.assertTrue(namespace['_surface_open_profile'](ctx, {'kind': 'openProfile', 'curves': ['curve']}))
        self.assertTrue(namespace['_surface_open_profile'](ctx, {'kind': 'openProfile', 'curves': ['edge']}))
        with self.assertRaisesRegex(ValueError, 'homogeneous'):
            namespace['_surface_open_profile'](ctx, {'kind': 'openProfile', 'curves': ['curve', 'edge']})

    def test_open_profile_none_parent_sketch_resolves_owner_without_crash(self):
        owner = Entity('Component')
        sketch = types.SimpleNamespace(objectType='adsk::fusion::Sketch', parentComponent=owner)
        open_profile = types.SimpleNamespace(objectType='adsk::fusion::Profile', parentSketch=None)
        self.assertIsNone(namespace['_cad_owner'](open_profile))
        closed_profile = types.SimpleNamespace(objectType='adsk::fusion::Profile', parentSketch=sketch)
        self.assertIs(namespace['_cad_owner'](closed_profile), owner)

    def test_model_preflight_availability_and_loft_conditions(self):
        ctx = Context()
        self.ctx = ctx
        blocked = namespace['_surface_model_preflight'](ctx, {'solid': False}, 'loft')
        self.assertEqual(blocked['status'], 'blocked')
        ctx.component.features = Features(loftFeatures=object())
        self.assertIsNone(namespace['_surface_model_preflight'](ctx, {'solid': False, 'endConditions': {'start': {'type': 'free'}}}, 'loft'))
        blocked = namespace['_surface_model_preflight'](ctx, {'solid': False, 'endConditions': {'end': {'type': 'tangent', 'weight': '1'}}}, 'loft')
        self.assertEqual(blocked['status'], 'blocked')
        self.assertIn('end-condition', blocked['warnings'][0])

    def test_trim_plan_cancels_and_apply_selects_cells(self):
        ctx = Context()
        ctx.component.features.trimFeatures = TrimFeatures((2, 2))
        tool = ctx.register('XZ', Entity('ConstructionPlane', component=ctx.component))
        self.ctx = ctx
        plan_result = self.call('surface.trim', {'schemaVersion': 1, 'frame': 'component', 'tool': 'XZ', 'mode': 'plan'})
        self.assertEqual(plan_result['plan']['cellCount'], 2)
        self.assertTrue(ctx.component.features.trimFeatures.inputs[0].cancelled)
        self.assertEqual(plan_result['status'], 'pass')
        apply_result = self.call('surface.trim', {'schemaVersion': 1, 'frame': 'component', 'tool': 'XZ', 'mode': 'apply',
                                                  'plan': plan_result['plan'], 'removeCells': [1]})
        self.assertTrue(ctx.component.features.trimFeatures.inputs[1].bRepCells.item(1).isSelected)
        self.assertFalse(ctx.component.features.trimFeatures.inputs[1].bRepCells.item(0).isSelected)
        self.assertEqual(apply_result['status'], 'pass')

    def test_trim_apply_rejects_stale_plan_and_unknown_cells(self):
        ctx = Context()
        ctx.component.features.trimFeatures = TrimFeatures((2, 3))
        ctx.register('XZ', Entity('ConstructionPlane', component=ctx.component))
        ctx.register('XY', Entity('ConstructionPlane', component=ctx.component))
        tool = ctx.register('XZ', Entity('ConstructionPlane', component=ctx.component))
        self.ctx = ctx
        plan = self.call('surface.trim', {'schemaVersion': 1, 'frame': 'component', 'tool': 'XZ', 'mode': 'plan'})['plan']
        with self.assertRaisesRegex(ValueError, 'Cell count changed'):
            self.call('surface.trim', {'schemaVersion': 1, 'frame': 'component', 'tool': 'XZ', 'mode': 'apply', 'plan': plan, 'removeCells': [0]})
        self.assertTrue(ctx.component.features.trimFeatures.inputs[1].cancelled)
        with self.assertRaisesRegex(ValueError, 'Plan belongs to a different tool'):
            self.call('surface.trim', {'schemaVersion': 1, 'frame': 'component', 'tool': 'XY', 'mode': 'apply',
                                       'plan': plan, 'removeCells': [0]})

    def test_check_free_edges_and_expectations(self):
        ctx, body = make_ctx_with_bodies(solid=False)
        self.ctx = ctx
        result = self.call('surface.check', {'schemaVersion': 1, 'frame': 'component', 'bodies': ['Surface']})
        self.assertEqual(result['bodies'][0]['freeEdgeCount'], 1)
        self.assertEqual(result['status'], 'pass')
        closed = self.call('surface.check', {'schemaVersion': 1, 'frame': 'component', 'bodies': ['Surface'], 'expectClosed': True})
        self.assertEqual(closed['status'], 'fail')
        allowed = self.call('surface.check', {'schemaVersion': 1, 'frame': 'component', 'bodies': ['Surface'], 'expectClosed': True,
                                              'allowedOpenEdges': [{'token': body.edges.item(0).entityToken}]})
        self.assertEqual(allowed['status'], 'pass')
        mismatch = self.call('surface.check', {'schemaVersion': 1, 'frame': 'component', 'bodies': ['Surface'], 'expectSolid': True})
        self.assertEqual(mismatch['status'], 'fail')

    def test_check_uses_token_when_sdk_edge_has_no_name(self):
        ctx, body = make_ctx_with_bodies(solid=False)
        self.ctx = ctx
        edge = body.edges.item(0)
        edge.name = None
        closed = self.call('surface.check', {'schemaVersion': 1, 'frame': 'component', 'bodies': ['Surface'],
                                             'expectClosed': True})
        self.assertEqual(closed['status'], 'fail')
        allowed = self.call('surface.check', {'schemaVersion': 1, 'frame': 'component', 'bodies': ['Surface'],
                                              'expectClosed': True, 'allowedOpenEdges': [{'token': edge.entityToken}]})
        self.assertEqual(allowed['status'], 'pass')

    def test_seam_measurement_pass_fail_and_explicit_unknown(self):
        ctx = Context()
        self.ctx = ctx
        shared = ctx.register('shared', Face(ctx.component, PlaneEvaluator()))
        other = ctx.register('other', Face(ctx.component, PlaneEvaluator(normal=(1, 0, 0))))
        failing = ctx.register('failing', Face(ctx.component, PlaneEvaluator(failing=True)))
        ctx.register('seam-body', Body(ctx.component, isSolid=False))
        edge_a = ctx.register('edgeA', Edge(ctx.component, faces=[shared]))
        edge_b = ctx.register('edgeB', Edge(ctx.component, faces=[shared, other, failing]))
        planar = self.call('surface.check', {'schemaVersion': 1, 'frame': 'component', 'bodies': ['seam-body'],
                                             'seams': [{'edgeA': 'edgeA', 'faceA': shared.entityToken, 'edgeB': 'edgeB', 'faceB': shared.entityToken}]})
        self.assertEqual(planar['seams'][0]['G0']['status'], 'pass')
        self.assertEqual(planar['seams'][0]['G1']['status'], 'pass')
        self.assertEqual(planar['seams'][0]['G2']['status'], 'pass')
        right_angle = self.call('surface.check', {'schemaVersion': 1, 'frame': 'component', 'bodies': ['seam-body'],
                                                  'seams': [{'edgeA': 'edgeA', 'faceA': shared.entityToken, 'edgeB': 'edgeB', 'faceB': other.entityToken}]})
        self.assertEqual(right_angle['seams'][0]['G1']['status'], 'fail')
        self.assertAlmostEqual(right_angle['seams'][0]['G1']['angleDeg'], 90.0, places=6)
        unknown = self.call('surface.check', {'schemaVersion': 1, 'frame': 'component', 'bodies': ['seam-body'],
                                              'seams': [{'edgeA': 'edgeA', 'faceA': shared.entityToken, 'edgeB': 'edgeB', 'faceB': failing.entityToken}]})
        self.assertEqual(unknown['seams'][0]['G2']['status'], 'unknown')
        self.assertTrue(unknown['seams'][0]['unknown'])
        self.assertEqual(unknown['status'], 'unknown')

    def test_seam_measurement_point_failure_reports_unknown(self):
        ctx = Context()
        self.ctx = ctx
        shared = ctx.register('shared', Face(ctx.component, PlaneEvaluator()))
        ctx.register('seam-body', Body(ctx.component, isSolid=False))
        failing_geometry = types.SimpleNamespace(evaluator=LineEvaluator(point_failure=True))
        edge_a = ctx.register('edgeA', Edge(ctx.component, faces=[shared], geometry=failing_geometry))
        edge_b = ctx.register('edgeB', Edge(ctx.component, faces=[shared]))
        result = self.call('surface.check', {'schemaVersion': 1, 'frame': 'component', 'bodies': ['seam-body'],
                                             'seams': [{'edgeA': 'edgeA', 'faceA': shared.entityToken, 'edgeB': 'edgeB', 'faceB': shared.entityToken}]})
        self.assertEqual(result['seams'][0]['G0']['status'], 'unknown')
        self.assertTrue(result['seams'][0]['unknown'])
        self.assertEqual(result['status'], 'unknown')

    def test_seam_g2_measures_nonzero_curvature_deviation(self):
        ctx = Context()
        self.ctx = ctx
        flat = ctx.register('flat', Face(ctx.component, PlaneEvaluator()))
        curved = ctx.register('curved', Face(ctx.component, PlaneEvaluator(curvature=(1.0, 0.0))))
        ctx.register('seam-body', Body(ctx.component, isSolid=False))
        edge_a = ctx.register('edgeA', Edge(ctx.component, faces=[flat]))
        edge_b = ctx.register('edgeB', Edge(ctx.component, faces=[curved]))
        result = self.call('surface.check', {'schemaVersion': 1, 'frame': 'component', 'bodies': ['seam-body'],
                                             'seams': [{'edgeA': 'edgeA', 'faceA': flat.entityToken, 'edgeB': 'edgeB', 'faceB': curved.entityToken}]})
        seam = result['seams'][0]
        self.assertEqual(seam['G1']['status'], 'pass')
        self.assertEqual(seam['G1']['samples'], 17)
        self.assertEqual(seam['G2']['status'], 'fail')
        self.assertGreater(seam['G2']['deviationInvCm'], 0)
        self.assertEqual(seam['G2']['samples'], 17)

    def test_seam_normal_at_parameter_failure_reports_unknown(self):
        ctx = Context()
        self.ctx = ctx
        shared = ctx.register('shared', Face(ctx.component, PlaneEvaluator()))
        bad_normal = ctx.register('bad-normal', Face(ctx.component, PlaneEvaluator(normal_failure=True)))
        ctx.register('seam-body', Body(ctx.component, isSolid=False))
        edge_a = ctx.register('edgeA', Edge(ctx.component, faces=[shared]))
        edge_b = ctx.register('edgeB', Edge(ctx.component, faces=[bad_normal]))
        result = self.call('surface.check', {'schemaVersion': 1, 'frame': 'component', 'bodies': ['seam-body'],
                                             'seams': [{'edgeA': 'edgeA', 'faceA': shared.entityToken, 'edgeB': 'edgeB', 'faceB': bad_normal.entityToken}]})
        seam = result['seams'][0]
        self.assertEqual(seam['G1']['status'], 'unknown')
        self.assertEqual(seam['G2']['status'], 'unknown')
        self.assertTrue(seam['unknown'])

    def test_extend_validates_shared_open_edges_and_sign(self):
        ctx = Context()
        self.ctx = ctx
        ctx.component.features.extendFeatures = SimpleFeatures(ctx.component, 'ExtendFeature')
        body = ctx.register('Surface', Body(ctx.component, isSolid=False))
        edge = Edge(ctx.component, faces=[Face(ctx.component)])
        body.edges = Collection([edge])
        ctx.register('edge', edge)
        with self.assertRaisesRegex(ValueError, 'positive distance'):
            self.call('surface.extend', {'schemaVersion': 1, 'frame': 'component', 'edges': ['edge'], 'distance': '-1 mm', 'type': 'natural'})
        solid = ctx.register('Solid', Body(ctx.component, isSolid=True))
        solid_edge = Edge(ctx.component, faces=[Face(ctx.component)], body=types.SimpleNamespace(parentComponent=ctx.component, isSolid=True))
        solid.edges = Collection([solid_edge])
        ctx.register('solid-edge', solid_edge)
        with self.assertRaisesRegex(ValueError, 'open surface body'):
            self.call('surface.extend', {'schemaVersion': 1, 'frame': 'component', 'edges': ['solid-edge'], 'distance': '1 mm'})
        shared = Edge(ctx.component, faces=[Face(ctx.component), Face(ctx.component)])
        body.edges = Collection([shared])
        ctx.register('shared-edge', shared)
        with self.assertRaisesRegex(ValueError, 'single-face'):
            self.call('surface.extend', {'schemaVersion': 1, 'frame': 'component', 'edges': ['shared-edge'], 'distance': '1 mm'})

    def test_model_result_envelope_carries_affected_without_duplicate_keyword(self):
        ctx = Context()
        self.ctx = ctx
        feature = ctx.register('SurfaceFeature', Entity('LoftFeature'))
        feature.bodies = Collection([Body(ctx.component, isSolid=False)])
        feature.healthState = 0
        feature.errorOrWarningMessage = ''
        result = {'feature': ctx.ref(feature), 'bodies': [ctx.ref(feature.bodies.item(0))], 'healthState': 0, 'message': ''}
        envelope = namespace['_surface_model_result'](ctx, 'loft', {'solid': False}, feature, result)
        self.assertEqual(envelope['status'], 'pass')
        self.assertEqual(envelope['operation'], 'model.loft')
        self.assertEqual(len(envelope['affected']), 2)
        self.assertEqual(envelope['affected'][0]['token'], feature.entityToken)
        self.assertTrue(envelope['surfaceVariant'])
        self.assertFalse(envelope['isSolid'])
        self.assertEqual(envelope['associativity'], 'nativeExpression')

    def test_extend_success_uses_real_surface_extend_type_enums(self):
        expected = {'natural': 'NaturalSurfaceExtendType', 'tangent': 'TangentSurfaceExtendType',
                    'perpendicular': 'PerpendicularSurfaceExtendType'}
        for extend_type, enum_name in expected.items():
            self.assertTrue(hasattr(adsk.fusion.SurfaceExtendTypes, enum_name), enum_name)
            ctx = Context()
            self.ctx = ctx
            TRACE.clear()
            ctx.component.features.extendFeatures = SimpleFeatures(ctx.component, 'ExtendFeature')
            body = ctx.register('Surface', Body(ctx.component, isSolid=False))
            edge = Edge(ctx.component, faces=[Face(ctx.component)])
            body.edges = Collection([edge])
            ctx.register('edge', edge)
            payload = {'schemaVersion': 1, 'frame': 'component', 'edges': ['edge'], 'distance': '1 mm'}
            if extend_type != 'natural':
                payload['type'] = extend_type
            result = self.call('surface.extend', payload)
            self.assertEqual(result['status'], 'pass')
            self.assertEqual(TRACE[0][0], 'ExtendFeature')
            self.assertEqual(TRACE[0][1], 'createInput')
            self.assertEqual(TRACE[0][2][2], getattr(adsk.fusion.SurfaceExtendTypes, enum_name))
            self.assertFalse(TRACE[0][2][3])

    def test_check_curvature_tolerance_units_and_default(self):
        ctx = Context()
        self.ctx = ctx
        shared = ctx.register('shared', Face(ctx.component, PlaneEvaluator()))
        ctx.register('seam-body', Body(ctx.component, isSolid=False))
        edge_a = ctx.register('edgeA', Edge(ctx.component, faces=[shared]))
        edge_b = ctx.register('edgeB', Edge(ctx.component, faces=[shared]))
        planar = self.call('surface.check', {'schemaVersion': 1, 'frame': 'component', 'bodies': ['seam-body'],
                                             'seams': [{'edgeA': 'edgeA', 'faceA': shared.entityToken, 'edgeB': 'edgeB', 'faceB': shared.entityToken}]})
        self.assertEqual(planar['seams'][0]['G2']['toleranceInvCm'], 0.001)
        converted = self.call('surface.check', {'schemaVersion': 1, 'frame': 'component', 'bodies': ['seam-body'],
                                                'curvatureTolerance': '5 1/mm',
                                                'seams': [{'edgeA': 'edgeA', 'faceA': shared.entityToken, 'edgeB': 'edgeB', 'faceB': shared.entityToken}]})
        self.assertEqual(converted['seams'][0]['G2']['toleranceInvCm'], 50.0)
        zero = self.call('surface.check', {'schemaVersion': 1, 'frame': 'component', 'bodies': ['seam-body'],
                                           'curvatureTolerance': '0 1/cm'})
        self.assertEqual(zero['status'], 'pass')

    def test_check_rejects_invalid_curvature_tolerance_before_measuring(self):
        ctx = Context()
        self.ctx = ctx
        ctx.register('Surface', Body(ctx.component, isSolid=False))
        for bad in ('0.001 cm/cm', '-0.1 1/cm', '0.001', '1/cm', 'abc 1/mm', '0.001 cm', ''):
            with self.assertRaises(ValueError, msg=bad):
                self.call('surface.check', {'schemaVersion': 1, 'frame': 'component', 'bodies': ['Surface'],
                                            'curvatureTolerance': bad})

    def test_stitch_expect_solid_verification(self):
        ctx = Context()
        self.ctx = ctx
        result_body = Body(ctx.component, isSolid=True)
        ctx.component.features.stitchFeatures = SimpleFeatures(ctx.component, 'StitchFeature', [result_body])
        open_a = ctx.register('A', Body(ctx.component, isSolid=False))
        open_b = ctx.register('B', Body(ctx.component, isSolid=False))
        result = self.call('surface.stitch', {'schemaVersion': 1, 'frame': 'component', 'bodies': ['A', 'B'], 'tolerance': '0.01 mm', 'expectSolid': False})
        self.assertEqual(result['status'], 'fail')
        self.assertTrue(result['warnings'])

    def test_offset_blocks_protected_zones(self):
        ctx = Context()
        self.ctx = ctx
        ctx.component.features.offsetFeatures = SimpleFeatures(ctx.component, 'OffsetFeature')
        face = ctx.register('face', Face(ctx.component))
        protected = ctx.register('protected', Body(ctx.component))
        result = self.call('surface.offset', {'schemaVersion': 1, 'frame': 'component', 'faces': ['face'], 'distance': '1 mm',
                                              'protected': ['protected']})
        self.assertEqual(result['status'], 'blocked')
        self.assertFalse(TRACE)

    def test_check_requires_frame_and_version(self):
        ctx = Context()
        self.ctx = ctx
        body = ctx.register('Surface', Body(ctx.component))
        with self.assertRaisesRegex(ValueError, 'schemaVersion'):
            self.call('surface.check', {'frame': 'component', 'bodies': ['Surface']})
        with self.assertRaisesRegex(ValueError, 'frame'):
            self.call('surface.check', {'schemaVersion': 1, 'frame': 'root', 'bodies': ['Surface']})


if __name__ == '__main__':
    unittest.main()
