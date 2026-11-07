"""GM04 offline oracles. Doubled SDK boundaries do not prove native acceptance."""
import math
import sys
from pathlib import Path
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

import core_test as core
import assembly_test as assembly

ROOT = Path(__file__).resolve().parents[1]
IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def matrix(values):
    result = assembly.Matrix()
    result.setWithArray(values)
    return result


class RootProxy(assembly.Entity):
    def __init__(self, ctx, parent, native):
        super().__init__('Occurrence', native.name, component=native.component,
                         nativeObject=native, fullPathName=parent.fullPathName + '+' + native.name,
                         isReferencedComponent=False, isGrounded=False)
        self.ctx, self.parent = ctx, parent
        self.override = None

    @property
    def transform2(self):
        return self.override or matrix(self.ctx.ns['_entity_multiply'](self.parent.transform2.asArray(), self.nativeObject.transform2.asArray()))

    @transform2.setter
    def transform2(self, value):
        self.ctx.trace.append('transform')
        self.override = value
        self.ctx.design.snapshots.hasPendingSnapshot = True


class DatumTests(unittest.TestCase):
    register = core.CoreTests.register

    def setUp(self):
        core.CoreTests.setUp(self)
        self.doc.creationId, self.doc.dataFile.id = 'gm04', 'gm04-file'
        self.design.designType = 1
        self.core.adsk.fusion.DesignTypes = NS(ParametricDesignType=1, DirectDesignType=0)
        self.core.adsk.core.Matrix3D = assembly.Matrix
        self.ns = self.core.__dict__
        with patch.dict(sys.modules, {'adsk': self.core.adsk, 'adsk.core': self.core.adsk.core, 'adsk.fusion': self.core.adsk.fusion}):
            for name in ('assembly', 'datum', 'io', 'model'):
                exec(compile((ROOT / f'assets/cad/{name}.py').read_text(), name, 'exec'), self.ns)

    def occurrence(self, path, owner, values, native=None):
        result = core.Entity('Occurrence', path.split('+')[-1])
        result.component, result.fullPathName = owner, path
        result.transform2, result.nativeObject = matrix(values), native
        result.isReferencedComponent = result.isGrounded = False
        self.root.allOccurrences.items.append(result)
        self.register(result)
        return result

    def nested(self):
        parent = core.component('Parent')
        self.design.allComponents.items.append(parent)
        self.register(parent)
        # Parent: +90deg about Z, then +100mm X. Child: +20mm local X.
        p = self.occurrence('Parent:1', parent, [0, -1, 0, 10, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
        n = core.Entity('Occurrence', 'Part:1')
        n.component, n.transform2, n.isGrounded = self.child, matrix([1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), False
        c = self.occurrence('Parent:1+Part:1', self.child, [0, -1, 0, 10, 1, 0, 0, 2, 0, 0, 1, 0, 0, 0, 0, 1], n)
        return p, c

    def transform(self, **data):
        return self.ctx.call('datum.transform', data)

    def test_nested_point_vector_difference_roundtrip(self):
        _, child = self.nested()
        source = {'occurrence': self.ctx.ref(child)}
        result = self.transform(**{'from': source, 'to': 'root', 'points': [['10 mm', '0 mm', '0 mm']],
            'vectors': [[2, 0, 0], [0, 0, 0]], 'differences': [{'from': ['1 cm', '2 cm', '3 cm'], 'to': ['3 cm', '2 cm', '3 cm']}]})
        self.assertEqual(result['points'], [[10, 3, 0]])
        self.assertEqual(result['vectors'], [[0, 2, 0], [0, 0, 0]])
        self.assertEqual(result['differences'], [[0, 2, 0]])
        back = self.transform(**{'from': 'root', 'to': source, 'points': [['10 cm', '3 cm', '0 cm']]})
        self.assertEqual(back['points'], [[1, 0, 0]])
        self.assertEqual(result['associativity'], 'snapshot')
        self.assertEqual(result['documentIdentity']['creationId'], 'gm04')

    def test_xz_yz_sketch_signs_without_occurrence_guess(self):
        for x, y, z in [([1, 0, 0], [0, 0, 1], [0, -1, 0]), ([0, 1, 0], [0, 0, 1], [1, 0, 0])]:
            sketch = core.Entity('Sketch', 'PlaneSketch', self.child)
            sketch.sketchToModelSpace = lambda p: core.Point(*(x[r]*p.x + y[r]*p.y + z[r]*p.z for r in range(3)))
            self.register(sketch)
            result = self.transform(**{'from': {'sketch': self.ctx.ref(sketch)}, 'to': {'component': self.ctx.ref(self.child)}, 'vectors': [[0, 0, 3]]})
            self.assertEqual(result['vectors'], [[v*3 for v in z]])

    def test_third_level_composition_and_context_output(self):
        _, child = self.nested()
        tip = core.component('Tip')
        self.design.allComponents.items.append(tip)
        self.register(tip)
        third = self.occurrence('Parent:1+Part:1+Tip:1', tip, [0, 0, 1, 10, 1, 0, 0, 2, 0, 1, 0, 4, 0, 0, 0, 1])
        result = self.transform(**{'from': {'occurrence': self.ctx.ref(third)}, 'to': 'root', 'points': [['0 cm', '1 cm', '0 cm']]})
        self.assertEqual(result['points'], [[10, 2, 5]])
        self.ctx.component, self.ctx.occurrence = self.child, child
        result = self.transform(**{'from': {'occurrence': self.ctx.ref(third)}, 'to': 'context', 'points': [['0 cm', '1 cm', '0 cm']]})
        self.assertEqual(result['points'], [[0, 0, 5]])

    def test_repeated_component_ambiguity_and_reflection_rejection(self):
        self.occurrence('Part:1', self.child, IDENTITY)
        other = self.occurrence('Part:2', self.child, IDENTITY)
        with self.assertRaisesRegex(ValueError, 'explicit occurrence'):
            self.transform(**{'from': {'component': 'Part'}, 'to': 'root'})
        reflected = list(IDENTITY)
        reflected[0] = -1
        other.transform2 = matrix(reflected)
        with self.assertRaisesRegex(ValueError, 'reflected'):
            self.transform(**{'from': {'occurrence': self.ctx.ref(other)}, 'to': 'root'})

    def test_bad_units_plain_vectors_and_schema(self):
        for payload in ({'points': [[1, 2, 3]]}, {'points': [['1 deg', '0 mm', '0 mm']]},
                        {'vectors': [['1 mm', 0, 0]]}, {'vectors': [[float('nan'), 0, 0]]}, {'schemaVersion': True}):
            with self.subTest(payload=payload), self.assertRaises((ValueError, TypeError)):
                self.transform(**{'from': 'root', 'to': 'root', **payload})
        with self.assertRaisesRegex(ValueError, 'Unknown named datum'):
            self.transform(**{'from': {'datum': 'missing'}, 'to': {'datum': 'missing'}})

    def test_frame_snapshot_does_not_regenerate_and_existing_policies(self):
        self.core.adsk.core.Matrix3D = core.Matrix
        self.ctx.call('param.apply', {'parameters': [{'name': 'offset', 'expression': '10 mm', 'unit': 'mm'}]})
        data = {'schemaVersion': 1, 'name': 'mount', 'origin': ['offset', '0 mm', '0 mm'], 'xAxis': [1, 0, 0], 'yAxis': [0, 1, 0]}
        result = self.ctx.call('datum.frame', data)
        self.assertFalse(result['parametric'])
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.ctx.call('datum.frame', data)
        self.assertFalse(self.ctx.call('datum.frame', dict(data, onExisting='reuse'))['changed'])
        self.design.userParameters.itemByName('offset').expression = '20 mm'
        read = self.transform(**{'from': {'component': 'root', 'datum': 'mount'}, 'to': 'root', 'points': [['0 mm']*3]})
        self.assertEqual(read['points'], [[1, 0, 0]])
        with self.assertRaisesRegex(ValueError, 'confirm'):
            self.ctx.call('datum.frame', dict(data, onExisting='reuse'))
        self.assertEqual(self.ctx.call('datum.frame', dict(data, onExisting='update', confirm=True))['matrix'][3], 2)

    def test_cross_frame_point_snapshot_keeps_negative_xz_offset(self):
        self.root.constructionPoints = core.Datums('ConstructionPoint', self.root)
        self.root.constructionPlanes = core.Datums('ConstructionPlane', self.root)
        data = {'name': 'p', 'point': ['1 cm', '2 cm', '3 cm'], 'frame': 'root', 'associativity': 'snapshot'}
        result = self.ctx.call('datum.point', data)
        offsets = [p.input.definition[1][1] for p in self.root.constructionPlanes.items]
        self.assertEqual(offsets, ['1.0 cm', '-(2.0 cm)', '3.0 cm'])
        self.assertEqual(result['associativity'], 'snapshot')

    def test_path_endpoints_and_failures_before_add(self):
        evaluator = NS(getParameterExtents=lambda: (True, 0, 1), getLengthAtParameter=lambda a, b: (True, 5))
        path = core.Items([NS(curve=NS(evaluator=evaluator))])
        for mode, values in [('proportional', ['0', '1', '0.3']), ('length', ['0 mm', '50 mm', '2 cm'])]:
            for value in values:
                actual, length, _ = self.ns['_datum_path_position'](self.ctx, path, {'mode': mode, 'value': value})
                self.assertEqual(length, 5)
                self.assertGreaterEqual(actual, 0)
        for mode, value in [('proportional', '-0.0001'), ('proportional', '1.00000001'), ('length', '-1 mm'), ('length', '50.000001 mm')]:
            with self.assertRaisesRegex(ValueError, 'clamping'):
                self.ns['_datum_path_position'](self.ctx, path, {'mode': mode, 'value': value})
        evaluator.getLengthAtParameter = lambda a, b: (False, 0)
        with self.assertRaisesRegex(Exception, 'length'):
            self.ns['_datum_path_position'](self.ctx, path, {'mode': 'length', 'value': '0 mm'})

    def test_native_plane_signature_expression_and_missing_sdk(self):
        calls = []
        inp = NS(setByPath=lambda *args: calls.append(args) or True)
        plane = core.Entity('ConstructionPlane', 'created', self.root)
        plane.geometry = NS(objectType='adsk::core::Plane', origin=core.Point(0, 0, 2.5), normal=core.Point(0, 0, 1))
        self.root.constructionPlanes = core.Items()
        self.root.constructionPlanes.createInput = lambda: inp
        self.root.constructionPlanes.add = lambda value: calls.append('add') or plane
        self.core.adsk.fusion.PathDistanceTypes = NS(ProportionalPathDistanceType='ratio', PhysicalPathDistanceType='physical')
        evaluator = NS(getParameterExtents=lambda: (True, 0, 1), getLengthAtParameter=lambda a, b: (True, 5),
            getParameterAtLength=lambda start, length: (True, start + length / 5), getTangent=lambda t: (True, core.Point(0, 0, 1)),
            getPointAtParameter=lambda t: (True, core.Point(0, 0, 5*t)))
        curve = core.Entity('BRepEdge', 'curve', self.root)
        curve.evaluator = evaluator
        self.register(curve)
        path = core.Items([NS(curve=NS(evaluator=evaluator), entity=curve, isOpposedToEntity=False)])
        data = {'name': 'section', 'path': {'curves': [self.ctx.ref(curve)]}, 'position': {'mode': 'proportional', 'value': '0.5'}}
        with patch.dict(self.ns, {'_model_path': lambda ctx, data: path}):
            result = self.ctx.call('datum.plane-on-path', data)
            self.assertEqual(calls[0], (path, 'ratio', '0.5'))
            self.assertEqual(result['actualPlane']['normal'], [0, 0, 1])
            self.assertEqual(result['associativity'], 'nativeExpression')
            self.assertEqual(result['status'], 'pass')
            self.assertEqual(result['distanceResidual'], 0)
            oriented = self.ctx.call('datum.plane-on-path', dict(data, orientation={'direction': [2, 0, 4], 'frame': 'root'}))
            self.assertEqual(oriented['sectionFrame']['matrix'], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 2.5, 0, 0, 0, 1])
            self.assertEqual(oriented['sectionFrame']['associativity'], 'snapshot')
            calls.clear()
            with self.assertRaisesRegex(ValueError, 'parallel'):
                self.ctx.call('datum.plane-on-path', dict(data, orientation={'direction': [0, 0, 7], 'frame': 'root'}))
            self.assertEqual(calls, [])
            plane.geometry.normal = core.Point(1, 0, 0)
            result = self.ctx.call('datum.plane-on-path', data)
            self.assertEqual(result['status'], 'fail')
            self.assertFalse(result['success'])
            self.assertIn('add', calls)
            calls.clear()
            with self.assertRaisesRegex(ValueError, 'clamping'):
                self.ctx.call('datum.plane-on-path', dict(data, position={'mode': 'length', 'value': '51 mm'}))
            self.assertEqual(calls, [])
            self.root.constructionPlanes.createInput = lambda: NS()
            result = self.ctx.call('datum.plane-on-path', data)
            self.assertEqual(result['status'], 'blocked')
            self.assertFalse(result['success'])


class AssemblyFrameTests(unittest.TestCase):
    def setUp(self):
        self.ctx = assembly.Context()

    def test_nested_absolute_pose_uses_parent_inverse_and_actual_readback(self):
        ctx = self.ctx
        parent = ctx.entities['A:1']
        parent._transform = matrix([0, -1, 0, 10, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
        class NestedNative(assembly.Occurrence):
            @assembly.Occurrence.transform2.setter
            def transform2(self, value):
                raise RuntimeError('transform overrides require a root-context proxy')
        native = NestedNative(ctx, ctx.entities['B'])
        nested = RootProxy(ctx, parent, native)
        ctx.root.allOccurrences.values.append(nested)
        ctx.entities['nested'] = nested
        pose = [1, 0, 0, 20, 0, 1, 0, 30, 0, 0, 1, 0, 0, 0, 0, 1]
        result = ctx.call('occurrence.transform', {'schemaVersion': 1, 'occurrence': 'nested', 'placement': {'matrix': pose, 'translationUnits': 'mm'}})
        self.assertEqual(result['actual'][3:12:4], [2, 3, 0])
        self.assertEqual(result['localTransform'][3:12:4], [3, 8, 0])
        self.assertEqual(native.transform2.asArray(), IDENTITY)
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(ctx.trace, ['transform', 'snapshot'])

    def test_reflection_rejected_before_transform(self):
        pose = list(IDENTITY)
        pose[0] = -1
        with self.assertRaisesRegex(ValueError, 'reflected'):
            self.ctx.call('occurrence.transform', {'occurrence': 'A:1', 'placement': {'matrix': pose, 'translationUnits': 'mm'}})
        self.assertEqual(self.ctx.trace, [])

    def test_nested_native_grounded_getter_is_never_used(self):
        ctx = self.ctx
        native = assembly.Occurrence(ctx, ctx.entities['B'])
        native.isGroundToParent = False
        class Native:
            component = native.component
            name = native.name
            _transform = native.transform2
            isGroundToParent = False
            @property
            def transform2(self):
                return self._transform
            @property
            def isGrounded(self):
                raise RuntimeError('SDK rejects unqualified nested isGrounded')
        native = Native()
        nested = RootProxy(ctx, ctx.entities['A:1'], native)
        ctx.root.allOccurrences.values.append(nested)
        ctx.entities['nested'] = nested
        result = ctx.call('occurrence.transform', {'schemaVersion': 1, 'occurrence': 'nested', 'placement': {}})
        self.assertEqual(result['status'], 'pass')
        native.isGroundToParent = True
        with self.assertRaisesRegex(ValueError, 'Unground'):
            ctx.call('occurrence.transform', {'occurrence': 'nested', 'placement': {}})

    def test_joint_primary_axis_is_z_and_signed_motion_vector_is_preserved(self):
        ctx = self.ctx
        ref = ctx.call('joint.revolute', {'name': 'j', 'occurrenceOne': 'A:1', 'occurrenceTwo': 'B:1', 'point': 'origin', 'axis': 'Z'})['joint']
        joint = ctx.resolve(ref)
        joint.geometry = NS(origin=NS(x=1, y=2, z=3), primaryAxisVector=NS(x=0, y=-1, z=0),
                            secondaryAxisVector=NS(x=1, y=0, z=0), thirdAxisVector=NS(x=0, y=0, z=1))
        joint.jointMotion.rotationAxisVector = NS(x=0, y=-1, z=0)
        result = ctx.call('joint.frame', {'joint': ref})
        self.assertEqual(result['frames'][0]['matrix'], [1, 0, 0, 1, 0, 0, -1, 2, 0, 1, 0, 3, 0, 0, 0, 1])
        self.assertEqual(result['motionAxes']['rotationAxisVector'], [0, -1, 0])
        self.assertEqual(result['limits']['rotation']['units'], 'rad')

    def test_rigid_geometry_unknown_is_not_an_invented_identity(self):
        ctx = self.ctx
        ref = ctx.call('joint.rigid', {'name': 'j', 'occurrenceOne': 'A:1', 'occurrenceTwo': 'B:1'})['joint']
        result = ctx.call('joint.frame', {'joint': ref})
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['frames'], [])

    def test_invalid_frame_joint_limits_leave_no_helper_mutations(self):
        with self.assertRaises(ValueError):
            self.ctx.call('joint.revolute', {'name': 'j', 'occurrenceOne': 'A:1', 'occurrenceTwo': 'B:1',
                'frame': 'root', 'associativity': 'snapshot', 'limits': {'rotation': {'minimumValue': '20 deg', 'maximumValue': '10 deg'}}, 'confirm': True})
        self.assertEqual(self.ctx.trace, [])

    def test_shared_parent_policy_and_datum_alignment(self):
        ctx = self.ctx
        parent, native = ctx.entities['A:1'], ctx.entities['B:1']
        nested = RootProxy(ctx, parent, native)
        ctx.root.allOccurrences.values.append(nested)
        ctx.entities['nested'] = nested
        with self.assertRaisesRegex(ValueError, 'allInstances'):
            ctx.call('occurrence.transform', {'occurrence': 'nested', 'placement': {}})
        self.assertEqual(ctx.trace, [])
        native.component.attributes = core.Attributes()
        ctx.root.attributes = core.Attributes()
        group = ctx.ns['_CAD_FRAME_GROUP']
        import json
        native.component.attributes.add(group, 'source', json.dumps({'matrix': [1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}))
        ctx.root.attributes.add(group, 'target', json.dumps({'matrix': [0, -1, 0, 10, 1, 0, 0, 3, 0, 0, 1, 0, 0, 0, 0, 1]}))
        result = ctx.call('occurrence.align', {'schemaVersion': 1, 'occurrence': 'nested',
            'source': {'occurrence': 'nested', 'datum': 'source'}, 'target': {'component': 'root', 'datum': 'target'}, 'sharedParentPolicy': 'allInstances'})
        self.assertEqual(result['actual'], [0, -1, 0, 10, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1])
        self.assertEqual(len(result['affected']), 2)

    def test_full_joint_pins_z_axis_and_reads_back_motion_axis(self):
        ctx = self.ctx
        axis = assembly.Entity('ConstructionAxis', 'axis', parentComponent=ctx.root,
                               geometry=NS(objectType='adsk::core::InfiniteLine3D',
                                           origin=NS(x=0, y=0, z=0), direction=NS(x=1, y=0, z=0)))
        ctx.entities['axis'] = axis
        result = ctx.call('joint.revolute', {'schemaVersion': 1, 'name': 'j', 'occurrenceOne': 'A:1',
            'occurrenceTwo': 'B:1', 'point': 'origin', 'axis': {'ref': 'axis'}})
        self.assertEqual(result['directionDiagnostics']['actualRoot'], [1, 0, 0])
        self.assertEqual(result['status'], 'pass')
        self.assertFalse(result['asBuilt'])
        self.assertFalse(result['posePreserved'])
        # A full Joint (not AsBuiltJoint) in root.joints, and a pinned JointOrigin
        # in each input occurrence's component.
        self.assertEqual(ctx.root.joints.count, 1)
        self.assertEqual(ctx.root.asBuiltJoints.count, 0)
        self.assertEqual(ctx.entities['A'].jointOrigins.count, 1)
        self.assertEqual(ctx.entities['B'].jointOrigins.count, 1)

    def test_native_custom_axis_negative_sign_diagnostic(self):
        ctx = self.ctx
        axis = assembly.Entity('ConstructionAxis', 'axis', parentComponent=ctx.root,
                               geometry=NS(objectType='adsk::core::InfiniteLine3D',
                                           origin=NS(x=0, y=0, z=0), direction=NS(x=0, y=0, z=-1)))
        ctx.entities['axis'] = axis
        original = ctx.root.joints.add

        def add(inp):
            joint = original(inp)
            joint.jointMotion.rotationAxisVector = NS(x=0, y=0, z=1)
            return joint
        ctx.root.joints.add = add
        result = ctx.call('joint.revolute', {'schemaVersion': 1, 'name': 'j', 'occurrenceOne': 'A:1',
            'occurrenceTwo': 'B:1', 'point': 'origin', 'axis': {'ref': 'axis'}})
        self.assertEqual(result['status'], 'fail')
        self.assertFalse(result['success'])
        self.assertEqual(result['directionDiagnostics']['signedDot'], -1)
        self.assertEqual(ctx.root.joints.count, 1)


if __name__ == '__main__':
    unittest.main()
