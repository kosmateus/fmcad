import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

test(
  "FAKE isolated host/backend: actual broker dispatch authorizes known cleanup without any SDK or history edits",
  { timeout: 30000 },
  (t) => {
    const root = fs.mkdtempSync("/tmp/opencode/closed-epoch-broker-");
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = process.cwd();
    const code = `
    const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
    const repo=process.argv[1],root=process.argv[2];
    (async()=>{
      const f=require(repo+'/tests/fixtures/closed-epoch-successor.cjs')(root,repo);
      assert.equal(f.dir,path.join(root,'queue'));
      assert.equal(fs.realpathSync(f.dir),f.dir);
      assert.equal(f.p.marker.pid,process.pid);
      const before=fs.readFileSync(path.join(f.epoch.root,'queue-state.json'));
      fs.unlinkSync(path.join(f.dir,'broker.lock')); // Only the just-created synthetic owner marker.
      let sdk=0;
      await require(repo+'/src/queue-broker').serve(f.cfg,{dir:f.dir,confirmOwnership:true,autoReconcile:false,
        createBackend:()=>({server:{timeoutMs:1000},_parse:JSON.parse,
          _post(){sdk++;assert.fail('No SDK for metadata authorization');},
          callTool(){sdk++;assert.fail('No SDK probe for metadata authorization');}})});
      const request=require(repo+'/src/queue-connection').request;
      const call=(action,rest={})=>request(f.dir,{action,auth:{clientId:f.clientId,clientToken:f.token},...rest});
      const status=await call('queue-summary');
      const {instanceId,generation,contextEpoch,buildHash}=status.control;
      const result=await call('authorize-closed-successor',{approval:require(repo+'/src/queue-epoch-lineage').reference(f.approvalFile),
        control:{instanceId,generation,contextEpoch,buildHash}});
      assert.equal(result.sdkRequestsSent,0);
      const next=await call('queue-summary');
      assert.equal(next.deadEpochSuccessor.requestId,f.requestId);
      assert.equal(next.deadEpochSuccessor.currentFactsAvailable,false);
      assert.deepEqual(fs.readFileSync(path.join(f.epoch.root,'queue-state.json')),before);
      assert.equal(sdk,0);
      console.log(JSON.stringify({metadataAuthorized:true,sdkRequestsSent:sdk,historyUnchanged:true}));
      // This child owns only a synthetic fixture. Exiting it tests process loss;
      // never change production close()'s deliberate closed-epoch hold semantics.
      process.exit(0);
    })().catch(error=>{console.error(error);process.exit(1);});
  `;
    const result = spawnSync(process.execPath, ["-e", code, repo, root], {
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      metadataAuthorized: true,
      sdkRequestsSent: 0,
      historyUnchanged: true,
    });
  },
);
