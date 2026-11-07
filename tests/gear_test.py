"""GM11 involute gear and pair-check tests against the model/sketch mocks."""
import json
import math
import unittest

import shapes_test as shapes

NAMESPACE = dict(shapes.NAMESPACE)
NAMESPACE['CAD_HANDLERS'] = dict(shapes.NAMESPACE['CAD_HANDLERS'])
exec(compile((shapes.ROOT / 'assets/cad/gear.py').read_text(), 'gear.py', 'exec'), NAMESPACE)


def _pt(ctx, coord):
    p = ctx.point(coord)
    return (p.x, p.y)


def _snap(p):
    return (round(p[0], 9), round(p[1], 9))


def _arc_end(center, start, sweep):
    cx, cy = center
    sx, sy = start
    a0 = math.atan2(sy - cy, sx - cx)
    a1 = a0 + sweep
    rad = math.hypot(sx - cx, sy - cy)
    return (cx + rad * math.cos(a1), cy + rad * math.sin(a1))


def _tooth_edges(ctx, geometry):
    edges = []
    for item in geometry:
        if item['type'] == 'line':
            edges.append((_pt(ctx, item['start']), _pt(ctx, item['end']), 'line', None))
        elif item['type'] == 'arc':
            center = _pt(ctx, item['center'])
            start = _pt(ctx, item['start'])
            end = _arc_end(center, start, ctx.angle(item['sweep']))
            edges.append((start, end, 'arc', center))
        else:
            raise AssertionError('unexpected tooth geometry type: ' + item['type'])
    return edges


def _single_cycle(edges):
    from collections import defaultdict, deque
    adj = defaultdict(set)
    for i, (a, b, _kind, _extra) in enumerate(edges):
        adj[_snap(a)].add((_snap(b), i))
        adj[_snap(b)].add((_snap(a), i))
    for vertex, nbrs in adj.items():
        if len(nbrs) != 2:
            return False, 'vertex %s has degree %d' % (vertex, len(nbrs))
    start = next(iter(adj))
    seen = {start}
    queue = deque([start])
    while queue:
        vertex = queue.popleft()
        for nbr, _i in adj[vertex]:
            if nbr not in seen:
                seen.add(nbr)
                queue.append(nbr)
    return len(seen) == len(adj), 'connected %d/%d vertices' % (len(seen), len(adj))


def _arc_polyline(center, start, end, samples=64):
    cx, cy = center
    a0 = math.atan2(start[1] - cy, start[0] - cx)
    a1 = math.atan2(end[1] - cy, end[0] - cx)
    sweep = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
    rad = math.hypot(start[0] - cx, start[1] - cy)
    return [(cx + rad * math.cos(a0 + sweep * k / samples),
             cy + rad * math.sin(a0 + sweep * k / samples)) for k in range(samples + 1)]


def _orient(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _on_segment(a, b, c):
    return (min(a[0], b[0]) - 1e-9 <= c[0] <= max(a[0], b[0]) + 1e-9 and
            min(a[1], b[1]) - 1e-9 <= c[1] <= max(a[1], b[1]) + 1e-9)


def _segments_cross(p1, p2, p3, p4):
    o1 = _orient(p1, p2, p3)
    o2 = _orient(p1, p2, p4)
    o3 = _orient(p3, p4, p1)
    o4 = _orient(p3, p4, p2)
    if o1 == 0 and _on_segment(p1, p2, p3):
        return True
    if o2 == 0 and _on_segment(p1, p2, p4):
        return True
    if o3 == 0 and _on_segment(p3, p4, p1):
        return True
    if o4 == 0 and _on_segment(p3, p4, p2):
        return True
    return (o1 * o2 < 0) and (o3 * o4 < 0)


def _profile_has_crossings(edges):
    polylines = []
    for start, end, kind, extra in edges:
        polylines.append([start, end] if kind == 'line' else _arc_polyline(extra, start, end))
    for i in range(len(polylines)):
        ends_i = {_snap(polylines[i][0]), _snap(polylines[i][-1])}
        for j in range(i + 1, len(polylines)):
            ends_j = {_snap(polylines[j][0]), _snap(polylines[j][-1])}
            if ends_i & ends_j:
                continue
            for a in range(len(polylines[i]) - 1):
                for b in range(len(polylines[j]) - 1):
                    if _segments_cross(polylines[i][a], polylines[i][a + 1],
                                       polylines[j][b], polylines[j][b + 1]):
                        return True
    return False


class GearContext(shapes.Context):
    def call(self, op, data):
        return NAMESPACE['CAD_HANDLERS'][op](self, data)


class GearTests(unittest.TestCase):
    def setUp(self):
        self.ctx = shapes.Context()
        shapes.model.TRACE.clear()

    def call(self, op, data):
        return NAMESPACE['CAD_HANDLERS'][op](self.ctx, data)

    def test_catalog_and_manual_cover_gear_operations(self):
        catalog = json.loads((shapes.ROOT / 'src/catalog/gear.json').read_text())
        manual = json.loads((shapes.ROOT / 'src/manual/gear.json').read_text())
        self.assertEqual(set(catalog), set(manual))
        self.assertEqual(set(catalog), {'shape.gear', 'gear.pair-check'})
        self.assertTrue(catalog['gear.pair-check']['readOnly'])
        self.assertTrue(catalog['gear.pair-check']['envelope'])
        for operation, entry in manual.items():
            self.assertTrue(any(s['title'].startswith('Return Contract') for s in entry['sections']))
            self.assertEqual(entry['audit']['gaps'], [])
            self.assertTrue(entry['audit']['sources'] and entry['audit']['verified'] and entry['audit']['tests'])

    def test_gear_diameters_follow_standard_equations(self):
        result = self.call('shape.gear', {'name': 'Gear', 'module': '2 mm', 'teeth': 20,
                                          'pressureAngle': '20 deg', 'faceWidth': '10 mm'})
        diameters = result['diameters']
        self.assertAlmostEqual(diameters['pitch'], 4.0, places=6)
        self.assertAlmostEqual(diameters['base'], 4.0 * math.cos(math.radians(20)), places=6)
        self.assertAlmostEqual(diameters['addendum'], 4.4, places=6)
        self.assertAlmostEqual(diameters['root'], 3.5, places=6)
        self.assertEqual(result['toothCount'], 20)
        self.assertEqual(result['recipe'], 'gear')
        self.assertIn('feature', result)

    def test_gear_tooth_flank_is_involute_not_trapezoid(self):
        self.call('shape.gear', {'name': 'Gear', 'module': '2 mm', 'teeth': 20, 'faceWidth': '10 mm'})
        tooth_geometry = None
        for op, data in self.ctx.calls:
            if op == 'sketch.geometry':
                if any(item.get('name', '').startswith('rightFlank') for item in data['geometry']):
                    tooth_geometry = data['geometry']
        self.assertIsNotNone(tooth_geometry)
        # Flanks are chordal line segments, never fitted splines, so the VCS
        # solver closes the profile with plain coincident constraints.
        self.assertFalse(any(item['type'] == 'spline' for item in tooth_geometry))
        flanks = [item for item in tooth_geometry
                  if item['type'] == 'line' and item['name'].startswith(('rightFlank', 'leftFlank'))]
        self.assertGreater(len(flanks), 16)
        self.assertTrue(any(item['type'] == 'arc' for item in tooth_geometry))

    def test_gear_tooth_profile_is_single_closed_loop_without_crossings(self):
        self.call('shape.gear', {'name': 'Gear', 'module': '2 mm', 'teeth': 20, 'faceWidth': '10 mm'})
        tooth_geometry = None
        for op, data in self.ctx.calls:
            if op == 'sketch.geometry':
                if any(item.get('name', '').startswith('rightFlank') for item in data['geometry']):
                    tooth_geometry = data['geometry']
        self.assertIsNotNone(tooth_geometry)
        edges = _tooth_edges(self.ctx, tooth_geometry)
        # A standard gear tooth must be ONE connected closed cycle: every vertex
        # joins exactly two curves, and no two curves may self-intersect. The
        # former regression (D-12 reopen) left the root arc sweeping the wrong
        # way, splitting the profile into two loops.
        closed, reason = _single_cycle(edges)
        self.assertTrue(closed, 'tooth profile is not a single closed loop: ' + reason)
        self.assertFalse(_profile_has_crossings(edges), 'tooth profile self-intersects')

    def test_gear_driving_radii_and_pattern(self):
        result = self.call('shape.gear', {'name': 'Gear', 'module': '2 mm', 'teeth': 20, 'faceWidth': '10 mm'})
        pattern = [d for op, d in self.ctx.calls if op == 'pattern.circular'][0]
        self.assertEqual(pattern['quantity'], 20)
        self.assertEqual(pattern['entities'], [result['tooth']['feature']])
        radius_exprs = set()
        for op, d in self.ctx.calls:
            if op == 'sketch.dimension' and d['type'] == 'radius':
                radius_exprs.add(d['expression'])
        self.assertIn('(2 mm) * (20 + 2.0) / 2', radius_exprs)
        self.assertIn('(2 mm) * (20 - 2.5) / 2', radius_exprs)

    def test_gear_undercut_detection(self):
        result = self.call('shape.gear', {'name': 'Small', 'module': '2 mm', 'teeth': 12, 'faceWidth': '5 mm'})
        self.assertTrue(result['undercut']['undercut'])
        self.assertEqual(result['undercut']['minimumTeeth'], 18)
        result = self.call('shape.gear', {'name': 'Big', 'module': '2 mm', 'teeth': 20, 'faceWidth': '5 mm'})
        self.assertFalse(result['undercut']['undercut'])

    def test_gear_root_treatment_and_profile_shift(self):
        result = self.call('shape.gear', {'name': 'Gear', 'module': '2 mm', 'teeth': 20, 'faceWidth': '5 mm',
                                          'rootTreatment': 'straight'})
        self.assertEqual(result['rootTreatment'], 'straight')
        self.assertEqual(result['rootFilletRadius'], '0 mm')
        shifted = self.call('shape.gear', {'name': 'Shifted', 'module': '2 mm', 'teeth': 20, 'faceWidth': '5 mm',
                                           'profileShift': 0.5})
        self.assertAlmostEqual(shifted['diameters']['addendum'], 4.4 + 2 * 0.2 * 0.5, places=6)

    def test_gear_bore_hub_and_key(self):
        ctx = shapes.Context(attach_bodies=True)
        result = NAMESPACE['CAD_HANDLERS']['shape.gear'](ctx, {'name': 'Gear', 'module': '2 mm', 'teeth': 20,
            'faceWidth': '10 mm', 'bore': '8 mm', 'hub': {'diameter': '15 mm', 'height': '5 mm'},
            'key': {'width': '2 mm', 'depth': '1 mm'}})
        self.assertIn('bore', result)
        self.assertIn('hub', result)
        self.assertIn('key', result)
        hole = [d for op, d in ctx.calls if op == 'model.hole'][0]
        self.assertEqual(hole['diameter'], '8 mm')
        self.assertIn('participants', hole)

    def test_gear_rejects_backlash_leaving_no_positive_half_angle(self):
        for i, change in enumerate(({'backlashAllocation': '10 mm'}, {'toothThicknessReduction': '10 mm'})):
            with self.assertRaisesRegex(ValueError, 'no positive tooth/tip half-angle'):
                self.call('shape.gear', {'name': 'G%d' % i, 'module': '2 mm', 'teeth': 20, 'faceWidth': '5 mm', **change})

    def test_gear_invalid_inputs_rejected_before_mutation(self):
        for change in ({'teeth': 0}, {'module': '0 mm'}, {'faceWidth': '0 mm'},
                       {'rootTreatment': 'fake'}, {'profileShift': 'NaN'}):
            with self.assertRaises(ValueError):
                self.call('shape.gear', dict({'name': 'G', 'module': '2 mm', 'teeth': 20, 'faceWidth': '5 mm'}, **change))
        self.assertEqual(shapes.model.TRACE, [])

    def test_pair_check_ratio_sign_center_distance_and_backlash(self):
        result = self.call('gear.pair-check', {'gear1': {'module': '2 mm', 'teeth': 20, 'pressureAngle': '20 deg'},
            'gear2': {'module': '2 mm', 'teeth': 40, 'pressureAngle': '20 deg'}, 'external': True, 'phase': 0})
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['ratio'], 2.0)
        self.assertEqual(result['sign'], 1)
        self.assertAlmostEqual(result['centerDistance'], 6.0, places=6)
        self.assertEqual(result['teeth'], (20, 40))

    def test_pair_check_internal_gear_flips_sign(self):
        result = self.call('gear.pair-check', {'gear1': {'module': '2 mm', 'teeth': 40, 'pressureAngle': '20 deg'},
            'gear2': {'module': '2 mm', 'teeth': 20, 'pressureAngle': '20 deg'}, 'external': False})
        self.assertEqual(result['ratio'], -0.5)
        self.assertEqual(result['sign'], -1)

    def test_pair_check_backlash_is_sum_not_unconditional_halving(self):
        result = self.call('gear.pair-check', {'gear1': {'module': '2 mm', 'teeth': 20, 'backlashAllocation': '0.05 mm'},
            'gear2': {'module': '2 mm', 'teeth': 20, 'backlashAllocation': '0.03 mm'}})
        self.assertAlmostEqual(result['backlash'], 0.008, places=6)

    def test_pair_check_undercut_and_mismatched_module(self):
        result = self.call('gear.pair-check', {'gear1': {'module': '2 mm', 'teeth': 10, 'pressureAngle': '20 deg'},
            'gear2': {'module': '2 mm', 'teeth': 20, 'pressureAngle': '20 deg'}})
        self.assertEqual(result['status'], 'fail')
        with self.assertRaises(ValueError):
            self.call('gear.pair-check', {'gear1': {'module': '2 mm', 'teeth': 20},
                'gear2': {'module': '3 mm', 'teeth': 20}})


if __name__ == '__main__':
    unittest.main()
