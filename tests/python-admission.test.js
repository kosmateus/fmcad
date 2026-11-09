'use strict';
const test = require('node:test');
test.after(require('./fixtures/fake-wsl-platform.cjs')());
const { assertDocumentStatusAdmission } = require('../dist/tests/fixtures/document-status-admission');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { dispatchPrepared } = require('../packages/core/dist');
const { createPythonRpcAdmission, classifyPythonRpc, pythonAdmissionResources } = require('../packages/node-adapters/dist/python/admission');
const { createPythonChecker } = require('../packages/node-adapters/dist/python/checker');
const { preparePythonArtifact } = require('../packages/node-adapters/dist/python/artifact');
const { validateInvocation } = require('../src/catalog');
const { prepareCadScript } = require('../src/cad');
const { createProductionQueueAdmission } = require('../src/queue-admission');
const documentStatusAdmission = require('./fixtures/document-status-admission-6bb.json');
const runtime = path.resolve('dist/runtime/python');
const raw = code => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute_python', arguments: { code, persistent: false } } });
const official = script => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fusion_mcp_execute', arguments: { featureType: 'script', object: { script } } } });
function report(artifact, status = 'passed') {
  return { status, diagnostics: [], reasons: [], provenance: { artifactHash: artifact.artifactHash,
    wireHash: artifact.sha256, analysisHash: 'analysis', checkerHash: 'checker', configHash: 'config', typingHash: 'typing' } };
}
function adapter(check = async ({artifact}) => report(artifact), resources = () => 'resources') {
  return createPythonRpcAdmission({runtime, checker: {check}, resources});
}
function dispatch(admission, outgoing, trace = [], more = {}) {
  let certificate;
  return dispatchPrepared({ prepare: () => outgoing,
    async check(payload) { trace.push('check'); certificate = await admission.check(payload); },
    admit(send) { trace.push('grant'); return send(); },
    fence(payload) { certificate.fence(payload); queueMicrotask(() => trace.push('microtask')); },
    async send(payload) { trace.push('send'); return structuredClone(payload); },
    settle: (_, reply) => reply, unknown() { trace.push('unknown'); }, ...more,
  });
}

test('all rejecting checker statuses and mismatched identity produce zero admission and zero SDK calls', async () => {
  for (const status of ['failed', 'incomplete', 'tool_error']) {
    for (const payload of [raw('x: int = "bad"'), official('x: int = "bad"')]) {
      const trace = [];
      await assert.rejects(dispatch(adapter(async ({artifact}) => report(artifact,status)), payload, trace), {code:'PYTHON_CHECK_REJECTED'});
      assert.deepEqual(trace,['check']);
    }
  }
  const trace = [];
  await assert.rejects(dispatch(adapter(async ({artifact}) => ({...report(artifact),provenance:{...report(artifact).provenance,wireHash:'other'}})),raw('x: int = 1'),trace));
  assert.deepEqual(trace,['check']);
  await assert.rejects(dispatch(adapter(async () => {throw new Error('missing checker');}),raw('x: int = 1')), {code:'PYTHON_CHECK_TOOL_ERROR'});
});

test('checked exact final bytes send once, with no asynchronous turn after grant', async () => {
  for (const payload of [raw('x: int = 1'),official('x: int = 1')]) {
    const trace = [];
    const result = await dispatch(adapter(),payload,trace);
    assert.deepEqual(result,payload);
    assert.deepEqual(trace,['check','grant','send','microtask']);
  }
});

test('Python admission forwards its local-phase cancellation signal to the checker', async () => {
  const controller=new AbortController();
  let received;
  const admission=adapter(async ({artifact},options)=>{received=options.signal;return report(artifact);});
  const certificate=await admission.check(raw('x: int = 1'),undefined,{signal:controller.signal});
  assert.equal(received,controller.signal);
  certificate.fence(raw('x: int = 1'));
});

test('TOCTOU source, RPC class, context, source units and resources are fenced without replay', async () => {
  for (const mutate of [p => p.params.arguments.code += '\nx: str = 2',p => p.params.name='capture_viewport',p => p.id=2]) {
    const payload = raw('x: int = 1'), trace = [];
    await assert.rejects(dispatch(adapter(),payload,trace,{admit(send){mutate(payload);return send();}}), {code:'PYTHON_ADMISSION_CHANGED'});
    assert.deepEqual(trace,['check']);
  }
  let resources = 'one';
  const payload = raw('x: int = 1');
  const certificate = await adapter(undefined,()=>resources).check(payload);
  resources='two';
  assert.throws(()=>certificate.fence(payload),{code:'PYTHON_ADMISSION_CHANGED'});
  const original = preparePythonArtifact([{id:'user',filename:'user.py',role:'user',source:'x: int = 1'}]);
  for (const modified of [{...original,context:{app:true}},{...original,units:[]},{...original,bytes:[0]}])
    await assert.rejects(adapter().check(raw(original.script),modified));
});

test('explicit non-Python class does not invoke checker and cannot become Python later', async () => {
  const admission = adapter(async()=>assert.fail('non-Python must not invoke checker'));
  for (const payload of [{method:'initialize'}, {method:'tools/list'}, {method:'ping'}, {method:'notifications/initialized'},
    {method:'resources/list'}, {method:'resources/templates/list'},
    {method:'tools/call',params:{name:'fusion_mcp_execute',arguments:{featureType:'document'}}},
    ...['fusion_mcp_read','capture_viewport','get_viewport','fetch_api_documentation','fetch_design_guide'].map(name=>({method:'tools/call',params:{name}}))]) {
    assert.equal(classifyPythonRpc(payload).kind,'non-python');
    const certificate = await admission.check(payload);
    certificate.fence(payload);
    payload.method='tools/call';payload.params={name:'execute_python',arguments:{code:'print(1)'}};
    assert.throws(()=>certificate.fence(payload));
  }
  assert.throws(()=>classifyPythonRpc({method:'tools/call',params:{name:'unknown_tool'}}));
});

test('real checker rejects nested bad Python and preserves literal filenames (not an entrypoint coverage claim)', async () => {
  const admission = createPythonRpcAdmission({runtime,checker:createPythonChecker({typingRoot:path.join(runtime,'typing')}),resources:()=> 'test-immutable'});
  for (const kind of ['user','internal']) {
    const source = `exec(compile(${JSON.stringify('x: int = "bad"')}, ${JSON.stringify(kind+'.py')}, 'exec'))`;
    const trace=[];
    await assert.rejects(dispatch(admission,official(source),trace),error=>{
      assert.equal(error.code,'PYTHON_CHECK_REJECTED');
      assert.ok(error.pythonCheck.diagnostics.some(d=>d.filename===kind+'.py' && d.rule==='reportAssignmentType'), JSON.stringify(error.pythonCheck));
      return true;
    });
    assert.deepEqual(trace,['check']);
  }
  const trace=[];
  await dispatch(admission,raw('x: int = 1'),trace);
  assert.deepEqual(trace,['check','grant','send','microtask']);
});

test('real internal receipt wrapper passes with verified SDK definitions and rejects nested errors', async () => {
  const {prepareReceiptScript} = require('../src/queue-instance');
  const artifact = prepareReceiptScript('def run(context: object) -> None:\n    pass',true,'/tmp/opencode/never-written.json',{jobId:'test'});
  const admission = createPythonRpcAdmission({runtime,checker:createPythonChecker({typingRoot:path.join(runtime,'typing'),
    definitionsRoot:path.join(runtime,'typing'),pythonPlatform:'Windows'})});
  const certificate = await admission.check(official(artifact.script),artifact);
  assert.equal(certificate.report.status,'passed');
  certificate.fence(official(artifact.script));
  const bad=prepareReceiptScript('def run(context: object) -> None:\n    value: int = "bad"',true,'/tmp/opencode/never-written.json',{jobId:'bad'});
  await assert.rejects(admission.check(official(bad.script),bad),error=>error.code==='PYTHON_CHECK_REJECTED'&&
    error.pythonCheck.diagnostics.some(d=>d.rule==='reportAssignmentType'&&d.filename==='<fmcad-queue>'));
  for (const source of ['def run(first: str, second: str) -> None:\n    pass', 'def run(context: int) -> None:\n    pass']) {
    const mismatched=prepareReceiptScript(source,true,'/tmp/opencode/never-written.json',{jobId:'wrong-entrypoint'});
    await assert.rejects(admission.check(official(mismatched.script),mismatched),error=>error.code==='PYTHON_CHECK_REJECTED'&&
      error.pythonCheck.diagnostics.some(d=>d.rule==='reportAssignmentType'&&d.filename==='<fmcad-queue>'));
  }
  assert.equal(fs.existsSync('/tmp/opencode/never-written.json'),false);
});

test('public document.status checks the current six-unit artifact before exactly one send', async () => {
  const invocation = validateInvocation({ version: 1, kind: 'cad', operation: 'document.status', data: {},
    doc: 'Model', docId: 'creation', docFileId: 'file', purpose: 'Inspect owned model' });
  const artifact = prepareCadScript(invocation.operation, invocation.data, {
    doc: invocation.doc, docId: invocation.docId, docFileId: invocation.docFileId,
    component: invocation.component, projectId: invocation.projectId, preview: invocation.preview === true,
  });
  const production = createProductionQueueAdmission(runtime);
  function outgoingFor(pythonArtifact) {
    return { jsonrpc: '2.0', id: 'document-status-test', method: 'tools/call', params: {
      name: 'fusion_mcp_execute', arguments: {
        featureType: 'script', object: { script: pythonArtifact.script, readOnly: true },
      },
    } };
  }
  function dispatchArtifact(admission, pythonArtifact) {
    const outgoing = outgoingFor(pythonArtifact);
    let certificate;
    let senderCalls = 0;
    const promise = dispatchPrepared({
      prepare: () => outgoing,
      async check(payload) { certificate = await admission.check(payload, pythonArtifact); },
      admit(send) { return send(); },
      fence(payload) { certificate.fence(payload); },
      async send(payload) { senderCalls++; return structuredClone(payload); },
      settle: (_, reply) => reply,
      unknown() { assert.fail('A checked document.status request became unknown'); },
    });
    return { promise, outgoing, get certificate() { return certificate; }, get senderCalls() { return senderCalls; } };
  }
  function rebuild(units) {
    return preparePythonArtifact(units.map(({ id, filename, source, role }) => ({ id, filename, source, role })), {
      context: artifact.context, request: artifact.request,
    });
  }

  const valid = dispatchArtifact(production.admission, artifact);
  await valid.promise;
  assert.equal(valid.certificate.report.status, 'passed');
  assert.equal(valid.certificate.report.diagnostics.length, 0);
  assertDocumentStatusAdmission(artifact);
  assert.equal(valid.certificate.artifact.sha256, artifact.sha256);
  assert.equal(valid.certificate.artifact.artifactHash, artifact.artifactHash);
  assert.equal(valid.certificate.report.provenance.checker, documentStatusAdmission.checker.engine);
  assert.equal(valid.certificate.report.provenance.checkerVersion, documentStatusAdmission.checker.version);
  assert.equal(valid.certificate.report.provenance.definitionsHash, documentStatusAdmission.checker.definitionsHash);
  assert.deepEqual(valid.certificate.artifact.units, artifact.units);
  assert.equal(valid.senderCalls, documentStatusAdmission.fences.dispatchPreparedSenderCallsPerValidArtifact);
  assert.deepEqual(valid.certificate.artifact.units.map(unit => unit.id),
    ['values', 'fusion-values', 'core', 'identity', 'document_snapshot', 'wrapper']);

  const invalid = rebuild(artifact.units.map(unit => ({ ...unit,
    source: unit.id === 'wrapper' ? unit.source + '\nstatus_bad: int = "bad"\n' : unit.source,
  })));
  const rejectedType = dispatchArtifact(production.admission, invalid);
  await assert.rejects(rejectedType.promise, error => {
    assert.equal(error.code, 'PYTHON_CHECK_REJECTED');
    assert.equal(error.pythonCheck.status, 'failed');
    assert.ok(error.pythonCheck.diagnostics.some(item => item.rule === 'reportAssignmentType'));
    return true;
  });
  assert.equal(rejectedType.senderCalls, documentStatusAdmission.fences.dispatchPreparedSenderCallsPerNegativeMode);

  const incomplete = rebuild(artifact.units.filter(unit => unit.id !== 'identity'));
  const rejectedIncomplete = dispatchArtifact(production.admission, incomplete);
  await assert.rejects(rejectedIncomplete.promise, error => {
    assert.ok(['PYTHON_CHECK_REJECTED', 'PYTHON_ADMISSION_UNAVAILABLE'].includes(error.code));
    return true;
  });
  assert.equal(rejectedIncomplete.senderCalls, documentStatusAdmission.fences.dispatchPreparedSenderCallsPerNegativeMode);

  let tamperSends = 0;
  const tampered = structuredClone(valid.outgoing);
  tampered.params.arguments.object.script += '\n# changed after final-byte check\n';
  assert.throws(() => {
    valid.certificate.fence(tampered);
    tamperSends++;
  });
  assert.equal(tamperSends, documentStatusAdmission.fences.dispatchPreparedSenderCallsPerNegativeMode);

  const missingChecker = adapter(async () => { throw new Error('basedpyright unavailable'); });
  const rejectedMissingChecker = dispatchArtifact(missingChecker, artifact);
  await assert.rejects(rejectedMissingChecker.promise, { code: 'PYTHON_CHECK_TOOL_ERROR' });
  assert.equal(rejectedMissingChecker.senderCalls, documentStatusAdmission.fences.dispatchPreparedSenderCallsPerNegativeMode);
});

test('actual run, CAD document, legacy, review and internal probe sources are inventoried and checked', async t => {
  const root=fs.mkdtempSync('/tmp/opencode/admission-builders-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'user.py');fs.writeFileSync(file,'def run(context: object) -> None:\n    value: int = "bad"\n');
  const {prepareRunScript}=require('../src/run');
  const {prepareCadScript}=require('../src/cad');
  const {prepareOpScript}=require('../src/ops');
  const {buildReviewScript}=require('../src/review');
  const {queueDocumentSnapshotSource}=require('../src/dist/python/document-probe');
  const sources=[prepareRunScript(file,[],false,undefined).script,
    prepareCadScript('document.status',{}, {doc:'fixture'}).script,
    prepareOpScript('stats',[]).script,buildReviewScript({}),queueDocumentSnapshotSource(runtime)];
  const checker=createPythonChecker({typingRoot:path.join(runtime,'typing')});
  for(const source of sources) {
    const trace=[];
    const admission=createPythonRpcAdmission({runtime,checker,resources:()=> 'test-immutable'});
    await assert.rejects(dispatch(admission,official('bad_admission_value: int = "bad"\n'+source),trace), error=>{
      assert.ok(['PYTHON_CHECK_REJECTED','PYTHON_CHECK_TOOL_ERROR'].includes(error.code));return true;
    });
    assert.deepEqual(trace,['check']);
  }
});

test('resource content and inventory bind checker/stubs, not timestamps', t => {
  const dir=fs.mkdtempSync('/tmp/opencode/admission-resources-');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'stub.pyi'),'one');const a=pythonAdmissionResources([dir]);
  fs.writeFileSync(path.join(dir,'stub.pyi'),'two');assert.notEqual(pythonAdmissionResources([dir]),a);
  fs.writeFileSync(path.join(dir,'extra.pyi'),'');const b=pythonAdmissionResources([dir]);
  fs.unlinkSync(path.join(dir,'extra.pyi'));assert.notEqual(pythonAdmissionResources([dir]),b);
});

test('two clients can prepare concurrently; a suspended checker never occupies the physical gate', async () => {
  const {QueueGate}=require('../packages/node-adapters/dist/execution/gate');
  const gate=new QueueGate({data:{paused:false,blocked:null,controlGeneration:0,contextEpoch:0}},'instance');
  let release,reached;
  const ready=new Promise(resolve=>{reached=resolve;});
  const waiting=new Promise(resolve=>{release=resolve;});
  const admission=adapter(async ({artifact})=>{reached();await waiting;return report(artifact);});
  let certificate,sent=0;
  const a=dispatchPrepared({prepare:()=>raw('x: int = 1'),async check(p){certificate=await admission.check(p);},
    admit:send=>gate.run(send),fence:p=>certificate.fence(p),async send(){sent++;},settle:()=>{},unknown:()=>assert.fail('unknown')});
  await ready;assert.equal(gate.active.size,0);
  await gate.run(async()=>{assert.equal(gate.active.size,1);sent++;});
  assert.equal(sent,1);release();await a;assert.equal(sent,2);assert.equal(gate.active.size,0);
});

test('typed phased-worker local checking precedes SDK-ready and rejects without scheduling a turn', async () => {
  const {PhasedWorkers}=require('../packages/node-adapters/dist/execution/phased-workers');
  let turns=0,release,reached;
  const ready=new Promise(resolve=>{reached=resolve;});
  const wait=new Promise(resolve=>{release=resolve;});
  const workers=new PhasedWorkers({state:{status(){return {state:'preparing'};},readyTurn(){turns++;}},async checkSdkRequest(){reached();await wait;throw Object.assign(new Error('bad Python'),{code:'PYTHON_CHECK_REJECTED'});}});
  const record={job:{id:'job'},token:'token',pending:null,localRemaining:10000,localStarted:performance.now(),timer:null};
  workers.workers.set('job',record);
  const pending=workers.enqueue({jobId:'job',workerToken:'token',method:'callTool',args:[]});
  await ready;assert.equal(turns,0);release();
  await assert.rejects(pending,{code:'PYTHON_CHECK_REJECTED'});
  assert.equal(turns,0);assert.equal(record.pending,null);clearTimeout(record.timer);
});

test('typed phased-worker local deadline aborts the pending admission check', async (t) => {
  const {PhasedWorkers}=require('../packages/node-adapters/dist/execution/phased-workers');
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fmcad-check-abort-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let observedSignal, aborted, workers, record;
  let resolveAborted;
  const abortSeen=new Promise(resolve=>{resolveAborted=resolve;});
  workers=new PhasedWorkers({
    state:{status(){return {state:'preparing'};},readyTurn(){assert.fail('timed out work is not SDK-ready');},finishLocal(){}},
    dir,
    durable(){},readResult(){return null;},workflowNonterminal(){return false;},
    responsePath(_dir,_job,name){return path.join(dir,name);},
    onUnknown(){assert.fail('local analysis timeout is not an SDK turn');},onFault(error){throw error;},
    async checkSdkRequest(_message,signal){
      observedSignal=signal;
      await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolveAborted();resolve();},{once:true}));
    },
  });
  record={job:{id:'abort-job',request:{cwd:dir}},token:'token',pending:null,localRemaining:20,localStarted:performance.now(),timer:null,
    child:{kill(){workers.finish(record,1,path.join(dir,'jobs','abort-job'));}}};
  workers.workers.set('abort-job',record);
  const pending=workers.enqueue({jobId:'abort-job',workerToken:'token',method:'callTool',args:[]});
  workers.resumeLocal(record);
  record.timer.ref();
  await abortSeen;
  assert(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted,true);
  assert.equal(aborted,true);
  await assert.rejects(pending,{code:'WORKER_CLOSED'});
});

test('SDK host platform is explicit and bound to checker configuration, not inferred from Linux process', async () => {
  const artifact=preparePythonArtifact([{id:'host',filename:'host.py',role:'user',source:'import ctypes\nctypes.WinDLL("kernel32")'}]);
  const check=pythonPlatform=>createPythonChecker({typingRoot:path.join(runtime,'typing'),pythonPlatform}).check({artifact,context:{kind:'raw'}});
  const linux=await check('Linux'), windows=await check('Windows');
  assert.ok(linux.diagnostics.some(d=>d.rule==='reportAttributeAccessIssue'&&d.message.includes('WinDLL')));
  assert.ok(!windows.diagnostics.some(d=>d.rule==='reportAttributeAccessIssue'&&d.message.includes('WinDLL')));
  assert.notEqual(linux.provenance.configHash,windows.provenance.configHash);
});

test('canonical broker document probe with receipt is fully checked without submitting its prepared call', async () => {
  const {prepareProbe}=require('../src/queue-instance');
  const admission=createPythonRpcAdmission({runtime,checker:createPythonChecker({typingRoot:path.join(runtime,'typing'),
    definitionsRoot:path.join(runtime,'typing'),pythonPlatform:'Windows'})});
  let checked;
  const prepared=await prepareProbe({server:{timeoutMs:5000},async prepareCallTool(args){
    checked=await admission.check(official(args.object.script));
    return Object.assign(async()=>assert.fail('offline preparation must not execute the probe'),{fence:()=>checked.fence(official(args.object.script))});
  }},{receiptPath:'/tmp/opencode/never-probe.json',binding:{jobId:'probe'},documentSelector:{creationId:'fixture'}});
  assert.equal(checked.report.status,'passed');prepared.fence();
  assert.equal(fs.existsSync('/tmp/opencode/never-probe.json'),false);
});

test('broker-reserved job identity binds a receipt before acceptance without changing client idempotency', () => {
  const {QueueDomain}=require('../src/dist/core');
  const queue=new QueueDomain({now:()=>1000,newId:()=>assert.fail('job identity was already reserved'),hash:value=>value});
  const request={requestId:'request',clientId:'client',kind:'rpc',payload:raw('x: int = 1'),timeoutMs:1000};
  assert.equal(queue.submit(request,'prepared-job').id,'prepared-job');
  assert.equal(queue.submit(request,'unused-competing-reservation').id,'prepared-job');
  assert.equal(queue.next().id,'prepared-job');
  const before=JSON.stringify(queue.data);
  assert.throws(()=>queue.submit({...request,requestId:'other'},'prepared-job'),{code:'INVALID_PREPARED_ID'});
  assert.equal(JSON.stringify(queue.data),before);
});

test('admission report cannot be rewritten after it authorizes final bytes', async () => {
  const certificate=await adapter().check(raw('x: int = 1'));
  assert.ok(Object.isFrozen(certificate.report));
  assert.ok(Object.isFrozen(certificate.report.provenance));
  assert.throws(()=>{certificate.report.provenance.wireHash='foreign';},TypeError);
});

test('caller mutation during checker await cannot authorize different RPC bytes or mutable source units', async () => {
  const original=preparePythonArtifact([{id:'user',filename:'user.py',source:'x: int = 1',role:'user'}]);
  const mutable=structuredClone(original), payload=raw(original.script);
  const checked=adapter(async ({artifact})=>{
    assert.ok(Object.isFrozen(artifact.units));
    Object.assign(mutable,preparePythonArtifact([{id:'user',filename:'user.py',source:'x: str = 1',role:'user'}]));
    assert.equal(artifact.script,original.script);
    return report(artifact);
  });
  const certificate=await checked.check(payload,mutable);
  certificate.fence(payload);
  assert.equal(certificate.artifact.sha256,original.sha256);
  const trace=[];
  await assert.rejects(dispatch(adapter(async ({artifact})=>{
    payload.params.arguments.code='x: str = 1';return report(artifact);
  }),payload,trace),{code:'PYTHON_ADMISSION_CHANGED'});
  assert.deepEqual(trace,['check']);
});
