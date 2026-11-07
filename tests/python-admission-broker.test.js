'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {serve}=require('../src/queue-broker');
const {createBrokerTransport}=require('../src/dist/fusion-transport/broker');

test('production transport refuses corrupted startup Python before any admission, including session initialization', async t=>{
  const directory=fs.mkdtempSync('/tmp/opencode/admission-broker-');
  const methods=[];let scripts=0;
  const endpoint=http.createServer((req,res)=>{
    let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{
      const payload=JSON.parse(body);methods.push(payload.method);
      if(payload.method==='initialize'){
        res.end(JSON.stringify({jsonrpc:'2.0',id:payload.id,result:{protocolVersion:payload.params.protocolVersion}}));return;
      }
      if(payload.method==='notifications/initialized'){res.writeHead(202);res.end();return;}
      scripts++;res.end(JSON.stringify({jsonrpc:'2.0',id:payload.id,result:{content:[]}}));
    });
  });
  t.after(async()=>{endpoint.closeAllConnections();await new Promise(resolve=>endpoint.close(resolve));fs.rmSync(directory,{recursive:true,force:true});});
  await new Promise(resolve=>endpoint.listen(0,'127.0.0.1',resolve));
  const cfg={backend:'mcp',url:`http://127.0.0.1:${endpoint.address().port}`,timeoutMs:5000,tool:'fusion_mcp_execute'};
  await assert.rejects(serve(cfg,{dir:directory,confirmOwnership:true,
    createBackend:server=>{
      const client=createBrokerTransport(server,{version:'test',requestTimeout:s=>s.timeoutMs,bridgeSource:()=>assert.fail('MCP has no bridge')});
      const prepare=client.prepareCallTool.bind(client);
      client.prepareCallTool=(args,name)=>prepare({...args,object:{...args.object,script:args.object.script+'\ninvalid_startup: int = "bad"\n'}},name);
      return client;
    }}),error=>{
    assert.equal(error.code,'PYTHON_CHECK_REJECTED');
    assert.equal(error.probeNotSubmitted,true);
    assert.notEqual(error.pythonCheck.status,'passed');
    return true;
  });
  assert.equal(scripts,0);
  assert.deepEqual(methods,[], 'Rejected final Python must not initialize a session');
  assert.ok(fs.existsSync(path.join(directory,'broker.lock')),
    'Lifecycle owner must handle local rejection evidence; this test never steals/removes shared ownership');
});
