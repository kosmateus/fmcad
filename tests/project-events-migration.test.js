'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {EventEmitter}=require('node:events');
const {createHash}=require('node:crypto');
const Module=require('node:module');
function historical(){
  const source=fs.readFileSync(path.join(__dirname,'fixtures/public-host-baseline/project-logger.cjs.txt'),'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'),require('./fixtures/public-host-baseline/provenance.json')['src/opencode/project-logger.cjs'].sha256);
  const filename=path.resolve(__dirname,'../src/opencode/project-logger.cjs'),value=new Module(filename,module);
  value.filename=filename;value.paths=Module._nodeModulePaths(path.dirname(filename));
  value._compile(source+'\nObject.assign(module.exports,{ipc,readJson});',filename);return value.exports;
}

test('typed passive event IPC preserves framing, bounds, authentication bytes and all failures',async()=>{
  const before=historical(),after=require('../src/dist/composition/library-project-events');
  const original=net.createConnection;
  try{
    for(const scenario of ['success','split','denied','null','malformed','oversized','disconnect','error','timeout']){
      async function observe(api){
        const calls=[];
        net.createConnection=options=>{
          calls.push(['connect',options]);const socket=new EventEmitter();
          socket.destroy=()=>calls.push(['destroy']);
          socket.write=bytes=>{calls.push(['write',bytes]);queueMicrotask(()=>{
            if(scenario==='success')socket.emit('data',Buffer.from('{"ok":true,"value":"α"}\n'));
            if(scenario==='split'){socket.emit('data',Buffer.from('{"ok":'));socket.emit('data',Buffer.from('true}\nignored'));}
            if(scenario==='denied')socket.emit('data',Buffer.from('{"ok":false}\n'));
            if(scenario==='null')socket.emit('data',Buffer.from('null\n'));
            if(scenario==='malformed')socket.emit('data',Buffer.from('{broken}\n'));
            if(scenario==='oversized')socket.emit('data',Buffer.from('x'.repeat(8193)));
            if(scenario==='disconnect')socket.emit('end');
            if(scenario==='error')socket.emit('error',Object.assign(Error('connection unavailable'),{code:'ECONNREFUSED'}));
          });};
          queueMicrotask(()=>socket.emit('connect'));return socket;
        };
        let outcome;
        try{outcome={result:await api.ipc({socket:'\0private-observer'},{method:'observation',token:'exact-token',event:{name:'event α'}})};}
        catch(error){outcome={error:error.message,code:error.code};}
        return {calls,outcome};
      }
      assert.deepEqual(await observe(after),await observe(before),scenario);
    }
  }finally{net.createConnection=original;}
});

test('typed passive sink preserves private snapshot guards, event validation, disabling and disposal',async t=>{
  const before=historical(),after=require('../src/dist/composition/library-project-events');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fmcad-event-parity-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const queueDir=path.join(directory,'queue');
  assert.deepEqual(after.locations(queueDir),before.locations(queueDir));
  const state=after.locations(queueDir).stateDir;fs.mkdirSync(state,{recursive:true});
  const control=path.join(state,'observer.json');fs.writeFileSync(control,'{"token":"owner-token"}');
  assert.deepEqual(after.readJson(control),before.readJson(control));
  const link=path.join(state,'link.json');fs.symlinkSync(control,link);
  for(const api of [before,after])assert.throws(()=>api.readJson(link),{code:'ELOOP'});
  for(const api of [before,after])assert.throws(()=>api.readJson(state),{code:'INVALID_SNAPSHOT'});
  const {createInvocationContext}=require('../src/dist/core');
  const event={version:1,atMs:1234,name:'opencode.session.activity',invocation:createInvocationContext({instanceId:'fixture',source:'opencode'}),data:{status:'busy'}};
  const original=net.createConnection,disabled=process.env.FMCAD_PROJECT_LOGS;
  try{
    async function observe(api,disable){
      const calls=[];
      process.env.FMCAD_PROJECT_LOGS=disable?'0':'1';
      net.createConnection=options=>{
        calls.push(['connect',options]);const socket=new EventEmitter();socket.destroy=()=>calls.push(['destroy']);
        socket.write=text=>{calls.push(['write',JSON.parse(text)]);queueMicrotask(()=>socket.emit('data',Buffer.from('{"ok":true}\n')));};
        queueMicrotask(()=>socket.emit('connect'));return socket;
      };
      const sink=api.createEventSink('/project',{queueDir});await sink.publish(event);
      await assert.rejects(sink.publish({...event,version:2}),/Invalid or oversized observation event/);
      await sink.dispose();await sink.publish(event);return calls;
    }
    for(const disable of [false,true])assert.deepEqual(await observe(after,disable),await observe(before,disable));
  }finally{net.createConnection=original;if(disabled===undefined)delete process.env.FMCAD_PROJECT_LOGS;else process.env.FMCAD_PROJECT_LOGS=disabled;}
});
