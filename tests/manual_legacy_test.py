"""Actual legacy handlers under offline SDK stubs; no Fusion process is contacted."""
import contextlib
import io
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


def migrated_legacy(name):
    root = Path(__file__).resolve().parents[1] / 'runtime/python/fmcad/adapters/fusion'
    return (root / 'legacy_document.py').read_text() + '\n' + (root / name).read_text()


class LegacyManualContracts(unittest.TestCase):
    def setUp(self):
        self.app = types.SimpleNamespace(data=types.SimpleNamespace(), documents=[], activeProduct=None, activeDocument=None)
        core = types.ModuleType('adsk.core')
        core.Application = types.SimpleNamespace(get=lambda: self.app)
        core.ValueInput = types.SimpleNamespace(createByString=lambda value: value)
        fusion = types.ModuleType('adsk.fusion')
        fusion.Design = types.SimpleNamespace(cast=lambda value: value)
        fusion.DistanceUnits = types.SimpleNamespace(MillimeterDistanceUnits=0, CentimeterDistanceUnits=1, InchDistanceUnits=2)
        adsk = types.ModuleType('adsk')
        adsk.core, adsk.fusion = core, fusion
        self.modules = patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': core, 'adsk.fusion': fusion})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def load(self, name):
        namespace = {'__name__': 'offline_legacy_manual'}
        root = Path(__file__).resolve().parents[1]
        file = (root / 'runtime/python/fmcad/adapters/fusion/legacy_parameters.py'
                if name == 'legacy_parameters.py' else root / 'assets' / name)
        source = (migrated_legacy(name) if name == 'legacy_parameters.py' else
                  (root / 'runtime/python/fmcad/adapters/fusion/legacy_cloud.py').read_text()
                  if name == 'fusion_data_manager.py' else file.read_text())
        exec(compile(source, str(file), 'exec'), namespace)
        return namespace

    def output(self, function, *args):
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            function(*args)
        return stream.getvalue()

    def test_param_add_safe_padded_slots_and_documented_omission_defect(self):
        made = []

        class Parameters(list):
            def add(self, name, expression, unit, comment):
                made.append((name, expression, unit, comment))
                return types.SimpleNamespace(name=name, expression=expression, unit=unit)

        self.app.activeProduct = types.SimpleNamespace(userParameters=Parameters())
        doc = types.SimpleNamespace(name='Model', creationId='owned', activate=lambda: True)
        self.app.documents = [doc]
        self.app.activeDocument = doc
        ns = self.load('legacy_parameters.py')
        ns['OP'], ns['ARGS'] = 'param_add', ['wall', '3 mm', '', '', 'Model']
        self.assertIn('CREATED_PARAM', self.output(ns['run'], ''))
        self.assertEqual(made, [('wall', '3 mm', 'mm', '')])
        ns['ARGS'] = ['other', '3 mm', 'Model']
        self.assertIn('ERROR document commands require', self.output(ns['run'], ''))
        self.assertEqual(len(made), 1)

    def cloud_revisions(self):
        root = Path(__file__).resolve().parents[1]
        return [(root / 'tests/fixtures/history/parameters-a26222f.py.txt').read_text(),
                (root / 'runtime/python/fmcad/adapters/fusion/legacy_cloud.py').read_text()]

    def test_folder_delete_rejects_all_spellings_of_project_root(self):
        for revision, source in enumerate(self.cloud_revisions()):
            for path in ('', '/', '///'):
                with self.subTest(revision=revision, path=path):
                    deleted = []
                    root = types.SimpleNamespace(deleteMe=lambda: deleted.append('root') or False)
                    project = types.SimpleNamespace(name='Project', rootFolder=root)
                    data = types.SimpleNamespace(dataProjects=types.SimpleNamespace(asArray=lambda: [project]))
                    namespace = {}
                    exec(compile(source, 'cloud-fixture.py', 'exec'), namespace)
                    output = self.output(namespace['cmd_folder_delete'], data, 'Project', path)
                    self.assertEqual(deleted, ['root'] if revision == 0 and path else [])
                    if revision == 1 or not path:
                        self.assertIn('cannot delete project root', output)

    def test_file_move_preserves_success_but_rejects_false_acceptance(self):
        for revision, source in enumerate(self.cloud_revisions()):
            for accepted in (True, False):
                with self.subTest(revision=revision, accepted=accepted):
                    calls = []
                    def move(target):
                        calls.append(target)
                        return accepted
                    file = types.SimpleNamespace(name='Part', fileExtension='f3d', id='file-id', move=move)
                    root = types.SimpleNamespace(name='Root', dataFiles=types.SimpleNamespace(asArray=lambda: [file]))
                    project = types.SimpleNamespace(name='Project', rootFolder=root)
                    data = types.SimpleNamespace(dataProjects=types.SimpleNamespace(asArray=lambda: [project]))
                    namespace = {}
                    exec(compile(source, 'cloud-fixture.py', 'exec'), namespace)
                    output = self.output(namespace['cmd_file_move'], data, 'Project', '', 'Part', '')
                    self.assertEqual(calls, [root])
                    if revision == 0 or accepted:
                        self.assertEqual(output, 'MOVED_FILE id=file-id to=Root\nDONE\n')
                    else:
                        self.assertEqual(output, 'ERROR file_move returned false: Part\n')

    def test_file_delete_acceptance_false_and_exception_without_replay(self):
        for outcome in (True, False, RuntimeError('SDK deletion failed')):
            with self.subTest(outcome=outcome):
                class File:
                    fileExtension = 'f3d'
                    calls = 0

                    @property
                    def id(self):
                        if self.calls:
                            raise RuntimeError('invalid after deleteMe')
                        return 'file-id'

                    @property
                    def name(self):
                        if self.calls:
                            raise RuntimeError('invalid after deleteMe')
                        return 'Part'

                    def deleteMe(self):
                        self.calls += 1
                        if isinstance(outcome, Exception):
                            raise outcome
                        return outcome

                file = File()
                reads = []

                def files():
                    reads.append('lookup')
                    self.assertEqual(file.calls, 0, 'no post-delete folder readback')
                    return [file]

                root = types.SimpleNamespace(dataFiles=types.SimpleNamespace(asArray=files))
                project = types.SimpleNamespace(name='Project', rootFolder=root)
                self.app.data = types.SimpleNamespace(dataProjects=types.SimpleNamespace(asArray=lambda: [project]))
                ns = self.load('fusion_data_manager.py')
                ns['OP'], ns['ARGS'] = 'file_delete', ['Project', '', 'Part.f3d']
                stream = io.StringIO()
                with contextlib.redirect_stdout(stream):
                    if isinstance(outcome, Exception):
                        with self.assertRaises(RuntimeError) as caught:
                            ns['run']('')
                        self.assertIs(caught.exception, outcome)
                    else:
                        ns['run']('')
                self.assertEqual(file.calls, 1)
                self.assertEqual(reads, ['lookup'])
                lines = stream.getvalue().splitlines()
                if outcome is True:
                    self.assertEqual(len(lines), 3)
                    self.assertEqual(lines[0], 'DELETED_FILE name=Part.f3d')
                    self.assertTrue(lines[1].startswith('FILE_DELETE '))
                    self.assertEqual(json.loads(lines[1].removeprefix('FILE_DELETE ')), {
                        'id': 'file-id', 'name': 'Part', 'accepted': True,
                        'permanentDeletionVerified': False, 'editableSlotReleased': 'notVerified'})
                    self.assertEqual(lines[2], 'DONE')
                elif outcome is False:
                    self.assertEqual(lines, ['ERROR file_delete deleteMe returned false: Part.f3d'])
                else:
                    self.assertEqual(lines, [])

    def test_inherited_volume_read_failure_cannot_be_a_zero_measurement(self):
        root_path = Path(__file__).resolve().parents[1]
        sources = [(root_path / 'tests/fixtures/history/inspect-a262.py.txt').read_text(),
                   migrated_legacy('legacy_inspect.py')]
        for failure in [RuntimeError('property unavailable'), ValueError('invalid body')]:
            for revision, source in enumerate(sources):
                with self.subTest(failure=failure, revision=revision):
                    calls = []
                    class Body:
                        name = 'Body'
                        isVisible = True

                        @property
                        def physicalProperties(self):
                            calls.append('read')
                            raise failure

                    root = types.SimpleNamespace(bRepBodies=types.SimpleNamespace(count=1, item=lambda index: Body()))
                    self.app.activeProduct = types.SimpleNamespace(rootComponent=root)
                    document = types.SimpleNamespace(name='Model', creationId='volume-document', activate=lambda: True)
                    self.app.documents = [document]
                    self.app.activeDocument = document
                    namespace = {}
                    exec(compile(source, 'volume-fixture.py', 'exec'), namespace)
                    output = io.StringIO()
                    with contextlib.redirect_stdout(output):
                        if revision == 0:
                            namespace['cmd_bodies'](None, 'Model')
                        else:
                            with self.assertRaisesRegex(RuntimeError, 'Body volume unavailable: Body') as caught:
                                namespace['cmd_bodies'](None, 'Model')
                            self.assertIs(caught.exception.__cause__, failure)
                    self.assertEqual(calls, ['read'])
                    if revision == 0:
                        self.assertIn('volume=0.00 mm3', output.getvalue())
                        self.assertIn('DONE', output.getvalue())
                    else:
                        self.assertNotIn('BODY name=', output.getvalue())
                        self.assertNotIn('DONE', output.getvalue())

    def test_volume_read_preserves_real_zero_and_rejects_invalid_measurements(self):
        namespace = {}
        exec(compile(migrated_legacy('legacy_inspect.py'), 'volume-fixture.py', 'exec'), namespace)
        for volume in [0.0, 6.0, float('nan'), float('inf'), float('-inf'), -1.0]:
            with self.subTest(volume=volume):
                body = types.SimpleNamespace(name='Body', isVisible=True,
                    physicalProperties=types.SimpleNamespace(volume=volume))
                self.app.activeProduct = types.SimpleNamespace(rootComponent=types.SimpleNamespace(
                    bRepBodies=types.SimpleNamespace(count=1, item=lambda index: body)))
                document = types.SimpleNamespace(name='Model', creationId='volume-document', activate=lambda: True)
                self.app.documents = [document]
                self.app.activeDocument = document
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    if volume in (0.0, 6.0):
                        namespace['cmd_bodies'](None, 'Model')
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'Body volume invalid: Body'):
                            namespace['cmd_bodies'](None, 'Model')
                if volume in (0.0, 6.0):
                    self.assertIn('volume=%.2f mm3' % (volume * 1000), output.getvalue())
                    self.assertIn('DONE', output.getvalue())
                else:
                    self.assertNotIn('BODY name=', output.getvalue())
                    self.assertNotIn('DONE', output.getvalue())

    def test_inspection_matches_pre_refactor_behavior_on_the_same_sdk_scenarios(self):
        import hashlib
        directory = Path(__file__).resolve().parent / 'fixtures' / 'history'
        manifest = json.loads((directory / 'manifest.json').read_text())
        entry = next(item for item in manifest if item['file'] == 'inspect-a262.py.txt')
        frozen = (directory / entry['file']).read_bytes()
        self.assertEqual(hashlib.sha256(frozen).hexdigest(), entry['sha256'])
        sources = [frozen.decode(), migrated_legacy('legacy_inspect.py')]
        cases = [
            ('stats', ['Model'], 'DOC name=Model\nBODIES=1 FEATURES=2 SKETCHES=3 USER_PARAMS=4 PLANES=5\nDONE\n'),
            ('bbox', ['Model'], 'DOC name=Model\nBODY name=Body min=(0.00,0.00,0.00) max=(10.00,20.00,30.00) size=(10.0 x 20.0 x 30.0) mm\nDONE\n'),
            ('bodies', ['Model'], 'DOC name=Model\nBODY name=Body volume=6000.00 mm3 visible=True\nDONE\n'),
            ('rollback', ['1', 'Model'], 'DOC name=Model\nROLLBACK pos=1 of 2\nDONE\n'),
            ('rollback', ['3', 'Model'], 'DOC name=Model\nERROR rollback position out of range: 3 (valid 0..2)\n'),
            ('units', ['cm', 'Model'], 'DOC name=Model\nUNITS distanceDisplayUnits=1\nDONE\n'),
            ('units', ['bad', 'Model'], 'DOC name=Model\nERROR unsupported unit: bad (use mm, cm or in)\n'),
            ('stats', ['Missing'], 'ERROR document not open: Missing\n'),
        ]
        for operation, args, expected in cases:
            for revision, source in enumerate(sources):
                with self.subTest(operation=operation, args=args, revision=revision):
                    point = lambda x, y, z: types.SimpleNamespace(x=x, y=y, z=z)
                    body = types.SimpleNamespace(name='Body', isVisible=True, physicalProperties=types.SimpleNamespace(volume=6), boundingBox=types.SimpleNamespace(minPoint=point(0, 0, 0), maxPoint=point(1, 2, 3)))
                    root = types.SimpleNamespace(bRepBodies=types.SimpleNamespace(count=1, item=lambda i: body), features=types.SimpleNamespace(count=2), sketches=types.SimpleNamespace(count=3), constructionPlanes=types.SimpleNamespace(count=5))
                    timeline = types.SimpleNamespace(count=2, markerPosition=2, item=lambda i: types.SimpleNamespace(healthState=0))
                    units = types.SimpleNamespace(distanceDisplayUnits=0)
                    target = types.SimpleNamespace(rootComponent=root, userParameters=types.SimpleNamespace(count=4), timeline=timeline, unitsManager=units)
                    self.app.activeProduct = types.SimpleNamespace(name='Other document')
                    activations = []
                    def activate():
                        activations.append('Model')
                        self.app.activeProduct = target
                        self.app.activeDocument = document
                        return True
                    document = types.SimpleNamespace(name='Model', creationId='paired-document', activate=activate)
                    self.app.documents = [document]
                    sys.modules['adsk.fusion'].FeatureHealthStates = types.SimpleNamespace(HealthyFeatureHealthState=0)
                    namespace = {}
                    exec(compile(source, 'inspection-fixture.py', 'exec'), namespace)
                    namespace['OP'], namespace['ARGS'] = operation, args
                    self.assertEqual(self.output(namespace['run'], ''), expected)
                    self.assertEqual(activations, [] if args == ['Missing'] else ['Model'])
                    self.assertEqual(timeline.markerPosition, 1 if operation == 'rollback' and args[0] == '1' else 2)
                    self.assertEqual(units.distanceDisplayUnits, 1 if operation == 'units' and args[0] == 'cm' else 0)

    def test_inherited_ambiguous_and_failed_activation_never_mutate_either_document(self):
        root = Path(__file__).resolve().parents[1]
        sources = [
            (root / 'tests/fixtures/history/inspect-a262.py.txt').read_text(),
            migrated_legacy('legacy_inspect.py'),
        ]
        for mode in ('duplicate-name', 'activate-false', 'activate-wrong-document'):
            for operation, args in [('units', ['cm', 'Model']), ('rollback', ['1', 'Model'])]:
                for revision, source in enumerate(sources):
                    with self.subTest(mode=mode, operation=operation, revision=revision):
                        target = types.SimpleNamespace(unitsManager=types.SimpleNamespace(distanceDisplayUnits=0), timeline=types.SimpleNamespace(count=2, markerPosition=2))
                        foreign = types.SimpleNamespace(unitsManager=types.SimpleNamespace(distanceDisplayUnits=0), timeline=types.SimpleNamespace(count=2, markerPosition=2))
                        other = types.SimpleNamespace(name='mOdEl' if mode == 'duplicate-name' else 'Other', creationId='foreign')
                        activations = []
                        def activate():
                            activations.append('target')
                            if mode == 'duplicate-name':
                                self.app.activeProduct = target
                                self.app.activeDocument = document
                            return mode != 'activate-false'
                        document = types.SimpleNamespace(name='Model', creationId='target', activate=activate)
                        self.app.documents = [document, other]
                        self.app.activeProduct = foreign
                        self.app.activeDocument = other
                        namespace = {}
                        exec(compile(source, 'inspection-identity-fixture.py', 'exec'), namespace)
                        namespace['OP'], namespace['ARGS'] = operation, args
                        output = self.output(namespace['run'], '')
                        values = [(d.unitsManager.distanceDisplayUnits, d.timeline.markerPosition) for d in (target, foreign)]
                        if revision == 0:
                            # Historical bug: first name wins, and a failed activation
                            # leaves the unrelated active design as the mutation target.
                            self.assertIn('DONE', output)
                            expected = (1, 2) if operation == 'units' else (0, 1)
                            self.assertEqual(values[0 if mode == 'duplicate-name' else 1], expected)
                        else:
                            self.assertIn('ERROR ', output)
                            self.assertNotIn('DONE', output)
                            self.assertEqual(values, [(0, 2), (0, 2)])
                            self.assertEqual(activations, [] if mode == 'duplicate-name' else ['target'])

    def test_builtin_box_missing_document_is_rejected_without_active_design_fallback(self):
        class ActiveDesign:
            @property
            def rootComponent(self):
                raise RuntimeError('MOCK reached active design despite missing target')

        self.app.activeProduct = ActiveDesign()
        self.app.activeDocument = types.SimpleNamespace(name='OtherDocument')
        ns = self.load('scripts/box.py')
        ns['DOC_NAME'] = 'MissingTarget'
        output = self.output(ns['run'], '')
        self.assertIn('ERROR expected exactly one open document: MissingTarget', output)


if __name__ == '__main__':
    unittest.main()
