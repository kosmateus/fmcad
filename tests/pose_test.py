"""GM18 offline tests: pose manifest save/list/apply/evaluate with a stubbed context."""
import types
import unittest

import model_test as model

NAMESPACE = dict(model.namespace)
NAMESPACE['CAD_HANDLERS'] = dict(model.HANDLERS)
exec(compile((model.ROOT / 'assets/cad/pose.py').read_text(), 'pose.py', 'exec'), NAMESPACE)
HANDLERS = NAMESPACE['CAD_HANDLERS']


class Attribute:
    def __init__(self, value):
        self.value = value


class AttributeStore:
    def __init__(self):
        self.store = {}

    def itemByName(self, group, name):
        value = self.store.get((group, name))
        return Attribute(value) if value is not None else None

    def add(self, group, name, value):
        self.store[(group, name)] = value
        return Attribute(value)


class PoseContext(model.Context):
    def __init__(self):
        super().__init__()
        self.doc = types.SimpleNamespace(name='Doc', creationId='id-1')
        self.root.attributes = AttributeStore()
        self.joints = {}
        self.params = {}
        self.fail_apply_after_mutation = False
        joint = model.Entity('Joint', name='joint-1')
        joint_entity = model.Entity('Joint', name='Joint')
        body = model.Entity('BRepBody', name='body-1')
        body.isLightBulbOn = False
        self.entities['joint-1'] = joint_entity
        self.entities['body-1'] = body
        self._joint = joint

    def _key(self, ref):
        if isinstance(ref, dict):
            return ref.get('token') or ref.get('name')
        return ref

    def resolve(self, ref, kind=None):
        key = ref if isinstance(ref, str) else ref.get('token', ref.get('name'))
        if key not in self.entities:
            raise ValueError('Reference not found: ' + str(key))
        return self.entities[key]

    def call(self, op, data):
        if op == 'joint.inspect':
            return dict(self.joints.setdefault(self._key(data['joint']), {'rotationValue': 0.0}))
        if op == 'joint.drive':
            state = {}
            if 'rotation' in data:
                value = self.angle(data['rotation'])
                if value < 0:
                    raise ValueError('rotation below minimum')
                state['rotationValue'] = value
            if 'slide' in data:
                state['slideValue'] = self.length(data['slide'])
            self.joints[self._key(data['joint'])] = state
            if self.fail_apply_after_mutation:
                self.fail_apply_after_mutation = False
                raise RuntimeError('joint setter failed after mutation')
            return dict(state)
        if op == 'param.inspect':
            return {'parameters': [{'name': n, 'expression': self.params.get(n, '1 mm')}
                                   for n in data.get('names', [])]}
        if op == 'param.apply':
            for spec in data['parameters']:
                self.params[spec['name']] = spec['expression']
            return {'parameters': [{'name': s['name'], 'expression': s['expression']} for s in data['parameters']]}
        raise ValueError('unexpected call ' + op)


class PoseTests(unittest.TestCase):
    def setUp(self):
        self.ctx = PoseContext()

    def call(self, operation, data):
        return HANDLERS[operation](self.ctx, data)

    def save_service_pose(self, **extra):
        data = {'schemaVersion': 1, 'frame': 'component', 'name': 'Service', 'revision': 1,
                'joints': [{'joint': {'token': 'joint-1'}, 'rotation': '30 deg'}],
                'parameters': [{'name': 'wall', 'expression': '2 mm'}],
                'visibility': [{'ref': {'token': 'body-1'}, 'visible': False}],
                'fillState': 'EMPTY', 'springState': 'COCKED',
                'routeVariant': 'service-route', 'service': {'disconnections': ['tank-dock']}}
        data.update(extra)
        return data

    def test_save_list_and_manifest_roundtrip(self):
        result = self.call('pose.save', self.save_service_pose())
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['name'], 'Service')
        self.assertEqual(result['revision'], 1)
        self.assertEqual(result['manifest']['schema'], 'fmcad.pose.manifest.v1')
        self.assertEqual(result['manifest']['fillState'], 'EMPTY')
        self.assertEqual(result['manifest']['springState'], 'COCKED')
        listed = self.call('pose.list', {'schemaVersion': 1, 'frame': 'component'})
        self.assertEqual(listed['count'], 1)
        self.assertEqual(listed['poses'][0]['name'], 'Service')

    def test_save_on_existing_requires_update(self):
        self.call('pose.save', self.save_service_pose())
        with self.assertRaises(ValueError):
            self.call('pose.save', self.save_service_pose())
        data = self.save_service_pose()
        data.pop('revision')
        updated = self.call('pose.save', dict(data, onExisting='update', confirm=True))
        self.assertEqual(updated['revision'], 2)

    def test_apply_leaves_state_and_reports_actual(self):
        self.call('pose.save', self.save_service_pose())
        result = self.call('pose.apply', {'schemaVersion': 1, 'frame': 'component', 'name': 'Service'})
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['leftApplied'])
        self.assertEqual(result['unapplied'], [])
        self.assertAlmostEqual(self.ctx.joints['joint-1']['rotationValue'], self.ctx.angle('30 deg'), places=9)
        self.assertFalse(self.ctx.entities['body-1'].isLightBulbOn)
        self.assertEqual(self.ctx.params['wall'], '2 mm')

    def test_apply_rejects_incompatible_document(self):
        self.call('pose.save', self.save_service_pose())
        self.ctx.doc = types.SimpleNamespace(name='Doc', creationId='id-2')
        with self.assertRaises(ValueError):
            self.call('pose.apply', {'schemaVersion': 1, 'frame': 'component', 'name': 'Service'})

    def test_apply_rejects_stale_refs(self):
        self.call('pose.save', self.save_service_pose())
        del self.ctx.entities['body-1']
        with self.assertRaises(ValueError):
            self.call('pose.apply', {'schemaVersion': 1, 'frame': 'component', 'name': 'Service'})

    def test_evaluate_restores_previous_state(self):
        self.call('pose.save', self.save_service_pose())
        self.ctx.joints['joint-1'] = {'rotationValue': 0.25}
        self.ctx.entities['body-1'].isLightBulbOn = True
        result = self.call('pose.evaluate', {'schemaVersion': 1, 'frame': 'component', 'name': 'Service'})
        self.assertTrue(result['restored'])
        self.assertEqual(result['restoreErrors'], [])
        self.assertAlmostEqual(self.ctx.joints['joint-1']['rotationValue'], 0.25, places=9)
        self.assertTrue(self.ctx.entities['body-1'].isLightBulbOn)

    def test_evaluate_restore_failure_is_separate(self):
        self.call('pose.save', self.save_service_pose())
        self.ctx.joints['joint-1'] = {'rotationValue': -0.5}
        result = self.call('pose.evaluate', {'schemaVersion': 1, 'frame': 'component', 'name': 'Service'})
        self.assertFalse(result['restored'])
        self.assertTrue(result['restoreErrors'])
        self.assertEqual(result['status'], 'fail')

    def test_evaluate_restores_when_first_joint_setter_mutates_then_raises(self):
        self.call('pose.save', self.save_service_pose())
        self.ctx.joints['joint-1'] = {'rotationValue': 0.25}
        self.ctx.fail_apply_after_mutation = True
        result = self.call('pose.evaluate', {'schemaVersion': 1, 'frame': 'component', 'name': 'Service'})
        self.assertEqual(result['status'], 'fail')
        self.assertIn('setter failed after mutation', result['primaryError'])
        self.assertTrue(result['restored'])
        self.assertEqual(result['restoreErrors'], [])
        self.assertAlmostEqual(self.ctx.joints['joint-1']['rotationValue'], 0.25, places=9)

    def test_delete_removes_pose(self):
        self.call('pose.save', self.save_service_pose())
        result = self.call('pose.delete', {'schemaVersion': 1, 'frame': 'component', 'name': 'Service', 'confirm': True})
        self.assertTrue(result['deleted'])
        self.assertEqual(self.call('pose.list', {'schemaVersion': 1, 'frame': 'component'})['count'], 0)

    def test_fill_state_variants_change_declared_liquid_state(self):
        full = self.call('pose.save', self.save_service_pose(name='Full', fillState='FULL'))
        empty = self.call('pose.save', self.save_service_pose(name='Empty', fillState='EMPTY'))
        self.assertEqual(full['manifest']['fillState'], 'FULL')
        self.assertEqual(empty['manifest']['fillState'], 'EMPTY')
        self.assertNotEqual(full['manifest']['fillState'], empty['manifest']['fillState'])


if __name__ == '__main__':
    unittest.main()
