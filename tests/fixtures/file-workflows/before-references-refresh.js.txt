const fs = require('node:fs/promises');
const path = require('node:path');
const { hash } = require('./engineering-common');
const { publishComplete } = require('./publish');
const { referenceStore } = require('./dist/node-adapters/persistence/references');
const { loadJournal, writePlan, readPlan, acquire, acquireRead } = referenceStore({ hash, publish: publishComplete });

const phases = new Set(['audit', 'plan', 'apply', 'inspect']);
const policies = new Set(['preserve', 'latest']);
const lifecycles = new Set(['existingOnly', 'openOwned']);
const fallbackModes = new Set(['never', 'qualifiedOnce']);
const durabilities = new Set(['cloud', 'cold']);
const own = (value, key) => Object.hasOwn(value, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim() === value && value.length > 0;
const boundedInteger = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

function validate(data, operation) {
  if (operation !== undefined && operation !== 'references.refresh') return;
  if (!isObject(data)) throw new Error('references.refresh data must be an object');
  const allowed = new Set(['schemaVersion', 'phase', 'root', 'scopeFileId', 'policy', 'pins',
    'allowedProjectIds', 'lifecycle', 'nativeFallback', 'durability', 'parameterBindings',
    'callerNamespaces', 'maxFiles', 'maxUpdates', 'timeBudgetMs', 'requestId', 'planId',
    'reportPath', 'confirm', 'uiLeases']);
  for (const key of Object.keys(data)) if (!allowed.has(key)) throw new Error(`Unknown references.refresh input: ${key}`);
  if (data.schemaVersion !== 1) throw new Error('references.refresh schemaVersion must be 1');
  const phase = data.phase ?? 'audit';
  if (!phases.has(phase)) throw new Error('phase must be audit, plan, apply or inspect');
  if (!isObject(data.root) || Object.keys(data.root).some(k => !['projectId', 'fileId', 'version'].includes(k)) ||
      !nonempty(data.root.projectId) || !nonempty(data.root.fileId) || !boundedInteger(data.root.version, 1, 1000000)) {
    throw new Error('root must be the exact saved {projectId,fileId,version} baseline');
  }
  if (data.scopeFileId !== undefined && !nonempty(data.scopeFileId)) throw new Error('scopeFileId must be an exact nonempty file ID');
  if (data.policy !== undefined && !policies.has(data.policy)) throw new Error('policy must be preserve or latest');
  if (phase !== 'apply' && phase !== 'inspect' && own(data, 'confirm')) throw new Error('confirm is accepted only by apply');
  if (phase === 'apply' && data.confirm !== true) throw new Error('apply requires confirm:true');
  if (phase === 'plan' && !policies.has(data.policy)) throw new Error('plan requires an explicit policy: preserve or latest');
  if (data.lifecycle !== undefined && !lifecycles.has(data.lifecycle)) throw new Error('lifecycle must be existingOnly or openOwned');
  if (data.nativeFallback !== undefined && !fallbackModes.has(data.nativeFallback)) throw new Error('nativeFallback must be never or qualifiedOnce');
  if (data.durability !== undefined && !durabilities.has(data.durability)) throw new Error('durability must be cloud or cold');
  if (!nonempty(data.requestId) || !/^[A-Za-z0-9_-]{1,128}$/.test(data.requestId)) {
    throw new Error('requestId must contain 1..128 letters, digits, underscores or hyphens');
  }
  if (!nonempty(data.reportPath)) throw new Error('reportPath must be a nonempty local journal directory');
  if ((phase === 'apply' || phase === 'inspect') && !nonempty(data.planId)) {
    if (phase === 'apply') throw new Error('apply requires planId');
  }
  if (data.planId !== undefined && !/^[0-9a-f]{64}$/.test(data.planId)) throw new Error('planId must be an exact SHA-256 plan identifier');
  for (const [key, value, max] of [['maxFiles', data.maxFiles, 1000], ['maxUpdates', data.maxUpdates, 1000],
    ['timeBudgetMs', data.timeBudgetMs, 1200000]]) {
    if (value !== undefined && !boundedInteger(value, 1, max)) throw new Error(`${key} must be an integer in 1..${max}`);
  }
  if (data.maxUpdates !== undefined && data.maxFiles !== undefined && data.maxUpdates > data.maxFiles) {
    throw new Error('maxUpdates cannot exceed maxFiles');
  }
  if (data.allowedProjectIds !== undefined && (!Array.isArray(data.allowedProjectIds) ||
      data.allowedProjectIds.some(id => !nonempty(id)) || new Set(data.allowedProjectIds).size !== data.allowedProjectIds.length)) {
    throw new Error('allowedProjectIds must contain unique exact project IDs');
  }
  if (data.allowedProjectIds && !data.allowedProjectIds.includes(data.root.projectId)) {
    throw new Error('allowedProjectIds must include the pinned root projectId');
  }
  if (data.pins !== undefined && (!Array.isArray(data.pins) || data.pins.some(pin => !isObject(pin) ||
      Object.keys(pin).some(k => !['edgeId', 'sourceFileId', 'version'].includes(k)) ||
      !nonempty(pin.edgeId) || !nonempty(pin.sourceFileId) || !boundedInteger(pin.version, 1, 1000000)))) {
    throw new Error('pins must be [{edgeId,sourceFileId,version}] with exact IDs and positive versions');
  }
  if (data.pins && new Set(data.pins.map(pin => pin.edgeId)).size !== data.pins.length) {
    throw new Error('pins must contain at most one version per edgeId');
  }
  if (data.parameterBindings !== undefined && (!Array.isArray(data.parameterBindings) ||
      data.parameterBindings.some(binding => !isObject(binding) ||
        Object.keys(binding).some(k => !['edgeId', 'sourceParameter', 'consumerAlias', 'nativeDerivedParameter'].includes(k)) ||
        !nonempty(binding.edgeId) || !nonempty(binding.sourceParameter) ||
        (!nonempty(binding.consumerAlias) && !nonempty(binding.nativeDerivedParameter))))) {
    throw new Error('parameterBindings require edgeId, sourceParameter and a caller-named consumerAlias or nativeDerivedParameter');
  }
  if (data.callerNamespaces !== undefined && !isObject(data.callerNamespaces)) {
    throw new Error('callerNamespaces must be an object of opaque caller-supplied context namespaces');
  }
  if (data.uiLeases !== undefined && (!isObject(data.uiLeases) || Object.entries(data.uiLeases).some(([fileId, entry]) =>
      !nonempty(fileId) || !isObject(entry) || !isObject(entry.target) || !isObject(entry.lease) ||
      entry.target.fileId !== fileId || !nonempty(entry.target.name) ||
      (entry.target.creationId !== undefined && !nonempty(entry.target.creationId)) ||
      (entry.target.commandId !== undefined && entry.target.commandId !== null) ||
      entry.lease.requestId !== data.requestId || !nonempty(entry.lease.id) || !nonempty(entry.lease.operationId) ||
      !Number.isSafeInteger(entry.lease.expiresAt) || !isObject(entry.lease.target) ||
      hash(entry.lease.target) !== hash(entry.target)))) {
    throw new Error('uiLeases must map exact file IDs to .11 leases bound to this requestId and exact target identity');
  }
  if (phase === 'apply' && inputNativeFallback(data) && data.uiLeases !== undefined &&
      Object.keys(data.uiLeases).some(fileId => !nonempty(fileId))) throw new Error('uiLeases keys must be exact file IDs');
  return { ...data, phase, lifecycle: data.lifecycle ?? 'existingOnly', nativeFallback: data.nativeFallback ?? 'never',
    policy: data.policy ?? 'preserve',
    durability: data.durability ?? (phase === 'apply' ? 'cold' : 'cold'),
    allowedProjectIds: data.allowedProjectIds ?? [data.root.projectId],
    maxFiles: data.maxFiles ?? 100, maxUpdates: data.maxUpdates ?? data.maxFiles ?? 100,
    timeBudgetMs: data.timeBudgetMs ?? 180000, pins: data.pins ?? [],
    parameterBindings: data.parameterBindings ?? [], callerNamespaces: data.callerNamespaces ?? {} };
}

function configure(catalog) {
  if (!catalog['references.refresh']) throw new Error('references.refresh catalog entry is required');
  const entry = catalog['references.refresh'];
  entry.nodeOnly = true;
  entry.batchAllowed = false;
  entry.requiresDoc = false;
}

function inputNativeFallback(data) { return (data.nativeFallback ?? 'never') === 'qualifiedOnce'; }

function edgeKey(edge) {
  if (!isObject(edge) || !nonempty(edge.edgeId)) throw new Error('Reference edge is missing its stable edgeId');
  return edge.edgeId;
}

function dependencyOrder(nodes, edges) {
  const state = new Map(), result = [], cycle = [];
  const outgoing = new Map(nodes.map(node => [node.fileId, []]));
  for (const edge of edges) {
    if (edge.selfReference === true) continue;
    if (outgoing.has(edge.ownerFileId) && nodes.some(node => node.fileId === edge.sourceFileId)) {
      outgoing.get(edge.ownerFileId).push(edge.sourceFileId);
    }
  }
  function visit(fileId, pathStack) {
    const mark = state.get(fileId);
    if (mark === 'done') return;
    if (mark === 'visiting') { cycle.push([...pathStack, fileId]); return; }
    state.set(fileId, 'visiting');
    for (const child of outgoing.get(fileId) ?? []) visit(child, [...pathStack, fileId]);
    state.set(fileId, 'done');
    result.push(fileId);
  }
  for (const node of nodes) visit(node.fileId, []);
  return { order: result, cycles: cycle };
}

function explicitBindingCoverage(edge, document, bindings) {
  const derived = Array.isArray(edge.derivedParameters) ? edge.derivedParameters : [];
  if (!derived.length) return { complete: true, expected: [], mapped: [], valuesMatch: true, valueMismatches: [] };
  const sourceNames = new Set((edge.sourceParameters ?? []).map(row => row.name));
  const aliases = new Map((document.parameters ?? []).filter(row => row?.name).map(row => [row.name, row]));
  const candidates = bindings.filter(binding => binding.edgeId === edge.edgeId);
  const mapped = [];
  for (const binding of candidates) {
    if (!sourceNames.has(binding.sourceParameter)) continue;
    let nativeName = binding.nativeDerivedParameter;
    if (nativeName && !derived.some(row => row.name === nativeName)) continue;
    if (!nativeName && binding.consumerAlias) {
      const alias = aliases.get(binding.consumerAlias);
      if (!alias) continue;
      const matches = derived.filter(row => alias.expression === row.name ||
        Array.isArray(alias.dependsOn) && alias.dependsOn.includes(row.name));
      if (matches.length !== 1) continue;
      nativeName = matches[0].name;
    }
    if (!nativeName) continue;
    if (binding.consumerAlias) {
      const alias = aliases.get(binding.consumerAlias);
      if (!alias || !(alias.expression === nativeName || Array.isArray(alias.dependsOn) && alias.dependsOn.includes(nativeName))) continue;
    }
    mapped.push({ sourceParameter: binding.sourceParameter, nativeDerivedParameter: nativeName,
      consumerAlias: binding.consumerAlias ?? null });
  }
  const mappedNames = new Set(mapped.map(row => row.nativeDerivedParameter));
  const complete = mapped.length === candidates.length && derived.every(row => mappedNames.has(row.name)) &&
    mapped.length === derived.length;
  const valueMismatches = [];
  let valuesUnknown = false;
  for (const binding of mapped) {
    const source = (edge.sourceParameters ?? []).find(row => row.name === binding.sourceParameter);
    const target = derived.find(row => row.name === binding.nativeDerivedParameter);
    if (!source || !target || source.internal_unit !== target.internal_unit ||
        source.internal_value === undefined || target.internal_value === undefined) {
      valuesUnknown = true;
      continue;
    }
    const matches = typeof source.internal_value === 'number' && typeof target.internal_value === 'number' ?
      Math.abs(source.internal_value - target.internal_value) <= 1e-9 * Math.max(1, Math.abs(source.internal_value)) :
      source.internal_value === target.internal_value;
    if (!matches) valueMismatches.push({ sourceParameter: source.name,
      nativeDerivedParameter: target.name, sourceValue: source.internal_value,
      derivedValue: target.internal_value, unit: source.internal_unit });
  }
  return { complete, expected: derived.map(row => row.name), mapped,
    valuesMatch: !complete || valuesUnknown ? null : valueMismatches.length === 0, valueMismatches };
}

function makePlan(snapshot, input) {
  if (!isObject(snapshot) || !Array.isArray(snapshot.documents) || !Array.isArray(snapshot.edges)) {
    const shape = !isObject(snapshot) ? `type=${snapshot === null ? 'null' : typeof snapshot}` :
      `object keys=${Object.keys(snapshot).sort().join(',') || '(none)'}`;
    const error = new Error(`Graph audit did not return documents and forward edges (${shape})`);
    error.fmcadReadOnlyFailure = 'references.refresh graph result shape';
    throw error;
  }
  const documents = snapshot.documents;
  const byId = new Map();
  for (const doc of documents) {
    if (!nonempty(doc.fileId) || !nonempty(doc.projectId) || !boundedInteger(doc.version, 1, 1000000)) {
      throw new Error('Audited document is missing exact project/file/version identity');
    }
    if (byId.has(doc.fileId)) throw new Error('Duplicate document identity in reference graph: ' + doc.fileId);
    byId.set(doc.fileId, doc);
  }
  const root = byId.get(input.root.fileId);
  if (!root || root.projectId !== input.root.projectId || root.version !== input.root.version) {
    throw new Error('Root audit does not match the exact requested project/file/version baseline');
  }
  const edgeIds = new Set();
  const edges = snapshot.edges.map((edge, edgeIndex) => {
    if (!isObject(edge) || !byId.has(edge.ownerFileId) || !nonempty(edge.sourceFileId) ||
        !nonempty(byId.get(edge.ownerFileId).projectId)) {
      throw new Error('Audited forward edge has incomplete owner/source file identity');
    }
    const id = edgeKey(edge);
    const duplicateId = edgeIds.has(id);
    const resolvedEdgeId = duplicateId || edge.edgeIdentityUnique === false ?
      `${id}:unresolved:${edgeIndex}` : id;
    edgeIds.add(resolvedEdgeId);
    const explicitPin = input.pins.find(pin => pin.edgeId === resolvedEdgeId || pin.edgeId === id);
    if (explicitPin && explicitPin.sourceFileId !== edge.sourceFileId) throw new Error('Pin sourceFileId differs from its audited edge');
    const source = byId.get(edge.sourceFileId);
    const sourceProjectId = edge.sourceProjectId ?? source?.projectId ?? null;
    const projectAllowed = nonempty(sourceProjectId) && input.allowedProjectIds.includes(sourceProjectId);
    const pinVersion = explicitPin?.version;
    const baselineVersion = edge.baselineVersion;
    const resolved = Number.isSafeInteger(baselineVersion) && baselineVersion > 0;
    const latestVersion = edge.latestVersion;
    const latestKnown = Number.isSafeInteger(latestVersion) && latestVersion > 0;
    let targetVersion = null, targetVersionSource = null, status = edge.status ?? 'current';
    if (duplicateId || edge.edgeIdentityUnique === false) status = 'blocked';
    else if (!nonempty(sourceProjectId)) status = 'unresolved';
    else if (!projectAllowed) status = 'blocked';
    else if (status === 'blocked') { /* keep edge identity ambiguity explicit */ }
    else if (!resolved || edge.getterError && edge.versionSource === 'unresolved') status = 'unresolved';
    else if (pinVersion !== undefined) {
      targetVersion = pinVersion; targetVersionSource = 'explicitPin';
      status = pinVersion < baselineVersion || latestKnown && pinVersion > latestVersion ? 'blocked' :
        pinVersion === baselineVersion ? 'pinned' : 'outdated';
    }
    else if (edge.selfReference === true) { targetVersion = baselineVersion; targetVersionSource = 'historicalSelfReference'; status = 'pinned'; }
    else if (input.policy === 'latest') {
      if (!latestKnown) status = 'unresolved';
      else { targetVersion = latestVersion; targetVersionSource = 'planLatest'; status = baselineVersion === latestVersion ? 'current' : 'outdated'; }
    } else {
      targetVersion = baselineVersion; targetVersionSource = 'preservedBaseline';
      status = latestKnown && baselineVersion < latestVersion ? 'pinned' : 'current';
    }
    if (source && sourceProjectId !== source.projectId) throw new Error('Edge source project differs from audited source document');
    if (!source && edge.selfReference !== true && status !== 'pinned' &&
        targetVersion !== null && targetVersion !== baselineVersion) status = 'unresolved';
    return { ...edge, edgeId: resolvedEdgeId, sourceProjectId,
      ownerProjectId: edge.ownerProjectId ?? byId.get(edge.ownerFileId).projectId,
      edgeIdentityUnique: !duplicateId && edge.edgeIdentityUnique !== false,
      explicitPin: pinVersion !== undefined, projectAllowed,
      ...(resolved ? { baselineVersion } : {}), ...(latestKnown ? { latestVersion } : {}),
      targetVersion, targetVersionSource, status,
      sourceAvailable: !!source };
  });
  for (const pin of input.pins) if (!edgeIds.has(pin.edgeId)) throw new Error('Pin does not match a proven reachable forward edge: ' + pin.edgeId);
  for (const edge of edges) if (edge.kind === 'derive') {
    const coverage = explicitBindingCoverage(edge, byId.get(edge.ownerFileId), input.parameterBindings);
    edge.bindingCoverage = coverage;
    edge.bindingValuesMatch = coverage.valuesMatch;
    if (coverage.complete && coverage.valuesMatch === false && !edge.explicitPin && !edge.selfReference &&
        edge.targetVersion !== null && !['blocked', 'unresolved'].includes(edge.status)) {
      edge.bindingValueMismatch = true;
      // A value mismatch without a version advance is not an update request.
      // Repeating Update All on an already-current Derive is not a repair.
      if (edge.baselineVersion === edge.targetVersion) {
        edge.status = 'blocked';
        edge.blockedReason = 'currentVersionBindingMismatch';
      } else edge.status = 'outdated';
    }
  }
  const reachableFromRoot = new Set([input.root.fileId]);
  let reachChanged = true;
  while (reachChanged) {
    reachChanged = false;
    for (const edge of edges) if (!edge.selfReference && reachableFromRoot.has(edge.ownerFileId) &&
        byId.has(edge.sourceFileId) && !reachableFromRoot.has(edge.sourceFileId)) {
      reachableFromRoot.add(edge.sourceFileId); reachChanged = true;
    }
  }
  const rootScope = input.scopeFileId ?? input.root.fileId;
  if (!reachableFromRoot.has(rootScope)) throw new Error('scopeFileId is not proven reachable from the pinned root');
  const selected = new Set([rootScope]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) if (!edge.selfReference && selected.has(edge.ownerFileId) && byId.has(edge.sourceFileId) && !selected.has(edge.sourceFileId)) {
      selected.add(edge.sourceFileId); changed = true;
    }
  }
  const selectedDocs = documents.filter(doc => selected.has(doc.fileId));
  const limitedIds = new Set(selectedDocs.slice(0, input.maxFiles).map(doc => doc.fileId));
  const scopedDocs = selectedDocs.filter(doc => limitedIds.has(doc.fileId));
  const scopedEdges = edges.filter(edge => limitedIds.has(edge.ownerFileId));
  const ordered = dependencyOrder(scopedDocs, scopedEdges);
  for (const cycle of ordered.cycles) {
    const cycleNodes = new Set(cycle);
    for (const doc of scopedDocs) if (cycleNodes.has(doc.fileId)) doc.referenceCycle = true;
    for (const edge of scopedEdges) if (cycleNodes.has(edge.ownerFileId) && cycleNodes.has(edge.sourceFileId)) edge.status = 'blocked';
  }
  const updates = [], blocked = [], skipped = [];
  for (const fileId of ordered.order) {
    const doc = byId.get(fileId);
    const outgoing = scopedEdges.filter(edge => edge.ownerFileId === fileId);
    const unknownEdge = outgoing.some(edge => ['unresolved', 'blocked'].includes(edge.status));
    const health = doc.health ?? doc.history ?? {};
    const incoming = scopedEdges.filter(edge => !edge.selfReference && edge.sourceFileId === fileId);
    const pinnedDependency = fileId !== rootScope && incoming.length > 0 && incoming.every(edge =>
      edge.status === 'pinned' && edge.targetVersion === doc.version) &&
      outgoing.every(edge => ['current', 'pinned'].includes(edge.status) && !edge.bindingValueMismatch);
    const repairRequired = doc.repairRequired === true || health.repairRequired === true ||
      health.healthy !== true || doc.consumedBodiesVerified === false || doc.historySnapshotSupported === false;
    let blocker = null;
    if (!input.allowedProjectIds.includes(doc.projectId)) blocker = 'projectNotAllowed';
    else if (doc.referenceCycle === true) blocker = 'referenceCycle';
    else if (doc.available !== true) blocker = 'documentUnavailable';
    else if (!Number.isSafeInteger(doc.version) || !Number.isSafeInteger(doc.latestVersion)) blocker = 'cloudVersionUnresolved';
    else if (doc.dirty !== false && doc.modified !== false) blocker = 'dirtyOrModifiedStatusUnknown';
    else if (Number.isSafeInteger(doc.latestVersion) && doc.version !== doc.latestVersion && !pinnedDependency) blocker = 'olderRevisionOpen';
    else if (doc.isComplete !== true) blocker = 'cloudIncompleteOrUnknown';
    else if (doc.readOnly !== false) blocker = 'uneditableOrUnknown';
    else if (doc.timelineAtEnd !== true || doc.pendingSnapshot !== false) blocker = 'historyPositionNotReadyOrUnknown';
    else if (repairRequired) blocker = 'repairRequired';
    else if (outgoing.some(edge => edge.blockedReason === 'currentVersionBindingMismatch')) blocker = 'repairRequired';
    else if (unknownEdge) blocker = outgoing.some(edge => edge.status === 'blocked') ? 'edgeConflictOrOutOfScope' : 'unresolvedReferenceVersion';
    const bySourceTargets = new Map();
    for (const edge of outgoing.filter(edge => !edge.selfReference && edge.targetVersion !== null)) {
      if (!bySourceTargets.has(edge.sourceFileId)) bySourceTargets.set(edge.sourceFileId, new Set());
      bySourceTargets.get(edge.sourceFileId).add(edge.targetVersion);
    }
    if ([...bySourceTargets.values()].some(versions => versions.size > 1) && outgoing.some(edge => edge.kind === 'derive')) {
      doc.blocked = true; doc.blockedReason = 'multipleVersionsOfOneDeriveSource';
      blocked.push({ fileId, reason: doc.blockedReason }); continue;
    }
    const stale = outgoing.filter(edge => !edge.selfReference && edge.status !== 'pinned' &&
      edge.targetVersion !== null && (edge.baselineVersion !== edge.targetVersion || edge.bindingValueMismatch === true));
    const blockedDependency = outgoing.some(edge => edge.sourceAvailable && byId.get(edge.sourceFileId)?.blocked === true);
    if (!blocker && blockedDependency) blocker = 'blockedDependency';
    if (blocker) { doc.blocked = true; doc.blockedReason = blocker; blocked.push({ fileId, reason: blocker }); continue; }
    if (!stale.length) { skipped.push({ fileId, reason: 'alreadyAtIntendedTargets' }); continue; }
    const linked = outgoing.filter(edge => edge.kind === 'linked' && edge.status !== 'pinned' && edge.isOccurrenceReference !== false);
    const derives = outgoing.filter(edge => edge.kind === 'derive' && edge.status !== 'pinned');
    const staleDerives = stale.filter(edge => edge.kind === 'derive');
    const incompleteBinding = staleDerives.find(edge => !explicitBindingCoverage(edge, doc, input.parameterBindings).complete);
    if (incompleteBinding) {
      doc.blocked = true; doc.blockedReason = 'explicitParameterBindingsRequired';
      blocked.push({ fileId, edgeId: incompleteBinding.edgeId, reason: doc.blockedReason,
        bindingCoverage: explicitBindingCoverage(incompleteBinding, doc, input.parameterBindings) });
      continue;
    }
    const unknownKinds = outgoing.filter(edge => !['linked', 'derive'].includes(edge.kind));
    if (unknownKinds.length) { doc.blocked = true; doc.blockedReason = 'unsupportedReferenceKind'; blocked.push({ fileId, reason: 'unsupportedReferenceKind' }); continue; }
    const conflictingPins = outgoing.some(edge => edge.explicitPin || edge.status === 'pinned');
    const massUpdateSafe = !conflictingPins && !outgoing.some(edge => edge.selfReference) && outgoing.every(edge =>
      edge.projectAllowed && edge.targetVersion === edge.latestVersion);
    if (derives.length && linked.length) {
      if (!massUpdateSafe) { doc.blocked = true; doc.blockedReason = 'mixedParentCouldAdvancePinnedOrOutOfScopeEdge'; blocked.push({ fileId, reason: doc.blockedReason }); continue; }
      const method = input.nativeFallback === 'qualifiedOnce' ? 'UpdateAllLatestCmd' : 'document.updateAllReferences';
      updates.push({ fileId, method, fallback: null,
        reason: 'mixedOwnedDeriveAndLinkedReferences', edgeIds: stale.map(edge => edge.edgeId) });
    } else if (derives.length) {
      if (!massUpdateSafe) { doc.blocked = true; doc.blockedReason = 'deriveUpdateCouldAdvancePinnedOrOutOfScopeEdge'; blocked.push({ fileId, reason: doc.blockedReason }); continue; }
      updates.push({ fileId, method: 'document.updateAllReferences', fallback: null,
        reason: 'ownedDeriveReferences', edgeIds: stale.map(edge => edge.edgeId) });
    } else {
      updates.push({ fileId, method: 'DocumentReference.getLatestVersion', fallback: null,
        reason: 'edgeScopedLinkedReferences', edgeIds: stale.map(edge => edge.edgeId) });
    }
  }
  const truncatedFiles = selectedDocs.filter(doc => !limitedIds.has(doc.fileId)).map(doc => doc.fileId);
  const limitedUpdates = updates.slice(0, input.maxUpdates);
  const updateLimited = updates.length > limitedUpdates.length;
  const notPlanned = [...truncatedFiles, ...(updateLimited ? updates.slice(limitedUpdates.length).map(row => row.fileId) : [])];
  const updateById = new Map(limitedUpdates.map(update => [update.fileId, update]));
  const blockedById = new Map(blocked.map(row => [row.fileId, row]));
  const skippedById = new Map(skipped.map(row => [row.fileId, row]));
  const plannedDocuments = scopedDocs.map(doc => ({ ...doc,
    baselineVersion: doc.version, resultingVersion: null,
    identityBefore: { projectId: doc.projectId, fileId: doc.fileId, version: doc.version,
      creationId: doc.creationId ?? null }, identityAfter: null,
    method: updateById.get(doc.fileId)?.method ?? null,
    status: blockedById.has(doc.fileId) ? 'blocked' : skippedById.has(doc.fileId) ? 'up_to_date' :
      updateById.has(doc.fileId) ? 'planned' : 'notProcessed',
    saveStatus: 'notStarted', coldVerified: null, commandReceipt: null }));
  return { schemaVersion: 1, root: { ...input.root }, scopeFileId: rootScope,
    policy: input.policy, lifecycle: input.lifecycle, nativeFallback: input.nativeFallback,
    durability: input.durability, requestId: input.requestId,
    options: { pins: clone(input.pins), allowedProjectIds: [...input.allowedProjectIds],
      parameterBindings: clone(input.parameterBindings), callerNamespaces: clone(input.callerNamespaces),
      maxFiles: input.maxFiles, maxUpdates: input.maxUpdates, timeBudgetMs: input.timeBudgetMs },
    documents: plannedDocuments, edges: scopedEdges,
    order: ordered.order, cycles: ordered.cycles, updates: limitedUpdates, blocked, skipped,
    notPlanned, limits: { maxFiles: input.maxFiles, maxUpdates: input.maxUpdates,
      totalReachableFiles: selectedDocs.length, plannedFiles: scopedDocs.length,
      requestedUpdates: updates.length, plannedUpdates: limitedUpdates.length },
    graphComplete: snapshot.graphComplete === true && scopedDocs.every(doc => doc.available !== false) && !truncatedFiles.length,
    allIntendedReferencesCurrent: scopedEdges.some(edge => edge.status === 'unresolved' ||
      edge.kind === 'derive' && (edge.bindingCoverage?.valuesMatch === null || edge.bindingReadError)) ? null :
      updates.length || blocked.length || scopedEdges.some(edge => edge.status === 'outdated') ? false : true,
    allReferencesLatest: scopedEdges.some(edge => edge.status === 'unresolved' || !Number.isSafeInteger(edge.latestVersion)) ? null :
      scopedEdges.every(edge => edge.selfReference || edge.baselineVersion === edge.latestVersion),
    getterErrors: snapshot.getterErrors ?? [], lifecycleEffects: snapshot.lifecycleEffects ?? [],
    coverage: snapshot.coverage ?? {},
    environment: snapshot.environment ?? { backend: null, fusionVersion: null, osBuild: null, locale: null, adapterQualification: null } };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function reportStatus(result) {
  const unknown = result.unknown === true || result.invocationStatus === 'unknown';
  if (unknown) return 'unknown';
  if (result.invocationStatus === 'failed' || result.failed?.length) return 'failed';
  if (result.invocationStatus === 'blocked' || result.blocked?.length) return 'blocked';
  return result.invocationStatus ?? 'complete';
}

function bindingEvidenceMatches(edge, currentEdge, baseline, current, bindings) {
  const binding = explicitBindingCoverage(currentEdge, current, bindings);
  if (binding.complete !== edge.bindingCoverage?.complete) return false;
  if (binding.valuesMatch === edge.bindingValuesMatch) return true;
  // sourceDesign can expose either the saved baseline or the newly published
  // source while a stale consumer is cold-opened. Accept only that proved
  // version change, never changed consumer bindings/values or same-version drift.
  const versions = [edge.baselineVersion, edge.targetVersion];
  if (!(versions[1] > versions[0]) || edge.sourceParameterVersion === currentEdge.sourceParameterVersion ||
      !versions.includes(edge.sourceParameterVersion) || !versions.includes(currentEdge.sourceParameterVersion) ||
      edge.sourceParameterFileId !== edge.sourceFileId || currentEdge.sourceParameterFileId !== edge.sourceFileId ||
      edge.sourceDocumentModified !== false || currentEdge.sourceDocumentModified !== false) return false;
  const rows = values => (values ?? []).map(row => ({ name: row.name, expression: row.expression,
    internal_value: row.internal_value, internal_unit: row.internal_unit, dependsOn: row.dependsOn ?? [] }))
    .sort((a,b) => a.name.localeCompare(b.name));
  const aliases = new Set(bindings.filter(row => row.edgeId === edge.edgeId).map(row => row.consumerAlias).filter(Boolean));
  const schema = values => rows(values).map(({name,internal_unit}) => ({name,internal_unit}));
  return hash(rows(edge.derivedParameters)) === hash(rows(currentEdge.derivedParameters)) &&
    hash(rows((baseline.parameters ?? []).filter(row => aliases.has(row.name)))) ===
      hash(rows((current.parameters ?? []).filter(row => aliases.has(row.name)))) &&
    hash(schema(edge.sourceParameters)) === hash(schema(currentEdge.sourceParameters));
}

function staleBeforeStep(plan, freshSnapshot, fileId, effectiveTargets = {}) {
  const baseline = plan.documents.find(doc => doc.fileId === fileId);
  const current = freshSnapshot.documents?.find(doc => doc.fileId === fileId) ??
    (freshSnapshot.document?.fileId === fileId ? freshSnapshot.document : null);
  if (!baseline || !current) return { reason: 'documentUnavailable',
    preflight: { status: freshSnapshot?.status ?? null, reason: freshSnapshot?.reason ?? null,
      error: freshSnapshot?.error ?? null, identity: freshSnapshot?.identity ?? null } };
  const currentHealth = current.health ?? current.history ?? {};
  for (const key of ['projectId', 'fileId', 'version']) if (baseline[key] !== current[key]) return 'identityOrVersionDrift';
  if (Number.isSafeInteger(baseline.latestVersion) && Number.isSafeInteger(current.latestVersion) &&
      baseline.latestVersion !== current.latestVersion) return 'unrelatedRevisionDrift';
  if (current.modified !== false || current.isComplete !== true || current.readOnly !== false ||
      current.timelineAtEnd !== true || current.pendingSnapshot !== false || currentHealth.healthy !== true) return 'documentPreconditionChanged';
  const plannedEdges = plan.edges.filter(edge => edge.ownerFileId === fileId);
  const currentEdges = new Map((freshSnapshot.edges ?? []).filter(edge => edge.ownerFileId === fileId).map(edge => [edge.edgeId, edge]));
  for (const edge of plannedEdges) {
    const now = currentEdges.get(edge.edgeId);
    if (!now || now.sourceFileId !== edge.sourceFileId || now.kind !== edge.kind) return {
      reason: 'edgeSetDrift', expectedEdgeId: edge.edgeId,
      observedEdges: [...currentEdges.values()].map(row => ({ edgeId: row.edgeId, kind: row.kind, sourceFileId: row.sourceFileId })) };
    if (edge.kind === 'derive') {
      if (!bindingEvidenceMatches(edge, now, baseline, current, plan.options?.parameterBindings ?? [])) {
        return 'derivedBindingEvidenceDrift';
      }
    }
    const expected = effectiveTargets[edge.edgeId] ?? edge.targetVersion;
    if (now.baselineVersion !== edge.baselineVersion && now.baselineVersion !== expected) return 'edgeVersionDrift';
    const latestNow = now.latestVersion ?? now.sourceLatestVersion;
    const targetNow = effectiveTargets[edge.edgeId];
    if (latestNow !== undefined && edge.latestVersion !== undefined &&
        latestNow !== (targetNow ?? edge.latestVersion)) return 'unrelatedSourceVersionDrift';
  }
  return null;
}

function planFreshness(plan, snapshot) {
  const blockers = [];
  if (!isObject(snapshot) || !Array.isArray(snapshot.documents) || !Array.isArray(snapshot.edges)) {
    blockers.push({ reason: 'auditGraphUnavailable' });
    return blockers;
  }
  const root = snapshot.documents?.find(doc => doc.fileId === plan.root.fileId);
  if (!root || root.projectId !== plan.root.projectId || root.version !== plan.root.version) {
    blockers.push({ fileId: plan.root.fileId, reason: 'rootIdentityOrVersionDrift' });
    return blockers;
  }
  for (const update of plan.updates) {
    const baseline = plan.documents.find(doc => doc.fileId === update.fileId);
    const current = snapshot.documents?.find(doc => doc.fileId === update.fileId);
    if (!baseline || !current) { blockers.push({ fileId: update.fileId, reason: 'documentUnavailable' }); continue; }
    const currentHealth = current.health ?? current.history ?? {};
    for (const key of ['projectId', 'fileId', 'version', 'latestVersion']) {
      if (baseline[key] !== current[key]) blockers.push({ fileId: update.fileId, reason: 'documentVersionDrift', field: key,
        expected: baseline[key], actual: current[key] });
    }
    if (current.modified !== false || current.readOnly !== false || current.isComplete !== true ||
        current.timelineAtEnd !== true || current.pendingSnapshot === true || currentHealth.healthy !== true) {
      blockers.push({ fileId: update.fileId, reason: currentHealth.repairRequired ? 'repairRequired' : 'documentPreconditionChanged' });
    }
    const plannedEdges = plan.edges.filter(edge => edge.ownerFileId === update.fileId);
    const currentEdges = snapshot.edges?.filter(edge => edge.ownerFileId === update.fileId) ?? [];
    if (plannedEdges.length !== currentEdges.length) blockers.push({ fileId: update.fileId, reason: 'forwardEdgeSetDrift' });
    const observedById = new Map(currentEdges.map(edge => [edge.edgeId, edge]));
    for (const edge of plannedEdges) {
      const now = observedById.get(edge.edgeId);
      if (!now || now.sourceFileId !== edge.sourceFileId || now.kind !== edge.kind ||
          now.baselineVersion !== edge.baselineVersion || now.latestVersion !== edge.latestVersion) {
        blockers.push({ fileId: update.fileId, edgeId: edge.edgeId, reason: 'forwardEdgeVersionDrift' });
        continue;
      }
      if (edge.kind === 'derive') {
        if (!bindingEvidenceMatches(edge, now, baseline, current, plan.options?.parameterBindings ?? [])) {
          blockers.push({ fileId: update.fileId, edgeId: edge.edgeId, reason: 'derivedBindingEvidenceDrift' });
        }
      }
    }
  }
  return blockers;
}

async function inspect(client, input, deps) {
  return require('./dist/core/application/documents/references').inspectReferences(input, readServices(deps));
}

async function finishReadPhase(input, result, deps) {
  return require('./dist/core/application/documents/references').finishReferenceRead(input, result, readServices(deps));
}
function readServices(deps) {
  return {
    journal: input => loadJournal(path.resolve(input.reportPath), input.requestId, deps.fs ?? fs),
    readPlan: input => readPlan(path.resolve(input.reportPath), input.planId, deps.fs ?? fs),
    acquire: (input, requestHash, result) => acquireRead(input, requestHash, result, deps.backend, deps.fs),
  };
}

async function apply(client, input, plan, deps) {
  const { applyReferences } = require('./dist/core/application/documents/references-apply');
  return applyReferences(input, plan, {
    backend: client?.capabilities?.backend ?? null,
    initialBlockers: deps.initialBlockers, initialSnapshot: deps.initialSnapshot,
    journal: request => loadJournal(path.resolve(request.reportPath), request.requestId, deps.fs ?? fs),
    acquire: (request, immutablePlan, requestHash) => acquire(request, immutablePlan, requestHash, client?.capabilities?.backend, deps.fs),
    step: (...args) => deps.step(...args), stale: staleBeforeStep,
    inspectUi: typeof deps.inspectUi === 'function' ? (data, context) => deps.inspectUi(client, data, context) : undefined,
    armWatcher: async data => {
      const watcher = await deps.armWatcher(client, data);
      return { status: watcher.status, evidence: JSON.parse(JSON.stringify(watcher)),
        complete: () => watcher.complete(), disarm: () => watcher.disarm() };
    }, now: deps.now ?? Date.now,
  });
}

async function execute(client, data, context, deps = {}) {
  const { executeReferences } = require('./dist/core/application/documents/references');
  return executeReferences(data, {
    validate,
    inspect: input => inspect(client, input, deps),
    readPlan: input => readPlan(path.resolve(input.reportPath), input.planId, deps.fs ?? fs),
    journal: input => loadJournal(path.resolve(input.reportPath), input.requestId, deps.fs ?? fs),
    graph: (input, request) => {
      if (!deps.step) throw new Error('references.refresh requires the shipped SDK step adapter');
      return deps.step('graph', input, request, context);
    },
    plan: makePlan, freshness: planFreshness,
    apply: (input, plan, preflight) => apply(client, input, plan, { ...deps, ...preflight }),
    publishPlan: (input, plan) => writePlan(path.resolve(input.reportPath), plan, deps.fs ?? fs),
    finishRead: (input, result) => finishReadPhase(input, result, deps),
  });
}

module.exports = { configure, validate, makePlan, dependencyOrder, staleBeforeStep, planFreshness, writePlan,
  readPlan, loadJournal, apply, execute };
