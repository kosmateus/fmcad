'use strict';
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn;
let peerCheckerWaiter, pausedPeerChecker;
function waitUntilStopped(child) {
  return new Promise((resolve,reject)=>{
    const deadline=Date.now()+5000;
    const inspect=()=>{
      let state;
      try {
        state=/^State:\s+([A-Za-z])/m.exec(fs.readFileSync(`/proc/${child.pid}/status`,'utf8'))?.[1];
      } catch {
        reject(Error('Peer checker exited before it could be suspended'));
        return;
      }
      if(state==='T'||state==='t') resolve();
      else if(child.exitCode!==null||child.signalCode!==null) reject(Error('Peer checker exited before it could be suspended'));
      else if(Date.now()>=deadline) reject(Error('Peer checker did not enter the stopped state'));
      else setTimeout(inspect,5);
    };
    inspect();
  });
}
// Hold a real isolated checker child after its OS spawn, not just its Promise.
childProcess.spawn=function(file,args,options) {
  const hold=peerCheckerWaiter&&file==='python3'&&Array.isArray(args)&&
    args[0]==='-I'&&args[1]==='-S'&&typeof args[2]==='string'&&args[2].includes('fmcad-check-')
    ?peerCheckerWaiter:null;
  let child;
  try {
    child=originalSpawn.call(this,file,args,options);
  } catch(error) {
    if(hold){peerCheckerWaiter=null;hold.reject(error);}
    throw error;
  }
  if(hold) {
    child.once('error',error=>{
      if(peerCheckerWaiter===hold) peerCheckerWaiter=null;
      if(!hold.cancelled) hold.reject(error);
    });
    child.once('spawn',()=>{
      if(hold.cancelled) return;
      if(peerCheckerWaiter===hold) peerCheckerWaiter=null;
      if(!child.pid||!child.kill('SIGSTOP')) {
        hold.reject(Error('Could not suspend the spawned peer checker'));
        return;
      }
      pausedPeerChecker=child;
      waitUntilStopped(child).then(hold.resolve,error=>{
        pausedPeerChecker=null;
        child.kill('SIGCONT');
        hold.reject(error);
      });
    });
  }
  return child;
};
const {spawn} = childProcess;
function resumePeerChecker() {
  if(peerCheckerWaiter) {
    peerCheckerWaiter.cancelled=true;
    peerCheckerWaiter=undefined;
  }
  const child=pausedPeerChecker;
  pausedPeerChecker=undefined;
  if(child) child.kill('SIGCONT');
}
const packageRoot=process.env.FMCAD_ADMISSION_CONSUMER_PACKAGE || path.resolve(__dirname,'../..');
const load=name=>require(path.join(packageRoot,'dist/src',name));
const {nativeReceipts}=require(path.join(__dirname,'native-source-envelope.cjs'));
const {createBrokerTransport} = load('dist/fusion-transport/broker');
const {serve} = load('queue-broker');
const {QueueClient} = load('queue-client');
const {queueDirectory} = load('queue-connection');
const {resolveFmcadConfiguration} = load('dist/core');

/** Real checker, transport preparation, broker IPC and worker processes. The
 * physical port records requests and emits synthetic receipts; it never runs
 * Python, contacts Fusion or makes a model/geometry correctness claim. */
module.exports = async function fixture(t, {typedService = false, slowPeerChecker = false} = {}) {
  const home=fs.mkdtempSync('/tmp/opencode/admission-ports-');
  const oldState=process.env.XDG_STATE_HOME, oldCwd=process.cwd();
  process.env.XDG_STATE_HOME=home;process.chdir(home);
  const dir=queueDirectory();
  const cfg=resolveFmcadConfiguration({adapter:{backend:'mcp',url:'http://queue.invalid',timeoutMs:120000},
    environment:{},file:{},platformDefaults:{},acceptedService:null});
  const instance={pid:991,birth:'synthetic:991',version:'fixture',activeCommand:'SelectCommand',documents:[]};
  const calls=[],clients=[];
  let active=0,maximum=0,products=0,fingerprint='A-1',observe=async()=>{},observeProduct=async()=>{},observeProtocol=async()=>{};
  const physical=createBrokerTransport(cfg,{version:'test',requestTimeout:s=>s.timeoutMs,bridgeSource:()=>{throw Error('No add-in bridge');}});
  physical._post=async payload=>{
    calls.push(payload);active++;maximum=Math.max(maximum,active);
    try {
      await new Promise(resolve=>setTimeout(resolve,5));
      await observeProtocol(payload);
      if(payload.method==='initialize') return {status:200,raw:JSON.stringify({jsonrpc:'2.0',id:payload.id,result:{protocolVersion:payload.params.protocolVersion}})};
      if(payload.method==='notifications/initialized') return {status:202,raw:''};
      const script=payload.params?.arguments?.object?.script || payload.params?.arguments?.code;
      let text='{}';
      if(script) {
        const observation={...instance,
          documentState:{status:'complete',fingerprint,state:{identity:{creationId:'A'},references:[]}}};
        const receipts=nativeReceipts(script,home,observation);
        const probe=receipts.some(receipt=>receipt.value.probeObservation);
        if(!probe) {products++;await observeProduct(script);}
        for(const receipt of receipts)
          fs.writeFileSync(receipt.file,JSON.stringify(receipt.value));
        if(probe) text='FMCAD_QUEUE_INSTANCE '+JSON.stringify(observation);
        else text='typed-result';
      }
      return {status:200,raw:JSON.stringify({jsonrpc:'2.0',id:payload.id,result:{content:[{type:'text',text}]}})};
    } finally {active--;}
  };
  const worker=path.join(home,'typed-service.cjs');
  if(typedService) fs.writeFileSync(worker,`
    const fs=require('node:fs');
    const {preparePythonArtifact,pythonArtifactManifest}=require(${JSON.stringify(path.join(packageRoot,'dist/src/python'))});
    require(${JSON.stringify(path.join(packageRoot,'dist/src/queue-worker'))}).run(process.argv[2],{async execute(request,backend,onOutcome){
      const filename=request.argv[1];
      const artifact=preparePythonArtifact([{id:'fixture',filename,source:fs.readFileSync(filename,'utf8'),role:'user'}]);
      const result=await backend.callTool({featureType:'script',object:{script:artifact.script,readOnly:true}},'fusion_mcp_execute',pythonArtifactManifest(artifact));
      onOutcome({fixture:true});process.stdout.write(result.text+'\\n');return result.failed?1:0;
    }}).then(code=>{process.exitCode=code},error=>{process.stderr.write(error.message+'\\n');process.exitCode=1});
  `);
  let broker;
  t.after(async()=>{
    resumePeerChecker();
    for(const client of clients) client.dispose();
    fs.rmSync(path.join(dir,'fusion-reset.lock'),{force:true});
    try {
      await broker?.close();
    } catch (error) {
      t.diagnostic(`Admission fixture retained after close refusal: ${home}`);
      throw error;
    } finally {
      process.chdir(oldCwd);
      if(oldState===undefined) delete process.env.XDG_STATE_HOME;else process.env.XDG_STATE_HOME=oldState;
    }
    fs.rmSync(home,{recursive:true,force:true});
  });
  broker=await serve(cfg,{dir,confirmOwnership:true,pollMs:5,createBackend:()=>physical,
    // This physical fixture writes receipts locally without executing Fusion.
    nativePath:value=>value,
    testCheckPrepared:prepared=>observe(prepared),
    ...(typedService?{spawnWorker(executable,args,options){return spawn(executable,[worker,args[1]],options);}}:{}),
  });
  return {home,dir,cfg,calls,maximum:()=>maximum,products:()=>products,close:()=>broker.close(),
    pauseNextPeerChecker(){
      if(!slowPeerChecker)throw Error('Slow peer checker is not enabled');
      if(peerCheckerWaiter||pausedPeerChecker)throw Error('A peer checker is already armed');
      return new Promise((resolve,reject)=>{peerCheckerWaiter={resolve,reject,cancelled:false};});
    },
    resumePeerChecker,
    fingerprint(value){fingerprint=value;},observe(value){observe=value;},
    observeProduct(value){observeProduct=value;},
    observeProtocol(value){observeProtocol=value;},
    script(name,source){const file=path.join(home,name);fs.writeFileSync(file,source);return file;},
    async client(name){const client=new QueueClient(name,{cfg});clients.push(client);await client.register();return client;},
  };
};
