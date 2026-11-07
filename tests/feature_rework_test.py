"""Offline API-shape tests for GM09 feature roles, extents and marker-restoring edits, not native kernel acceptance."""
import json
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


class CollectionBuilder(Collection):
    def add(self, value):
        self.values.append(value)


class FeatureCollectionItem:
    def __init__(self, entity=None, isCenterLine=False):
        self.entity = entity
        self.isCenterLine = isCenterLine
        self.edgeCondition = 'g0'


class EdgeSetFixture:
    def __init__(self, variant='ConstantRadiusFilletEdgeSet'):
        self.objectType = 'adsk::fusion::' + variant
        self.entityToken = 'edge-set'
        self.name = 'EdgeSet'
        self._edges = Collection()
        self.on_edges_assignment = None
        self.stale = False
        self._radius = Parameter('edgeRadius', '2 mm')
        self.chordLength = Parameter('edgeChord', '2 mm')
        self.startRadius = Parameter('edgeStartRadius', '1 mm')
        self.endRadius = Parameter('edgeEndRadius', '2 mm')
        self.offsetOne = Parameter('edgeOffsetOne', '1 mm')
        self.offsetTwo = Parameter('edgeOffsetTwo', '2 mm')
        self.midRadii = Collection([Parameter('edgeMidRadius', '1.5 mm')])
        self.midPositions = Collection([Parameter('edgeMidPosition', '0.5', 'text', .5)])
        self.distance = Parameter('edgeDistance', '2 mm')
        self.distanceOne = Parameter('edgeDistanceOne', '2 mm')
        self.distanceTwo = Parameter('edgeDistanceTwo', '3 mm')
        self.angle = Parameter('edgeAngle', '45 deg', 'rad', math.pi / 4)
        self.isFlipped = False
        self.isTangentChain = True
        self.continuity = 'tangent'
        self.tangencyWeight = ('value', '1')

    @property
    def edges(self):
        return self._edges

    @edges.setter
    def edges(self, value):
        self._edges = value
        if self.on_edges_assignment is not None:
            self.on_edges_assignment()

    @property
    def radius(self):
        if self.stale:
            raise RuntimeError('API object refers to a deleted Object')
        return self._radius

    @radius.setter
    def radius(self, value):
        self._radius = value


class FullRoundFaceSetFixture:
    def __init__(self, center, side_one, side_two):
        self.objectType = 'adsk::fusion::FullRoundFilletFaceSet'
        self.entityToken = 'full-round-face-set'
        self.name = 'FullRoundFaceSet'
        self.centerFace, self.sideOneFaces, self.sideTwoFaces = center, side_one, side_two
        self.areAutomaticSideFaces = True
        self.owner = None

    def deleteMe(self):
        self.owner.values.remove(self)
        return True


class FullRoundFaceSetsFixture(Collection):
    def add(self, center, side_one, side_two, automatic=True):
        row = FullRoundFaceSetFixture(center, side_one, side_two)
        row.areAutomaticSideFaces = automatic
        row.owner = self
        self.values.append(row)
        return row


class Parameter:
    serial = 0

    def __init__(self, name, expression, unit='cm', value=1.0):
        Parameter.serial += 1
        self.name, self.expression, self.unit, self.value = name, expression, unit, value
        self.createdBy = None


def castable(cls):
    return lambda entity: entity if isinstance(entity, cls) else None


class DistanceExtentDefinition:
    def __init__(self, distance):
        self.distance = distance

    @staticmethod
    def create(value):
        TRACE.append(('extent', 'distance-create', value))
        return DistanceExtentDefinition(None)


class ToEntityExtentDefinition:
    def __init__(self, entity, offset=None):
        self.entity, self.offset = entity, offset

    @staticmethod
    def create(entity, isChained, offset=None):
        TRACE.append(('extent', 'toEntity-create', entity, isChained))
        return ToEntityExtentDefinition(entity, offset)


class ThroughAllExtentDefinition:
    def __init__(self):
        pass

    @staticmethod
    def create():
        TRACE.append(('extent', 'throughAll-create'))
        return ThroughAllExtentDefinition()


class SymmetricExtentDefinition:
    def __init__(self, distance, taperAngle=None):
        self.distance, self.taperAngle = distance, taperAngle


class OffsetStartDefinition:
    def __init__(self, offset):
        self.offset = offset

    @staticmethod
    def create(value):
        TRACE.append(('extent', 'offsetStart-create', value))
        return OffsetStartDefinition(None)


class FromEntityStartDefinition:
    def __init__(self, entity, offset=None):
        self.entity, self.offset = entity, offset


class DistanceHoleExtentDefinition:
    def __init__(self, depth):
        self.depth = depth


class ThroughAllHoleExtentDefinition:
    def __init__(self):
        pass


class ToEntityHoleExtentDefinition:
    def __init__(self, entity, offset=None):
        self.entity, self.offset = entity, offset


class AngleExtentDefinition:
    def __init__(self, angle):
        self.angle = angle


class Entity:
    serial = 0

    def __init__(self, kind, name=None, component=None):
        Entity.serial += 1
        self.objectType = 'adsk::fusion::' + kind
        self.entityToken = str(Entity.serial)
        self.name = name or self.entityToken
        self.assemblyContext = None
        self.parentComponent = component
        self.nativeObject = None
        self.healthState = 0
        self.errorOrWarningMessage = ''
        self.isParametric = True
        self.isSuppressed = False
        self.isSolid = True
        self.timelineObject = TimelineObject(self)
        self._operation = 'new'
        self._participantBodies = []

    @property
    def operation(self):
        return self._operation

    @operation.setter
    def operation(self, value):
        self._operation = value
        TRACE.append(('apply', 'operation', value))

    @property
    def participantBodies(self):
        return self._participantBodies

    @participantBodies.setter
    def participantBodies(self, value):
        self._participantBodies = value
        TRACE.append(('apply', 'participantBodies', len(value)))

    def setInputEntities(self, entities, chain=True):
        self.inputEntities = entities
        self.inputFaces = entities
        TRACE.append(('native', 'setInputEntities', type(self).__name__, entities.count, chain))
        return True

    def setThicknesses(self, inside, outside):
        self.insideThicknessValue, self.outsideThicknessValue = inside, outside
        return True

    def setToSimple(self):
        self.holeType = 'simple'
        return True

    def setToCounterbore(self, diameter, depth):
        self.holeType = 'counterbore'
        return True

    def setToCountersink(self, diameter, angle):
        self.holeType = 'countersink'
        return True

    def setPositionBySketchPoints(self, points):
        self.position = ('sketchPoints', points.count)
        return True

    def setPositionBySketchPoint(self, point):
        self.position = ('sketchPoint', point)
        return True


class ExtrudeFeature(Entity):
    def __init__(self, component, name='Extrude1'):
        super().__init__('ExtrudeFeature', name, component)
        self.extentOne, self.extentTwo, self.startExtent, self.symmetricExtent = None, None, None, None
        self.hasTwoExtents = False
        self.taperAngleOne, self.taperAngleTwo = None, None
        self.timelineObject = TimelineObject(self)
        self._operation = 'new'
        self._participantBodies = None

    @property
    def operation(self):
        return self._operation

    @operation.setter
    def operation(self, value):
        self._operation = value
        TRACE.append(('apply', 'operation', value))

    @property
    def participantBodies(self):
        if TRACE and TRACE[-1] == ('timeline', 'rollTo', True):
            return self._participantBodies
        raise RuntimeError('participantBodies getter requires timeline roll')

    @participantBodies.setter
    def participantBodies(self, value):
        self._participantBodies = value
        TRACE.append(('apply', 'participantBodies', len(value)))

    def setOneSideExtent(self, extent, direction, taperAngle=None):
        TRACE.append(('apply', 'setOneSideExtent', type(extent).__name__, direction, taperAngle))
        return True

    def setSymmetricExtent(self, distance, isFullLength, taperAngle=None):
        TRACE.append(('apply', 'setSymmetricExtent', distance, isFullLength, taperAngle))
        return True

    def setTwoSidesExtent(self, one, two, taperAngleOne=None, taperAngleTwo=None):
        TRACE.append(('apply', 'setTwoSidesExtent', type(one).__name__, type(two).__name__))
        return True


class FailingProfileExtrude(ExtrudeFeature):
    @property
    def profile(self):
        return getattr(self, '_profile', None)

    @profile.setter
    def profile(self, _value):
        raise RuntimeError('native profile setter failed')


class RevolveFeature(Entity):
    def __init__(self, component, angle=None):
        super().__init__('RevolveFeature', component=component)
        self.extentDefinition = AngleExtentDefinition(angle) if angle is not None else None
        self.timelineObject = TimelineObject(self)

    def setAngleExtent(self, symmetric, angle):
        TRACE.append(('apply', 'setAngleExtent', symmetric, angle))
        return True

    def setTwoSideAngleExtent(self, one, two):
        TRACE.append(('apply', 'setTwoSideAngleExtent', one, two))
        return True

    def setOneSideToExtent(self, target, hint=None):
        TRACE.append(('apply', 'setOneSideToExtent', target, hint))
        return True

    def setTwoSidesToExtent(self, one, two):
        TRACE.append(('apply', 'setTwoSidesToExtent', one, two))
        return True


class FailingRevolve(RevolveFeature):
    @property
    def operation(self):
        return self._operation

    @operation.setter
    def operation(self, _value):
        raise RuntimeError('revolve operation setter failed')


class HoleFeature(Entity):
    def __init__(self, component, name='Hole1'):
        super().__init__('HoleFeature', name, component)
        self.holeDiameter = Parameter('holeDiameter', '3 mm', 'cm', .3)
        self.extentDefinition = DistanceHoleExtentDefinition(Parameter('holeDepth', '5 mm', 'cm', .5))
        self.holeType = 'simple'
        self.timelineObject = TimelineObject(self)

    def setDistanceExtent(self, distance):
        TRACE.append(('apply', 'setDistanceExtent', distance))
        return True

    def setAllExtent(self, direction):
        TRACE.append(('apply', 'setAllExtent', direction))
        return True

    def setOneSideToExtent(self, target, matchShape, directionHint=None):
        TRACE.append(('apply', 'setOneSideToExtent', target, matchShape, directionHint))
        return True


class FilletFeature(Entity):
    def __init__(self, component):
        super().__init__('FilletFeature', component=component)
        self.filletFeatureType = 'constantRadius'
        self.timelineObject = TimelineObject(self)


class TimelineObject:
    def __init__(self, feature):
        self.index = 2
        self.feature = feature

    def rollTo(self, markBeforeThisItem):
        TRACE.append(('timeline', 'rollTo', markBeforeThisItem))
        return True


class TimelineItem:
    def __init__(self, name, health=0, message=''):
        self.name, self.healthState, self.errorOrWarningMessage = name, health, message


class Timeline:
    def __init__(self, items=()):
        self.items = list(items)
        self.stale = False
        self._markerPosition = len(self.items)

    @property
    def markerPosition(self):
        return self._markerPosition

    @markerPosition.setter
    def markerPosition(self, value):
        if self.stale:
            raise RuntimeError('API object refers to a deleted Object')
        self._markerPosition = value

    @property
    def count(self):
        return len(self.items)

    def item(self, index):
        return self.items[index]

    def moveToEnd(self):
        if self.stale:
            raise RuntimeError('API object refers to a deleted Object')
        TRACE.append(('timeline', 'moveToEnd'))
        return True


class Component(Entity):
    def __init__(self, name='Selected', features=()):
        super().__init__('Component', name)
        self.features = Collection(features)
        self.bRepBodies = Collection()


adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
for cls in (DistanceExtentDefinition, ToEntityExtentDefinition, ThroughAllExtentDefinition, SymmetricExtentDefinition,
            OffsetStartDefinition, FromEntityStartDefinition, DistanceHoleExtentDefinition,
            ThroughAllHoleExtentDefinition, ToEntityHoleExtentDefinition, AngleExtentDefinition):
    setattr(adsk.fusion, cls.__name__, types.SimpleNamespace(cast=castable(cls), create=getattr(cls, 'create', None)))
for kind in ('ConstructionPlane', 'ConstructionPoint', 'ConstructionAxis', 'SketchLine', 'SketchCurve', 'BRepFace', 'BRepEdge', 'BRepBody', 'Component', 'Occurrence'):
    setattr(adsk.fusion, kind, types.SimpleNamespace(cast=lambda entity, k=kind: entity if entity.objectType.endswith('::' + k) else None))
adsk.fusion.Profile = types.SimpleNamespace(cast=lambda entity: entity if entity.objectType.endswith('::Profile') else None)
adsk.fusion.Path = types.SimpleNamespace(cast=lambda entity: entity if entity.objectType.endswith('::Path') else None)
adsk.fusion.SketchPoint = types.SimpleNamespace(cast=lambda entity: entity if entity.objectType.endswith('::SketchPoint') else None)
adsk.fusion.FilletFeatureTypes = types.SimpleNamespace(FullRoundFilletFeatureType='fullRound')
for kind in ('ConstantRadiusFilletEdgeSet', 'ChordLengthFilletEdgeSet', 'VariableRadiusFilletEdgeSet', 'AsymmetricFilletEdgeSet',
             'EqualDistanceChamferEdgeSet', 'TwoDistancesChamferEdgeSet', 'DistanceAndAngleChamferEdgeSet'):
    setattr(adsk.fusion, kind, types.SimpleNamespace(cast=lambda entity, k=kind: entity if entity.objectType.endswith('::' + k) else None))
adsk.fusion.SurfaceContinuityTypes = types.SimpleNamespace(TangentSurfaceContinuityType='tangent', CurvatureSurfaceContinuityType='curvature')
adsk.fusion.FilletFeatureTypes = types.SimpleNamespace(FullRoundFilletFeatureType='fullRound')
adsk.fusion.ExtentDirections = types.SimpleNamespace(PositiveExtentDirection='positive', NegativeExtentDirection='negative')
adsk.fusion.FeatureOperations = types.SimpleNamespace(NewBodyFeatureOperation='new', JoinFeatureOperation='join', CutFeatureOperation='cut', IntersectFeatureOperation='intersect')
adsk.fusion.SweepOrientationTypes = types.SimpleNamespace(PerpendicularOrientationType='perpendicular', ParallelOrientationType='parallel')
adsk.core.ObjectCollection = types.SimpleNamespace(create=lambda: CollectionBuilder())
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
namespace = {'CAD_HANDLERS': {}}
load_legacy_core(namespace, ROOT)
# The legacy assembly history handlers implement payloads without schemaVersion;
# feature.py composes them through a payload-shape dispatch.
exec(compile((ROOT / 'assets/cad/assembly.py').read_text(), 'assembly.py', 'exec'), namespace)
exec(compile((ROOT / 'assets/cad/feature.py').read_text(), 'feature.py', 'exec'), namespace)
HANDLERS = namespace['CAD_HANDLERS']


class Context:
    def __init__(self, component=None):
        self.component = component or Component()
        self.entities = {}
        self.created = []
        self.doc = types.SimpleNamespace(creationId='feature-fixture', name='FeatureFixture')
        self.design = types.SimpleNamespace(allParameters=Collection(), timeline=Timeline(), rootComponent=types.SimpleNamespace(allOccurrences=Collection()))

    def assert_identity(self):
        pass

    def ref(self, entity):
        self.entities[entity.entityToken] = entity
        return {'token': entity.entityToken, 'kind': entity.objectType.split('::')[-1], 'name': entity.name}

    def resolve(self, ref, kind=None):
        if isinstance(ref, str):
            return self.entities[ref]
        return self.entities[ref.get('token', ref.get('name'))]

    def _expression(self, expression, units=None):
        number, unit = expression.split()
        value = float(number)
        allowed = {'cm': ('mm', 'cm', 'in'), 'rad': ('deg', 'rad'), None: ('mm', 'cm', 'in', 'deg', 'rad')}[units]
        if unit not in allowed:
            raise ValueError('Incompatible units for expression: ' + expression)
        return expression, value * {'mm': 0.1, 'in': 2.54}.get(unit, 1)

    def expression(self, expression, units=None, unitless=False):
        return self._expression(expression, units)

    def value(self, expression):
        self._expression(expression)
        return ('expression', expression)

    def length(self, expression):
        return self._expression(expression, 'cm')[1]

    def angle(self, expression):
        return self._expression(expression, 'rad')[1]

    def describe(self, entity):
        result = self.ref(entity)
        result['objectType'] = entity.objectType
        result['isSuppressed'] = getattr(entity, 'isSuppressed', None)
        return result

    def register(self, name, entity):
        self.entities[name] = entity
        self.entities[entity.entityToken] = entity
        return entity


def make_extrude(ctx, component=None, name='Extrude1'):
    feature = ExtrudeFeature(component or ctx.component, name)
    ctx.register(name, feature)
    return feature


class FeatureReworkTests(unittest.TestCase):
    def setUp(self):
        TRACE.clear()
        self.ctx = Context()

    def call(self, operation, data):
        result = HANDLERS[operation](self.ctx, data)
        json.dumps(result)
        return result

    def test_inspect_reads_roles_from_structure_not_alongdistance(self):
        feature = make_extrude(self.ctx)
        feature.extentOne = DistanceExtentDefinition(Parameter('d12', '5 mm', 'cm', 0.5))
        feature.startExtent = OffsetStartDefinition(Parameter('d13', '2 mm', 'cm', 0.2))
        result = self.call('feature.inspect', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Extrude1'})
        roles = {row['role'] for row in result['parameters']}
        self.assertEqual(roles, {'distance', 'startOffset'})
        self.assertEqual(result['extent']['mode'], 'distance')
        self.assertEqual(result['extent']['startOffset']['expression'], '2 mm')
        self.assertNotIn('AlongDistance', json.dumps(result))
        self.assertEqual(result['roleSource'], 'feature structure')
        self.assertEqual(result['schemaVersion'], 1)

    def test_operation_change_newbody_to_join_and_cut(self):
        feature = make_extrude(self.ctx)
        self.ctx.component.bRepBodies = Collection([Entity('BRepBody', 'Body', self.ctx.component)])
        participant = Entity('BRepBody', 'Participant', self.ctx.component)
        self.ctx.register('participant', participant)
        for operation in ('join', 'cut'):
            feature.operation = 'new'
            result = self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Extrude1',
                'operationChange': {'expected': 'newBody', 'value': operation, 'participants': ['participant'], 'expectedResultBodyCount': 1}})
            self.assertEqual(result['operationChange']['actualOperation'], operation)
            self.assertEqual(result['operationChange']['directSolidBodyCount'], 1)
            self.assertTrue(result['operationChange']['posesPreserved'])
            self.assertTrue(result['markerRestored'])
            feature.operation = 'new'

    def test_operation_change_rejects_mixed_wrong_scope_and_wrong_type(self):
        make_extrude(self.ctx)
        change = {'expected': 'newBody', 'value': 'join', 'participants': ['missing'], 'expectedResultBodyCount': 1}
        with self.assertRaisesRegex(KeyError, 'missing'):
            self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Extrude1', 'operationChange': change})
        with self.assertRaisesRegex(ValueError, 'cannot be combined'):
            self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Extrude1', 'name': 'X', 'operationChange': change})
        fillet = FilletFeature(self.ctx.component)
        self.ctx.register('Fillet1', fillet)
        with self.assertRaisesRegex(ValueError, 'unsupported for feature type FilletFeature'):
            self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Fillet1', 'operationChange': change})

    def test_operation_change_noop_is_readback_verified(self):
        feature = make_extrude(self.ctx)
        self.ctx.component.bRepBodies = Collection([Entity('BRepBody', 'Body', self.ctx.component)])
        result = self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Extrude1',
            'operationChange': {'expected': 'newBody', 'value': 'newBody', 'expectedResultBodyCount': 1}})
        self.assertEqual(result['operationChange']['actualOperation'], 'newBody')
        self.assertEqual(result['operationChange']['directSolidBodyCount'], 1)
        self.assertTrue(result['operationChange']['featureIdentityPreserved'])
        self.assertFalse(any(row[0] == 'timeline' for row in TRACE))

    def test_operation_change_restores_marker_after_roll_failure(self):
        feature = make_extrude(self.ctx)
        participant = Entity('BRepBody', 'Participant', self.ctx.component)
        self.ctx.register('participant', participant)
        marker = self.ctx.design.timeline.markerPosition
        def fail_roll(_before):
            raise RuntimeError('roll failed after request')
        feature.timelineObject.rollTo = fail_roll
        with self.assertRaisesRegex(RuntimeError, 'feature.edit failed'):
            self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Extrude1',
                'operationChange': {'expected': 'newBody', 'value': 'join', 'participants': ['participant'], 'expectedResultBodyCount': 1}})
        self.assertEqual(self.ctx.design.timeline.markerPosition, marker)

    def test_operation_change_supports_documented_non_extrude_operation_setters(self):
        for kind in ('RevolveFeature', 'SweepFeature', 'LoftFeature', 'ThickenFeature'):
            with self.subTest(kind=kind):
                ctx = Context()
                feature = Entity(kind, kind + '1', ctx.component)
                participant = Entity('BRepBody', 'Body', ctx.component)
                ctx.component.bRepBodies = Collection([participant])
                ctx.register(feature.name, feature)
                ctx.register('Body', participant)
                payload = {'schemaVersion': 1, 'frame': 'component', 'feature': feature.name,
                    'operationChange': {'expected': 'newBody', 'value': 'join', 'participants': ['Body'], 'expectedResultBodyCount': 1}}
                blocked = HANDLERS['feature.edit'](ctx, payload)
                self.assertEqual(blocked['status'], 'blocked')
                self.assertEqual(feature.operation, 'new')
                payload['confirm'] = True
                result = HANDLERS['feature.edit'](ctx, payload)
                self.assertEqual(result['status'], 'pass')
                self.assertEqual(result['operationChange']['actualOperation'], 'join')
                self.assertEqual(result['operationChange']['directSolidBodyCount'], 1)
                self.assertTrue(result['operationChange']['featureIdentityPreserved'])
                self.assertTrue(result['operationChange']['markerRestored'])
                self.assertTrue(result['operationChange']['posesPreserved'])
                TRACE.clear()
                noop = HANDLERS['feature.edit'](ctx, {'schemaVersion': 1, 'frame': 'component', 'feature': feature.name,
                    'operationChange': {'expected': 'join', 'value': 'join', 'participants': ['Body'], 'expectedResultBodyCount': 1}})
                self.assertEqual(noop['status'], 'pass')
                self.assertFalse(any(row[0] == 'timeline' for row in TRACE))

    def test_non_extrude_operation_setter_failure_reports_partial_state_and_restores_marker(self):
        ctx = Context()
        feature = FailingRevolve(ctx.component)
        body = Entity('BRepBody', 'Body', ctx.component)
        ctx.component.bRepBodies = Collection([body])
        ctx.register('Revolve1', feature)
        ctx.register('Body', body)
        marker = ctx.design.timeline.markerPosition
        result = HANDLERS['feature.edit'](ctx, {'schemaVersion': 1, 'frame': 'component', 'feature': 'Revolve1',
            'operationChange': {'expected': 'newBody', 'value': 'join', 'participants': ['Body'], 'expectedResultBodyCount': 1},
            'confirm': True})
        self.assertEqual(result['status'], 'fail')
        self.assertIn('revolve operation setter failed', result['primaryError'])
        self.assertEqual(result['operationChange']['actualOperation'], 'newBody')
        self.assertEqual(result['operationChange']['directSolidBodyCount'], 1)
        self.assertTrue(result['markerRestored'])
        self.assertEqual(ctx.design.timeline.markerPosition, marker)

    def test_parameter_entries_remain_in_place_across_all_feature_families(self):
        families = ('ExtrudeFeature', 'RevolveFeature', 'FilletFeature', 'ChamferFeature', 'HoleFeature',
                    'CircularPatternFeature', 'RectangularPatternFeature', 'PathPatternFeature', 'MirrorFeature',
                    'ShellFeature', 'SweepFeature', 'LoftFeature', 'ThickenFeature')
        for index, kind in enumerate(families):
            with self.subTest(kind=kind):
                ctx = Context()
                feature = Entity(kind, 'Feature' + str(index), ctx.component)
                ctx.register(feature.name, feature)
                parameter = Parameter('p' + str(index), '1 mm', 'cm', 0.1)
                parameter.createdBy = feature
                ctx.design.allParameters = Collection([parameter])
                result = HANDLERS['feature.edit'](ctx, {'schemaVersion': 1, 'frame': 'component', 'feature': feature.name,
                    'entries': [{'name': parameter.name, 'expression': '2 mm'}]})
                self.assertEqual(parameter.expression, '2 mm')
                self.assertEqual(result['after']['type'], kind)
                self.assertEqual(result['after']['parameters'][0]['name'], parameter.name)
                self.assertEqual(result['after']['feature']['name'], feature.name)
                capabilities = result['after']['editCapabilities']
                self.assertIn('entries: exact owned ModelParameter expressions (listed in parameters)', capabilities['supported'])
                self.assertEqual(capabilities['modelParameters'][0]['name'], parameter.name)

    def test_native_edits_confirm_preview_and_family_adapters(self):
        family_specs = (
            ('ExtrudeFeature', {'profile': 'profile'}),
            ('RevolveFeature', {'profile': 'profile', 'axis': 'axis'}),
            ('FilletFeature', {'edgeSets': [{'index': 0, 'edges': ['edge'], 'radius': '3 mm'}]}),
            ('ChamferFeature', {'edgeSets': [{'index': 0, 'edges': ['edge'], 'distance': '3 mm'}]}),
            ('HoleFeature', {'holeType': {'type': 'simple'}}),
            ('CircularPatternFeature', {'entities': ['body'], 'axis': 'axis', 'suppressedElementsIds': [1]}),
            ('RectangularPatternFeature', {'entities': ['body'], 'directionOneEntity': 'axis'}),
            ('PathPatternFeature', {'entities': ['body'], 'path': 'path'}),
            ('MirrorFeature', {'entities': ['body'], 'mirrorPlane': 'plane'}),
            ('ShellFeature', {'entities': ['body']}),
            ('SweepFeature', {'profile': 'profile', 'path': 'path', 'orientation': 'parallel'}),
            ('LoftFeature', {'sections': ['profile'], 'rails': ['path']}),
            ('ThickenFeature', {'entities': ['face'], 'isSymmetric': True}),
        )
        for index, (kind, native_edits) in enumerate(family_specs):
            with self.subTest(kind=kind):
                TRACE.clear()
                ctx = Context()
                feature = Entity(kind, 'F' + str(index), ctx.component)
                ctx.register(feature.name, feature)
                if kind in ('CircularPatternFeature', 'RectangularPatternFeature', 'PathPatternFeature'):
                    feature.patternElements = Collection([types.SimpleNamespace(id=1)])
                refs = {
                    'profile': Entity('Profile', 'Profile', ctx.component),
                    'axis': Entity('ConstructionAxis', 'Axis', ctx.component),
                    'edge': Entity('BRepEdge', 'Edge', ctx.component),
                    'body': Entity('BRepBody', 'Body', ctx.component),
                    'face': Entity('BRepFace', 'Face', ctx.component),
                    'plane': Entity('ConstructionPlane', 'Plane', ctx.component),
                    'path': Entity('Path', 'Path', ctx.component),
                }
                for name, entity in refs.items():
                    ctx.register(name, entity)
                def call(data):
                    result = HANDLERS['feature.edit'](ctx, data)
                    json.dumps(result)
                    return result
                if kind in ('FilletFeature', 'ChamferFeature'):
                    edge_set = EdgeSetFixture()
                    if kind == 'ChamferFeature':
                        edge_set.objectType = 'adsk::fusion::EqualDistanceChamferEdgeSet'
                    edge_set.distance = Parameter('d', '2 mm', 'cm', .2)
                    edge_set.distanceOne = Parameter('d1', '2 mm', 'cm', .2)
                    edge_set.distanceTwo = Parameter('d2', '3 mm', 'cm', .3)
                    edge_set.angle = Parameter('a', '45 deg', 'rad', math.pi / 4)
                    feature.edgeSets = Collection([edge_set])
                if kind == 'LoftFeature':
                    feature.loftSections = Collection([FeatureCollectionItem(refs['profile'])])
                    feature.centerLineOrRails = Collection([FeatureCollectionItem(refs['path'])])
                preview = call({'schemaVersion': 1, 'frame': 'component', 'feature': feature.name,
                    'nativeEdits': native_edits, 'preview': True})
                self.assertFalse(preview['applied'])
                self.assertFalse(preview['mutation'])
                self.assertFalse(any(row[0] == 'timeline' for row in TRACE))
                blocked = call({'schemaVersion': 1, 'frame': 'component', 'feature': feature.name,
                    'nativeEdits': native_edits})
                self.assertEqual(blocked['status'], 'blocked')
                self.assertFalse(blocked['applied'])
                result = call({'schemaVersion': 1, 'frame': 'component', 'feature': feature.name,
                    'nativeEdits': native_edits, 'confirm': True})
                self.assertEqual(result['status'], 'pass', json.dumps(result))
                self.assertTrue(result['markerRestored'])
                self.assertTrue(result['featureIdentityPreserved'])
                self.assertTrue(result['posesPreserved'])

    def test_native_edit_rejections_preflight_scope_unsupported_variant_and_cardinality(self):
        ctx = Context()
        mirror = Entity('MirrorFeature', 'Mirror1', ctx.component)
        ctx.register('Mirror1', mirror)
        foreign = Component('Foreign')
        foreign_plane = Entity('ConstructionPlane', 'ForeignPlane', foreign)
        ctx.register('ForeignPlane', foreign_plane)
        with self.assertRaisesRegex(ValueError, 'owned by the selected component'):
            HANDLERS['feature.edit'](ctx, {'schemaVersion': 1, 'frame': 'component', 'feature': 'Mirror1',
                'nativeEdits': {'mirrorPlane': 'ForeignPlane'}, 'preview': True})
        hole = Entity('HoleFeature', 'Hole1', ctx.component)
        ctx.register('Hole1', hole)
        with self.assertRaisesRegex(ValueError, 'holeType.type'):
            HANDLERS['feature.edit'](ctx, {'schemaVersion': 1, 'frame': 'component', 'feature': 'Hole1',
                'nativeEdits': {'holeType': {'type': 'clearance'}}, 'preview': True})
        loft = Entity('LoftFeature', 'Loft1', ctx.component)
        profile_one, profile_two = Entity('Profile', 'P0', ctx.component), Entity('Profile', 'P1', ctx.component)
        ctx.register('P0', profile_one)
        ctx.register('P1', profile_two)
        loft.loftSections = Collection([FeatureCollectionItem(profile_one)])
        ctx.register('Loft1', loft)
        with self.assertRaisesRegex(ValueError, 'preserve collection cardinality'):
            HANDLERS['feature.edit'](ctx, {'schemaVersion': 1, 'frame': 'component', 'feature': 'Loft1',
                'nativeEdits': {'sections': ['P0', 'P1']}, 'preview': True})
        shell = Entity('ShellFeature', 'Shell1', ctx.component)
        body = Entity('BRepBody', 'ShellBody', ctx.component)
        face = Entity('BRepFace', 'ShellFace', ctx.component)
        face.body = body
        ctx.register('Shell1', shell)
        ctx.register('ShellBody', body)
        ctx.register('ShellFace', face)
        with self.assertRaisesRegex(ValueError, 'both a body and one of its faces'):
            HANDLERS['feature.edit'](ctx, {'schemaVersion': 1, 'frame': 'component', 'feature': 'Shell1',
                'nativeEdits': {'entities': ['ShellBody', 'ShellFace']}, 'preview': True})

    def test_full_round_fillet_face_sets_are_replaced_in_place(self):
        ctx = Context()
        feature = Entity('FilletFeature', 'FullRound', ctx.component)
        feature.filletFeatureType = 'fullRound'
        center = Entity('BRepFace', 'Center', ctx.component)
        side_one = Entity('BRepFace', 'SideOne', ctx.component)
        side_two = Entity('BRepFace', 'SideTwo', ctx.component)
        for face in (center, side_one, side_two):
            ctx.register(face.name, face)
        face_sets = FullRoundFaceSetsFixture()
        old = face_sets.add(center, [side_one], [side_two])
        feature.fullRoundFilletFaceSets = face_sets
        ctx.register('FullRound', feature)
        result = HANDLERS['feature.edit'](ctx, {'schemaVersion': 1, 'frame': 'component', 'feature': 'FullRound',
            'nativeEdits': {'fullRoundFaceSets': [{'centerFace': 'Center', 'sideOneFaces': ['SideOne'],
                'sideTwoFaces': ['SideTwo'], 'automaticSideFaces': True}]}, 'confirm': True})
        self.assertEqual(result['status'], 'pass', json.dumps(result))
        self.assertEqual(face_sets.count, 1)
        self.assertIsNot(face_sets.item(0), old)
        self.assertTrue(result['featureIdentityPreserved'])

    def test_native_edits_cover_fillet_and_chamfer_edge_set_variants(self):
        cases = (
            ('FilletFeature', 'ConstantRadiusFilletEdgeSet', {'radius': '2 mm'}),
            ('FilletFeature', 'ChordLengthFilletEdgeSet', {'chordLength': '2 mm'}),
            ('FilletFeature', 'VariableRadiusFilletEdgeSet', {'startRadius': '1 mm', 'endRadius': '2 mm', 'midRadii': ['1.5 mm'], 'midPositions': [0.5]}),
            ('FilletFeature', 'AsymmetricFilletEdgeSet', {'offsetOne': '1 mm', 'offsetTwo': '2 mm', 'isFlipped': False}),
            ('ChamferFeature', 'EqualDistanceChamferEdgeSet', {'distance': '1 mm'}),
            ('ChamferFeature', 'TwoDistancesChamferEdgeSet', {'distanceOne': '1 mm', 'distanceTwo': '2 mm', 'isFlipped': False}),
            ('ChamferFeature', 'DistanceAndAngleChamferEdgeSet', {'distance': '1 mm', 'angle': '45 deg', 'isFlipped': False}),
        )
        for index, (kind, variant, fields) in enumerate(cases):
            with self.subTest(kind=kind, variant=variant):
                TRACE.clear()
                ctx = Context()
                feature = FilletFeature(ctx.component) if kind == 'FilletFeature' else Entity(kind, 'Chamfer'+str(index), ctx.component)
                feature.name = 'EdgeFeature' + str(index)
                feature.edgeSets = Collection([EdgeSetFixture(variant)])
                edge = Entity('BRepEdge', 'Edge', ctx.component)
                ctx.register(feature.name, feature)
                ctx.register('Edge', edge)
                row = {'index': 0, **fields}
                if 'radius' not in fields and 'chordLength' not in fields and 'startRadius' not in fields and 'offsetOne' not in fields and 'distance' not in fields and 'distanceOne' not in fields:
                    raise AssertionError('fixture must exercise a dimensional field')
                row['edges'] = ['Edge']
                result = HANDLERS['feature.edit'](ctx, {'schemaVersion': 1, 'frame': 'component', 'feature': feature.name,
                    'nativeEdits': {'edgeSets': [row]}, 'confirm': True})
                self.assertEqual(result['status'], 'pass')
                self.assertTrue(result['markerRestored'])
                self.assertTrue(result['featureIdentityPreserved'])

    def test_native_edge_set_edit_reacquires_timeline_after_edge_rebuild(self):
        TRACE.clear()
        ctx = Context()
        feature = FilletFeature(ctx.component)
        edge_set = EdgeSetFixture()
        feature.edgeSets = Collection([edge_set])
        edge_set.on_edges_assignment = lambda: self._invalidate_native_objects(ctx, feature, edge_set)
        old_edge = Entity('BRepEdge', 'OldEdge', ctx.component)
        new_edge = Entity('BRepEdge', 'NewEdge', ctx.component)
        ctx.register('Fillet1', feature)
        ctx.register('OldEdge', old_edge)
        ctx.register('NewEdge', new_edge)
        result = HANDLERS['feature.edit'](ctx, {'schemaVersion': 1, 'frame': 'component', 'feature': 'Fillet1',
            'nativeEdits': {'edgeSets': [{'index': 0, 'edges': ['NewEdge'], 'radius': '2.5 mm'}]}, 'confirm': True})
        self.assertEqual(result['status'], 'pass', json.dumps(result))
        self.assertEqual(list(feature.edgeSets.item(0).edges), [new_edge])
        self.assertTrue(result['markerRestored'])
        self.assertEqual(result['timelinePositionAfter'], ctx.design.timeline.markerPosition)
        self.assertFalse(any(row[0] == 'timeline' and row[1] == 'moveToEnd' for row in TRACE))

    @staticmethod
    def _invalidate_native_objects(ctx, feature, old_edge_set):
        old = ctx.design.timeline
        old.stale = True
        fresh = Timeline(old.items)
        fresh.markerPosition = old.markerPosition
        ctx.design.timeline = fresh
        replacement = EdgeSetFixture()
        replacement._edges = old_edge_set.edges
        replacement._radius.expression = old_edge_set._radius.expression
        old_edge_set.stale = True
        feature.edgeSets.values[0] = replacement

    def test_non_extrude_operation_change_requires_confirmation(self):
        ctx = Context()
        feature = RevolveFeature(ctx.component)
        ctx.register('Revolve1', feature)
        body = Entity('BRepBody', 'Body', ctx.component)
        ctx.component.bRepBodies = Collection([body])
        ctx.register('Body', body)
        payload = {'schemaVersion': 1, 'frame': 'component', 'feature': 'Revolve1',
            'operationChange': {'expected': 'newBody', 'value': 'join', 'participants': ['Body'], 'expectedResultBodyCount': 1}}
        blocked = HANDLERS['feature.edit'](ctx, payload)
        self.assertEqual(blocked['status'], 'blocked')
        self.assertEqual(feature.operation, 'new')
        payload['confirm'] = True
        result = HANDLERS['feature.edit'](ctx, payload)
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['operationChange']['actualOperation'], 'join')

    def test_expected_operation_mismatch_and_unsupported_feature_fail_before_roll(self):
        feature = make_extrude(self.ctx)
        feature.operation = 'join'
        participant = Entity('BRepBody', 'Participant', self.ctx.component)
        self.ctx.register('participant', participant)
        with self.assertRaisesRegex(ValueError, 'Expected operation does not match'):
            self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Extrude1',
                'operationChange': {'expected': 'newBody', 'value': 'cut', 'participants': ['participant'], 'expectedResultBodyCount': 1}})
        self.assertFalse(any(row[0] == 'timeline' for row in TRACE))
        nonparametric = Entity('ThreadFeature', 'Thread1', self.ctx.component)
        self.ctx.register('Thread1', nonparametric)
        with self.assertRaisesRegex(ValueError, 'nativeEdits is unsupported for feature type ThreadFeature'):
            self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Thread1',
                'nativeEdits': {'profile': 'some-profile'}, 'preview': True})
        inspected = self.call('feature.inspect', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Thread1'})
        self.assertIn('type-specific nativeEdits are unsupported for ThreadFeature', inspected['editCapabilities']['unsupported'])

    def test_native_edits_replaces_full_round_fillet_face_sets_in_place(self):
        ctx = Context()
        feature = Entity('FilletFeature', 'FullRound1', ctx.component)
        feature.filletFeatureType = 'fullRound'
        center, side_one, side_two = (Entity('BRepFace', name, ctx.component) for name in ('Center', 'SideOne', 'SideTwo'))
        for name, face in (('Center', center), ('SideOne', side_one), ('SideTwo', side_two)):
            ctx.register(name, face)
        original = FullRoundFaceSetFixture(center, [side_one], [side_two])
        sets = FullRoundFaceSetsFixture([original])
        original.owner = sets
        feature.fullRoundFilletFaceSets = sets
        ctx.register('FullRound1', feature)
        result = HANDLERS['feature.edit'](ctx, {'schemaVersion': 1, 'frame': 'component', 'feature': 'FullRound1',
            'nativeEdits': {'fullRoundFaceSets': [{'centerFace': 'Center', 'sideOneFaces': ['SideOne'],
                'sideTwoFaces': ['SideTwo'], 'automaticSideFaces': True}]}, 'confirm': True})
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(sets.count, 1)
        self.assertIsNot(sets.item(0), original)
        self.assertTrue(result['featureIdentityPreserved'])
        self.assertTrue(result['markerRestored'])

    def test_native_setter_failure_reports_partial_effect_and_restores_marker(self):
        ctx = Context()
        feature = FailingProfileExtrude(ctx.component, 'FailingExtrude')
        profile = Entity('Profile', 'Profile', ctx.component)
        ctx.register('FailingExtrude', feature)
        ctx.register('Profile', profile)
        marker = ctx.design.timeline.markerPosition
        result = HANDLERS['feature.edit'](ctx, {'schemaVersion': 1, 'frame': 'component', 'feature': 'FailingExtrude',
            'nativeEdits': {'profile': 'Profile'}, 'confirm': True})
        self.assertEqual(result['status'], 'fail')
        self.assertIn('native profile setter failed', result['primaryError'])
        self.assertTrue(result['markerRestored'])
        self.assertEqual(ctx.design.timeline.markerPosition, marker)

    def test_ambiguous_role_requires_name(self):
        fillet = FilletFeature(self.ctx.component)
        self.ctx.register('Fillet1', fillet)
        radius_one, radius_two = Parameter('r1', '3 mm', 'cm', 0.3), Parameter('r2', '2 mm', 'cm', 0.2)
        radius_one.createdBy = radius_two.createdBy = fillet
        self.ctx.design.allParameters = Collection([radius_one, radius_two])
        with self.assertRaisesRegex(ValueError, 'Ambiguous'):
            self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Fillet1',
                                       'entries': [{'role': 'unknown', 'expression': '4 mm'}], 'preview': True})
        result = self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Fillet1',
                                            'entries': [{'name': 'r2', 'expression': '4 mm'}], 'preview': True})
        self.assertTrue(result['applied'] is False)
        self.assertEqual(result['steps'][0]['name'], 'r2')

    def test_unknown_role_and_unsupported_type(self):
        feature = make_extrude(self.ctx)
        feature.extentOne = DistanceExtentDefinition(Parameter('d12', '5 mm', 'cm', 0.5))
        with self.assertRaisesRegex(ValueError, 'No feature parameter matches'):
            self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Extrude1',
                                       'entries': [{'role': 'radius', 'expression': '3 mm'}], 'preview': True})
        fillet = FilletFeature(self.ctx.component)
        self.ctx.register('Fillet1', fillet)
        inspected = self.call('feature.inspect', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Fillet1'})
        self.assertEqual(inspected['extent']['mode'], 'unsupported')
        self.assertEqual(inspected['roleSource'], 'feature structure')
        with self.assertRaisesRegex(ValueError, 'Extent editing is unsupported'):
            self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Fillet1',
                                       'extent': {'mode': 'distance', 'distance': '1 mm'}, 'preview': True})

    def test_preview_plans_without_mutation(self):
        feature = make_extrude(self.ctx)
        distance = Parameter('d12', '5 mm', 'cm', 0.5)
        start = Parameter('d13', '2 mm', 'cm', 0.2)
        feature.extentOne = DistanceExtentDefinition(distance)
        feature.startExtent = OffsetStartDefinition(start)
        result = self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Extrude1',
                                            'entries': [{'role': 'startOffset', 'expression': '3 mm'}], 'preview': True})
        self.assertTrue(result['applied'] is False)
        self.assertEqual(start.expression, '2 mm')
        self.assertFalse(any(t[0] == 'timeline' for t in TRACE))

    def test_edit_applies_entries_and_extent_with_marker_restore(self):
        feature = make_extrude(self.ctx)
        distance = Parameter('d12', '5 mm', 'cm', 0.5)
        start = Parameter('d13', '2 mm', 'cm', 0.2)
        feature.extentOne = DistanceExtentDefinition(distance)
        feature.startExtent = OffsetStartDefinition(start)
        self.ctx.design.timeline = Timeline([TimelineItem('Before'), TimelineItem('Before'), TimelineItem('Extrude1'),
                                             TimelineItem('After1'), TimelineItem('After2')])
        result = self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Extrude1',
                                            'entries': [{'role': 'startOffset', 'expression': '3 mm'}],
                                            'extent': {'mode': 'distance', 'distance': '20 mm'}})
        self.assertEqual(start.expression, '3 mm')
        self.assertTrue(result['applied'])
        self.assertTrue(result['markerRestored'])
        self.assertFalse(result['geometryDeleted'])
        self.assertTrue(any(t == ('timeline', 'rollTo', True) for t in TRACE))
        self.assertTrue(any(t == ('timeline', 'moveToEnd') for t in TRACE))
        self.assertEqual(next(row for row in result['after']['parameters'] if row['role'] == 'startOffset')['expression'], '3 mm')
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['downstream']['scanned'], 2)

    def test_failure_restores_marker_and_never_deletes_geometry(self):
        feature = make_extrude(self.ctx)
        feature.extentOne = DistanceExtentDefinition(Parameter('d12', '5 mm', 'cm', 0.5))

        def refuse(*args):
            raise RuntimeError('Kernel rejected extent')
        feature.setOneSideExtent = refuse
        with self.assertRaisesRegex(RuntimeError, 'feature.edit failed'):
            self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Extrude1',
                                       'extent': {'mode': 'distance', 'distance': '20 mm'}})
        self.assertTrue(any(t == ('timeline', 'moveToEnd') for t in TRACE))
        self.assertFalse(any('delete' in str(t) for t in TRACE))

    def test_downstream_failure_reported(self):
        feature = make_extrude(self.ctx)
        distance = Parameter('d12', '5 mm', 'cm', 0.5)
        feature.extentOne = DistanceExtentDefinition(distance)
        self.ctx.design.timeline = Timeline([TimelineItem('B0'), TimelineItem('B1'), TimelineItem('Extrude1'),
                                             TimelineItem('After1'), TimelineItem('Broken', health=2, message='Regeneration failed')])
        result = self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Extrude1',
                                            'entries': [{'name': 'd12', 'role': 'distance', 'expression': '6 mm'}]})
        self.assertEqual(result['status'], 'fail')
        self.assertTrue(result['downstream']['unhealthy'])

    def test_cross_component_target_reported_and_refused(self):
        other = Component(name='Other')
        target = Entity('ConstructionPlane', name='Target', component=other)
        self.ctx.register('target', target)
        feature = make_extrude(self.ctx)
        feature.extentOne = ToEntityExtentDefinition(target, offset=Parameter('d14', '0 mm', 'cm', 0.0))
        inspected = self.call('feature.inspect', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Extrude1'})
        ownership = inspected['extent']['target']
        self.assertEqual(ownership['ownership'], 'foreign')
        self.assertFalse(ownership['editable'])
        with self.assertRaisesRegex(ValueError, 'Cross-component extent target is refused'):
            self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Extrude1',
                                       'extent': {'mode': 'toEntity', 'target': 'target'}, 'preview': True})

    def test_legacy_payloads_keep_the_legacy_handler(self):
        feature = make_extrude(self.ctx)
        parameter = Parameter('d1', '2 mm', 'cm', 0.2)
        parameter.createdBy = feature
        self.ctx.design.allParameters = Collection([parameter])
        legacy = self.call('feature.inspect', {'feature': 'Extrude1'})
        self.assertNotIn('schemaVersion', legacy)
        self.assertEqual(legacy['feature']['name'], 'Extrude1')
        self.assertEqual(legacy['parameters'][0]['expression'], '2 mm')
        self.assertIn('schemaVersion', self.call('feature.inspect', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Extrude1'}))

    def test_rename_collision_and_unit_validation(self):
        feature = make_extrude(self.ctx)
        feature.extentOne = DistanceExtentDefinition(Parameter('d12', '5 mm', 'cm', 0.5))
        sibling = ExtrudeFeature(self.ctx.component, 'Other')
        self.ctx.component.features = Collection([feature, sibling])
        with self.assertRaisesRegex(ValueError, 'collision'):
            self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Extrude1',
                                       'name': 'Other', 'preview': True})
        with self.assertRaisesRegex(ValueError, 'Incompatible units'):
            self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Extrude1',
                                       'entries': [{'name': 'd12', 'expression': '5 rad'}], 'preview': True})

    def test_revolve_reads_angle_from_extent_definition(self):
        feature = RevolveFeature(self.ctx.component, angle=Parameter('a1', '90 deg', 'rad', math.pi / 2))
        self.ctx.register('Revolve1', feature)
        result = self.call('feature.inspect', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Revolve1'})
        roles = {row['role'] for row in result['parameters']}
        self.assertEqual(roles, {'angle'})
        self.assertEqual(result['roleSource'], 'feature structure')
        self.assertEqual(result['extent']['mode'], 'angle')
        self.assertEqual(result['extent']['angle']['expression'], '90 deg')

    def test_revolve_edit_applies_angle_extent(self):
        feature = RevolveFeature(self.ctx.component, angle=Parameter('a1', '90 deg', 'rad', math.pi / 2))
        self.ctx.register('Revolve1', feature)
        result = self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Revolve1',
                                            'extent': {'mode': 'angle', 'angle': '180 deg'}})
        self.assertTrue(result['applied'])
        self.assertTrue(result['markerRestored'])
        self.assertTrue(any(t == ('apply', 'setAngleExtent', False, ('expression', '180 deg')) for t in TRACE))
        self.assertEqual(result['after']['extent']['mode'], 'angle')

    def test_revolve_two_side_extent_and_direction_modes(self):
        feature = RevolveFeature(self.ctx.component, angle=Parameter('a1', '90 deg', 'rad', math.pi / 2))
        self.ctx.register('Revolve1', feature)
        result = self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Revolve1',
            'extent': {'mode': 'twoSideAngle', 'angle': '60 deg', 'angleTwo': '-30 deg'}})
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(any(row[1] == 'setTwoSideAngleExtent' for row in TRACE if row[0] == 'apply'))

    def test_hole_distance_and_through_all_extents_are_native_in_place(self):
        feature = HoleFeature(self.ctx.component)
        self.ctx.register('Hole1', feature)
        result = self.call('feature.edit', {'schemaVersion': 1, 'frame': 'component', 'feature': 'Hole1',
            'extent': {'mode': 'throughAll', 'reverse': True}, 'confirm': True})
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(any(row[1] == 'setAllExtent' for row in TRACE if row[0] == 'apply'))

    def test_hole_native_position_uses_associative_points_and_refuses_transient_point(self):
        ctx = Context()
        feature = Entity('HoleFeature', 'Hole1', ctx.component)
        point = Entity('SketchPoint', 'HolePoint', ctx.component)
        ctx.register('Hole1', feature)
        ctx.register('HolePoint', point)
        result = HANDLERS['feature.edit'](ctx, {'schemaVersion': 1, 'frame': 'component', 'feature': 'Hole1',
            'nativeEdits': {'position': {'mode': 'sketchPoint', 'point': 'HolePoint'}}, 'confirm': True})
        self.assertEqual(result['status'], 'pass', json.dumps(result))
        with self.assertRaisesRegex(ValueError, 'non-associative'):
            HANDLERS['feature.edit'](ctx, {'schemaVersion': 1, 'frame': 'component', 'feature': 'Hole1',
                'nativeEdits': {'position': {'mode': 'point', 'plane': 'XY', 'point': ['0 mm', '0 mm', '0 mm']}}, 'preview': True})

    def test_hole_simple_counterbore_and_countersink_native_variants(self):
        for spec in ({'type': 'simple'}, {'type': 'counterbore', 'diameter': '5 mm', 'depth': '2 mm'},
                     {'type': 'countersink', 'diameter': '5 mm', 'angle': '90 deg'}):
            with self.subTest(holeType=spec['type']):
                ctx = Context()
                feature = HoleFeature(ctx.component)
                ctx.register('Hole1', feature)
                result = HANDLERS['feature.edit'](ctx, {'schemaVersion': 1, 'frame': 'component', 'feature': 'Hole1',
                    'nativeEdits': {'holeType': spec}, 'confirm': True})
                self.assertEqual(result['status'], 'pass')
                self.assertEqual(feature.holeType, spec['type'])

    def test_toentity_plan_captures_native_target_and_apply_uses_it_directly(self):
        plan_fn = namespace['_feature_extent_plan']
        apply_extent = namespace['_feature_apply_extent']
        feature = make_extrude(self.ctx)
        target = Entity('ConstructionPlane', name='G0904Plane', component=self.ctx.component)
        self.ctx.register('G0904Plane', target)
        spec = {'mode': 'toEntity', 'target': 'G0904Plane', 'offset': '0 mm'}
        plan = plan_fn(self.ctx, feature, {}, spec)
        self.assertIs(plan['target'], target)
        # After the marker rolls back to the feature, both name and token resolve
        # fail for the downstream plane; only the captured native object survives,
        # so apply must hand it to ToEntityExtentDefinition.create without resolving.
        del self.ctx.entities['G0904Plane']
        del self.ctx.entities[target.entityToken]
        apply_extent(self.ctx, feature, spec, plan)
        created = next(t for t in TRACE if t[:2] == ('extent', 'toEntity-create'))
        self.assertIs(created[2], target)


if __name__ == '__main__':
    unittest.main()
