"""Offline regressions for the GM04 custom joint axis handoff.

Live evidence: a datum-frame custom axis handed to Fusion as a ConstructionAxis
(or a sketch line) produced a +Z motion axis instead of the requested +X. Point-
based AsBuiltJoint geometry is position-only and silently drops custom direction
entities. These tests pin the full (non-as-built) Joint path: two explicit
JointOrigins whose primary (Z) axis is a sketch line along the requested axis,
plus the post-create diagnostics that must catch native drops and sign flips.
"""
import json
import unittest
from unittest.mock import patch

import assembly_test as assembly
from assembly_test import NS


def negate(point):
    return NS(x=-point.x, y=-point.y, z=-point.z)


class JointAxisTests(unittest.TestCase):
    def setUp(self):
        self.ctx = assembly.Context()

    def axis(self, direction, origin=(0.0, 0.0, 0.0)):
        ctx = self.ctx
        axis = assembly.Entity('ConstructionAxis', 'Axis' + str(len(ctx.entities)),
                               parentComponent=ctx.root,
                               geometry=NS(objectType='adsk::core::InfiniteLine3D',
                                           origin=NS(x=origin[0], y=origin[1], z=origin[2]),
                                           direction=NS(x=direction[0], y=direction[1], z=direction[2])))
        ctx.entities['axis'] = axis
        return axis

    def create(self, mode='revolute', honoring='echo', **extra):
        ctx = self.ctx
        inputs = []
        original = ctx.root.joints.add

        def add(inp):
            inputs.append(inp)
            joint = original(inp)
            if honoring == 'flip':
                if hasattr(joint.jointMotion, 'rotationAxisVector'):
                    joint.jointMotion.rotationAxisVector = negate(joint.jointMotion.rotationAxisVector)
                if hasattr(joint.jointMotion, 'slideDirectionVector'):
                    joint.jointMotion.slideDirectionVector = negate(joint.jointMotion.slideDirectionVector)
            elif honoring == 'drop':
                joint.jointMotion.rotationAxisVector = NS(x=0, y=0, z=1)
                joint.jointMotion.slideDirectionVector = NS(x=0, y=0, z=1)
            return joint
        ctx.root.joints.add = add
        result = ctx.call('joint.' + mode, dict(name='J', occurrenceOne='A:1', occurrenceTwo='B:1',
                                                point='origin', axis={'ref': 'axis'}, **extra))
        return result, inputs

    def test_joint_origin_pins_z_axis_to_requested_direction_for_all_axes(self):
        for direction in ([1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1]):
            with self.subTest(direction=direction):
                self.setUp()
                self.axis(direction)
                result, inputs = self.create()
                self.assertEqual(len(inputs), 1)
                inp = inputs[0]
                # The full Joint uses ZAxisJointDirection: the JointOrigin Z axis
                # is already pinned, not a custom direction entity.
                self.assertEqual(inp.mode, 'Revolute')
                self.assertEqual(inp.axis, 'Z')
                line = inp.one.zAxisEntity
                self.assertIsNotNone(line.parentSketch)
                # The carrier line is drawn along -axis (Fusion inverts the
                # zAxisEntity direction), so its direction negates the request.
                self.assertEqual([round(line.geometry.direction.x, 9), round(line.geometry.direction.y, 9),
                                  round(line.geometry.direction.z, 9)], [-d for d in direction])
                self.assertEqual(result['directionDiagnostics']['requestedRoot'], direction)
                self.assertEqual(result['directionDiagnostics']['actualRoot'], direction)
                self.assertAlmostEqual(result['directionDiagnostics']['signedDot'], 1)
                self.assertEqual(result['status'], 'pass')
                self.assertTrue(result['success'])
                self.assertFalse(result['asBuilt'])
                self.assertFalse(result['posePreserved'])

    def test_sign_flip_by_native_is_detected_and_fails(self):
        self.axis([-1, 0, 0])
        result, inputs = self.create(honoring='flip')
        self.assertEqual(result['directionDiagnostics']['requestedRoot'], [-1, 0, 0])
        self.assertEqual(result['directionDiagnostics']['actualRoot'], [1, 0, 0])
        self.assertAlmostEqual(result['directionDiagnostics']['signedDot'], -1)
        self.assertEqual(result['status'], 'fail')
        self.assertFalse(result['success'])
        self.assertTrue(any('differs from the requested datum axis' in w for w in result['warnings']))
        self.assertEqual(self.ctx.root.joints.count, 1)

    def test_native_dropping_custom_direction_fails_like_live_evidence(self):
        self.axis([1, 0, 0])
        result, inputs = self.create(honoring='drop')
        self.assertEqual(result['directionDiagnostics']['requestedRoot'], [1, 0, 0])
        self.assertEqual(result['directionDiagnostics']['actualRoot'], [0, 0, 1])
        self.assertAlmostEqual(result['directionDiagnostics']['signedDot'], 0)
        self.assertEqual(result['status'], 'fail')
        self.assertFalse(result['success'])

    def test_slider_pins_z_axis_and_reads_back_slide_direction(self):
        self.axis([0, 1, 0])
        result, inputs = self.create(mode='slider')
        inp = inputs[0]
        self.assertEqual(inp.mode, 'Slider')
        self.assertEqual(inp.axis, 'Z')
        line = inp.one.zAxisEntity
        self.assertEqual([line.geometry.direction.x, line.geometry.direction.y, line.geometry.direction.z], [0, -1, 0])
        self.assertEqual(result['directionDiagnostics']['actualRoot'], [0, 1, 0])
        self.assertEqual(result['status'], 'pass')

    def test_joint_origin_helpers_and_direction_entity_refs(self):
        ctx = self.ctx
        self.axis([1, 0, 0], origin=(1.0, 2.0, 3.0))
        result, inputs = self.create()
        line = inputs[0].one.zAxisEntity
        start, end = line.startSketchPoint.geometry, line.endSketchPoint.geometry
        self.assertEqual([start.x, start.y, start.z], [1.0, 2.0, 3.0])
        self.assertEqual([end.x, end.y, end.z], [0.0, 2.0, 3.0])
        # One sketch line per input occurrence's component, not in the root.
        self.assertEqual(ctx.entities['A'].sketches.count, 1)
        self.assertEqual(ctx.entities['B'].sketches.count, 1)
        self.assertEqual(ctx.root.sketches.count, 0)
        entity = result['directionEntity']
        self.assertEqual(len(entity), 2)
        for side, component_name in zip(entity, ('A', 'B')):
            component = ctx.entities[component_name]
            self.assertEqual(ctx.resolve(side['line']).parentSketch, component.sketches.values[0])
            self.assertEqual(ctx.resolve(side['plane']).parentComponent, component)
            self.assertEqual(len(side['points']), 3)
            self.assertEqual(ctx.resolve(side['origin']).parentComponent, component)
        self.assertEqual(ctx.entities['A'].jointOrigins.count, 1)
        self.assertEqual(ctx.entities['B'].jointOrigins.count, 1)
        json.dumps(result, allow_nan=False)

    def test_frame_joint_merges_direction_helpers(self):
        ctx = self.ctx
        # GM04Target-like frame: origin [-1,0.5,2], xAxis [0,0,-1], yAxis [0,1,0] -> +Z is root +X.
        matrix = [0, 0, 1, -1, 0, 1, 0, 0.5, -1, 0, 0, 2, 0, 0, 0, 1]
        ctx.root.attributes.add(ctx.ns['_CAD_FRAME_GROUP'], 'mount', json.dumps({'matrix': matrix}))
        original_axis = ctx.ns['_cad_datum_axis']

        def axis_with_geometry(ctx, data):
            described = original_axis(ctx, data)
            entity = ctx.resolve(described)
            entity.geometry = NS(objectType='adsk::core::InfiniteLine3D',
                                 origin=NS(x=-1, y=0.5, z=2), direction=NS(x=1, y=0, z=0))
            return described
        with patch.dict(ctx.ns, {'_cad_datum_axis': axis_with_geometry}):
            result = ctx.call('joint.slider', {'schemaVersion': 1, 'name': 'S', 'occurrenceOne': 'A:1',
                                               'occurrenceTwo': 'B:1',
                                               'frame': {'component': 'root', 'datum': 'mount'},
                                               'associativity': 'snapshot'})
        self.assertEqual(result['directionDiagnostics']['requestedRoot'], [1, 0, 0])
        self.assertEqual(result['directionDiagnostics']['actualRoot'], [1, 0, 0])
        names = [h['name'] for h in result['helpers'] if 'name' in h]
        for expected in ('S__origin', 'S__axisEnd', 'S__axis', 'S__one__lineStart', 'S__one__lineEnd',
                         'S__one__lineSide', 'S__two__lineStart', 'S__two__lineEnd', 'S__two__lineSide'):
            self.assertIn(expected, names)
        self.assertEqual(result['status'], 'pass')
        json.dumps(result, allow_nan=False)

    def test_custom_axis_without_line_geometry_is_refused(self):
        ctx = self.ctx
        axis = assembly.Entity('ConstructionAxis', 'BadAxis', parentComponent=ctx.root, geometry=None)
        ctx.entities['axis'] = axis
        with self.assertRaisesRegex(ValueError, 'line geometry'):
            ctx.call('joint.revolute', {'name': 'J', 'occurrenceOne': 'A:1', 'occurrenceTwo': 'B:1',
                                        'point': 'origin', 'axis': {'ref': 'axis'}})
        self.assertEqual(ctx.root.sketches.count, 0)
        self.assertEqual(ctx.created, [])


if __name__ == '__main__':
    unittest.main()
