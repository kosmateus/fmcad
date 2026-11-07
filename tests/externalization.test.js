const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const external=require('../src/externalization');
const {catalog,validateCad,executeCad,executeExternalizationAction}=require('../src/cad');
const {isTransactional,readOperationJournal,writeOperationRecord}=require('../src/batch-atomic');

function embeddedRequest(script, variable) {
  const start=script.indexOf(`${variable} = `);
  assert.notEqual(start,-1,`missing ${variable} assignment`);
  const match=script.slice(start).match(/__import__\('json'\)\.loads\(("(?:\\.|[^"\\])*")\)/);
  assert.ok(match,`could not parse ${variable} JSON transport payload`);
  return JSON.parse(JSON.parse(match[1]));
}

function input(mode='composeNew',extra={}) {
  const copy=mode==='copyAndReplace';
  return {schemaVersion:1,operationId:'op',reportPath:'/unused',mode,phase:'run',
    source:{projectId:'project',fileId:'source',creationId:'creation',version:1},
    ...(mode==='composeNew'?{destinationDocument:{projectId:'project',folderId:'folder',name:'New'}}:{}),
    items:[{itemId:'module',instancePolicy:'selected',
      ...(copy?{selection:{path:'Module:1'},definitionPolicy:'local',destination:{projectId:'project',folderId:'folder',fileName:'Module'}}:
        {dataFileId:'existing',projectId:'project',version:2,...(mode==='composeNew'?{}:{selection:{path:'Module:1'},definitionPolicy:mode==='replaceExternal'?'external':'local'})})}],
    expectedInventory:{module:{bodies:2,occurrences:0,history:2}},
    linearTolerance:'0.001 mm',angularTolerance:'0.001 deg',volumeTolerance:'0.000001 cm^3',save:true,
    ...(mode==='replaceExternal'?{confirmReplace:true}:{}),
    ...(['copyAndReplace','replaceFromExisting'].includes(mode)?{confirmRetire:true}:{}),...extra};
}
async function directory(t){const p=await fs.mkdtemp(path.join(os.tmpdir(),'fmcad-external-test-'));t.after(()=>fs.rm(p,{recursive:true,force:true}));return p;}
function native({fail,wait=false}={}){
  const calls=[];let failure=fail;
  return {calls,step:async(action,payload,readOnly)=>{
    calls.push({action,...payload.pending,phase:payload.phase,itemId:payload.itemId,stepId:payload.stepId,readOnly});
    if(action==='inspect')return {status:'unavailable',terminal:false,lifecycleEffects:[]};
    if(failure){const e=failure;failure=null;throw e;}
    const state=external.slot(payload.result.byItem[payload.itemId],payload.phase),cursor=state.receipt?.cursor ?? 0;
    if(payload.phase==='copy' && payload.manifest.items.find(i=>i.itemId===payload.itemId).dataFileId)
      return {status:'notApplicable',receipt:{cursor:1,reuse:{fileId:'existing',version:2}}};
    if(payload.phase==='copy' && cursor===0)return {status:'pending',uploadStatus:'accepted',rawUploadState:{value:0,name:'processing'},receipt:{cursor:1}};
    if(payload.phase==='copy' && wait)return {status:'pending',waitingPublication:true,uploadStatus:'pending',receipt:{cursor:1}};
    if(payload.phase.startsWith('verify:'))return {status:cursor<2?'pending':'complete',completedChecks:1,
      receipt:{cursor:cursor+1,checks:[{checkId:'check:'+cursor,passed:true}],remainingCheckIds:Array.from({length:Math.max(0,2-cursor)},(_,i)=>'check:'+(cursor+i+1))}};
    return {status:'complete',...(payload.phase==='copy'?{uploadStatus:'complete'}:{}),receipt:{cursor:cursor+1}};
  }};
}

test('all four explicit modes validate flags and enforce single-phase ownership',()=>{
  for(const mode of ['copyAndReplace','replaceFromExisting','composeNew','replaceExternal'])assert.equal(external.validate(input(mode)).mode,mode);
  for(const mode of ['composeNew','replaceExternal'])assert.throws(()=>external.validate(input(mode,{phase:'retire'})),/not applicable/);
  assert.throws(()=>external.validate(input('replaceExternal',{confirmReplace:false})),/confirmReplace/);
  assert.throws(()=>external.validate(input('replaceExternal',{items:[{...input('replaceExternal').items[0],
    destinationOccurrence:'Parent:1'}]})),/preserves the selected occurrence context/);
  assert.throws(()=>external.validate(input('copyAndReplace',{confirmRetire:false})),/confirmRetire/);
  assert.throws(()=>external.validate(input('composeNew',{phase:'verify'})),/verificationScope/);
  assert.throws(()=>external.validate(input('composeNew',{save:false})),/save:true/);
  assert.equal(external.validate(input('composeNew',{phase:'verify',verificationScope:'sources',save:false})).phase,'verify');
 });
test('missing/unknown fields, bad bounds, unpinned existing files and ambiguous controls fail offline',()=>{
  for(const key of ['source','expectedInventory','linearTolerance','angularTolerance','volumeTolerance']){
    const data=input();delete data[key];assert.throws(()=>external.validate(data),/Missing/);
  }
  for(const key of ['maxItems','maxChecks','timeBudgetMs'])for(const value of [0,-1,1.5,null,true])assert.throws(()=>external.validate(input('composeNew',{[key]:value})),/positive integer/);
  assert.throws(()=>external.validate(input('composeNew',{surprise:true})),/Unknown/);
  const missing=input();delete missing.items[0].version;assert.throws(()=>external.validate(missing),/pin/);
  assert.throws(()=>external.validate(input('composeNew',{itemIds:['foreign']})),/subset/);
  const collision=input();collision.items[0].destination={projectId:'project',folderId:'folder',fileName:'Existing'};
  assert.throws(()=>external.validate(collision),/reused only by ID/);
  const mapped=input();mapped.items[0].occurrenceMap=[{sourceIndex:0,targetIndex:0}];
  assert.doesNotThrow(()=>external.validate(mapped));
  assert.throws(()=>external.validate({...mapped,items:[{...mapped.items[0],occurrenceMap:[{sourceIndex:0,targetIndex:0},{sourceIndex:0,targetIndex:1}]}]}),/bijection/);
  assert.throws(()=>external.validate({...mapped,items:[{...mapped.items[0],bodyMap:[{sourceIndex:-1,targetIndex:0}]}]}),/nonnegative/);
});
test('unsupported caller description requests reject before backend or journal writes',async()=>{
  for(const scope of ['manifest','item','destination','destinationDocument']) {
    const data=input(scope==='destinationDocument'?'composeNew':'copyAndReplace');
    const target=scope==='manifest'?data:scope==='item'?data.items[0]:
      scope==='destination'?data.items[0].destination:data.destinationDocument;
    target.description='Caller requires this exact description';
    assert.throws(()=>external.validate(data),/Unknown.*description/);
  }
});
test('group membership cannot silently expand just the first member definition',()=>{
  const data=input('copyAndReplace');delete data.items[0].selection;
  data.items[0].groupId='pair';data.items[0].instancePolicy='allInstances';
  data.extractionGroups=[{id:'pair',members:[{name:'A:1'},{name:'B:1'}]}];
  assert.throws(()=>external.validate(data),/explicit selected sibling membership/);
  data.items[0].instancePolicy='selected';assert.doesNotThrow(()=>external.validate(data));
});
test('driver probes prevalidate unique identity, exact producer pin and scalar check shape',()=>{
  const probe={probeId:'driver-1',itemId:'module',source:{projectId:'project',fileId:'producer',version:3},
    parameter:'Drive',expression:'12 mm',minimum:'8 mm',maximum:'16 mm',
    checks:[{id:'volume',measurement:{operation:'measure.volume',data:{ref:'body'}},expected:'2 cm^3',tolerance:'0.01 cm^3'}],
    refresh:{reportPath:'./refresh'}};
  assert.doesNotThrow(()=>external.validate(input('composeNew',{probes:[probe]})));
  assert.throws(()=>external.validate(input('composeNew',{probes:[{...probe,probeId:'bad id'}]})),/probeId/);
  assert.throws(()=>external.validate(input('composeNew',{probes:[probe,{...probe}]})),/probeId/);
  assert.throws(()=>external.validate(input('composeNew',{probes:[{...probe,checks:[{measurement:{operation:'not.measure',data:{}},min:'0 mm'}]}]})),/supported scalar/);
  assert.throws(()=>external.validate(input('composeNew',{probes:[{...probe,checks:[{measurement:{operation:'measure.volume',data:{ref:'body',extra:true}},min:'0 cm^3'}]}]})),/Unknown/);
   assert.throws(()=>external.validate(input('composeNew',{probes:[{...probe,refresh:{reportPath:'./refresh',nativeFallback:'qualifiedOnce'}}]})),/driverUiLeases/);
  const target={name:'consumer v3',fileId:'consumer',creationId:'consumer-owner'};
  const lease=requestId=>({target,lease:{id:'lease',requestId,operationId:'authorized',expiresAt:Date.now()+60000,target:{...target}}});
  assert.doesNotThrow(()=>external.validate(input('composeNew',{probes:[{...probe,refresh:{reportPath:'./refresh',
    nativeFallback:'qualifiedOnce',driverUiLeases:{consumer:lease('op_driver-1_driver_apply')},
     restoreUiLeases:{consumer:lease('op_driver-1_restore_apply')}}}]})));
  assert.throws(()=>external.validate(input('composeNew',{probes:[{...probe,refresh:{reportPath:'./refresh',
    nativeFallback:'qualifiedOnce',driverUiLeases:{consumer:lease('wrong')},
     restoreUiLeases:{consumer:lease('op_driver-1_restore_apply')}}}]})),/exact \.10 apply request/);
  const explicitNull={...target,commandId:null};
  const nullCommandLease=requestId=>({target:explicitNull,lease:{id:'lease',requestId,
    operationId:'authorized',expiresAt:Date.now()+60000,target:{...explicitNull}}});
  assert.throws(()=>external.validate(input('composeNew',{probes:[{...probe,refresh:{reportPath:'./refresh',
    nativeFallback:'qualifiedOnce',driverUiLeases:{consumer:nullCommandLease('op_driver-1_driver_apply')},
    restoreUiLeases:{consumer:lease('op_driver-1_restore_apply')}}}]})),/omit an unqualified commandId/);
});
test('reused native source can supply an exact loaded-editor context pin',()=>{
  const data=input('replaceFromExisting');
  data.items[0].creationId='owned-editor';data.items[0].context='topLevel';
  assert.doesNotThrow(()=>external.validate(data));
  assert.throws(()=>external.validate({...data,items:[{...data.items[0],context:'referenceBuffer'}]}),/context must be topLevel/);
  assert.throws(()=>external.validate(input('copyAndReplace',{items:[{...input('copyAndReplace').items[0],creationId:'not-created-yet'}]})),/pins apply only to exact reused files/);
});
test('existing source and new-copy projects must match the authorized assembly project',()=>{
  const reuse=input('composeNew');reuse.destinationDocument.projectId='destination';
  assert.throws(()=>external.validate(reuse),/source must belong to the destination project/);
  const copy=input('copyAndReplace');copy.items[0].destination.projectId='other-project';
  assert.throws(()=>external.validate(copy),/destination must match the assembly project/);
});
test('composeNew placement and callerNamespaces are explicit generic context contracts',()=>{
  const placed=input('composeNew');placed.items[0].placement={translation:['0 mm','0 mm','0 mm']};
  assert.doesNotThrow(()=>external.validate(placed));
  assert.throws(()=>external.validate(input('copyAndReplace',{items:[{...input('copyAndReplace').items[0],
    placement:{translation:['0 mm','0 mm','0 mm']}}]})),/only supported by composeNew/);
  assert.doesNotThrow(()=>external.validate(input('composeNew',{callerNamespaces:[
    {itemId:'module',scope:'parent',group:'ROLE',keys:['site','mount']}]})));
  assert.throws(()=>external.validate(input('composeNew',{callerNamespaces:[
    {itemId:'module',scope:'parent',group:'ROLE',keys:['site']},
    {itemId:'module',scope:'parent',group:'ROLE',keys:['mount']}]})),/unique per item/);
});
test('catalog declares external effects and does not alias local occurrence.add',async()=>{
  assert.equal(isTransactional('component.externalize',catalog),false);
  assert.equal(isTransactional('occurrence.insert_external',catalog),false);
  assert.equal(catalog['component.externalize'].nodeOnly,true);
  assert.match(catalog['component.externalize'].inputs.callerNamespaces,/scope:parent/);
  assert.doesNotThrow(()=>validateCad('component.externalize',input()));
  const preview=await executeCad(null,'component.externalize',input(),{preview:true});
  assert.equal(preview.state,'input-validated-only');assert.equal(preview.mutation,false);
});
test('phase receipts retain owned activation and nested consumer-refresh lifecycle effects',async t=>{
  const data=input('composeNew',{reportPath:await directory(t),probes:[{
    probeId:'driver',itemId:'module',source:{projectId:'project',fileId:'producer',version:2},parameter:'Drive',
    expression:'12 mm',minimum:'8 mm',maximum:'16 mm',checks:[{measurement:{operation:'measure.volume',data:{ref:'body'}},
      expected:'2 cm^3'}],refresh:{reportPath:'./refresh'}}]});
  const adapter=native(),step=adapter.step;
  adapter.step=async(action,payload,readOnly)=>{
    const result=await step(action,payload,readOnly);
    const verifyCursor=payload.result.byItem.module.phaseResults.verify.assembly.receipt?.cursor ?? 0;
    if(action==='perform' && payload.phase==='verify:assembly' && verifyCursor>=2){
      result.receipt={...(result.receipt ?? {}),refreshRequest:{phase:'apply'}};
      result.lifecycleEffects=[{action:'activated',docid:'target',openedByOperation:false}];
    }
    return result;
  };
  adapter.refresh=async()=>({invocationStatus:'complete',lifecycleEffects:[{action:'opened',docid:'consumer',openedByOperation:true}]});
  const result=await external.execute(null,data,{},adapter);
  assert.equal(result.migrationComplete,true);
  assert.deepEqual(result.lifecycleEffects.map(effect=>effect.docid),['target','consumer']);
});
test('a settled read-only graph-shape failure is failed, not an unknown model mutation',async t=>{
  const data=input('composeNew',{reportPath:await directory(t),probes:[{
    probeId:'driver',itemId:'module',source:{projectId:'project',fileId:'producer',version:2},parameter:'Drive',
    expression:'12 mm',minimum:'8 mm',maximum:'16 mm',checks:[{measurement:{operation:'measure.volume',data:{ref:'body'}},
      expected:'2 cm^3'}],refresh:{reportPath:'./refresh'}}]});
  const adapter=native(),step=adapter.step;
  adapter.step=async(action,payload,readOnly)=>{
    const result=await step(action,payload,readOnly);
    const cursor=payload.result.byItem.module.phaseResults.verify.assembly.receipt?.cursor ?? 0;
    if(action==='perform' && payload.phase==='verify:assembly' && cursor>=2)
      result.receipt={...(result.receipt ?? {}),refreshRequest:{phase:'plan'}};
    return result;
  };
  adapter.refresh=async()=>{
    const error=new Error('Graph audit did not return documents and forward edges (object keys=reason,status)');
    error.fmcadReadOnlyFailure='references.refresh graph result shape';
    throw error;
  };
  const result=await external.execute(null,data,{},adapter);
  const state=external.slot(result.byItem.module,'verify:assembly');
  assert.equal(result.invocationStatus,'failed');
  assert.equal(result.pending,null);
  assert.match(result.error,/object keys=reason,status/);
  assert.equal(state.status,'failed');
  assert.equal(state.receipt.refreshReceipt.failureStage,'references.refresh graph result shape');
  assert.equal(adapter.calls.filter(call=>call.action==='perform' && call.phase==='finalize').length,0);
});
test('executeCad nested externalize-to-refresh preserves saved root, qualified mixed route and request-bound lease',async t=>{
  const reportPath=await directory(t),refreshPath=path.join(reportPath,'driver-refresh');
  const operationId='nested-adapter';
  const probeId='width-driver';
  const applyRequestId=`${operationId}_${probeId}_driver_apply`;
  const root={projectId:'project',fileId:'consumer',version:3};
  const target={name:'consumer v3',fileId:'consumer',creationId:'consumer-creation'};
  const driverLease={target,lease:{id:'driver-lease',requestId:applyRequestId,
    operationId:'authorized-driver-update',expiresAt:Date.now()+120000,target:{...target}}};
  const restoreRequestId=`${operationId}_${probeId}_restore_apply`;
  const restoreLease={target,lease:{id:'restore-lease',requestId:restoreRequestId,
    operationId:'authorized-driver-restore',expiresAt:Date.now()+120000,target:{...target}}};
  const edgeIds={linked:'consumer->child',derive:'consumer->driver'};
  const bindings=[{edgeId:edgeIds.derive,sourceParameter:'IW79_Driver',
    nativeDerivedParameter:'IW79_Driver_Ref',consumerAlias:'IW79_Alias'}];
  const manifest=input('replaceFromExisting',{operationId,reportPath,probes:[{
    probeId,itemId:'module',source:{projectId:'project',fileId:'driver',version:5},
    parameter:'IW79_Driver',expression:'15 mm',minimum:'8 mm',maximum:'16 mm',
    checks:[{id:'volume',measurement:{operation:'measure.volume',data:{ref:'body'}},expected:'1.5 cm^3'}],
    refresh:{reportPath:refreshPath,nativeFallback:'qualifiedOnce',
      driverUiLeases:{consumer:driverLease},restoreUiLeases:{consumer:restoreLease}},
  }]});
  const document=(fileId,version,extra={})=>({fileId,projectId:'project',version,latestVersion:version,
    available:true,modified:false,isComplete:true,readOnly:false,timelineAtEnd:true,pendingSnapshot:false,
    health:{healthy:true,status:'pass'},repairRequired:false,consumedBodiesVerified:true,
    historySnapshotSupported:true,metadataComplete:true,name:fileId==='consumer'?'consumer v3':fileId,
    creationId:fileId==='consumer'?'consumer-creation':`${fileId}-creation`,parameters:[],userParameters:[],...extra});
  const rootDoc=document('consumer',3,{parameters:[{name:'IW79_Alias',expression:'IW79_Driver_Ref',
    dependsOn:['IW79_Driver_Ref'],internal_value:1,internal_unit:'cm'}],
    userParameters:[{name:'IW79_Alias',expression:'IW79_Driver_Ref',display_unit:'mm',isFavorite:true,
      display_value:10,internal_value:1,internal_unit:'cm'}]});
  const childDoc=document('child',1);
  const driverDoc=document('driver',5,{parameters:[{name:'IW79_Driver',expression:'15 mm',dependsOn:[],
    internal_value:1.5,internal_unit:'cm',display_value:15,display_unit:'mm',isFavorite:true}]});
  const graph={schemaVersion:1,documents:[rootDoc,childDoc,driverDoc],graphComplete:true,
    edges:[
      {edgeId:edgeIds.linked,edgeIdentityUnique:true,kind:'linked',ownerFileId:'consumer',ownerProjectId:'project',
        sourceFileId:'child',sourceProjectId:'project',baselineVersion:1,latestVersion:1,
        versionSource:'document_reference',selfReference:false,status:'current',sourceAvailable:true},
      {edgeId:edgeIds.derive,edgeIdentityUnique:true,kind:'derive',ownerFileId:'consumer',ownerProjectId:'project',
        sourceFileId:'driver',sourceProjectId:'project',featureName:'driver derive',featureToken:'derive-token',
        baselineVersion:4,latestVersion:5,versionSource:'document_reference',selfReference:false,status:'outdated',
        sourceParameters:[{name:'IW79_Driver',expression:'15 mm',dependsOn:[],internal_value:1.5,
          internal_unit:'cm',display_value:15,display_unit:'mm'}],
        derivedParameters:[{name:'IW79_Driver_Ref',expression:'10 mm',dependsOn:[],internal_value:1,
          internal_unit:'cm',display_value:10,display_unit:'mm'}],sourceAvailable:true},
    ],getterErrors:[],lifecycleEffects:[],coverage:{reachableDocuments:3,reachableEdges:2},environment:{}};
  const nativeCalls=[],referenceCalls=[];let plannedPlan=null;
  const client={capabilities:{backend:'addin',implementation:'transport-double'},server:{url:'http://transport.invalid',timeoutMs:120000},
    callTool:async request=>{
      const script=request.object.script;
      if(script.includes('_EXTERNAL_REQUEST = ')){
        const envelope=embeddedRequest(script,'_EXTERNAL_REQUEST');
        assert.equal(envelope.action,'perform');
        const payload=envelope.data;nativeCalls.push(payload.phase);
        if(payload.phase==='verify:assembly'){
          const state=payload.result.byItem.module.phaseResults.verify.assembly;
          const cursor=state.receipt?.cursor ?? 0;
          if(cursor===0)return {failed:false,text:'FMCAD_RESULT '+JSON.stringify({status:'pending',receipt:{cursor:1,
            refreshRequest:{schemaVersion:1,phase:'plan',root,policy:'latest',lifecycle:'openOwned',
              durability:'cold',reportPath:refreshPath,nativeFallback:'qualifiedOnce',parameterBindings:bindings,
              requestId:`${operationId}_${probeId}_driver_plan`}}})};
          if(cursor===1){
            const plan=state.receipt?.refreshReceipt;
            assert.ok(plan?.planId);
            plannedPlan=plan;
            return {failed:false,text:'FMCAD_RESULT '+JSON.stringify({status:'pending',receipt:{cursor:2,
              refreshRequest:{schemaVersion:1,phase:'apply',confirm:true,root,reportPath:refreshPath,
                planId:plan.planId,requestId:applyRequestId,policy:'latest',lifecycle:'openOwned',
                durability:'cold',nativeFallback:'qualifiedOnce',parameterBindings:bindings,
                uiLeases:{consumer:driverLease}}}})};
          }
          return {failed:false,text:'FMCAD_RESULT '+JSON.stringify({status:'complete',receipt:{cursor:cursor+1}})};
        }
        if(payload.phase==='copy')return {failed:false,text:'FMCAD_RESULT '+JSON.stringify({status:'notApplicable',receipt:{cursor:1}})};
        return {failed:false,text:'FMCAD_RESULT '+JSON.stringify({status:'complete',receipt:{cursor:1}})};
      }
      if(script.includes('_FMCAD_REFERENCE_REQUEST = ')){
        const envelope=embeddedRequest(script,'_FMCAD_REFERENCE_REQUEST');
        referenceCalls.push(envelope);
        if(envelope.action==='graph')return {failed:false,text:'FMCAD_RESULT '+JSON.stringify(graph)};
        if(envelope.action==='preflight')return {failed:false,text:'FMCAD_RESULT '+JSON.stringify({status:'complete',
          document:rootDoc,edges:graph.edges,metadata:{},lifecycleEffects:[],identity:{creationId:'consumer-creation'}})};
        throw new Error('unexpected references action '+envelope.action);
      }
      if(script.includes('FMCAD_UI_PROBE '))return {failed:false,text:'FMCAD_UI_PROBE '+JSON.stringify({
        documents:[{name:target.name,creationId:target.creationId,fileId:target.fileId,isSaved:true,
          isModified:false,isActive:true}],unavailableEvidence:[],activeCommand:null,fusionVersion:'transport-test'})};
      throw new Error('unexpected transport-only SDK script');
    }};
  const result=await executeCad(client,'component.externalize',manifest,{});
  assert.equal(result.operation,'component.externalize');
  assert.equal(result.invocationStatus,'failed','UI host unavailable must block before UpdateAllLatestCmd submit');
  const phaseCalls=referenceCalls.filter(call=>call.action==='graph').map(call=>call.data);
  assert.equal(phaseCalls[0].phase,'plan');
  assert.deepEqual(phaseCalls[0].root,root,'the .9 saved consumer version is preserved through nested dispatch');
  assert.equal(phaseCalls[0].nativeFallback,'qualifiedOnce');
  assert.equal(plannedPlan.updates[0].method,
    'UpdateAllLatestCmd','the .10 planner selects the qualified mixed-parent route');
  const applyResult=result.byItem.module.phaseResults.verify.assembly.receipt.refreshReceipt;
  assert.equal(applyResult.invocationStatus,'blocked');
  assert.equal(applyResult.blocked[0].reason,'UIHostNotIdleOrTargetUnverified',
    'the request-bound lease passed .10 preflight; the transport-only UI probe deliberately cannot qualify a host');
  assert.equal(referenceCalls.some(call=>call.action==='nativeUpdate'),false,'transport test does not submit a native command');
  assert.equal(nativeCalls.includes('finalize'),false);
});
for(const mode of ['copyAndReplace','replaceFromExisting','composeNew','replaceExternal'])test(mode+' run uses phase order and reports whole migration separately',async t=>{
  const adapter=native(),data=input(mode,{reportPath:await directory(t)});
  const result=await external.execute(null,data,{},adapter);
  assert.equal(result.invocationStatus,'complete');assert.equal(result.migrationComplete,true);
  const phases=adapter.calls.filter(c=>c.action==='perform').map(c=>c.phase);
  assert.deepEqual([...new Set(phases)],['copy','verify:sources','stage','verify:assembly',...(['composeNew','replaceExternal'].includes(mode)?[]:['retire']),'finalize']);
  assert.equal(result.byItem.module.phaseResults.copy.status,mode==='copyAndReplace'?'complete':'notApplicable');
  assert.equal(result.byItem.module.phaseResults.verify.sources.receipt.checks.length,3);
});
test('copy completion and explicit source verification never install or imply migration success',async t=>{
  const data=input('copyAndReplace',{reportPath:await directory(t),phase:'copy'}),adapter=native();
  let result=await external.execute(null,data,{},adapter);
  assert.equal(result.invocationStatus,'complete');assert.equal(result.migrationComplete,false);
  assert.equal(result.continuation.reason,'complete');assert.equal(result.continuation.nextPhase,'verify:sources');
  assert.deepEqual([...new Set(adapter.calls.map(c=>c.phase))],['copy']);
  adapter.calls.length=0;
  result=await external.execute(null,{...data,phase:'verify',verificationScope:'sources',resume:true},{},adapter);
  assert.equal(result.invocationStatus,'complete');assert.equal(result.byItem.module.phaseResults.stage.status,'notStarted');
  assert.equal(adapter.calls.every(c=>c.phase==='verify:sources'),true);
});
test('existing reuse supports source verification before stage and does not submit copy',async t=>{
  const data=input('replaceFromExisting',{reportPath:await directory(t),phase:'copy'}),adapter=native();
  let result=await external.execute(null,data,{},adapter);
  assert.equal(result.byItem.module.phaseResults.copy.status,'notApplicable');
  result=await external.execute(null,{...data,phase:'verify',verificationScope:'sources',resume:true},{},adapter);
  assert.equal(result.byItem.module.phaseResults.verify.sources.status,'complete');
  assert.equal(result.byItem.module.phaseResults.stage.status,'notStarted');
});
test('maxItems considers one unit and resumes remaining original items, not already-completed units',async t=>{
  const data=input('composeNew',{reportPath:await directory(t),maxItems:1}),adapter=native();
  data.items.push({...data.items[0],itemId:'second'});data.expectedInventory.second={...data.expectedInventory.module};
  let result=await external.execute(null,data,{},adapter);
  assert.equal(result.migrationComplete,false);assert.equal(result.consideredItems,1);
  assert.equal(adapter.calls.every(c=>c.itemId==='module'),true);
  adapter.calls.length=0;
  result=await external.execute(null,{...data,resume:true},{},adapter);
  assert.equal(result.migrationComplete,true);assert.equal(adapter.calls.every(c=>c.itemId==='second'),true);
});
test('maxChecks stops exactly after two distinct checks and persists remaining coverage',async t=>{
  const data=input('composeNew',{reportPath:await directory(t),maxChecks:2}),adapter=native();
  const first=await external.execute(null,data,{},adapter);
  assert.equal(first.invocationStatus,'partial');assert.equal(first.migrationComplete,false);
  assert.equal(first.byItem.module.phaseResults.verify.sources.receipt.checks.length,2);
  assert.deepEqual(first.continuation.remainingCheckIds,['check:2']);
  const second=await external.execute(null,{...data,resume:true,maxChecks:10},{},adapter);
  assert.equal(second.migrationComplete,true);
  assert.deepEqual(second.byItem.module.phaseResults.verify.sources.receipt.checks.map(c=>c.checkId),['check:0','check:1','check:2']);
});
test('whole-invocation budget stops before the next native action, without undo or timeout replay',async t=>{
  const data=input('composeNew',{reportPath:await directory(t),timeBudgetMs:10}),adapter=native();let clock=0;
  const step=adapter.step;adapter.step=async(...args)=>{const r=await step(...args);clock+=20;return r;};adapter.now=()=>clock;
  const result=await external.execute(null,data,{},adapter);
  assert.equal(result.invocationStatus,'partial');assert.equal(result.continuation.reason,'budgetExhausted');
  assert.equal(result.budgetExceeded,true);assert.equal(adapter.calls.length,1);
});
test('native probe reserve stops at a resumable known checkpoint without repeating its step',async t=>{
  const data=input('composeNew',{reportPath:await directory(t)});let calls=0;
  const adapter={step:async(action)=>{
    if(action==='inspect')return {status:'unavailable',terminal:false};
    calls++;return {status:'pending',receipt:{cursor:0,reason:'budgetExhausted',stopReason:'budgetExhausted',
      restorationReserveMsPlanned:60000,restorationReserveMsUsed:0}};
  }};
  const result=await external.execute(null,data,{},adapter);
  assert.equal(calls,1);assert.equal(result.byItem.module.phaseResults.copy.status,'pending');
  assert.equal(result.continuation.reason,'budgetExhausted');assert.equal(result.continuation.canResume,true);
  assert.equal(result.pending,null);
});
test('externalization reserves RPC return time instead of submitting a subsecond request',async()=>{
  const client={server:{timeoutMs:120000},callTool:async()=>assert.fail('No SDK request may be submitted')};
  const result=await executeExternalizationAction(client,'perform',{remainingMs:322},false);
  assert.equal(result.notStarted,true);assert.equal(result.status,'pending');
  assert.equal(result.receipt.stopReason,'budgetExhausted');assert.equal(client.server.timeoutMs,120000);
});
test('pending native upload remains copy pending and can only observe its original future',async t=>{
  const data=input('copyAndReplace',{reportPath:await directory(t),phase:'copy'}),adapter=native({wait:true});
  let clock=0;data.timeBudgetMs=400;adapter.now=()=>clock;adapter.sleep=async ms=>{clock+=ms;};
  const result=await external.execute(null,data,{},adapter);
  assert.equal(result.byItem.module.uploadStatus,'pending');assert.equal(result.byItem.module.phaseResults.copy.status,'pending');
  assert.equal(result.migrationComplete,false);assert.equal(result.continuation.reason,'pendingPublication');
  assert.equal(result.continuation.canResume,true);
});
test('queued and accepted native submissions normalize to pending, never completed upload',async t=>{
  for(const status of ['queued','accepted']){
    let clock=0;
    const data=input('copyAndReplace',{reportPath:await directory(t),phase:'copy',timeBudgetMs:1000});
    const adapter={now:()=>clock,step:async()=>{clock=1000;return {status:'pending',uploadStatus:status,
      rawUploadState:{value:0},receipt:{cursor:1,accepted:true}};}};
    const result=await external.execute(null,data,{},adapter);
    assert.equal(result.byItem.module.uploadStatus,'pending');assert.equal(result.migrationComplete,false);
    assert.equal(result.byItem.module.phaseResults.copy.status,'pending');
    assert.equal(result.byItem.module.phaseResults.copy.receipt.accepted,true);
  }
});
test('generous automatic run observes the original pending future then continues without a new copy submission',async t=>{
  const data=input('copyAndReplace',{reportPath:await directory(t)}),adapter=native();let observations=0,clock=0;
  const original=adapter.step;
  adapter.now=()=>clock;adapter.sleep=async ms=>{clock+=ms;};
  adapter.step=async(action,payload,readOnly)=>{
    if(action==='perform' && payload.phase==='copy' && external.slot(payload.result.byItem.module,'copy').receipt?.cursor===1 && observations++===0)
      return {status:'pending',uploadStatus:'pending',waitingPublication:true,receipt:{cursor:1}};
    return original(action,payload,readOnly);
  };
  const result=await external.execute(null,data,{},adapter);
  assert.equal(result.migrationComplete,true);assert.equal(observations,2);
});
test('unknown native effects survive restart and inspection without another mutation',async t=>{
  const data=input('copyAndReplace',{reportPath:await directory(t)}),adapter=native({fail:Error('lost transport after submit')});
  let result=await external.execute(null,data,{},adapter);
  assert.equal(result.invocationStatus,'unknown');assert.ok(result.pending);
  result=await external.execute(null,{...data,phase:'inspect'},{},adapter);
  assert.equal(result.inspection.status,'unavailable');
  const mutations=adapter.calls.filter(c=>c.action==='perform').length;
  result=await external.execute(null,{...data,resume:true},{},adapter);
  assert.equal(result.invocationStatus,'unknown');assert.equal(adapter.calls.filter(c=>c.action==='perform').length,mutations);
});
test('a known original receipt retains transport error history without reporting a stale active error',async t=>{
  const data=input('copyAndReplace',{reportPath:await directory(t),phase:'copy'});
  const adapter=native({fail:Error('lost reply')});
  const first=await external.execute(null,data,{},adapter);assert.equal(first.invocationStatus,'unknown');
  const original=adapter.step;
  adapter.step=async(action,payload,readonly)=>action==='inspect'?{status:'observed',terminal:true,
    stepId:first.pending.stepId,result:{status:'pending',receipt:{cursor:1,accepted:true}}}:original(action,payload,readonly);
  const result=await external.execute(null,{...data,resume:true},{},adapter);
  assert.equal(result.invocationStatus,'complete');assert.equal(result.error,undefined);
  assert.deepEqual(result.reconciledErrors,[{stepId:first.pending.stepId,error:'lost reply'}]);
});
test('restart inspection preserves known phase checks recorded before an unknown native submit',()=>{
  const checks=[{checkId:'final:0:body:0',passed:true},{checkId:'final:1:history:poses:attributes',passed:true}];
  const result={pending:{stepId:'finalize:module:3:5',phase:'finalize',itemId:'module'},
    byItem:{module:{phaseResults:{finalize:{status:'unknown',receipt:{cursor:3,reason:'lost result'}}}}}};
  const records=[{event:'observed',result:{pending:{stepId:'finalize:module:2:4',phase:'finalize',itemId:'module'},
    byItem:{module:{phaseResults:{finalize:{status:'pending',receipt:{cursor:3,checks}}}}}}}];
  external.restoreKnownPendingEvidence(result,records);
  assert.deepEqual(result.byItem.module.phaseResults.finalize.receipt.checks,checks);
  assert.equal(result.byItem.module.phaseResults.finalize.receipt.reason,'lost result');
});
test('known notStarted block preserves the exact completed coverage cursor for safe continuation',()=>{
  const state={receipt:{cursor:7,checks:[{checkId:'check:0',passed:true}]}};
  const output={status:'blocked',notStarted:true,receipt:{cursor:0,reason:'staleEvidence'}};
  output.receipt={...state.receipt,...output.receipt};
  external.preserveKnownCursor(state,output);
  assert.equal(output.receipt.cursor,7);assert.equal(output.receipt.reason,'staleEvidence');
  assert.deepEqual(output.receipt.checks,state.receipt.checks);
});
test('receipt-level source wait and local RPC reserve retain their known continuation cursor',()=>{
  for(const output of [
    {status:'blocked',receipt:{cursor:0,notStarted:true,reason:'staleEvidence'}},
    {status:'pending',notStarted:true,receipt:{cursor:0,stopReason:'budgetExhausted'}},
  ]){
    external.preserveKnownCursor({receipt:{cursor:4}},output);
    assert.equal(output.receipt.cursor,4);
  }
});
test('restart restores prior verification cursor after a proven notStarted stale-evidence block',()=>{
  const checks=[{checkId:'body:0',passed:true},{checkId:'history:poses:attributes',passed:true}];
  const result={byItem:{module:{itemId:'module',phaseResults:{verify:{sources:{status:'notStarted',receipt:null},
    assembly:{status:'blocked',receipt:{cursor:0,notStarted:true,reason:'staleEvidence',checks}}}}}}};
  const records=[{event:'observed',result:{byItem:{module:{phaseResults:{verify:{sources:{status:'notStarted',receipt:null},
    assembly:{status:'pending',receipt:{cursor:2,checks}}}}}}}}];
  external.restoreBlockedCheckpoints(result,records);
  assert.equal(external.slot(result.byItem.module,'verify:assembly').receipt.cursor,2);
  assert.deepEqual(external.slot(result.byItem.module,'verify:assembly').receipt.checks,checks);
  assert.equal(external.slot(result.byItem.module,'verify:assembly').receipt.notStarted,true);
});
test('inspect without an immutable manifest is read-only and does not create a report directory',async t=>{
  const root=await directory(t),reportPath=path.join(root,'missing-report');
  const data=input('composeNew',{reportPath,phase:'inspect'}),adapter=native();
  const result=await external.execute(null,data,{},adapter);
  assert.equal(result.invocationStatus,'unknown');assert.equal(result.inspection.status,'unavailable');
  assert.equal(adapter.calls.length,0);
  await assert.rejects(fs.access(path.join(reportPath,'op')));
});
test('manifest drift, operation reuse without resume and journal gaps reject before SDK',async t=>{
  const data=input('composeNew',{reportPath:await directory(t),phase:'copy'}),adapter=native();
  await external.execute(null,data,{},adapter);
  await assert.rejects(external.execute(null,{...data,linearTolerance:'1 mm',resume:true},{},adapter),/manifest differs/);
  await assert.rejects(external.execute(null,data,{},adapter),/resume:true/);
  const dir=path.join(data.reportPath,data.operationId);
  await fs.rename(path.join(dir,'00000000.json'),path.join(dir,'00009999.json'));
  await assert.rejects(external.execute(null,{...data,resume:true},{},adapter),/sequence gap/);
});
test('shared .3 journal identity is immutable and publication never overwrites an existing record',async t=>{
  const dir=await directory(t),binding={operation:'component.externalize',operationId:'a',requestHash:'hash'};
  await writeOperationRecord(dir,binding,0,{result:{phaseResults:{copy:{status:'pending'}}}});
  await assert.rejects(writeOperationRecord(dir,binding,0,{result:{}}));
  assert.equal((await readOperationJournal(dir,binding)).length,1);
  await assert.rejects(readOperationJournal(dir,{...binding,operationId:'other'}),/identity mismatch/);
});

test('group publication remains pending across bounded invocations despite an uncorrelated complete name candidate',async t=>{
  const data=input('copyAndReplace',{reportPath:await directory(t),phase:'copy',timeBudgetMs:400});
  delete data.items[0].selection;data.items[0].groupId='pair';
  data.extractionGroups=[{id:'pair',members:[{token:'a',path:'A:1'},{token:'b',path:'B:1'}]}];
  let clock=0,submissions=0,observations=0;
  const adapter={now:()=>clock,sleep:async ms=>{clock+=ms;},step:async(action,payload)=>{
    if(action==='inspect')return {status:'observed',terminal:false,
      sourceObservation:{modified:false},candidateByName:{fileId:'uncorrelated',isComplete:true}};
    assert.equal(payload.phase,'copy');
    const cursor=payload.result.byItem.module.phaseResults.copy.receipt?.cursor??0;
    if(cursor===0){submissions++;return {status:'pending',receipt:{cursor:1,isolatedParentCopyAccepted:true}};}
    observations++;return {status:'pending',uploadStatus:'pending',rawUploadState:{value:0,name:'0'},
      waitingPublication:true,receipt:{cursor:1,accepted:true}};
  }};
  const first=await external.execute(null,data,{},adapter);
  assert.equal(first.continuation.reason,'pendingPublication');assert.equal(first.migrationComplete,false);
  const before=observations;
  const inspected=await external.execute(null,{...data,phase:'inspect'},{},adapter);
  assert.equal(inspected.inspection.candidateByName.isComplete,true);assert.equal(observations,before);
  const next=await external.execute(null,{...data,resume:true},{},adapter);
  assert.equal(next.byItem.module.phaseResults.copy.status,'pending');assert.equal(next.migrationComplete,false);
  assert.equal(next.byItem.module.phaseResults.stage.status,'notStarted');assert.equal(submissions,1);
  assert.ok(observations>before);
});

test('new copy nonce and exact source/component/destination intent are durable before native submission',async t=>{
  const data=input('copyAndReplace',{reportPath:await directory(t),phase:'copy'});
  const adapter=native(),original=adapter.step;let intent;
  adapter.step=async(action,payload,readonly)=>{
    if(action==='perform'&&payload.phase==='copy'&&payload.copyIntent){
      intent=payload.copyIntent;
      const record=JSON.parse(await fs.readFile(path.join(data.reportPath,data.operationId,'00000000.json'),'utf8'));
      assert.deepEqual(record.result.pending.copyIntent,intent);
      assert.deepEqual(intent.source,data.source);assert.deepEqual(intent.component,data.items[0].selection);
      assert.deepEqual(intent.destination,data.items[0].destination);assert.match(intent.nonce,/^[0-9a-f]{64}$/);
      assert.equal(intent.description,intent.finalDescription+' [fmcad-copy:'+intent.nonce+']');
    }
    return original(action,payload,readonly);
  };
  const result=await external.execute(null,data,{},adapter);
  assert.equal(result.invocationStatus,'complete');assert.ok(intent);
  const other=input('copyAndReplace',{operationId:'other',reportPath:await directory(t),phase:'copy'});
  let otherNonce;const otherAdapter=native(),otherStep=otherAdapter.step;
  otherAdapter.step=async(...args)=>{if(args[1].copyIntent)otherNonce=args[1].copyIntent.nonce;return otherStep(...args);};
  await external.execute(null,other,{},otherAdapter);assert.notEqual(otherNonce,intent.nonce);
});

test('three-module grouped automatic and bounded scheduling have equal completed scope with one submission per effect',async t=>{
  const make=async(reportPath)=>{
    const data=input('copyAndReplace',{reportPath});delete data.items[0].selection;data.items[0].groupId='pair';
    data.extractionGroups=[{id:'pair',members:[{token:'a',path:'A:1'},{token:'b',path:'B:1'}]}];
    data.expectedInventory.module={bodies:2,occurrences:2,history:5};
    data.items.push({...input('copyAndReplace').items[0],itemId:'anchor',selection:{token:'c',path:'Anchor:1'},
      destination:{projectId:'project',folderId:'folder',fileName:'Anchor'}});
    data.expectedInventory.anchor={bodies:1,occurrences:0,history:2};
    return data;
  };
  const adapter=()=>{
    const base=native(),original=base.step,effects=[];
    base.step=async(action,payload,readonly)=>{
      if(action==='perform'&&payload.itemId==='module'&&payload.phase==='copy'){
        const cursor=payload.result.byItem.module.phaseResults.copy.receipt?.cursor??0;
        effects.push(cursor);
        return {status:cursor===8?'complete':'pending',uploadStatus:cursor===8?'complete':'pending',
          receipt:{cursor:cursor+1,...(cursor===0?{isolatedParentCopyAccepted:true}:{}),
            ...(cursor===6?{stagingSource:{projectId:'project',fileId:'staging',version:2},stagingComponent:{token:'group-component'}}:{}),
            ...(cursor===8?{target:{fileId:'exact-group-future-result',version:1}}:{})}};
      }
      return original(action,payload,readonly);
    };
    base.effects=effects;return base;
  };
  const autoData=await make(await directory(t)),autoAdapter=adapter();
  const automatic=await external.execute(null,autoData,{},autoAdapter);
  assert.equal(automatic.migrationComplete,true);
  const boundedData=await make(await directory(t)),boundedAdapter=adapter();
  let bounded=await external.execute(null,{...boundedData,maxItems:1,maxChecks:1},{},boundedAdapter);
  for(let i=0;i<20&&!bounded.migrationComplete;i++)
    bounded=await external.execute(null,{...boundedData,resume:true,maxItems:1,maxChecks:1},{},boundedAdapter);
  assert.equal(bounded.migrationComplete,true);
  for(const id of ['module','anchor'])assert.deepEqual(bounded.byItem[id].phaseResults,automatic.byItem[id].phaseResults);
  assert.deepEqual(autoAdapter.effects,[0,1,2,3,4,5,6,7,8]);
  assert.deepEqual(boundedAdapter.effects,autoAdapter.effects);
});
