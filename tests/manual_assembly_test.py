"""Manual examples against actual handlers and offline fixtures, not Fusion geometry."""
import json
from pathlib import Path
import subprocess
import types
import unittest

import assembly_test as fixtures
import core_test as core_fixtures


ROOT = Path(__file__).resolve().parents[1]


def manual(family):
    return json.loads((ROOT / 'src/manual' / (family + '.json')).read_text())


def validate_manual(case, family):
    entries = manual(family)
    catalog = json.loads((ROOT / 'src/catalog' / (family + '.json')).read_text())
    case.assertEqual(set(entries), {operation for operation, entry in catalog.items() if not entry.get('internalOnly')})
    for operation, entry in entries.items():
        with case.subTest(operation=operation):
            case.assertEqual(set(entry), {'sections', 'examples', 'audit'})
            case.assertTrue(entry['examples'])
            case.assertIn('Return Contract', [section['title'] for section in entry['sections']])
            for section in entry['sections']:
                case.assertEqual(set(section), {'title', 'text'})
                case.assertTrue(all(isinstance(value, str) and value for value in section.values()))
            for example in entry['examples']:
                case.assertEqual(set(example), {'label', 'data', 'requires', 'output'})
                case.assertIsInstance(example['data'], dict)
                for field in ('label', 'requires', 'output'):
                    case.assertIsInstance(example[field], str)
                    case.assertTrue(example[field])
            audit = entry['audit']
            case.assertEqual(set(audit), {'sources', 'verified', 'tests', 'gaps', 'bugs'})
            for field in audit:
                case.assertIsInstance(audit[field], list)
            case.assertTrue(audit['sources'])
            case.assertTrue(audit['verified'])
            case.assertEqual(audit['gaps'], [])
            for source in audit['sources']:
                case.assertTrue((ROOT / source.split(':', 1)[0]).is_file(), source)
            for test in audit['tests']:
                case.assertTrue((ROOT / test).is_file(), test)
    # This validates the real outer schema only; handler execution below validates deeper inputs.
    script = """
const {validateCad} = require('./src/cad');
const manual = require('./src/manual/' + process.argv[1] + '.json');
for (const [operation, entry] of Object.entries(manual)) {
  for (const example of entry.examples) validateCad(operation, example.data);
}
"""
    result = subprocess.run(['node', '-e', script, family], cwd=ROOT, text=True, capture_output=True)
    case.assertEqual(result.returncode, 0, result.stderr)


class ManualAssemblyTests(unittest.TestCase):
    def context(self):
        ctx = fixtures.Context()
        # Nested destination examples exercise the real dispatch path; provide
        # the same occurrence-collection surface on definition components.
        for name in ('A', 'B'):
            ctx.entities[name].occurrences = fixtures.Occurrences(ctx, ctx.entities[name])
        feature = fixtures.Entity('ExtrudeFeature', 'AuditExtrude', isSuppressed=False,
                                  parentComponent=ctx.root)
        parameter = types.SimpleNamespace(name='d1', expression='2 mm', unit='cm', createdBy=feature)
        ctx.root.features.values.append(feature)
        ctx.design.allParameters.values.append(parameter)
        ctx.entities['AuditExtrude'] = feature
        body = fixtures.Entity('BRepBody', 'AuditBody', parentComponent=ctx.root)
        body.moveToComponent = lambda occurrence: body
        ctx.root.bRepBodies.values.append(body)
        ctx.entities['AuditBody'] = body
        # Supply the concrete native origins/geometry named by the published
        # regular-rigid example; keep the example's reference forms intact.
        origin_a = fixtures.JointOrigin(ctx.entities['A'])
        origin_a.entityToken = 'ORIGIN_A_TOKEN'
        ctx.entities['ORIGIN_A_TOKEN'] = origin_a
        ctx.entities['A'].jointOrigins.values.append(origin_a)
        for kind, name in (('ConstructionPoint', 'B_point'), ('ConstructionAxis', 'B_x'),
                           ('ConstructionAxis', 'B_z')):
            ctx.entities[name] = fixtures.Entity(kind, name, parentComponent=ctx.entities['B'])
        ref = ctx.call('joint.cylindrical', dict(name='FixtureJoint', occurrenceOne='A:1',
                       occurrenceTwo='B:1', point='origin', axis='Z'))['joint']
        # This fixture resolves aliases directly; a separate test uses real core alias persistence.
        ctx.entities['audit_joint'] = ctx.resolve(ref)
        ctx.created.clear()
        ctx.trace.clear()
        return ctx

    def test_catalog_coverage_metadata_and_outer_validator(self):
        validate_manual(self, 'assembly')
        self.assertEqual(len(manual('assembly')), 28)

    def test_every_example_through_actual_handler_and_return_keys(self):
        expected = {
            'component.inspect': {'component', 'bodies', 'occurrences'},
            'component.create': {'component', 'occurrence', 'bodies', 'atomic'},
            'component.from_bodies': {'component', 'occurrence', 'bodies', 'atomic'},
            'component.rename': {'component', 'affectsAllInstances'},
            'component.reparent': {'occurrence', 'worldPosePreserved', 'affectedPaths'},
            'occurrence.add': {'occurrence', 'component', 'copyMode', 'affectedPaths'},
            'occurrence.duplicate': {'occurrence', 'component', 'copyMode', 'affectedPaths'},
            'occurrence.transform': {'occurrence', 'snapshot', 'parametricExpressions', 'relationship'},
            'occurrence.align': {'occurrence', 'snapshot', 'parametricExpressions', 'relationship'},
            'assembly.ground': {'occurrence', 'grounded'},
            'assembly.unground': {'occurrence', 'grounded'},
            'assembly.rigid_group': {'rigidGroup'},
            'assembly.parts': {'parts', 'scope'},
            'feature.list': {'features'},
            'feature.suppress': {'feature', 'parameters'},
            'feature.unsuppress': {'feature', 'parameters'},
            'change.preview': {'feature', 'parameters', 'proposedName', 'applied', 'atomic', 'scope'},
            'feature.dependencies': {'parameters', 'coverage', 'limitations'},
            'history.check': {'timeline', 'markerPosition', 'recomputed', 'healthy', 'status', 'recursive', 'scope', 'allowSuppressed', 'coverage'},
            'history.recompute': {'timeline', 'markerPosition', 'recomputed', 'healthy', 'status', 'recursive', 'scope', 'allowSuppressed', 'coverage'},
        }
        count = 0
        for operation, entry in manual('assembly').items():
            for example in entry['examples']:
                with self.subTest(operation=operation, example=example['label']):
                    ctx = self.context()
                    output = ctx.call(operation, example['data'])
                    keys = expected.get(operation)
                    if operation.startswith('joint.'):
                        mode = operation.split('.')[1]
                        keys = {'joint', 'motionType', 'occurrences', 'limits', 'units',
                                'parametricExpressions', 'scope'}
                        if mode != 'rigid':
                            keys |= ({'rotationValue'} if mode == 'revolute' else {'slideValue'}
                                     if mode == 'slider' else {'rotationValue', 'slideValue'})
                        if mode in ('rigid', 'revolute', 'slider', 'cylindrical'):
                            keys |= {'type', 'asBuilt'}
                        if mode == 'rigid' and example['data'].get('mode') == 'regular':
                            keys |= {'mode', 'posePolicy', 'poses', 'originOne', 'originTwo',
                                     'requestedOccurrences', 'requested', 'linearTolerance',
                                     'angularTolerance', 'poseUnits', 'groundingPolicy', 'associativity'}
                        if mode == 'drive':
                            keys.update({'snapshot', 'coordinateReadback'})
                            evidence = output['coordinateReadback']
                            self.assertEqual(set(evidence), {'evaluated', 'beforeCapture'})
                            for key, prop, evaluate in (('rotation', 'rotationValue', ctx.angle),
                                                        ('slide', 'slideValue', ctx.length)):
                                if key in example['data']:
                                    self.assertEqual(evidence['evaluated'][prop], evaluate(example['data'][key]))
                                    self.assertEqual(evidence['beforeCapture'][prop], output[prop])
                        for state in output['limits'].values():
                            self.assertEqual(set(state), {'minimumValue', 'maximumValue', 'restValue',
                                'isMinimumValueEnabled', 'isMaximumValueEnabled', 'isRestValueEnabled', 'units'})
                    self.assertEqual(set(output), keys)
                    json.dumps(output, allow_nan=False)
                    count += 1
        self.assertGreater(count, 30)

    def test_joint_alias_example_uses_real_core_resolution(self):
        fixture = core_fixtures.CoreTests()
        fixture.setUp()
        joint = core_fixtures.Entity('AsBuiltJoint', 'NotTheAlias', fixture.root)
        fixture.register(joint)
        ref = fixture.ctx.ref(joint)
        output = fixture.ctx.call('entity.alias', {'ref': ref, 'alias': 'audit_joint'})
        self.assertEqual(output['ref'], ref)
        self.assertIs(fixture.ctx.resolve('audit_joint'), joint)
        with self.assertRaises(ValueError):
            fixture.ctx.resolve('NotTheAlias')

    def test_documented_create_to_inspect_to_drive_wiring(self):
        ctx = self.context()
        made = ctx.call('joint.slider', dict(name='Rail', occurrenceOne='A:1', occurrenceTwo='B:1',
                                            point='origin', axis='X'))
        inspected = ctx.call('joint.inspect', {'joint': made['joint']})
        driven = ctx.call('joint.drive', {'joint': inspected['joint'], 'slide': '10 mm'})
        self.assertEqual(driven['slideValue'], 1)
        script = """
const assert = require('node:assert/strict');
const {resolveReferences, validateBatch} = require('./src/batch');
const {catalog} = require('./src/cad');
const ref = {token:'offline-fixture-only',kind:'AsBuiltJoint'};
assert.deepEqual(resolveReferences({joint:{$ref:'hinge.result.joint'}}, {hinge:{result:{joint:ref}}}), {joint:ref});
assert.equal(validateBatch({runId:'manual-wiring',operations:[
  {id:'hinge',operation:'joint.revolute',data:{name:'Hinge',occurrenceOne:'A:1',occurrenceTwo:'B:1',point:'origin',axis:'Z'}},
  {id:'drive',operation:'joint.drive',data:{joint:{$ref:'hinge.result.joint'},rotation:'45 deg'}}
]},catalog).success,true);
"""
        result = subprocess.run(['node', '-e', script], cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
