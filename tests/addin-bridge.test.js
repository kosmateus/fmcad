const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { buildBridgeScript } = require('../src/addin-bridge');

const harness = String.raw`
import contextlib, io, json, sys, types
from types import SimpleNamespace as NS
params = json.load(sys.stdin)
calls = []
class Collection(list):
    def asArray(self):
        return list(self)
    def open(self, file):
        calls.append(['open', file.id])
        return None if params.get('openFails') else doc
class Document:
    name = 'Unsaved'
    isActive = True
    isSaved = params.get('saved', True)
    isModified = True
    @property
    def dataFile(self):
        assert self.isSaved, 'New documents must not need a cloud file'
        return NS(id='file-1')
    def save(self, description):
        calls.append(['save', description])
        result = params.get('saveResult', True)
        if result is True and not params.get('staysModified'):
            self.isModified = False
        return result
    def close(self, save):
        calls.append(['close', save])
        return params.get('closeResult', True)
doc = Document()
def folder(files=(), folders=()):
    return NS(dataFiles=Collection(files), dataFolders=Collection(folders))
file = NS(name=params.get('fileName', 'DUST Collector'), id='file-1')
projects = Collection([
    NS(name='Workshop', id='p1', rootFolder=folder(folders=[folder([file])])),
    NS(name='Other', id='p2', rootFolder=folder([NS(name='Other Dust', id='file-2')]))
])
def find_file(file_id):
    calls.append(['find', file_id])
    return None if params.get('missingFile') else file
app = NS(documents=Collection([doc]), activeDocument=None if params.get('noDocument') else doc,
         data=NS(dataProjects=projects, findFileById=find_file),
         userInterface=NS(activeCommand=params.get('command', 'ExtrudeCommand')))
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.core.Application = NS(get=lambda: app)
sys.modules['adsk'] = adsk
sys.modules['adsk.core'] = adsk.core
scope = {}
output = io.StringIO()
error = None
with contextlib.redirect_stdout(output):
    try:
        exec(compile(params['source'], '<bridge>', 'exec'), scope)
        assert calls == [], 'Script must not invoke run itself'
        if 'override' in params:
            scope['_BRIDGE_REQUEST'] = params['override']
        scope['run']('')
    except Exception as exc:
        error = str(exc)
print(json.dumps(dict(stdout=output.getvalue(), error=error, calls=calls)))
`;

function invoke(tool, request, options = {}) {
  const result = spawnSync('python3', ['-B', '-c', harness], {
    input: JSON.stringify({ source: buildBridgeScript(tool, request), ...options }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function payload(result) {
  assert.equal(result.error, null);
  assert.match(result.stdout, /^FMCAD_BRIDGE_RESULT /);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  return JSON.parse(result.stdout.slice('FMCAD_BRIDGE_RESULT '.length));
}

const read = request => buildBridgeScript('fusion_mcp_read', request);
const execute = object => ({ featureType: 'document', object });

test('builder emits ASCII, JSON-safe Python and preserves replacement metacharacters', () => {
  const name = 'Za\u017c\u00f3\u0142\u0107 \ud83d\ude80 $& $` $\' \\ "\n';
  const request = { queryType: 'document', operation: 'search', name, extra: [true, false, null] };
  const source = read(request);
  assert.match(source, /def run\(_context: str\):/);
  assert.match(source, /__import__\('json'\).loads/);
  assert.doesNotMatch(source, /[^\x00-\x7f]/);
  const result = invoke('fusion_mcp_read', request, { fileName: name });
  assert.deepEqual(payload(result).results, [{ name, id: 'file-1' }]);
  assert.deepEqual(result.calls, []);
});

test('open documents and projects keep native data shapes without mutation', () => {
  for (const saved of [true, false]) {
    const result = invoke('fusion_mcp_read', { queryType: 'document', operation: 'open' }, { saved });
    assert.deepEqual(payload(result), { success: true, results: [{
      name: 'Unsaved', isActive: true, isSaved: saved, isModified: true,
      ...(saved ? { id: 'file-1' } : {}),
    }] });
    assert.deepEqual(result.calls, []);
  }
  assert.deepEqual(payload(invoke('fusion_mcp_read', { queryType: 'projects' })), {
    success: true, projects: [{ name: 'Workshop', id: 'p1' }, { name: 'Other', id: 'p2' }],
  });
});

test('search traverses folders, normalizes case and Unicode, scopes by project name or id', () => {
  for (const project of [undefined, 'workSHOP', 'p1', 'p2']) {
    const result = invoke('fusion_mcp_read', { queryType: 'document', operation: 'search', name: 'dust', project });
    assert.equal(payload(result).results.length, project ? 1 : 2);
    if (project) assert.equal(payload(result).results[0].id, project === 'p2' ? 'file-2' : 'file-1');
    assert.deepEqual(result.calls, []);
  }
  const result = invoke('fusion_mcp_read', { queryType: 'document', operation: 'search', name: '\u00e9' }, { fileName: 'e\u0301' });
  assert.equal(payload(result).results.length, 1);
  const missing = invoke('fusion_mcp_read', { queryType: 'document', operation: 'search', name: 'dust', project: 'missing' });
  assert.match(missing.error, /Project not found/);
  assert.equal(missing.stdout, '');
});

test('active command reports partial information without fabricated live inputs', () => {
  const result = payload(invoke('fusion_mcp_read', { queryType: 'activeCommand' }));
  assert.deepEqual(result.activeCommand, { id: 'ExtrudeCommand' });
  assert.equal(result.partial, true);
  assert.match(result.limitations, /live inputs are unavailable/);
  assert.equal(payload(invoke('fusion_mcp_read', { queryType: 'activeCommand' }, { command: '' })).activeCommand, null);
});

test('unsupported routes and malformed requests fail before any backend call', () => {
  for (const queryType of ['licensing', 'apiDocumentation', 'screenshot', 'unknown']) {
    assert.throws(() => read({ queryType }), /unsupported.*--backend mcp explicitly/);
  }
  assert.throws(() => read({ queryType: 'document', operation: 'recent' }), /unsupported/);
  assert.throws(() => buildBridgeScript('fusion_mcp_update', { featureType: 'undo' }), /unsupported/);
  assert.throws(() => buildBridgeScript('fusion_mcp_execute', { featureType: 'script' }), /unsupported/);
  assert.throws(() => read(null), /object/);
  assert.throws(() => read({ queryType: 'document', operation: 'search', name: '' }), /nonempty/);
  assert.throws(() => buildBridgeScript('fusion_mcp_execute', execute({ operation: 'open' })), /fileId/);
});

test('open checks file lookup and actual returned document', () => {
  const request = execute({ operation: 'open', fileId: 'file-1' });
  const result = invoke('fusion_mcp_execute', request);
  assert.equal(payload(result).success, true);
  assert.deepEqual(result.calls, [['find', 'file-1'], ['open', 'file-1']]);
  for (const options of [{ missingFile: true }, { openFails: true }]) {
    const failed = invoke('fusion_mcp_execute', request, options);
    assert.ok(failed.error);
    assert.equal(failed.stdout, '');
  }
});

test('close requires exactly one strictly boolean confirmation in JS and Python', () => {
  for (const flags of [{}, { userConfirmedSaveAndClose: true, userConfirmedCloseWithoutSave: true },
    { userConfirmedSaveAndClose: false }, { userConfirmedCloseWithoutSave: 'true' },
    { userConfirmedSaveAndClose: 1 }, { userConfirmedSaveAndClose: null },
    { userConfirmedCloseWithoutSave: true, userConfirmedSaveAndClose: 'false' }]) {
    const request = execute({ operation: 'close', ...flags });
    assert.throws(() => buildBridgeScript('fusion_mcp_execute', request), /confirmation|boolean/);
    const result = invoke('fusion_mcp_read', { queryType: 'projects' }, {
      override: { toolName: 'fusion_mcp_execute', request },
    });
    assert.match(result.error, /confirmation|boolean/);
    assert.equal(result.stdout, '');
    assert.deepEqual(result.calls, []);
  }
});

test('save refuses new documents and reports success only on boolean true', () => {
  const request = execute({ operation: 'save' });
  assert.equal(payload(invoke('fusion_mcp_execute', request)).success, true);
  for (const options of [{ saved: false }, { noDocument: true }, { saveResult: false }, { saveResult: 1 }]) {
    const result = invoke('fusion_mcp_execute', request, options);
    assert.ok(result.error);
    assert.equal(result.stdout, '');
    if (options.saved === false || options.noDocument) assert.deepEqual(result.calls, []);
  }
});

test('save-and-close cannot close on save failure, missing target or remaining changes', () => {
  const request = execute({ operation: 'close', userConfirmedSaveAndClose: true });
  const result = invoke('fusion_mcp_execute', request);
  assert.equal(payload(result).success, true);
  assert.deepEqual(result.calls, [['save', ''], ['close', false]]);
  for (const options of [{ saved: false }, { saveResult: false }, { staysModified: true }]) {
    const failed = invoke('fusion_mcp_execute', request, options);
    assert.ok(failed.error);
    assert.equal(failed.stdout, '');
    assert.ok(failed.calls.every(call => call[0] !== 'close'));
  }
});

test('discard closes without saving and checks close return value', () => {
  const request = execute({ operation: 'close', userConfirmedCloseWithoutSave: true });
  const result = invoke('fusion_mcp_execute', request, { saved: false });
  assert.equal(payload(result).success, true);
  assert.deepEqual(result.calls, [['close', false]]);
  for (const closeResult of [false, 1]) {
    const failed = invoke('fusion_mcp_execute', request, { closeResult });
    assert.match(failed.error, /close failed/);
    assert.equal(failed.stdout, '');
  }
});
