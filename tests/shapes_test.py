"""Recipe tests execute real model/sketch handlers against existing model mocks."""
import json
import math
from pathlib import Path
import re
import types
import unittest
from unittest.mock import patch

import model_test as model


ROOT = Path(__file__).resolve().parents[1]
NAMESPACE = dict(model.namespace)
NAMESPACE['CAD_HANDLERS'] = dict(model.HANDLERS)
exec(compile((ROOT / 'assets/cad/shapes.py').read_text(), 'shapes.py', 'exec'), NAMESPACE)


class RecipeSketch(model.Sketch):
    def addCenterToCenterSlot(self, start, end, width, create_width_dimension):
        self.slotArgs = (start, end, width, create_width_dimension)
        assert isinstance(start, (model.SketchPoint, model.Point))
        assert isinstance(end, (model.SketchPoint, model.Point))
        assert width[0] == 'expression'
        # Model copied seed geometry, not an implicit associative point/parameter link.
        a, b = [p.geometry if isinstance(p, model.SketchPoint) else p for p in (start, end)]
        a, b = [model.Point(p.x, p.y, p.z) for p in (a, b)]
        dx, dy = b.x - a.x, b.y - a.y
        distance = math.hypot(dx, dy)
        radius = self.ctx.length(width[1]) / 2
        nx, ny = -dy / distance * radius, dx / distance * radius
        p = lambda x, y: model.Point(x, y, a.z)
        curves = [model.SketchArc(a, p(a.x + nx, a.y + ny), p(a.x - nx, a.y - ny), self),
                  model.SketchArc(b, p(b.x - nx, b.y - ny), p(b.x + nx, b.y + ny), self),
                  model.SketchLine(p(a.x + nx, a.y + ny), p(b.x + nx, b.y + ny), self),
                  model.SketchLine(p(b.x - nx, b.y - ny), p(a.x - nx, a.y - ny), self),
                  model.SketchLine(a, b, self)]
        curves[-1].isConstruction = True
        self.sketchCurves.values.extend(curves)
        model.TRACE.append(('nativeSlot',))
        if create_width_dimension:
            dimension = self.sketchDimensions.dimension('slotWidth', True)
            dimension.parameter.expression = str(radius * 2) + ' cm'
            return curves + [dimension]
        return curves


class RecipeDimensions(model.Dimensions):
    def addRadialDimension(self, curve, text, driving):
        dimension = super().addRadialDimension(curve, text, driving)
        dimension.entity = curve
        return dimension


model.adsk.fusion.Sketch = RecipeSketch
model.adsk.fusion.DesignTypes = types.SimpleNamespace(ParametricDesignType=1)


class Context(model.Context):
    def __init__(self, attach_bodies=False):
        super().__init__()
        self.attach_bodies = attach_bodies
        self.calls = []
        self.component.sketches = model.Collection()
        self.component.sketches.addWithoutEdges = self.add_sketch
        self.component.constructionPlanes = model.Collection()
        self.component.constructionPoints = model.Collection()
        self.component.constructionAxes = model.Collection()
        self.component.bRepBodies = model.Collection()
        self.feature_rows = []
        self.component.features.count = 0
        self.component.features.item = lambda i: self.feature_rows[i]
        self.unavailable_profile_tokens = False
        self.design = types.SimpleNamespace(designType=1, findEntityByToken=lambda token: [
            e for key, e in self.entities.items() if key == token and not (
                self.unavailable_profile_tokens and e.objectType.endswith('::Profile'))])
        self.parameters = {'wall': .3, 'pitch': 4., 'hole_d': .4, 'slot_length': 3.,
                           'slot_width': .6, 'px': -.5, 'py': .7, 'pz': .2,
                           'phase': math.pi / 6, 'tilt': math.pi / 4, 'count': 4}
        for entity in self.entities.values():
            if not hasattr(entity, 'parentSketch'):
                entity.parentComponent = self.component
        self.entities['seed'] = model.Entity('ExtrudeFeature')
        self.entities['seed'].parentComponent = self.component
        self.entities['seed'].bodies = model.Collection()

    def add_sketch(self, plane, *args):
        sketch = RecipeSketch(self.component)
        sketch.ctx = self
        sketch.sketchDimensions = RecipeDimensions()
        sketch.originPoint = model.SketchPoint(model.Point(0, 0, 0), sketch)
        self.component.sketches.values.append(sketch)
        return sketch

    def ref(self, entity):
        ref = super().ref(entity)
        if entity.objectType.endswith('Profile'):
            ref.update(kind='profile', sketch=super().ref(entity.parentSketch))
        return ref

    def resolve(self, ref, kind=None):
        if isinstance(ref, dict) and ref.get('kind') == 'profile':
            return NAMESPACE['CadContext'].resolve(self, ref, kind)
        if isinstance(ref, dict) and ref.get('token') in self.entities:
            return self.entities[ref['token']]
        return super().resolve(ref, kind)

    def length(self, expression):
        return self.evaluate(expression)

    def angle(self, expression):
        return self.evaluate(expression)

    def expression(self, expression, units=None, unitless=False):
        return self._expression(expression, units, unitless)

    def point(self, values):
        if not isinstance(values, (list, tuple)) or len(values) != 3:
            raise ValueError('Point requires three length expressions')
        return model.Point(*(self.length(v) for v in values))

    def evaluate(self, expression):
        self.value(expression)
        # Test-only arithmetic evaluator; real unit/expression validation belongs to core.
        expanded = re.sub(r'(\d+(?:\.\d+)?)\s*(mm|cm|deg|rad)\b',
            lambda m: '(' + m[1] + '*' + str({'mm': .1, 'cm': 1, 'deg': math.pi / 180, 'rad': 1}[m[2]]) + ')', expression)
        return float(eval(expanded, {'__builtins__': {}}, dict(self.parameters, sin=math.sin, cos=math.cos)))

    def _expression(self, expression, units, unitless=False):
        if expression == 'count' and unitless:
            return expression, 4
        if not isinstance(expression, str):
            raise ValueError('expression string required')
        return expression, float(expression)

    def call(self, op, data):
        self.calls.append((op, data))
        if op == 'datum.point':
            point = model.Entity('ConstructionPoint', name=data['name'])
            point.parentComponent = self.component
            point.geometry = self.point(data['point'])
            point.coordinateExpressions = tuple(data['point'])
            self.component.constructionPoints.values.append(point)
            helpers = []
            for axis in ('x', 'y', 'z'):
                plane = model.Entity('ConstructionPlane', name=data['name'] + '__' + axis)
                plane.parentComponent = self.component
                self.component.constructionPlanes.values.append(plane)
                helpers.append(self.ref(plane))
            return dict(self.ref(point), helpers=helpers,
                        representation='intersection of three expression-driven offset planes')
        if op == 'sketch.project':
            self.assert_linked = data['linked']
            sketch = self.resolve(data['sketch'])
            projected = []
            for ref in data['entities']:
                source = self.resolve(ref)
                point = sketch.sketchPoints.add(model.Point(source.geometry.x, source.geometry.y, 0))
                point.source = source
                projected.append(point)
            return {'entities': [self.ref(p) for p in projected], 'refs': {}}
        if op == 'datum.plane':
            plane = model.Entity('ConstructionPlane', name=data['name'])
            plane.parentComponent = self.component
            self.component.constructionPlanes.values.append(plane)
            return self.ref(plane)
        result = NAMESPACE['CAD_HANDLERS'][op](self, data)
        if op == 'sketch.geometry':
            sketch = self.resolve(data['sketch'])
            circles = [e for e in sketch.sketchCurves.values if isinstance(e, model.SketchCircle)]
            if len(circles) == 2:
                annulus = model.Entity('Profile', sketch)
                annulus.profileLoops = model.Collection([object(), object()])
                sketch.profiles.values.append(annulus)
            for item in data['geometry']:
                if item['type'] == 'spline':
                    spline = self.resolve(result['refs'][item['name']])
                    spline.fitPoints = model.Collection([model.SketchPoint(self.point(p), sketch) for p in item['points']])
        if 'feature' in result:
            feature = self.resolve(result['feature'])
            feature.parentComponent = self.component
            if feature not in self.feature_rows:
                self.feature_rows.append(feature)
                self.component.features.count = len(self.feature_rows)
            if self.attach_bodies and op in ('model.extrude', 'model.revolve', 'model.loft', 'model.sweep'):
                self._attach_body(feature)
                result['bodies'] = [self.ref(body) for body in feature.bodies.values]
        return result

    def _attach_body(self, feature):
        axis = model.Point(0, 1, 0)
        height = 5.0
        body = model.Entity('BRepBody', name=feature.name + '__body')
        body.parentComponent = self.component
        top = model.Entity('BRepFace', name=feature.name + '__top')
        top.centroid = model.Point(*(axis.x * height, axis.y * height, axis.z * height))
        bottom = model.Entity('BRepFace', name=feature.name + '__bottom')
        bottom.centroid = model.Point(0, 0, 0)
        side = model.Entity('BRepFace', name=feature.name + '__side')
        side.centroid = model.Point(0, 0, 0)
        body.faces = model.Collection([top, bottom, side])
        edge_top = model.Entity('BRepEdge', name=feature.name + '__topEdge')
        edge_top.geometry = type('Circle', (), {'center': top.centroid, 'radius': 1.0})
        edge_bottom = model.Entity('BRepEdge', name=feature.name + '__bottomEdge')
        edge_bottom.geometry = type('Circle', (), {'center': bottom.centroid, 'radius': 1.0})
        body.edges = model.Collection([edge_bottom, edge_top])
        feature.bodies = model.Collection([body])


class ShapesTests(unittest.TestCase):
    def setUp(self):
        self.ctx = Context()
        model.TRACE.clear()

    def test_catalog_matches_registered_shapes_and_compiles(self):
        catalog = json.loads((ROOT / 'src/catalog/shapes.json').read_text())
        catalog.update(json.loads((ROOT / 'src/catalog/shapes-library.json').read_text()))
        self.assertEqual(set(catalog), {op for op in NAMESPACE['CAD_HANDLERS'] if op.startswith('shape.')})
        for entry in catalog.values():
            self.assertEqual(set(entry), {'summary', 'required', 'example', 'readOnly', 'limitations', 'inputs'})
            self.assertTrue(set(entry['required']) <= entry['example'].keys())
            self.assertTrue(entry['limitations'])
        compile((ROOT / 'assets/cad/shapes.py').read_text(), 'shapes.py', 'exec')

    def test_new_catalog_examples_dispatch_and_modes_have_no_conflicting_required_fields(self):
        catalog = json.loads((ROOT / 'src/catalog/shapes.json').read_text())
        shared = {'shape.bolt_circle': ['quantity'], 'shape.slot': ['thickness'],
                  'shape.revolved_profile': ['axis'], 'shape.route': ['profile']}
        for op, required in shared.items():
            self.assertEqual(catalog[op]['required'], required)
            self.assertTrue(set(catalog[op]['example']) <= catalog[op]['inputs'].keys())
            ctx = Context()
            ctx.entities['DuctSection'] = ctx.sketch
            self.assertIn('feature', ctx.call(op, catalog[op]['example']))

    def test_bundle_compiles_in_contract_order(self):
        folder = ROOT / 'assets/cad'
        sources = [folder / 'core.py'] + sorted(p for p in folder.glob('*.py') if p.name != 'core.py')
        compile('\n\n'.join(p.read_text() for p in sources), 'bundle.py', 'exec')

    def test_box_preserves_expressions(self):
        result = self.ctx.call('shape.box', {'name': 'Box', 'width': 'wall', 'depth': '20 mm', 'height': '10 mm'})
        self.assertEqual(result['recipe'], 'box')
        self.assertIn('feature', result)
        dimensions = self.ctx.component.sketches.item(0).sketchDimensions.values
        self.assertEqual([d.parameter.expression for d in dimensions], ['wall', '20 mm'])
        self.assertTrue(all(not c.isFixed for c in self.ctx.component.sketches.item(0).sketchCurves.values))
        extrusion = [d for op, d in self.ctx.calls if op == 'model.extrude'][0]
        self.assertEqual(extrusion['distance'], '10 mm')

    def test_cylinder_and_annulus_profiles(self):
        for mode in ('cylinder', 'tube', 'ring'):
            ctx = Context()
            data = {'name': mode, 'height': '10 mm'}
            data.update({'radius': 'wall'} if mode == 'cylinder' else {'outerRadius': '20 mm', 'innerRadius': 'wall'})
            result = ctx.call('shape.' + mode, data)
            payload = [d for op, d in ctx.calls if op == 'model.extrude'][0]
            self.assertEqual(ctx.resolve(payload['profile']).profileLoops.count, 1 if mode == 'cylinder' else 2)
            dims = ctx.component.sketches.item(0).sketchDimensions.values
            self.assertIn('wall', [d.parameter.expression for d in dims])
            self.assertIn('bodies', result)

    def test_cone_offset_expression_and_loft(self):
        result = self.ctx.call('shape.cone', {'name': 'Cone', 'baseRadius': '20 mm', 'topRadius': '10 mm', 'height': 'wall'})
        self.assertEqual(len(result['helpers']), 3)
        self.assertEqual([d['offset'] for op, d in self.ctx.calls if op == 'datum.plane'], ['wall'])
        self.assertEqual(len([d for op, d in self.ctx.calls if op == 'model.loft'][0]['profiles']), 2)

    def test_primitive_profiles_do_not_require_tokens(self):
        cases = {'box': {'width': '20 mm', 'depth': '10 mm'},
                 'cylinder': {'radius': '10 mm'},
                 'tube': {'outerRadius': '10 mm', 'innerRadius': '6 mm'},
                 'ring': {'outerRadius': '10 mm', 'innerRadius': '6 mm'},
                 'cone': {'baseRadius': '10 mm', 'topRadius': '5 mm'}}
        for mode, sizes in cases.items():
            with self.subTest(mode=mode):
                ctx = Context()
                ctx.unavailable_profile_tokens = True
                result = ctx.call('shape.' + mode, dict(sizes, name=mode, height='20 mm'))
                self.assertIn('feature', result)
                payload = next(d for op, d in ctx.calls if op in ('model.extrude', 'model.loft'))
                profiles = payload['profiles'] if mode == 'cone' else [payload['profile']]
                for selector in profiles:
                    self.assertNotIn('token', selector)
                    self.assertNotIn('index', selector)
                    self.assertEqual(selector['loopCount'], 2 if mode in ('tube', 'ring') else 1)
                    profile = ctx.resolve(selector)
                    self.assertEqual(ctx.design.findEntityByToken(profile.entityToken), [])
                    sketch = ctx.resolve(selector['sketch'])
                    sketch.profiles.values.reverse()
                    self.assertIs(ctx.resolve(selector), profile)
                    with self.assertRaisesRegex(ValueError, 'Entity token: expected one match, found 0'):
                        ctx.resolve(ctx.ref(profile))

    def test_annulus_topology_must_remain_unique_before_extrude(self):
        for loop_counts, count in (([1], 0), ([1, 2, 2], 2)):
            with self.subTest(loop_counts=loop_counts):
                ctx = Context()
                original = ctx.call

                def call(op, data):
                    if op == 'model.extrude':
                        sketch = ctx.resolve(data['profile']['sketch'])
                        sketch.profiles.values = []
                        for loops in loop_counts:
                            profile = model.Entity('Profile', sketch)
                            profile.profileLoops = model.Collection([object() for unused in range(loops)])
                            sketch.profiles.values.append(profile)
                    return original(op, data)

                ctx.call = call
                model.TRACE.clear()
                with self.assertRaisesRegex(ValueError, 'loopCount 2: expected one match, found %d' % count):
                    ctx.call('shape.tube', {'name': 'Tube', 'outerRadius': '10 mm',
                                          'innerRadius': '6 mm', 'height': '20 mm'})
                self.assertFalse(any(row[:2] == ('input', 'extrude') for row in model.TRACE))

    def test_primitive_invalid_before_sketch_creation(self):
        cases = [('box', {'width': '0 mm', 'depth': '5 mm', 'height': '5 mm'}),
                 ('cylinder', {'radius': 5, 'height': '5 mm'}),
                 ('tube', {'outerRadius': '5 mm', 'innerRadius': '6 mm', 'height': '5 mm'}),
                 ('cone', {'baseRadius': '5 mm', 'topRadius': '0 mm', 'height': '5 mm'})]
        for mode, data in cases:
            result = self.ctx.call('shape.' + mode, dict(data, name='Bad'))
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['error']['code'], 'INVALID_INPUT')
            self.assertTrue(result['error']['message'])
            self.assertEqual(result['rejection'], {
                'kind': 'cad-input-rejection', 'version': 1,
                'operation': 'shape.' + mode, 'mutationStatus': 'not_started'})
        self.assertEqual(self.ctx.component.sketches.count, 0)
        self.assertEqual(model.TRACE, [])

    def test_primitive_native_failure_is_not_input_rejection(self):
        def failed_section(*args):
            model.TRACE.append(('partial-native-mutation',))
            raise ValueError('Native section failed after mutation')

        with patch.dict(NAMESPACE, {'_shapes_section': failed_section}):
            with self.assertRaisesRegex(ValueError, 'after mutation'):
                self.ctx.call('shape.box', {'name': 'Box', 'width': '5 mm',
                                           'depth': '5 mm', 'height': '5 mm'})
        self.assertEqual(model.TRACE, [('partial-native-mutation',)])

    def test_name_collision_and_proxy_rejected(self):
        self.ctx.component.sketches.values.append(types.SimpleNamespace(name='Part__section'))
        with self.assertRaises(ValueError):
            self.ctx.call('shape.cylinder', {'name': 'Part', 'radius': '5 mm', 'height': '5 mm'})
        self.ctx.entities['XY'].assemblyContext = object()
        with self.assertRaises(ValueError):
            self.ctx.call('shape.cylinder', {'name': 'Other', 'radius': '5 mm', 'height': '5 mm'})
        self.assertEqual(model.TRACE, [])

    def test_profile_recipes(self):
        profile = {'kind': 'profile', 'sketch': 'Section', 'index': 0}
        for mode in ('slot', 'rib', 'web'):
            result = self.ctx.call('shape.' + mode, {'profile': profile, 'thickness': 'wall'})
            self.assertIn('feature', result)
            payload = [d for op, d in self.ctx.calls if op == 'model.extrude'][-1]
            self.assertEqual(payload['distance'], 'wall')
            self.assertEqual(payload['operation'], 'cut' if mode == 'slot' else 'join')
        result = self.ctx.call('shape.revolved_profile', {'profile': profile, 'axis': 'Z'})
        self.assertIn('feature', result)

    def test_pattern_recipes_preserve_counts(self):
        for mode, extras in (('bolt_circle', {'axis': 'Z'}), ('slot_pattern', {'direction': 'X', 'distance': 'wall'})):
            result = self.ctx.call('shape.' + mode, dict(extras, entities=['seed'], quantity='count'))
            self.assertIn('feature', result)
            payload = [d for op, d in self.ctx.calls if op.startswith('pattern.')][-1]
            self.assertEqual(payload['quantity'], 'count')

    def test_invalid_patterns_are_nonmutating(self):
        for quantity in (True, 1, '2.5', ''):
            with self.assertRaises(ValueError):
                self.ctx.call('shape.bolt_circle', {'entities': ['seed'], 'axis': 'Z', 'quantity': quantity})
        self.assertEqual(model.TRACE, [])

    def test_routes_use_real_sweep(self):
        profile = {'kind': 'profile', 'sketch': 'Section', 'index': 0}
        for mode in ('route', 'helix'):
            result = self.ctx.call('shape.' + mode, {'profile': profile, 'path': {'curves': ['line-token']}, 'twist': '30 deg'})
            self.assertIn('feature', result)
        self.assertEqual(len([op for op, data in self.ctx.calls if op == 'model.sweep']), 2)

    def test_generated_bolt_circle_links_pitch_phase_and_native_hole_pattern(self):
        result = self.ctx.call('shape.bolt_circle', {'name': 'Bolts', 'pitchDiameter': 'pitch',
            'phase': 'phase', 'quantity': 'count', 'diameter': 'hole_d', 'depth': 'wall'})
        datum = [d for op, d in self.ctx.calls if op == 'datum.point'][0]
        self.assertEqual(datum['point'], ['(pitch) / 2 * cos(phase)', '(pitch) / 2 * sin(phase)', '0 mm'])
        self.assertTrue(self.ctx.assert_linked)
        hole = [d for op, d in self.ctx.calls if op == 'model.hole'][0]
        self.assertEqual((hole['diameter'], hole['depth']), ('hole_d', 'wall'))
        pattern = [d for op, d in self.ctx.calls if op == 'pattern.circular'][0]
        self.assertEqual(pattern['entities'], [result['seed']['feature']])
        self.assertEqual((pattern['axis'], pattern['quantity']), ('Z', 'count'))
        self.assertFalse(result['atomic'])
        self.assertIn('helpers', result)

    def test_generated_slot_is_native_stadium_with_expression_driven_position(self):
        result = self.ctx.call('shape.slot', {'name': 'Slot', 'length': 'slot_length', 'width': 'slot_width',
            'position': ['px', 'py', 'pz'], 'angle': 'tilt', 'thickness': 'wall'})
        sketch = self.ctx.component.sketches.item(0)
        start, end, width, dimensioned = sketch.slotArgs
        self.assertEqual(width, ('expression', 'slot_width'))
        self.assertFalse(dimensioned)
        self.assertIsInstance(start, model.Point)
        self.assertIsInstance(end, model.Point)
        self.assertEqual(len(sketch.sketchCurves.values), 5)
        self.assertEqual(sum(c.isConstruction for c in sketch.sketchCurves.values), 1)
        self.assertEqual(sum(isinstance(c, model.SketchArc) for c in sketch.sketchCurves.values), 2)
        a, b = start, end
        self.assertAlmostEqual((a.x + b.x) / 2, self.ctx.parameters['px'])
        self.assertAlmostEqual((a.y + b.y) / 2, self.ctx.parameters['py'])
        self.assertAlmostEqual(math.hypot(b.x - a.x, b.y - a.y), self.ctx.parameters['slot_length'] - self.ctx.parameters['slot_width'])
        self.assertEqual([d['offset'] for op, d in self.ctx.calls if op == 'datum.plane'], ['pz'])
        coordinates = [d['point'] for op, d in self.ctx.calls if op == 'datum.point']
        for coords in coordinates:
            self.assertIn('slot_length', coords[0])
            self.assertIn('slot_width', coords[0])
            self.assertIn('tilt', coords[1])
            self.assertEqual(coords[2], 'pz')
        self.assertIn('slotGeometry', result)
        self.assertEqual(sketch.sketchDimensions.values[0].parameter.expression, '(slot_width) / 2')

    def test_slot_explicit_dependency_graph_survives_input_edits_without_rebuilding(self):
        # Contract test, not a sketch solver: evaluate only the expressions reached
        # through actual constraint subjects and the actual radial dimension entity.
        ctx = self.ctx
        ctx.parameters.update(px=1., py=-.5, pz=.2, tilt=0., wall=.3)
        result = ctx.call('shape.slot', {'name': 'Slot', 'length': 'slot_length', 'width': 'slot_width',
            'position': ['px', 'py', 'pz'], 'angle': 'tilt', 'thickness': 'wall',
            'operation': 'newBody', 'symmetric': True})
        sketch = ctx.component.sketches.item(0)
        arcs = [c for c in sketch.sketchCurves.values if isinstance(c, model.SketchArc)]
        links = [row[1:] for row in model.TRACE if row[0] == 'addCoincident']
        self.assertEqual(len(links), 2)
        self.assertEqual([subject for subject, target in links], [a.centerSketchPoint for a in arcs])
        self.assertEqual([target for subject, target in links], sketch.sketchPoints.values)
        for subject, target in links:
            self.assertIsNot(subject, target)
            self.assertIsNot(subject.geometry, target.geometry)
        self.assertTrue(ctx.assert_linked)
        self.assertEqual(sketch.sketchDimensions.count, 1)
        radius = sketch.sketchDimensions.item(0)
        self.assertIs(radius.entity, arcs[0])
        self.assertTrue(radius.isDriving)
        self.assertEqual(radius.parameter.expression, '(slot_width) / 2')
        self.assertIn(ctx.ref(radius), result['slotGeometry'])
        extrusion = next(d for op, d in ctx.calls if op == 'model.extrude')
        offset = next(d['offset'] for op, d in ctx.calls if op == 'datum.plane')
        self.assertEqual((extrusion['distance'], offset, extrusion['symmetric']), ('wall', 'pz', True))
        counts = (ctx.component.sketches.count, ctx.component.constructionPoints.count,
                  ctx.component.constructionPlanes.count, ctx.component.features.count,
                  sketch.sketchCurves.count, sketch.profiles.count)
        self.assertEqual(counts, (1, 2, 7, 1, 5, 1))
        before = list(model.TRACE)
        for changes, volume, minimum, size in (
            ({}, (24 * 6 + math.pi * 9) * 3, [-5, -8, .5], [30, 6, 3]),
            ({'slot_length': 4., 'slot_width': .8, 'wall': .4,
              'px': -.7, 'py': .9, 'pz': -.3, 'tilt': math.pi / 2},
             (32 * 8 + math.pi * 16) * 4, [-11, -11, -5], [8, 40, 4]),
            ({'tilt': -math.pi, 'px': 0., 'py': 0., 'pz': 0.},
             (32 * 8 + math.pi * 16) * 4, [-20, -4, -2], [40, 8, 4])):
            with self.subTest(changes=changes):
                ctx.parameters.update(changes)
                a, b = [ctx.point(target.source.coordinateExpressions) for subject, target in links]
                r = ctx.length(radius.parameter.expression)
                h, z = ctx.length(extrusion['distance']), ctx.length(offset)
                span = math.hypot(b.x - a.x, b.y - a.y)
                self.assertAlmostEqual((span * 2 * r + math.pi * r * r) * h * 1000, volume)
                actual_min = [min(a.x, b.x) - r, min(a.y, b.y) - r, z - h / 2]
                actual_size = [abs(b.x - a.x) + 2 * r, abs(b.y - a.y) + 2 * r, h]
                for actual, expected in zip(actual_min + actual_size, minimum + size):
                    self.assertAlmostEqual(actual * 10, expected)
                self.assertEqual((ctx.component.sketches.count, ctx.component.constructionPoints.count,
                    ctx.component.constructionPlanes.count, ctx.component.features.count,
                    sketch.sketchCurves.count, sketch.profiles.count), counts)
        self.assertEqual(model.TRACE, before)
        self.assertFalse(any(c.isFixed for c in sketch.sketchCurves.values))
        check = ctx.call('sketch.check', {'sketch': ctx.ref(sketch)})
        self.assertEqual((check['profileCount'], check['healthState'], check['message']), (1, 0, ''))
        self.assertEqual((result['healthState'], result['message']), (0, ''))

    def test_slot_radial_dimension_failure_prevents_extrusion(self):
        with patch.object(RecipeDimensions, 'addRadialDimension', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'addRadialDimension'):
                self.ctx.call('shape.slot', {'name': 'S', 'length': 'slot_length',
                    'width': 'slot_width', 'thickness': 'wall'})
        self.assertFalse(any(op == 'model.extrude' for op, data in self.ctx.calls))

    def test_slot_unhealthy_extrusion_is_not_reported_as_success(self):
        self.ctx.component.features.extrudeFeatures.unhealthy = True
        with self.assertRaisesRegex(RuntimeError, 'Kernel rejected shape'):
            self.ctx.call('shape.slot', {'name': 'S', 'length': 'slot_length',
                'width': 'slot_width', 'thickness': 'wall'})

    def test_slot_signed_coordinate_equations_and_zero_angles(self):
        for angle in ('0 deg', '90 deg', '180 deg', '-90 deg'):
            ctx = Context()
            ctx.call('shape.slot', {'name': 'S', 'length': '30 mm', 'width': '6 mm',
                'position': ['0 mm', '-10 mm', '0 mm'], 'angle': angle, 'thickness': '2 mm'})
            coords = [d['point'] for op, d in ctx.calls if op == 'datum.point']
            start, end = [ctx.point(c) for c in coords]
            self.assertAlmostEqual(math.hypot(end.x - start.x, end.y - start.y), 2.4)
            self.assertAlmostEqual((start.y + end.y) / 2, -1)

    def test_generated_mode_collisions_are_noops_in_every_named_collection(self):
        data = {'name': 'Slot', 'length': '30 mm', 'width': '6 mm', 'thickness': '2 mm'}
        for prop, collision in (('sketches', 'Slot__section'), ('constructionPlanes', 'Slot__end__y'),
                                ('constructionPoints', 'Slot__start'), ('bRepBodies', 'Slot')):
            ctx = Context()
            getattr(ctx.component, prop).values.append(types.SimpleNamespace(name=collision))
            model.TRACE.clear()
            with self.assertRaisesRegex(ValueError, 'Reserved shape name'):
                ctx.call('shape.slot', data)
            self.assertEqual(model.TRACE, [])
            self.assertEqual(ctx.created, [])
        self.ctx.feature_rows.append(types.SimpleNamespace(name='Slot'))
        self.ctx.component.features.count = 1
        with self.assertRaisesRegex(ValueError, 'Reserved shape name'):
            self.ctx.call('shape.slot', data)

    def test_repeat_generated_recipe_rejects_before_further_changes(self):
        data = {'name': 'Bolts', 'pitchDiameter': '40 mm', 'diameter': '4 mm', 'depth': '2 mm', 'quantity': 4}
        self.ctx.call('shape.bolt_circle', data)
        before = list(model.TRACE)
        with self.assertRaisesRegex(ValueError, 'Reserved shape name'):
            self.ctx.call('shape.bolt_circle', data)
        self.assertEqual(model.TRACE, before)

    def test_generated_invalid_inputs_rejected_before_any_helper(self):
        bolt = {'name': 'B', 'pitchDiameter': '40 mm', 'diameter': '4 mm', 'depth': '2 mm', 'quantity': 4}
        slot = {'name': 'S', 'length': '30 mm', 'width': '6 mm', 'thickness': '2 mm'}
        for op, data in [('bolt_circle', dict(bolt, quantity='2.5')), ('bolt_circle', dict(bolt, depth='0 mm')),
                         ('bolt_circle', dict(bolt, participants=[])), ('slot', dict(slot, width='30 mm')),
                         ('slot', dict(slot, position=['0 mm'])), ('slot', dict(slot, symmetric='yes')),
                         ('slot', dict(slot, operation='fake'))]:
            with self.assertRaises(ValueError):
                self.ctx.call('shape.' + op, data)
        self.assertEqual(model.TRACE, [])
        self.assertEqual(self.ctx.created, [])

    def test_slot_api_missing_and_empty_result_are_explicit_failures(self):
        data = {'name': 'S', 'length': '30 mm', 'width': '6 mm', 'thickness': '2 mm'}
        with patch.object(model.adsk.fusion, 'Sketch', model.Sketch):
            with self.assertRaisesRegex(ValueError, 'addCenterToCenterSlot'):
                self.ctx.call('shape.slot', data)
        self.assertEqual(model.TRACE, [])
        with patch.object(RecipeSketch, 'addCenterToCenterSlot', return_value=[]):
            with self.assertRaisesRegex(RuntimeError, 'Slot creation returned no geometry'):
                self.ctx.call('shape.slot', data)
        self.assertFalse(any(op == 'model.extrude' for op, d in self.ctx.calls))
        ctx = Context()
        with patch.object(RecipeSketch, 'addCenterToCenterSlot', return_value=[ctx.resolve('line-token')]):
            with self.assertRaisesRegex(RuntimeError, 'ordered cap arcs'):
                ctx.call('shape.slot', data)
        self.assertFalse(any(op == 'model.extrude' for op, d in ctx.calls))

    def profile_data(self):
        return {'plane': 'XY', 'geometry': [
            {'name': 'cap', 'type': 'arc', 'center': ['0 mm', '0 mm', '0 mm'],
             'start': ['wall', '0 mm', '0 mm'], 'sweep': '180 deg'},
            {'name': 'base', 'type': 'line', 'start': ['-wall', '0 mm', '0 mm'],
             'end': ['wall', '0 mm', '0 mm']}],
            'constraints': [{'type': 'coincident', 'entities': ['cap.center', 'origin']},
                            {'type': 'coincident', 'entities': ['base.start', 'cap.end']},
                            {'type': 'coincident', 'entities': ['base.end', 'cap.start']},
                            {'type': 'horizontal', 'entities': ['base']}],
            'dimensions': [{'type': 'radius', 'entities': ['cap'], 'expression': 'wall'}]}

    def test_revolved_profile_data_creates_geometry_and_driving_dimensions(self):
        result = self.ctx.call('shape.revolved_profile', {'name': 'Turned', 'axis': 'X', 'profileData': self.profile_data()})
        sketch = self.ctx.component.sketches.item(0)
        self.assertEqual([d.parameter.expression for d in sketch.sketchDimensions.values], ['wall'])
        self.assertEqual(set(result['refs']), {'cap', 'base', 'origin'})
        self.assertIn('raw geometry/waypoint expressions are initial values', result['dependencies'])
        self.assertFalse(result['isFullyConstrained'])
        self.assertTrue(any(op == 'model.revolve' for op, d in self.ctx.calls))

    def test_profile_data_prevalidates_all_solver_lists_and_names(self):
        for change in ({'dimensions': [{'type': 'radius', 'entities': ['unknown'], 'expression': 'wall'}]},
                       {'dimensions': [{'type': 'distance', 'entities': ['cap', 'base'], 'expression': 'wall'}]},
                       {'constraints': [{'type': 'horizontal', 'entities': ['cap']}]},
                       {'profileIndex': -1}, {'dimensions': 'wrong'}):
            with self.assertRaises(ValueError):
                self.ctx.call('shape.revolved_profile', {'name': 'R', 'axis': 'X', 'profileData': dict(self.profile_data(), **change)})
        self.assertEqual(model.TRACE, [])

    def test_route_waypoints_lines_and_arcs_with_constraints_dimensions(self):
        result = self.ctx.call('shape.route', {'name': 'Route',
            'profile': {'kind': 'profile', 'sketch': 'Section', 'index': 0},
            'waypoints': [['0 mm', '0 mm', '0 mm'], ['10 mm', '0 mm', '0 mm'], ['20 mm', '10 mm', '0 mm']],
            'segments': [{'type': 'line'}, {'type': 'arc', 'through': ['20 mm', '0 mm', '0 mm']}],
            'constraints': [{'type': 'coincident', 'entities': ['route0.start', 'origin']},
                            {'type': 'horizontal', 'entities': ['route0']}],
            'dimensions': [{'type': 'distance', 'entities': ['route0.start', 'route0.end'], 'expression': 'wall'},
                           {'type': 'radius', 'entities': ['route1'], 'expression': 'slot_width'}]})
        geometry = [d['geometry'] for op, d in self.ctx.calls if op == 'sketch.geometry'][0]
        self.assertEqual([g['type'] for g in geometry], ['line', 'arc3'])
        self.assertEqual(len(result['path']['curves']), 2)
        self.assertEqual(result['path']['chain'], 'none')
        self.assertEqual([d.parameter.expression for d in self.ctx.component.sketches.item(0).sketchDimensions.values], ['wall', 'slot_width'])
        self.assertTrue(any(op == 'model.sweep' for op, d in self.ctx.calls))

    def test_route_spline_fitpoint_dimensions(self):
        result = self.ctx.call('shape.route', {'name': 'SplineRoute',
            'profile': {'kind': 'profile', 'sketch': 'Section', 'index': 0}, 'interpolation': 'spline',
            'waypoints': [['0 mm', '0 mm', '0 mm'], ['10 mm', '5 mm', '0 mm'], ['20 mm', '0 mm', '0 mm']],
            'constraints': [{'type': 'coincident', 'entities': ['route0.fit0', 'origin']}],
            'dimensions': [{'type': 'distance', 'entities': ['origin', 'route0.fit1'], 'orientation': 'horizontal', 'expression': 'wall'}]})
        self.assertIn('route0.fit2', result['refs'])
        self.assertEqual(len(result['path']['curves']), 1)
        self.assertEqual(self.ctx.component.sketches.item(0).sketchDimensions.values[0].parameter.expression, 'wall')

    def test_route_invalid_waypoints_modes_and_selectors_before_creation(self):
        base = {'name': 'R', 'profile': {'kind': 'profile', 'sketch': 'Section', 'index': 0},
                'waypoints': [['0 mm', '0 mm', '0 mm'], ['10 mm', '0 mm', '0 mm']]}
        for changes in ({'segments': []}, {'interpolation': 'fake'},
                        {'segments': [{'type': 'arc', 'through': ['5 mm', '0 mm', '0 mm']}]},
                        {'waypoints': [['0 mm', '0 mm', '0 mm'], ['0 mm', '0 mm', '0 mm']]},
                        {'waypoints': [['0 mm', '0 mm', '0 mm'], ['10 mm', '0 mm', '1 mm']]},
                        {'dimensions': [{'type': 'distance', 'entities': ['route0.fit2', 'origin'], 'expression': 'wall'}]}):
            with self.assertRaises(ValueError):
                self.ctx.call('shape.route', dict(base, **changes))
        self.assertEqual(model.TRACE, [])

    def test_alternative_modes_cannot_be_combined(self):
        for op, data in [
            ('shape.revolved_profile', {'name': 'R', 'axis': 'X', 'profile': 'Section', 'profileData': self.profile_data()}),
            ('shape.slot', {'profile': 'Section', 'length': '30 mm', 'width': '6 mm', 'thickness': '2 mm'}),
            ('shape.bolt_circle', {'entities': ['seed'], 'axis': 'Z', 'quantity': 4, 'pitchDiameter': '40 mm'}),
            ('shape.route', {'name': 'R', 'profile': 'Section', 'path': {'curves': ['line-token']},
                             'waypoints': [['0 mm', '0 mm', '0 mm'], ['10 mm', '0 mm', '0 mm']]})]:
            with self.assertRaises(ValueError):
                self.ctx.call(op, data)
        self.assertEqual(model.TRACE, [])

    def test_helix_pitch_turns_mode_is_explicitly_unimplemented_and_nonmutating(self):
        with self.assertRaisesRegex(ValueError, 'createHelixWire.*temporary wire'):
            self.ctx.call('shape.helix', {'name': 'H', 'pitch': '5 mm', 'turns': 4, 'radius': '10 mm'})
        self.assertEqual(model.TRACE, [])
        self.assertEqual(self.ctx.created, [])


if __name__ == '__main__':
    unittest.main()
