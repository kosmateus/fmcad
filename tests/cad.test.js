const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { catalog, validateCad, buildCadScript, prepareCadScript, executeCad } = require('../src/cad');
const { parseCadInput } = require('../src/cad-input');
const { scriptConfig } = require('./helpers/legacy');

const context = { doc: 'Review "Model"\n\\test', component: null, projectId: null, preview: false };
const pythonEntries = Object.entries(catalog).filter(([, entry]) => !entry.nodeOnly && !entry.internalOnly);
const INTERNAL_PYTHON_OPERATIONS = ['document.save_native', 'measure.baseline.capture', 'measure.baseline.inspect',
  'measure.baseline.compare', 'measure.baseline.capture_internal', 'measure.baseline.compare_internal',
  'selection.rule.define', 'selection.rule.inspect', 'selection.rule.resolve', 'selection.rule.check',
  'selection.rule.define_internal', 'selection.rule.inspect_internal',
  'selection.rule.resolve_internal', 'selection.rule.check_internal'];

test('CAD integration: prepared status artifact binds its request and preserves the lightweight profile', () => {
  const prepared = prepareCadScript('document.status', {}, context);
  assert.deepEqual(prepared, prepareCadScript('document.status', {}, context));
  assert.equal(prepared.script, buildCadScript('document.status', {}, context));
  assert.equal(prepared.request.operation, 'document.status');
  assert.ok(prepared.units.some(unit => unit.id === 'values'));
  assert.ok(!prepared.units.some(unit => unit.id === 'model'));
  assert.ok(Object.isFrozen(prepared.bytes));
});

// Only imports and handler registration execute. No Fusion application is available.
const stubImports = `import sys, types, json
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
`;
function python(program, input) {
  const result = spawnSync('python3', ['-B', '-c', program], {
    input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

test('CAD integration: every catalog example validates through the actual dispatcher', async (t) => {
  for (const [operation, entry] of Object.entries(catalog)) {
    await t.test(operation, async () => {
      assert.equal(validateCad(operation, entry.example), entry);
      const input = parseCadInput(['--doc', context.doc, '--data', JSON.stringify(entry.example)], entry.inputs);
      assert.deepEqual(input.data, entry.example);
      const result = await executeCad(null, operation, input.data, { ...context, preview: true });
      assert.equal(result.success, true, JSON.stringify(result));
    });
  }
});

test('joint.rigid catalog accepts opt-in regular mode while rejecting unsupported rotation vectors', () => {
  const data = { name: 'Regular', mode: 'regular', occurrenceOne: 'A:1', occurrenceTwo: 'B:1',
    confirm: true, originOne: { ref: { token: 'origin-a', kind: 'JointOrigin' } },
    originTwo: { point: 'P_B', xAxis: 'X_B', zAxis: 'Z_B' }, posePolicy: 'moveSecond',
    angle: '30 deg', offset: '2 mm', isFlipped: true,
    linearTolerance: '0.01 mm', angularTolerance: '0.01 deg', groundingPolicy: 'reject' };
  assert.equal(validateCad('joint.rigid', data), catalog['joint.rigid']);
  assert.throws(() => validateCad('joint.rigid', { ...data, rotationAxisVector: [0, 0, 1] }), /Unknown CAD inputs/);
});

test('CAD integration: every generated Python request compiles and round-trips JSON', () => {
  for (const [operation, entry] of pythonEntries) {
    const script = buildCadScript(operation, entry.example, context);
    if (entry.curve) {
      const request = scriptConfig(script, ['_FMCAD_REQUEST'])._FMCAD_REQUEST;
      assert.equal(request.operation, operation);
      assert.deepEqual(request.data, require('../src/curve').prepare(operation, entry.example));
      continue;
    }
    if (entry.dataImport) {
      const request = scriptConfig(script, ['_FMCAD_REQUEST'])._FMCAD_REQUEST;
      assert.equal(request.operation, operation);
      assert.equal(request.data.version, 1);
      assert.ok(request.data.digest);
      continue; // File adapters serialize their validated plan, not CLI-host paths/raw records.
    }
    const expectedData = operation === 'inspect.pack'
      ? require('../src/dist/core/application/inspection').planInspection(entry.example, require('../src/catalog').contracts, validateCad)
      : entry.example;
    assert.deepEqual(scriptConfig(script, ['_FMCAD_REQUEST'])._FMCAD_REQUEST,
      { operation, data: expectedData, doc: context.doc, component: null, projectId: null });
  }
});

test('CAD integration: executable Python registry exactly matches non-Node catalog without overwrites', () => {
  const script = buildCadScript('status', {}, context);
  const output = python(stubImports + `import ast
tree = ast.parse(sys.stdin.read())
class Registry(dict):
    def update(self, entries):
        for key, handler in entries.items():
            assert key not in self, 'Duplicate handler: ' + key
            assert callable(handler), key
            self[key] = handler
namespace = {'Registry': Registry}
for node in tree.body:
    if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'CAD_HANDLERS' for t in node.targets):
        node.value = ast.Call(func=ast.Name(id='Registry', ctx=ast.Load()), args=[], keywords=[])
ast.fix_missing_locations(tree)
exec(compile(tree, '<cad-registry>', 'exec'), namespace)
print(json.dumps(sorted(namespace['CAD_HANDLERS'])))
`, script);
  assert.deepEqual(JSON.parse(output), [...pythonEntries.map(([operation]) => operation),
    ...INTERNAL_PYTHON_OPERATIONS].sort());
  assert.deepEqual(Object.entries(catalog).filter(([, e]) => e.nodeOnly).map(([op]) => op).sort(),
    ['batch.finalize', 'batch.preview', 'batch.reconcile', 'batch.run', 'batch.summary', 'batch.validate',
      'capabilities.inspect', 'capabilities.probe', 'component.externalize',
      'definition.expand', 'definition.inspect', 'definition.instantiate',
      'document.save.observe', 'document.save.once',
      'drawing.check', 'drawing.export', 'drawing.package', 'measure.baseline.capture',
      'measure.baseline.compare', 'measure.baseline.inspect', 'reference.calibrate', 'reference.compare',
      'reference.layout', 'references.refresh', 'selection.rule.check', 'selection.rule.define',
      'selection.rule.inspect', 'selection.rule.resolve', 'ui.inspect', 'ui.resolve', 'ui.respond']);
});

test('new Node-only routes dispatch through their explicit coordinators, not the Python registry', async t => {
  const client={callTool:async()=>assert.fail('Node routing must not directly submit a generic CAD script')};
  const external=require('../src/externalization'),references=require('../src/references-refresh'),ui=require('../src/ui');
  const documentPublication=require('../src/document-publication');
  t.mock.method(external,'execute',async(c,data,ctx,adapter)=>{
    assert.equal(c,client);assert.equal(typeof adapter.step,'function');assert.equal(typeof adapter.refresh,'function');
    return {route:'externalization'};
  });
  t.mock.method(references,'execute',async(c,data,ctx,adapter)=>{
    assert.equal(c,client);assert.equal(typeof adapter.step,'function');assert.equal(typeof adapter.inspectUi,'function');
    return {route:'references'};
  });
  t.mock.method(ui,'execute',async(c,operation)=>{assert.equal(c,client);return {route:operation};});
  t.mock.method(documentPublication,'execute',async(c,operation,data,ctx,execute)=>{
    assert.equal(c,client);assert.equal(typeof execute,'function');return {route:operation};
  });
  for(const [operation,route] of [['component.externalize','externalization'],['references.refresh','references'],
      ['ui.inspect','ui.inspect'],['ui.resolve','ui.resolve'],['ui.respond','ui.respond'],
      ['document.save.once','document.save.once'],['document.save.observe','document.save.observe']]){
    assert.deepEqual(await executeCad(client,operation,catalog[operation].example,context),{route});
  }
  for(const operation of ['batch.reconcile','batch.finalize'])
    await assert.rejects(executeCad(null,operation,catalog[operation].example,context),/requires the selected addin backend/);
  const { commands }=require('../src/commands');
  assert.equal(commands.some(command=>command.target==='document.save_native'),false,
    'internal save primitive must not be exposed as a CLI command');
});

test('CAD integration: aliases have unique owners, exact targets and collision-free help', () => {
  const { commands, findCommand } = require('../src/commands');
  const { detail } = require('../src/help');
  const owners = new Map();
  for (const command of commands) {
    for (const spelling of [command.key, ...(command.aliases || [])]) {
      assert.equal(owners.has(spelling), false, `Collision: ${spelling}`);
      owners.set(spelling, command);
      assert.equal(findCommand(spelling.split(' ')), command, spelling);
      if (command.aliases?.includes(spelling)) assert.ok(detail(...spelling.split(' ')).includes(command.usage), spelling);
    }
  }
  assert.deepEqual(commands.filter(c => c.kind === 'cad').map(c => c.target).sort(),
    Object.keys(catalog).filter(operation => !catalog[operation].internalOnly).sort());
  assert.equal(findCommand(['export', 'step']).kind, 'export');
  assert.equal(findCommand(['cad', 'export', 'step']).target, 'export.step');
});

test('CAD integration: CLI previews for every catalog route and alias never load config or construct a client', async () => {
  const { commands } = require('../src/commands');
  const { main } = require('../src/cli');
  let networkAttempts = 0;
  const forbidden = () => { networkAttempts++; throw new Error('Preview must stay offline'); };
  for (const command of commands.filter(c => c.kind === 'cad')) {
    for (const spelling of [command.key, ...(command.aliases || [])]) {
      let stdout = '', stderr = '';
      const code = await main([...spelling.split(' '), '--doc', context.doc, '--data',
        JSON.stringify(catalog[command.target].example), '--preview', '--json'], {
        loadConfig: forbidden, McpClient: class { constructor() { forbidden(); } },
        stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } },
        setExitCode: () => {},
      });
      assert.equal(code, 0, `${spelling}: ${stderr}`);
      assert.equal(JSON.parse(stdout).success, true, spelling);
    }
  }
  assert.equal(networkAttempts, 0);
});

test('CAD integration: unsupported input flags and keys fail before any executor call', async () => {
  let calls = 0;
  const client = { callTool: async () => { calls++; assert.fail('Invalid input reached executor'); } };
  for (const [operation, entry] of Object.entries(catalog)) {
    assert.throws(() => parseCadInput(['--unsupported-review-flag', 'true'], entry.inputs), /Unknown CAD option/);
    await assert.rejects(executeCad(client, operation, { ...entry.example, unsupportedReviewFlag: true }, context), /Unknown CAD inputs/);
  }
  assert.equal(calls, 0);
});

test('CAD integration: transport readOnly and generated activation agree for every Python operation', async () => {
  for (const [operation, entry] of pythonEntries) {
    let request;
    const client = { callTool: async args => {
      request = args;
      return { text: 'FMCAD_RESULT ' + JSON.stringify({ success: true, operation, result: {} }) };
    } };
    await executeCad(client, operation, entry.example, context);
    assert.equal(request.object.readOnly, entry.readOnly, operation);
    const keepActive = entry.readOnly || operation === 'document.clear' || operation === 'selection.highlight' || (operation.startsWith('camera.') && operation !== 'camera.set') || operation === 'shot.pack';
    python(stubImports + `exec(sys.stdin.read())
calls = []
class Context(CadContext):
    def __init__(self, *args):
        self.doc_id = self.doc_file_id = None
        self.app = types.SimpleNamespace(activeDocument=object())
        self.doc = types.SimpleNamespace(name='Review', activate=self.activate)
        self.created = []
    def activate(self):
        calls.append('activate')
        self.app.activeDocument = self.doc
        return True
    def call(self, operation, data):
        assert (self.app.activeDocument == self.doc) == ${keepActive ? 'False' : 'True'}
        calls.append('handler')
        return {}
CadContext = Context
run('')
assert calls == ${keepActive ? "['handler']" : "['activate', 'handler']"}, calls
`, request.object.script);
  }
});

test('CAD integration: generated trailer must not turn failed handler evidence into success', () => {
  const script = buildCadScript('parameter.test', catalog['parameter.test'].example, context);
  const text = python(stubImports + `exec(sys.stdin.read())
class Context(CadContext):
    def __init__(self, *args):
        self.doc_id = self.doc_file_id = None
        self.doc = types.SimpleNamespace(name='Review')
        self.app = types.SimpleNamespace(activeDocument=self.doc)
        self.created = []
    def call(self, operation, data):
        return {'passed': False, 'status': 'fail', 'restored': False, 'restoreErrors': ['restore setter failed']}
CadContext = Context
run('')
`, script);
  const output = JSON.parse(text.split('\n').find(s => s.startsWith('FMCAD_RESULT ')).slice(13));
  assert.equal(output.success, false, JSON.stringify(output));
});

test('CAD integration: batch stops and refuses replay on nested failed CAD evidence', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcad-cad-review-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const client = { callTool: async () => {
    calls++;
    return { text: 'FMCAD_RESULT ' + JSON.stringify({ success: true,
      operation: calls === 1 ? 'check' : 'sketch.create',
      result: calls === 1 ? { passed: false, status: 'fail' } : { sketch: { token: 'mock-sketch' } }, created: [] }) };
  } };
  const data = { runId: 'nested-failure', atomic: false, reportPath: dir, operations: [
    { id: 'gate', operation: 'check', data: catalog.check.example, onExisting: 'reuse' },
    { id: 'later', operation: 'sketch.create', data: catalog['sketch.create'].example, onExisting: 'reuse' },
  ] };
  const result = await executeCad(client, 'batch.run', data, context);
  assert.equal(result.success, false, JSON.stringify(result));
  assert.equal(calls, 1);
  assert.equal(result.steps[1].status, 'skipped');
  await assert.rejects(executeCad(client, 'batch.run', data, context), /inspection|failed/);
});

test('CAD integration: advertised component input flag is not swallowed by context parsing', () => {
  const input = parseCadInput(['--doc', 'Model', '--input-component', 'Bracket', '--name', 'MountBracket'],
    catalog['component.rename'].inputs);
  assert.equal(validateCad('component.rename', input.data), catalog['component.rename']);
  assert.equal(input.data.component, 'Bracket');
});

test('CAD integration: explicit extrude directions dispatch using existing model API stubs', () => {
  python(`import sys
sys.path.insert(0, ${JSON.stringify(__dirname)})
import model_test as model
for direction in ('positive', 'negative'):
    ctx = model.Context()
    data = dict(model.CATALOG['model.extrude']['example'], direction=direction)
    result = model.HANDLERS['model.extrude'](ctx, data)
    assert result['feature']
`, '');
});

test('CAD integration: selection highlight respects its already-active-document contract', () => {
  const script = buildCadScript('selection.highlight', { refs: [], replace: true }, context);
  python(stubImports + `exec(sys.stdin.read())
activations = []
class Context(CadContext):
    def __init__(self, *args):
        self.doc_id = self.doc_file_id = None
        self.doc = types.SimpleNamespace(name='Review', activate=self.activate)
        self.app = types.SimpleNamespace(activeDocument=object(), userInterface=types.SimpleNamespace(
            activeSelections=types.SimpleNamespace(clear=lambda: True, count=0)))
        self.created = []
    def activate(self):
        activations.append(True)
        self.app.activeDocument = self.doc
    def call(self, operation, data):
        return CAD_HANDLERS[operation](self, data)
CadContext = Context
try:
    run('')
except ValueError as error:
    assert 'already be active' in str(error)
assert not activations, 'Generated trailer activated a document despite selection.highlight contract'
`, script);
});
