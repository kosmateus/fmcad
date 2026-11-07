"""GM16 offline tests: mounts, fasteners, bearings, shafts, bayonets, snaps and barbs."""
import math
import unittest

import shapes_test as shapes

NAMESPACE = dict(shapes.NAMESPACE)
NAMESPACE['CAD_HANDLERS'] = dict(shapes.NAMESPACE['CAD_HANDLERS'])
exec(compile((shapes.ROOT / 'assets/cad/fastener.py').read_text(), 'fastener.py', 'exec'), NAMESPACE)


class MountContext(shapes.Context):
    # Live ctx.ref() normalizes kinds via _cad_kind (ConstructionPoint -> 'point');
    # the shared offline mock returns the raw objectType short name. Normalize
    # datum-point refs so offline assertions match the live contract.
    def ref(self, entity):
        ref = dict(super().ref(entity))
        if ref.get('kind') == 'ConstructionPoint':
            ref['kind'] = 'point'
        return ref


class FastenerTests(unittest.TestCase):
    def setUp(self):
        self.ctx = MountContext()
        shapes.model.TRACE.clear()

    def call(self, operation, data):
        return NAMESPACE['CAD_HANDLERS'][operation](self.ctx, data)

    def test_mount_create_pin_slot_locates_without_over_constraining(self):
        result = self.call('mount.create', {'schemaVersion': 1, 'frame': 'component', 'name': 'PcbMount',
                                            'scheme': 'pin-slot', 'pin': {'x': '0 mm', 'y': '0 mm'},
                                            'slot': {'x': '40 mm', 'y': '0 mm'},
                                            'holes': {'diameter': '3 mm', 'clearance': '0.5 mm',
                                                      'positions': [{'x': '10 mm', 'y': '10 mm'},
                                                                    {'x': '30 mm', 'y': '30 mm'}]},
                                            'boss': {'diameter': '6 mm', 'height': '8 mm'},
                                            'support': {'connector': True},
                                            'material': 'FR-4', 'process': 'injection molded'})
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['locatingDofConstrained'], 3)
        self.assertFalse(result['overConstrained'])
        self.assertEqual(result['pin']['kind'], 'point')
        self.assertEqual(result['slot']['kind'], 'point')
        self.assertEqual(result['mateFit']['connectorSupported'], True)

    def test_mount_create_two_pin_over_constrains(self):
        result = self.call('mount.create', {'schemaVersion': 1, 'frame': 'component', 'name': 'Bad',
                                            'scheme': 'two-pin', 'pin': {'x': '0 mm', 'y': '0 mm'},
                                            'slot': {'x': '40 mm', 'y': '0 mm'},
                                            'holes': {'diameter': '3 mm', 'clearance': '0 mm',
                                                      'positions': [{'x': '10 mm', 'y': '10 mm'}]}})
        self.assertEqual(result['status'], 'fail')
        self.assertTrue(result['overConstrained'])

    def test_mount_check_flags_tight_holes_and_requires_connector_support(self):
        ok = self.call('mount.check', {'schemaVersion': 1, 'frame': 'component', 'scheme': 'pin-slot',
                                       'holes': [{'diameter': '3 mm', 'clearance': '0.5 mm'},
                                                 {'diameter': '3 mm', 'clearance': '0.5 mm'}],
                                       'connector': {'supported': True, 'supportPresent': True}})
        self.assertEqual(ok['status'], 'pass')
        bad = self.call('mount.check', {'schemaVersion': 1, 'frame': 'component', 'scheme': 'two-pin',
                                        'holes': [{'diameter': '3 mm', 'clearance': '0 mm'}],
                                        'connector': {'supported': True}})
        self.assertEqual(bad['status'], 'fail')

    def test_fastener_stack_engagement_is_thread_length_minus_stack(self):
        result = self.call('fastener.stack', {'schemaVersion': 1, 'frame': 'component',
                                              'screw': {'length': '12 mm', 'threadLength': '10 mm',
                                                        'headDiameter': '6 mm'},
                                              'stack': [{'id': 'bracket', 'thickness': '4 mm'},
                                                        {'id': 'pcb', 'thickness': '1.6 mm'}],
                                              'receptacle': {'kind': 'insert', 'depth': '8 mm'},
                                              'torque': '0.5 N*m', 'tool': {'diameter': '5 mm'}})
        self.assertEqual(result['status'], 'pass')
        self.assertAlmostEqual(result['clampedLength']['value'], 5.6, places=6)
        self.assertAlmostEqual(result['engagement']['value'], 4.4, places=6)
        self.assertEqual(result['torqueStatus'], 'declared')
        self.assertAlmostEqual(result['bottoming']['clearance']['value'], 1.6, places=6)
        self.assertFalse(result['bottoming']['bottomed'])

    def test_fastener_stack_requires_engagement(self):
        result = self.call('fastener.stack', {'schemaVersion': 1, 'frame': 'component',
                                              'screw': {'length': '10 mm', 'threadLength': '6 mm'},
                                              'stack': [{'thickness': '6 mm'}]})
        self.assertEqual(result['status'], 'fail')

    def test_native_fixture_declaration_uses_legacy_tapped_kind_not_native_blind_kind(self):
        import ast
        source = (shapes.ROOT / 'assets/native-qualification/measured-fasteners.py').read_text()
        declarations = []
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Dict):
                for key, value in zip(node.keys, node.values):
                    if isinstance(key, ast.Constant) and key.value == 'declaredEvidence':
                        declarations.append(ast.literal_eval(value))
        self.assertEqual(len(declarations), 1)
        declared = declarations[0]
        operation = declared.pop('operation')
        self.assertEqual(declared['receptacle']['kind'], 'tapped')
        result = self.call(operation, declared)
        self.assertEqual(result['status'], 'pass')
        declared['receptacle']['kind'] = 'blind'
        with self.assertRaisesRegex(ValueError, 'receptacle kind must be nut, tapped or insert'):
            self.call(operation, declared)
        self.assertIn("'receptacle': {'kind': 'blind', 'axis':", source)

    def test_fastener_check_engagement_bottoming_access(self):
        result = self.call('fastener.check', {'schemaVersion': 1, 'frame': 'component',
                                              'screw': {'length': '12 mm', 'threadLength': '10 mm'},
                                              'stack': [{'thickness': '4 mm'}, {'thickness': '1.6 mm'}],
                                              'minimumEngagement': '4 mm',
                                              'receptacle': {'kind': 'insert', 'depth': '8 mm'},
                                              'tool': {'diameter': '4 mm', 'recess': '5 mm'}})
        self.assertEqual(result['status'], 'pass')
        statuses = {c['check']: c['status'] for c in result['checks']}
        self.assertEqual(statuses['engagement'], 'pass')
        self.assertEqual(statuses['bottoming'], 'pass')
        self.assertEqual(statuses['access'], 'pass')

    def test_fastener_check_reports_unknown_without_declared_data(self):
        result = self.call('fastener.check', {'schemaVersion': 1, 'frame': 'component',
                                              'screw': {'length': '12 mm', 'threadLength': '10 mm'},
                                              'stack': [{'thickness': '4 mm'}]})
        statuses = {c['check']: c['status'] for c in result['checks']}
        self.assertEqual(statuses['engagement'], 'notEvaluated')
        self.assertEqual(statuses['bottoming'], 'notEvaluated')

    def test_fastener_schedule_flags_missing_data(self):
        complete = self.call('fastener.schedule', {'schemaVersion': 1, 'frame': 'component',
                                                   'fasteners': [{'id': 'A', 'torque': '0.5 N*m',
                                                                  'process': 'torque wrench', 'material': 'A2-70'}]})
        self.assertEqual(complete['status'], 'pass')
        incomplete = self.call('fastener.schedule', {'schemaVersion': 1, 'frame': 'component',
                                                     'fasteners': [{'id': 'B', 'torque': '0.5 N*m'}]})
        self.assertEqual(incomplete['status'], 'unknown')
        self.assertEqual(incomplete['missingData'], ['B'])

    def test_bearing_stack_distinguishes_fixed_ring_and_no_preload(self):
        result = self.call('bearing.stack-check', {'schemaVersion': 1, 'frame': 'component',
                                                   'rings': {'inner': {'bore': '10 mm'}, 'outer': {'od': '26 mm'}},
                                                   'journal': '10 mm', 'seat': '26 mm',
                                                   'shaftClearance': '0.005 mm', 'housingClearance': '0.0 mm',
                                                   'shoulder': {'inner': True}, 'arrangement': 'fixed-floating'})
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['fixedRing'], 'inner')
        self.assertIn('none declared', result['preload'])

    def test_shaft_interface_d_flat_requires_d_flat_bore(self):
        good = self.call('shaft.interface', {'schemaVersion': 1, 'frame': 'component',
                                             'shaft': {'type': 'D-flat', 'd': '6 mm', 'flat': {'depth': '0.5 mm'}},
                                             'hub': {'bore': '6 mm', 'boreType': 'D-flat',
                                                     'splitClampGap': '0.8 mm', 'shoulders': [{}]}})
        self.assertEqual(good['status'], 'pass')
        bad = self.call('shaft.interface', {'schemaVersion': 1, 'frame': 'component',
                                            'shaft': {'type': 'D-flat', 'd': '6 mm', 'flat': {'depth': '0.5 mm'}},
                                            'hub': {'bore': '6 mm', 'boreType': 'round'}})
        self.assertEqual(bad['status'], 'fail')

    def test_retention_bayonet_assembly_path_and_capture(self):
        result = self.call('retention.bayonet', {'schemaVersion': 1, 'frame': 'component',
                                                 'lugs': {'count': 3, 'width': '4 mm', 'height': '2 mm'},
                                                 'stroke': '6 mm', 'rotation': '30 deg',
                                                 'capture': {'depth': '1.5 mm'},
                                                 'clearances': {'radial': '0.2 mm'}})
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['assemblyPath'], 'insert -> rotate -> capture')
        missing = self.call('retention.bayonet', {'schemaVersion': 1, 'frame': 'component',
                                                  'lugs': {'count': 3, 'width': '4 mm', 'height': '2 mm'},
                                                  'stroke': '6 mm', 'rotation': '30 deg'})
        self.assertEqual(missing['status'], 'fail')

    def test_snap_evaluate_cantilever_beam(self):
        result = self.call('snap.evaluate', {'schemaVersion': 1, 'frame': 'component',
                                             'geometry': {'length': '10 mm', 'width': '4 mm', 'thickness': '1 mm',
                                                          'engagementDepth': '0.6 mm', 'deflection': '0.6 mm'},
                                             'material': {'name': 'ABS', 'modulus': '2.1 GPa', 'yieldStrength': '40 MPa'},
                                             'support': {'condition': 'cantilever'}})
        self.assertEqual(result['status'], 'pass')
        # I = w t^3 / 12 = 4*1/12 = 1/3 mm^4; k = 3 E I / L^3 = 3*2100*(1/3)/1000 = 2.1 N/mm
        self.assertAlmostEqual(result['stiffness']['value'], 2.1, places=6)
        self.assertAlmostEqual(result['engagementForce']['value'], 1.26, places=6)
        self.assertAlmostEqual(result['stress']['value'], 18.9, places=6)

    def test_snap_evaluate_yield_exceeded_fails(self):
        result = self.call('snap.evaluate', {'schemaVersion': 1, 'frame': 'component',
                                             'geometry': {'length': '10 mm', 'width': '4 mm', 'thickness': '1 mm',
                                                          'engagementDepth': '2 mm', 'deflection': '2 mm'},
                                             'material': {'name': 'ABS', 'modulus': '2.1 GPa', 'yieldStrength': '10 MPa'},
                                             'support': {'condition': 'cantilever'}})
        self.assertEqual(result['status'], 'fail')

    def test_snap_define_requires_no_material_default(self):
        result = self.call('snap.define', {'schemaVersion': 1, 'frame': 'component',
                                           'geometry': {'length': '10 mm', 'width': '4 mm', 'thickness': '1 mm',
                                                        'engagementDepth': '0.6 mm'},
                                           'material': {'name': 'ABS', 'modulus': '2.1 GPa'}})
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['material']['name'], 'ABS')

    def test_hose_barb_channel_continuity_and_seating(self):
        result = self.call('shape.hose_barb', {'schemaVersion': 1, 'frame': 'component', 'name': 'Barb',
                                               'tubeId': '4 mm', 'tubeOd': '6 mm', 'bore': '3 mm',
                                               'barbs': [{'crest': '7 mm', 'root': '6 mm', 'length': '3 mm'},
                                                         {'crest': '7 mm', 'root': '6 mm', 'length': '3 mm'}]})
        self.assertEqual(result['status'], 'pass')
        self.assertAlmostEqual(result['seating'][0]['radialInterference']['value'], 1.5, places=6)
        self.assertIn('feature', result)

    def test_hose_barb_rejects_blocked_channel(self):
        with self.assertRaises(ValueError):
            self.call('shape.hose_barb', {'schemaVersion': 1, 'frame': 'component', 'name': 'Barb',
                                          'tubeId': '4 mm', 'tubeOd': '6 mm', 'bore': '4.5 mm',
                                          'barbs': [{'crest': '7 mm', 'root': '6 mm', 'length': '3 mm'}]})


if __name__ == '__main__':
    unittest.main()
