"""Execute every io manual example with offline API fixtures, never live Fusion.

Filesystem and units are controlled stubs; passing is not native geometry validation.
"""
import copy
import json
from pathlib import Path
import types
import unittest

import io_test
import styles_test


MANUAL = json.loads((io_test.ROOT / 'src/manual/io.json').read_text())


class ManualIOTests(unittest.TestCase):
    def fixture(self):
        fixture = styles_test.StyleTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        for body in (fixture.body, fixture.other):
            body.isLightBulbOn = True
            body.isVisible = True
            body.preciseBoundingBox = copy.deepcopy(fixture.root.boundingBox)
        for occurrence in fixture.occurrences:
            occurrence.isReferencedComponent = False
            occurrence.bRepBodies = io_test.Items()
        fixture.path = lambda name: str(fixture.folder / name)
        fixture.ctx.ref = lambda e: fixture.module.CadContext.ref(fixture.ctx, e)
        fixture.ctx._proxy = lambda e, occurrence: e
        fixture.ctx.describe = lambda e: fixture.module.CadContext.describe(fixture.ctx, e)
        fixture.ctx.value = lambda expression: expression
        planes = io_test.Items()
        fixture.root.constructionPlanes = planes
        plane = io_test.entity('ConstructionPlane', 'XZ')
        plane.parentComponent = fixture.root
        fixture.entities['XZ'] = plane
        planes.createInput = lambda: types.SimpleNamespace(setByOffset=lambda p, v: True)

        def add_plane(inp):
            created = io_test.entity('ConstructionPlane', 'New plane')
            created.parentComponent = fixture.root
            planes.values.append(created)
            return created

        planes.add = add_plane
        sections = io_test.Items()
        sections.createInput = lambda plane, offset: (plane, offset)

        def add_section(inp):
            created = io_test.entity('SectionAnalysis', 'New section')
            sections.values.append(created)
            return created

        sections.add = add_section
        fixture.design.analyses = types.SimpleNamespace(sectionAnalyses=sections, isLightBulbOn=True)
        canvas = io_test.entity('Canvas', 'Canvas')
        canvas.transform = io_test.Matrix()
        fixture.entities['Canvas'] = canvas
        fixture.library('appearance')
        fixture.app.materialLibraries.item(0).materials = io_test.Items([
            types.SimpleNamespace(id='foreign-material', name='Foreign physical')])
        fixture.design.materials.addByCopy = lambda item, name: types.SimpleNamespace(
            id='copied-material', name=name, appearance=fixture.base)
        return fixture

    def inputs(self, fixture, operation, example):
        def output(op, **data):
            return {'result': fixture.call(op, **data)}

        def input_file(name):
            path = fixture.folder / name
            path.write_bytes(b'offline-fixture-not-a-real-cad-file')
            return str(path)

        bodies = [fixture.ctx.describe(e) for e in (fixture.body, fixture.other)]
        refs = {
            'bodies': {'result': {'entities': bodies}},
            'faces': {'result': {'entities': [fixture.ctx.describe(fixture.face)]}},
            'selection': {'result': {'selections': [{'entity': fixture.ctx.describe(fixture.entities['Canvas'])}]}},
            'save': output('camera.save'),
            'styles': output('appearance.list'),
            'materials': output('material.list'),
            'libraryStyles': output('appearance.list', library='loaded-library'),
            'libraryMaterials': output('material.list', library='loaded-library'),
        }
        # Earlier result paths are real handler outputs; only entity discovery uses
        # describe fixtures because this test targets the io command family.
        if operation == 'visibility.restore':
            refs['hide'] = output('visibility.hide', refs=['Body'])
        if operation == 'view.compare':
            refs['pack'] = output('shot.pack', shots=[
                {'path': fixture.path('pair-left.png')}, {'path': fixture.path('pair-right.png')}])
        if operation == 'checkpoint.inspect':
            input_file('candidate.f3d')
            refs['checkpoints'] = output('checkpoint.list', directory=str(fixture.folder))
        if operation == 'checkpoint.open':
            refs['checkpoint'] = output('checkpoint.create', path=fixture.path('open.f3d'))
        if operation == 'export.verify' and example['data'].get('reimport'):
            refs['step'] = output('export.step', path=fixture.path('verify.step'), ref='root')
        if operation == 'section.view' and example['data']['mode'] in ('show', 'hide'):
            fixture.call('section.view', mode='create', name=example['data']['name'], plane='XZ')

        def resolve(value):
            if isinstance(value, list):
                return [resolve(v) for v in value]
            if isinstance(value, dict):
                if '$ref' in value:
                    self.assertEqual(set(value), {'$ref'})
                    result = refs
                    for key in value['$ref'].split('.'):
                        result = result[int(key)] if isinstance(result, list) else result[key]
                    return copy.deepcopy(result)
                return {k: resolve(v) for k, v in value.items()}
            if isinstance(value, str) and value.startswith('/tmp/fmcad-io'):
                return str(fixture.folder) + value[len('/tmp/fmcad-io'):]
            return value

        data = resolve(example['data'])
        if operation == 'import.file':
            Path(data['path']).write_bytes(b'offline-import-fixture')
        if data.get('overwrite'):
            Path(data['path']).write_bytes(b'previous-file')
        return data

    def test_every_example_executes_against_handler_stubs(self):
        executed = set()
        count = 0
        for operation, entry in MANUAL.items():
            for example in entry['examples']:
                with self.subTest(operation=operation, example=example['label']):
                    fixture = self.fixture()
                    data = self.inputs(fixture, operation, example)
                    result = fixture.call(operation, **data)
                    self.assertIsInstance(result, dict)
                    json.dumps(result, allow_nan=False)
                    if operation.startswith('camera.'):
                        self.assertIn('state', result)
                    elif operation.startswith('visibility.'):
                        self.assertEqual(set(result), {'restoreState', 'items', 'limitations'})
                    elif operation.startswith(('appearance.', 'material.')):
                        self.assertIn('items', result)
                        if operation.endswith('.list'):
                            self.assertEqual(set(result), {'kind', 'items', 'library', 'libraries', 'affected', 'count'})
                            self.assertEqual(result['count'], 0)
                        else:
                            state_keys = {'ref', 'scope', 'definition', 'appearance', 'appearanceSource',
                                          'appearanceOverride', 'appearanceOverrideScope', 'material',
                                          'materialReadFrom', 'materialSource', 'materialInheritance'}
                            self.assertEqual(set(result['items'][0]), state_keys)
                            if operation.endswith('.inspect'):
                                self.assertTrue(all(r['before'] == r['after'] for r in result['affected']))
                            if operation.endswith('.assign'):
                                self.assertIn('copiedStyle', result)
                                self.assertIn('previous', result)
                    elif operation == 'section.view':
                        self.assertIn('entity' if data['mode'] == 'helper' else 'ref', result)
                    elif operation == 'reference.image':
                        self.assertEqual(result['calibration'], {'lengthCm': 4, 'scaleFactor': 2, 'anchorCm': [10, 20]})
                        self.assertEqual(len(result['transform']), 9)
                    elif operation == 'export.verify':
                        self.assertEqual('comparison' in result, data.get('reimport', False))
                        self.assertFalse(result['geometryVerified'])
                    count += 1
                    executed.add(operation)
        self.assertEqual(executed, set(MANUAL))
        self.assertEqual(count, sum(len(entry['examples']) for entry in MANUAL.values()))

    def test_verify_close_failure_still_restores_prior_activation(self):
        fixture = self.fixture()
        path = fixture.path('verify.step')
        fixture.call('export.step', path=path)
        original = fixture.app.importManager.importToNewDocument

        def import_with_failed_close(options):
            doc = original(options)
            doc.close = lambda save: False
            return doc

        fixture.app.importManager.importToNewDocument = import_with_failed_close
        with self.assertRaisesRegex(RuntimeError, 'Close verification'):
            fixture.call('export.verify', path=path, reimport=True)
        self.assertIs(fixture.app.activeDocument, fixture.doc)

    def test_shot_restore_failure_reports_image_failure_as_primary(self):
        fixture = self.fixture()
        fixture.viewport.fail_image = True

        def fail_restore(*args, **kwargs):
            raise RuntimeError('injected restore failure')

        fixture.module._io_camera_apply = fail_restore
        with self.assertRaisesRegex(RuntimeError, '^I/O cleanup failed: ') as raised:
            fixture.call('shot.pack', shots=[{'path': fixture.path('failed.png')}])
        payload = json.loads(str(raised.exception).split(': ', 1)[1])
        self.assertIn('Save image', payload['primaryError']['message'])
        self.assertEqual(payload['primaryError']['message'], str(raised.exception.__cause__))
        self.assertEqual(payload['cleanupErrors'], [{'action': 'Restore original camera',
            'type': 'RuntimeError', 'message': 'injected restore failure'}])


if __name__ == '__main__':
    unittest.main()
