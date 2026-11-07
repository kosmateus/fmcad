"""GM10 generic shape library recipe tests against the existing model/sketch mocks."""
import json
import math
import unittest

import shapes_test as shapes


class Gm10ShapesTests(unittest.TestCase):
    def setUp(self):
        self.ctx = shapes.Context()
        shapes.model.TRACE.clear()

    def test_catalog_and_manual_cover_all_gm10_shapes(self):
        catalog = json.loads((shapes.ROOT / 'src/catalog/shapes-library.json').read_text())
        manual = json.loads((shapes.ROOT / 'src/manual/shapes-library.json').read_text())
        self.assertEqual(set(catalog), set(manual))
        expected = {'shape.annular_segment', 'shape.arc_strip', 'shape.can', 'shape.impeller', 'shape.boss_pattern'}
        self.assertEqual(set(catalog), expected)
        for entry in catalog.values():
            self.assertEqual(set(entry) - {'envelope'}, {'summary', 'required', 'example', 'readOnly', 'limitations', 'inputs'})
            self.assertTrue(set(entry['required']) <= entry['example'].keys())
            self.assertTrue(entry['limitations'])
            self.assertTrue(set(entry['example']) <= entry['inputs'].keys())
        for operation, entry in manual.items():
            self.assertTrue(entry['sections'])
            self.assertTrue(any(s['title'].startswith('Return Contract') for s in entry['sections']))
            self.assertEqual(entry['audit']['gaps'], [])
            self.assertTrue(entry['audit']['sources'] and entry['audit']['verified'] and entry['audit']['tests'])
            for example in entry['examples']:
                self.assertTrue(example['label'] and example['requires'] and example['output'])

    def test_annular_segment_driving_radii_and_sector_closure(self):
        result = self.ctx.call('shape.annular_segment', {'name': 'Seg', 'innerRadius': '10 mm',
            'outerRadius': '20 mm', 'start': '0 deg', 'sweep': '120 deg', 'height': '5 mm'})
        self.assertEqual(result['recipe'], 'annular_segment')
        self.assertIn('feature', result)
        self.assertEqual(set(result['refs']), {'inner', 'outer', 'capStart', 'capEnd', 'origin'})
        self.assertEqual(result['diameters']['inner'], '10 mm')
        self.assertEqual(result['diameters']['sweep'], '120 deg')
        dimensions = self.ctx.component.sketches.item(0).sketchDimensions.values
        self.assertEqual([d.parameter.expression for d in dimensions], ['10 mm', '20 mm'])
        self.assertFalse(any(c.isFixed for c in self.ctx.component.sketches.item(0).sketchCurves.values))
        extrusion = [d for op, d in self.ctx.calls if op == 'model.extrude'][0]
        self.assertEqual(extrusion['distance'], '5 mm')

    def test_annular_segment_invalid_inputs_rejected_before_mutation(self):
        for change in ({'innerRadius': '20 mm'}, {'sweep': '400 deg'}, {'center': ['0 mm', '0 mm', '5 mm']},
                       {'participants': []}):
            with self.assertRaises(ValueError):
                self.ctx.call('shape.annular_segment', dict(
                    {'name': 'S', 'innerRadius': '10 mm', 'outerRadius': '20 mm', 'height': '5 mm'}, **change))
        self.assertEqual(shapes.model.TRACE, [])

    def test_annular_segment_frame_declares_aligned_plane(self):
        result = self.ctx.call('shape.annular_segment', {'name': 'Seg', 'innerRadius': '10 mm',
            'outerRadius': '20 mm', 'height': '5 mm', 'frame': {'datum': 'Tilted'}})
        plane = [d for op, d in self.ctx.calls if op == 'datum.plane'][0]
        self.assertEqual(plane['mode'], 'frame')
        self.assertEqual(plane['frame'], {'datum': 'Tilted'})
        self.assertEqual(plane['associativity'], 'snapshot')
        self.assertIn('helpers', result)

    def test_arc_strip_centerline_arc_and_off_origin_center(self):
        result = self.ctx.call('shape.arc_strip', {'name': 'Blade', 'centerline': {'radius': '30 mm', 'start': '10 deg', 'sweep': '80 deg'},
            'center': ['5 mm', '-2 mm', '0 mm'], 'thickness': '2 mm', 'height': '20 mm'})
        self.assertEqual(result['recipe'], 'arc_strip')
        self.assertIn('5 mm', result['centerline']['center'][0])
        dimensions = self.ctx.component.sketches.item(0).sketchDimensions.values
        self.assertEqual([d.parameter.expression for d in dimensions],
                         ['((30 mm) - (2 mm) / 2)', '((30 mm) + (2 mm) / 2)'])

    def test_arc_strip_three_point_centerline_computes_circle(self):
        result = self.ctx.call('shape.arc_strip', {'name': 'Blade',
            'centerline': {'start': ['10 mm', '0 mm', '0 mm'], 'through': ['0 mm', '10 mm', '0 mm'], 'end': ['-10 mm', '0 mm', '0 mm']},
            'thickness': '1 mm', 'height': '5 mm'})
        center = result['centerline']['center']
        self.assertAlmostEqual(float(center[0].split()[0]), 0.0, places=4)
        self.assertAlmostEqual(float(center[1].split()[0]), 0.0, places=4)

    def test_arc_strip_three_point_collinear_rejected(self):
        with self.assertRaises(ValueError):
            self.ctx.call('shape.arc_strip', {'name': 'B',
                'centerline': {'start': ['0 mm', '0 mm', '0 mm'], 'through': ['1 mm', '0 mm', '0 mm'], 'end': ['2 mm', '0 mm', '0 mm']},
                'thickness': '1 mm', 'height': '5 mm'})
        self.assertEqual(shapes.model.TRACE, [])

    def test_can_composes_blank_shell_and_fillets(self):
        ctx = shapes.Context(attach_bodies=True)
        result = ctx.call('shape.can', {'name': 'Can', 'diameter': '40 mm', 'height': '60 mm',
            'wallThickness': '1.5 mm', 'opening': 'top', 'radii': ['2 mm', '1 mm']})
        self.assertEqual(result['recipe'], 'can')
        self.assertIn('blank', result)
        self.assertIn('shell', result)
        self.assertEqual(len(result['fillets']), 2)
        revolve = [d for op, d in ctx.calls if op == 'model.revolve'][0]
        self.assertEqual(revolve['axis'], 'Y')
        shell = [d for op, d in ctx.calls if op == 'model.shell'][0]
        self.assertEqual(shell['thickness'], '1.5 mm')
        self.assertEqual([d['radius'] for op, d in ctx.calls if op == 'model.fillet'], ['2 mm', '1 mm'])

    def test_can_mutually_exclusive_sources(self):
        for change in ({'diameter': '40 mm', 'profile': 'Section'},
                       {'diameter': '40 mm', 'profileData': {'geometry': []}},
                       {}):
            data = {'name': 'C', 'height': '10 mm', 'wallThickness': '1 mm'}
            data.update(change)
            with self.assertRaises(ValueError):
                self.ctx.call('shape.can', data)
        self.assertEqual(shapes.model.TRACE, [])

    def test_impeller_hub_blade_pattern_dependencies(self):
        ctx = shapes.Context(attach_bodies=True)
        result = ctx.call('shape.impeller', {'name': 'Imp', 'hub': {'diameter': '20 mm', 'height': '15 mm'},
            'blade': {'innerRadius': '10 mm', 'outerRadius': '40 mm', 'sweep': '60 deg', 'height': '15 mm'}, 'count': 6})
        self.assertEqual(result['recipe'], 'impeller')
        self.assertIn('hub', result)
        self.assertIn('blade', result)
        self.assertIn('pattern', result)
        blade_extrude = [d for op, d in ctx.calls if op == 'shape.arc_strip'][0]
        self.assertEqual(blade_extrude['operation'], 'join')
        self.assertNotIn('participants', blade_extrude)
        # The seed blade must reach the hub (inner edge == hub radius 10 mm) so the
        # implicit join merges with the hub body; outer edge == 40 mm.
        self.assertAlmostEqual(ctx.evaluate(result['blade']['centerline']['innerRadius']), 1.0, places=6)
        self.assertAlmostEqual(ctx.evaluate(result['blade']['centerline']['outerRadius']), 4.0, places=6)
        pattern = [d for op, d in ctx.calls if op == 'pattern.circular'][0]
        self.assertEqual(pattern['quantity'], 6)
        self.assertEqual(pattern['entities'], [result['blade']['feature']])

    def test_impeller_shroud_revolve_join(self):
        ctx = shapes.Context(attach_bodies=True)
        shroud = {'profileData': {'geometry': [{'type': 'line', 'name': 'a', 'start': ['0 mm', '0 mm', '0 mm'], 'end': ['10 mm', '0 mm', '0 mm']},
            {'type': 'line', 'name': 'b', 'start': ['10 mm', '0 mm', '0 mm'], 'end': ['0 mm', '0 mm', '0 mm']}]}}
        result = ctx.call('shape.impeller', {'name': 'Imp', 'hub': {'diameter': '20 mm', 'height': '15 mm'},
            'blade': {'thickness': '1 mm', 'radius': '30 mm', 'height': '15 mm'}, 'count': 4, 'shroud': shroud})
        self.assertIn('shroud', result)
        self.assertTrue(any(op == 'model.revolve' for op, d in ctx.calls))

    def test_boss_pattern_circular_with_hole(self):
        ctx = shapes.Context(attach_bodies=True)
        result = ctx.call('shape.boss_pattern', {'name': 'Boss', 'boss': {'diameter': '8 mm', 'height': '5 mm'},
            'hole': {'diameter': '3 mm', 'depth': '5 mm'},
            'layout': {'type': 'circular', 'axis': 'Z', 'quantity': 6, 'angle': '360 deg'}})
        self.assertEqual(result['recipe'], 'boss_pattern')
        self.assertIn('boss', result)
        self.assertIn('hole', result)
        pattern = [d for op, d in ctx.calls if op == 'pattern.circular'][0]
        self.assertEqual(len(pattern['entities']), 2)
        self.assertEqual(pattern['entities'], [result['boss']['feature'], result['hole']['feature']])
        hole = [d for op, d in ctx.calls if op == 'model.hole'][0]
        self.assertIn('participants', hole)
        self.assertTrue(hole['reverse'])
        self.assertEqual(hole['participants'], [result['boss']['bodies'][0]])

    def test_boss_pattern_rectangular_and_list_layouts(self):
        ctx = shapes.Context(attach_bodies=True)
        result = ctx.call('shape.boss_pattern', {'name': 'Boss', 'boss': {'diameter': '8 mm', 'height': '5 mm'},
            'layout': {'type': 'rectangular', 'direction': 'X', 'quantity': 4, 'distance': '15 mm'}})
        self.assertTrue(any(op == 'pattern.rectangular' for op, d in ctx.calls))
        result = ctx.call('shape.boss_pattern', {'name': 'Boss2', 'boss': {'diameter': '8 mm', 'height': '5 mm'},
            'layout': {'type': 'list', 'positions': [['0 mm', '0 mm', '0 mm'], ['10 mm', '0 mm', '0 mm']]}})
        self.assertEqual(result['pattern']['recipe'], 'list')

    def test_boss_pattern_invalid_layouts_rejected(self):
        for layout in ({'type': 'fake'}, {'type': 'rectangular', 'quantity': 4, 'distance': '15 mm'},
                       {'type': 'list', 'positions': [['0 mm', '0 mm', '0 mm']]}):
            with self.assertRaises(ValueError):
                self.ctx.call('shape.boss_pattern', {'name': 'B', 'boss': {'diameter': '8 mm', 'height': '5 mm'}, 'layout': layout})
        self.assertEqual(shapes.model.TRACE, [])

    def test_slot_frame_declares_plane_and_frame_local_points(self):
        ctx = self.ctx
        result = ctx.call('shape.slot', {'name': 'Slot', 'length': '30 mm', 'width': '6 mm',
            'position': ['10 mm', '-5 mm', '0 mm'], 'angle': '30 deg', 'thickness': '3 mm',
            'frame': {'datum': 'Tilted'}})
        plane = [d for op, d in ctx.calls if op == 'datum.plane'][0]
        self.assertEqual(plane['mode'], 'frame')
        self.assertEqual(plane['frame'], {'datum': 'Tilted'})
        points = [d for op, d in ctx.calls if op == 'datum.point']
        self.assertEqual(len(points), 2)
        for point in points:
            self.assertEqual(point['frame'], {'datum': 'Tilted'})
            self.assertEqual(point['associativity'], 'snapshot')
            self.assertEqual(point['point'][2], '0 mm')
        self.assertIn('slotGeometry', result)

    def test_slot_frame_and_plane_mutually_exclusive(self):
        with self.assertRaises(ValueError):
            self.ctx.call('shape.slot', {'name': 'S', 'length': '30 mm', 'width': '6 mm', 'thickness': '3 mm',
                'frame': {'datum': 'Tilted'}, 'plane': 'XZ'})
        self.assertEqual(shapes.model.TRACE, [])


if __name__ == '__main__':
    unittest.main()
