"""Offline safety tests for the native fixture generator; not Fusion qualification."""
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / 'tests/native/generic-controls/generate.py'
IDENTITY = {
    'name': 'FmcadGenericControlsScratch',
    'projectId': 'project-test',
    'folderId': 'folder-test',
    'fileId': 'file-test',
    'creationId': 'creation-test',
    'version': 1,
    'saved': True,
    'isComplete': True,
    'isReadOnly': False,
}


class FakeOccurrence:
    def __init__(self, name):
        self.name = name
        self.isValid = True
        self.isReferencedComponent = False
        self.deleted = False

    def deleteMe(self):
        self.deleted = True
        self.isValid = False
        return True


class FakeFmcad:
    def __init__(self):
        self.calls = []
        self.occurrences = {}
        self.components = 0

    def call(self, operation, data, component=None):
        self.calls.append((operation, data, component))
        if operation == 'document.status':
            return dict(IDENTITY)
        if operation == 'component.inspect':
            return {'bodies': [], 'occurrences': []}
        if operation == 'component.create':
            self.components += 1
            token = 'owned-' + str(self.components)
            occurrence = FakeOccurrence(data['name'])
            self.occurrences[token] = occurrence
            return {
                'component': {'kind': 'component', 'token': 'component-' + str(self.components)},
                'occurrence': {'kind': 'occurrence', 'token': token},
            }
        if operation == 'sketch.create':
            return {'sketch': {'kind': 'sketch', 'token': 'sketch-' + str(self.components)}}
        if operation.startswith(('shape.', 'sketch.')):
            return {'status': 'fake-only'}
        raise AssertionError('Unexpected fake operation: ' + operation)

    def resolve(self, reference, kind):
        if kind != 'occurrence' or reference.get('token') not in self.occurrences:
            raise ValueError('unknown occurrence token')
        return self.occurrences[reference['token']]


def prepare(args, fake=None):
    namespace = {'__name__': 'generic_controls_native_generator_test'}
    exec(compile(GENERATOR.read_text(), str(GENERATOR), 'exec'), namespace)
    namespace['ARGS'] = args
    namespace['FMCAD'] = fake or FakeFmcad()
    return namespace


def fixture_args(**extra):
    return {
        'projectId': IDENTITY['projectId'], 'folderId': IDENTITY['folderId'],
        'fileId': IDENTITY['fileId'], 'creationId': IDENTITY['creationId'],
        'version': IDENTITY['version'],
        'fixturePrefix': 'TEST1234', **extra,
    }


class NativeGenericFixtureGeneratorTests(unittest.TestCase):
    def test_generation_without_explicit_consent_stops_before_mutation(self):
        fake = FakeFmcad()
        namespace = prepare(fixture_args(mode='generate'), fake)
        with self.assertRaisesRegex(RuntimeError, 'confirmNativeFixtureGeneration'):
            namespace['run'](None)
        self.assertEqual([row[0] for row in fake.calls], ['document.status'])

    def test_generation_requires_the_exact_pinned_identity_before_mutation(self):
        fake = FakeFmcad()
        args = fixture_args(mode='generate', confirmNativeFixtureGeneration=True)
        args['fileId'] = 'different-file'
        namespace = prepare(args, fake)
        with self.assertRaisesRegex(RuntimeError, 'identity mismatch for fileId'):
            namespace['run'](None)
        self.assertEqual(fake.components, 0)

    def test_generation_uses_unique_owned_components_and_never_claims_native_qualification(self):
        fake = FakeFmcad()
        namespace = prepare(fixture_args(
            mode='generate', confirmNativeFixtureGeneration=True), fake)
        report = namespace['run'](None)

        self.assertEqual(report['status'], 'generated')
        self.assertEqual(report['nativeModelQualification'], 'not performed')
        self.assertFalse(report['automaticCleanup'])
        self.assertEqual(len(report['ownedOccurrences']), 18)
        names = [row['name'] for row in report['ownedOccurrences']]
        self.assertEqual(len(names), len(set(names)))
        self.assertTrue(all(name.startswith('FMCAD_GC_TEST1234_') for name in names))
        self.assertFalse(any(operation.startswith('document.save') for operation, _, _ in fake.calls))

    def test_cleanup_deletes_only_exact_owned_occurrences(self):
        fake = FakeFmcad()
        generated = prepare(fixture_args(
            mode='generate', confirmNativeFixtureGeneration=True), fake)['run'](None)
        unrelated = FakeOccurrence('UserComponent')
        fake.occurrences['user-token'] = unrelated

        namespace = prepare(fixture_args(
            mode='cleanup', confirmOwnedFixtureCleanup=True,
            ownedOccurrences=generated['ownedOccurrences']), fake)
        report = namespace['run'](None)

        self.assertEqual(report['status'], 'cleaned')
        self.assertEqual(report['deletedCount'], len(generated['ownedOccurrences']))
        self.assertTrue(unrelated.isValid)
        self.assertFalse(any(fake.occurrences[row['occurrence']['token']].isValid
                             for row in generated['ownedOccurrences']))

    def test_cleanup_rejects_a_foreign_ledger_entry_before_deleting_anything(self):
        fake = FakeFmcad()
        generated = prepare(fixture_args(
            mode='generate', confirmNativeFixtureGeneration=True), fake)['run'](None)
        first = generated['ownedOccurrences'][0]
        bad_entry = {'name': 'UserComponent',
                     'occurrence': {'kind': 'occurrence', 'token': 'foreign-token'}}
        fake.occurrences['foreign-token'] = FakeOccurrence('UserComponent')
        entries = generated['ownedOccurrences'][:2] + [bad_entry]
        namespace = prepare(fixture_args(
            mode='cleanup', confirmOwnedFixtureCleanup=True,
            ownedOccurrences=entries), fake)

        with self.assertRaisesRegex(RuntimeError, 'outside this fixture run prefix'):
            namespace['run'](None)
        self.assertTrue(fake.occurrences[first['occurrence']['token']].isValid)
        self.assertTrue(fake.occurrences['foreign-token'].isValid)


if __name__ == '__main__':
    unittest.main()
