"""Actual legacy handlers under offline SDK stubs; no Fusion process is contacted."""
import contextlib
import io
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


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
        exec(compile(file.read_text(), str(file), 'exec'), namespace)
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

    def test_folder_delete_slash_only_path_reaches_root_despite_guard(self):
        deleted = []
        root = types.SimpleNamespace(deleteMe=lambda: deleted.append('root') or False)
        project = types.SimpleNamespace(name='Project', rootFolder=root)
        data = types.SimpleNamespace(dataProjects=types.SimpleNamespace(asArray=lambda: [project]))
        ns = self.load('fusion_data_manager.py')
        self.assertIn('cannot delete project root', self.output(ns['cmd_folder_delete'], data, 'Project', ''))
        self.assertEqual(deleted, [])
        self.assertIn('ERROR folder_delete', self.output(ns['cmd_folder_delete'], data, 'Project', '///'))
        self.assertEqual(deleted, ['root'])

    def test_file_move_ignores_false_api_result_as_documented(self):
        file = types.SimpleNamespace(name='Part', fileExtension='f3d', id='file-id', move=lambda target: False, deleteMe=lambda: False)
        root = types.SimpleNamespace(name='Root', dataFiles=types.SimpleNamespace(asArray=lambda: [file]))
        project = types.SimpleNamespace(name='Project', rootFolder=root)
        data = types.SimpleNamespace(dataProjects=types.SimpleNamespace(asArray=lambda: [project]))
        ns = self.load('fusion_data_manager.py')
        self.assertIn('MOVED_FILE', self.output(ns['cmd_file_move'], data, 'Project', '', 'Part', ''))

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

    def test_body_volume_failure_is_reported_as_zero_not_real_measurement(self):
        class Body:
            name = 'Body'
            isVisible = True

            @property
            def physicalProperties(self):
                raise RuntimeError('MOCK property failure')

        root = types.SimpleNamespace(bRepBodies=types.SimpleNamespace(count=1, item=lambda index: Body()))
        self.app.activeProduct = types.SimpleNamespace(rootComponent=root)
        document = types.SimpleNamespace(name='Model', creationId='volume-document', activate=lambda: True)
        self.app.documents = [document]
        self.app.activeDocument = document
        ns = self.load('inspect.py')
        self.assertIn('volume=0.00 mm3', self.output(ns['cmd_bodies'], None, 'Model'))

    def test_inspection_matches_pre_refactor_behavior_on_the_same_sdk_scenarios(self):
        import hashlib
        directory = Path(__file__).resolve().parent / 'fixtures' / 'history'
        manifest = json.loads((directory / 'manifest.json').read_text())
        entry = next(item for item in manifest if item['file'] == 'inspect-a262.py.txt')
        frozen = (directory / entry['file']).read_bytes()
        self.assertEqual(hashlib.sha256(frozen).hexdigest(), entry['sha256'])
        sources = [frozen.decode(), (directory.parents[2] / 'runtime/python/fmcad/adapters/fusion/legacy_inspect.py').read_text()]
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
            (root / 'runtime/python/fmcad/adapters/fusion/legacy_inspect.py').read_text(),
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
