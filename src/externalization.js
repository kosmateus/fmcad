const { hash } = require('./engineering-common');
const { publishComplete } = require('./publish');
const { readOperationJournal, writeOperationRecord } = require('./batch-atomic');
const { openExternalizationJournal } = require('./dist/node-adapters/persistence/externalization');
const { initial, slot, completeMigration, phaseOrder } = require('./dist/core/application/documents/externalization');

const modes = ['copyAndReplace', 'replaceFromExisting', 'composeNew', 'replaceExternal'];
const phases = ['run', 'copy', 'verify', 'stage', 'retire', 'finalize', 'inspect'];
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' && x.trim() === x && x.length > 0;
const integer = x => Number.isSafeInteger(x) && x > 0;
const clone = x => JSON.parse(JSON.stringify(x));
const probeMeasures = {
  'measure.diameter': [['ref'], ['units']], 'measure.radius': [['ref'], ['units']],
  'measure.length': [['ref'], ['units']], 'measure.area': [['ref'], ['units']],
  'measure.volume': [['ref'], ['units']], 'measure.mass': [['ref'], ['units']],
  'measure.distance': [['a','b'], ['mode','direction','units','space']],
  'measure.angle': [['a','b'], ['c','units']],
  'measure.thickness': [['a','b'], ['units','mode','tolerance','angleTolerance']],
};
function requireThat(test, message) { if (!test) throw new Error(message); }
function fields(value, allowed, required = []) {
  requireThat(object(value), 'Expected an object');
  for (const key of Object.keys(value)) requireThat(allowed.includes(key), 'Unknown externalization field: ' + key);
  for (const key of required) requireThat(Object.hasOwn(value, key), 'Missing externalization field: ' + key);
}
function destination(value, nameKey) {
  fields(value, ['projectId', 'folderId', nameKey], ['projectId', 'folderId', nameKey]);
  requireThat(Object.values(value).every(text), 'Destination requires exact project/folder/name');
}
function validateProbeCheck(check) {
  fields(check, ['measurement','min','max','expected','tolerance','id','source'], ['measurement']);
  const measurement = check.measurement;
  fields(measurement, ['operation','data'], ['operation','data']);
  const shape = probeMeasures[measurement.operation];
  requireThat(shape && object(measurement.data), 'Probe check requires a supported scalar measurement');
  fields(measurement.data, shape[0].concat(shape[1]), shape[0]);
  requireThat(['min','max','expected'].some(key => Object.hasOwn(check, key)), 'Probe check requires min/max or expected');
  requireThat(!(Object.hasOwn(check, 'expected') && (Object.hasOwn(check, 'min') || Object.hasOwn(check, 'max'))) &&
    !(Object.hasOwn(check, 'tolerance') && !Object.hasOwn(check, 'expected')), 'Probe check must use expected/tolerance or min/max');
  for (const key of ['min','max','expected','tolerance']) if (Object.hasOwn(check, key))
    requireThat(text(check[key]), 'Probe check ' + key + ' must be a dimensional expression');
}

function validateProbeUiLeases(leases, requestId, name) {
  requireThat(object(leases), `qualifiedOnce driver probes require ${name}`);
  for (const [fileId, entry] of Object.entries(leases)) {
    requireThat(text(fileId) && object(entry) && object(entry.target) && object(entry.lease),
      `${name} must map exact file IDs to request-bound target/lease records`);
    const { target, lease } = entry;
    requireThat(target.fileId === fileId && text(target.name) &&
      (target.creationId === undefined || text(target.creationId)) &&
      target.commandId === undefined,
      `${name} target must identify its exact consumer file and omit an unqualified commandId`);
    requireThat(text(lease.id) && text(lease.operationId) && lease.requestId === requestId &&
      Number.isSafeInteger(lease.expiresAt) && object(lease.target) && hash(lease.target) === hash(target),
      `${name} lease must match its exact .10 apply request and target`);
  }
}
function validateIndexMap(value,name) {
  if (value===undefined)return;
  requireThat(Array.isArray(value),name+' must be an explicit mapping array');
  const sources=new Set(),targets=new Set();
  for (const row of value) {
    fields(row,['sourceIndex','targetIndex'],['sourceIndex','targetIndex']);
    requireThat(Number.isSafeInteger(row.sourceIndex) && row.sourceIndex>=0 &&
      Number.isSafeInteger(row.targetIndex) && row.targetIndex>=0,name+' indices must be nonnegative integers');
    requireThat(!sources.has(row.sourceIndex) && !targets.has(row.targetIndex),name+' must be a bijection');
    sources.add(row.sourceIndex);targets.add(row.targetIndex);
  }
}
const immutableKeys = ['schemaVersion','mode','source','items','extractionGroups','destinationDocument',
  'parameterBindings','rootDatums','boundaries','probes','callerNamespaces','expectedInventory',
  'linearTolerance','angularTolerance','volumeTolerance','save','confirmReplace','confirmRetire'];
function validate(input) {
  fields(input, [...immutableKeys,'operationId','reportPath','phase','verificationScope','resume','itemIds',
    'maxItems','maxChecks','timeBudgetMs'], ['schemaVersion','operationId','reportPath','mode','source','items',
    'linearTolerance','angularTolerance','volumeTolerance','expectedInventory']);
  requireThat(input.schemaVersion === 1, 'schemaVersion must be 1');
  requireThat(text(input.operationId) && /^[A-Za-z0-9_-]{1,100}$/.test(input.operationId), 'Invalid operationId');
  requireThat(text(input.reportPath), 'reportPath is required');
  requireThat(modes.includes(input.mode), 'Explicit externalization mode is required');
  const data = { phase:'run', resume:false, maxItems:100, maxChecks:10000, timeBudgetMs:180000,
    extractionGroups:[], parameterBindings:[], rootDatums:[], boundaries:[], probes:[], callerNamespaces:[], ...clone(input) };
  requireThat(phases.includes(data.phase), 'Invalid externalization phase');
  if (data.phase === 'verify') requireThat(['sources','assembly'].includes(data.verificationScope), 'verify requires verificationScope:sources|assembly');
  else requireThat(data.verificationScope === undefined, 'verificationScope belongs only to verify');
  requireThat(!(data.phase === 'retire' && ['composeNew','replaceExternal'].includes(data.mode)), 'retire is not applicable to this mode');
  requireThat(typeof data.resume === 'boolean', 'resume must be boolean');
  for (const key of ['save','confirmReplace','confirmRetire']) if (data[key] !== undefined) requireThat(typeof data[key] === 'boolean', key + ' must be boolean');
  for (const key of ['maxItems','maxChecks','timeBudgetMs']) requireThat(integer(data[key]), key + ' must be a positive integer');
  for (const key of ['linearTolerance','angularTolerance','volumeTolerance']) requireThat(text(data[key]), key + ' must be an explicit dimensional expression');
  fields(data.source, ['projectId','fileId','version','creationId','context'], ['projectId','fileId','version','creationId']);
  requireThat(data.source.context===undefined || data.source.context==='topLevel','Source context must explicitly be topLevel when disambiguation is required');
  requireThat(text(data.source.projectId) && text(data.source.fileId) && text(data.source.creationId) && integer(data.source.version), 'Source must pin a saved document and exact version');
  if (data.mode === 'composeNew') destination(data.destinationDocument, 'name');
  else requireThat(data.destinationDocument === undefined, 'destinationDocument belongs only to composeNew');
  const targetProjectId=data.mode==='composeNew'?data.destinationDocument.projectId:data.source.projectId;
  if (data.mode === 'replaceExternal') requireThat(data.confirmReplace === true, 'replaceExternal requires confirmReplace:true');
  if (['copyAndReplace','replaceFromExisting'].includes(data.mode) && ['run','retire'].includes(data.phase))
    requireThat(data.confirmRetire === true, 'Local retirement requires confirmRetire:true');
  if (['run','finalize'].includes(data.phase)) requireThat(data.save === true, 'run/finalize requires explicit save:true');
  requireThat(Array.isArray(data.items) && data.items.length > 0, 'items must be nonempty');
  const ids = new Set();
  for (const item of data.items) {
    fields(item, ['itemId','selection','dataFileId','version','projectId','destination','instancePolicy',
      'destinationOccurrence','placement','placementSpace','sharedParentPolicy','name','occurrenceMap','bodyMap','groupId','definitionPolicy',
      'creationId','context'], ['itemId','instancePolicy']);
    requireThat(text(item.itemId) && /^[A-Za-z0-9_-]+$/.test(item.itemId) && !['__proto__','prototype','constructor'].includes(item.itemId) && !ids.has(item.itemId), 'itemId must be unique and safe'); ids.add(item.itemId);
    requireThat(['selected','allInstances'].includes(item.instancePolicy), 'instancePolicy is required');
    requireThat(item.definitionPolicy === undefined || ['local','external'].includes(item.definitionPolicy), 'Invalid definitionPolicy');
    if(item.selection!==undefined)requireThat(['local','external'].includes(item.definitionPolicy),'A selected source requires explicit definitionPolicy:local|external');
    const reuse = item.dataFileId !== undefined;
    if (reuse) {
      requireThat(text(item.dataFileId) && text(item.projectId) && integer(item.version), 'Existing source must pin dataFileId/projectId/version');
      requireThat(item.projectId===targetProjectId,'Pinned reused source must belong to the destination project');
      if (item.creationId !== undefined) requireThat(text(item.creationId), 'Existing source creationId must be exact');
      if (item.context !== undefined) requireThat(item.context === 'topLevel', 'Existing source context must be topLevel');
    }
    else {
      requireThat(item.selection !== undefined || text(item.groupId), 'New copy needs a native selection or extraction group');
      destination(item.destination,'fileName');
      requireThat(item.destination.projectId===targetProjectId,'New native copy destination must match the assembly project');
    }
    if (!reuse) requireThat(item.creationId === undefined && item.context === undefined, 'creationId/context pins apply only to exact reused files');
    if (['replaceFromExisting','replaceExternal'].includes(data.mode)) requireThat(reuse && item.selection !== undefined, 'Replacement requires existing file pin and exact selected occurrence');
    if (data.mode === 'copyAndReplace') requireThat(!reuse, 'copyAndReplace requires declared native copies');
    if (reuse) requireThat(item.destination === undefined, 'Existing files are reused only by ID, not destination/name');
    if (data.mode==='composeNew') requireThat(item.destinationOccurrence===undefined || item.destinationOccurrence==='root',
      'composeNew starts with a new empty root; nested target parents must be declared as native files, not guessed by name');
    if (data.mode==='replaceExternal') requireThat(item.destinationOccurrence===undefined && item.placement===undefined &&
      item.placementSpace===undefined && item.sharedParentPolicy===undefined,
      'replaceExternal preserves the selected occurrence context and does not accept insertion placement options');
    if (item.name !== undefined) requireThat(text(item.name), 'Invalid item name');
    if (item.placementSpace !== undefined) requireThat(item.placement !== undefined && ['root','parent'].includes(item.placementSpace), 'placementSpace requires placement');
    if (item.placement !== undefined) {
      requireThat(data.mode==='composeNew','Placement edits are only supported by composeNew; in-place modes preserve captured poses');
      fields(item.placement,['translation','axis','angle']);
      if (item.destinationOccurrence!==undefined && item.destinationOccurrence!=='root')
        requireThat(['root','parent'].includes(item.placementSpace),'Nested placement requires placementSpace:root|parent');
      else requireThat(item.placementSpace!== 'parent','placementSpace:parent requires a nonroot destination');
      if (item.placement.translation!==undefined) requireThat(Array.isArray(item.placement.translation) &&
        item.placement.translation.length===3 && item.placement.translation.every(text),'placement.translation needs three length expressions');
      requireThat((item.placement.axis===undefined)===(item.placement.angle===undefined),'placement rotation needs both axis and angle');
      if (item.placement.axis!==undefined) requireThat(Array.isArray(item.placement.axis) && item.placement.axis.length===3 &&
        item.placement.axis.every(value=>typeof value==='number' && Number.isFinite(value)) &&
        item.placement.axis.some(value=>value!==0) && text(item.placement.angle),
        'placement rotation needs a finite nonzero axis and angle expression');
    }
    if (item.sharedParentPolicy !== undefined) requireThat(['reject','allInstances'].includes(item.sharedParentPolicy), 'Invalid sharedParentPolicy');
    validateIndexMap(item.occurrenceMap,'occurrenceMap');validateIndexMap(item.bodyMap,'bodyMap');
  }
  for (const key of ['extractionGroups','parameterBindings','rootDatums','boundaries','probes','callerNamespaces']) requireThat(Array.isArray(data[key]), key + ' must be an array');
  const namespaceKeys=new Set();
  for (const declaration of data.callerNamespaces) {
    fields(declaration,['itemId','scope','group','keys'],['itemId','scope','group','keys']);
    requireThat(ids.has(declaration.itemId) && declaration.scope==='parent' && text(declaration.group) &&
      Array.isArray(declaration.keys) && declaration.keys.length>0 && declaration.keys.every(text) &&
      new Set(declaration.keys).size===declaration.keys.length,'callerNamespaces require a caller-selected parent attribute group and unique keys');
    const key=declaration.itemId+'\0'+declaration.group;
    requireThat(!namespaceKeys.has(key),'callerNamespaces declarations must be unique per item and group');
    namespaceKeys.add(key);
  }
  const groups = new Set();
  for (const group of data.extractionGroups) {
    fields(group,['id','members'],['id','members']);
    requireThat(text(group.id) && !groups.has(group.id) && Array.isArray(group.members) && group.members.length > 1, 'Invalid extraction group'); groups.add(group.id);
  }
  for (const item of data.items) if (item.groupId) {
    requireThat(groups.has(item.groupId), 'Unknown groupId');
    requireThat(item.instancePolicy==='selected','Extraction groups require explicit selected sibling membership; implicit allInstances group expansion is unsupported');
  }
  for (const binding of data.parameterBindings) {
    if (binding.targetItemId !== undefined) requireThat(ids.has(binding.targetItemId) && data.save===true,
      'Item-scoped parameter binding requires an original targetItemId and save:true');
  }
  const callerNamespaceIds=new Set();
  for (const declaration of data.callerNamespaces) {
    fields(declaration,['itemId','scope','group','keys'],['itemId','scope','group','keys']);
    requireThat(ids.has(declaration.itemId) && declaration.scope==='parent' && text(declaration.group) &&
      Array.isArray(declaration.keys) && declaration.keys.length>0 && declaration.keys.every(text) &&
      new Set(declaration.keys).size===declaration.keys.length,'callerNamespaces need exact item, parent scope, attribute group and unique keys');
    const key=declaration.itemId+'\0'+declaration.group;
    requireThat(!callerNamespaceIds.has(key),'callerNamespaces group must be unique per item');callerNamespaceIds.add(key);
  }
  requireThat(object(data.expectedInventory), 'expectedInventory is required');
  for (const item of data.items) {
    const inventory = data.expectedInventory[item.itemId];
    fields(inventory,['bodies','occurrences','history'],['bodies','occurrences','history']);
    requireThat(Object.values(inventory).every(v => Number.isSafeInteger(v) && v >= 0), 'Inventory counts must be nonnegative integers');
  }
  for (const id of Object.keys(data.expectedInventory)) requireThat(ids.has(id), 'Inventory contains an unknown item');
  if (data.itemIds !== undefined) requireThat(Array.isArray(data.itemIds) && data.itemIds.length > 0 &&
    new Set(data.itemIds).size === data.itemIds.length && data.itemIds.every(id=>ids.has(id)), 'itemIds must be a unique original-manifest subset');
  const probeIds = new Set();
  for (const probe of data.probes) {
    fields(probe,['probeId','itemId','source','parameter','expression','minimum','maximum','checks','refresh','scope'],
      ['probeId','itemId','source','parameter','expression','minimum','maximum','checks','refresh']);
    requireThat(text(probe.probeId) && ids.has(probe.itemId) && data.save === true, 'Driver probes require explicit save authorization and item');
    requireThat(/^[A-Za-z0-9_-]{1,100}$/.test(probe.probeId) && !probeIds.has(probe.probeId), 'probeId must be unique and safe');
    probeIds.add(probe.probeId);
    if (Object.hasOwn(probe.source, 'itemId')) {
      fields(probe.source, ['itemId'], ['itemId']);
      requireThat(ids.has(probe.source.itemId), 'Probe source itemId is not in the original manifest');
    } else {
      fields(probe.source, ['projectId','fileId','version','creationId','context'], ['projectId','fileId','version']);
      requireThat(text(probe.source.projectId) && text(probe.source.fileId) && integer(probe.source.version),
        'Probe source must pin an exact project/file/version');
      if (probe.source.creationId !== undefined) requireThat(text(probe.source.creationId), 'Probe source creationId must be exact');
      if (probe.source.context !== undefined) requireThat(probe.source.context === 'topLevel', 'Probe source context must be topLevel');
    }
    requireThat(probe.scope===undefined || ['sources','assembly'].includes(probe.scope),'Probe scope must be sources or assembly');
    requireThat([probe.parameter,probe.expression,probe.minimum,probe.maximum].every(text) &&
      Array.isArray(probe.checks) && probe.checks.length > 0, 'Probe must declare a continuous scalar range and checks');
    for (const check of probe.checks) validateProbeCheck(check);
    fields(probe.refresh, ['reportPath','nativeFallback','driverUiLeases','restoreUiLeases'], ['reportPath']);
    requireThat(text(probe.refresh.reportPath), 'Probe refresh reportPath is required');
    if (probe.refresh.nativeFallback !== undefined)
      requireThat(['never','qualifiedOnce'].includes(probe.refresh.nativeFallback), 'Invalid probe refresh nativeFallback');
    if (probe.refresh.nativeFallback === 'qualifiedOnce') {
      validateProbeUiLeases(probe.refresh.driverUiLeases,
        `${data.operationId}_${probe.probeId}_driver_apply`, 'driverUiLeases');
      validateProbeUiLeases(probe.refresh.restoreUiLeases,
        `${data.operationId}_${probe.probeId}_restore_apply`, 'restoreUiLeases');
    }
  }
  return data;
}
function manifest(data) { return Object.fromEntries(immutableKeys.filter(k=>data[k]!==undefined).map(k=>[k,clone(data[k])])); }
function restoreKnownPendingEvidence(result,records) {
  const pending=result.pending;
  if(!pending)return;
  const current=slot(result.byItem[pending.itemId],pending.phase);
  if(current?.status!=='unknown')return;
  for(let index=records.length-1;index>=0;index--){
    const priorResult=records[index].result;
    if(priorResult?.pending?.itemId!==pending.itemId || priorResult.pending.phase!==pending.phase)continue;
    const prior=slot(priorResult.byItem?.[pending.itemId],pending.phase);
    if(prior?.status!=='pending' || !Array.isArray(prior.receipt?.checks))continue;
    current.receipt={...prior.receipt,...(current.receipt ?? {}),
      checks:current.receipt?.checks ?? prior.receipt.checks};
    return;
  }
}
function preserveKnownCursor(state,output) {
  const previous=state.receipt?.cursor,current=output.receipt?.cursor;
  if(['blocked','pending'].includes(output.status) && (output.notStarted===true || output.receipt?.notStarted===true) && Number.isSafeInteger(previous) &&
     Number.isSafeInteger(current) && current<previous)
    output.receipt={...output.receipt,cursor:previous};
}
function restoreBlockedCheckpoints(result,records) {
  for(const [itemId,item] of Object.entries(result.byItem ?? {})) for(const phase of phaseOrder){
    const state=slot(item,phase);
    if(!state || state.status!=='blocked' || state.receipt?.notStarted!==true)continue;
    const cursor=state.receipt.cursor;
    if(!Number.isSafeInteger(cursor))continue;
    for(let index=records.length-1;index>=0;index--){
      const prior=records[index].result;
      const priorState=slot(prior?.byItem?.[itemId] ?? {},phase);
      if(!['pending','complete'].includes(priorState.status) ||
          !Number.isSafeInteger(priorState.receipt?.cursor) || priorState.receipt.cursor<=cursor)continue;
      const checks=new Map();
      for(const check of [...(priorState.receipt.checks ?? []),...(state.receipt.checks ?? [])])checks.set(check.checkId,check);
      state.receipt={...priorState.receipt,...state.receipt,cursor:priorState.receipt.cursor,
        ...(checks.size?{checks:[...checks.values()]}:{})};
      break;
    }
  }
}
function copyIntent(stored, item, state, result) {
  if (stored.copyProtocol !== 1 || item.dataFileId) return undefined;
  const cursor=state.receipt?.cursor ?? 0;
  const group=item.groupId && stored.manifest.extractionGroups.find(g=>g.id===item.groupId);
  const purpose=cursor===0 ? (group?'groupParent':'component') :
    group && cursor===group.members.length+5 ? 'groupChild' : null;
  if (!purpose) return undefined;
  let source=clone(stored.manifest.source),component=item.selection;
  for (const row of Object.values(result.byItem)) {
    const published=row.phaseResults.finalize.receipt?.file;
    if (published?.fileId===source.fileId) source.version=Math.max(source.version,published.version);
  }
  if (purpose==='groupParent') component={parentOf:clone(group.members)};
  if (purpose==='groupChild') {
    requireThat(state.receipt?.stagingSource && state.receipt?.stagingComponent,'Missing exact staged group source receipt');
    source=clone(state.receipt.stagingSource);component=clone(state.receipt.stagingComponent);
  }
  const destination={...item.destination,...(purpose==='groupParent'?
    {fileName:item.destination.fileName+'__'+stored.operationId+'__staging'}:{})};
  const binding={operationId:stored.operationId,itemId:item.itemId,purpose,source,component,destination};
  const nonce=hash({sessionNonce:stored.sessionNonce,requestHash:stored.requestHash,...binding});
  const finalDescription=purpose==='component'?'Native externalization '+stored.operationId:
    purpose==='groupParent'?'Isolated native group staging':'Native extraction group';
  return {...binding,nonce,finalDescription,description:finalDescription+' [fmcad-copy:'+nonce+']'};
}

async function execute(client, input, context, deps) {
  const { executeExternalization } = require('./dist/core/application/documents/externalization');
  return executeExternalization(input, context?.readOnly === true, {
    validate,
    requestHash: data => hash(manifest(data)),
    open: data => openJournal(data, deps),
    restore(result, records) {
      restoreKnownPendingEvidence(result, records);
      restoreBlockedCheckpoints(result, records);
    },
    copyIntent,
    preserveCursor: preserveKnownCursor,
    inspect: (stored, result) => deps.step('inspect', { ...stored, result }, true),
    perform: ({ stored, ...request }) => deps.step('perform', { ...stored, ...request }, false),
    refresh: request => deps.refresh(request),
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
  });
}

async function openJournal(data, deps) {
  return openExternalizationJournal(data, { hash, manifest, publish: publishComplete,
    read: readOperationJournal, write: writeOperationRecord }, deps.fs);
}
module.exports={validate,manifest,initial,slot,completeMigration,restoreKnownPendingEvidence,
  preserveKnownCursor,restoreBlockedCheckpoints,execute};
