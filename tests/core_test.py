"""Offline contract tests. These stubs do not validate Fusion kernel behavior."""
import importlib.util
import json
import math
from pathlib import Path
import re
import sys
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/cad/core.py'
CATALOG = ROOT / 'src/catalog/core.json'


class Items:
    def __init__(self, items=()):
        self.items = list(items)

    @property
    def count(self):
        return len(self.items)

    def item(self, index):
        return self.items[index]

    def itemByName(self, name):
        return next((x for x in self.items if x.name == name), None)

    def add(self, entity):
        self.items.append(entity)
        return True


class Attributes:
    def __init__(self):
        self.values = {}
        self.writes = 0

    def itemByName(self, group, name):
        return self.values.get((group, name))

    def add(self, group, name, value):
        self.writes += 1
        result = types.SimpleNamespace(value=value)
        self.values[group, name] = result
        return result


class Entity:
    def __init__(self, kind, name=None, owner=None):
        self.objectType = 'adsk::fusion::' + kind
        self.entityToken = 'token-' + str(id(self))
        if name is not None:
            self.name = name
        if owner is not None:
            self.parentComponent = owner
        self.attributes = Attributes()
        self.assemblyContext = None
        self.nativeObject = None

    def createForAssemblyContext(self, occurrence):
        if self.assemblyContext is not None:
            raise ValueError('Only native entities can create proxies')
        if self.parentComponent != occurrence.component:
            raise ValueError('Wrong occurrence for native entity')
        proxy = Entity(self.objectType.split('::')[-1])
        proxy.__dict__.update(self.__dict__)
        proxy.nativeObject = self
        proxy.assemblyContext = occurrence
        return proxy

    def __eq__(self, other):
        return isinstance(other, Entity) and self.entityToken == other.entityToken and self.assemblyContext is other.assemblyContext


class ConstructionOwnerRegression(unittest.TestCase):
    def test_construction_geometry_component_property(self):
        spec = importlib.util.spec_from_file_location('construction_owner_core', SOURCE)
        module = importlib.util.module_from_spec(spec)
        adsk = types.ModuleType('adsk')
        adsk.core = types.ModuleType('adsk.core')
        adsk.fusion = types.ModuleType('adsk.fusion')
        with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
            values = ROOT / 'runtime/python/fmcad/domain/values.py'
            exec(compile(values.read_text(), str(values), 'exec'), module.__dict__)
            spec.loader.exec_module(module)
        owner = Entity('Component', 'Part')
        for kind in ('ConstructionPlane', 'ConstructionAxis', 'ConstructionPoint'):
            datum = Entity(kind, 'Base')
            datum.component = owner
            self.assertIs(module._cad_owner(datum), owner)


class Point:
    objectType = 'adsk::core::Point3D'

    def __init__(self, x, y, z):
        self.x, self.y, self.z = x, y, z

    @staticmethod
    def create(x, y, z):
        return Point(x, y, z)


class Matrix:
    objectType = 'adsk::core::Matrix3D'

    @staticmethod
    def create():
        return Matrix()

    def setWithCoordinateSystem(self, origin, x, y, z):
        self.values = [x.x, y.x, z.x, origin.x, x.y, y.y, z.y, origin.y,
                       x.z, y.z, z.z, origin.z, 0, 0, 0, 1]
        return True

    def asArray(self):
        return self.values


class Quantity:
    def __init__(self, value, dimension=''):
        self.value, self.dimension = value, dimension

    @staticmethod
    def coerce(other):
        return other if isinstance(other, Quantity) else Quantity(other)

    def __add__(self, other):
        other = self.coerce(other)
        if self.dimension != other.dimension:
            raise ValueError('Incompatible units')
        return Quantity(self.value + other.value, self.dimension)

    __radd__ = __add__

    def __neg__(self):
        return Quantity(-self.value, self.dimension)

    def __sub__(self, other):
        return self + -self.coerce(other)

    def __mul__(self, other):
        other = self.coerce(other)
        if self.dimension and other.dimension:
            raise ValueError('Test evaluator only implements scalar multiplication')
        return Quantity(self.value * other.value, self.dimension or other.dimension)

    __rmul__ = __mul__

    def __truediv__(self, other):
        other = self.coerce(other)
        if other.dimension and self.dimension != other.dimension:
            raise ValueError('Incompatible quotient')
        return Quantity(self.value / other.value, '' if other.dimension else self.dimension)


class Units:
    units = {'mm': (0.1, 'length'), 'cm': (1, 'length'), 'in': (2.54, 'length'),
             'rad': (1, 'angle'), 'deg': (math.pi / 180, 'angle'), '': (1, ''),
             'cm/cm': (1, '')}

    def __init__(self):
        self.parameters = Items()
        self.defaultLengthUnits = 'mm'
        self.calls = []

    def parse(self, expression, seen=()):
        values = {'Q': Quantity, 'pi': math.pi, 'abs': lambda q: Quantity(abs(q.value), q.dimension)}
        for parameter in self.parameters.items:
            if parameter.name not in seen and re.search(r'\b' + re.escape(parameter.name) + r'\b', expression):
                value = self.parse(parameter.expression, (*seen, parameter.name))
                if not value.dimension and parameter.unit:
                    factor, dimension = self.units[parameter.unit]
                    value = Quantity(value.value * factor, dimension)
                values[parameter.name] = value
        expression = re.sub(r'(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\s*(mm|cm|in|rad|deg)\b',
                            lambda m: 'Q(%s,%r)' % (float(m[1]) * self.units[m[2]][0], self.units[m[2]][1]), expression)
        return Quantity.coerce(eval(expression, {'__builtins__': {}}, values))

    def isValidExpression(self, expression, unit):
        self.calls.append(('isValidExpression', expression, unit))
        try:
            result = self.parse(expression)
            # Fusion accepts explicitly dimensioned expressions with units=''.
            # This is a default/inferred context, NOT a dimensionless type check.
            if unit == '':
                return True
            expected = self.units[unit][1]
            return result.dimension in (expected, '')
        except (ValueError, TypeError, KeyError, NameError, SyntaxError, ZeroDivisionError):
            return False

    def evaluateExpression(self, expression, unit):
        self.calls.append(('evaluateExpression', expression, unit))
        result = self.parse(expression)
        if not result.dimension:
            return result.value * self.units[unit or self.defaultLengthUnits][0]
        return result.value

    def standardizeExpression(self, expression, unit):
        self.calls.append(('standardizeExpression', expression, unit))
        if not self.isValidExpression(expression, unit):
            return ''
        if not self.parse(expression).dimension and unit not in ('cm/cm',):
            if re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?', expression.strip()):
                return expression.strip() + ' ' + (unit or self.defaultLengthUnits)
            return '(%s) * (1 %s)' % (expression, unit or self.defaultLengthUnits)
        return expression


class Parameters(Items):
    def __init__(self, units):
        super().__init__()
        self.units = units
        self.writes = []

    def add(self, name, expression, unit, comment):
        parameter = Entity('UserParameter', name)
        parameter.expression, parameter.unit, parameter.comment = expression, unit, comment
        parameter.value = self.units.evaluateExpression(expression, unit or 'cm/cm')
        self.items.append(parameter)
        self.writes.append(name)
        return parameter


class DatumInput:
    def __init__(self, succeeds=True):
        self.succeeds = succeeds
        self.creationOccurrence = None

    def __getattr__(self, name):
        if name not in ('setByOffset', 'setByAngle', 'setByTwoPlanes', 'setByCircularFace',
                        'setByTwoPoints', 'setByEdge', 'setByThreePlanes', 'setByPoint'):
            raise AttributeError(name)

        def define(*args):
            self.definition = (name, args)
            return self.succeeds

        return define


class Datums(Items):
    def __init__(self, kind, owner):
        super().__init__()
        self.kind, self.owner = kind, owner
        self.succeeds = True

    def createInput(self):
        return DatumInput(self.succeeds)

    def add(self, inp):
        entity = Entity(self.kind, self.kind, self.owner)
        entity.input = inp
        self.items.append(entity)
        return entity


def component(name):
    result = Entity('Component', name)
    for prop in ('bRepBodies', 'sketches', 'features', 'constructionPlanes', 'constructionAxes',
                 'constructionPoints', 'allOccurrences'):
        setattr(result, prop, Items())
    for short, prop, kind, normal in (
            ('XY', 'xYConstructionPlane', 'ConstructionPlane', [0, 0, 1]),
            ('XZ', 'xZConstructionPlane', 'ConstructionPlane', [0, -1, 0]),
            ('YZ', 'yZConstructionPlane', 'ConstructionPlane', [1, 0, 0]),
            ('X', 'xConstructionAxis', 'ConstructionAxis', [1, 0, 0]),
            ('Y', 'yConstructionAxis', 'ConstructionAxis', [0, 1, 0]),
            ('Z', 'zConstructionAxis', 'ConstructionAxis', [0, 0, 1]),
            ('origin', 'originConstructionPoint', 'ConstructionPoint', [0, 0, 0])):
        entity = Entity(kind, short, result)
        entity.geometry = types.SimpleNamespace(objectType='adsk::core::Plane', origin=Point(0, 0, 0), normal=Point(*normal))
        setattr(result, prop, entity)
    return result


def load_core(app):
    adsk = types.ModuleType('adsk')
    adsk.core = types.ModuleType('adsk.core')
    adsk.fusion = types.ModuleType('adsk.fusion')
    adsk.core.Application = types.SimpleNamespace(get=lambda: app)
    adsk.core.Point3D = Point
    adsk.core.Vector3D = Point
    adsk.core.Matrix3D = Matrix
    adsk.core.ValueInput = types.SimpleNamespace(createByString=lambda expression: expression)
    adsk.core.ObjectCollection = types.SimpleNamespace(create=Items)
    adsk.fusion.Design = types.SimpleNamespace(cast=lambda product: product)
    spec = importlib.util.spec_from_file_location('core_under_test', SOURCE)
    module = importlib.util.module_from_spec(spec)
    # Explicit compile verifies syntax without creating unowned __pycache__ files.
    with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
        values = ROOT / 'runtime/python/fmcad/domain/values.py'
        exec(compile(values.read_text(), str(values), 'exec'), module.__dict__)
        exec(compile(SOURCE.read_text(), str(SOURCE), 'exec'), module.__dict__)
        identity = SOURCE.with_name('identity.py')
        exec(compile(identity.read_text(), str(identity), 'exec'), module.__dict__)
        entity = SOURCE.with_name('entity.py')
        exec(compile(entity.read_text(), str(entity), 'exec'), module.__dict__)
    return module


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.root = component('Assembly')
        self.child = component('Part')
        self.units = Units()
        self.parameters = Parameters(self.units)
        self.units.parameters = self.parameters
        self.tokens = {}
        self.design = types.SimpleNamespace(rootComponent=self.root, allComponents=Items([self.root, self.child]),
            unitsManager=self.units, allParameters=self.parameters, userParameters=self.parameters,
            findEntityByToken=lambda token: self.tokens.get(token, []))
        self.requests = []

        def product(kind):
            self.requests.append(kind)
            return self.design

        self.doc = types.SimpleNamespace(name='Test', products=types.SimpleNamespace(itemByProductType=product),
            dataFile=types.SimpleNamespace(parentProject=types.SimpleNamespace(id='project-from-test')))
        self.app = types.SimpleNamespace(documents=Items([self.doc]), activeDocument=self.doc,
            userInterface=types.SimpleNamespace(activeSelections=Items()))
        self.core = load_core(self.app)
        self.ctx = self.core.CadContext('Test')
        self.register(self.root, self.child)

    def register(self, *entities):
        for entity in entities:
            self.tokens[entity.entityToken] = [entity]

    def test_rigid_as_built_joint_can_have_no_geometry(self):
        joint = Entity('AsBuiltJoint', 'Fixed', self.root)
        joint.geometry = None
        result = self.ctx.describe(joint)
        self.assertIsNone(result['geometry'])
        self.assertEqual(result['name'], 'Fixed')

    def body(self, name='Body', owner=None):
        owner = owner or self.root
        entity = Entity('BRepBody', name, owner)
        entity.faces, entity.edges, entity.vertices = Items(), Items(), Items()
        owner.bRepBodies.items.append(entity)
        self.register(entity)
        return entity

    def occurrence(self, name='Part:1'):
        entity = Entity('Occurrence', name)
        entity.component = self.child
        entity.fullPathName = name
        self.root.allOccurrences.items.append(entity)
        self.register(entity)
        return entity

    def profile_sketch(self, count):
        sketch = Entity('Sketch', 'Section', self.root)
        sketch.profiles, sketch.sketchPoints = Items(), Items()
        self.root.sketches.items.append(sketch)
        self.register(sketch)
        for i in range(count):
            profile = Entity('Profile')
            profile.parentSketch = sketch
            profile.profileLoops = Items([object()])
            profile.areaProperties = lambda: types.SimpleNamespace(area=12.5, centroid=Point(1, 2, 0))
            sketch.profiles.items.append(profile)
            self.register(profile)
        return sketch

    def apply(self, specifications, **kwargs):
        return self.ctx.call('param.apply', dict(parameters=specifications, **kwargs))

    def test_constructor_exact_signature_and_nonactive_document(self):
        self.app.activeDocument = object()
        ctx = self.core.CadContext(doc_name='Test', component_ref=None, project_id='project-from-test')
        self.assertIs(ctx.design, self.design)
        self.assertEqual(self.requests, ['DesignProductType', 'DesignProductType'])
        self.assertIsNot(self.app.activeDocument, self.doc)
        with self.assertRaisesRegex(ValueError, 'found 0'):
            self.core.CadContext('Test', project_id='other-project')

    def test_duplicate_documents_rejected(self):
        self.app.documents.items.append(self.doc)
        with self.assertRaisesRegex(ValueError, 'found 2'):
            self.core.CadContext('Test')

    def test_document_without_design_rejected(self):
        self.doc.products.itemByProductType = lambda kind: None
        with self.assertRaisesRegex(ValueError, 'no Fusion Design'):
            self.core.CadContext('Test')

    def test_origins_and_kind_validation(self):
        self.assertIs(self.ctx.resolve('root'), self.root)
        for name, prop in self.core._CAD_ORIGINS.items():
            self.assertIs(self.ctx.resolve(name), getattr(self.root, prop))
        with self.assertRaisesRegex(ValueError, 'Expected body'):
            self.ctx.resolve('XY', 'body')
        with self.assertRaisesRegex(ValueError, 'conflicts'):
            self.ctx.resolve({'name': 'XY', 'kind': 'plane'}, 'body')

    def test_names_require_unique_match(self):
        self.body()
        self.body()
        with self.assertRaisesRegex(ValueError, 'found 2'):
            self.ctx.resolve('Body', 'body')
        with self.assertRaisesRegex(ValueError, 'found 0'):
            self.ctx.resolve('missing')

    def test_component_scoped_names(self):
        root_body = self.body()
        child_body = self.body(owner=self.child)
        self.assertIs(self.ctx.resolve('Body', 'body'), root_body)
        self.assertIs(self.ctx.resolve({'name': 'Body', 'component': 'Part'}, 'body'), child_body)

    def test_tokens_split_kind_and_scope(self):
        body = self.body()
        other = self.body('Other')
        self.assertIs(self.ctx.resolve({'token': body.entityToken, 'name': 'stale-display-name'}), body)
        with self.assertRaisesRegex(ValueError, 'found 0'):
            self.ctx.resolve({'token': body.entityToken, 'kind': 'face'})
        with self.assertRaisesRegex(ValueError, 'found 0'):
            self.ctx.resolve({'token': body.entityToken, 'component': 'Part'})
        self.tokens[body.entityToken] = [body, other]
        with self.assertRaisesRegex(ValueError, 'found 2'):
            self.ctx.resolve({'token': body.entityToken})

    def test_root_datum_reference_roundtrip_without_resolvable_root_token(self):
        self.tokens[self.root.entityToken] = []
        datum = Entity('ConstructionPlane', 'TestOffset')
        datum.component = self.root
        self.root.constructionPlanes.items.append(datum)
        self.register(datum)
        ref = self.ctx.describe(datum)
        self.assertEqual(ref['component'], {'kind': 'component', 'name': 'root'})
        fresh = self.core.CadContext('Test', 'Part')
        self.assertIs(fresh.resolve(self.ctx.ref(self.root)), self.root)
        self.assertEqual(fresh.call('entity.inspect', {'ref': ref})['token'], datum.entityToken)
        self.tokens[datum.entityToken] = []
        with self.assertRaisesRegex(ValueError, 'Entity token: expected one match, found 0'):
            fresh.resolve(ref)
        with self.assertRaisesRegex(ValueError, 'Entity token: expected one match, found 0'):
            fresh.resolve({'kind': 'component', 'token': self.root.entityToken, 'name': 'root'})

    def test_occurrence_proxies_and_reference_roundtrip(self):
        occurrence = self.occurrence()
        body = self.body(owner=self.child)
        ctx = self.core.CadContext('Test', 'Part:1')
        proxy = ctx.resolve('Body', 'body')
        self.assertIs(proxy.nativeObject, body)
        self.assertIs(proxy.assemblyContext, occurrence)
        ref = ctx.ref(proxy)
        self.assertEqual(ref['occurrence']['path'], 'Part:1')
        self.assertEqual(ctx.resolve(ref), proxy)
        self.assertIs(ctx.resolve(ctx.ref(occurrence)), occurrence)
        with self.assertRaisesRegex(ValueError, 'disagree'):
            self.ctx.resolve({'name': 'Body', 'component': 'root', 'occurrence': 'Part:1'})

    def test_profile_requires_explicit_choice(self):
        sketch = self.profile_sketch(2)
        with self.assertRaisesRegex(ValueError, 'explicit index'):
            self.ctx.resolve({'kind': 'profile', 'sketch': 'Section'})
        for invalid in (-1, 2, True, 0.5):
            with self.assertRaisesRegex(ValueError, 'index'):
                self.ctx.resolve({'kind': 'profile', 'sketch': 'Section', 'index': invalid})
        self.assertNotIn('index', self.ctx.ref(sketch.profiles.item(0)))
        profile = self.ctx.resolve({'kind': 'profile', 'sketch': 'Section', 'index': 1})
        result = self.ctx.describe(profile)
        self.assertEqual(result['index'], 1)
        self.assertEqual(result['area']['value'], 12.5)
        self.assertEqual(result['sketch']['name'], 'Section')
        json.dumps(result, allow_nan=False)

    def test_profile_token_index_consistency_and_roundtrip(self):
        sketch = self.profile_sketch(2)
        profile = self.ctx.resolve({'kind': 'profile', 'sketch': 'Section', 'index': 1})
        ref = self.ctx.ref(profile)
        fresh = self.core.CadContext('Test')
        self.assertEqual(fresh.ref(fresh.resolve(ref))['index'], 1)
        with self.assertRaisesRegex(ValueError, 'disagrees'):
            self.ctx.resolve(dict(ref, token=sketch.profiles.item(0).entityToken))

    def test_single_profile_does_not_invent_index(self):
        self.profile_sketch(1)
        profile = self.ctx.resolve({'kind': 'profile', 'sketch': 'Section'})
        self.assertNotIn('index', self.ctx.ref(profile))

    def test_profile_loop_count_without_resolvable_profile_tokens(self):
        sketch = self.profile_sketch(2)
        disk, annulus = sketch.profiles.items
        annulus.profileLoops = Items([object(), object()])
        for profile in sketch.profiles.items:
            self.tokens[profile.entityToken] = []
        selector = {'kind': 'profile', 'sketch': self.ctx.ref(sketch), 'loopCount': 2}
        fresh = self.core.CadContext('Test', 'Part')
        self.assertIs(fresh.resolve(selector), annulus)
        sketch.profiles.items.reverse()
        self.assertIs(fresh.resolve(selector), annulus)
        with self.assertRaisesRegex(ValueError, 'Entity token: expected one match, found 0'):
            fresh.resolve(dict(selector, token=annulus.entityToken))
        for invalid in (0, -1, True, 2.0, '2'):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, 'positive integer'):
                fresh.resolve(dict(selector, loopCount=invalid))
        with self.assertRaisesRegex(ValueError, 'cannot be combined'):
            fresh.resolve(dict(selector, index=0))
        disk.profileLoops = Items([object(), object()])
        with self.assertRaisesRegex(ValueError, 'loopCount 2: expected one match, found 2'):
            fresh.resolve(selector)
        sketch.profiles.items.clear()
        with self.assertRaisesRegex(ValueError, 'loopCount 2: expected one match, found 0'):
            fresh.resolve(selector)

    def test_profile_token_must_agree_with_loop_count(self):
        sketch = self.profile_sketch(2)
        disk, annulus = sketch.profiles.items
        annulus.profileLoops = Items([object(), object()])
        selector = {'kind': 'profile', 'sketch': self.ctx.ref(sketch), 'loopCount': 2}
        self.assertIs(self.ctx.resolve(dict(selector, token=annulus.entityToken)), annulus)
        with self.assertRaisesRegex(ValueError, 'disagrees'):
            self.ctx.resolve(dict(selector, token=disk.entityToken))

    def test_expression_units_and_signed_minus_one(self):
        self.assertAlmostEqual(self.ctx.length('10 mm'), 1)
        self.assertAlmostEqual(self.ctx.length('-10 mm'), -1)
        self.assertAlmostEqual(self.ctx.angle('180 deg'), math.pi)
        self.assertEqual(self.ctx.value('10 mm'), '10 mm')
        self.assertEqual(self.core._cad_xyz(self.ctx.point(['10 mm', '0 cm', '-1 cm'])), [1, 0, -1])
        for expression in (1, 0, True, None, '', '1', '1e3', '2*pi', '1 cm / 1 cm', 'missing', '1 deg'):
            with self.subTest(expression=expression), self.assertRaises(ValueError):
                self.ctx.length(expression)
        with self.assertRaises(ValueError):
            self.ctx.angle('1 mm')

    def test_empty_units_are_not_a_dimensionless_classifier(self):
        for expression, expected in (('5 mm', 0.5), ('0 mm', 0), ('0.001 mm', 0.0001)):
            with self.subTest(expression=expression):
                self.assertTrue(self.units.isValidExpression(expression, ''))
                self.assertFalse(self.units.isValidExpression(expression, 'cm/cm'))
                self.assertAlmostEqual(self.ctx.length(expression), expected)
                self.assertEqual(self.ctx.value(expression), expression)
        self.assertTrue(self.units.isValidExpression('30 deg', ''))
        self.assertAlmostEqual(self.ctx.angle('30 deg'), math.pi / 6)

    def test_explicit_dimensionless_context_does_not_use_length_defaults(self):
        self.assertAlmostEqual(self.units.evaluateExpression('4', ''), 0.4)
        self.assertEqual(self.ctx._expression('4', '', unitless=True)[1], 4)
        self.assertEqual(self.ctx._expression('1 cm / 1 cm', '', unitless=True)[1], 1)
        for expression in ('5 mm', '0 mm', '30 deg'):
            with self.subTest(expression=expression), self.assertRaises(ValueError):
                self.ctx._expression(expression, '', unitless=True)

    def test_documented_standardization_and_evaluation_semantics(self):
        self.assertEqual(self.units.standardizeExpression('1.5', ''), '1.5 mm')
        self.assertEqual(self.units.standardizeExpression('1.5', 'in'), '1.5 in')
        self.assertEqual(self.units.standardizeExpression('1.5 cm', 'mm'), '1.5 cm')
        self.assertEqual(self.units.standardizeExpression('1 deg', 'mm'), '')
        self.assertAlmostEqual(self.units.evaluateExpression('1cm + 1in', 'cm'), 3.54)

    def test_valid_dimensions_and_counts_are_independent_of_document_defaults(self):
        for default in ('mm', 'in'):
            self.units.defaultLengthUnits = default
            self.assertEqual(self.ctx.length('5 mm'), 0.5)
            self.assertEqual(self.ctx.length('0 mm'), 0)
            self.assertEqual(self.ctx._expression('4', '', unitless=True)[1], 4)
        self.assertTrue(all(call[2] for call in self.units.calls))

    def test_dimension_guards_remain_strict_with_real_empty_unit_behavior(self):
        for expression in ('5', '-1', '0', '1e3', '2*pi', '1 cm / 1 cm', '0 deg', 'unknown'):
            with self.subTest(expression=expression), self.assertRaises(ValueError):
                self.ctx.length(expression)
        for expression in ('5', '0', '0 mm', '1 cm'):
            with self.subTest(expression=expression), self.assertRaises(ValueError):
                self.ctx.angle(expression)
        self.assertAlmostEqual(self.ctx.length('5e-3 mm'), 0.0005)

    def test_nonfinite_evaluation_rejected(self):
        self.units.evaluateExpression = lambda expression, unit: math.inf
        with self.assertRaisesRegex(ValueError, 'non-finite'):
            self.ctx.length('1 mm')

    def test_parameter_reference_not_implicit_dimensionless(self):
        self.apply([{'name': 'size', 'expression': '10 mm', 'unit': 'mm'},
                    {'name': 'number', 'expression': 3, 'unit': ''}])
        self.assertEqual(self.ctx.length('size'), 1)
        with self.assertRaisesRegex(ValueError, 'Dimensionless'):
            self.ctx.length('number')

    def test_collection_dispatch_and_confirmation(self):
        entity = self.body()
        self.assertEqual(self.ctx.collection([entity]).count, 1)
        self.assertEqual(self.ctx.call('entity.inspect', {'ref': 'Body'})['name'], 'Body')
        with self.assertRaisesRegex(ValueError, 'Unsupported CAD'):
            self.ctx.call('missing.operation', {})
        with self.assertRaises(TypeError):
            self.ctx.call('entity.inspect', [])
        for invalid in (False, 1, 'true', None):
            with self.assertRaises(ValueError):
                self.ctx.require_confirm({'confirm': invalid})
        self.ctx.require_confirm({'confirm': True})

    def test_alias_persists_noop_confirm_and_stale_replacement(self):
        body = self.body()
        other = self.body('Other')
        data = {'ref': 'Body', 'alias': 'mount'}
        self.assertTrue(self.ctx.call('entity.alias', data)['changed'])
        self.assertIs(self.ctx.resolve('mount'), body)
        self.assertFalse(self.ctx.call('entity.alias', data)['changed'])
        with self.assertRaisesRegex(ValueError, 'confirm'):
            self.ctx.call('entity.alias', {'ref': 'Other', 'alias': 'mount'})
        self.tokens[body.entityToken] = []
        self.ctx.call('entity.alias', {'ref': 'Other', 'alias': 'mount', 'confirm': True})
        self.assertIs(self.ctx.resolve('mount'), other)
        with self.assertRaises(ValueError):
            self.ctx.call('entity.alias', {'ref': 'Other', 'alias': 'XY'})

    def test_alias_name_collision_rejected_on_resolution(self):
        self.body()
        self.body('Other')
        self.ctx.call('entity.alias', {'ref': 'Other', 'alias': 'Body'})
        with self.assertRaisesRegex(ValueError, 'found 2'):
            self.ctx.resolve('Body')

    def test_child_body_alias_collision_persists_across_contexts(self):
        first = self.body('FirstBody', self.child)
        second = self.body('Bry\u0142a2', self.child)
        ctx = self.core.CadContext('Test', 'Part')
        result = ctx.call('entity.alias', {'ref': ctx.ref(first), 'alias': second.name})
        self.assertEqual(result['alias'], second.name)
        stored = self.root.attributes.itemByName(self.core._CAD_ALIAS_GROUP, second.name)
        self.assertEqual(json.loads(stored.value), ctx.ref(first))
        fresh = self.core.CadContext('Test', 'Part')
        self.assertIs(fresh.resolve(json.loads(stored.value)), first)
        self.assertIs(self.core._cad_owner(first), self.child)
        with self.assertRaisesRegex(ValueError, 'expected one match, found 2'):
            fresh.resolve({'name': second.name, 'kind': 'body'})
        self.assertIs(fresh.resolve(fresh.ref(second)), second)
        self.assertEqual(self.child.bRepBodies.count, 2)

    def test_mojibake_alias_does_not_collide_with_native_body_name(self):
        first = self.body('FirstBody', self.child)
        second = self.body('Bry\u0142a2', self.child)
        corrupted = 'Bry\u00c5\u0082a2'
        ctx = self.core.CadContext('Test', 'Part')
        result = ctx.call('entity.alias', {'ref': ctx.ref(first), 'alias': corrupted})
        self.assertEqual(result['alias'], corrupted)
        self.assertIsNone(self.root.attributes.itemByName(self.core._CAD_ALIAS_GROUP, second.name))
        fresh = self.core.CadContext('Test', 'Part')
        self.assertIs(fresh.resolve({'name': corrupted, 'kind': 'body'}), first)
        self.assertIs(fresh.resolve({'name': second.name, 'kind': 'body'}), second)

    def test_selection_does_not_activate(self):
        self.app.activeDocument = object()
        for operation, data in [('selection.inspect', {}), ('selection.highlight', {'refs': []})]:
            with self.assertRaisesRegex(ValueError, 'already be active'):
                self.ctx.call(operation, data)

    def test_highlight_resolves_all_before_clearing(self):
        self.body()
        selection = self.app.userInterface.activeSelections
        selection.clear = lambda: self.fail('Should not clear before resolving every ref')
        with self.assertRaises(ValueError):
            self.ctx.call('selection.highlight', {'refs': ['Body', 'missing']})

    def test_failed_selection_clear_is_not_silent(self):
        self.app.userInterface.activeSelections.clear = lambda: False
        with self.assertRaisesRegex(RuntimeError, 'Clear selection failed'):
            self.ctx.call('selection.highlight', {'refs': []})

    def test_parameter_prevalidation_prevents_partial_invalid_batch(self):
        with self.assertRaises(ValueError):
            self.apply([{'name': 'good', 'expression': '10 mm', 'unit': 'mm'},
                        {'name': 'bad', 'expression': 10, 'unit': 'mm'}])
        self.assertEqual(self.parameters.count, 0)
        with self.assertRaises(ValueError):
            self.apply([{'name': 'good', 'expression': '10 mm', 'unit': 'mm'},
                        {'name': 'bad', 'expression': '10 deg', 'unit': 'mm'}])
        self.assertEqual(self.parameters.count, 0)

    def test_forward_parameter_dependencies_and_created_refs(self):
        result = self.apply([{'name': 'outer', 'expression': '2 * wall', 'unit': 'mm'},
                             {'name': 'wall', 'expression': '3 mm', 'unit': 'mm'}])
        self.assertEqual(self.parameters.writes, ['wall', 'outer'])
        self.assertEqual([r['name'] for r in self.ctx.created], ['wall', 'outer'])
        self.assertFalse(result['atomic'])
        self.assertAlmostEqual(self.parameters.itemByName('outer').value, 0.6)

    def test_existing_implicit_ui_parameter_units_survive_expansion(self):
        self.parameters.add('ui_width', '10', 'mm', '')
        with patch.object(self.parameters, 'add', wraps=self.parameters.add) as add:
            result = self.apply([{'name': 'outer', 'expression': '2 * ui_width', 'unit': 'mm'}])
        self.assertTrue(result['prevalidated'])
        self.assertEqual(add.call_args.args[1], '2 * ui_width')
        self.assertEqual(result['parameters'][0]['value'], 2)

    def test_existing_explicit_ui_parameter_units_are_not_multiplied(self):
        self.parameters.add('ui_width', '5 mm', 'mm', '')
        result = self.apply([{'name': 'outer', 'expression': '2 * ui_width', 'unit': 'mm'}])
        self.assertEqual(result['parameters'][0]['value'], 1)

    def test_standardization_failure_aborts_batch_before_writes(self):
        self.parameters.add('ui_width', '5 mm', 'mm', '')
        self.units.standardizeExpression = lambda expression, unit: ''
        with self.assertRaisesRegex(ValueError, 'Cannot standardize'):
            self.apply([{'name': 'outer', 'expression': '2 * ui_width', 'unit': 'mm'}])
        self.assertEqual(self.parameters.writes, ['ui_width'])

    def test_live_failure_parameter_batch_regression(self):
        result = self.apply([
            {'name': 'thickness20', 'expression': '5 mm', 'unit': 'mm', 'metadata': {'tolerance': '0.001 mm'}},
            {'name': 'zero_offset', 'expression': '0 mm', 'unit': 'mm'},
            {'name': 'count20', 'expression': 4, 'unit': ''},
        ])
        self.assertEqual([p['value'] for p in result['parameters']], [0.5, 0, 4])
        self.assertEqual(self.ctx.length('thickness20'), 0.5)
        with self.assertRaisesRegex(ValueError, 'Dimensionless'):
            self.ctx.length('count20')
        self.assertEqual(self.ctx._expression('count20', '', unitless=True)[1], 4)
        self.assertTrue(all(call[2] for call in self.units.calls))

    def test_parameter_cycles_duplicates_and_counts(self):
        with self.assertRaisesRegex(ValueError, 'Cyclic'):
            self.apply([{'name': 'a', 'expression': 'b', 'unit': 'mm'},
                        {'name': 'b', 'expression': 'a', 'unit': 'mm'}])
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.apply([{'name': 'a', 'expression': '1 mm', 'unit': 'mm'}] * 2)
        self.assertEqual(self.parameters.count, 0)
        result = self.apply([{'name': 'count', 'expression': 4, 'unit': ''}])
        self.assertEqual(result['parameters'][0]['value'], 4)

    def test_existing_dependency_cycle_rejected(self):
        self.apply([{'name': 'a', 'expression': '1 mm', 'unit': 'mm'},
                    {'name': 'b', 'expression': '2 * a', 'unit': 'mm'}])
        with self.assertRaisesRegex(ValueError, 'Cyclic'):
            self.apply([{'name': 'a', 'expression': 'b'}], overwrite=True)
        self.assertEqual(self.parameters.itemByName('a').expression, '1 mm')

    def test_parameter_noop_and_overwrite_relationships(self):
        spec = {'name': 'size', 'expression': '10 mm', 'unit': 'mm', 'comment': 'input'}
        self.apply([spec])
        self.assertFalse(self.apply([spec])['parameters'][0]['changed'])
        with self.assertRaisesRegex(ValueError, 'overwrite'):
            self.apply([dict(spec, expression='1 cm')])
        self.assertTrue(self.apply([dict(spec, expression='1 cm')], overwrite=True)['parameters'][0]['changed'])
        with self.assertRaisesRegex(ValueError, 'unit'):
            self.apply([dict(spec, unit='cm')], overwrite=True)

    def test_protected_metadata_survives_rename_and_requires_confirmation(self):
        self.apply([{'name': 'size', 'expression': '1 mm', 'unit': 'mm',
                     'metadata': {'protected': True, 'source': 'drawing', 'tolerance': '0.1 mm'}}])
        parameter = self.parameters.itemByName('size')
        parameter.name = 'renamed'
        with self.assertRaisesRegex(ValueError, 'confirm'):
            self.apply([{'name': 'renamed', 'expression': '2 mm'}], overwrite=True)
        result = self.apply([{'name': 'renamed', 'expression': '2 mm'}], overwrite=True, confirm=True)
        self.assertEqual(result['parameters'][0]['metadata']['source'], 'drawing')
        self.assertTrue(result['parameters'][0]['metadata']['protected'])
        self.apply([{'name': 'renamed', 'expression': '2 mm', 'metadata': {'protected': False}}],
                   overwrite=True, confirm=True)
        self.assertFalse(self.ctx.call('param.inspect', {})['parameters'][0]['metadata']['protected'])

    def test_tolerance_validation_before_mutation(self):
        for tolerance in ('-1 mm', '1 deg', 1, {'min': '1 mm'}):
            with self.subTest(tolerance=tolerance), self.assertRaises(ValueError):
                self.apply([{'name': 'size', 'expression': '1 mm', 'unit': 'mm', 'metadata': {'tolerance': tolerance}}])
        self.assertEqual(self.parameters.count, 0)

    def test_dependency_report_is_partial_with_unknown_lists(self):
        self.apply([{'name': 'size', 'expression': '1 mm', 'unit': 'mm'}])
        result = self.ctx.call('param.dependencies', {'name': 'size'})
        self.assertEqual(result['coverage'], 'partial')
        self.assertIsNone(result['parameters'][0]['usedByParameters'])

    def test_text_parameter_inspection_does_not_read_numeric_value(self):
        parameter = Entity('UserParameter', 'note')
        parameter.expression = "'hello'"
        parameter.unit, parameter.comment, parameter.textValue = 'Text', '', 'hello'
        self.parameters.items.append(parameter)
        result = self.ctx.call('param.inspect', {})['parameters'][0]
        self.assertEqual(result['valueType'], 'text')
        self.assertEqual(result['value'], 'hello')
        with self.assertRaisesRegex(ValueError, 'Text parameters'):
            self.apply([{'name': 'note', 'expression': "'updated'"}], overwrite=True)

    def test_geometry_filter_cylinder_and_plane(self):
        body = self.body()
        face = Entity('BRepFace')
        face.body = body
        face.geometry = types.SimpleNamespace(objectType='adsk::core::Cylinder', radius=2.5,
                                              origin=Point(0, 0, 5), axis=Point(0, 0, 1))
        body.faces.items.append(face)
        result = self.ctx.call('entity.find', {'filters': {'geometry': 'cylinder', 'radius': '25 mm',
            'axis': [0, 0, -5], 'position': ['0 mm', '0 mm', '0 mm']}, 'unique': True})
        self.assertEqual(result['token'], face.entityToken)
        self.assertEqual(self.ctx.call('entity.find', {'filters': {'radius': '20 mm'}})['count'], 0)
        with self.assertRaisesRegex(ValueError, 'Unsupported geometry filters'):
            self.ctx.call('entity.find', {'filters': {'diameter': '50 mm'}})
        with self.assertRaisesRegex(ValueError, 'Direction cannot be zero'):
            self.ctx.call('entity.find', {'filters': {'axis': [0, 0, 0]}})

    def test_find_mixed_null_and_absent_geometry_preserves_descriptors(self):
        absent = self.body('Absent')
        null = self.body('Null')
        null.geometry = None
        analytic = self.body('Analytic')
        analytic.geometry = types.SimpleNamespace(objectType='adsk::core::Cylinder', radius=2.5,
            origin=Point(0, 0, 0), axis=Point(0, 0, 1))
        expected = [self.ctx.describe(entity) for entity in (absent, null, analytic)]
        result = self.ctx.call('entity.find', {'kind': 'body'})
        self.assertEqual(result, {'entities': expected, 'count': 3})
        json.dumps(result, allow_nan=False)
        for entity, descriptor in zip((absent, null, analytic), expected):
            with self.subTest(name=entity.name):
                self.assertEqual(self.ctx.call('entity.find', {'kind': 'body',
                    'filters': {'name': entity.name}, 'unique': True}), descriptor)
                self.assertIs(self.ctx.resolve(descriptor), entity)
        for filters in ({'geometry': 'cylinder'}, {'radius': '25 mm'},
                        {'axis': [0, 0, 1]}, {'position': ['0 mm'] * 3}):
            with self.subTest(filters=filters):
                self.assertEqual(self.ctx.call('entity.find', {'kind': 'body', 'filters': filters}),
                                 {'entities': [expected[2]], 'count': 1})
                with self.assertRaisesRegex(ValueError, 'Geometry search: expected one match, found 0'):
                    self.ctx.call('entity.find', {'kind': 'body',
                        'filters': dict(filters, name='Null'), 'unique': True})

    def test_find_null_geometry_keeps_scope_and_input_guards(self):
        root_body = self.body('Body')
        child_body = self.body('Body', self.child)
        root_body.geometry = child_body.geometry = None
        for owner, entity in (('root', root_body), ('Part', child_body)):
            result = self.ctx.call('entity.find', {'kind': 'body', 'component': owner, 'unique': True})
            self.assertEqual(result, self.ctx.describe(entity))
            self.assertIs(self.ctx.resolve(result), entity)
        for filters in ({'radius': '1 deg'}, {'tolerance': '1 deg'},
                        {'angleTolerance': '1 mm'}, {'position': ['1 deg'] * 3},
                        {'axis': [0, 0, math.inf]}):
            with self.subTest(filters=filters), self.assertRaises(ValueError):
                self.ctx.call('entity.find', {'kind': 'body', 'filters': filters})
        self.units.evaluateExpression = lambda expression, unit: math.inf
        with self.assertRaisesRegex(ValueError, 'non-finite'):
            self.ctx.call('entity.find', {'kind': 'body'})

    def test_find_null_world_geometry_excludes_analytic_filters(self):
        sketch = self.profile_sketch(0)
        point = Entity('SketchPoint')
        point.parentSketch = sketch
        point.geometry = Point(0, 0, 0)
        point.worldGeometry = None
        sketch.sketchPoints.items.append(point)
        self.assertEqual(self.ctx.call('entity.find', {'kind': 'point', 'unique': True}),
                         self.ctx.describe(point))
        self.assertEqual(self.ctx.call('entity.find', {'kind': 'point',
            'filters': {'position': ['0 mm'] * 3}}), {'entities': [], 'count': 0})

    def test_sketch_point_geometry_uses_world_coordinates(self):
        sketch = self.profile_sketch(0)
        point = Entity('SketchPoint')
        point.parentSketch = sketch
        point.geometry = Point(0, 0, 0)
        point.worldGeometry = Point(1, 2, 3)
        sketch.sketchPoints.items.append(point)
        result = self.ctx.call('entity.find', {'kind': 'point',
            'filters': {'geometry': 'point', 'position': ['1 cm', '2 cm', '3 cm']}, 'unique': True})
        self.assertEqual(result['geometry']['xyz'], [1, 2, 3])

    def test_plane_datum_modes_preserve_expressions(self):
        self.root.constructionPlanes = Datums('ConstructionPlane', self.root)
        examples = [({'name': 'Offset', 'offset': '-10 mm'}, 'setByOffset'),
                    ({'name': 'Middle', 'mode': 'mid', 'plane1': 'XY', 'plane2': 'XZ'}, 'setByTwoPlanes'),
                    ({'name': 'Tilt', 'mode': 'angle', 'axis': 'X', 'plane': 'XY', 'angle': '30 deg'}, 'setByAngle')]
        for data, method in examples:
            result = self.ctx.call('datum.plane', data)
            created = self.root.constructionPlanes.items[-1]
            self.assertEqual(created.input.definition[0], method)
            self.assertEqual(result['name'], data['name'])
        self.assertEqual(self.root.constructionPlanes.item(0).input.definition[1][1], '-10 mm')
        self.assertEqual(len(self.ctx.created), 3)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.ctx.call('datum.plane', examples[0][0])

    def test_axis_datum_modes_and_occurrence_creation_context(self):
        occurrence = self.occurrence()
        self.child.constructionAxes = Datums('ConstructionAxis', self.child)
        ctx = self.core.CadContext('Test', 'Part:1')
        ctx.call('datum.axis', {'name': 'Axis', 'mode': 'twoPlanes', 'plane1': 'XY', 'plane2': 'XZ'})
        axis = self.child.constructionAxes.item(0)
        self.assertIs(axis.input.creationOccurrence, occurrence)
        self.assertIs(axis.input.definition[1][0].assemblyContext, occurrence)
        self.assertEqual(ctx.created[0]['occurrence']['path'], 'Part:1')

    def test_coordinate_point_signed_helper_planes(self):
        self.root.constructionPlanes = Datums('ConstructionPlane', self.root)
        self.root.constructionPoints = Datums('ConstructionPoint', self.root)
        result = self.ctx.call('datum.point', {'name': 'Mount', 'point': ['1 mm', '-2 mm', '0 mm']})
        self.assertEqual(result['representation'], 'intersection of three expression-driven offset planes')
        self.assertEqual([h['name'] for h in result['helpers']], ['Mount__x', 'Mount__y', 'Mount__z'])
        # XZ's native normal is -Y in this stub, so its signed offset must be inverted.
        expressions = [p.input.definition[1][1] for p in self.root.constructionPlanes.items]
        self.assertEqual(expressions, ['1 mm', '-(-2 mm)', '0 mm'])
        self.assertEqual(self.root.constructionPoints.item(0).input.definition[0], 'setByThreePlanes')
        self.assertEqual(len(self.ctx.created), 1)

    def test_coordinate_point_prevalidates_all_coordinates(self):
        self.root.constructionPlanes = Datums('ConstructionPlane', self.root)
        self.root.constructionPoints = Datums('ConstructionPoint', self.root)
        with self.assertRaises(ValueError):
            self.ctx.call('datum.point', {'name': 'Mount', 'point': ['1 mm', '2 mm', 0]})
        self.assertEqual(self.root.constructionPlanes.count, 0)

    def test_datum_api_false_and_unsupported_modes_fail(self):
        self.root.constructionPlanes = Datums('ConstructionPlane', self.root)
        self.root.constructionAxes = Datums('ConstructionAxis', self.root)
        self.root.constructionPoints = Datums('ConstructionPoint', self.root)
        for operation in ('datum.plane', 'datum.axis', 'datum.point'):
            with self.assertRaisesRegex(ValueError, 'Unsupported'):
                self.ctx.call(operation, {'name': 'Invalid', 'mode': 'unavailable'})
        self.root.constructionPlanes.succeeds = False
        with self.assertRaisesRegex(RuntimeError, 'Define datum plane failed'):
            self.ctx.call('datum.plane', {'name': 'Invalid', 'offset': '1 mm'})
        self.assertEqual(self.root.constructionPlanes.count, 0)

    def test_unknown_input_and_boolean_typos_rejected(self):
        with self.assertRaisesRegex(ValueError, 'unsupported inputs'):
            self.ctx.call('entity.list', {'typo': True})
        with self.assertRaisesRegex(ValueError, 'must be boolean'):
            self.ctx.call('selection.highlight', {'refs': [], 'replace': 'true'})
        self.root.constructionPlanes = Datums('ConstructionPlane', self.root)
        with self.assertRaisesRegex(ValueError, 'unsupported inputs'):
            self.ctx.call('datum.plane', {'name': 'Plane', 'offset': '1 mm', 'angle': '30 deg'})
        self.assertEqual(self.root.constructionPlanes.count, 0)

    def test_frame_metadata_representation_and_overwrite(self):
        data = {'name': 'Frame', 'origin': ['0 mm', '0 mm', '10 mm'], 'xAxis': [2, 0, 0], 'yAxis': [0, 3, 0]}
        result = self.ctx.call('datum.frame', data)
        self.assertEqual(result['representation'], 'named transform metadata')
        self.assertFalse(result['parametric'])
        self.assertEqual(result['matrix'][11], 1)
        self.assertFalse(self.ctx.call('datum.frame', data)['changed'])
        changed = dict(data, origin=['0 mm', '0 mm', '20 mm'])
        with self.assertRaisesRegex(ValueError, 'confirm'):
            self.ctx.call('datum.frame', changed)
        self.assertTrue(self.ctx.call('datum.frame', dict(changed, confirm=True))['changed'])
        with self.assertRaisesRegex(ValueError, 'perpendicular'):
            self.ctx.call('datum.frame', dict(data, yAxis=[1, 1, 0]))

    def test_api_false_result_is_not_swallowed(self):
        with self.assertRaisesRegex(RuntimeError, 'partial changes'):
            self.core._cad_require_result(False, 'Define datum')
        with self.assertRaisesRegex(RuntimeError, 'partial changes'):
            self.core._cad_require_result(None, 'Create datum')

    def test_catalog_handler_parity_and_complete_examples(self):
        catalog = json.loads(CATALOG.read_text())
        catalog.update(json.loads(CATALOG.with_name('entity.json').read_text()))
        self.assertEqual(set(catalog), set(self.core.CAD_HANDLERS))
        self.assertEqual(len(catalog), 14)
        for operation, entry in catalog.items():
            with self.subTest(operation=operation):
                self.assertEqual(set(entry) - {'inspectionSafe'}, {'summary', 'required', 'example', 'readOnly', 'limitations', 'inputs'})
                if 'inspectionSafe' in entry:
                    self.assertIs(entry['inspectionSafe'], True)
                    self.assertIs(entry['readOnly'], True)
                self.assertTrue(entry['summary'])
                self.assertIsInstance(entry['readOnly'], bool)
                self.assertIsInstance(entry['limitations'], list)
                self.assertTrue(set(entry['required']) <= set(entry['example']))
                self.assertTrue(set(entry['example']) <= set(entry['inputs']))
                self.assertTrue(all(isinstance(v, str) and v for v in entry['inputs'].values()))
        self.assertFalse(catalog['selection.highlight']['readOnly'])
        self.assertTrue(catalog['selection.inspect']['readOnly'])
        self.assertFalse(hasattr(self.core, 'run'))

    def test_current_concatenated_bundle_compiles(self):
        paths = [SOURCE] + sorted(path for path in SOURCE.parent.glob('*.py') if path != SOURCE)
        compile('\n\n'.join(path.read_text() for path in paths), '<cad-bundle>', 'exec')


if __name__ == '__main__':
    unittest.main()
