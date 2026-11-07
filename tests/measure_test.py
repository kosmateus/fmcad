"""Offline mathematical/API-shape tests, NOT Fusion kernel verification."""
import copy
import itertools
import json
import math
import pathlib
import re
import sys
import types
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]


class Collection:
    def __init__(self, values=()):
        self.values = list(values)

    @property
    def count(self):
        return len(self.values)

    def item(self, index):
        return self.values[index]


class Point:
    objectType = 'adsk::core::Point3D'

    def __init__(self, x=0, y=0, z=0):
        self.x, self.y, self.z = x, y, z

    create = staticmethod(lambda x, y, z: Point(x, y, z))

    def copy(self):
        return copy.copy(self)

    def transformBy(self, matrix):
        c, s = math.cos(matrix.angle), math.sin(matrix.angle)
        self.x, self.y, self.z = (c*self.x - s*self.y + matrix.translation.x,
                                 s*self.x + c*self.y + matrix.translation.y,
                                 self.z + matrix.translation.z)
        return True


class Matrix:
    def __init__(self):
        self.translation = Point()
        self.angle = 0

    create = staticmethod(lambda: Matrix())

    def asArray(self):
        c, s = math.cos(self.angle), math.sin(self.angle)
        return [c, -s, 0, self.translation.x, s, c, 0, self.translation.y,
                0, 0, 1, self.translation.z, 0, 0, 0, 1]

    def copy(self):
        return copy.deepcopy(self)

    def invert(self):
        self.angle = -self.angle
        c, s = math.cos(self.angle), math.sin(self.angle)
        t = self.translation
        self.translation = Point(-c*t.x + s*t.y, -s*t.x - c*t.y, -t.z)
        return True


class Entity:
    def __init__(self, kind, name, **values):
        self.objectType = 'adsk::fusion::' + kind
        self.name = name
        self.entityToken = name
        self.assemblyContext = None
        self.nativeObject = None
        self.attributes = types.SimpleNamespace(itemByName=lambda *args: None)
        self.__dict__.update(values)

    def createForAssemblyContext(self, occurrence):
        result = copy.copy(self)
        result.nativeObject = self
        result.assemblyContext = occurrence
        return result


class Body(Entity):
    def __init__(self, name, owner, low=(0, 0, 0), high=(1, 1, 1)):
        super().__init__('BRepBody', name, parentComponent=owner)
        self.boundingBox = types.SimpleNamespace(minPoint=Point(*low), maxPoint=Point(*high))
        self.volume = math.prod(b - a for a, b in zip(low, high))
        self.isSolid = True
        self.isValid = True
        self.faces = Collection()
        self.edges = Collection()
        self.temporary = False

    @property
    def preciseBoundingBox(self):
        return self.boundingBox

    def getPhysicalProperties(self, accuracy):
        assert accuracy == 2
        return types.SimpleNamespace(volume=self.volume, area=6, mass=self.volume * 0.00785)


class GeometricBody(Body):
    """Polyhedral geometry: bound transformed vertices, not the native AABB."""
    def __init__(self, name, owner, vertices):
        super().__init__(name, owner)
        self.vertices = vertices
        self.bounds_reads = []
        self.boundingBox = types.SimpleNamespace(minPoint=Point(-99, -99, -99), maxPoint=Point(99, 99, 99))

    @property
    def preciseBoundingBox(self):
        self.bounds_reads.append(self.assemblyContext)
        vertices = self.vertices
        if self.assemblyContext is not None:
            transform = self.assemblyContext.transform2
            c, s = math.cos(transform.angle), math.sin(transform.angle)
            t = transform.translation
            vertices = [(c*x - s*y + t.x, s*x + c*y + t.y, z + t.z) for x, y, z in vertices]
        return types.SimpleNamespace(minPoint=Point(*(min(v[i] for v in vertices) for i in range(3))),
                                     maxPoint=Point(*(max(v[i] for v in vertices) for i in range(3))))


class Occurrence(Entity):
    def __init__(self, name, component, angle=0, translation=(0, 0, 0), children=()):
        transform = Matrix()
        transform.angle, transform.translation = angle, Point(*translation)
        super().__init__('Occurrence', name, component=component, fullPathName=name,
                         transform2=transform, childOccurrences=Collection(children))

    @property
    def bRepBodies(self):
        return Collection(b.createForAssemblyContext(self) for b in self.component.bRepBodies.values)


class Parameter(Entity):
    def __init__(self):
        super().__init__('UserParameter', 'width')
        self.unit, self.comment, self.value = 'mm', '', 1.0
        self._expression = '10 mm'
        self.writes = []
        self.fail_sample = False
        self.fail_restore = False

    @property
    def expression(self):
        return self._expression

    @expression.setter
    def expression(self, value):
        self.writes.append(value)
        if value == '10 mm' and self.fail_restore:
            raise RuntimeError('restore setter failed')
        self._expression = value
        if value == '20 mm' and self.fail_sample:
            raise RuntimeError('sample setter failed after mutation')


class Units:
    # Only literals are implemented in these stubs. Production uses core UnitsManager.
    units = {'mm': ('L', 0.1), 'cm': ('L', 1), 'm': ('L', 100), 'in': ('L', 2.54),
             'mm^2': ('A', 0.01), 'cm^2': ('A', 1), 'mm^3': ('V', 0.001), 'cm^3': ('V', 1),
             'kg': ('M', 1), 'g': ('M', 0.001), 'rad': ('R', 1), 'deg': ('R', math.pi / 180), '': ('', 1)}

    def parse(self, expression):
        match = re.fullmatch(r'\s*(-?[0-9.]+)\s*([a-z]*(?:\^[23])?)\s*', expression)
        if not match or match[2] not in self.units:
            raise ValueError('Unsupported stub expression')
        dimension, factor = self.units[match[2]]
        return dimension, float(match[1]) * factor

    def isValidExpression(self, expression, unit):
        try:
            return self.parse(expression)[0] == self.units[unit][0]
        except (ValueError, KeyError):
            return False

    def evaluateExpression(self, expression, unit):
        return self.parse(expression)[1]


class Manager:
    def __init__(self):
        self.copies = []
        self.transforms = []
        self.boolean_ok = True
        self.section = None

    def copy(self, entity):
        body = copy.copy(entity)
        body.boundingBox = copy.deepcopy(entity.boundingBox)
        body.temporary = True
        self.copies.append(entity)
        return body

    def transform(self, body, matrix):
        assert body.temporary, 'Must never transform live geometry'
        self.transforms.append(matrix)
        for p in (body.boundingBox.minPoint, body.boundingBox.maxPoint):
            for k in ('x', 'y', 'z'):
                setattr(p, k, getattr(p, k) + getattr(matrix.translation, k))
        return True

    def booleanOperation(self, target, tool, operation):
        assert target.temporary, 'Must never Boolean live target'
        assert operation in (6, 7)
        if not self.boolean_ok:
            return False
        overlap = math.prod(max(0, min(getattr(target.boundingBox.maxPoint, k), getattr(tool.boundingBox.maxPoint, k)) -
                                     max(getattr(target.boundingBox.minPoint, k), getattr(tool.boundingBox.minPoint, k)))
                                   for k in ('x', 'y', 'z'))
        target.volume = overlap if operation == 7 else max(0, target.volume - overlap)
        return True

    def createFaceFromPlanarWires(self, wires):
        return None

    def planeIntersection(self, body, plane):
        assert body.temporary
        assert plane.objectType.endswith('Plane')
        return self.section


class Measurements:
    def __init__(self, root):
        self.root = root
        self.calls = []

    def validate(self, entities):
        for entity in entities:
            if (NS['_cad_owner'](entity) not in (None, self.root) and
                    entity.assemblyContext is None and not getattr(entity, 'temporary', False) and
                    not entity.objectType.endswith('::Occurrence')):
                raise RuntimeError('3 : invalid argument geometryOne')

    def measureMinimumDistance(self, a, b):
        self.calls.append((a, b))
        self.validate((a, b))
        if any(entity.objectType.endswith('::Plane') for entity in (a, b)):
            raise RuntimeError('3 : invalid argument geometryOne')
        if all(hasattr(e, 'measurementPoint') for e in (a, b)):
            points = []
            for entity in (a, b):
                point = entity.measurementPoint.copy()
                if entity.assemblyContext is not None:
                    point.transformBy(entity.assemblyContext.transform2)
                points.append(point)
            value = math.dist(NS['_cad_xyz'](points[0]), NS['_cad_xyz'](points[1]))
            return types.SimpleNamespace(value=value, positionOne=points[0], positionTwo=points[1])
        if hasattr(a, 'boundingBox') and hasattr(b, 'boundingBox'):
            distances = [max(0, getattr(a.boundingBox.minPoint, k) - getattr(b.boundingBox.maxPoint, k),
                             getattr(b.boundingBox.minPoint, k) - getattr(a.boundingBox.maxPoint, k)) for k in ('x', 'y', 'z')]
            value = math.hypot(*distances)
        else:
            value = 0.5
        return types.SimpleNamespace(value=value, positionOne=Point(), positionTwo=Point(value, 0, 0))

    def measureAngle(self, *entities):
        self.calls.append(entities)
        self.validate(entities)
        return types.SimpleNamespace(value=math.pi / 2)


adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
adsk.core.Point3D = Point
adsk.core.Vector3D = Point
adsk.core.Plane = types.SimpleNamespace(create=lambda point, normal: Entity('Plane', 'section plane', geometry=types.SimpleNamespace(objectType='adsk::core::Plane')))
adsk.core.Matrix3D = Matrix
adsk.fusion.CalculationAccuracy = types.SimpleNamespace(HighCalculationAccuracy=2)
adsk.fusion.BooleanTypes = types.SimpleNamespace(IntersectionBooleanType=7, DifferenceBooleanType=6)
adsk.fusion.FeatureHealthStates = types.SimpleNamespace(HealthyFeatureHealthState=0, WarningFeatureHealthState=1,
                                                       ErrorFeatureHealthState=2, SuppressedFeatureHealthState=3)
MANAGER = Manager()
adsk.fusion.TemporaryBRepManager = types.SimpleNamespace(get=lambda: MANAGER)
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
NS = {}
exec(compile((ROOT / 'runtime/python/fmcad/domain/values.py').read_text(), 'values.py', 'exec'), NS)
for filename in ('core.py', 'measure.py'):
    source = (ROOT / 'assets/cad' / filename).read_text()
    exec(compile(source, filename, 'exec'), NS)
for filename in ('domain/regional_geometry.py', 'adapters/fusion/regional_geometry.py',
                 'application/regional_geometry.py', 'domain/brep_baseline.py',
                 'adapters/fusion/brep_baseline.py', 'application/brep_baseline.py',
                 'domain/section_witness.py', 'adapters/fusion/section_witness.py',
                 'application/section_witness.py', 'application/section_witness_handlers.py'):
    source = (ROOT / 'runtime/python/fmcad' / filename).read_text()
    exec(compile(source, filename, 'exec'), NS)


class MeasureTests(unittest.TestCase):
    def setUp(self):
        global MANAGER
        MANAGER = Manager()
        self.ctx = NS['CadContext'].__new__(NS['CadContext'])
        self.root = Entity('Component', 'root')
        for name in ('bRepBodies', 'sketches', 'features', 'constructionPlanes', 'constructionAxes', 'constructionPoints', 'allOccurrences'):
            setattr(self.root, name, Collection())
        self.ctx.root = self.ctx.component = self.root
        self.ctx.occurrence = None
        self.ctx.created = []
        self.ctx._profile_selections = []
        self.ctx.doc = types.SimpleNamespace(name='Example', isModified=False)
        self.measurements = Measurements(self.root)
        self.ctx.app = types.SimpleNamespace(measureManager=self.measurements)
        self.parameter = Parameter()
        self.health = types.SimpleNamespace(name='Feature', healthState=0, errorOrWarningMessage='',
                                            isSuppressed=False, isRolledBack=False)
        self.computes = 0
        self.compute_actions = []
        self.compute_advances_ms = []
        self.clock = None

        def compute():
            self.computes += 1
            if self.compute_actions:
                action = self.compute_actions.pop(0)
                if isinstance(action, Exception):
                    raise action
                self.health.healthState = action
            if self.compute_advances_ms and self.clock is not None:
                self.clock['now'] += self.compute_advances_ms.pop(0) / 1000
            return True

        self.entities = {'width': self.parameter, 'root': self.root}
        self.ctx.design = types.SimpleNamespace(allComponents=Collection([self.root]), allParameters=Collection([self.parameter]),
            userParameters=Collection([self.parameter]), timeline=Collection([self.health]), computeAll=compute,
            unitsManager=Units(), findEntityByToken=lambda token: [self.entities[token]] if token in self.entities else [])
        self.body = Body('BodyA', self.root)
        self.add(self.body)

    def add(self, entity):
        self.entities[entity.name] = entity
        if entity.objectType.endswith('BRepBody'):
            entity.parentComponent.bRepBodies.values.append(entity)
        return {'token': entity.entityToken}

    def call(self, operation, data):
        return self.ctx.call(operation, data)

    def face(self, name, geometry, body=None):
        face = Entity('BRepFace', name, body=body or self.body, geometry=geometry)
        face.body.faces.values.append(face)
        self.add(face)
        return face

    def test_catalog_registration_and_examples_match(self):
        catalog = json.loads((ROOT / 'src/catalog/measure.json').read_text())
        expected = set(catalog)
        core = {}
        exec(compile((ROOT / 'runtime/python/fmcad/domain/values.py').read_text(), 'values.py', 'exec'), core)
        exec(compile((ROOT / 'assets/cad/core.py').read_text(), 'core.py', 'exec'), core)
        self.assertEqual(expected | {'measure.baseline.capture_internal', 'measure.baseline.compare_internal'},
                         NS['CAD_HANDLERS'].keys() - core['CAD_HANDLERS'].keys())
        self.assertEqual(len(expected), 28)

    def test_analytic_inclined_cylinder_not_bbox(self):
        geometry = Entity('Cylinder', 'cylinder', radius=1.25, axis=Point(1, 1, 1))
        face = self.face('Cyl', geometry)
        face.boundingBox = types.SimpleNamespace(minPoint=Point(-99, -99, -99), maxPoint=Point(99, 99, 99))
        self.assertEqual(self.call('measure.diameter', {'ref': {'token': 'Cyl'}})['value'], 25)
        self.assertEqual(self.call('measure.radius', {'ref': {'token': 'Cyl'}})['value'], 12.5)

    def test_circle_radius_and_unsupported_surface(self):
        self.face('Circle', Entity('Circle3D', 'circle', radius=2))
        self.assertEqual(self.call('measure.radius', {'ref': {'token': 'Circle'}, 'units': 'cm'})['value'], 2)
        self.face('Cone', Entity('Cone', 'cone', radius=2))
        with self.assertRaisesRegex(ValueError, 'analytic'):
            self.call('measure.diameter', {'ref': {'token': 'Cone'}})

    def test_units_scale_by_dimension_and_mass_internal_kg(self):
        volume = self.call('measure.volume', {'ref': 'BodyA'})
        self.assertEqual((volume['value'], volume['units']), (1000, 'mm3'))
        self.assertEqual(self.call('measure.area', {'ref': 'BodyA'})['value'], 600)
        self.assertAlmostEqual(self.call('measure.mass', {'ref': 'BodyA'})['value'], 0.00785)
        self.assertAlmostEqual(self.call('measure.mass', {'ref': 'BodyA', 'units': 'g'})['value'], 7.85)
        for scale in (0.1, 2, 10):
            value = NS['_measure_value'](scale ** 3, 'volume', {})['value']
            self.assertAlmostEqual(value, (10 * scale) ** 3)

    def test_nonfinite_wrong_units_and_unknown_inputs_rejected(self):
        with self.assertRaisesRegex(ValueError, 'units'):
            self.call('measure.volume', {'ref': 'BodyA', 'units': 'mm'})
        with self.assertRaisesRegex(ValueError, 'unsupported inputs'):
            self.call('measure.radius', {'ref': 'BodyA', 'mode': 'bbox'})
        with self.assertRaisesRegex(ValueError, 'non-finite'):
            NS['_measure_value'](math.inf, 'length', {})

    def test_finite_curve_length(self):
        edge = Entity('BRepEdge', 'Edge', body=self.body, length=math.pi)
        self.add(edge)
        self.assertAlmostEqual(self.call('measure.length', {'ref': {'token': 'Edge'}})['value'], 10 * math.pi)
        with self.assertRaisesRegex(ValueError, 'Length requires'):
            self.call('measure.length', {'ref': 'BodyA'})

    def test_minimum_and_point_projection_are_distinct(self):
        self.add(Body('BodyB', self.root, (2, 3, 0), (3, 4, 1)))
        minimum = self.call('measure.distance', {'a': 'BodyA', 'b': 'BodyB'})
        self.assertAlmostEqual(minimum['value'], math.sqrt(5) * 10)
        data = {'a': ['10 mm', '0 mm', '0 mm'], 'b': ['0 mm', '20 mm', '0 mm'],
                'direction': [2, 0, 0], 'space': 'assembly', 'mode': 'axial'}
        self.assertEqual(self.call('measure.distance', data)['value'], -10)
        self.assertEqual(self.call('measure.distance', dict(data, mode='projected'))['value'], 10)
        self.assertEqual(len(self.measurements.calls), 1)
        with self.assertRaisesRegex(ValueError, 'direction and explicit space'):
            self.call('measure.distance', {k: v for k, v in data.items() if k != 'space'})
        with self.assertRaisesRegex(ValueError, 'only apply'):
            self.call('measure.distance', {'a': 'BodyA', 'b': 'BodyB', 'direction': [1, 0, 0]})

    def test_mixed_native_frames_rejected_proxy_refs_supported(self):
        component = Entity('Component', 'Part', bRepBodies=Collection())
        self.ctx.design.allComponents.values.append(component)
        native = Body('PartBody', component)
        self.add(native)
        with self.assertRaisesRegex(ValueError, 'Mixed coordinate'):
            self.call('measure.distance', {'a': 'BodyA', 'b': {'token': 'PartBody'}})
        transform = Matrix()
        transform.translation = Point(3, 0, 0)
        occurrence = Entity('Occurrence', 'Part:1', component=component, fullPathName='Part:1', transform2=transform)
        self.root.allOccurrences.values.append(occurrence)
        result = self.call('assembly.clearance', {'a': 'BodyA', 'b': {'token': 'PartBody', 'occurrence': 'Part:1'}, 'minimum': '10 mm'})
        self.assertEqual(result['distance']['value'], 20)
        self.assertTrue(result['passed'])
        self.assertEqual(result['context']['space'], 'assembly')
        self.assertIn(native, MANAGER.copies)
        self.assertEqual(native.boundingBox.minPoint.x, 0)
        self.assertEqual(MANAGER.transforms, [transform])

    def test_projection_arrays_cannot_silently_adopt_foreign_component(self):
        component = Entity('Component', 'OtherComponent')
        point = Entity('ConstructionPoint', 'ForeignPoint', parentComponent=component, geometry=Point(1, 0, 0))
        self.add(point)
        data = {'a': {'token': 'ForeignPoint'}, 'b': ['0 mm', '0 mm', '0 mm'],
                'mode': 'projected', 'direction': [1, 0, 0], 'space': 'component local'}
        with self.assertRaisesRegex(ValueError, 'selected component'):
            self.call('measure.distance', data)
        self.ctx.component = component
        self.assertEqual(self.call('measure.distance', data)['value'], 10)

    def test_nested_native_occurrence_context_not_mislabeled_root(self):
        component = Entity('Component', 'Part', bRepBodies=Collection())
        native = Body('Native', component)
        occurrence = Entity('Occurrence', 'Nested:1', component=component, fullPathName='Nested:1', transform2=Matrix())
        body = native.createForAssemblyContext(occurrence)
        self.entities['Proxy'] = body
        with self.assertRaisesRegex(ValueError, 'root-context occurrence'):
            self.call('measure.volume', {'ref': {'token': 'Proxy'}})

    def test_projection_prefers_sketch_world_geometry(self):
        sketch = Entity('Sketch', 'Sketch', parentComponent=self.root)
        point = Entity('SketchPoint', 'SketchPoint', parentSketch=sketch, geometry=Point(99, 99, 99), worldGeometry=Point(1, 0, 0))
        self.add(point)
        result = self.call('measure.distance', {'a': {'token': 'SketchPoint'}, 'b': ['0 mm', '0 mm', '0 mm'],
                           'mode': 'axial', 'direction': [1, 0, 0], 'space': 'assembly'})
        self.assertEqual(result['value'], -10)

    def test_angle_and_bounds(self):
        self.root.xConstructionAxis = Entity('ConstructionAxis', 'X', parentComponent=self.root)
        self.root.yConstructionAxis = Entity('ConstructionAxis', 'Y', parentComponent=self.root)
        self.assertEqual(self.call('measure.angle', {'a': 'X', 'b': 'Y'})['value'], 90)
        self.assertEqual(self.call('measure.angle', {'a': 'X', 'b': 'Y', 'units': 'rad'})['value'], math.pi / 2)
        result = self.call('measure.bounds', {'ref': 'BodyA'})
        self.assertEqual(result['size'], [10, 10, 10])
        self.assertEqual(result['units'], 'mm')

    def test_bounds_pattern_and_mirror_ignore_inflated_component_graphics(self):
        for label, placements, expected in (
                ('pattern', [(x, y, 0) for x in (0, 1, 2) for y in (0, 0.6, 1.2)], [22, 15, 4]),
                ('mirror', [(0, 0, 0), (0.8, 0, 0)], [10, 3, 4])):
            with self.subTest(label=label):
                component = Entity('Component', label, bRepBodies=Collection(), allOccurrences=Collection(),
                    boundingBox=types.SimpleNamespace(minPoint=Point(-0.002, -0.002, -0.002),
                        maxPoint=Point(expected[0] / 10 + 0.002, 2.175999952316284, 2.175999952316284)))
                self.add(component)
                for i, (x, y, z) in enumerate(placements):
                    body = GeometricBody(label + str(i), component,
                        list(itertools.product((x, x + 0.2), (y, y + 0.3), (z, z + 0.4))))
                    self.add(body)
                for units, scale in (('mm', 1), ('cm', 0.1), ('m', 0.001), ('in', 1 / 25.4)):
                    result = self.call('measure.bounds', {'ref': {'token': label}, 'units': units})
                    self.assertEqual(result['min'], [0, 0, 0])
                    for actual, target in zip(result['size'], expected):
                        self.assertAlmostEqual(actual, target * scale)
                    self.assertEqual(result['context']['space'], 'component local')

    def test_bounds_recursive_rotated_proxies_and_repeated_instances(self):
        self.root.bRepBodies = Collection()
        part = Entity('Component', 'Part', bRepBodies=Collection(), allOccurrences=Collection())
        group = Entity('Component', 'Group', bRepBodies=Collection(), allOccurrences=Collection())
        self.add(part)
        self.add(group)
        # A triangular prism detects rotating an AABB instead of actual geometry.
        body = GeometricBody('Prism', part, [(x, y, z) for x, y in ((0, 0), (2, 0), (0, 1)) for z in (0, 1)])
        self.add(body)
        direct = GeometricBody('Direct', group, list(itertools.product((0, 0.5), (0, 0.5), (0, 0.5))))
        self.add(direct)
        local = Occurrence('Child:1', part, math.pi / 4, (2, 0, 0))
        group.allOccurrences = Collection([local])
        # Parent rotates 90 degrees and translates (10, 5, 0); child's full transform is composed.
        child = Occurrence('Group:1+Child:1', part, 3 * math.pi / 4, (10, 7, 0))
        parent = Occurrence('Group:1', group, math.pi / 2, (10, 5, 0), [child])
        child.assemblyContext = parent
        repeat = Occurrence('Part:2', part, 0, (20, 0, 0))
        self.root.allOccurrences = Collection([parent, child, repeat])
        for occurrence in (parent, child, repeat):
            self.add(occurrence)
        self.ctx.design.allComponents.values.extend([group, part])
        self.root.boundingBox = types.SimpleNamespace(minPoint=Point(-100, -100, -100), maxPoint=Point(100, 100, 100))

        def bounds(ref, low, high, space):
            result = self.call('measure.bounds', {'ref': ref, 'units': 'cm'})
            for actual, expected in zip(result['min'] + result['max'], low + high):
                self.assertAlmostEqual(actual, expected)
            self.assertEqual(result['context']['space'], space)

        q = math.sqrt(0.5)
        bounds({'token': 'Group'}, [0, 0, 0], [2 + 2*q, 2*q, 1], 'component local')
        self.assertEqual(body.bounds_reads, [local])
        body.bounds_reads.clear()
        bounds({'token': 'Group:1'}, [10 - 2*q, 5, 0], [10, 7 + 2*q, 1], 'assembly')
        self.assertEqual(body.bounds_reads, [child])
        body.bounds_reads.clear()
        direct.bounds_reads.clear()
        bounds({'token': 'root'}, [10 - 2*q, 0, 0], [22, 7 + 2*q, 1], 'assembly')
        self.assertEqual(body.bounds_reads, [child, repeat])
        self.assertEqual(direct.bounds_reads, [parent])
        bounds({'token': 'Prism', 'occurrence': child.fullPathName},
               [10 - 2*q, 7 - q, 0], [10, 7 + 2*q, 1], 'assembly')
        self.assertEqual(MANAGER.transforms, [])
        self.assertEqual(self.ctx.created, [])

    def test_bounds_empty_and_invalid_geometry_fail_without_infinities(self):
        empty = Entity('Component', 'Empty', bRepBodies=Collection(), allOccurrences=Collection(),
                       boundingBox=types.SimpleNamespace(minPoint=Point(-99, -99, -99), maxPoint=Point(99, 99, 99)))
        occurrence = Occurrence('Empty:1', empty)
        self.root.allOccurrences.values.append(occurrence)
        self.add(empty)
        self.add(occurrence)
        for token in ('Empty', 'Empty:1'):
            with self.assertRaisesRegex(ValueError, 'nonempty B-Rep'):
                self.call('measure.bounds', {'ref': {'token': token}})
        for low, high in (((math.inf, 0, 0), (1, 1, 1)), ((0, 0, 0), (math.nan, 1, 1)),
                          ((2, 0, 0), (1, 1, 1)), ((-1e308, 0, 0), (1e308, 1, 1))):
            self.body.boundingBox = types.SimpleNamespace(minPoint=Point(*low), maxPoint=Point(*high))
            with self.assertRaisesRegex(ValueError, 'invalid|non-finite'):
                self.call('measure.bounds', {'ref': 'BodyA', 'units': 'cm'})
        self.body.boundingBox = None
        with self.assertRaisesRegex(ValueError, 'no geometric bounding box'):
            self.call('measure.bounds', {'ref': 'BodyA'})

    def test_bounds_root_includes_direct_bodies_without_definition_duplicates(self):
        result = self.call('measure.bounds', {'ref': {'token': 'root'}})
        self.assertEqual(result['min'], [0, 0, 0])
        self.assertEqual(result['max'], [10, 10, 10])
        self.assertEqual(result['context']['space'], 'assembly')

    def test_brep_bounds_helper_needs_only_entity_and_preserves_scaled_validation(self):
        self.assertEqual(NS['_cad_brep_bounds'](self.root),
                         {'min': [0, 0, 0], 'max': [1, 1, 1], 'size': [1, 1, 1]})
        self.body.boundingBox.maxPoint.x = 1e308
        with self.assertRaisesRegex(ValueError, 'non-finite'):
            self.call('measure.bounds', {'ref': 'BodyA', 'units': 'mm'})
        with self.assertRaisesRegex(ValueError, 'requires B-Rep'):
            NS['_cad_brep_bounds'](Entity('Sketch', 'Sketch'))

    def test_bounds_face_and_edge_stay_scoped_to_selected_geometry(self):
        for kind in ('BRepFace', 'BRepEdge'):
            entity = Entity(kind, kind, body=self.body, boundingBox=types.SimpleNamespace(
                minPoint=Point(0.2, 0.3, 0.4), maxPoint=Point(0.5, 0.6, 0.4)))
            self.add(entity)
            result = self.call('measure.bounds', {'ref': {'token': kind}})
            self.assertEqual(result['min'], [2, 3, 4])
            self.assertEqual(result['max'], [5, 6, 4])

    def test_section_computes_wire_without_live_changes(self):
        plane = Entity('ConstructionPlane', 'Plane', parentComponent=self.root,
                       geometry=Entity('Plane', 'plane', origin=Point(), normal=Point(0, 0, 1)))
        self.add(plane)
        edge = Entity('BRepEdge', 'SectionEdge', length=2 * math.pi,
                      geometry=Entity('Circle3D', 'circle', center=Point(), normal=Point(0, 0, 1), radius=1))
        MANAGER.section = types.SimpleNamespace(edges=Collection([edge]))
        result = self.call('measure.section', {'body': 'BodyA', 'plane': {'token': 'Plane'}})
        self.assertAlmostEqual(result['totalLength']['value'], 20 * math.pi)
        self.assertEqual(result['curves'][0]['lengthUnits'], 'cm')
        self.assertEqual(self.root.bRepBodies.count, 1)
        self.assertEqual(self.computes, 0)
        self.assertEqual(self.ctx.created, [])
        with self.assertRaisesRegex(ValueError, 'unsupported'):
            self.call('measure.section', {'body': 'BodyA', 'plane': {'token': 'Plane'}, 'mode': 'area'})
        MANAGER.section = None
        with self.assertRaisesRegex(RuntimeError, 'no intersection or kernel failure'):
            self.call('measure.section', {'body': 'BodyA', 'plane': {'token': 'Plane'}})

    def test_thickness_parallel_planar_faces_not_global_wall(self):
        for name, z in (('Front', 0), ('Back', 0.5)):
            self.face(name, Entity('Plane', name, origin=Point(0, 0, z), normal=Point(0, 0, 1)))
        data = {'a': {'token': 'Front'}, 'b': {'token': 'Back'}}
        self.assertEqual(self.call('measure.thickness', data)['value'], 5)
        self.entities['Back'].geometry.normal = Point(1, 0, 0)
        with self.assertRaisesRegex(ValueError, 'not parallel'):
            self.call('measure.thickness', data)
        with self.assertRaisesRegex(ValueError, 'global minimum'):
            self.call('measure.thickness', dict(data, mode='minimumWall'))

    def test_thickness_analytic_distance_normalized_antiparallel_and_units(self):
        front = self.face('Front', Entity('Plane', 'p1', origin=Point(), normal=Point(3, 4, 0)))
        back = self.face('Back', Entity('Plane', 'p2', origin=Point(-3.7, 3.4, 10), normal=Point(-6, -8, 0)))
        data = {'a': {'token': 'Front'}, 'b': {'token': 'Back'}, 'mode': 'parallelPlanes'}

        def face_distance(a, b):
            self.assertIs(a, front)
            self.assertIs(b, back)
            # Within overlap tolerance, but deliberately not the analytic plane distance.
            return types.SimpleNamespace(value=0.50001)

        self.measurements.measureMinimumDistance = face_distance
        for units, expected in (('mm', 5), ('cm', 0.5), ('m', 0.005), ('in', 0.5 / 2.54)):
            self.assertAlmostEqual(self.call('measure.thickness', dict(data, units=units))['value'], expected)
        with self.assertRaisesRegex(ValueError, 'no normal overlap'):
            self.call('measure.thickness', dict(data, tolerance='0.00001 mm'))

    def child_measurement_fixture(self):
        component = Entity('Component', 'Child', bRepBodies=Collection(), allOccurrences=Collection())
        self.add(component)
        self.ctx.design.allComponents.values.append(component)
        self.ctx.component = component
        body = Body('ChildBody', component)
        self.add(body)
        front = self.face('ChildFront', Entity('Plane', 'p1', origin=Point(), normal=Point(0, 0, 2)), body)
        back = self.face('ChildBack', Entity('Plane', 'p2', origin=Point(0, 0, 0.5), normal=Point(0, 0, -3)), body)
        front.measurementPoint, back.measurementPoint = Point(), Point(0, 0, 0.5)
        # Full root-context path, with rotation and translation, not a nested native occurrence.
        occurrence = Occurrence('Parent:1+Child:1', component, math.pi / 2, (10, 20, 30))
        self.root.allOccurrences.values.append(occurrence)
        self.add(occurrence)
        data = {'a': {'token': front.entityToken}, 'b': {'token': back.entityToken}}
        return component, occurrence, front, back, data

    def test_native_child_thickness_manager_rejects_natives_accepts_unique_proxies(self):
        component, occurrence, front, back, data = self.child_measurement_fixture()
        with self.assertRaisesRegex(RuntimeError, 'invalid argument geometryOne'):
            self.measurements.measureMinimumDistance(front, back)
        self.measurements.calls.clear()
        result = self.call('measure.thickness', data)
        self.assertEqual(result['value'], 5)
        self.assertEqual(result['context'], {'space': 'component local', 'component': self.ctx.ref(component)})
        a, b = self.measurements.calls[-1]
        self.assertIs(a.nativeObject, front)
        self.assertIs(b.nativeObject, back)
        self.assertIs(a.assemblyContext, occurrence)
        self.assertIs(b.assemblyContext, occurrence)
        self.assertIsNone(front.assemblyContext)
        self.assertIsNone(back.assemblyContext)
        self.assertEqual(MANAGER.copies, [])
        self.assertEqual(self.ctx.created, [])
        # The scalar is still plane distance, not a replacement by finite-face distance.
        back.measurementPoint.z += 0.00001
        self.assertEqual(self.call('measure.thickness', data)['value'], 5)
        back.measurementPoint = Point(2, 0, 0.5)
        with self.assertRaisesRegex(ValueError, 'no normal overlap'):
            self.call('measure.thickness', data)
        back.geometry.normal = Point(1, 0, 0)
        with self.assertRaisesRegex(ValueError, 'not parallel'):
            self.call('measure.thickness', data)
        back.body = self.body
        with self.assertRaisesRegex(ValueError, 'Mixed coordinate|same body'):
            self.call('measure.thickness', data)

    def test_manager_normalization_requires_unique_occurrence_before_call(self):
        component, occurrence, front, back, data = self.child_measurement_fixture()
        for matches in ([], [occurrence, Occurrence('Parent:2+Child:1', component)]):
            self.root.allOccurrences = Collection(matches)
            for operation in ('measure.distance', 'measure.angle', 'measure.thickness'):
                with self.subTest(count=len(matches), operation=operation):
                    with self.assertRaisesRegex(ValueError, 'unique root-context occurrence; found %d' % len(matches)):
                        self.call(operation, data)
                    self.assertEqual(self.measurements.calls, [])

    def test_minimum_child_edges_vertices_points_restore_local_closest_points(self):
        component, occurrence, front, back, data = self.child_measurement_fixture()
        sketch = Entity('Sketch', 'ChildSketch', parentComponent=component)
        for kind, owner in (('BRepFace', {'body': front.body}), ('BRepEdge', {'body': front.body}),
                            ('BRepVertex', {'body': front.body}), ('ConstructionPoint', {'parentComponent': component}),
                            ('SketchPoint', {'parentSketch': sketch})):
            with self.subTest(kind=kind):
                entities = [Entity(kind, kind + str(i), measurementPoint=Point(*p), **owner)
                            for i, p in enumerate(((1, 2, 3), (4, 6, 3)))]
                refs = [self.add(e) for e in entities]
                with self.assertRaisesRegex(RuntimeError, 'invalid argument geometryOne'):
                    self.measurements.measureMinimumDistance(*entities)
                result = self.call('measure.distance', dict(zip(('a', 'b'), refs)))
                self.assertEqual(result['context']['space'], 'component local')
                self.assertAlmostEqual(result['value'], 50)
                for actual, expected in zip(sum(result['points'], []), [10, 20, 30, 40, 60, 30]):
                    self.assertAlmostEqual(actual, expected)
                self.assertEqual([e.nativeObject for e in self.measurements.calls[-1]], entities)
                self.assertTrue(all(e.assemblyContext is occurrence for e in self.measurements.calls[-1]))
                self.assertEqual(NS['_cad_xyz'](occurrence.transform2.translation), [10, 20, 30])
                self.assertEqual(occurrence.transform2.angle, math.pi / 2)

    def test_angle_child_edges_and_three_points_use_same_unique_occurrence(self):
        component, occurrence, front, back, data = self.child_measurement_fixture()
        for kind, count, owner in (('BRepEdge', 2, {'body': front.body}),
                                    ('ConstructionPoint', 3, {'parentComponent': component})):
            entities = [Entity(kind, 'Angle' + str(i), **owner) for i in range(count)]
            refs = [self.add(e) for e in entities]
            with self.assertRaisesRegex(RuntimeError, 'invalid argument geometryOne'):
                self.measurements.measureAngle(*entities)
            result = self.call('measure.angle', dict(zip(('a', 'b', 'c'), refs)))
            self.assertEqual(result['value'], 90)
            self.assertEqual(result['context']['space'], 'component local')
            self.assertEqual([e.nativeObject for e in self.measurements.calls[-1]], entities)
            self.assertTrue(all(e.assemblyContext is occurrence for e in self.measurements.calls[-1]))

    def test_explicit_child_proxies_pass_unchanged_despite_multiple_instances(self):
        component, occurrence, front, back, data = self.child_measurement_fixture()
        self.root.allOccurrences.values.append(Occurrence('Parent:2+Child:1', component))
        proxies = [e.createForAssemblyContext(occurrence) for e in (front, back)]
        # Represent the API's common body proxy for these two faces.
        proxies[0].body = proxies[1].body = front.body.createForAssemblyContext(occurrence)
        for key, proxy in zip(('a', 'b'), proxies):
            token = 'Explicit' + key
            self.entities[token] = proxy
            data[key] = {'token': token}
        for operation, expected in (('measure.distance', 5), ('measure.angle', 90), ('measure.thickness', 5)):
            result = self.call(operation, data)
            self.assertEqual(result['value'], expected)
            self.assertEqual(result['context']['space'], 'assembly')
            self.assertEqual(self.measurements.calls[-1], tuple(proxies))
            if operation == 'measure.distance':
                self.assertEqual(result['points'], [[100, 200, 300], [100, 200, 305]])
        # Qualification through the actual core resolver also bypasses uniqueness inference.
        explicit = {key: {'token': e.entityToken, 'occurrence': occurrence.fullPathName}
                    for key, e in zip(('a', 'b'), (front, back))}
        self.assertEqual(self.call('measure.distance', explicit)['context']['space'], 'assembly')

    def test_thickness_finite_face_overlap_and_planarity_guards(self):
        front = self.face('Front', Entity('Plane', 'p1', origin=Point(), normal=Point(0, 0, 2)))
        back = self.face('Back', Entity('Plane', 'p2', origin=Point(3, 0, 0.5), normal=Point(0, 0, -3)))
        front.boundingBox = types.SimpleNamespace(minPoint=Point(), maxPoint=Point(1, 1, 0))
        back.boundingBox = types.SimpleNamespace(minPoint=Point(3, 0, 0.5), maxPoint=Point(4, 1, 0.5))
        data = {'a': {'token': 'Front'}, 'b': {'token': 'Back'}}
        with self.assertRaisesRegex(ValueError, 'no normal overlap'):
            self.call('measure.thickness', data)
        self.assertEqual(self.measurements.calls, [(front, back)])
        back.geometry.origin = Point()
        with self.assertRaisesRegex(ValueError, 'coincident'):
            self.call('measure.thickness', data)
        back.geometry = Entity('Cylinder', 'cylinder', radius=1)
        with self.assertRaisesRegex(ValueError, 'planar faces'):
            self.call('measure.thickness', data)
        back.body = Body('Other', self.root)
        with self.assertRaisesRegex(ValueError, 'same body'):
            self.call('measure.thickness', data)

    def test_interference_containment_separation_and_contact(self):
        self.add(Body('Inner', self.root, (0.25, 0.25, 0.25), (0.75, 0.75, 0.75)))
        overlap = self.call('assembly.interference', {'a': 'BodyA', 'b': 'Inner'})
        self.assertTrue(overlap['interferes'])
        self.assertEqual(overlap['overlapVolume']['value'], 125)
        self.assertEqual(overlap['distance']['value'], 0)
        self.assertFalse(overlap['passed'])
        self.add(Body('Touch', self.root, (1, 0, 0), (2, 1, 1)))
        touch = self.call('assembly.clearance', {'a': 'BodyA', 'b': 'Touch', 'minimum': '0.1 mm'})
        self.assertFalse(touch['interferes'])
        self.assertFalse(touch['passed'])
        self.assertEqual(touch['distance']['value'], 0)
        self.assertEqual(self.body.volume, 1)

    def test_boolean_failure_never_passes_and_surface_rejected(self):
        self.add(Body('Other', self.root))
        MANAGER.boolean_ok = False
        with self.assertRaisesRegex(RuntimeError, 'Temporary intersection'):
            self.call('assembly.interference', {'a': 'BodyA', 'b': 'Other'})
        MANAGER.boolean_ok = True
        self.body.isSolid = False
        with self.assertRaisesRegex(ValueError, 'solid'):
            self.call('assembly.clearance', {'a': 'BodyA', 'b': 'Other'})

    def test_motion_samples_are_independent_and_not_continuous(self):
        self.add(Body('Obstacle', self.root, (2, 0, 0), (3, 1, 1)))
        data = {'moving': 'BodyA', 'obstacles': ['Obstacle'],
                'translations': [['0 mm', '0 mm', '0 mm'], ['20 mm', '0 mm', '0 mm'], ['40 mm', '0 mm', '0 mm']]}
        result = self.call('assembly.motion_check', data)
        self.assertEqual([s['passed'] for s in result['samples']], [True, False, True])
        self.assertFalse(result['sampledPassed'])
        self.assertFalse(result['continuousMotionVerified'])
        self.assertEqual(self.body.boundingBox.minPoint.x, 0)
        self.assertEqual(self.computes, 0)
        with self.assertRaisesRegex(ValueError, 'continuous sweep'):
            self.call('assembly.motion_check', dict(data, mode='joint'))

    def test_check_uses_external_dimensional_limits(self):
        spec = {'measurement': {'operation': 'measure.volume', 'data': {'ref': 'BodyA'}},
                'expected': '1 cm^3', 'tolerance': '1 mm^3', 'source': 'test specification'}
        result = self.call('check', spec)
        self.assertTrue(result['passed'])
        self.assertEqual(result['acceptance'], {'min': 999, 'max': 1001, 'units': 'mm3'})
        self.assertFalse(self.call('check', dict(spec, expected='2 cm^3'))['passed'])
        for extra in ({'expected': '2 mm'}, {'tolerance': '-1 mm^3'}, {'max': '2 cm^3'}):
            with self.assertRaises(ValueError):
                self.call('check', dict(spec, **extra))

    def test_compare_bodies_uses_bidirectional_csg_not_equal_volume(self):
        elongated = Body('EqualVolumeDifferentShape', self.root, (0, 0, 0), (0.5, 1, 2))
        self.add(elongated)
        frame = NS['_measure_space'](self.ctx, [self.body])
        same = NS['_measure_compare_bodies'](self.ctx, 'BodyA', 'BodyA', frame,
            '0 mm^3', '0 mm', '0 deg')
        self.assertTrue(same['equal'])
        self.assertTrue(same['emptyDifference']['aMinusB'])
        self.assertTrue(same['emptyDifference']['bMinusA'])
        different = NS['_measure_compare_bodies'](self.ctx, 'BodyA', 'EqualVolumeDifferentShape', frame,
            '0.01 mm^3', '0 mm', '0 deg')
        self.assertEqual(self.body.volume, elongated.volume)
        self.assertFalse(different['volumeEqual'])
        self.assertGreater(different['aMinusB']['value'], 0)
        self.assertGreater(different['bMinusA']['value'], 0)
        self.assertFalse(different['equal'])
        self.assertFalse(self.body.temporary)
        self.assertFalse(elongated.temporary)

    def test_compare_bodies_restores_a_serialized_frame_for_temporary_baselines(self):
        frame = NS['_measure_space'](self.ctx, [self.body])
        captured = NS['_measure_temporary_body'](self.ctx, 'BodyA', frame)
        restored = NS['_MeasureTemporaryBody'](captured.body, frame['space'], captured.transform)

        result = NS['_measure_compare_bodies'](self.ctx, restored, 'BodyA', frame['space'],
            '0 mm^3', '0 mm', '0 deg')

        self.assertTrue(result['volumeEqual'])
        self.assertTrue(result['poseEqual'])
        self.assertTrue(result['emptyDifference']['aMinusB'])
        self.assertTrue(result['emptyDifference']['bMinusA'])

    def test_compare_bodies_requires_a_shared_declared_frame_and_propagates_boolean_failure(self):
        child = Entity('Component', 'Child', bRepBodies=Collection())
        self.ctx.design.allComponents.values.append(child)
        child_body = Body('ChildBody', child)
        self.add(child_body)
        with self.assertRaisesRegex(ValueError, 'frame|Mixed coordinate contexts'):
            NS['_measure_compare_bodies'](self.ctx, 'BodyA', {'token': child_body.entityToken},
                {'space': 'component local', 'component': self.ctx.ref(self.root)},
                '0 mm^3', '0 mm', '0 deg')
        MANAGER.boolean_ok = False
        try:
            frame = NS['_measure_space'](self.ctx, [self.body, self.body])
            with self.assertRaisesRegex(RuntimeError, 'Boolean difference failed'):
                NS['_measure_compare_bodies'](self.ctx, 'BodyA', 'BodyA', frame,
                    '0 mm^3', '0 mm', '0 deg')
        finally:
            MANAGER.boolean_ok = True

    def test_compare_bodies_pose_rotation_identity_90_and_180(self):
        proxies = []
        for index, angle in enumerate((0, math.pi / 2, math.pi)):
            occurrence = Occurrence('Pose%d:1' % index, self.root, angle=angle)
            self.root.allOccurrences.values.append(occurrence)
            proxy = self.body.createForAssemblyContext(occurrence)
            proxy.entityToken = 'PoseProxy%d' % index
            self.add(proxy)
            self.entities[proxy.entityToken] = proxy
            proxies.append(proxy)
        frame = {'space': 'assembly', 'component': self.ctx.ref(self.root)}
        for proxy in proxies:
            result = NS['_measure_compare_bodies'](self.ctx, {'token': proxy.entityToken},
                {'token': proxy.entityToken}, frame, '0 mm^3', '0 mm', '0.1 deg')
            self.assertTrue(result['poseEqual'])
            self.assertAlmostEqual(result['rotationDelta']['value'], 0, places=9)
        for proxy, angle in zip(proxies[1:], (math.pi / 2, math.pi)):
            result = NS['_measure_compare_bodies'](self.ctx, {'token': proxies[0].entityToken},
                {'token': proxy.entityToken}, frame, '0 mm^3', '0 mm', '0.1 deg')
            self.assertAlmostEqual(result['rotationDelta']['value'], angle, places=7)
            self.assertFalse(result['poseEqual'])

    def parameter_test(self, **extra):
        return self.call('parameter.test', dict(parameter='width', expressions=['20 mm'], confirm=True, **extra))

    def parameter_test_v2(self, cases, **extra):
        return self.call('parameter.test', dict(cases=cases, confirm=True, **extra))

    def test_parameter_requires_confirmation_before_mutation(self):
        with self.assertRaisesRegex(ValueError, 'confirm'):
            self.call('parameter.test', {'parameter': 'width', 'expressions': ['20 mm'], 'confirm': False})
        self.assertEqual(self.parameter.writes, [])

    def test_parameter_success_restores_and_recomputes(self):
        result = self.parameter_test()
        self.assertTrue(result['passed'])
        self.assertTrue(result['restored'])
        self.assertEqual(self.parameter.expression, '10 mm')
        self.assertEqual(self.parameter.writes, ['20 mm', '10 mm'])
        self.assertEqual(self.computes, 2)

    def test_parameter_failure_after_setter_mutation_still_restores(self):
        self.parameter.fail_sample = True
        result = self.parameter_test()
        self.assertFalse(result['passed'])
        self.assertIn('sample setter failed', result['error'])
        self.assertTrue(result['restored'])
        self.assertEqual(self.parameter.expression, '10 mm')

    def test_parameter_original_and_restore_failures_both_reported(self):
        self.parameter.fail_sample = self.parameter.fail_restore = True
        result = self.parameter_test()
        self.assertFalse(result['passed'])
        self.assertFalse(result['restored'])
        self.assertIn('sample setter failed', result['error'])
        self.assertTrue(any('restore setter failed' in e for e in result['restoreErrors']))
        self.assertEqual(self.computes, 1)

    def test_parameter_recompute_failure_and_restore_health(self):
        self.compute_actions = [RuntimeError('sample compute failure'), 0]
        result = self.parameter_test()
        self.assertFalse(result['passed'])
        self.assertTrue(result['restored'])
        self.assertIn('sample compute failure', result['error'])
        self.assertEqual(result['restoredHealth'][0]['state'], 'HealthyFeatureHealthState')

    def test_parameter_warning_fails_even_when_compute_returns_true(self):
        self.compute_actions = [1, 0]
        result = self.parameter_test()
        self.assertFalse(result['passed'])
        self.assertFalse(result['samples'][0]['passed'])
        self.assertTrue(result['restored'])

    def test_parameter_restore_health_change_is_failure(self):
        self.compute_actions = [0, 2]
        result = self.parameter_test()
        self.assertFalse(result['restored'])
        self.assertIn('Timeline health differs', result['restoreErrors'][0])

    def test_parameter_restore_recompute_failure_does_not_mask_sample_error(self):
        self.compute_actions = [RuntimeError('sample failed'), RuntimeError('restore failed')]
        result = self.parameter_test()
        self.assertIn('sample failed', result['error'])
        self.assertTrue(any('restore failed' in error for error in result['restoreErrors']))
        self.assertFalse(result['restored'])
        self.assertIsNotNone(result['restoredHealth'])

    def test_parameter_invalid_units_rejected_before_mutation(self):
        with self.assertRaises(ValueError):
            self.call('parameter.test', {'parameter': 'width', 'expressions': ['20 deg'], 'confirm': True})
        self.assertEqual(self.parameter.writes, [])

    def test_failed_acceptance_check_is_not_a_transport_error(self):
        check = {'measurement': {'operation': 'measure.volume', 'data': {'ref': 'BodyA'}}, 'min': '2 cm^3'}
        result = self.parameter_test(checks=[check])
        self.assertFalse(result['passed'])
        self.assertIsNone(result['error'])
        self.assertTrue(result['restored'])

    def test_parameter_check_failure_restores(self):
        check = {'measurement': {'operation': 'measure.volume', 'data': {'ref': 'missing'}}, 'min': '1 mm^3'}
        with self.assertRaisesRegex(ValueError, 'Reference missing'):
            self.parameter_test(checks=[check])
        self.assertEqual(self.parameter.writes, [])
        self.assertEqual(self.parameter.expression, '10 mm')

    def test_parameter_v2_cases_restore_baseline_between_cases(self):
        cases = [
            {'id': 'short', 'assign': [{'parameter': 'width', 'expression': '20 mm'}]},
            {'id': 'long', 'assign': [{'parameter': 'width', 'expression': '30 mm'}]},
        ]
        result = self.parameter_test_v2(cases)
        self.assertTrue(result['passed'])
        self.assertEqual(result['status'], 'pass')
        self.assertEqual([case['id'] for case in result['cases']], ['short', 'long'])
        self.assertEqual(self.parameter.writes, ['20 mm', '10 mm', '30 mm', '10 mm'])
        self.assertEqual(self.parameter.expression, '10 mm')
        self.assertEqual(self.computes, 4)
        self.assertGreaterEqual(result['restorationReserveMsUsed'], 0)
        self.assertGreaterEqual(result['actualElapsedMs'], 0)
        self.assertFalse(result['budgetExceeded'])
        self.assertFalse(result['budgetExhausted'])

    def test_parameter_v2_prevalidates_all_cases_before_first_setter(self):
        cases = [
            {'id': 'valid', 'assign': [{'parameter': 'width', 'expression': '20 mm'}]},
            {'id': 'invalid', 'assign': [{'parameter': 'width', 'expression': '20 deg'}]},
        ]
        with self.assertRaisesRegex(ValueError, 'expression|unit'):
            self.parameter_test_v2(cases)
        self.assertEqual(self.parameter.writes, [])
        self.assertEqual(self.computes, 0)

    def test_parameter_v2_limits_and_legacy_form_are_preflight_only(self):
        legacy_and_v2 = {'parameter': 'width', 'expressions': ['20 mm'], 'cases': [], 'confirm': True}
        with self.assertRaisesRegex(ValueError, 'mutually exclusive'):
            self.call('parameter.test', legacy_and_v2)
        too_many_cases = [{'id': 'case-%d' % index,
                           'assign': [{'parameter': 'width', 'expression': '20 mm'}]}
                          for index in range(1001)]
        with self.assertRaisesRegex(ValueError, '1..1000'):
            self.parameter_test_v2(too_many_cases)
        parameters = []
        for index in range(11):
            parameter = Parameter()
            parameter.name = 'parameter%d' % index
            parameter.entityToken = parameter.name
            self.entities[parameter.name] = parameter
            self.ctx.design.allParameters.values.append(parameter)
            self.ctx.design.userParameters.values.append(parameter)
            parameters.append(parameter)
        assignments = [{'parameter': parameter.name, 'expression': '20 mm'} for parameter in parameters]
        too_many_assignments = [{'id': 'case-%d' % index, 'assign': assignments} for index in range(1000)]
        with self.assertRaisesRegex(ValueError, '10000 assignments'):
            self.parameter_test_v2(too_many_assignments)
        self.assertTrue(all(not parameter.writes for parameter in [self.parameter] + parameters))

    def test_parameter_v2_restores_all_assignments_after_partial_setter_failure(self):
        height = Parameter()
        height.name = 'height'
        self.entities['height'] = height
        self.ctx.design.allParameters.values.append(height)
        self.ctx.design.userParameters.values.append(height)
        self.parameter.fail_sample = True
        cases = [
            {'id': 'partial', 'assign': [
                {'parameter': 'width', 'expression': '20 mm'},
                {'parameter': 'height', 'expression': '15 mm'}]},
            {'id': 'continues-after-restored-error', 'assign': [
                {'parameter': 'width', 'expression': '12 mm'}]},
        ]
        result = self.parameter_test_v2(cases)
        self.assertFalse(result['passed'])
        self.assertIn('sample setter failed after mutation', result['primaryError']['message'])
        self.assertEqual([case['status'] for case in result['cases']], ['fail', 'pass'])
        self.assertTrue(result['cases'][0]['restored'])
        self.assertEqual(self.parameter.expression, '10 mm')
        self.assertEqual(height.expression, '10 mm')
        self.assertEqual(height.writes, ['10 mm'])

    def test_parameter_v2_recompute_error_stays_primary_and_finally_restores(self):
        self.compute_actions = [RuntimeError('sample recompute failed'), 0]
        result = self.parameter_test_v2([{'id': 'recompute',
            'assign': [{'parameter': 'width', 'expression': '20 mm'}]}])
        self.assertIn('sample recompute failed', result['primaryError']['message'])
        self.assertTrue(result['cases'][0]['restored'])
        self.assertEqual(result['restoreErrors'], [])
        self.assertEqual(self.parameter.expression, '10 mm')
        self.assertEqual(self.computes, 2)

    def test_parameter_v2_collects_all_restore_faults_without_masking_primary(self):
        height = Parameter()
        height.name = 'height'
        height.entityToken = 'height'
        self.entities['height'] = height
        self.ctx.design.allParameters.values.append(height)
        self.ctx.design.userParameters.values.append(height)
        self.parameter.fail_sample = self.parameter.fail_restore = True
        self.compute_actions = [RuntimeError('restore recompute failed')]
        cases = [{'id': 'restore-faults', 'assign': [
            {'parameter': 'width', 'expression': '20 mm'},
            {'parameter': 'height', 'expression': '15 mm'}]}]

        def check_restored(spec, restored):
            raise RuntimeError('restore oracle failed')

        result = NS['_measure_parameter_test'](self.ctx, {'cases': cases, 'confirm': True},
                                               lambda spec, case: True, check_restored)
        self.assertIn('sample setter failed after mutation', result['primaryError']['message'])
        self.assertFalse(result['cases'][0]['restored'])
        self.assertTrue(any('restore setter failed' in row['message'] for row in result['restoreErrors']))
        self.assertTrue(any('restore recompute failed' in row['message'] for row in result['restoreErrors']))
        self.assertTrue(any('restore oracle failed' in row['message'] for row in result['restoreErrors']))
        self.assertIn('10 mm', height.writes)

    def test_parameter_v2_callback_failures_still_restore_and_are_separate(self):
        cases = [{'id': 'oracle', 'assign': [{'parameter': 'width', 'expression': '20 mm'}]}]
        calls = []

        def check_case(spec, case):
            calls.append('case')
            raise RuntimeError('independent oracle failed')

        def check_restored(spec, restored):
            calls.append('restored')
            raise RuntimeError('restore oracle failed')

        result = NS['_measure_parameter_test'](self.ctx,
            {'cases': cases, 'confirm': True}, check_case, check_restored)
        self.assertIn('independent oracle failed', result['primaryError']['message'])
        self.assertTrue(any('restore oracle failed' in row['message'] for row in result['restoreErrors']))
        self.assertFalse(result['passed'])
        self.assertEqual(calls, ['case', 'restored'])
        self.assertEqual(self.parameter.expression, '10 mm')

    def test_parameter_v2_callbacks_can_use_local_temporary_body_oracle(self):
        frame = NS['_measure_space'](self.ctx, [self.body])
        calls = []
        baseline = NS['_measure_temporary_body'](self.ctx, 'BodyA', frame)

        def check_case(spec, report):
            result = NS['_measure_compare_bodies'](self.ctx, 'BodyA', 'BodyA', frame,
                '0.001 mm^3', '0.001 mm', '0.01 deg')
            calls.append(result['equal'])
            return result['equal']

        def check_restored(spec, report):
            result = NS['_measure_compare_bodies'](self.ctx, baseline, 'BodyA', frame,
                '0.001 mm^3', '0.001 mm', '0.01 deg')
            calls.append(result['equal'])
            return result['equal']

        result = NS['_measure_parameter_test'](self.ctx, {
            'cases': [{'id': 'temp-oracle', 'assign': [{'parameter': 'width', 'expression': '20 mm'}]}],
            'confirm': True}, check_case, check_restored)
        self.assertTrue(result['passed'])
        self.assertEqual(calls, [True, True])
        self.assertFalse(self.body.temporary)
        self.assertEqual(self.body.volume, 1)

    def test_parameter_v2_runs_only_local_measurements_and_never_publishes(self):
        calls = []
        original_call = self.ctx.call

        def tracked_call(operation, data):
            calls.append(operation)
            return original_call(operation, data)

        self.ctx.call = tracked_call
        check = {'measurement': {'operation': 'measure.volume', 'data': {'ref': 'BodyA'}}, 'min': '1 mm^3'}
        result = self.parameter_test_v2([{'id': 'local',
            'assign': [{'parameter': 'width', 'expression': '20 mm'}], 'checks': [check]}])
        self.assertTrue(result['passed'])
        self.assertTrue(calls)
        self.assertEqual(set(calls), {'parameter.test', 'measure.volume'}, calls)
        self.assertFalse(any(any(word in operation for word in ('save', 'upload', 'publish')) for operation in calls))

    def test_parameter_v2_rejects_async_callbacks_and_still_restores(self):
        async def async_callback(spec, report):
            return True

        result = NS['_measure_parameter_test'](self.ctx, {
            'cases': [{'id': 'async', 'assign': [{'parameter': 'width', 'expression': '20 mm'}]}],
            'confirm': True}, async_callback, lambda spec, report: True)
        self.assertFalse(result['passed'])
        self.assertIn('Asynchronous parameter-test callbacks are unsupported', result['primaryError']['message'])
        self.assertTrue(result['restored'])
        self.assertEqual(self.parameter.expression, '10 mm')

    def test_parameter_v2_reserve_exhaustion_skips_required_cases_without_mutation(self):
        cases = [{'id': 'one', 'assign': [{'parameter': 'width', 'expression': '20 mm'}]},
                 {'id': 'two', 'assign': [{'parameter': 'width', 'expression': '30 mm'}]}]
        result = self.parameter_test_v2(cases, timeBudgetMs=1000)
        self.assertFalse(result['passed'])
        self.assertEqual(result['status'], 'partial')
        self.assertTrue(result['budgetExhausted'])
        self.assertFalse(result['budgetExceeded'])
        self.assertEqual(result['continuation']['reason'], 'budgetExhausted')
        self.assertEqual(result['coverage']['skipped'], 2)
        self.assertEqual(self.parameter.writes, [])

    def test_parameter_v2_completes_final_oracle_after_deadline_and_restores(self):
        self.clock = {'now': 0.0}
        cases = [{'id': 'final-call', 'assign': [{'parameter': 'width', 'expression': '20 mm'}]}]

        def check_case(spec, case):
            self.clock['now'] += 2.5
            return True

        def check_restored(spec, restored):
            self.clock['now'] += 0.05
            return True

        with patch.object(NS['time'], 'monotonic', lambda: self.clock['now']):
            result = NS['_measure_parameter_test'](self.ctx,
                {'cases': cases, 'confirm': True, 'timeBudgetMs': 2000},
                check_case, check_restored)
        self.assertTrue(result['passed'])
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['budgetExceeded'])
        self.assertFalse(result['budgetExhausted'])
        self.assertGreaterEqual(result['actualElapsedMs'], 2500)
        self.assertAlmostEqual(result['restorationReserveMsUsed'], 50, places=6)
        self.assertEqual(self.parameter.expression, '10 mm')
        self.assertEqual(self.parameter.writes, ['20 mm', '10 mm'])

    def test_parameter_v2_overrun_restores_current_case_and_skips_the_next(self):
        self.clock = {'now': 0.0}
        cases = [{'id': 'slow', 'assign': [{'parameter': 'width', 'expression': '20 mm'}]},
                 {'id': 'must-not-start', 'assign': [{'parameter': 'width', 'expression': '30 mm'}]}]
        callbacks = []

        def check_case(spec, case):
            callbacks.append(case['id'])
            self.clock['now'] += 5.0
            return True

        def check_restored(spec, restored):
            self.clock['now'] += 0.05
            return True

        with patch.object(NS['time'], 'monotonic', lambda: self.clock['now']):
            result = NS['_measure_parameter_test'](self.ctx,
                {'cases': cases, 'confirm': True, 'timeBudgetMs': 4000},
                check_case, check_restored)
        self.assertEqual(callbacks, ['slow'])
        self.assertTrue(result['budgetExceeded'])
        self.assertTrue(result['budgetExhausted'])
        self.assertEqual(result['status'], 'partial')
        self.assertFalse(result['passed'])
        self.assertTrue(result['cases'][0]['restored'])
        self.assertAlmostEqual(result['restorationReserveMsUsed'], 50, places=6)
        self.assertEqual(result['cases'][1]['status'], 'skipped')
        self.assertEqual(self.parameter.expression, '10 mm')

    def test_audit_real_counts_parameters_warnings_pure_read(self):
        self.root.sketches.values.extend([object(), object()])
        self.root.features.values.append(object())
        self.health.healthState, self.health.errorOrWarningMessage = 1, 'Missing reference'
        result = self.call('audit', {})
        self.assertEqual(result['counts']['bodyDefinitions'], 1)
        self.assertEqual(result['counts']['sketchDefinitions'], 2)
        self.assertEqual(result['counts']['featureDefinitions'], 1)
        self.assertEqual(result['parameters'][0]['expression'], '10 mm')
        self.assertEqual(result['issues'][0]['message'], 'Missing reference')
        self.assertEqual(result['components'][0]['bodies'][0]['volume']['units'], 'mm3')
        self.assertEqual(self.computes, 0)
        self.assertEqual(self.parameter.writes, [])
        json.dumps(result, allow_nan=False)

    def test_snapshot_inventory_includes_hidden_solid_bodies(self):
        self.body.isVisible = False
        result = self.call('snapshot', {})
        bodies = result['components'][0]['bodies']
        self.assertEqual(len(bodies), 1)
        self.assertEqual(bodies[0]['ref']['name'], 'BodyA')

    def test_snapshot_issues_skip_duplicate_timeline_entity_rows(self):
        duplicate = types.SimpleNamespace(entity=self.health, name='duplicate timeline binding',
                                          healthState=self.health.healthState,
                                          isSuppressed=False, isRolledBack=False)
        self.ctx.design.timeline = Collection([self.health, duplicate])
        result = self.call('snapshot', {})
        self.assertEqual(result['timeline'][1]['duplicate'], True)
        self.assertEqual(result['issues'], [])

    def test_snapshot_inventory_includes_hidden_solid_bodies(self):
        self.body.isVisible = False
        result = self.call('snapshot', {})
        bodies = result['components'][0]['bodies']
        self.assertEqual(len(bodies), 1)
        self.assertEqual(bodies[0]['ref']['name'], 'BodyA')

    def test_snapshot_diff_ignores_tokens_but_detects_real_changes(self):
        before = self.call('snapshot', {})
        after = copy.deepcopy(before)
        after['components'][0]['ref']['token'] = 'new-token-same-entity'
        self.assertFalse(self.call('diff', {'before': before, 'after': after})['changed'])
        after['parameters'][0]['expression'] = '12 mm'
        result = self.call('diff', {'before': before, 'after': after})
        self.assertEqual(result['changes'][0]['path'], '/parameters/0/expression')
        self.assertFalse(self.call('diff', {'before': before})['changed'])
        with self.assertRaisesRegex(ValueError, 'snapshot data'):
            self.call('diff', {'before': 'some-file.json'})

    def test_status_and_report_never_invent_acceptance(self):
        self.assertEqual(self.call('status', {})['acceptance'], 'notEvaluated')
        result = self.call('report', {'metadata': {'status': 'accepted'}})
        self.assertEqual(result['checkOutcome'], 'notEvaluated')
        self.assertFalse(result['metadataVerified'])
        self.assertEqual(result['status']['acceptance'], 'notEvaluated')
        self.assertEqual(result['userMetadata']['status'], 'accepted')
        with self.assertRaises(ValueError):
            self.call('status', {'accepted': True})


if __name__ == '__main__':
    unittest.main()
