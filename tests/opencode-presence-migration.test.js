'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..');

function loadBoundary(historical,trace,{absent=false,failTouch=false,failClose=false,failSink=false}={}){
  const adapter={defaultOpenCodePresenceDirectory:()=>'/presence',createOpenCodePresence:(project,directory)=>{
    trace.push(['create',project,directory]);
    return absent?null:{file:'/presence/owned.json',instanceId:'instance:fixture',
      touch:(id,data)=>{trace.push(['touch',id,data]);if(failTouch)throw Error('unavailable');},
      event:value=>trace.push(['event',value]),close:async()=>{trace.push(['close']);if(failClose)throw Error('unavailable');}};
  }};
  const sink={async publish(event){trace.push(['publish',event]);},dispose(){trace.push(['dispose']);if(failClose)throw Error('unavailable');}};
  const logger={createEventSink:project=>{trace.push(['sink',project]);if(failSink)throw Error('unavailable');return sink;}};
  const original=Module._load;
  Module._load=function(name,...args){
    if(name.endsWith('/telemetry/opencode-presence'))return adapter;
    if((name.endsWith('/project-logger.cjs')||name==='./library-project-events'))return logger;
    return original.call(this,name,...args);
  };
  try{
    let filename,source;
    if(historical){
      filename=path.join(root,'src/opencode/presence.cjs');
      source=fs.readFileSync(path.join(__dirname,'fixtures/public-host-baseline/opencode-presence.cjs.txt'),'utf8');
      assert.equal(createHash('sha256').update(source).digest('hex'),require('./fixtures/public-host-baseline/provenance.json')['src/opencode/presence.cjs'].sha256);
    }else{
      filename=path.join(root,'src/dist/composition/library-opencode-presence.js');
      source=fs.readFileSync(filename,'utf8');
    }
    const isolated=new Module(filename,module);isolated.filename=filename;isolated.paths=Module._nodeModulePaths(path.dirname(filename));
    isolated._compile(source,filename);
    // The reporter creates its logger lazily; keep the scoped require override
    // active only while the synchronous factory/setup prefix runs.
    return {api:isolated.exports,scoped:callback=>{
      const saved=Module._load;Module._load=function(name,...args){if((name.endsWith('/project-logger.cjs')||name==='./library-project-events'))return logger;return saved.call(this,name,...args);};
      try{return callback();}finally{Module._load=saved;}
    }};
  }finally{Module._load=original;}
}

test('typed OpenCode reporter preserves passive events, exact ownership and independent cleanup failures', async()=>{
  const clock=Date.now;Date.now=()=>1800000000000;
  try{
    for(const options of [{},{absent:true},{failTouch:true},{failClose:true},{failSink:true}]){
      async function observe(historical){
        const trace=[],{api,scoped}=loadBoundary(historical,trace,options);
        const reporter=scoped(()=>api.createReporter('/project'));
        if(reporter){
          assert.equal(reporter.file,'/presence/owned.json');
          reporter.touch('session α',{agent:'build\nprivate',status:'busy',requestId:'request',jobId:'job',documentId:'document',turnId:'turn',title:'private title'});
          for(const event of [null,{},'invalid',{type:'session.created',properties:{info:{id:'session α',documentID:'doc'},requestID:'request',jobID:'job',turnID:'turn'}},{type:'session.updated',properties:{info:{id:'session α'}}},{type:'session.deleted',properties:{info:{id:'session α'}}},{type:'session.status',properties:{sessionID:'session α',status:{type:'busy'},documentId:'doc'}},{type:'session.idle',properties:{sessionID:'session α',turnId:'turn'}}])reporter.event(event);
          await reporter.close();
        }
        await Promise.resolve();return trace;
      }
      assert.deepEqual(await observe(false),await observe(true),JSON.stringify(options));
    }
  }finally{Date.now=clock;}
});

test('typed retained V1/V2 presence hooks preserve host mapping, local abort and disposal', async()=>{
  const clock=Date.now;Date.now=()=>1800000000000;
  try{
    for(const version of [1,2]){
      async function observe(historical){
        const trace=[],{api,scoped}=loadBoundary(historical,trace);
        const event={sessionID:'session',agent:'build',tool:'fmcad_execute',requestID:'request',jobID:'job',documentID:'doc',turnID:'turn'};
        if(version===1){
          const hooks=await scoped(()=>api.setupV1({directory:'/project',client:{session:{get:async value=>{trace.push(['get',value]);return {data:{title:'title',directory:'/project'}};}}}}));
          trace.push(['hooks',Object.keys(hooks)]);
          for(const key of ['chat.message','chat.params','tool.execute.before'])await hooks[key](event);
          await hooks.event({event:{type:'session.idle',properties:{sessionID:'session'}}});
          await hooks.dispose();
        }else{
          const callbacks=[];
          const dispose=await scoped(()=>api.setupV2({location:{directory:'/project'},session:{get:async value=>{trace.push(['get',value]);return {title:'title',directory:'/project'};},hook:async(name,fn)=>{trace.push(['session.hook',name]);callbacks.push(fn);}},tool:{hook:async(name,fn)=>{trace.push(['tool.hook',name]);callbacks.push(fn);}},event:{async *subscribe({signal}){trace.push(['subscribe']);yield {type:'session.idle',properties:{sessionID:'session'}};await new Promise(resolve=>signal.addEventListener('abort',()=>{trace.push(['abort']);resolve();},{once:true}));}}}));
          for(const callback of callbacks)callback(event);
          await Promise.resolve();await dispose();
        }
        await Promise.resolve();return trace;
      }
      assert.deepEqual(await observe(false),await observe(true),'host version '+version);
    }
  }finally{Date.now=clock;}
});
