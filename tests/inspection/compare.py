"""Offline fake SDK. Native transaction/admission effects are NOT simulated."""
import contextlib
import io
import json
import sys
import types

adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
strategies = json.load(sys.stdin)
metrics = {}
baseline = None
for name, scripts in strategies.items():
    calls = [0]
    identities = [0]
    rpc_count = 0
    request_bytes = 0
    response_bytes = 0
    results = []
    for script in scripts:
        rpc_count += 1
        request_bytes += len(json.dumps({'featureType': 'script', 'object': {'script': script, 'readOnly': True}}, ensure_ascii=False, separators=(',', ':')).encode())
        namespace = {}
        exec(compile(script, '<fmcad-artifact>', 'exec'), namespace)
        original = namespace['CadContext']

        class FakeContext:
            call = original.call

            def __init__(self, doc, component=None, project=None, creation=None, file=None):
                assert doc == 'InspectionScratch' and creation == 'creation-123' and file == 'file-123'
                self.doc = types.SimpleNamespace(name=doc)
                self.created = {}

            def assert_identity(self):
                identities[0] += 1

            def _scope(self, data):
                return None, None

            def _entities(self, kind, component, occurrence):
                calls[0] += 1
                return [{'name': kind + '-' + str(i), 'kind': kind, 'volume': i + 0.25} for i in range(10)]

            def describe(self, entity):
                return entity

        namespace['CadContext'] = FakeContext
        if name == 'batch':
            # The real atomic wrapper and request are prepared. The fake only
            # evaluates its read steps: no native command, rollback or receipts.
            def execute(request):
                assert request['operation'] == 'atomic_start'
                ctx = FakeContext(request['doc'], creation=request['identity']['creationId'], file=request['identity']['fileId'])
                ctx.assert_identity()
                return {'results': [ctx.call(step['operation'], step['data']) for step in request['steps']]}
            namespace['execute'] = execute
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            namespace['run']('')
        response_bytes += len(output.getvalue().encode('utf-8'))
        envelope = json.loads(next(line[13:] for line in output.getvalue().splitlines() if line.startswith('FMCAD_RESULT ')))
        if name == 'individual':
            results.append(envelope['result'])
        elif name == 'batch':
            results.extend(envelope['results'])
        else:
            assert envelope['result']['status'] == 'pass'
            results.extend(item['result'] for item in envelope['result']['items'])
    if baseline is None:
        baseline = results
    assert results == baseline, name + ' differs from individual reads'
    # Pack shares the repeated kind/scope inventory inside this one invocation.
    assert calls[0] == (10 if name == 'pack' else 20)
    metrics[name] = dict(fakeRpcCount=rpc_count, fakeRequestBytes=request_bytes,
                         fakeResponseBytes=response_bytes,
                         inventoryTraversals=calls[0], readDispatches=len(results), identityChecks=identities[0],
                         equivalentResultBytes=len(json.dumps(results).encode()))
print(json.dumps(metrics))
