"""Offline API-shape tests, not a substitute for Fusion kernel integration tests."""
import json
import math
import pathlib
import sys
import types
import unittest


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


class Point:
    def __init__(self, x, y, z):
        self.x, self.y, self.z = x, y, z

    @staticmethod
    def create(x, y, z):
        return Point(x, y, z)


class RigidTransform:
    def __init__(self, rotation=None, translation=(0, 0, 0)):
        self.rotation = rotation or ((1, 0, 0), (0, 1, 0), (0, 0, 1))
        self.translation = translation

    def point(self, value):
        rotated = self.vector(value)
        return Point(*(rotated[i] + self.translation[i] for i in range(3)))

    def vector(self, value):
        xyz = (value.x, value.y, value.z)
        return tuple(sum(self.rotation[i][j] * xyz[j] for j in range(3)) for i in range(3))

    def compose(self, other):
        rotation = tuple(tuple(sum(self.rotation[i][k] * other.rotation[k][j] for k in range(3))
                               for j in range(3)) for i in range(3))
        origin = self.point(Point(*other.translation))
        return RigidTransform(rotation, (origin.x, origin.y, origin.z))


class Plane:
    def __init__(self, name='XY', origin=None, normal=None):
        self.name = name
        self.origin = origin or Point(0, 0, 0)
        self.normal = normal or Point(0, 0, 1)

    @staticmethod
    def cast(entity):
        return entity if isinstance(entity, Plane) else None

    def isCoPlanarTo(self, other):
        a = (self.normal.x, self.normal.y, self.normal.z)
        b = (other.normal.x, other.normal.y, other.normal.z)
        cross = (a[1] * b[2] - a[2] * b[1],
                 a[2] * b[0] - a[0] * b[2],
                 a[0] * b[1] - a[1] * b[0])
        if sum(value * value for value in cross) > 1e-12:
            return False
        delta = (other.origin.x - self.origin.x, other.origin.y - self.origin.y,
                 other.origin.z - self.origin.z)
        return abs(sum(a[i] * delta[i] for i in range(3))) <= 1e-9

    def copy(self):
        return Plane(self.name, Point(self.origin.x, self.origin.y, self.origin.z),
                     Point(self.normal.x, self.normal.y, self.normal.z))

    def transformBy(self, transform):
        self.origin = transform.point(self.origin)
        self.normal = Point(*transform.vector(self.normal))
        return True


class NurbsCurve3D:
    @staticmethod
    def createNonRational(controlPoints, degree, knots, isPeriodic):
        assert isinstance(controlPoints, list)
        assert all(isinstance(p, Point) for p in controlPoints)
        assert isinstance(knots, list)
        assert type(isPeriodic) is bool
        result = NurbsCurve3D()
        result.controlPoints, result.degree = controlPoints, degree
        result.knots, result.isPeriodic = knots, isPeriodic
        TRACE.append(('nurbs', result))
        return result


class Entity:
    serial = 0

    def __init__(self, kind='BRepBody', sketch=None, name=None):
        Entity.serial += 1
        self.objectType = 'adsk::fusion::' + kind
        self.entityToken = str(Entity.serial)
        self.name = name or self.entityToken
        self.assemblyContext = None
        if sketch is not None:
            self.parentSketch = sketch
        self.isFullyConstrained = False
        self.isConstruction = False
        self.isFixed = False
        self.healthState = 0
        self.errorOrWarningMessage = ''
        self.bodies = Collection()

    def deleteMe(self):
        TRACE.append(('delete', self.entityToken))
        return True


class SketchPoint(Entity):
    def __init__(self, point, sketch):
        super().__init__('SketchPoint', sketch)
        self.geometry = point

    @staticmethod
    def cast(entity):
        return entity if isinstance(entity, SketchPoint) else None


class SketchLine(Entity):
    def __init__(self, a, b, sketch):
        super().__init__('SketchLine', sketch)
        self.startSketchPoint = SketchPoint(a, sketch)
        self.endSketchPoint = SketchPoint(b, sketch)

    @staticmethod
    def cast(entity):
        return entity if isinstance(entity, SketchLine) else None


class SketchCircle(Entity):
    def __init__(self, center, radius, sketch):
        super().__init__('SketchCircle', sketch)
        self.centerSketchPoint = SketchPoint(center, sketch)
        self.radius = radius

    @staticmethod
    def cast(entity):
        return entity if isinstance(entity, SketchCircle) else None


class SketchArc(Entity):
    def __init__(self, center, start, end, sketch):
        super().__init__('SketchArc', sketch)
        self.centerSketchPoint = SketchPoint(center, sketch)
        self.startSketchPoint = SketchPoint(start, sketch)
        self.endSketchPoint = SketchPoint(end, sketch)

    @staticmethod
    def cast(entity):
        return entity if isinstance(entity, SketchArc) else None


class SketchFixedSpline(Entity):
    def __init__(self, geometry, sketch):
        super().__init__('SketchFixedSpline', sketch)
        self.geometry = geometry
        self.isFixed = True

    def __setattr__(self, name, value):
        if name == 'isFixed' and getattr(self, 'isFixed', False):
            raise AssertionError('Fixed spline must not need fixed-state assignment')
        super().__setattr__(name, value)


class CurveFactory:
    def __init__(self, sketch):
        self.sketch = sketch

    def record(self, method, entity):
        TRACE.append((method,))
        self.sketch.sketchCurves.values.append(entity)
        return entity

    def addByTwoPoints(self, a, b):
        return self.record('line', SketchLine(a, b, self.sketch))

    def addTwoPointRectangle(self, a, b):
        points = [a, Point(b.x, a.y, a.z), b, Point(a.x, b.y, b.z)]
        return Collection([self.addByTwoPoints(points[i], points[(i + 1) % 4]) for i in range(4)])

    def addByCenterRadius(self, center, radius):
        assert isinstance(radius, float)
        return self.record('circle', SketchCircle(center, radius, self.sketch))

    def addByCenterStartSweep(self, center, start, sweep):
        assert isinstance(sweep, float)
        TRACE.append(('sweepRadians', sweep))
        return self.record('arc', SketchArc(center, start, start, self.sketch))

    def addByThreePoints(self, start, through, end):
        return self.record('arc3', SketchArc(through, start, end, self.sketch))

    def addByCenterStartEnd(self, center, start, end):
        return self.record('arcMirror', SketchArc(center, start, end, self.sketch))

    def add(self, points):
        assert isinstance(points, Collection)
        return self.record('spline', Entity('SketchFittedSpline', self.sketch))

    def addByNurbsCurve(self, curve):
        assert isinstance(curve, NurbsCurve3D)
        return self.record('bezier', SketchFixedSpline(curve, self.sketch))


class PointFactory(Collection):
    def __init__(self, sketch):
        super().__init__()
        self.sketch = sketch

    def add(self, point):
        result = SketchPoint(point, self.sketch)
        self.values.append(result)
        TRACE.append(('point',))
        return result


class Input:
    properties = {'quantity', 'totalAngle', 'isSymmetric', 'directionTwoEntity', 'quantityTwo',
                  'distanceTwo', 'isSolid', 'participantBodies', 'twistAngle', 'taperAngle',
                  'isClosed', 'isDefaultDirection', 'insideThickness', 'outsideThickness',
                  'operation', 'isKeepToolBodies', 'isDirectionFlipped', 'isModeled',
                  'isFullLength', 'threadLength', 'threadOffset', 'startExtent', 'orientation', 'guideRail'}

    def __setattr__(self, name, value):
        if name not in self.properties:
            raise AttributeError('Undocumented feature input property: ' + name)
        if name == 'guideRail':
            assert isinstance(value, Path)
        if name == 'orientation':
            assert value in ('ParallelOrientationType', 'PerpendicularOrientationType')
        if name == 'startExtent':
            assert isinstance(value, OffsetStartDefinition)
        TRACE.append(('set', name, value))
        object.__setattr__(self, name, value)

    def setSymmetricExtent(self, distance, full, taper):
        TRACE.append(('symmetricExtent', distance, full, taper))
        return True

    def setOneSideExtent(self, extent, direction, taper):
        assert isinstance(extent, (DistanceExtentDefinition, ThroughAllExtentDefinition, ToEntityExtentDefinition))
        assert direction in ('PositiveExtentDirection', 'NegativeExtentDirection')
        assert isinstance(taper, ValueInput)
        TRACE.append(('oneSideExtent', extent, direction, taper))
        return True

    def setAngleExtent(self, symmetric, angle):
        TRACE.append(('angleExtent', symmetric, angle))
        return True

    def setPositionBySketchPoints(self, points):
        assert isinstance(points, Collection)
        TRACE.append(('holePoints', points))
        return True

    def setDistanceExtent(self, distance):
        assert isinstance(distance, ValueInput)
        TRACE.append(('holeDepth', distance))
        return True

    def setAllExtent(self, direction):
        assert direction in ('PositiveExtentDirection', 'NegativeExtentDirection')
        TRACE.append(('holeAll', direction))
        # Native input changes this flag; the handler must explicitly restore
        # the requested natural/reversed convention after setting the extent.
        object.__setattr__(self, 'isDefaultDirection', direction == 'PositiveExtentDirection')
        return True

    def setOneSideToExtent(self, target, matchShape, directionHint=None):
        assert target.objectType.split('::')[-1] in ('BRepBody', 'BRepFace', 'BRepVertex', 'ConstructionPlane', 'ConstructionPoint')
        assert type(matchShape) is bool
        assert directionHint is None
        TRACE.append(('holeTo', target, matchShape, directionHint))
        return True

    def setSingleAngle(self, symmetric, angle):
        assert type(symmetric) is bool
        TRACE.append(('draftAngle', symmetric, angle))
        return True

    def setDirectionOne(self, direction, quantity, distance):
        TRACE.append(('sketchDirectionOne', direction, quantity, distance))
        return True

    def setDirectionTwo(self, direction, quantity, distance):
        TRACE.append(('sketchDirectionTwo', direction, quantity, distance))
        return True

    @property
    def edgeSetInputs(self):
        return self

    def addConstantRadiusEdgeSet(self, entities, radius, chain):
        assert isinstance(entities, Collection)
        TRACE.append(('filletEdges', entities, radius, chain))
        return Entity('ConstantRadiusFilletEdgeSetInput')

    @property
    def chamferEdgeSets(self):
        return self

    def addEqualDistanceChamferEdgeSet(self, edges, distance, chain):
        assert isinstance(edges, Collection)
        TRACE.append(('chamferEdges', edges, distance, chain))
        return True

    @property
    def loftSections(self):
        return self

    @property
    def centerLineOrRails(self):
        return self

    def addRail(self, entity):
        assert isinstance(entity, Path) or adsk.fusion.SketchCurve.cast(entity) or adsk.fusion.BRepEdge.cast(entity)
        TRACE.append(('loftRail', entity))
        return Entity('LoftCenterLineOrRail')

    def addCenterLine(self, entity):
        assert isinstance(entity, Path) or adsk.fusion.SketchCurve.cast(entity) or adsk.fusion.BRepEdge.cast(entity)
        TRACE.append(('loftCenterLine', entity))
        return Entity('LoftCenterLineOrRail')

    def add(self, profile):
        TRACE.append(('loftSection', profile))
        return Entity('LoftSection')


class FeatureFactory:
    counts = {'extrude': 2, 'revolve': 3, 'sweep': 3, 'loft': 1, 'shell': 2,
              'thicken': 5, 'combine': 2, 'splitBody': 3, 'fillet': 0, 'draft': 3,
              'thread': 2, 'mirror': 2, 'circularPattern': 2, 'rectangularPattern': 5, 'pathPattern': 5}

    def __init__(self, mode):
        self.mode = mode
        self.fail = False
        self.unhealthy = False
        self.warning = False
        self.result_bodies = []
        self.last_profile_input = None

    def createInput(self, *args):
        assert len(args) == self.counts[self.mode], (self.mode, args)
        if self.mode == 'extrude':
            self.last_profile_input = args[0]
        if self.mode == 'draft':
            assert isinstance(args[0], list)
        if self.mode in ('shell', 'thicken', 'splitBody', 'thread', 'mirror', 'circularPattern', 'rectangularPattern', 'pathPattern'):
            assert isinstance(args[0], Collection)
        if self.mode == 'combine':
            assert isinstance(args[1], Collection)
        if self.mode == 'sweep':
            assert isinstance(args[1], Path)
        TRACE.append(('input', self.mode, args))
        return Input()

    def createInput2(self):
        assert self.mode == 'chamfer'
        TRACE.append(('input2', self.mode))
        return Input()

    def createSimpleInput(self, diameter):
        TRACE.append(('simpleHole', diameter))
        return Input()

    def createCounterboreInput(self, diameter, bore, depth):
        TRACE.append(('counterbore', diameter, bore, depth))
        return Input()

    def createCountersinkInput(self, diameter, sink, angle):
        TRACE.append(('countersink', diameter, sink, angle))
        return Input()

    def add(self, inp):
        assert isinstance(inp, Input)
        TRACE.append(('feature', self.mode))
        result = Entity(self.mode.title() + 'Feature')
        result.bodies = Collection(self.result_bodies)
        if self.unhealthy:
            result.healthState = 2
            result.errorOrWarningMessage = 'Kernel rejected shape'
        elif self.warning:
            result.healthState = 1
            result.errorOrWarningMessage = 'Some profiles did not produce tool bodies'
        return None if self.fail else result


class Constraints(Collection):
    arity = {'addCoincident': 2, 'addCollinear': 2, 'addConcentric': 2, 'addMidPoint': 2,
             'addParallel': 2, 'addPerpendicular2': 2, 'addHorizontal': 1, 'addVertical': 1,
             'addHorizontalPoints': 2, 'addVerticalPoints': 2, 'addTangent': 2,
             'addSmooth': 2, 'addEqual': 2, 'addSymmetry': 3}

    def __init__(self, sketch):
        super().__init__()
        self.sketch = sketch

    def __getattr__(self, method):
        if method not in self.arity:
            raise AttributeError(method)

        def create(*args):
            assert len(args) == self.arity[method]
            TRACE.append((method, *args))
            result = Entity('GeometricConstraint', self.sketch)
            self.values.append(result)
            return result
        return create

    def createOffsetInput(self, curves, distance):
        assert isinstance(curves, list)
        TRACE.append(('offsetInput', curves, distance))
        return Input()

    def addOffset2(self, inp):
        TRACE.append(('offset',))
        result = Entity('OffsetConstraint', self.sketch)
        result.childCurves = [Entity('SketchLine', self.sketch)]
        return result

    def createCircularPatternInput(self, entities, center):
        assert isinstance(entities, list)
        assert isinstance(center, SketchPoint)
        return Input()

    def addCircularPattern(self, inp):
        TRACE.append(('sketchCircular',))
        return Entity('CircularPatternConstraint', self.sketch)

    def createRectangularPatternInput(self, entities, distance_type):
        assert isinstance(entities, list)
        return Input()

    def addRectangularPattern(self, inp):
        TRACE.append(('sketchRectangular',))
        return Entity('RectangularPatternConstraint', self.sketch)


class Dimensions(Collection):
    def dimension(self, mode, driving):
        TRACE.append(('dimension', mode, driving))
        result = Entity('SketchDimension')
        result.isDriving = driving
        result.parameter = types.SimpleNamespace(name='d1', expression='1 mm')
        self.values.append(result)
        return result

    def addDistanceDimension(self, a, b, orientation, text, driving):
        assert isinstance(a, SketchPoint) and isinstance(b, SketchPoint)
        return self.dimension('distance', driving)

    def addAngularDimension(self, a, b, text, driving):
        return self.dimension('angle', driving)

    def addRadialDimension(self, curve, text, driving):
        return self.dimension('radius', driving)

    def addDiameterDimension(self, curve, text, driving):
        return self.dimension('diameter', driving)


class Sketch(Entity):
    def __init__(self, component):
        super().__init__('Sketch')
        self.parentComponent = component
        self.transform = RigidTransform()
        self.referencePlane = types.SimpleNamespace(geometry=Plane())
        self.sketchCurves = Collection()
        factory = CurveFactory(self)
        for prop in ('sketchLines', 'sketchCircles', 'sketchArcs', 'sketchFittedSplines', 'sketchFixedSplines'):
            setattr(self.sketchCurves, prop, factory)
        self.sketchPoints = PointFactory(self)
        self.geometricConstraints = Constraints(self)
        self.sketchDimensions = Dimensions()
        profile = Entity('Profile', self)
        profile.plane = self.referencePlane.geometry
        profile.profileLoops = Collection([object()])
        self.profiles = Collection([profile])

    def project2(self, entities, linked):
        assert isinstance(entities, list) and type(linked) is bool
        TRACE.append(('project2', linked))
        return [Entity('SketchLine', self)]


class Path(Collection):
    isClosed = False

    def __init__(self, curves, owner):
        super().__init__([types.SimpleNamespace(entity=e) for e in curves])
        self.owner = owner

    @staticmethod
    def create(curves, chain):
        curves = curves.values if isinstance(curves, Collection) else [curves]
        if any(e.assemblyContext is None and namespace['_cad_owner'](e).name != 'Root' for e in curves):
            raise RuntimeError('InternalValidationError : Utils::getObjectPath(sketchCurve, objPath, nullptr, contextPath)')
        TRACE.append(('transientPath', 'static', curves, chain))
        result = Path(curves, namespace['_cad_owner'](curves[0]))
        if chain != 'noChainedCurves':
            result.addCurves(curves[0], chain)
        return result

    def addCurves(self, curve, chain):
        TRACE.append(('transientPath', 'add', curve, chain))
        assert namespace['_cad_owner'](curve) is self.owner
        for entity in [curve] + getattr(curve, chain, []):
            if not any(item.entity == entity for item in self.values):
                self.values.append(types.SimpleNamespace(entity=entity))
        return True


class Features(types.SimpleNamespace):
    def __init__(self, owner):
        super().__init__(**{mode + 'Features': FeatureFactory(mode)
                          for mode in (*FeatureFactory.counts, 'chamfer', 'hole')})
        self.owner = owner

    def createPath(self, curves, isChain=True):
        assert type(isChain) is bool
        explicit = isinstance(curves, Collection)
        curves = curves.values if explicit else [curves]
        assert curves
        assert all(e.assemblyContext is None and namespace['_cad_owner'](e) is self.owner for e in curves)
        TRACE.append(('transientPath', 'scoped', self.owner, curves, isChain, explicit))
        result = Path(curves, self.owner)
        if isChain and not explicit:
            result.addCurves(curves[0], 'connectedChainedCurves')
        if getattr(self, 'returnedOccurrence', None) is not None:
            # Fusion can contextualize PathEntity.entity even for native inputs.
            import copy
            for item in result.values:
                native = item.entity
                item.entity = copy.copy(native)
                item.entity.nativeObject = native
                item.entity.assemblyContext = self.returnedOccurrence
                item.entity.entityToken = 'proxy-' + native.entityToken
        return result


adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
adsk.core.Point3D = Point
adsk.core.Plane = types.SimpleNamespace(cast=Plane.cast)
adsk.core.NurbsCurve3D = NurbsCurve3D
class ValueInput(tuple):
    @staticmethod
    def createByReal(n):
        return ValueInput(('number', n))

    @staticmethod
    def createByString(s):
        assert isinstance(s, str)
        return ValueInput(('expression', s))


class DistanceExtentDefinition:
    @classmethod
    def create(cls, value):
        assert isinstance(value, ValueInput)
        result = cls()
        result.value = value
        return result


class OffsetStartDefinition(DistanceExtentDefinition):
    pass


class ThroughAllExtentDefinition:
    @staticmethod
    def create():
        return ThroughAllExtentDefinition()


class ToEntityExtentDefinition:
    @staticmethod
    def create(entity, isChained, offset=None):
        assert entity.objectType.split('::')[-1] in ('ConstructionPlane', 'BRepFace')
        assert type(isChained) is bool
        assert offset is None or isinstance(offset, ValueInput)
        result = ToEntityExtentDefinition()
        result.entity, result.isChained, result.offset = entity, isChained, offset
        return result


adsk.core.ValueInput = ValueInput
adsk.fusion.SketchCurve = types.SimpleNamespace(cast=lambda e: e if isinstance(e, (SketchLine, SketchCircle, SketchArc)) or getattr(e, 'objectType', '').endswith('SketchFittedSpline') else None)
adsk.fusion.BRepEdge = types.SimpleNamespace(cast=lambda e: e if e.objectType.endswith('::BRepEdge') else None)
for cls in (SketchLine, SketchCircle, SketchArc, SketchPoint, Path):
    setattr(adsk.fusion, cls.__name__, cls)
for name, values in {
    'FeatureOperations': ('NewBodyFeatureOperation', 'JoinFeatureOperation', 'CutFeatureOperation', 'IntersectFeatureOperation'),
    'PatternDistanceType': ('SpacingPatternDistanceType', 'ExtentPatternDistanceType'),
    'ChainedCurveOptions': ('noChainedCurves', 'connectedChainedCurves', 'tangentChainedCurves'),
    'DimensionOrientations': ('AlignedDimensionOrientation', 'HorizontalDimensionOrientation', 'VerticalDimensionOrientation'),
    'ExtentDirections': ('PositiveExtentDirection', 'NegativeExtentDirection'),
    'SweepOrientationTypes': ('ParallelOrientationType', 'PerpendicularOrientationType'),
}.items():
    setattr(adsk.fusion, name, types.SimpleNamespace(**{v: v for v in values}))
for cls in (DistanceExtentDefinition, ThroughAllExtentDefinition, ToEntityExtentDefinition, OffsetStartDefinition):
    setattr(adsk.fusion, cls.__name__, cls)
for kind in ('BRepBody', 'BRepFace', 'BRepVertex', 'ConstructionPlane', 'ConstructionPoint'):
    setattr(adsk.fusion, kind, types.SimpleNamespace(cast=lambda e, k=kind: e if e.objectType.endswith('::' + k) else None))
adsk.fusion.Profile = types.SimpleNamespace(cast=lambda e: e if e.objectType.endswith('::Profile') else None)
adsk.fusion.SketchText = types.SimpleNamespace(cast=lambda e: e if e.objectType.endswith('::SketchText') else None)
adsk.fusion.FeatureHealthStates = types.SimpleNamespace(
    HealthyFeatureHealthState=0, WarningFeatureHealthState=1, ErrorFeatureHealthState=2)


def thread_info(tapered, internal, thread_type, designation, thread_class, right_handed):
    assert tapered is False
    TRACE.append(('threadInfo', internal, thread_type, designation, thread_class, right_handed))
    return object()


adsk.fusion.ThreadInfo = types.SimpleNamespace(create=thread_info)
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
namespace = {'CAD_HANDLERS': {}}
exec(compile((ROOT / 'runtime/python/fmcad/domain/values.py').read_text(), 'values.py', 'exec'), namespace)
exec(compile((ROOT / 'assets/cad/core.py').read_text(), 'core.py', 'exec'), namespace)
exec(compile((ROOT / 'assets/cad/model.py').read_text(), 'model.py', 'exec'), namespace)
HANDLERS = namespace['CAD_HANDLERS']
CATALOG = json.loads((ROOT / 'src/catalog/model.json').read_text())


class Context:
    _proxy = namespace['CadContext']._proxy

    def __init__(self):
        self.created = []
        self.component = Entity('Component', name='Selected')
        self.root = Entity('Component', name='Root')
        self.occurrence = None
        self._profile_selections = []
        self.sketch = Sketch(self.component)
        self.component.features = Features(self.component)
        self.root.features = Features(self.root)
        self.component.sketches = types.SimpleNamespace(addWithoutEdges=self.add_sketch)
        self.entities = {name: self.sketch for name in ('Section', 'Bottom', 'Top')}
        self.entities['line-token'] = SketchLine(Point(0, 0, 0), Point(1, 0, 0), self.sketch)
        self.entities['axis-line-token'] = SketchLine(Point(0, 0, 0), Point(0, 1, 0), self.sketch)
        self.entities['circle-token'] = SketchCircle(Point(1, 0, 0), 0.5, self.sketch)
        self.entities['point-token'] = SketchPoint(Point(0, 0, 0), self.sketch)
        self.entities['curve-token'] = self.entities['line-token']
        for name in ('Base', 'Surface', 'Cutter'):
            self.entities[name] = Entity('BRepBody', name=name)
        for name in ('XY', 'XZ', 'YZ'):
            self.entities[name] = Entity('ConstructionPlane', name=name)
        for name in ('X', 'Y', 'Z'):
            self.entities[name] = Entity('ConstructionAxis', name=name)
        for name in ('edge-token', 'path-token', 'path-curve-token'):
            self.entities[name] = Entity('BRepEdge')
            self.entities[name].body = types.SimpleNamespace(parentComponent=self.component)
        self.entities['path-curve-token'] = self.entities['line-token']
        for name in ('side-face-token', 'top-face-token', 'cylinder-face-token'):
            self.entities[name] = Entity('BRepFace')

    def _scope(self, data):
        return self.component, None

    def resolve(self, ref, kind=None):
        if isinstance(ref, dict) and ref.get('kind') == 'profile':
            return namespace['CadContext'].resolve(self, ref, kind)
        return self.entities[ref if isinstance(ref, str) else ref.get('token', ref.get('name'))]

    def ref(self, entity):
        self.entities[entity.entityToken] = entity
        return {'token': entity.entityToken, 'kind': entity.objectType.split('::')[-1], 'name': entity.name}

    def describe(self, entity):
        return self.ref(entity)

    def value(self, expression):
        if not isinstance(expression, str) or not expression:
            raise ValueError('Expression string required')
        return ValueInput.createByString(expression)

    def length(self, expression):
        self.value(expression)
        number, unit = expression.split()
        if unit not in ('mm', 'cm', 'in'):
            raise ValueError('Incompatible length units')
        return float(number) * {'mm': 0.1, 'cm': 1, 'in': 2.54}[unit]

    def angle(self, expression):
        self.value(expression)
        number, unit = expression.split()
        if unit not in ('deg', 'rad'):
            raise ValueError('Incompatible angle units')
        return float(number) * {'deg': math.pi / 180, 'rad': 1}[unit]

    def point(self, values):
        return Point(*(self.length(v) for v in values))

    def collection(self, entities):
        return Collection(entities)

    def require_confirm(self, data):
        if data.get('confirm') is not True:
            raise ValueError('confirm required')

    def add_sketch(self, plane, *args):
        TRACE.append(('sketchCreate', plane))
        return Sketch(self.component)


class ModelTests(unittest.TestCase):
    def setUp(self):
        TRACE.clear()
        self.ctx = Context()

    def call(self, operation, data):
        result = HANDLERS[operation](self.ctx, data)
        json.dumps(result)
        return result

    def test_every_catalog_example_dispatches(self):
        for operation, entry in CATALOG.items():
            with self.subTest(operation=operation):
                self.setUp()
                result = self.call(operation, entry['example'])
                self.assertTrue(result)
                if entry['readOnly']:
                    self.assertFalse(self.ctx.created)
                    self.assertTrue(all(t[0] == 'transientPath' for t in TRACE))
                elif operation != 'sketch.edit':
                    self.assertTrue(self.ctx.created)
        model_keys = {key for key in HANDLERS if key.startswith(('model.', 'sketch.', 'path.', 'pattern.'))}
        self.assertEqual(model_keys, set(CATALOG))

    def test_profile_selection_uses_real_core_and_rejects_ambiguity(self):
        data = {'profile': {'kind': 'profile', 'sketch': 'Section'}, 'distance': '2 mm'}
        self.call('model.extrude', data)
        self.assertIs(self.ctx.component.features.extrudeFeatures.last_profile_input,
                      self.ctx.sketch.profiles.item(0))
        self.ctx.sketch.profiles.values.append(Entity('Profile', self.ctx.sketch))
        TRACE.clear()
        with self.assertRaisesRegex(ValueError, 'explicit index'):
            self.call('model.extrude', data)
        self.assertFalse(TRACE)
        for index in (True, '0', 0.0, -1, 2):
            data['profile']['index'] = index
            with self.assertRaisesRegex(ValueError, 'integer'):
                self.call('model.extrude', data)
        data['profile']['index'] = 1
        self.call('model.extrude', data)
        self.assertIs(next(t[2][0] for t in TRACE if t[:2] == ('input', 'extrude')), self.ctx.sketch.profiles.item(1))

    def _add_profile(self, name, plane=None):
        profile = Entity('Profile', self.ctx.sketch, name=name)
        profile.plane = plane or self.ctx.sketch.referencePlane.geometry
        profile.profileLoops = Collection([object()])
        self.ctx.sketch.profiles.values.append(profile)
        self.ctx.entities[name] = profile
        return profile

    def _two_profile_refs(self):
        return [{'kind': 'profile', 'sketch': 'Section', 'index': 0},
                {'kind': 'profile', 'sketch': 'Section', 'index': 1}]

    def test_multi_profile_extrude_uses_native_collection_and_unmapped_body_refs(self):
        first = self.ctx.sketch.profiles.item(0)
        second = self._add_profile('SecondDisjointProfile')
        body_a = Entity('BRepBody', name='ExtrudeBodyA')
        body_b = Entity('BRepBody', name='ExtrudeBodyB')
        for body in (body_a, body_b):
            body.parentComponent = self.ctx.component
        feature_factory = self.ctx.component.features.extrudeFeatures
        feature_factory.result_bodies = [body_b, body_a]
        result = self.call('model.extrude', {
            'profiles': self._two_profile_refs(), 'distance': '5 mm',
            'operation': 'newBody', 'name': 'DisjointNewBodies'})
        self.assertIsInstance(feature_factory.last_profile_input, Collection)
        self.assertEqual(feature_factory.last_profile_input.values, [first, second])
        self.assertEqual(result['profileCount'], 2)
        self.assertEqual(result['bodyCount'], 2)
        self.assertEqual({ref['token'] for ref in result['bodies']}, {body_a.entityToken, body_b.entityToken})
        self.assertEqual([ref['token'] for ref in result['profileRefs']],
                         [first.entityToken, second.entityToken])
        self.assertEqual(result['profileBodyMapping']['status'], 'unavailable')
        self.assertEqual(result['profileBodyMapping']['reason'],
                         'Fusion does not expose a stable result-body to input-profile mapping; use the returned body refs as identities.')
        self.assertEqual(next(row[2] for row in TRACE if row[:2] == ('input', 'extrude'))[1],
                         adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
        self.assertEqual(next(row[1].value for row in TRACE if row[0] == 'oneSideExtent'),
                         ('expression', '5 mm'))

    def test_multi_profile_extrude_accepts_planar_face_and_sketch_text(self):
        body = self.ctx.entities['Base']
        body.parentComponent = self.ctx.component
        face = Entity('BRepFace', name='PlanarFace')
        face.body, face.geometry = body, Plane()
        text = Entity('SketchText', self.ctx.sketch, name='SketchTextProfile')
        self.ctx.entities.update({'PlanarFace': face, 'SketchTextProfile': text})
        result = self.call('model.extrude', {'profiles': ['PlanarFace', 'SketchTextProfile'],
            'distance': '4 mm', 'operation': 'newBody'})
        self.assertEqual(self.ctx.component.features.extrudeFeatures.last_profile_input.values,
                         [face, text])
        self.assertEqual([ref['kind'] for ref in result['profileRefs']], ['BRepFace', 'SketchText'])
        self.assertEqual(result['profileCount'], 2)

    def test_multi_profile_cut_preserves_explicit_participant_semantics(self):
        self._add_profile('SecondCutProfile')
        base = self.ctx.entities['Base']
        base.parentComponent = self.ctx.component
        feature_factory = self.ctx.component.features.extrudeFeatures
        feature_factory.result_bodies = [base]
        result = self.call('model.extrude', {
            'profiles': self._two_profile_refs(), 'distance': '5 mm', 'operation': 'cut',
            'participants': ['Base']})
        input_args = next(row[2] for row in TRACE if row[:2] == ('input', 'extrude'))
        self.assertIsInstance(input_args[0], Collection)
        self.assertEqual(input_args[0].values, [self.ctx.sketch.profiles.item(0), self.ctx.sketch.profiles.item(1)])
        self.assertEqual(input_args[1], adsk.fusion.FeatureOperations.CutFeatureOperation)
        self.assertEqual(next(row[2] for row in TRACE if row[:2] == ('set', 'participantBodies')), [base])
        self.assertEqual(result['bodyCount'], 1)
        self.assertEqual(result['bodies'][0]['token'], base.entityToken)

    def test_multi_profile_preflight_transforms_sketch_planes_to_model_space(self):
        second = self._add_profile('SecondTransformedProfile')
        owner_transform = RigidTransform(
            ((0, 0, 1), (0, 1, 0), (-1, 0, 0)), (12, 4, -3))
        self.ctx.sketch.transform = owner_transform
        second_sketch = Sketch(self.ctx.component)
        second_sketch.transform = owner_transform
        second.parentSketch = second_sketch
        self.ctx.entities['SecondTransformedProfile'] = second

        # The profiles live in separate sketches, but a shared rotated/translated
        # owner transform keeps their actual model-space planes coplanar.
        result = self.call('model.extrude', {
            'profiles': self._two_profile_refs(), 'distance': '5 mm', 'operation': 'newBody'})
        self.assertEqual(result['profileCount'], 2)

        TRACE.clear()
        second_sketch.transform = owner_transform.compose(RigidTransform(
            ((1, 0, 0), (0, 0, -1), (0, 1, 0))))
        with self.assertRaisesRegex(ValueError, 'must be co-planar'):
            self.call('model.extrude', {
                'profiles': self._two_profile_refs(), 'distance': '5 mm', 'operation': 'newBody'})
        self.assertFalse(any(row[0] in ('input', 'feature') for row in TRACE))

        # Parallel profiles offset along the transformed normal are not coplanar.
        second_sketch.transform = owner_transform
        second.plane = Plane('offset-local', Point(0, 0, 1), Point(0, 0, 1))
        TRACE.clear()
        with self.assertRaisesRegex(ValueError, 'must be co-planar'):
            self.call('model.extrude', {
                'profiles': self._two_profile_refs(), 'distance': '5 mm', 'operation': 'newBody'})
        self.assertFalse(any(row[0] in ('input', 'feature') for row in TRACE))

    def test_multi_profile_warning_health_is_not_reported_as_success(self):
        self._add_profile('SecondWarningProfile')
        self.ctx.component.features.extrudeFeatures.warning = True
        with self.assertRaisesRegex(RuntimeError, 'non-healthy multi-profile feature.*inspect partial changes'):
            self.call('model.extrude', {
                'profiles': self._two_profile_refs(), 'distance': '5 mm', 'operation': 'newBody'})
        self.assertTrue(any(row[0] == 'feature' for row in TRACE))

    def test_multi_profile_extrude_rejects_conflicts_owners_context_and_planes_before_input(self):
        second = self._add_profile('SecondProfile')
        base = {'profiles': self._two_profile_refs(), 'distance': '5 mm'}
        invalid = (
            ({'distance': '5 mm'}, 'exactly one'),
            (dict(base, profile={'kind': 'profile', 'sketch': 'Section', 'index': 0}), 'exactly one'),
            ({'profile': [self._two_profile_refs()[0]], 'distance': '5 mm'}, 'profile accepts one reference'),
            ({**base, 'profiles': []}, 'nonempty array'),
            ({**base, 'profiles': [self._two_profile_refs()[0], self._two_profile_refs()[0]]}, 'distinct profile references'),
            ({**base, 'profiles': ['line-token', 'SecondProfile']}, 'Profile, planar BRepFace, or SketchText'),
        )
        for data, message in invalid:
            TRACE.clear()
            with self.subTest(message=message):
                with self.assertRaisesRegex(ValueError, message):
                    self.call('model.extrude', data)
                self.assertFalse(any(row[0] in ('input', 'feature') for row in TRACE))

        second.plane = Plane('offset-XY', Point(0, 0, 1), Point(0, 0, 1))
        TRACE.clear()
        with self.assertRaisesRegex(ValueError, 'must be co-planar'):
            self.call('model.extrude', base)
        self.assertFalse(any(row[0] in ('input', 'feature') for row in TRACE))

        second.plane = self.ctx.sketch.referencePlane.geometry
        foreign_body = Entity('BRepBody', name='ForeignParticipant')
        foreign_body.parentComponent = self.ctx.root
        self.ctx.entities['ForeignParticipant'] = foreign_body
        TRACE.clear()
        with self.assertRaisesRegex(ValueError, 'selected component'):
            self.call('model.extrude', {**base, 'operation': 'cut', 'participants': ['ForeignParticipant']})
        self.assertFalse(any(row[0] in ('input', 'feature') for row in TRACE))

        other_sketch = Sketch(self.ctx.root)
        second.parentSketch = other_sketch
        TRACE.clear()
        with self.assertRaisesRegex(ValueError, 'owned by the selected component'):
            self.call('model.extrude', base)
        self.assertFalse(any(row[0] in ('input', 'feature') for row in TRACE))

        second.parentSketch = self.ctx.sketch
        second.assemblyContext = types.SimpleNamespace(component=self.ctx.component)
        TRACE.clear()
        with self.assertRaisesRegex(ValueError, 'native geometry owned by the selected component'):
            self.call('model.extrude', base)
        self.assertFalse(any(row[0] in ('input', 'feature') for row in TRACE))

    def test_unknown_fields_and_boolean_strings_rejected_before_mutation(self):
        for data in ({'profile': 'Base', 'distance': '1 mm', 'throughAll': True},
                     {'profile': 'Base', 'distance': '1 mm', 'symmetric': 'false'},
                     {'profile': 'Base', 'distance': '1 mm', 'name': ''}):
            with self.assertRaises(ValueError):
                self.call('model.extrude', data)
        self.assertFalse(TRACE)

    def test_feature_failure_is_not_reported_as_success(self):
        self.ctx.component.features.extrudeFeatures.fail = True
        with self.assertRaisesRegex(RuntimeError, 'extrude'):
            self.call('model.extrude', CATALOG['model.extrude']['example'])
        self.assertFalse(self.ctx.created)
        self.ctx.component.features.extrudeFeatures.fail = False
        self.ctx.component.features.extrudeFeatures.unhealthy = True
        with self.assertRaisesRegex(RuntimeError, 'Kernel rejected shape; inspect partial changes'):
            self.call('model.extrude', CATALOG['model.extrude']['example'])

    def test_native_selected_component_enforced(self):
        self.ctx.entities['Base'].parentComponent = self.ctx.root
        with self.assertRaisesRegex(ValueError, 'selected component'):
            self.call('model.mirror', {'entities': ['Base'], 'plane': 'XY'})
        self.assertFalse(TRACE)
        self.ctx.entities['Base'].parentComponent = self.ctx.component
        self.ctx.entities['Base'].assemblyContext = object()
        with self.assertRaisesRegex(ValueError, 'cross-occurrence'):
            self.call('model.mirror', {'entities': ['Base'], 'plane': 'XY'})
        self.assertFalse(TRACE)
        self.assertFalse(self.ctx.created)

    def test_construction_datum_feature_ownership_before_sdk_input_or_add(self):
        profile = {'kind': 'profile', 'sketch': 'Section', 'index': 0}
        cases = [
            ('model.extrude', 'ConstructionPlane', {'profile': profile, 'extent': 'toEntity', 'target': 'datum'}),
            ('model.revolve', 'ConstructionAxis', {'profile': profile, 'axis': 'datum', 'angle': '90 deg'}),
            ('model.hole', 'ConstructionPlane', {'points': ['point-token'], 'diameter': '2 mm', 'extent': 'toEntity', 'target': 'datum'}),
            ('model.hole', 'ConstructionPoint', {'points': ['point-token'], 'diameter': '2 mm', 'extent': 'toEntity', 'target': 'datum'}),
            ('model.split', 'ConstructionPlane', {'bodies': ['Base'], 'tool': 'datum'}),
            ('model.draft', 'ConstructionPlane', {'faces': ['top-face-token'], 'plane': 'datum', 'angle': '3 deg'}),
            ('model.mirror', 'ConstructionPlane', {'entities': ['Base'], 'plane': 'datum'}),
            ('pattern.circular', 'ConstructionAxis', {'entities': ['Base'], 'axis': 'datum', 'quantity': 2}),
            ('pattern.rectangular', 'ConstructionAxis', {'entities': ['Base'], 'direction': 'datum', 'quantity': 2, 'distance': '5 mm'}),
            ('pattern.rectangular', 'ConstructionAxis', {'entities': ['Base'], 'direction': 'X', 'quantity': 2, 'distance': '5 mm',
                                                        'directionTwo': 'datum', 'quantityTwo': 2, 'distanceTwo': '5 mm'}),
        ]
        for kind in ('ConstructionPlane', 'ConstructionAxis', 'ConstructionPoint'):
            cases.extend([
                ('model.mirror', kind, {'entities': ['datum'], 'plane': 'XY'}),
                ('pattern.circular', kind, {'entities': ['datum'], 'axis': 'Z', 'quantity': 2}),
                ('pattern.rectangular', kind, {'entities': ['datum'], 'direction': 'X', 'quantity': 2, 'distance': '5 mm'}),
                ('pattern.path', kind, {'entities': ['datum'], 'path': {'curves': ['line-token']}, 'quantity': 2, 'distance': '5 mm'}),
            ])
        for operation, kind, data in cases:
            for scope in ('foreign', 'same', 'proxy'):
                with self.subTest(operation=operation, kind=kind, data=data, scope=scope):
                    self.setUp()
                    datum = Entity(kind)
                    datum.component = self.ctx.root if scope == 'foreign' else self.ctx.component
                    if scope == 'proxy':
                        datum.nativeObject = Entity(kind)
                        datum.nativeObject.component = self.ctx.component
                        datum.assemblyContext = types.SimpleNamespace(component=self.ctx.component)
                    self.ctx.entities['datum'] = datum
                    if scope == 'same':
                        result = self.call(operation, data)
                        self.assertEqual(self.ctx.created, [result['feature']])
                        self.assertEqual(sum(t[0] in ('input', 'simpleHole') for t in TRACE), 1)
                        self.assertEqual(sum(t[0] == 'feature' for t in TRACE), 1)
                    else:
                        with self.assertRaisesRegex(ValueError, 'native input geometry.*cross-occurrence'):
                            self.call(operation, data)
                        self.assertFalse(TRACE)
                        self.assertFalse(self.ctx.created)

    def test_body_sketch_and_topology_feature_owner_regression(self):
        cases = [
            ('model.mirror', 'Base', {'entities': ['Base'], 'plane': 'XY'}),
            ('model.extrude', 'Section', {'profile': {'kind': 'profile', 'sketch': 'Section'}, 'distance': '2 mm'}),
            ('model.fillet', 'edge-token', {'edges': ['edge-token'], 'radius': '1 mm'}),
        ]
        for operation, ref, data in cases:
            for scope in ('foreign', 'same', 'proxy'):
                with self.subTest(operation=operation, scope=scope):
                    self.setUp()
                    entity = self.ctx.entities[ref]
                    owner = self.ctx.root if scope == 'foreign' else self.ctx.component
                    if ref == 'edge-token':
                        entity.body.parentComponent = owner
                    else:
                        entity.parentComponent = owner
                    if scope == 'proxy':
                        subject = entity.profiles.item(0) if ref == 'Section' else entity
                        subject.assemblyContext = types.SimpleNamespace(component=owner)
                    if scope == 'same':
                        result = self.call(operation, data)
                        self.assertEqual(self.ctx.created, [result['feature']])
                        self.assertEqual(sum(t[0] == 'feature' for t in TRACE), 1)
                    else:
                        with self.assertRaisesRegex(ValueError, 'native input geometry'):
                            self.call(operation, data)
                        self.assertFalse(TRACE)
                        self.assertFalse(self.ctx.created)

    def test_sketch_geometry_units_and_named_results(self):
        point = ['0 mm', '0 mm', '0 mm']
        end = ['10 mm', '20 mm', '0 mm']
        specs = [
            {'type': 'point', 'point': point, 'name': 'origin'},
            {'type': 'line', 'start': point, 'end': end, 'name': 'line'},
            {'type': 'circle', 'center': point, 'radius': '2 cm', 'name': 'circle'},
            {'type': 'arc', 'center': point, 'start': end, 'sweep': '90 deg', 'name': 'arc'},
            {'type': 'arc3', 'start': point, 'through': ['4 mm', '0 mm', '0 mm'], 'end': end},
            {'type': 'rectangle', 'start': point, 'end': end, 'name': 'box'},
            {'type': 'spline', 'points': [point, end], 'name': 'spline'},
        ]
        result = self.call('sketch.geometry', {'sketch': 'Section', 'geometry': specs})
        self.assertEqual(len(result['entities']), 10)
        self.assertEqual(len(result['refs']['box']), 4)
        circle = self.ctx.resolve(result['refs']['circle'])
        self.assertEqual(circle.radius, 2.0)
        line = self.ctx.resolve(result['refs']['line'])
        self.assertEqual((line.endSketchPoint.geometry.x, line.endSketchPoint.geometry.y), (1.0, 2.0))
        self.assertIn(('sweepRadians', math.pi / 2), TRACE)

    def test_geometry_rejects_unsupported_mode_and_duplicate_labels_before_add(self):
        good = {'type': 'point', 'point': ['0 mm'] * 3, 'name': 'p'}
        for specs in ([good, {'type': 'slot'}], [good, good]):
            with self.assertRaises(ValueError):
                self.call('sketch.geometry', {'sketch': 'Section', 'geometry': specs})
        self.assertFalse(TRACE)

    def test_bezier_exact_native_cubic_units_flags_and_refs(self):
        points = [['0 mm', '1 cm', '0 mm'], ['10 mm', '2 cm', '0 mm'],
                  ['1 in', '-10 mm', '0 mm'], ['30 mm', '0 mm', '5 mm']]
        for flags in ({}, {'fixed': True, 'construction': True}, {'construction': False}):
            with self.subTest(flags=flags):
                self.setUp()
                self.ctx.point = types.MethodType(namespace['CadContext'].point, self.ctx)
                result = self.call('sketch.geometry', {'sketch': 'Section', 'geometry': [
                    dict(type='bezier', controlPoints=points, name='art', **flags)]})
                ref = result['refs']['art']
                self.assertEqual(result['entities'], [ref])
                self.assertEqual(self.ctx.created, [ref])
                self.assertEqual(ref['kind'], 'SketchFixedSpline')
                curve = self.ctx.resolve(ref)
                self.assertTrue(curve.isFixed)
                self.assertEqual(curve.isConstruction, flags.get('construction', False))
                self.assertIs(curve.parentSketch, self.ctx.sketch)
                nurbs = curve.geometry
                self.assertIs(TRACE[0][1], nurbs)
                self.assertEqual([t[0] for t in TRACE], ['nurbs', 'bezier'])
                self.assertEqual(nurbs.degree, 3)
                self.assertEqual(nurbs.knots, [0, 0, 0, 0, 1, 1, 1, 1])
                self.assertIs(nurbs.isPeriodic, False)
                self.assertEqual([(p.x, p.y, p.z) for p in nurbs.controlPoints],
                                 [(0, 1, 0), (1, 2, 0), (2.54, -1, 0), (3, 0, 0.5)])

    def test_bezier_invalid_count_and_fixed_reject_entire_list_before_add(self):
        point = ['0 mm'] * 3
        good = {'type': 'line', 'start': point, 'end': ['10 mm'] * 3}
        invalid = [{'controlPoints': value} for value in (None, 'abcd', {}, [], [point] * 3, [point] * 5)]
        invalid.append({'controlPoints': [point] * 4, 'fixed': False})
        for fields in invalid:
            with self.subTest(fields=fields):
                self.setUp()
                with self.assertRaisesRegex(ValueError, 'exactly four|fixed:false'):
                    self.call('sketch.geometry', {'sketch': 'Section', 'geometry': [
                        good, dict(type='bezier', **fields)]})
                self.assertFalse(TRACE)
                self.assertFalse(self.ctx.created)
                self.assertEqual(self.ctx.sketch.sketchCurves.count, 0)
                self.assertEqual(self.ctx.sketch.sketchPoints.count, 0)

    def test_endpoint_dimensions_and_driven_dimensions(self):
        line = {'token': 'line-token'}
        result = self.call('sketch.dimension', {'sketch': 'Section', 'type': 'distance',
            'entities': [{'entity': line, 'point': 'start'}, {'entity': line, 'point': 'end'}],
            'text': ['0 mm'] * 3, 'expression': '20 mm'})
        self.assertEqual(result['expression'], '20 mm')
        for mode, entities in [('angle', [line, line]), ('radius', [{'token': 'circle-token'}]), ('diameter', [{'token': 'circle-token'}])]:
            self.call('sketch.dimension', {'sketch': 'Section', 'type': mode, 'entities': entities,
                'text': ['0 mm'] * 3, 'driving': False})
        with self.assertRaisesRegex(ValueError, 'cannot accept'):
            self.call('sketch.dimension', {'sketch': 'Section', 'type': 'radius',
                'entities': [{'token': 'circle-token'}], 'text': ['0 mm'] * 3, 'driving': False, 'expression': '2 mm'})

    def test_sketch_constraints_are_closed_dispatch(self):
        for mode in ('coincident', 'collinear', 'concentric', 'midpoint', 'parallel', 'perpendicular',
                     'horizontal', 'vertical', 'horizontalPoints', 'verticalPoints', 'tangent', 'smooth', 'equal', 'symmetry'):
            count = 1 if mode in ('horizontal', 'vertical') else 3 if mode == 'symmetry' else 2
            self.call('sketch.constrain', {'sketch': 'Section', 'type': mode, 'entities': [{'token': 'line-token'}] * count})
        with self.assertRaises(ValueError):
            self.call('sketch.constrain', {'sketch': 'Section', 'type': '__dict__', 'entities': []})

    def test_delete_requires_confirmation_and_preserves_solver_failure(self):
        data = {'sketch': 'Section', 'entities': [{'token': 'line-token'}], 'delete': True}
        with self.assertRaises(ValueError):
            self.call('sketch.edit', data)
        self.assertFalse(TRACE)
        self.call('sketch.edit', dict(data, confirm=True))
        self.assertEqual(TRACE[0][0], 'delete')
        self.ctx.entities['line-token'].deleteMe = lambda: False
        with self.assertRaises(RuntimeError):
            self.call('sketch.edit', dict(data, confirm=True))

    def test_sketch_mirror_reflects_circle_and_preserves_construction(self):
        source = self.ctx.entities['circle-token']
        source.isConstruction = True
        result = self.call('sketch.mirror', CATALOG['sketch.mirror']['example'])
        circle = self.ctx.resolve(result['entities'][0])
        self.assertEqual(circle.centerSketchPoint.geometry.x, -1)
        self.assertEqual(circle.radius, source.radius)
        self.assertTrue(circle.isConstruction)
        self.assertEqual(len(result['constraints']), 1)

    def test_sketch_mirror_all_supported_primitives_and_3d_rejection(self):
        self.ctx.entities['arc'] = SketchArc(Point(1, 0, 0), Point(2, 0, 0), Point(1, 1, 0), self.ctx.sketch)
        self.call('sketch.mirror', {'sketch': 'Section', 'entities': ['line-token', 'point-token', 'arc'], 'line': 'axis-line-token'})
        self.ctx.entities['point-token'].geometry.z = 1
        TRACE.clear()
        with self.assertRaisesRegex(ValueError, 'planar'):
            self.call('sketch.mirror', {'sketch': 'Section', 'entities': ['circle-token', 'point-token'], 'line': 'axis-line-token'})
        self.assertFalse(TRACE)

    def test_sketch_patterns_both_modes_and_offset_refs(self):
        self.call('sketch.pattern', {'sketch': 'Section', 'type': 'circular', 'entities': ['circle-token'], 'center': 'point-token', 'quantity': 4})
        self.call('sketch.pattern', {'sketch': 'Section', 'type': 'rectangular', 'entities': ['circle-token'],
            'quantity': 4, 'distance': '2 mm', 'quantityTwo': 3, 'distanceTwo': '3 mm'})
        self.assertTrue(any(t[0] == 'sketchDirectionTwo' for t in TRACE))
        result = self.call('sketch.offset', CATALOG['sketch.offset']['example'])
        self.assertEqual(len(result['entities']), 1)
        self.assertIn('constraint', result)

    def test_path_descriptor_roundtrip_does_not_mutate(self):
        result = self.call('path.create', CATALOG['path.create']['example'])
        self.call('path.inspect', result['path'])
        self.assertFalse(self.ctx.created)
        self.assertTrue(all(t[0] == 'transientPath' for t in TRACE))
        with self.assertRaisesRegex(ValueError, 'one seed'):
            self.call('path.create', {'curves': ['line-token', 'circle-token'], 'chain': 'connected'})
        with self.assertRaisesRegex(ValueError, 'sketch curves only'):
            self.call('path.create', {'curves': ['edge-token'], 'chain': 'connected'})

    def test_native_child_path_reproduces_static_failure_and_scopes_consumers(self):
        line = self.ctx.entities['line-token']
        with self.assertRaisesRegex(RuntimeError, 'Utils::getObjectPath'):
            Path.create(line, 'noChainedCurves')
        for component in (self.ctx.component, self.ctx.root):
            self.ctx.component = component
            self.ctx.sketch.parentComponent = component
            TRACE.clear()
            route = self.call('path.create', {'curves': ['line-token']})['path']
            self.call('path.inspect', route)
            self.assertFalse(self.ctx.created)
            self.assertTrue(all(t[0] == 'transientPath' for t in TRACE))
            self.call('model.sweep', {'profile': {'kind': 'profile', 'sketch': 'Section'}, 'path': route})
            self.call('pattern.path', {'entities': ['Base'], 'path': route, 'quantity': 3, 'distance': '10 mm'})
            for t in TRACE:
                if t[:2] in (('input', 'sweep'), ('input', 'pathPattern')):
                    self.assertIs(t[2][1].owner, component)
                    self.assertIs(t[2][1].item(0).entity, line)
            self.assertFalse(any(t[:2] == ('transientPath', 'static') for t in TRACE))
            self.ctx.created.clear()

    def test_path_chaining_and_explicit_object_collection(self):
        seed = self.ctx.entities['line-token']
        tangent = SketchLine(Point(1, 0, 0), Point(2, 0, 0), self.ctx.sketch)
        corner = SketchLine(Point(2, 0, 0), Point(2, 1, 0), self.ctx.sketch)
        seed.tangentChainedCurves = [tangent]
        seed.connectedChainedCurves = [tangent, corner]
        for chain, expected in [('none', 1), ('tangent', 2), ('connected', 3)]:
            made = self.call('path.create', {'curves': ['line-token'], 'chain': chain})
            self.assertEqual(made['count'], expected)
            self.assertEqual(self.call('path.inspect', made['path'])['count'], expected)
        made = self.call('path.create', {'curves': ['line-token', self.ctx.ref(tangent)]})
        self.assertEqual(made['count'], 2)
        self.assertEqual(TRACE[-1][-2:], (False, True))
        edge = self.ctx.entities['edge-token']
        edge.tangentChainedCurves = [self.ctx.entities['path-token']]
        self.assertEqual(self.call('path.create', {'curves': ['edge-token'], 'chain': 'tangent'})['count'], 2)

    def test_native_descriptor_normalizes_sdk_proxy_entries_and_roundtrips_to_features(self):
        owner = self.ctx.component
        line = self.ctx.entities['line-token']
        second = SketchLine(Point(1, 0, 0), Point(2, 0, 0), self.ctx.sketch)
        line.connectedChainedCurves = [second]
        occurrence = Entity('Occurrence', name='Parent:2+Child:3')
        occurrence.component = owner
        occurrence.fullPathName = occurrence.name
        owner.features.returnedOccurrence = occurrence
        profile = self.ctx.sketch.profiles.item(0)
        body = self.ctx.entities['Base']
        body.parentComponent = owner
        tokens = {e.entityToken: e for e in [owner, self.ctx.sketch, line, second, profile, body, occurrence]}
        self.ctx.design = types.SimpleNamespace(findEntityByToken=lambda token: [tokens[token]])
        self.ctx.ref = types.MethodType(namespace['CadContext'].ref, self.ctx)
        self.ctx.resolve = types.MethodType(namespace['CadContext'].resolve, self.ctx)
        self.ctx._scope = types.MethodType(namespace['CadContext']._scope, self.ctx)
        # Definition-scoped refs must stay local even when another instance is selected.
        self.ctx.occurrence = occurrence
        route = self.call('path.create', {'curves': [self.ctx.ref(line)], 'chain': 'connected', 'name': 'Route'})['path']
        for operation in ('path.create', 'path.inspect'):
            with self.subTest(operation=operation):
                self.assertEqual(route, {'kind': 'path', 'curves': [self.ctx.ref(line), self.ctx.ref(second)],
                                         'chain': 'none', 'name': 'Route'})
                self.assertTrue(all('occurrence' not in ref and ref['component'] == self.ctx.ref(owner)
                                    for ref in route['curves']))
                self.assertIs(self.ctx.resolve(route['curves'][0]), line)
                self.assertEqual(self.ctx.resolve(route['curves'][1]).endSketchPoint.geometry.x, 2)
                self.assertFalse(self.ctx.created)
                self.assertTrue(all(t[0] == 'transientPath' for t in TRACE))
                route = self.call('path.inspect', route)['path']
        self.call('model.sweep', {'profile': self.ctx.ref(profile), 'path': route})
        self.call('pattern.path', {'entities': [self.ctx.ref(body)], 'path': route, 'quantity': 3, 'distance': '10 mm'})
        for t in TRACE:
            if t[:2] == ('transientPath', 'scoped'):
                self.assertIs(t[2], owner)
                self.assertTrue(all(e.assemblyContext is None for e in t[3]))
            elif t[:2] in (('input', 'sweep'), ('input', 'pathPattern')):
                self.assertIs(t[2][1].owner, owner)
                self.assertIs(t[2][1].item(0).entity.nativeObject, line)
        self.assertEqual([t[1] for t in TRACE if t[0] == 'feature'], ['sweep', 'pathPattern'])

    def test_path_uses_geometry_owner_not_selected_component_and_propagates_failure(self):
        owner = self.ctx.component
        self.ctx.component = self.ctx.root
        self.call('path.create', {'curves': ['line-token']})
        self.assertIs(TRACE[-1][2], owner)
        owner.features.createPath = lambda *args: None
        with self.assertRaisesRegex(RuntimeError, 'Features.createPath'):
            self.call('path.create', {'curves': ['line-token']})
        path = Path([self.ctx.entities['line-token']], owner)
        path.addCurves = lambda *args: False
        owner.features.createPath = lambda *args: path
        with self.assertRaisesRegex(RuntimeError, 'Path.addCurves'):
            self.call('path.create', {'curves': ['line-token'], 'chain': 'tangent'})
        self.assertFalse(self.ctx.created)

    def test_native_path_descriptor_rejects_foreign_generated_geometry(self):
        foreign = SketchLine(Point(0, 0, 0), Point(1, 0, 0), Sketch(self.ctx.root))
        self.ctx.component.features.createPath = lambda *args: Path([foreign], self.ctx.component)
        with self.assertRaisesRegex(ValueError, 'requested native component frame'):
            self.call('path.create', {'curves': ['line-token']})
        self.assertFalse(self.ctx.created)

    def test_proxy_path_preserves_exact_translated_rotated_nested_instance(self):
        native = self.ctx.entities['line-token']
        occurrences = []
        for name, angle, translation in [('First:1', 0, (10, 0)), ('Parent:2+Child:3', math.pi / 2, (4, 7))]:
            occurrence = Entity('Occurrence', name=name)
            occurrence.component = self.ctx.component
            occurrence.fullPathName = name
            occurrence.angle, occurrence.translation = angle, translation
            occurrences.append(occurrence)
        self.ctx.root.allOccurrences = Collection(occurrences)
        self.ctx.ref = types.MethodType(namespace['CadContext'].ref, self.ctx)
        self.ctx.resolve = types.MethodType(namespace['CadContext'].resolve, self.ctx)
        self.ctx._scope = types.MethodType(namespace['CadContext']._scope, self.ctx)
        profile = self.ctx.sketch.profiles.item(0)
        body = self.ctx.entities['Base']
        body.parentComponent = self.ctx.component
        tokens = {e.entityToken: e for e in [native, profile, body, self.ctx.component, *occurrences]}
        self.ctx.design = types.SimpleNamespace(findEntityByToken=lambda token: [tokens[token]])

        def proxy(occurrence):
            result = SketchLine(native.startSketchPoint.geometry, native.endSketchPoint.geometry, self.ctx.sketch)
            result.entityToken = native.entityToken
            result.nativeObject = native
            result.assemblyContext = occurrence
            x, y = occurrence.translation
            result.worldEnd = (x + math.cos(occurrence.angle), y + math.sin(occurrence.angle))
            return result

        native.createForAssemblyContext = proxy
        for occurrence, expected in zip(occurrences, [(11, 0), (4, 8)]):
            ref = self.ctx.ref(proxy(occurrence))
            route = self.call('path.create', {'curves': [ref]})['path']
            self.assertEqual(route['curves'][0]['occurrence']['path'], occurrence.fullPathName)
            self.call('path.inspect', route)
            received = next(t[2][0] for t in reversed(TRACE) if t[:2] == ('transientPath', 'static'))
            self.assertIs(received.assemblyContext, occurrence)
            for value, want in zip(received.worldEnd, expected):
                self.assertAlmostEqual(value, want)
            with self.assertRaisesRegex(ValueError, 'native input geometry'):
                self.call('model.sweep', {'profile': self.ctx.ref(profile), 'path': route})
            with self.assertRaisesRegex(ValueError, 'native input geometry'):
                self.call('pattern.path', {'entities': [self.ctx.ref(body)], 'path': route,
                                           'quantity': 3, 'distance': '10 mm'})
            self.assertTrue(all(t[0] == 'transientPath' for t in TRACE))
        TRACE.clear()
        with self.assertRaisesRegex(ValueError, 'occurrence context'):
            self.call('path.create', {'curves': [self.ctx.ref(proxy(o)) for o in occurrences]})
        self.assertFalse(TRACE)
        self.assertFalse(self.ctx.created)
        self.assertTrue(all(t[0] == 'transientPath' for t in TRACE))

    def test_path_rejects_invalid_or_mixed_contexts_before_sdk_call(self):
        foreign = SketchLine(Point(1, 0, 0), Point(2, 0, 0), Sketch(self.ctx.root))
        self.ctx.entities['foreign'] = foreign
        for refs in (['point-token'], ['Base'], ['line-token', 'foreign']):
            with self.assertRaises(ValueError):
                self.call('path.create', {'curves': refs})
        occurrence = types.SimpleNamespace(component=self.ctx.component)
        self.ctx.entities['axis-line-token'].assemblyContext = occurrence
        with self.assertRaisesRegex(ValueError, 'occurrence context'):
            self.call('path.create', {'curves': ['line-token', 'axis-line-token']})
        self.ctx.entities['line-token'].assemblyContext = types.SimpleNamespace(component=self.ctx.root)
        with self.assertRaisesRegex(ValueError, 'valid owning'):
            self.call('path.create', {'curves': ['line-token']})
        self.assertFalse(TRACE)

    def test_feature_mode_options_and_api_argument_order(self):
        self.call('model.extrude', dict(CATALOG['model.extrude']['example'], symmetric=True, taper='2 deg'))
        self.assertIn(('symmetricExtent', ('expression', '10 mm'), True, ('expression', '2 deg')), TRACE)
        self.call('model.revolve', dict(CATALOG['model.revolve']['example'], symmetric=True))
        self.assertIn(('angleExtent', True, ('expression', '360 deg')), TRACE)
        self.call('model.draft', CATALOG['model.draft']['example'])
        self.assertIn(('draftAngle', False, ('expression', '3 deg')), TRACE)
        self.call('model.thread', dict(CATALOG['model.thread']['example'], length='5 mm', offset='1 mm', rightHanded=False))
        self.assertIn(('set', 'threadOffset', ('expression', '1 mm')), TRACE)
        self.call('model.sweep', dict(CATALOG['model.sweep']['example'], twist='45 deg', taper='1 deg'))
        self.assertIn(('set', 'twistAngle', ('expression', '45 deg')), TRACE)
        self.call('model.shell', dict(CATALOG['model.shell']['example'], outsideThickness='1 mm'))
        self.assertIn(('set', 'outsideThickness', ('expression', '1 mm')), TRACE)

    def test_counterbore_and_countersink_modes(self):
        base = CATALOG['model.hole']['example']
        self.call('model.hole', dict(base, type='counterbore', boreDiameter='8 mm', boreDepth='2 mm'))
        self.call('model.hole', dict(base, type='countersink', sinkDiameter='8 mm', sinkAngle='90 deg'))
        for fields in ({'type': 'counterbore'}, {'sinkAngle': '90 deg'}, {'type': 'unknown'}):
            with self.assertRaises(ValueError):
                self.call('model.hole', dict(base, **fields))

    def test_extrude_extents_offsets_direction_and_expression_identity(self):
        profile = {'kind': 'profile', 'sketch': 'Section', 'index': 0}
        for extent_mode in ('distance', 'throughAll', 'toEntity'):
            for direction in ('positive', 'negative'):
                with self.subTest(extent=extent_mode, direction=direction):
                    TRACE.clear()
                    data = {'profile': profile, 'extent': extent_mode, 'direction': direction,
                            'operation': 'cut', 'participants': ['Base'], 'startOffset': '-1 mm'}
                    if extent_mode == 'distance':
                        data['distance'] = '2 in'
                    elif extent_mode == 'toEntity':
                        data.update(target='XY', offset='-2 mm')
                    result = self.call('model.extrude', data)
                    self.assertIn('feature', result)
                    extent, received_direction, taper = next(t[1:] for t in TRACE if t[0] == 'oneSideExtent')
                    self.assertEqual(received_direction, direction.title() + 'ExtentDirection')
                    if extent_mode == 'distance':
                        self.assertEqual(extent.value, ('expression', '2 in'))
                    elif extent_mode == 'toEntity':
                        self.assertIs(extent.entity, self.ctx.entities['XY'])
                        self.assertEqual(extent.offset, ('expression', '-2 mm'))
                        self.assertIs(extent.isChained, False)
                    else:
                        self.assertIsInstance(extent, ThroughAllExtentDefinition)
                    start = next(t[2] for t in TRACE if t[:2] == ('set', 'startExtent'))
                    self.assertEqual(start.value, ('expression', '-1 mm'))
                    self.assertEqual(next(t[2] for t in TRACE if t[:2] == ('set', 'participantBodies')), [self.ctx.entities['Base']])
                    self.assertFalse(any(t[0] == 'delete' for t in TRACE))
        # Use the real core expression validation and ValueInput construction for a parameter.
        self.ctx.design = types.SimpleNamespace(unitsManager=types.SimpleNamespace(
            isValidExpression=lambda expression, unit: unit == 'cm',
            evaluateExpression=lambda expression, unit: 2.0))
        self.ctx._expression = types.MethodType(namespace['CadContext']._expression, self.ctx)
        self.ctx.value = types.MethodType(namespace['CadContext'].value, self.ctx)
        self.ctx.length = types.MethodType(namespace['CadContext'].length, self.ctx)
        self.call('model.extrude', {'profile': profile, 'distance': 'wall * 2'})
        self.assertEqual(next(t[1] for t in reversed(TRACE) if t[0] == 'oneSideExtent').value,
                         ('expression', 'wall * 2'))

    def test_hole_all_and_to_extents_all_hole_types(self):
        for extra in ({}, {'type': 'counterbore', 'boreDiameter': '8 mm', 'boreDepth': '2 mm'},
                      {'type': 'countersink', 'sinkDiameter': '8 mm', 'sinkAngle': '90 deg'}):
            base = dict(points=['point-token'], diameter='5 mm', participants=['Base'], **extra)
            for reverse in (False, True):
                self.call('model.hole', dict(base, extent='throughAll', reverse=reverse))
                self.assertIn(('holeAll', 'PositiveExtentDirection' if reverse else 'NegativeExtentDirection'), TRACE)
                self.assertEqual(next(t[2] for t in reversed(TRACE) if t[:2] == ('set', 'isDefaultDirection')), not reverse)
            for target in ('XY', 'Base', 'top-face-token'):
                self.call('model.hole', dict(base, extent='toEntity', target=target))
                self.assertIn(('holeTo', self.ctx.entities[target], False, None), TRACE)

    def test_hole_participant_bodies_and_reverse_direction(self):
        self.call('model.hole', {'points': ['point-token'], 'diameter': '5 mm',
                                 'participants': ['Base'], 'depth': '5 mm', 'reverse': True})
        self.assertEqual(next(t[2] for t in TRACE if t[:2] == ('set', 'participantBodies')),
                         [self.ctx.entities['Base']])
        self.assertEqual(next(t[2] for t in reversed(TRACE) if t[:2] == ('set', 'isDefaultDirection')), False)

    def test_sweep_orientation_and_native_guides(self):
        base = CATALOG['model.sweep']['example']
        for orientation in ('parallel', 'perpendicular'):
            self.call('model.sweep', dict(base, orientation=orientation))
            self.assertIn(('set', 'orientation', orientation.title() + 'OrientationType'), TRACE)
        route = self.call('path.create', {'curves': ['line-token']})['path']
        self.call('model.sweep', dict(base, guideRail=route))
        rail = next(t[2] for t in TRACE if t[:2] == ('set', 'guideRail'))
        self.assertIsInstance(rail, Path)
        self.assertIs(rail.owner, self.ctx.component)
        self.assertIs(rail.item(0).entity, self.ctx.entities['line-token'])

    def test_loft_rails_and_centerline_curve_and_path_types(self):
        base = CATALOG['model.loft']['example']
        route = self.call('path.create', {'curves': ['line-token']})['path']
        self.call('model.loft', dict(base, rails=['line-token', 'edge-token', route]))
        rails = [t[1] for t in TRACE if t[0] == 'loftRail']
        self.assertEqual(rails[:2], [self.ctx.entities['line-token'], self.ctx.entities['edge-token']])
        self.assertIsInstance(rails[2], Path)
        self.assertIs(rails[2].owner, self.ctx.component)
        for center in ('line-token', 'edge-token', route):
            self.call('model.loft', dict(base, centerLine=center))
        self.assertEqual(len([t for t in TRACE if t[0] == 'loftCenterLine']), 3)

    def test_priority_modes_reject_conflicts_missing_units_and_unknown_fields_before_mutation(self):
        profile = {'kind': 'profile', 'sketch': 'Section', 'index': 0}
        cases = {
            'model.extrude': ({'profile': profile}, [
                {}, {'extent': 'unknown'}, {'extent': 'throughAll', 'distance': '1 mm'},
                {'extent': 'toEntity'}, {'distance': '1 mm', 'target': 'XY'},
                {'extent': 'throughAll', 'offset': '1 mm'}, {'extent': 'throughAll', 'symmetric': True},
                {'distance': '1 mm', 'symmetric': True, 'direction': 'negative'},
                {'distance': '1 mm', 'symmetric': True, 'startOffset': '1 mm'},
                {'distance': '1 deg'}, {'distance': '1 mm', 'taper': '1 mm'},
                {'extent': 'toEntity', 'target': 'XY', 'offset': '1 deg'},
                {'extent': 'throughAll', 'startOffset': '1 deg'},
                {'extent': 'throughAll', 'direction': 'X'},
                {'extent': 'throughAll', 'participants': ['Base']},
                {'extent': 'throughAll', 'operation': 'cut', 'participants': ['XY']},
                {'extent': 'toEntity', 'target': 'line-token'},
                {'extent': 'throughAll', 'distanceTwo': '1 mm'}]),
            'model.hole': ({'points': ['point-token'], 'diameter': '5 mm'}, [
                {}, {'extent': 'toEntity'}, {'extent': 'throughAll', 'depth': '1 mm'},
                {'extent': 'toEntity', 'target': 'XY', 'reverse': False},
                {'extent': 'toEntity', 'target': 'XY', 'offset': '0 mm'},
                {'extent': 'throughAll', 'startOffset': '0 mm'},
                {'extent': 'throughAll', 'direction': 'negative'},
                {'extent': 'throughAll', 'diameter': '2 deg'},
                {'extent': 'toEntity', 'target': 'line-token'}]),
            'model.sweep': (CATALOG['model.sweep']['example'], [
                {'orientation': 'unknown'}, {'orientation': 'parallel', 'guideRail': {'curves': ['line-token']}},
                {'twist': '1 deg', 'guideRail': {'curves': ['line-token']}},
                {'taper': '1 deg', 'guideRail': {'curves': ['line-token']}},
                {'twist': '1 mm'}, {'guideRail': {'curves': []}},
                {'guideRail': {'curves': ['line-token'], 'unknown': True}}, {'guideSurface': 'XY'}]),
            'model.loft': (CATALOG['model.loft']['example'], [
                {'rails': []}, {'rails': ['line-token'], 'centerLine': 'line-token'},
                {'rails': ['point-token']}, {'centerLine': 'XY'}, {'endContinuity': 'tangent'},
                {'rails': [{'curves': ['line-token'], 'unknown': True}]}])}
        for operation, (base, variants) in cases.items():
            for variant in variants:
                with self.subTest(operation=operation, variant=variant):
                    TRACE.clear()
                    with self.assertRaises(ValueError):
                        self.call(operation, dict(base, **variant))
                    self.assertFalse(TRACE)

    def test_new_target_and_guide_refs_enforce_native_scope(self):
        for proxy in (False, True):
            self.ctx.entities['XY'].parentComponent = self.ctx.root if not proxy else self.ctx.component
            self.ctx.entities['XY'].assemblyContext = object() if proxy else None
            self.ctx.entities['line-token'].parentSketch = Sketch(self.ctx.root) if not proxy else self.ctx.sketch
            self.ctx.entities['line-token'].assemblyContext = object() if proxy else None
            cases = [
                ('model.extrude', {'profile': {'kind': 'profile', 'sketch': 'Section'}, 'extent': 'toEntity', 'target': 'XY'}),
                ('model.hole', {'points': ['point-token'], 'diameter': '5 mm', 'extent': 'toEntity', 'target': 'XY'}),
                ('model.sweep', dict(CATALOG['model.sweep']['example'], guideRail={'curves': ['line-token']})),
                ('model.loft', dict(CATALOG['model.loft']['example'], rails=[{'curves': ['line-token']}])),
                ('model.loft', dict(CATALOG['model.loft']['example'], centerLine='line-token'))]
            for operation, data in cases:
                with self.assertRaisesRegex(ValueError, 'native input geometry'):
                    self.call(operation, data)
                self.assertFalse(TRACE)

    def test_priority_api_signatures_match_installed_public_sdk(self):
        import ast
        sdk = pathlib.Path('/mnt/c/Users/kamil/AppData/Roaming/Autodesk/Autodesk Fusion 360/API/Python/defs/adsk/fusion.py')
        if not sdk.exists():
            self.skipTest('Installed Fusion SDK is not available')
        classes = {n.name: n for n in ast.parse(sdk.read_text(encoding='utf-8-sig')).body if isinstance(n, ast.ClassDef)}
        signatures = {
            ('ThroughAllExtentDefinition', 'create'): [],
            ('DistanceExtentDefinition', 'create'): [('distance', 'core.ValueInput')],
            ('OffsetStartDefinition', 'create'): [('offset', 'core.ValueInput')],
            ('ToEntityExtentDefinition', 'create'): [('entity', 'core.Base'), ('isChained', 'bool'), ('offset', 'core.ValueInput')],
            ('HoleFeatureInput', 'setAllExtent'): [('direction', 'ExtentDirections')],
            ('HoleFeatureInput', 'isDefaultDirection'): [('value', 'bool')],
            ('HoleFeatureInput', 'setOneSideToExtent'): [('toEntity', 'core.Base'), ('matchShape', 'bool'), ('directionHint', 'core.Vector3D')],
            ('LoftCenterLineOrRails', 'addRail'): [('entity', 'core.Base')],
            ('LoftCenterLineOrRails', 'addCenterLine'): [('entity', 'core.Base')],
            ('SweepFeatureInput', 'guideRail'): [('value', 'Path')],
            ('SweepFeatureInput', 'orientation'): [('value', 'SweepOrientationTypes')],
        }
        for (cls, method), expected in signatures.items():
            with self.subTest(cls=cls, method=method):
                node = [n for n in classes[cls].body if isinstance(n, ast.FunctionDef) and n.name == method][-1]
                self.assertEqual([(a.arg, ast.unparse(a.annotation)) for a in node.args.args if a.arg != 'self'], expected)
                self.assertNotIn('preview feature', ast.get_docstring(classes[cls]).lower())

    def test_homogeneous_feature_subclasses_and_bad_patterns(self):
        self.ctx.entities['f1'] = Entity('ExtrudeFeature')
        self.ctx.entities['f2'] = Entity('FilletFeature')
        self.call('model.mirror', {'entities': ['f1', 'f2'], 'plane': 'XY'})
        with self.assertRaisesRegex(ValueError, 'same API type'):
            self.call('model.mirror', {'entities': ['Base', 'f1'], 'plane': 'XY'})
        with self.assertRaisesRegex(ValueError, 'one construction'):
            self.call('model.mirror', {'entities': ['XY', 'XZ'], 'plane': 'YZ'})
        with self.assertRaisesRegex(ValueError, 'Second direction'):
            self.call('pattern.rectangular', {'entities': ['Base'], 'direction': 'X', 'quantity': 2,
                'distance': '2 mm', 'quantityTwo': 3})

    def test_no_arbitrary_code_or_document_mutations(self):
        import ast
        source = '\n'.join((ROOT / ('runtime/python/fmcad/' + layer + '/geometry_model.py')).read_text()
                           for layer in ('domain', 'adapters/fusion', 'application'))
        tree = ast.parse(source)
        forbidden = {'eval', 'exec', 'compile', 'executeTextCommand', 'save', 'saveAs', 'activate', 'activateRootComponent', 'close', 'allOccurrencesByComponent'}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                name = node.func.id if isinstance(node.func, ast.Name) else node.func.attr if isinstance(node.func, ast.Attribute) else None
                self.assertNotIn(name, forbidden)
            if isinstance(node, ast.FunctionDef):
                self.assertNotEqual(node.name, 'run')
            if isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Store):
                self.assertNotIn(node.attr, {'designType', 'activeComponent', 'activeOccurrence', 'transform2'})
            self.assertNotIsInstance(node, ast.ExceptHandler)


if __name__ == '__main__':
    unittest.main(verbosity=2)
