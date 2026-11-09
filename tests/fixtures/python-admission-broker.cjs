'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const packageRoot=process.env.FMCAD_ADMISSION_CONSUMER_PACKAGE || path.resolve(__dirname,'../..');
const load=name=>require(path.join(packageRoot,'dist/src',name));
const {createBrokerTransport} = load('dist/fusion-transport/broker');
const {createPythonChecker} = load('python');
const {serve} = load('queue-broker');
const {QueueClient} = load('queue-client');
const {queueDirectory} = load('queue-connection');
const {resolveFmcadConfiguration} = load('dist/core');

/** Real checker, transport preparation, broker IPC and worker processes. The
 * physical port records requests and emits synthetic receipts; it never runs
 * Python, contacts Fusion or makes a model/geometry correctness claim. */
module.exports = async function fixture(t, {typedService = false} = {}) {
  const home=fs.mkdtempSync('/tmp/opencode/admission-ports-');
  const oldState=process.env.XDG_STATE_HOME, oldCwd=process.cwd();
  process.env.XDG_STATE_HOME=home;process.chdir(home);
  const dir=queueDirectory();
  const cfg=resolveFmcadConfiguration({adapter:{backend:'mcp',url:'http://queue.invalid',timeoutMs:120000},
    environment:{},file:{},platformDefaults:{},acceptedService:null});
  const instance={pid:991,birth:'synthetic:991',version:'fixture',activeCommand:'SelectCommand',documents:[]};
  const calls=[],checks=[],clients=[];
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
        if(!script.includes('FMCAD_QUEUE_INSTANCE')) {products++;await observeProduct(script);}
        const binding=script.match(/_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/);
        const filename=script.match(/_qr_path = ("(?:\\.|[^"\\])*")/);
        if(binding&&filename) {
          const file=JSON.parse(filename[1]).replace(/^\\\\wsl\$\\[^\\]+/,'').replaceAll('\\','/');
          if(!file.startsWith(home+'/')) throw Error('Foreign synthetic receipt path');
          fs.writeFileSync(file,JSON.stringify({...JSON.parse(JSON.parse(binding[1])),terminal:true,outcome:'succeeded',instance}));
        }
        if(script.includes('FMCAD_QUEUE_INSTANCE')) text='FMCAD_QUEUE_INSTANCE '+JSON.stringify({...instance,
          documentState:{status:'complete',fingerprint,state:{identity:{creationId:'A'},references:[]}}});
        else text='typed-result';
      }
      return {status:200,raw:JSON.stringify({jsonrpc:'2.0',id:payload.id,result:{content:[{type:'text',text}]}})};
    } finally {active--;}
  };
  const runtime=path.join(packageRoot,'dist/runtime/python');
  const checker=createPythonChecker({typingRoot:path.join(runtime,'typing'),definitionsRoot:path.join(runtime,'typing'),pythonPlatform:'Windows'});
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
    for(const client of clients) client.dispose();
    fs.rmSync(path.join(dir,'fusion-reset.lock'),{force:true});
    await broker?.close();
    process.chdir(oldCwd);
    if(oldState===undefined) delete process.env.XDG_STATE_HOME;else process.env.XDG_STATE_HOME=oldState;
    fs.rmSync(home,{recursive:true,force:true});
  });
  broker=await serve(cfg,{dir,confirmOwnership:true,pollMs:5,createBackend:()=>physical,
    // This physical fixture writes receipts locally without executing Fusion.
    nativePath:value=>value,
    pythonChecker:{async check(request){checks.push(request.artifact.sha256);return checker.check(request);}},
    checkPrepared:prepared=>observe(prepared),
    ...(typedService?{spawnWorker(executable,args,options){return spawn(executable,[worker,args[1]],options);}}:{}),
  });
  return {home,dir,cfg,calls,checks,maximum:()=>maximum,products:()=>products,close:()=>broker.close(),
    fingerprint(value){fingerprint=value;},observe(value){observe=value;},
    observeProduct(value){observeProduct=value;},
    observeProtocol(value){observeProtocol=value;},
    script(name,source){const file=path.join(home,name);fs.writeFileSync(file,source);return file;},
    async client(name){const client=new QueueClient(name,{cfg});clients.push(client);await client.register();return client;},
  };
};
