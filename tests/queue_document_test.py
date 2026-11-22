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
    def test_numeric_parameter_fingerprint_is_unchanged(self):
        runtime = pathlib.Path(__file__).parents[1] / 'runtime/python/fmcad/adapters/fusion/legacy_queue_document.py'
        namespace = dict(identity)
        exec(compile(runtime.read_text(), str(runtime), 'exec'), namespace)
        for capture in (qd._qd_capture, namespace['_qd_capture']):
            doc, _, _, _ = document('A')
            result = capture(NS(documents=Collection(doc)), {'creationId': doc.creationId})
            with self.subTest(capture=capture.__module__ if hasattr(capture, '__module__') else 'runtime'):
                self.assertEqual(result['status'], 'complete')
                self.assertEqual(result['fingerprint'],
                                 '33e376a30cb4cb0fca465563126b083341559fe8f7e5269a541c5a6ce27784ce')

    def test_text_parameter_fingerprint_uses_inspection_value(self):
        runtime = pathlib.Path(__file__).parents[1] / 'runtime/python/fmcad/adapters/fusion/legacy_queue_document.py'
        namespace = dict(identity)
        exec(compile(runtime.read_text(), str(runtime), 'exec'), namespace)
        for capture in (qd._qd_capture, namespace['_qd_capture']):
            doc, design, _, numeric = document('A')
            text = NS(name='note', expression="'hello'", textValue='hello', unit='Text')
            design.allParameters = Collection(numeric, text)
            app = NS(documents=Collection(doc))
            with self.subTest(capture=capture.__module__ if hasattr(capture, '__module__') else 'runtime'):
                first = capture(app, {'creationId': doc.creationId})
                self.assertEqual(first['status'], 'complete')
                text_row = next(row for row in first['state']['parameters'] if row['name'] == 'note')
                self.assertEqual(text_row['value'], 'hello')
                text.textValue = 'changed'
                second = capture(app, {'creationId': doc.creationId})
                self.assertEqual(second['status'], 'complete')
                self.assertNotEqual(first['fingerprint'], second['fingerprint'])

    def test_saved_metadata_selects_exact_version_without_loading_design(self):
        root = pathlib.Path(__file__).parents[1]
        runtime = root / 'runtime/python/fmcad/adapters/fusion/legacy_queue_document.py'
        namespace = dict(identity)
        exec(compile(runtime.read_text(), str(runtime), 'exec'), namespace)
        for capture in (qd._qd_capture, namespace['_qd_capture']):
            older = NS(creationId='older', isSaved=True, dataFile=NS(id='lineage', versionNumber=1))
            newer = NS(creationId='newer', isSaved=True, dataFile=NS(id='lineage', versionNumber=2))
            app = NS(documents=Collection(older, newer))
            selector = {'kind': 'saved-document-metadata', 'fileId': 'lineage', 'version': 2}
            with self.subTest(capture=capture.__module__):
                result = capture(app, selector)
                self.assertEqual(result['status'], 'complete')
                self.assertEqual(result['state']['identity'],
                                 {'creationId': 'newer', 'fileId': 'lineage', 'version': 2, 'isSaved': True})
                duplicate = NS(creationId='duplicate', isSaved=True, dataFile=newer.dataFile)
                app.documents.values.append(duplicate)
                self.assertEqual(capture(app, selector)['matches'], 2)
                app.documents.values.pop()
                newer.isSaved = False
                self.assertEqual(capture(app, selector)['matches'], 0)
                app.documents.values.clear()
                self.assertEqual(capture(app, selector)['matches'], 0)

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
