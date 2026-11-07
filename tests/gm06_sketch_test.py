"""GM06 parser/SDK-shape and failure-injection tests; no Fusion kernel claims."""
import copy
import json
import math
import types
import unittest
import sys
from unittest.mock import patch

_old_adsk_modules = {name: sys.modules.get(name) for name in ('adsk', 'adsk.core', 'adsk.fusion')}
import model_test as base
for _name, _module in _old_adsk_modules.items():
    if _module is None:
        sys.modules.pop(_name, None)
    else:
        sys.modules[_name] = _module


P = base.Point
C = base.Collection
TRACE = base.TRACE
NS = dict(base.namespace, CAD_HANDLERS=dict(base.HANDLERS))
sdk = types.SimpleNamespace(core=types.SimpleNamespace(**vars(base.adsk.core)), fusion=types.SimpleNamespace(**vars(base.adsk.fusion)))
NS['adsk'] = sdk


class Matrix:
    @staticmethod
    def create():
        return Matrix()

    def setWithArray(self, values):
        assert len(values) == 16
        self.values = values
        return True

    def asArray(self):
        return self.values


sdk.core.Matrix3D = Matrix
sdk.core.Vector3D = P
sdk.fusion.DesignTypes = types.SimpleNamespace(ParametricDesignType=1)
for name in ('shapes.py', 'sketch.py', 'sketch_plan.py'):
    exec(compile((base.ROOT / 'assets/cad' / name).read_text(), name, 'exec'), NS)


class Point(base.SketchPoint):
    refuse = False

    def move(self, translation):
        TRACE.append(('movePoint', translation.x, translation.y, translation.z))
        if self.refuse:
            return False
        self.geometry = P(self.geometry.x+translation.x, self.geometry.y+translation.y, self.geometry.z+translation.z)
        return True


class Ellipse(base.Entity):
    def __init__(self, center, major, minor, sketch):
        super().__init__('SketchEllipse', sketch)
        self.centerSketchPoint = Point(center, sketch)
        self.majorAxisRadius = math.hypot(major.x-center.x, major.y-center.y)
        self.minorAxisRadius = math.hypot(minor.x-center.x, minor.y-center.y)
        self.majorAxis = P((major.x-center.x)/self.majorAxisRadius, (major.y-center.y)/self.majorAxisRadius, 0)
        self.majorAxisLine = base.SketchLine(center, major, sketch)
        self.minorAxisLine = base.SketchLine(center, minor, sketch)


class Factory(base.CurveFactory):
    def record(self, method, entity):
        result = super().record(method, entity)
        for prop in ('startSketchPoint', 'endSketchPoint', 'centerSketchPoint'):
            point = getattr(entity, prop, None)
            if point is not None:
                self.sketch.sketchPoints.values.append(point)
        return result

    def add(self, center, major, minor):
        assert all(isinstance(p, P) for p in (center, major, minor))
        return self.record('ellipse', Ellipse(center, major, minor, self.sketch))


class Parameter:
    def __init__(self, entity, attr, initial='1 cm'):
        self.entity, self.attr, self.name = entity, attr, 'd' + str(base.Entity.serial)
        self._expression = initial

    @property
    def expression(self):
        return self._expression

    @expression.setter
    def expression(self, value):
        if value == 'conflict mm':
            raise RuntimeError('solver expression conflict')
        self._expression = value
        if self.attr:
            number, unit = value.split()
            setattr(self.entity, self.attr, float(number) * {'mm': .1, 'cm': 1}[unit])


class Dimensions(C):
    def __init__(self, sketch):
        super().__init__()
        self.sketch = sketch
        self.fail_at = None

    def add_dimension(self, kind, driving, props, attr=None):
        TRACE.append(('dimension', kind))
        if self.fail_at == len(self.values):
            raise RuntimeError('injected solver conflict')
        d = base.Entity(kind, self.sketch)
        for prop, value in props.items():
            setattr(d, prop, value)
        d.isDriving = driving
        d.parameter = Parameter(next(iter(props.values())), attr)
        self.values.append(d)
        return d

    def addEllipseMajorRadiusDimension(self, ellipse, text, isDriving=True):
        assert isinstance(ellipse, Ellipse) and isinstance(text, P) and type(isDriving) is bool
        return self.add_dimension('SketchEllipseMajorRadiusDimension', isDriving, {'ellipse': ellipse}, 'majorAxisRadius')

    def addEllipseMinorRadiusDimension(self, ellipse, text, isDriving=True):
        assert isinstance(ellipse, Ellipse) and isinstance(text, P) and type(isDriving) is bool
        return self.add_dimension('SketchEllipseMinorRadiusDimension', isDriving, {'ellipse': ellipse}, 'minorAxisRadius')

    def addRadialDimension(self, curve, text, driving):
        assert isinstance(curve, base.SketchCircle)
        return self.add_dimension('SketchRadialDimension', driving, {'entity': curve}, 'radius')

    def addDiameterDimension(self, curve, text, driving):
        return self.add_dimension('SketchDiameterDimension', driving, {'entity': curve})

    def addDistanceDimension(self, a, b, orientation, text, driving):
        return self.add_dimension('SketchLinearDimension', driving, {'entityOne': a, 'entityTwo': b, 'orientation': orientation})

    def addAngularDimension(self, a, b, text, driving):
        assert isinstance(a, base.SketchLine) and isinstance(b, base.SketchLine)
        return self.add_dimension('SketchAngularDimension', driving, {'lineOne': a, 'lineTwo': b})


class Constraints(base.Constraints):
    def __getattr__(self, method):
        props = {'addHorizontal': ('HorizontalConstraint', ['line']), 'addVertical': ('VerticalConstraint', ['line']),
            'addParallel': ('ParallelConstraint', ['lineOne', 'lineTwo']),
            'addPerpendicular2': ('PerpendicularConstraint', ['line', 'curve']),
            'addEqual': ('EqualConstraint', ['curveOne', 'curveTwo']),
            'addCoincident': ('CoincidentConstraint', ['point', 'entity']),
            'addConcentric': ('ConcentricConstraint', ['entityOne', 'entityTwo']),
            'addHorizontalPoints': ('HorizontalPointsConstraint', ['pointOne', 'pointTwo']),
            'addVerticalPoints': ('VerticalPointsConstraint', ['pointOne', 'pointTwo'])}
        if method not in props:
            return super().__getattr__(method)
        def add(*args):
            kind, attributes = props[method]
            assert len(args) == len(attributes)
            TRACE.append((method,))
            c = base.Entity(kind, self.sketch)
            for name, value in zip(attributes, args):
                setattr(c, name, value)
            self.values.append(c)
            return c
        return add


class Sketch(base.Sketch):
    def __init__(self, component, plane='XY'):
        super().__init__(component)
        self.plane = plane
        self.originPoint = Point(P(0, 0, 0), self)
        factory = Factory(self)
        for prop in ('sketchEllipses', 'sketchLines', 'sketchCircles', 'sketchArcs'):
            setattr(self.sketchCurves, prop, factory)
        self.sketchDimensions = Dimensions(self)
        self.geometricConstraints = Constraints(self)
        self.refuse = False
        self.ignore_move = False
        self.timelineObject = types.SimpleNamespace(rollTo=lambda before: TRACE.append(('rollTo', before)) or True)

    def sketchToModelSpace(self, p):
        # Independent non-XY bases: XZ maps local +Y to root -Z;
        # YZ maps local +X to root -Z and +Y to root +Y.
        return {'XY': P(p.x, p.y, p.z), 'XZ': P(p.x, p.z, -p.y), 'YZ': P(p.z, p.y, -p.x)}[self.plane]

    def move(self, entities, matrix):
        assert isinstance(entities, C)
        TRACE.append(('move', matrix.asArray()))
        if self.refuse:
            return False
        if self.ignore_move:
            return True
        m = matrix.asArray()
        contained = entities.values
        seen = []
        for entity in contained:
            points = [entity] if isinstance(entity, base.SketchPoint) else [getattr(entity, p, None) for p in ('startSketchPoint', 'endSketchPoint', 'centerSketchPoint')]
            for point in points:
                if point is not None and point not in seen:
                    p = point.geometry
                    point.geometry = P(m[0]*p.x+m[1]*p.y+m[3], m[4]*p.x+m[5]*p.y+m[7], p.z)
                    seen.append(point)
            if isinstance(entity, Ellipse) and entity.majorAxisLine in contained:
                a = entity.majorAxis
                entity.majorAxis = P(m[0]*a.x+m[1]*a.y, m[4]*a.x+m[5]*a.y, 0)
        return True


class Context(base.Context):
    def __init__(self):
        super().__init__()
        self.doc = types.SimpleNamespace(creationId='gm06-doc', name='GM06')
        self.design = types.SimpleNamespace(designType=1)
        self.design.timeline = types.SimpleNamespace(moveToEnd=lambda: TRACE.append(('moveToEnd',)) or True)
        self.design.computeAll = lambda: TRACE.append(('computeAll',)) or True
        self.sketch = Sketch(self.component)
        self.entities['Section'] = self.sketch
        self.component.sketches = C([self.sketch])
        self.component.sketches.addWithoutEdges = self.add_sketch
        self.component.features.count = 0
        for prop in ('constructionPlanes', 'constructionAxes', 'constructionPoints', 'bRepBodies'):
            setattr(self.component, prop, C())
        for plane in ('XY', 'XZ', 'YZ'):
            self.entities[plane].component = self.component
        self.identity_valid = True

    def assert_identity(self):
        if not self.identity_valid:
            raise ValueError('document identity changed')

    def add_sketch(self, plane):
        TRACE.append(('sketchCreate', plane.name))
        sketch = Sketch(self.component, plane.name)
        self.component.sketches.values.append(sketch)
        return sketch

    def call(self, operation, data):
        result = NS['CAD_HANDLERS'][operation](self, data)
        json.dumps(result, allow_nan=False)
        return result

    def describe(self, entity):
        result = self.ref(entity)
        if isinstance(entity, Ellipse):
            result.update(majorRadius=entity.majorAxisRadius, minorRadius=entity.minorAxisRadius,
                axis=[entity.majorAxis.x, entity.majorAxis.y, entity.majorAxis.z])
        elif isinstance(entity, base.SketchCircle):
            result['radius'] = entity.radius
        return result


def ellipse(**extra):
    return dict(type='ellipse', name='oval', center=['-10 mm', '0 mm', '0 mm'], majorRadius='20 mm', minorRadius='10 mm', **extra)


class GM06Tests(unittest.TestCase):
    def setUp(self):
        TRACE.clear()
        self.ctx = Context()

    def add(self, specs):
        return self.ctx.call('sketch.geometry', {'sketch': 'Section', 'geometry': specs})

    def test_ellipse_variants_radii_not_diameters_and_axis_orientation(self):
        for spec in (ellipse(angle='90 deg'), {'type': 'ellipse', 'center': ['-10 mm', '0 mm', '0 mm'],
                'majorAxisPoint': ['-10 mm', '20 mm', '0 mm'], 'minorAxisPoint': ['-20 mm', '0 mm', '0 mm']}):
            result = self.add([spec])
            oval = self.ctx.resolve(result['entities'][0])
            self.assertEqual(oval.majorAxisRadius, 2)
            self.assertEqual(oval.minorAxisRadius, 1)
            self.assertAlmostEqual(oval.majorAxis.y, 1)
            self.assertEqual(result['frame']['space'], 'sketch')

    def test_whole_geometry_preflight_prevents_partial_creation(self):
        invalid = [dict(ellipse(), minorRadius='30 mm'), dict(ellipse(), majorRadius='0 mm'),
            dict(ellipse(), minorRadius='-1 mm'), dict(ellipse(), center=['0 mm', '0 mm', '1 mm']),
            {'type': 'ellipse', 'center': ['0 mm']*3, 'majorAxisPoint': ['20 mm', '0 mm', '0 mm'], 'minorAxisPoint': ['1 mm', '10 mm', '0 mm']},
            dict(ellipse(), majorAxisPoint=['20 mm', '0 mm', '0 mm'])]
        for bad in invalid:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.add([{'type': 'circle', 'center': ['0 mm']*3, 'radius': '5 mm'}, bad])
            self.assertEqual(TRACE, [])

    def test_native_major_minor_dimensions_edit_and_driven(self):
        ref = self.add([ellipse()])['entities'][0]
        made = []
        for mode, value in [('majorRadius', '25 mm'), ('minorRadius', '8 mm')]:
            made.append(self.ctx.call('sketch.dimension', {'sketch': 'Section', 'type': mode, 'entities': [ref], 'text': ['10 mm']*2+['0 mm'], 'expression': value}))
        oval = self.ctx.resolve(ref)
        self.assertEqual((oval.majorAxisRadius, oval.minorAxisRadius), (2.5, .8))
        edited = self.ctx.call('sketch.edit', {'sketch': 'Section', 'dimensions': [
            {'dimension': made[0]['dimension'], 'expression': '30 mm'}, {'dimension': made[1]['dimension'], 'expression': '12 mm'}]})
        self.assertEqual(edited['status'], 'pass')
        self.assertAlmostEqual(oval.majorAxisRadius, 3)
        self.assertAlmostEqual(oval.minorAxisRadius, 1.2)
        self.assertNotEqual(edited['before'], edited['after'])
        with self.assertRaisesRegex(ValueError, 'existing dimension'):
            self.ctx.call('sketch.dimension', {'sketch': 'Section', 'type': 'majorRadius', 'entities': [ref], 'text': ['0 mm']*3, 'expression': '30 mm'})
        new_ref = self.add([ellipse()])['entities'][0]
        driven = self.ctx.call('sketch.dimension', {'sketch': 'Section', 'type': 'minorRadius', 'entities': [new_ref], 'text': ['0 mm']*3, 'driving': False})
        self.assertFalse(self.ctx.resolve(driven['dimension']).isDriving)

    def test_build_reuses_shapes_schema_and_exposes_orientation_lines(self):
        data = {'name': 'Built', 'plane': 'XZ', 'geometry': [ellipse(angle='30 deg'),
            {'type': 'line', 'name': 'axis', 'start': ['0 mm']*3, 'end': ['10 mm', '0 mm', '0 mm'], 'fixed': True, 'construction': True}],
            'dimensions': [{'type': 'angle', 'entities': ['axis', 'oval.majorAxis'], 'expression': '30 deg'},
                {'type': 'majorRadius', 'entities': ['oval'], 'expression': '20 mm'}, {'type': 'minorRadius', 'entities': ['oval'], 'expression': '10 mm'}]}
        result = self.ctx.call('sketch.build', data)
        sketch = self.ctx.resolve(result['sketch'])
        self.assertEqual(sketch.plane, 'XZ')
        self.assertEqual(sketch.sketchDimensions.count, 3)
        self.assertIn('oval.majorAxis', result['refs'])
        self.assertEqual(result['profiles'][0]['kind'], 'profile')
        before = list(TRACE)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.ctx.call('sketch.build', data)
        self.assertEqual(TRACE, before)

    def test_transform_xz_yz_rotate_then_translate_and_center(self):
        for plane in ('XZ', 'YZ'):
            self.setUp()
            self.ctx.sketch.plane = plane
            ref = self.add([ellipse()])['entities'][0]
            result = self.ctx.call('sketch.transform', {'sketch': 'Section', 'entities': [ref], 'frame': 'sketch',
                'rotate': {'angle': '90 deg', 'center': ['10 mm', '0 mm', '0 mm']}, 'translate': ['-10 mm', '10 mm', '0 mm']})
            oval = self.ctx.resolve(ref)
            self.assertEqual(result['status'], 'pass')
            self.assertAlmostEqual(oval.centerSketchPoint.geometry.x, 0)
            self.assertAlmostEqual(oval.centerSketchPoint.geometry.y, -1)
            self.assertAlmostEqual(oval.majorAxis.x, 0)
            self.assertAlmostEqual(oval.majorAxis.y, 1)
            for line, end in ((oval.majorAxisLine, (0, 1)), (oval.minorAxisLine, (-1, -1))):
                self.assertAlmostEqual(line.startSketchPoint.geometry.x, 0)
                self.assertAlmostEqual(line.startSketchPoint.geometry.y, -1)
                self.assertAlmostEqual(line.endSketchPoint.geometry.x, end[0])
                self.assertAlmostEqual(line.endSketchPoint.geometry.y, end[1])
            world = self.ctx.sketch.sketchToModelSpace(oval.centerSketchPoint.geometry)
            expected = (0, 0, 1) if plane == 'XZ' else (0, -1, 0)
            for a, b in zip((world.x, world.y, world.z), expected):
                self.assertAlmostEqual(a, b)
            self.assertEqual(self.ctx.sketch.geometricConstraints.count, 0)

    def test_transform_moves_ellipse_axis_lines_translate_only(self):
        ref = self.add([ellipse()])['entities'][0]
        oval = self.ctx.resolve(ref)
        result = self.ctx.call('sketch.transform', {'sketch': 'Section', 'entities': [ref], 'frame': 'sketch',
            'translate': ['5 mm', '-5 mm', '0 mm']})
        self.assertEqual(result['status'], 'pass')
        self.assertAlmostEqual(oval.centerSketchPoint.geometry.x, -0.5)
        self.assertAlmostEqual(oval.centerSketchPoint.geometry.y, -0.5)
        self.assertAlmostEqual(oval.majorAxis.x, 1)
        self.assertAlmostEqual(oval.majorAxis.y, 0)
        for line, end in ((oval.majorAxisLine, (1.5, -0.5)), (oval.minorAxisLine, (-0.5, 0.5))):
            self.assertAlmostEqual(line.startSketchPoint.geometry.x, -0.5)
            self.assertAlmostEqual(line.startSketchPoint.geometry.y, -0.5)
            self.assertAlmostEqual(line.endSketchPoint.geometry.x, end[0])
            self.assertAlmostEqual(line.endSketchPoint.geometry.y, end[1])

    def test_transform_moves_ellipse_axis_lines_rotate_only(self):
        ref = self.add([ellipse()])['entities'][0]
        oval = self.ctx.resolve(ref)
        result = self.ctx.call('sketch.transform', {'sketch': 'Section', 'entities': [ref], 'frame': 'sketch',
            'rotate': {'angle': '90 deg'}})
        self.assertEqual(result['status'], 'pass')
        self.assertAlmostEqual(oval.centerSketchPoint.geometry.x, 0)
        self.assertAlmostEqual(oval.centerSketchPoint.geometry.y, -1)
        self.assertAlmostEqual(oval.majorAxis.x, 0)
        self.assertAlmostEqual(oval.majorAxis.y, 1)
        for line, end in ((oval.majorAxisLine, (0, 1)), (oval.minorAxisLine, (-1, -1))):
            self.assertAlmostEqual(line.startSketchPoint.geometry.x, 0)
            self.assertAlmostEqual(line.startSketchPoint.geometry.y, -1)
            self.assertAlmostEqual(line.endSketchPoint.geometry.x, end[0])
            self.assertAlmostEqual(line.endSketchPoint.geometry.y, end[1])

    def test_transform_collection_includes_ellipse_axis_lines(self):
        ref = self.add([ellipse()])['entities'][0]
        oval = self.ctx.resolve(ref)
        moved = []
        original = self.ctx.sketch.move
        def capture(entities, matrix):
            moved.extend(entities.values)
            return original(entities, matrix)
        self.ctx.sketch.move = capture
        result = self.ctx.call('sketch.transform', {'sketch': 'Section', 'entities': [ref], 'frame': 'sketch',
            'translate': ['1 mm', '0 mm', '0 mm']})
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(moved.count(oval), 1)
        self.assertIn(oval.majorAxisLine, moved)
        self.assertIn(oval.minorAxisLine, moved)

    def test_move_negative_zero_positive_and_constrained_refusal(self):
        point = Point(P(-1, 0, 0), self.ctx.sketch)
        ref = self.ctx.ref(point)
        self.ctx.sketch.sketchPoints.values.append(point)
        for coordinate in ('0 mm', '10 mm', '-10 mm'):
            result = self.ctx.call('sketch.edit', {'sketch': 'Section', 'movePoints': [{'point': ref, 'to': [coordinate, '0 mm', '0 mm']}]})
            self.assertEqual(result['status'], 'pass')
            self.assertEqual(point.geometry.x, self.ctx.length(coordinate))
        point.isFullyConstrained = True
        before = list(TRACE)
        result = self.ctx.call('sketch.edit', {'sketch': 'Section', 'movePoints': [{'point': ref, 'to': ['0 mm']*3}]})
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['before'], result['after'])
        self.assertEqual(TRACE, before)

    def test_solver_false_silent_failure_and_exception_report_before_after(self):
        ref = self.add([ellipse()])['entities'][0]
        request = {'sketch': 'Section', 'entities': [ref], 'frame': 'sketch', 'translate': ['1 mm', '0 mm', '0 mm']}
        self.ctx.sketch.refuse = True
        result = self.ctx.call('sketch.transform', request)
        self.assertEqual(result['status'], 'fail')
        self.ctx.sketch.refuse = False
        self.ctx.sketch.ignore_move = True
        self.assertEqual(self.ctx.call('sketch.transform', request)['status'], 'fail')
        def fail(*args):
            raise RuntimeError('solver conflict')
        self.ctx.sketch.move = fail
        result = self.ctx.call('sketch.transform', request)
        self.assertEqual(result['conflicts'], ['solver conflict'])
        self.assertFalse(any(t[0] == 'delete' for t in TRACE))

    def test_plan_apply_replan_is_read_only_and_no_radius_duplicates(self):
        self.add([{'type': 'circle', 'center': ['0 mm']*3, 'radius': '10 mm'}, ellipse()])
        before = list(TRACE), list(self.ctx.created)
        result = self.ctx.call('sketch.dimension-plan', {'sketch': 'Section'})
        self.assertEqual((TRACE, self.ctx.created), before)
        self.assertFalse(result['mutation'])
        self.assertEqual(len(result['plan']['proposals']), 3)
        applied = self.ctx.call('sketch.dimension-apply', {'sketch': 'Section', 'plan': result['plan'], 'accept': ['p1', 'p2', 'p3']})
        self.assertEqual(applied['status'], 'pass')
        self.assertEqual(self.ctx.call('sketch.dimension-plan', {'sketch': 'Section'})['plan']['proposals'], [])
        with self.assertRaisesRegex(ValueError, 'stale'):
            self.ctx.call('sketch.dimension-apply', {'sketch': 'Section', 'plan': result['plan'], 'accept': ['p1']})

    def test_dimension_count_is_not_recognition_and_diameter_prevents_radius(self):
        refs = self.add([{'type': 'circle', 'center': ['0 mm']*3, 'radius': '10 mm'},
            {'type': 'circle', 'center': ['30 mm', '0 mm', '0 mm'], 'radius': '10 mm'}])['entities']
        d = self.ctx.sketch.sketchDimensions.addDiameterDimension(self.ctx.resolve(refs[0]), P(0, 0, 0), True)
        plan = self.ctx.call('sketch.dimension-plan', {'sketch': 'Section'})
        self.assertEqual(len(plan['plan']['proposals']), 1)
        self.assertEqual(plan['plan']['proposals'][0]['data']['entities'], [refs[1]])
        self.assertEqual(plan['existing'][0]['ref'], self.ctx.ref(d))

    def test_rectangle_rotated_and_existing_opposite_dimension(self):
        points = [P(0, 0, 0), P(2, 2, 0), P(1, 3, 0), P(-1, 1, 0)]
        lines = [self.ctx.sketch.sketchCurves.sketchLines.addByTwoPoints(points[i], points[(i+1)%4]) for i in range(4)]
        d = self.ctx.sketch.sketchDimensions.addDistanceDimension(lines[2].startSketchPoint, lines[2].endSketchPoint,
            sdk.fusion.DimensionOrientations.AlignedDimensionOrientation, P(1, 1, 0), True)
        plan = self.ctx.call('sketch.dimension-plan', {'sketch': 'Section'})
        self.assertEqual(len(plan['recognized']), 1)
        self.assertEqual(plan['recognized'][0]['type'], 'rectangle')
        self.assertEqual(len(plan['plan']['proposals']), 1)
        result = self.ctx.call('sketch.dimension-apply', {'sketch': 'Section', 'plan': plan['plan'], 'accept': ['p1']})
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(self.ctx.call('sketch.dimension-plan', {'sketch': 'Section'})['plan']['proposals'], [])

    def test_existing_native_relations_and_alias_refs(self):
        refs = self.add([{'type': 'line', 'start': ['0 mm']*3, 'end': ['10 mm', '0 mm', '0 mm']},
            {'type': 'line', 'start': ['0 mm', '20 mm', '0 mm'], 'end': ['10 mm', '20 mm', '0 mm']}])['entities']
        lines = [self.ctx.resolve(r) for r in refs]
        self.ctx.sketch.geometricConstraints.addParallel(*lines)
        self.ctx.sketch.geometricConstraints.addEqual(*lines)
        self.ctx.sketch.geometricConstraints.addHorizontal(lines[0])
        self.ctx.entities['different-token-same-entity'] = lines[1]
        relations = [{'type': 'parallel', 'entities': [refs[0], {'token': 'different-token-same-entity'}]},
            {'type': 'equal', 'entities': list(reversed(refs))}, {'type': 'horizontal', 'entities': [refs[0]]}]
        before = list(TRACE)
        plan = self.ctx.call('sketch.dimension-plan', {'sketch': 'Section', 'relations': relations})
        self.assertEqual(plan['plan']['proposals'], [])
        self.assertEqual(TRACE, before)

    def test_apply_stale_tampered_foreign_unknown_ids_before_mutation(self):
        self.add([ellipse()])
        plan = self.ctx.call('sketch.dimension-plan', {'sketch': 'Section'})['plan']
        bad = copy.deepcopy(plan)
        bad['proposals'][0]['data']['expression'] = '80 mm'
        foreign = copy.deepcopy(plan)
        foreign['documentIdentity']['creationId'] = 'foreign'
        before = list(TRACE)
        for p, ids in ((bad, ['p1']), (foreign, ['p1']), (plan, ['missing']), (plan, ['p1', 'p1'])):
            with self.assertRaises(ValueError):
                self.ctx.call('sketch.dimension-apply', {'sketch': 'Section', 'plan': p, 'accept': ids})
        self.assertEqual(TRACE, before)
        self.ctx.sketch.sketchPoints.item(0).geometry.x += 1
        with self.assertRaisesRegex(ValueError, 'stale'):
            self.ctx.call('sketch.dimension-apply', {'sketch': 'Section', 'plan': plan, 'accept': ['p1']})

    def test_apply_partial_conflict_retains_constraints_and_reports_unapplied(self):
        self.add([ellipse()])
        self.ctx.sketch.sketchDimensions.fail_at = 1
        plan = self.ctx.call('sketch.dimension-plan', {'sketch': 'Section'})['plan']
        result = self.ctx.call('sketch.dimension-apply', {'sketch': 'Section', 'plan': plan, 'accept': ['p1', 'p2']})
        self.assertEqual(result['status'], 'fail')
        self.assertEqual(len(result['completed']), 1)
        self.assertEqual(result['notApplied'], ['p2'])
        self.assertEqual(self.ctx.sketch.sketchDimensions.count, 1)
        self.assertFalse(any(t[0] == 'delete' for t in TRACE))

    def test_signed_position_expression_frame_coefficients_xz_yz(self):
        for plane in ('XY', 'XZ', 'YZ'):
            sketch = Sketch(self.ctx.component, plane)
            expressions = NS['_sketch_component_expressions'](sketch, ['signed_x', 'signed_y', '0 mm'])
            for x in (-1, 0, 1):
                values = [eval(e.replace(' cm', '').replace('signed_x', str(x)).replace('signed_y', '-2'), {'__builtins__': {}}, {}) for e in expressions]
                expected = sketch.sketchToModelSpace(P(x, -2, 0))
                self.assertEqual(values, [expected.x, expected.y, expected.z])

    def test_identity_scope_and_work_budget_guard(self):
        self.ctx.identity_valid = False
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.add([ellipse()])
        self.assertEqual(TRACE, [])
        self.ctx.identity_valid = True
        self.ctx.sketch.assemblyContext = object()
        with self.assertRaisesRegex(ValueError, 'native sketch'):
            self.add([ellipse()])
        self.ctx.sketch.assemblyContext = None
        self.add([ellipse(), dict(ellipse(), name='other')])
        with self.assertRaisesRegex(ValueError, 'maxEntities'):
            self.ctx.call('sketch.dimension-plan', {'sketch': 'Section', 'maxEntities': 1})

    def test_equal_circles_share_one_size_and_coincident_dimension_points(self):
        refs = self.add([{'type': 'circle', 'center': ['0 mm']*3, 'radius': '10 mm'},
            {'type': 'circle', 'center': ['30 mm', '0 mm', '0 mm'], 'radius': '10 mm'}])['entities']
        self.ctx.sketch.geometricConstraints.addEqual(*[self.ctx.resolve(r) for r in refs])
        plan = self.ctx.call('sketch.dimension-plan', {'sketch': 'Section'})['plan']
        self.assertEqual(len(plan['proposals']), 1)
        self.ctx.call('sketch.dimension-apply', {'sketch': 'Section', 'plan': plan, 'accept': ['p1']})
        self.assertEqual(self.ctx.call('sketch.dimension-plan', {'sketch': 'Section'})['plan']['proposals'], [])
        points = [Point(P(i, 0, 0), self.ctx.sketch) for i in range(4)]
        dims = self.ctx.sketch.sketchDimensions
        orientation = sdk.fusion.DimensionOrientations.AlignedDimensionOrientation
        dims.addDistanceDimension(points[0], points[1], orientation, P(0, 0, 0), True)
        self.ctx.sketch.geometricConstraints.addCoincident(points[0], points[2])
        self.ctx.sketch.geometricConstraints.addCoincident(points[1], points[3])
        recognized, unknown = NS['_sketch_existing'](self.ctx, self.ctx.sketch)
        self.assertTrue(NS['_sketch_has'](recognized, 'distance', points[2:], orientation))

    def test_build_preflight_dimension_conflicts_and_safe_shrink_order(self):
        data = {'name': 'Shrunk', 'geometry': [ellipse()], 'dimensions': [
            {'type': 'majorRadius', 'entities': ['oval'], 'expression': '5 mm'},
            {'type': 'minorRadius', 'entities': ['oval'], 'expression': '3 mm'}]}
        result = self.ctx.call('sketch.build', data)
        shape = self.ctx.resolve(result['refs']['oval'])
        self.assertAlmostEqual(shape.majorAxisRadius, .5)
        self.assertAlmostEqual(shape.minorAxisRadius, .3)
        for dims in ([data['dimensions'][0]]*2, [dict(data['dimensions'][0], expression='2 mm'), data['dimensions'][1]],
                     [dict(data['dimensions'][0], entities=['missing'])]):
            before = list(TRACE)
            with self.assertRaises(ValueError):
                self.ctx.call('sketch.build', dict(data, name='Invalid', dimensions=dims))
            self.assertEqual(TRACE, before)

    def test_position_binding_plumbing_and_helper_collision_preflight(self):
        data = {'name': 'Positioned', 'plane': 'XZ', 'geometry': [ellipse()],
            'positions': [{'name': 'CenterDatum', 'point': 'oval.center', 'coordinates': ['-10 mm', '0 mm', '0 mm']}]}
        calls = []
        def linked(ctx, sketch_ref, name, coords):
            calls.append((name, coords))
            sketch = ctx.resolve(sketch_ref)
            return Point(P(-1, 0, 0), sketch), [{'name': name}]
        with patch.dict(NS, {'_shapes_linked_point': linked}):
            result = self.ctx.call('sketch.build', data)
        self.assertIn('CenterDatum.helpers', result['refs'])
        sketch = self.ctx.resolve(result['sketch'])
        self.assertEqual(sketch.geometricConstraints.count, 1)
        self.assertIn('(-10 mm)', calls[0][1][0])
        self.assertIn('(-1)', calls[0][1][2])
        before = list(TRACE)
        with self.assertRaisesRegex(ValueError, 'distinct'):
            self.ctx.call('sketch.build', dict(data, name='CenterDatum'))
        self.assertEqual(TRACE, before)

    def test_read_only_check_lists_points_and_reports_health(self):
        self.ctx.sketch.sketchPoints.values.append(Point(P(0, 0, 0), self.ctx.sketch))
        before = list(TRACE)
        result = self.ctx.call('sketch.check', {'sketch': 'Section'})
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(len(result['underconstrainedPoints']), 1)
        self.ctx.sketch.healthState = 2
        self.ctx.sketch.errorOrWarningMessage = 'solver error'
        self.assertEqual(self.ctx.call('sketch.check', {'sketch': 'Section'})['status'], 'fail')
        self.assertEqual(TRACE, before)

    def test_primary_solver_error_survives_secondary_readback_error(self):
        ref = self.add([ellipse()])['entities'][0]
        original = NS['_sketch_state']
        calls = []
        def state(ctx, sketch):
            calls.append(True)
            if len(calls) > 1:
                raise RuntimeError('readback error')
            return original(ctx, sketch)
        def failed_move(*args):
            raise RuntimeError('primary solver error')
        self.ctx.sketch.move = failed_move
        with patch.dict(NS, {'_sketch_state': state}):
            result = self.ctx.call('sketch.transform', {'sketch': 'Section', 'entities': [ref], 'frame': 'sketch', 'translate': ['1 mm', '0 mm', '0 mm']})
        self.assertEqual(result['conflicts'], ['primary solver error', 'Readback failed: readback error'])
        self.assertEqual(result['after']['status'], 'unknown')
        self.assertEqual(result['status'], 'fail')

    def test_ellipse_axis_is_unoriented_geometry_for_transform_readback(self):
        ref = self.add([ellipse()])['entities'][0]
        oval = self.ctx.resolve(ref)
        original = self.ctx.sketch.move
        def canonicalized_move(entities, matrix):
            original(entities, matrix)
            axis = oval.majorAxis
            oval.majorAxis = P(-axis.x, -axis.y, -axis.z)
            return True
        self.ctx.sketch.move = canonicalized_move
        result = self.ctx.call('sketch.transform', {'sketch': 'Section', 'entities': [ref], 'frame': 'sketch', 'rotate': {'angle': '90 deg'}})
        self.assertEqual(result['status'], 'pass')
        self.assertAlmostEqual(oval.centerSketchPoint.geometry.y, -1)

    def test_recognition_time_budget_is_read_only(self):
        self.add([ellipse()])
        before = list(TRACE), list(self.ctx.created)
        ticks = iter([0, 2])
        with patch.dict(NS, {'time': types.SimpleNamespace(monotonic=lambda: next(ticks))}):
            with self.assertRaisesRegex(ValueError, 'maxSeconds'):
                self.ctx.call('sketch.dimension-plan', {'sketch': 'Section', 'maxSeconds': 1})
        self.assertEqual((TRACE, self.ctx.created), before)


if __name__ == '__main__':
    unittest.main()
