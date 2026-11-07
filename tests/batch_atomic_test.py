"""Atomic batch command-transaction lifecycle tests with SDK doubles; no Fusion."""
import json
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

_atomic_path = Path(__file__).resolve().parents[1] / 'assets' / 'cad' / 'atomic.py'
_atomic_spec = importlib.util.spec_from_file_location('fmcad_test_atomic', _atomic_path)
helper = importlib.util.module_from_spec(_atomic_spec)
_atomic_spec.loader.exec_module(helper)


class Collection:
    def __init__(self, values=()):
        self.values = list(values)

    @property
    def count(self):
        return len(self.values)

    def item(self, index):
        return self.values[index]


class Attributes:
    def __init__(self):
        self.values = {}

    def itemByName(self, group, name):
        return self.values.get((group, name))

    def add(self, group, name, value):
        result = types.SimpleNamespace(value=value)
        self.values[group, name] = result
        return result


class Event:
    def __init__(self):
        self.handlers = []

    def add(self, handler):
        self.handlers.append(handler)
        return True

    def fire(self, args):
        for handler in self.handlers:
            handler.notify(args)


class Model:
    """Shared native-model state, so a simulated rollback is observable across the
    start context and the finalize-time reconstructed context."""

    def __init__(self):
        self.bodies = []
        self.sketches = []
        self.seen_components = []

    def snapshot(self):
        return {'sketches': len(self.sketches), 'bodies': len(self.bodies),
                'occurrences': 0, 'userParameters': 0}


class Body:
    """A body-shaped double with the dimensions the richer snapshot reads."""

    def __init__(self, name, volume=None):
        self.name = name
        self.volume = volume
        self.boundingBox = None
        self.material = None
        self.appearance = None


class CadContext:
    """SDK double for the CadContext imported by atomic.py."""

    def __init__(self, doc, component=None, project_id=None, doc_id=None, doc_file_id=None):
        self.doc_name = doc
        self.component = component
        self.occurrence = None
        self.model = MODEL
        self.doc = DOC
        self.root = types.SimpleNamespace(sketches=Collection(self.model.sketches),
                                          bRepBodies=Collection(self.model.bodies),
                                          allOccurrences=Collection())
        self.design = types.SimpleNamespace(userParameters=Collection())
        self.created = []
        self.calls = []

    def activate_target(self):
        return True

    def assert_identity(self):
        pass

    def call(self, operation, data):
        self.calls.append((operation, data))
        return helper.CAD_HANDLERS[operation](self, data)

    def resolve(self, ref, kind=None):
        # Mirrors CadContext.resolve's boundary guard: a collection is consumed
        # element-wise by handlers, never handed to resolve as an array.
        if not isinstance(ref, (str, dict)):
            raise TypeError('Entity reference must be a name or reference object')
        return ref

    def _scope(self, data):
        return data.get('component', self.component), data.get('occurrence', self.occurrence)


MODEL = Model()
DOC = None


def _install_fakes(test):
    test.core = types.ModuleType('adsk.core')
    test.fusion = types.ModuleType('adsk.fusion')
    test.adsk = types.ModuleType('adsk')
    test.core.Application = types.SimpleNamespace(get=lambda: test.app)
    test.core.CommandEventHandler = type('Handler', (), {})
    test.core.CommandCreatedEventHandler = type('CreatedHandler', (), {})
    test.core.CommandTerminationReason = types.SimpleNamespace(
        UnknownTerminationReason=0, CompletedTerminationReason=1, CancelledTerminationReason=2,
        AbortedTerminationReason=3, PreEmptedTerminationReason=4, SessionEndingTerminationReason=5)
    test.fusion.Design = types.SimpleNamespace(cast=lambda value: value)
    test.adsk.core, test.adsk.fusion = test.core, test.fusion
    modules = patch.dict(sys.modules, {'adsk': test.adsk, 'adsk.core': test.core, 'adsk.fusion': test.fusion})
    modules.start()
    test.addCleanup(modules.stop)


class AtomicTransactionTests(unittest.TestCase):
    def setUp(self):
        global MODEL, DOC
        MODEL = Model()
        self.model = MODEL
        self.definitions = {}
        test = self

        class Definition:
            isNative = False

            def __init__(self, identifier):
                self.id, self.commandCreated = identifier, Event()

            def execute(self):
                return True

            def create(self):
                self.command = types.SimpleNamespace(execute=Event(), destroy=Event(), commandInputs=Collection())
                self.commandCreated.fire(types.SimpleNamespace(command=self.command))

            def perform(self):
                event = types.SimpleNamespace(executeFailed=False, executeFailedMessage='')
                self.command.execute.fire(event)
                return event

            def destroy(self, reason=1):
                self.command.destroy.fire(types.SimpleNamespace(terminationReason=reason))

            def deleteMe(self):
                del test.definitions[self.id]
                return True

        def add(identifier, name, tooltip):
            definition = Definition(identifier)
            self.definitions[identifier] = definition
            return definition

        self.ui = types.SimpleNamespace(activeCommand='SelectCommand', commandDefinitions=types.SimpleNamespace(
            itemById=self.definitions.get, addButtonDefinition=add))
        self.doc = types.SimpleNamespace(creationId='creation', name='Model')
        DOC = self.doc
        self.app = types.SimpleNamespace(activeDocument=self.doc, documents=Collection([self.doc]),
                                         userInterface=self.ui)
        _install_fakes(self)
        self.command_id = 'fmcad_atomic_' + 'a' * 32
        # Inject the CadContext / CAD_HANDLERS / _cad_json globals atomic.py references.
        helper.CadContext = CadContext
        old_context_factory = helper._atomic_fresh_context
        helper._atomic_fresh_context = lambda app, doc, args: CadContext(
            args['doc'], args.get('component'), args.get('projectId'), args.get('docId'), args.get('docFileId'))
        self.addCleanup(setattr, helper, '_atomic_fresh_context', old_context_factory)
        helper.CAD_HANDLERS = {'op.create': lambda ctx, d: self.create_body(ctx, d),
                               'op.use': lambda ctx, d: self.use_body(ctx, d),
                               'op.fail': lambda ctx, d: self.fail_body(ctx, d),
                               'op.find': lambda ctx, d: self.find_bodies(ctx, d),
                               'op.highlight': lambda ctx, d: self.highlight_refs(ctx, d),
                               'op.mutate': lambda ctx, d: self.mutate_body(ctx, d),
                               'op.record': lambda ctx, d: self.record_component(ctx, d)}
        helper._cad_json = lambda value: value
        self.addCleanup(self.clear_sessions)

    def clear_sessions(self):
        for name in ('_fmcad_' + 'fmcad_atomic_' + c * 32 for c in ('a', 'b')):
            sys.modules.pop(name, None)

    # Handlers driven by the test's shared model.
    def create_body(self, ctx, data):
        name = data['name']
        ctx.model.bodies.append(Body(name, data.get('volume')))
        ctx.created.append({'token': name})
        return {'body': {'token': name}}

    def mutate_body(self, ctx, data):
        body = next(b for b in ctx.model.bodies if b.name == data['name'])
        body.volume = data['volume']
        return {'mutated': data['name']}

    def record_component(self, ctx, data):
        ctx.model.seen_components.append({'scope': ctx.component, 'domain': data.get('component')})
        return {'ok': True}

    def use_body(self, ctx, data):
        return {'used': data['ref']}

    def fail_body(self, ctx, data):
        raise RuntimeError('native failure')

    def find_bodies(self, ctx, data):
        return {'refs': [{'token': 'A', 'kind': 'body', 'name': 'A'},
                         {'token': 'B', 'kind': 'body', 'name': 'B'}]}

    def highlight_refs(self, ctx, data):
        refs = data['refs']
        if not isinstance(refs, list):
            raise ValueError('refs must be an array')
        return {'highlighted': [ctx.resolve(ref)['name'] for ref in refs]}

    def steps(self, *step_list):
        return [dict(id='step_%d' % i, **step) for i, step in enumerate(step_list)]

    def start_args(self, steps, operation='atomic_start'):
        return {'operation': operation, 'commandId': self.command_id, 'runId': 'run', 'doc': 'Model',
                'component': None, 'projectId': None, 'docId': None, 'docFileId': None,
                'sessionNonce': '1' * 32, 'requestHash': '2' * 64, 'backend': 'addin',
                'documentIdentity': {'expected': {'name': 'Model', 'creationId': None, 'fileId': None},
                                     'resolved': {'name': 'Model', 'creationId': 'creation', 'fileId': None}},
                'steps': steps}

    def call(self, operation, **updates):
        return helper.execute(dict(self.start_args(None, operation), **updates))

    def test_happy_path_start_execute_destroy_finalize_commits(self):
        start = self.call('atomic_start', steps=self.steps(
            {'operation': 'op.create', 'data': {'name': 'Body1'}}))
        self.assertTrue(start['accepted'])
        self.assertFalse(start['completed'])
        self.assertEqual(start['status'], 'submitted')
        definition = self.definitions[self.command_id]
        definition.create()
        self.assertTrue(definition.command.isAutoExecute)
        event = definition.perform()
        self.assertFalse(event.executeFailed)
        self.assertFalse(self.call('atomic_status')['completed'])
        definition.destroy()
        final = self.call('atomic_finalize')
        self.assertTrue(final['cleanupCompleted'])
        self.assertTrue(final['definitionDeleted'])
        self.assertEqual(final['outcome'], 'committed')
        self.assertEqual(final['rollbackVerified'], False)
        self.assertEqual(final['results']['step_0']['result'], {'body': {'token': 'Body1'}})
        self.assertNotIn(self.command_id, self.definitions)
        self.assertIn('_fmcad_' + self.command_id, sys.modules)
        self.assertTrue(self.call('atomic_finalize')['cleanupCompleted'])

    def test_error_in_execute_requests_abort_and_records_aborted_reason(self):
        self.call('atomic_start', steps=self.steps(
            {'operation': 'op.create', 'data': {'name': 'Body1'}},
            {'operation': 'op.fail', 'data': {}}))
        definition = self.definitions[self.command_id]
        definition.create()
        event = definition.perform()
        self.assertTrue(event.executeFailed)
        self.assertIn('native failure', event.executeFailedMessage)
        # The created body was written before the failure; the transaction aborts it.
        self.assertEqual([body.name for body in self.model.bodies], ['Body1'])
        self.model.bodies.clear()  # Fusion's abort reverts the uncommitted mutation.
        definition.destroy(3)  # AbortedTerminationReason
        final = self.call('atomic_finalize')
        self.assertEqual(final['terminationReason'], 3)
        self.assertEqual(final['outcome'], 'aborted')
        self.assertTrue(final['cleanupCompleted'])
        self.assertTrue(final['rollbackVerified'])
        self.assertEqual(final['errorStep'], 'step_1')
        self.assertEqual(self.model.bodies, [])

    def test_abort_reports_effective_aborted_reason_when_kernel_reports_completed(self):
        # Live kernels may report CompletedTerminationReason (1) even after
        # executeFailed requested an abort; the effective terminationReason must be
        # AbortedTerminationReason (3) so the report matches the aborted outcome.
        self.call('atomic_start', steps=self.steps(
            {'operation': 'op.create', 'data': {'name': 'Body1'}},
            {'operation': 'op.fail', 'data': {}}))
        definition = self.definitions[self.command_id]
        definition.create()
        event = definition.perform()
        self.assertTrue(event.executeFailed)
        self.model.bodies.clear()  # Fusion's abort reverts the uncommitted mutation.
        definition.destroy(1)  # CompletedTerminationReason (the observed misleading case)
        final = self.call('atomic_finalize')
        self.assertEqual(final['terminationReason'], 3)
        self.assertEqual(final['outcome'], 'aborted')
        self.assertTrue(final['cleanupCompleted'])
        self.assertTrue(final['rollbackVerified'])

    def test_destroy_termination_reason_maps_to_outcome(self):
        tr = self.core.CommandTerminationReason
        cases = [
            (tr.CompletedTerminationReason, 'committed'),
            (tr.AbortedTerminationReason, 'aborted'),   # OK clicked but executed failed
            (tr.CancelledTerminationReason, 'aborted'),
            (tr.PreEmptedTerminationReason, 'aborted'),
            (tr.SessionEndingTerminationReason, 'aborted'),
            (tr.UnknownTerminationReason, 'aborted'),
        ]
        for reason, expected in cases:
            with self.subTest(reason=reason, expected=expected):
                self.model.bodies.clear()
                self.call('atomic_start', steps=self.steps(
                    {'operation': 'op.create', 'data': {'name': 'Body1'}}))
                definition = self.definitions[self.command_id]
                definition.create()
                definition.perform()
                definition.destroy(reason)
                status = self.call('atomic_status')
                self.assertTrue(status['destroyed'])
                self.assertEqual(status['terminationReason'], reason)
                self.assertEqual(status['outcome'], expected)
                self.call('atomic_finalize')  # clean up for the next reason
                sys.modules.pop('_fmcad_' + self.command_id, None)

    def test_finalize_busy_context_preserves_outcome_until_idle(self):
        self.call('atomic_start', steps=self.steps(
            {'operation': 'op.create', 'data': {'name': 'Body1'}}))
        definition = self.definitions[self.command_id]
        definition.create()
        definition.perform()
        definition.destroy(self.core.CommandTerminationReason.PreEmptedTerminationReason)
        self.ui.activeCommand = 'OtherUserCommand'
        pending = self.call('atomic_finalize')
        self.assertEqual(pending['status'], 'cleanup_pending')
        self.assertEqual(pending['outcome'], 'aborted')
        self.assertEqual(pending['terminationReason'], 4)
        self.assertFalse(pending['cleanupCompleted'])
        self.assertIs(self.definitions[self.command_id], definition)
        self.ui.activeCommand = 'SelectCommand'
        final = self.call('atomic_finalize')
        self.assertTrue(final['cleanupCompleted'])
        self.assertEqual(final['outcome'], 'aborted')
        self.assertEqual(final['terminationReason'], 4)

    def test_ref_resolution_between_steps(self):
        self.call('atomic_start', steps=self.steps(
            {'operation': 'op.create', 'data': {'name': 'Body1'}},
            {'operation': 'op.use', 'data': {'ref': {'$ref': 'step_0.result.body'}}}))
        definition = self.definitions[self.command_id]
        definition.create()
        definition.perform()
        definition.destroy()
        final = self.call('atomic_finalize')
        self.assertEqual(final['outcome'], 'committed')
        self.assertEqual(final['results']['step_1']['result'], {'used': {'token': 'Body1'}})

    def test_ref_collection_between_steps(self):
        self.call('atomic_start', steps=self.steps(
            {'operation': 'op.find', 'data': {}},
            {'operation': 'op.highlight', 'data': {'refs': {'$ref': 'step_0.result.refs'}}}))
        definition = self.definitions[self.command_id]
        definition.create()
        definition.perform()
        definition.destroy()
        final = self.call('atomic_finalize')
        self.assertEqual(final['outcome'], 'committed')
        self.assertEqual(final['results']['step_1']['result'], {'highlighted': ['A', 'B']})

    def test_finalize_before_destroy_does_not_cleanup(self):
        self.call('atomic_start', steps=self.steps({'operation': 'op.create', 'data': {'name': 'Body1'}}))
        definition = self.definitions[self.command_id]
        definition.create()
        definition.perform()
        pending = self.call('atomic_finalize')
        self.assertFalse(pending['cleanupCompleted'])
        self.assertFalse(pending['definitionDeleted'])
        self.assertIs(self.definitions[self.command_id], definition)
        definition.destroy()
        self.assertTrue(self.call('atomic_finalize')['cleanupCompleted'])

    def test_lost_session_is_unavailable(self):
        self.call('atomic_start', steps=self.steps({'operation': 'op.create', 'data': {'name': 'Body1'}}))
        del sys.modules['_fmcad_' + self.command_id]
        status = self.call('atomic_status')
        self.assertEqual(status['status'], 'unavailable')
        self.assertEqual(status['outcome'], 'unknown')

    def test_wrong_session_nonce_cannot_observe_or_finalize_holder(self):
        self.call('atomic_start', steps=self.steps(
            {'operation': 'op.create', 'data': {'name': 'Body1'}}))
        wrong = self.call('atomic_status', sessionNonce='f' * 32)
        self.assertEqual(wrong['status'], 'identity_mismatch')
        self.assertEqual(wrong['outcome'], 'unknown')
        self.assertFalse(wrong['cleanupCompleted'])
        definition = self.definitions[self.command_id]
        self.assertIn(self.command_id, self.definitions)
        self.assertIsNotNone(definition)
        # Re-submission is refused even after state loss: the owned definition
        # still exists, so a replay (never auto-replayed) is blocked.
        with self.assertRaisesRegex(ValueError, 'already submitted'):
            self.call('atomic_start', steps=self.steps({'operation': 'op.create', 'data': {'name': 'Body1'}}))

    def test_resolver_reports_two_buffers_for_pinned_file_as_ambiguous_without_activation(self):
        original = self.app.activeDocument
        first = types.SimpleNamespace(name='Model', creationId='creation-a',
                                      dataFile=types.SimpleNamespace(id='file-1'))
        second = types.SimpleNamespace(name='Model', creationId='creation-b',
                                       dataFile=types.SimpleNamespace(id='file-1'))
        self.app.documents = Collection([first, second])
        self.app.activeDocument = original
        result = self.call('atomic_resolve', documentIdentity={'expected': {
            'name': 'Model', 'creationId': 'creation-a', 'fileId': 'file-1'}})
        self.assertEqual(result['status'], 'ambiguous')
        self.assertEqual(len(result['candidates']), 2)
        self.assertIn('unique open buffer', result['unavailableEvidence'][0])
        self.assertIs(self.app.activeDocument, original)
        self.assertFalse(self.definitions)

    def test_resolver_missing_document_is_unavailable_not_success(self):
        self.app.documents = Collection([])
        result = self.call('atomic_resolve', documentIdentity={'expected': {
            'name': 'Model', 'creationId': None, 'fileId': None}})
        self.assertEqual(result['status'], 'unavailable')
        self.assertEqual(result['candidates'], [])

    def test_replaced_document_identity_blocks_status_and_cleanup(self):
        self.call('atomic_start', steps=self.steps({'operation': 'op.create', 'data': {'name': 'Body1'}}))
        definition = self.definitions[self.command_id]
        definition.create()
        definition.perform()
        definition.destroy()
        replacement = types.SimpleNamespace(name='Model', creationId='replacement', dataFile=None)
        self.app.documents = Collection([replacement])
        status = self.call('atomic_status')
        self.assertEqual(status['status'], 'identity_mismatch')
        final = self.call('atomic_finalize')
        self.assertFalse(final.get('cleanupCompleted', False))
        self.assertIn(self.command_id, self.definitions)
        self.assertEqual(self.app.activeDocument, self.doc)

    def test_two_open_buffers_make_live_reconcile_ambiguous_and_block_cleanup(self):
        self.call('atomic_start', steps=self.steps({'operation': 'op.create', 'data': {'name': 'Body1'}}))
        definition = self.definitions[self.command_id]
        definition.create()
        definition.perform()
        definition.destroy()
        first = types.SimpleNamespace(name='Model', creationId='buffer-a', dataFile=None)
        second = types.SimpleNamespace(name='Model', creationId='buffer-b', dataFile=None)
        self.app.documents = Collection([first, second])
        status = self.call('atomic_status')
        self.assertEqual(status['status'], 'ambiguous')
        self.assertEqual(len(status['candidates']), 2)
        final = self.call('atomic_finalize')
        self.assertFalse(final.get('cleanupCompleted', False))
        self.assertIn(self.command_id, self.definitions)
        self.assertEqual(self.app.activeDocument, self.doc)

    def test_observe_uses_fresh_read_only_context_and_rejects_mutating_operation(self):
        self.call('atomic_start', steps=self.steps({'operation': 'op.create', 'data': {'name': 'Body1'}}))
        definition = self.definitions[self.command_id]
        definition.create()
        definition.perform()
        identity = sys.modules['_fmcad_' + self.command_id].identity
        result = self.call('atomic_observe', data=[{'operation': 'op.find', 'data': {}}],
                           readOnlyOperations=['op.find'])
        self.assertEqual(result['status'], 'observed')
        self.assertEqual(result['identity'], identity)
        with self.assertRaisesRegex(ValueError, 'read-only whitelist'):
            self.call('atomic_observe', data=[{'operation': 'op.create', 'data': {}}], readOnlyOperations=['op.find'])
        self.assertIn(self.command_id, self.definitions)
        self.assertEqual(self.app.activeDocument, self.doc)

    def test_active_writer_status_and_read_observe_do_not_open_activate_or_cleanup(self):
        self.call('atomic_start', steps=self.steps({'operation': 'op.create', 'data': {'name': 'Body1'}}))
        definition = self.definitions[self.command_id]
        definition.create()
        self.ui.activeCommand = self.command_id
        before_documents = list(self.app.documents.values)
        before_bodies = list(self.model.bodies)
        status = self.call('atomic_status')
        self.assertFalse(status['destroyed'])
        self.assertFalse(status['idle'])
        self.assertFalse(status['cleanupCompleted'])
        observed = self.call('atomic_observe', data=[{'operation': 'op.find', 'data': {}}],
                             readOnlyOperations=['op.find'])
        self.assertEqual(observed['status'], 'observed')
        self.assertFalse(observed['destroyed'])
        self.assertFalse(observed['cleanupCompleted'])
        self.assertEqual(list(self.app.documents.values), before_documents)
        self.assertEqual(self.app.activeDocument, self.doc)
        self.assertEqual(self.model.bodies, before_bodies)
        self.assertIn(self.command_id, self.definitions)
        self.assertTrue(definition.command.execute.handlers)
        self.ui.activeCommand = 'SelectCommand'
        definition.perform()
        definition.destroy()
        self.assertTrue(self.call('atomic_finalize')['cleanupCompleted'])

    def test_repeated_execute_refused(self):
        self.call('atomic_start', steps=self.steps({'operation': 'op.create', 'data': {'name': 'Body1'}}))
        definition = self.definitions[self.command_id]
        definition.create()
        definition.perform()
        self.assertTrue(definition.perform().executeFailed)
        self.assertEqual(len(self.model.bodies), 1)

    def test_aborted_rollback_verifies_volume_and_reports_detail(self):
        self.model.bodies.append(Body('Body1', volume=3.0))
        self.call('atomic_start', steps=self.steps(
            {'operation': 'op.mutate', 'data': {'name': 'Body1', 'volume': 5.0}},
            {'operation': 'op.fail', 'data': {}}))
        definition = self.definitions[self.command_id]
        definition.create()
        event = definition.perform()
        self.assertTrue(event.executeFailed)
        self.assertEqual(self.model.bodies[0].volume, 5.0)
        self.model.bodies[0].volume = 3.0  # Fusion's abort reverts the uncommitted change
        definition.destroy(3)
        final = self.call('atomic_finalize')
        self.assertEqual(final['outcome'], 'aborted')
        self.assertTrue(final['rollbackVerified'])
        self.assertTrue(final['rollback']['measured'])
        self.assertTrue(final['rollback']['matched'])
        volume = [d for d in final['rollback']['dimensions'] if d['dimension'] == 'body.volume']
        self.assertTrue(volume)
        self.assertTrue(volume[0]['matched'])
        self.assertEqual(volume[0]['before'], 3.0)
        # The richer snapshot measured more than the four legacy counters.
        for key in ('parameters', 'occurrences', 'timeline', 'bodies'):
            self.assertIn(key, final['after'])

    def test_aborted_rollback_detects_unreverted_volume_mismatch(self):
        self.model.bodies.append(Body('Body1', volume=3.0))
        self.call('atomic_start', steps=self.steps(
            {'operation': 'op.mutate', 'data': {'name': 'Body1', 'volume': 5.0}},
            {'operation': 'op.fail', 'data': {}}))
        definition = self.definitions[self.command_id]
        definition.create()
        definition.perform()
        definition.destroy(3)  # No manual revert: the model was not restored.
        final = self.call('atomic_finalize')
        self.assertEqual(final['outcome'], 'aborted')
        self.assertFalse(final['rollbackVerified'])
        self.assertFalse(final['rollback']['matched'])
        self.assertTrue(any(d['dimension'] == 'body.volume' and not d['matched']
                            for d in final['rollback']['dimensions']))

    def test_step_component_override_is_context_only_and_restored(self):
        self.call('atomic_start', steps=self.steps(
            {'operation': 'op.record', 'component': 'Child', 'data': {'component': 'domain-value'}}))
        definition = self.definitions[self.command_id]
        definition.create()
        definition.perform()
        definition.destroy()
        final = self.call('atomic_finalize')
        self.assertEqual(final['outcome'], 'committed')
        self.assertEqual(self.model.seen_components, [{'scope': 'Child', 'domain': 'domain-value'}])


class AtomicReferenceTests(unittest.TestCase):
    def test_resolves_canonical_list_indexes_and_preserves_dict_text_keys(self):
        result = {'rows': [{'0': 'text-key', 'values': ['zero', 'one']}]}
        self.assertEqual(helper._atomic_resolve({'$ref': 'step.result.rows.0.values.1'}, {'step': {'result': result}}), 'one')
        self.assertEqual(helper._atomic_resolve({'$ref': 'step.result.rows.0.0'}, {'step': {'result': result}}), 'text-key')
        for ref in ('step.result.rows.00', 'step.result.rows.-1', 'step.result.rows.2'):
            with self.assertRaisesRegex(ValueError, 'array index|out of range'):
                helper._atomic_resolve({'$ref': ref}, {'step': {'result': result}})

    def test_unknown_acceptance_is_failure_even_with_success_elsewhere(self):
        for status in ('unknown', 'missing', 'stale'):
            self.assertTrue(helper._atomic_result_failed({'status': status, 'success': True}))
        self.assertTrue(helper._atomic_result_failed({'status': 'pass', 'success': False}))


class AtomicCompareTests(unittest.TestCase):
    """Direct coverage of _atomic_compare's bounds/timeline/occurrence-transform
    branches with non-trivial values (open-notes #4). _atomic_compare is a pure
    function and does not need the Fusion SDK doubles.

    Open-notes #2 note: the numeric tolerances below (bbox abs 1e-6 cm, rotation
    1e-9) are asserted here with deliberately out-of-tolerance inputs only; the
    tolerance VALUES themselves are flagged for live-kernel verification in the
    coverage matrix (BACKENDS.md), not tightened or loosened offline.
    """

    @staticmethod
    def snapshot(volume=3.0, bounds=None, material='Steel', appearance=None,
                 name='Body1', transform=None, health=1):
        identity = [1.0, 0.0, 0.0, 1.0,
                    0.0, 1.0, 0.0, 2.0,
                    0.0, 0.0, 1.0, 3.0,
                    0.0, 0.0, 0.0, 1.0]
        return {
            'counts': {'sketches': 0, 'bodies': 1, 'occurrences': 1, 'userParameters': 0},
            'parameters': {},
            'occurrences': {'Occ:1': transform if transform is not None else identity},
            'timeline': [{'name': 'Extrude1', 'healthState': health}],
            'bodies': [{'name': name, 'volume': volume, 'bounds': bounds,
                        'material': material, 'appearance': appearance}],
        }

    def test_identical_rich_snapshot_verifies_all_dimensions(self):
        snap = self.snapshot(volume=3.0, bounds=[0.0, 0.0, 0.0, 2.0, 1.0, 1.0],
                             material='Steel', appearance='Paint', name='Body1')
        verified, dimensions = helper._atomic_compare(snap, snap)
        self.assertTrue(verified)
        self.assertTrue(all(d['matched'] for d in dimensions))
        names = {d['dimension'] for d in dimensions}
        self.assertIn('body.volume', names)
        self.assertIn('body.bounds', names)
        self.assertIn('body.material', names)
        self.assertIn('body.appearance', names)
        self.assertIn('timeline', names)
        self.assertIn('occurrences', names)

    def test_bounds_mismatch_detected(self):
        before = self.snapshot(bounds=[0.0, 0.0, 0.0, 2.0, 1.0, 1.0])
        after = self.snapshot(bounds=[0.0, 0.0, 0.0, 2.0, 1.0, 1.01])
        verified, dimensions = helper._atomic_compare(before, after)
        self.assertFalse(verified)
        self.assertFalse(next(d for d in dimensions if d['dimension'] == 'body.bounds')['matched'])

    def test_timeline_health_mismatch_detected(self):
        verified, dimensions = helper._atomic_compare(self.snapshot(health=1), self.snapshot(health=2))
        self.assertFalse(verified)
        self.assertFalse(next(d for d in dimensions if d['dimension'] == 'timeline')['matched'])

    def test_occurrence_translation_mismatch_detected(self):
        before = self.snapshot(transform=[1, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 3, 0, 0, 0, 1])
        after = self.snapshot(transform=[1, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 3.1, 0, 0, 0, 1])
        verified, dimensions = helper._atomic_compare(before, after)
        self.assertFalse(verified)
        self.assertFalse(next(d for d in dimensions if d['dimension'] == 'occurrence.Occ:1[11]')['matched'])

    def test_occurrence_rotation_mismatch_detected(self):
        before = self.snapshot(transform=[1, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 3, 0, 0, 0, 1])
        after = self.snapshot(transform=[1, 0.001, 0, 1, 0, 1, 0, 2, 0, 0, 1, 3, 0, 0, 0, 1])
        verified, dimensions = helper._atomic_compare(before, after)
        self.assertFalse(verified)
        self.assertFalse(next(d for d in dimensions if d['dimension'] == 'occurrence.Occ:1[1]')['matched'])

    def test_material_and_name_mismatch_detected(self):
        verified, dimensions = helper._atomic_compare(
            self.snapshot(material='Steel', name='Body1'),
            self.snapshot(material='Aluminum', name='Body1'))
        self.assertFalse(verified)
        self.assertFalse(next(d for d in dimensions if d['dimension'] == 'body.material')['matched'])

    def test_parameters_mismatch_detected(self):
        before, after = self.snapshot(), self.snapshot()
        before['parameters'] = {'wall': {'expression': '2 mm', 'unit': 'mm'}}
        after['parameters'] = {'wall': {'expression': '3 mm', 'unit': 'mm'}}
        verified, dimensions = helper._atomic_compare(before, after)
        self.assertFalse(verified)
        self.assertFalse(next(d for d in dimensions if d['dimension'] == 'parameters')['matched'])

    def test_occurrence_path_added_or_removed_detected(self):
        # Same occurrence count but a different full path: the occurrence-set
        # branch (not the per-index transform branch) must flag it.
        before, after = self.snapshot(), self.snapshot()
        after['occurrences'] = {'Occ:2': after['occurrences']['Occ:1']}
        verified, dimensions = helper._atomic_compare(before, after)
        self.assertFalse(verified)
        self.assertFalse(next(d for d in dimensions if d['dimension'] == 'occurrences')['matched'])

    def test_body_count_mismatch_detected(self):
        # A committed extra body that was not reverted: the bodies-length branch
        # must report it (not silently accept an equal subset).
        before = self.snapshot()
        after = self.snapshot()
        after['bodies'] = after['bodies'] + [dict(after['bodies'][0], name='Body2')]
        after['counts']['bodies'] = len(after['bodies'])
        verified, dimensions = helper._atomic_compare(before, after)
        self.assertFalse(verified)
        self.assertFalse(next(d for d in dimensions if d['dimension'] == 'bodies.count')['matched'])

    def test_body_bounds_none_vs_value_mismatch_detected(self):
        # A body with no measured bounds versus one with bounds is a mismatch,
        # not silently ignored (the None/non-None guard branch).
        verified, dimensions = helper._atomic_compare(
            self.snapshot(bounds=None),
            self.snapshot(bounds=[0.0, 0.0, 0.0, 2.0, 1.0, 1.0]))
        self.assertFalse(verified)
        self.assertFalse(next(d for d in dimensions if d['dimension'] == 'body.bounds')['matched'])


class FaultInjectionTests(unittest.TestCase):
    """Deterministic test-only fault injection (contract §8.4). Verifies the
    three failure phases and the unknown-phase guard of _atomic_test_fault."""

    class FaultCtx:
        def __init__(self):
            self.calls = []

        def call(self, operation, data):
            self.calls.append((operation, data))
            return {'component': {'token': 'T'}}

    def test_after_mutation_raises(self):
        with self.assertRaisesRegex(RuntimeError, 'after-mutation'):
            helper._atomic_test_fault(self.FaultCtx(), {'phase': 'after_mutation'})

    def test_before_ref_publish_creates_then_raises_without_publishing(self):
        ctx = self.FaultCtx()
        with self.assertRaisesRegex(RuntimeError, 'before-ref-publish'):
            helper._atomic_test_fault(ctx, {'phase': 'before_ref_publish', 'name': '__test_orphan'})
        # The object is created via the shared handler, then the ref is never returned.
        self.assertEqual(ctx.calls, [('component.create', {'name': '__test_orphan'})])

    def test_final_validation_returns_failed_status(self):
        result = helper._atomic_test_fault(self.FaultCtx(), {'phase': 'final_validation'})
        self.assertEqual(result, {'status': 'fail', 'message': 'test fault: final validation rejected the result'})
        # The shared result-failure predicate treats this as an unsuccessful result.
        self.assertTrue(helper._atomic_result_failed(result))

    def test_unknown_phase_raises(self):
        with self.assertRaisesRegex(ValueError, 'unknown test fault phase'):
            helper._atomic_test_fault(self.FaultCtx(), {'phase': 'nope'})


if __name__ == '__main__':
    unittest.main()
