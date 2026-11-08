'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const cp=require('node:child_process');
const net=require('node:net');
const test=require('node:test');
async function run(){
 const source=path.resolve(__dirname,'..');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fmcad-console-installed-'));
 const children=[];
 const originalSpawn=cp.spawn;
 const previous=new Map(['XDG_DATA_HOME','XDG_STATE_HOME','XDG_CONFIG_HOME','HOME'].map(key=>[key,process.env[key]]));
 try {
  fs.writeFileSync(path.join(directory,'package.json'),'{"private":true}');
  const packed=JSON.parse(cp.execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',directory],{cwd:source,encoding:'utf8'}));
  cp.execFileSync('npm',['install','--offline','--ignore-scripts','--omit=dev','--no-audit','--no-fund',path.join(directory,packed[0].filename)],{cwd:directory,stdio:'pipe'});
  Object.assign(process.env,{XDG_DATA_HOME:path.join(directory,'data'),XDG_STATE_HOME:path.join(directory,'state'),XDG_CONFIG_HOME:path.join(directory,'config'),HOME:directory});
  const project=path.join(directory,'registered project');fs.mkdirSync(project);
  const installed=path.join(directory,'node_modules/fmcad');
  const registry=require(path.join(installed,'dist/src/dist/node-adapters/persistence/project-history/registry.js')).openProjectRegistry();
  registry.register({projectId:'project-unicode-α',projectPath:project,databaseId:'database-test',monitoring:false,archivedAtMs:null,nowMs:Date.now()});
  const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
  const config=path.join(directory,'config.json');fs.writeFileSync(config,JSON.stringify({backend:'addin',routing:'queue',controlCenter:{port},queue:{autoStart:false}}));
  const original=cp.spawn;cp.spawn=function(...args){const child=original.apply(this,args);children.push(child);return child;};
  const {main}=require(path.join(installed,'dist/src/cli.js'));
  async function invoke(args){let out='',err='';const code=await main(args,{cwd:directory,stdin:{isTTY:false},stdout:{write(s){out+=s;}},stderr:{write(s){err+=s;}},setExitCode(){}});return {code,out,err};}
  const denied=await invoke(['console','--web','--config',config,'--project',directory]);assert.equal(denied.code,1);assert.match(denied.err,/not registered/);assert.equal(children.length,0);
  for(const alias of ['console','diagnostic']){
   const result=await invoke([alias,'--web','--config',config,'--project',project]);assert.equal(result.code,0,result.err);assert.equal(result.err,alias==='diagnostic'?'diagnostic is an alias; use fmcad console.\n':'');
   const url=new URL(result.out.trim());assert.equal(url.searchParams.get('project'),'project-unicode-α');assert.equal(Number(url.port),port);
   const response=await fetch(url);assert.equal(response.status,200);assert.match(await response.text(),/assets\/control-center\/web\/index.js/);
  }
  const global=await invoke(['console','--web','--config',config]);assert.equal(global.code,0,global.err);assert.equal(new URL(global.out.trim()).search,'');assert.equal(children.length,1,'aliases reuse the same shared service');
  console.log('Installed E/F console: registration rejection, both aliases, global view, real readiness, static assets, disposal and shared-service reuse passed.');
 }finally{
  for(const child of children){if(child.exitCode===null&&child.signalCode===null){const closed=new Promise(r=>child.once('exit',r));child.ref();child.kill('SIGTERM');await closed;}}
  cp.spawn=originalSpawn;
  for(const [key,value] of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  fs.rmSync(directory,{recursive:true,force:true});
 }
}
test('installed public console uses registered projects and releases only caller resources', {timeout:90000}, run);
