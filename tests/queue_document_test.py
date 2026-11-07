import importlib.util
import pathlib
import types
import unittest

spec = importlib.util.spec_from_file_location('queue_document', pathlib.Path(__file__).parents[1] / 'assets' / 'queue_document.py')
qd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qd)
identity = {}
exec(compile((pathlib.Path(__file__).parents[1] / 'assets/cad/identity.py').read_text(), '<identity>', 'exec'), identity)
if '_document_data_file' in identity:
    qd._document_data_file = identity['_document_data_file']
NS = types.SimpleNamespace


class Collection:
    def __init__(self, *values):
        self.values = list(values)

    @property
    def count(self):
        return len(self.values)

    def item(self, index):
        return self.values[index]


def document(name):
    component = NS(id=name + '-component', name=name, revisionId='revision-1', bRepBodies=Collection(),
                   sketches=Collection(), features=Collection())
    component.features.deriveFeatures = Collection()
    parameter = NS(name='length', expression='1 mm', value=0.1, unit='mm')
    design = NS(allComponents=Collection(component), allParameters=Collection(parameter),
                timeline=NS(count=0, markerPosition=0))
    doc = NS(creationId=name + '-editor', name=name, isSaved=True, isModified=True,
             dataFile=NS(id=name + '-file', versionNumber=1),
             products=NS(itemByProductType=lambda _: design), allDocumentReferences=Collection())
    return doc, design, component, parameter


class DocumentSnapshots(unittest.TestCase):
    def test_other_file_changes_do_not_invalidate_target(self):
        a, _, _, _ = document('A')
        b, _, bc, bp = document('B')
        app = NS(documents=Collection(a, b))
        first = qd._qd_capture(app, {'creationId': a.creationId})
        bc.revisionId = 'revision-2'
        bp.value = 12
        b.dataFile.versionNumber = 2
        second = qd._qd_capture(app, {'creationId': a.creationId})
        self.assertEqual(first['status'], 'complete')
        self.assertEqual(first['fingerprint'], second['fingerprint'])

    def test_unsaved_change_on_already_dirty_document_returns_fresh_parameters(self):
        a, _, component, parameter = document('A')
        app = NS(documents=Collection(a))
        first = qd._qd_capture(app, {'creationId': a.creationId})
        component.revisionId = 'revision-2'
        parameter.expression = '9 mm'
        parameter.value = 0.9
        second = qd._qd_capture(app, {'creationId': a.creationId})
        self.assertNotEqual(first['fingerprint'], second['fingerprint'])
        self.assertTrue(first['state']['identity']['isModified'])
        self.assertTrue(second['state']['identity']['isModified'])
        self.assertEqual(second['state']['parameters'][0]['expression'], '9 mm')

    def test_geometry_revision_and_parameter_only_changes_are_both_detected(self):
        a, _, component, parameter = document('A')
        app = NS(documents=Collection(a))
        first = qd._qd_capture(app, {'name': 'A'})
        component.revisionId = 'geometry-changed'
        second = qd._qd_capture(app, {'name': 'A'})
        self.assertNotEqual(first['fingerprint'], second['fingerprint'])
        parameter.value = 55
        third = qd._qd_capture(app, {'name': 'A'})
        self.assertNotEqual(second['fingerprint'], third['fingerprint'])

    def test_changed_reference_source_invalidates_dependent_document(self):
        assembly, _, _, _ = document('Assembly')
        source, _, source_component, _ = document('Source')
        assembly.allDocumentReferences = Collection(NS(dataFile=source.dataFile, referencedDocument=source))
        app = NS(documents=Collection(assembly, source))
        first = qd._qd_capture(app, {'name': 'Assembly'})
        source_component.revisionId = 'source-changed'
        second = qd._qd_capture(app, {'name': 'Assembly'})
        self.assertNotEqual(first['fingerprint'], second['fingerprint'])

    def test_parameter_only_derive_is_observed_even_when_document_references_are_empty(self):
        a, _, component, _ = document('A')
        source, _, source_component, _ = document('Source')
        component.features.deriveFeatures = Collection(NS(isSuppressed=False,
            documentReference=NS(dataFile=source.dataFile, referencedDocument=source)))
        app = NS(documents=Collection(a, source))
        first = qd._qd_capture(app, {'name': 'A'})
        source_component.revisionId = 'source-changed'
        second = qd._qd_capture(app, {'name': 'A'})
        self.assertNotEqual(first['fingerprint'], second['fingerprint'])

    def test_missing_ambiguous_and_unavailable_state_never_means_unchanged(self):
        a, design, _, _ = document('A')
        app = NS(documents=Collection(a))
        self.assertEqual(qd._qd_capture(app, {'name': 'missing'})['status'], 'target-unavailable')
        app.documents.values.append(a)
        self.assertEqual(qd._qd_capture(app, {'name': 'A'})['status'], 'target-unavailable')
        app.documents.values.pop()
        design.allParameters = None
        self.assertEqual(qd._qd_capture(app, {'name': 'A'})['status'], 'unavailable')


if __name__ == '__main__':
    unittest.main()
