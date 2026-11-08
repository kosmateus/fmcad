const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ui = require('../src/ui');
const { catalog, validateCad, executeCad } = require('../src/cad');
const { detail } = require('../src/help');

// Host responses below are synthetic Windows fixtures; restore path emulation after each test.
test.beforeEach(t => t.after(require('./fixtures/fake-wsl-platform.cjs')()));

const now = 1800000000000;
const target = { name: 'Scratch', creationId: 'creation-1', fileId: 'file-1' };
const lease = { id: 'lease-1', requestId: 'request-1', operationId: 'operation-1', expiresAt: now + 60000, target };
const context = { doc: target.name, docId: target.creationId, docFileId: target.fileId };
const qualification = { profileId: 'update-all-latest', fusionVersion: 'F1', osBuild: 'Windows-1', locale: 'pl-PL' };

function adapter({ duplicate = false, stale = false, actionStatus = 'actionSubmitted' } = {}) {
  const calls = [];
  const control = (runtimeId, name = 'Uaktualnij wszystko') => ({
    runtimeId: [1, 2, runtimeId], containerKey: 'dialog:1.2', parentPath: ['dialog'],
    automationId: 'QTApplication.Nu::QTMessageBox.standardActions.qt_msgbox_buttonbox.QPushButton',
    name, controlType: 'Button', className: 'QPushButton', enabled: true,
    offscreen: false, invokeAvailable: true, semanticRole: null,
  });
  const snapshot = (isStale = false) => ({ status: 'ready', processStartTicks: 'ticks-1',
    mainWindowHandle: 100, osBuild: 'Windows-1', locale: 'pl-PL', truncated: false,
    windows: [{ handle: 200, className: 'QMessageBox', title: 'Aktualizuj wszystko do najnowszej wersji',
      isModal: true, controls: [
        { ...control(10), automationId: 'QTApplication.Nu::QTMessageBox.titleLabel',
          name: 'Aktualizuj wszystko do najnowszej wersji', controlType: 'Text' },
        { ...control(11), automationId: 'QTApplication.Nu::QTMessageBox.messageLabel',
          name: 'Spowoduje to zaktualizowanie wszystkich komponent', controlType: 'Text' },
        control(isStale ? 99 : 12), ...(duplicate ? [control(13)] : []),
        { ...control(14, 'secret'), isPassword: true },
      ] }], unavailableEvidence: [] });
  const dependencies = {
    stateDir: null,
    now: () => now,
    qualifiedProfiles: { 'update-all-latest': qualification },
    probeSdk: async () => ({ status: 'resolved', backend: 'addin', sessionFingerprint: 'session-1',
      processId: 400, identityPinned: true, identity: { ...target, isActive: true, isSaved: true },
      activeCommand: { id: 'UpdateAllLatestCmd', isNative: true }, fusionVersion: 'F1' }),
    runHost: async (mode, request) => {
      calls.push({ mode, request });
      if (mode === 'respond') return { status: actionStatus,
        actionSubmitted: actionStatus === 'unknown' ? null : true, dialogClosed: true };
      return snapshot(mode === 'inspect' && stale && calls.filter(item => item.mode === 'inspect').length > 1);
    },
  };
  return { calls, dependencies };
}

function request(extra = {}) {
  return { requestId: lease.requestId, lease, target, intent: 'confirmRequestedUpdate', ...extra };
}

function pendingUpdateSnapshot({ modal = true, title = target.name + ' - Autodesk Fusion',
  processStartTicks = 'ticks-1', mainWindowHandle = 100, processId = 400,
  fusionVersion = 'F1', osBuild = 'Windows-1' } = {}) {
  const controls = [];
  if (modal) {
    const profile = ui.profiles['update-all-latest'];
    controls.push({ runtimeId: [1, 1], containerKey: 'dialog:1', parentPath: ['main', 'dialog'],
      automationId: 'QTApplication.Nu::QTMessageBox', name: profile.localized.pl.title,
      controlType: 'Window', className: 'Nu::QTMessageBox', enabled: true, offscreen: false,
      invokeAvailable: true, isModal: true });
    controls.push({ runtimeId: [1, 2], containerKey: 'dialog:1', parentPath: ['main', 'dialog'],
      automationId: profile.titleAutomationId, name: profile.localized.pl.title,
      controlType: 'Text', className: 'QLabel', enabled: true, offscreen: false,
      invokeAvailable: true, isModal: false });
    controls.push({ runtimeId: [1, 3], containerKey: 'dialog:1', parentPath: ['main', 'dialog'],
      automationId: profile.messageAutomationId, name: 'Spowoduje to zaktualizowanie wszystkich komponentów',
      controlType: 'Text', className: 'QLabel', enabled: true, offscreen: false,
      invokeAvailable: true, isModal: false });
    controls.push({ runtimeId: [1, 4], containerKey: 'dialog:1', parentPath: ['main', 'dialog'],
      automationId: profile.buttonAutomationId, name: 'Uaktualnij wszystko', controlType: 'Button',
      className: 'QPushButton', enabled: true, offscreen: false, invokeAvailable: true, isModal: false });
    controls.push({ runtimeId: [1, 5], containerKey: 'dialog:1', parentPath: ['main', 'dialog'],
      automationId: profile.buttonAutomationId, name: 'Anuluj', controlType: 'Button',
      className: 'QPushButton', enabled: true, offscreen: false, invokeAvailable: true, isModal: false });
  }
  return { status: 'ready', processId, processStartTicks, mainWindowHandle,
    fusionVersion, osBuild, locale: 'pl-PL', truncated: false,
    unavailableEvidence: [], windows: [{ handle: mainWindowHandle, className: 'Nu::QTMainWindow',
      title, isMain: true, isModal: false, ownerHandle: 0, rootContainerKey: `root:${mainWindowHandle}`,
      controls }] };
}

async function pendingContinuationFixture(t, { snapshots, oldActionSubmitted = null, actionResult } = {}) {
  const stateDir = await scratch(t);
  const baseNow = now;
  let clock = baseNow - 120000;
  let inspectIndex = 0, probeCalls = 0, responseCalls = 0;
  const oldLease = { id: 'old-request-lease', requestId: 'pending-request',
    operationId: 'pending-operation', expiresAt: baseNow - 60000,
    target: { ...target } };
  const qualification = { profileId: 'update-all-latest', fusionVersion: 'F1',
    osBuild: 'Windows-1', locale: 'pl-PL' };
  const dependencies = {
    stateDir,
    now: () => clock,
    qualifiedProfiles: { 'update-all-latest': qualification },
    probeSdk: async () => { probeCalls++; return { status: 'resolved', backend: 'addin',
      sessionFingerprint: 'session-1', processId: 400, identityPinned: true,
      identity: { ...target, isActive: true, isSaved: true },
      activeCommand: { id: 'SelectCommand' }, fusionVersion: 'F1' }; },
    armHostWatcher: async () => ({ completion: Promise.resolve({ status: 'unknown',
      actionSubmitted: oldActionSubmitted, operationOutcome: 'notEvaluated' }),
      stop: async () => ({ status: 'stopped' }) }),
    runHost: async (mode, requestData) => {
      if (mode === 'inspect') {
        const snapshot = snapshots?.[inspectIndex] ?? pendingUpdateSnapshot({ modal: inspectIndex === 1,
          processId: 400, fusionVersion: 'F1', osBuild: 'Windows-1' });
        inspectIndex++;
        return snapshot;
      }
      if (mode === 'watch-status') return { status: 'terminal', watcherState: 'finished',
        hostProcessStatus: 'notRunning', watcherResult: { status: 'unknown',
          actionSubmitted: oldActionSubmitted, operationOutcome: 'notEvaluated' } };
      if (mode === 'respond') {
        responseCalls++;
        assert.equal(requestData.requestId, 'pending-request');
        assert.equal(requestData.intent, 'confirmRequestedUpdate');
        assert.equal(requestData.action, 'confirm');
        assert.equal(requestData.expectedIdentity.fileId, target.fileId);
        assert.equal(requestData.profile.profileId, 'update-all-latest');
        assert.equal(requestData.control.name, 'Uaktualnij wszystko');
        assert.notEqual(requestData.lease.id, oldLease.id);
        assert.equal(requestData.lease.operationId, oldLease.operationId);
        return actionResult ?? { status: 'actionSubmitted', actionSubmitted: true,
          dialogClosed: false, operationOutcome: 'notEvaluated', unavailableEvidence: [] };
      }
      throw new Error('Unexpected watcher continuation host mode: ' + mode);
    },
  };
  const originalWatcher = await ui.armWatcher(null, { requestId: oldLease.requestId, lease: oldLease,
    expectedIdentity: target, intent: 'confirmRequestedUpdate', profileId: 'update-all-latest',
    timeBudgetMs: 5000 }, dependencies);
  assert.equal(originalWatcher.status, 'armed');
  await originalWatcher.completion;
  await originalWatcher.disarm();
  clock = baseNow;
  const continuation = { requestId: oldLease.requestId, operationId: oldLease.operationId,
    originalLeaseBinding: { requestId: oldLease.requestId, operationId: oldLease.operationId,
      idHash: crypto.createHash('sha256').update(oldLease.id).digest('hex'), target: { ...target } },
    expectedIdentity: { ...target }, intent: 'confirmRequestedUpdate',
    profileId: 'update-all-latest', nativeCommandId: 'UpdateAllLatestCmd',
    projectId: 'test-project', root: { projectId: 'test-project', fileId: target.fileId, version: 1 },
    originalLeaseExpiresAt: oldLease.expiresAt, renewalAuthorized: true, timeBudgetMs: 8000 };
  return { stateDir, dependencies, oldLease, continuation,
    get probeCalls() { return probeCalls; }, get responseCalls() { return responseCalls; } };
}

test('SDK identity probe resolves the unique active copy and safely reports duplicate contexts', () => {
  const active = { ...target, isSaved: true, isModified: true, isActive: true };
  const referenced = { ...target, isSaved: true, isModified: false, isActive: false };
  const probe = { documents: [active, referenced], processId: 400,
    activeCommand: { id: 'SelectCommand' }, fusionVersion: 'F1', unavailableEvidence: [] };
  const resolved = ui.resolveProbeDocuments(probe, target);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.identity, active);
  assert.equal(resolved.identityPinned, true);
  assert.deepEqual(resolved.candidates, [active]);

  const ambiguous = ui.resolveProbeDocuments({ ...probe, documents: [active,
    { ...referenced, isActive: true }] }, target);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.identity, undefined);
  assert.equal(ambiguous.candidates.length, 2);
  assert.equal(ambiguous.candidates.every(candidate => candidate.fileId === target.fileId), true);
});

async function scratch(t) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcad-ui-test-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

test('UI descriptors route as node-only operations and reject malformed lease or selector inputs', () => {
  for (const operation of ui.operations) {
    assert.equal(catalog[operation].nodeOnly, true);
  }
  assert.equal(validateCad('ui.inspect', request()), catalog['ui.inspect']);
});

test('UI input validation binds the lease and limits observation and resolver budgets', () => {
  assert.throws(() => ui.validate('ui.inspect', { ...request(), lease: { ...lease, requestId: 'other' } }), /lease/);
  assert.throws(() => ui.validate('ui.inspect', { ...request(), maxControls: 513 }), /maxControls/);
  assert.throws(() => ui.validate('ui.resolve', { ...request(), maxActions: 11 }), /maxActions/);
  assert.throws(() => ui.validate('ui.respond', { ...request(), action: 'cancel', observationId: '00000000-0000-4000-8000-000000000000', profileId: 'update-all-latest' }), /contradicts/);
});

test('qualified invariant semantic action remains stable across label languages; unsafe IDs fail closed', () => {
  const probe = { activeCommand: { id: 'UpdateAllLatestCmd' }, fusionVersion: 'F1',
    identity: { isSaved: true, fileId: 'file-1' } };
  const results = [];
  for (const [locale, title, message, button] of [
    ['en-US', 'Update all to latest', 'All components will be updated', 'Update all'],
    ['pl-PL', 'Aktualizuj wszystko do najnowszej wersji', 'Spowoduje to zaktualizowanie wszystkich komponent', 'Uaktualnij wszystko'],
    ['x-private', 'mise à jour', 'mise à jour des composants', 'tout mettre à jour'],
  ]) {
    const controls = [
      { automationId: 'QTApplication.Nu::QTMessageBox.titleLabel', controlType: 'Text', name: title, containerRef: 'dialog', enabled: true },
      { automationId: 'QTApplication.Nu::QTMessageBox.messageLabel', controlType: 'Text', name: message, containerRef: 'dialog', enabled: true },
      { automationId: 'QTApplication.Nu::QTMessageBox.standardActions.qt_msgbox_buttonbox.QPushButton', controlType: 'Button', name: button,
        semanticRole: 'confirm', invokeAvailable: true, enabled: true, offscreen: false, containerRef: 'dialog', controlRef: 'button-' + locale },
    ];
    const snapshot = { locale, osBuild: 'Windows-1', windows: [{ handle: 200, className: 'QMessageBox', controls }] };
    const qualifiedProfiles = { 'update-all-latest': { ...qualification, locale } };
    const candidates = ui.profileCandidates(snapshot, probe, 'confirmRequestedUpdate', qualifiedProfiles);
    results.push(candidates.filter(candidate => candidate.qualified).map(candidate => candidate.profileId));
  }
  assert.deepEqual(results, [['update-all-latest'], ['update-all-latest'], ['update-all-latest']]);
  const duplicateIds = { locale: 'x-private', osBuild: 'Windows-1', windows: [{ handle: 200, className: 'QMessageBox',
    controls: [
      { automationId: 'QTApplication.Nu::QTMessageBox.titleLabel', controlType: 'Text', name: 'title', containerRef: 'dialog' },
      { automationId: 'QTApplication.Nu::QTMessageBox.titleLabel', controlType: 'Text', name: 'duplicate', containerRef: 'dialog' },
      { automationId: 'QTApplication.Nu::QTMessageBox.messageLabel', controlType: 'Text', name: 'message', containerRef: 'dialog' },
      { automationId: 'QTApplication.Nu::QTMessageBox.standardActions.qt_msgbox_buttonbox.QPushButton', controlType: 'Button', name: 'okay',
        semanticRole: 'confirm', invokeAvailable: true, enabled: true, offscreen: false, containerRef: 'dialog' },
    ] }] };
  assert.deepEqual(ui.profileCandidates(duplicateIds, probe, 'confirmRequestedUpdate', { 'update-all-latest': qualification }), []);
});

test('inspection bounds/redacts UI evidence and response consumes its observation once', async t => {
  const stateDir = await scratch(t);
  const { calls, dependencies } = adapter();
  dependencies.stateDir = stateDir;
  const inspected = await ui.execute(null, 'ui.inspect', request(), context, dependencies);
  assert.equal(inspected.status, 'ready');
  assert.equal(inspected.identityVerified, true);
  assert.equal(inspected.operationOutcome, 'notEvaluated');
  assert.ok(inspected.observationId);
  assert.equal(inspected.windows[0].controls.at(-1).name, '[redacted]');
  assert.equal(inspected.profiles[0].qualified, true);
  const payload = { ...request(), action: 'confirm', observationId: inspected.observationId,
    profileId: 'update-all-latest' };
  const first = await ui.execute(null, 'ui.respond', payload, context, dependencies);
  const second = await ui.execute(null, 'ui.respond', payload, context, dependencies);
  assert.equal(first.status, 'actionSubmitted', JSON.stringify({ inspected, first }));
  assert.equal(first.actionSubmitted, true);
  assert.equal(first.operationOutcome, 'notEvaluated');
  assert.equal(second.replayedReceipt, true);
  assert.equal(calls.filter(call => call.mode === 'respond').length, 1);
});

test('inspect uses exact prearmed provenance for host-only modal evidence when SDK identity is unavailable', async t => {
  const stateDir = await scratch(t);
  const { dependencies } = adapter();
  dependencies.stateDir = stateDir;
  dependencies.probeSdk = async () => ({ status: 'resolved', backend: 'addin',
    sessionFingerprint: 'session-1', processId: 400, identityPinned: true,
    identity: { ...target, isActive: true, isSaved: true },
    activeCommand: { id: 'SelectCommand' }, fusionVersion: 'F1' });
  dependencies.runHost = async () => pendingUpdateSnapshot({ title: 'Scratch - Autodesk Fusion' });
  dependencies.armHostWatcher = async () => ({ completion: Promise.resolve({ status: 'unknown',
    actionSubmitted: null, operationOutcome: 'notEvaluated' }), stop: async () => ({ status: 'stopped' }) });
  const watcher = await ui.armWatcher(null, { requestId: lease.requestId, lease,
    expectedIdentity: target, intent: 'confirmRequestedUpdate', profileId: 'update-all-latest',
    timeBudgetMs: 5000 }, dependencies);
  assert.equal(watcher.status, 'armed');
  await watcher.completion;
  await watcher.disarm();

  let hostInspections = 0;
  dependencies.runHost = async (mode, requestData) => {
    assert.equal(mode, 'inspect');
    hostInspections++;
    assert.equal(requestData.processId, 400);
    assert.equal(requestData.expectedProcessStartTicks, 'ticks-1');
    assert.equal(requestData.expectedMainWindowHandle, 100);
    return pendingUpdateSnapshot({ title: 'Scratch - Autodesk Fusion' });
  };
  dependencies.probeSdk = async () => ({ status: 'unknown', unavailableEvidence: ['SDK probe timed out'] });

  const result = await ui.execute(null, 'ui.inspect', request(), context, dependencies);
  assert.equal(result.status, 'partial');
  assert.equal(result.identityVerified, false);
  assert.equal(result.identityEvidence, 'prearmedWatcherBoundHost');
  assert.equal(result.sdkIdentityAvailable, false);
  assert.equal(result.target.creationId, target.creationId);
  assert.equal(result.target.fileId, target.fileId);
  assert.equal(result.process.pid, 400, JSON.stringify(result));
  assert.equal(result.observationId, null, 'host-bound evidence must not mint an SDK-verified action token');
  assert.equal(result.windows.length, 1);
  assert.equal(hostInspections, 1);
});

test('inspect refuses host fallback for absent or mismatched durable watcher provenance', async t => {
  const stateDir = await scratch(t);
  const { dependencies } = adapter();
  dependencies.stateDir = stateDir;
  dependencies.probeSdk = async () => ({ status: 'unknown', unavailableEvidence: ['SDK probe timed out'] });
  let hostInspections = 0;
  dependencies.runHost = async () => { hostInspections++; return pendingUpdateSnapshot(); };

  const missing = await ui.execute(null, 'ui.inspect', request(), context, dependencies);
  assert.equal(missing.identityVerified, false);
  assert.equal(missing.observationId, null);
  assert.equal(hostInspections, 0);

  dependencies.probeSdk = async () => ({ status: 'resolved', backend: 'addin',
    sessionFingerprint: 'session-1', processId: 400, identityPinned: true,
    identity: { ...target, isActive: true, isSaved: true },
    activeCommand: { id: 'SelectCommand' }, fusionVersion: 'F1' });
  dependencies.runHost = async () => pendingUpdateSnapshot({ title: 'Scratch - Autodesk Fusion' });
  dependencies.armHostWatcher = async () => ({ completion: Promise.resolve({ status: 'unknown',
    actionSubmitted: null, operationOutcome: 'notEvaluated' }), stop: async () => ({ status: 'stopped' }) });
  const watcher = await ui.armWatcher(null, { requestId: lease.requestId, lease,
    expectedIdentity: target, intent: 'confirmRequestedUpdate', profileId: 'update-all-latest',
    timeBudgetMs: 5000 }, dependencies);
  assert.equal(watcher.status, 'armed');
  await watcher.completion;
  await watcher.disarm();
  dependencies.probeSdk = async () => ({ status: 'unknown', unavailableEvidence: ['SDK probe timed out'] });

  const otherLease = { ...lease, id: 'different-lease' };
  const mismatch = await ui.execute(null, 'ui.inspect', { ...request(), lease: otherLease }, context, dependencies);
  assert.equal(mismatch.identityVerified, false);
  assert.equal(mismatch.observationId, null);
  assert.equal(hostInspections, 0);
  assert.match(mismatch.unavailableEvidence.join(' '), /binding differs/, JSON.stringify(mismatch));
});

test('inspect rejects stale same-host PID/start/window or target-title evidence', async t => {
  const stateDir = await scratch(t);
  const { dependencies } = adapter();
  dependencies.stateDir = stateDir;
  dependencies.probeSdk = async () => ({ status: 'resolved', backend: 'addin',
    sessionFingerprint: 'session-1', processId: 400, identityPinned: true,
    identity: { ...target, isActive: true, isSaved: true },
    activeCommand: { id: 'SelectCommand' }, fusionVersion: 'F1' });
  dependencies.runHost = async () => pendingUpdateSnapshot({ title: 'Scratch - Autodesk Fusion' });
  dependencies.armHostWatcher = async () => ({ completion: Promise.resolve({ status: 'unknown',
    actionSubmitted: null, operationOutcome: 'notEvaluated' }), stop: async () => ({ status: 'stopped' }) });
  const watcher = await ui.armWatcher(null, { requestId: lease.requestId, lease,
    expectedIdentity: target, intent: 'confirmRequestedUpdate', profileId: 'update-all-latest',
    timeBudgetMs: 5000 }, dependencies);
  await watcher.completion;
  await watcher.disarm();

  dependencies.probeSdk = async () => ({ status: 'unknown', unavailableEvidence: ['SDK probe timed out'] });
  for (const hostSnapshot of [
    { ...pendingUpdateSnapshot({ title: 'Scratch - Autodesk Fusion' }), processStartTicks: 'reused-pid' },
    { ...pendingUpdateSnapshot({ title: 'Scratch - Autodesk Fusion' }), mainWindowHandle: 101 },
    pendingUpdateSnapshot({ title: 'Different document - Autodesk Fusion' }),
  ]) {
    dependencies.runHost = async () => hostSnapshot;
    const result = await ui.execute(null, 'ui.inspect', request(), context, dependencies);
    assert.equal(result.identityVerified, false);
    assert.equal(result.observationId, null);
    assert.notEqual(result.identityEvidence, 'prearmedWatcherBoundHost');
  }
});

test('bounded UI receipt can persist a large but complete 256-control tree', async t => {
  const stateDir = await scratch(t);
  const { dependencies } = adapter();
  dependencies.stateDir = stateDir;
  const base = dependencies.runHost;
  dependencies.runHost = async (mode, requestData) => {
    const snapshot = await base(mode, requestData);
    if (mode === 'inspect') snapshot.windows[0].controls.push(...Array.from({ length: 252 }, (_, index) => ({
      automationId: `label-${index}`, name: 'x'.repeat(700), controlType: 'Text',
      runtimeId: [99, index], containerKey: `other-${index}`,
    })));
    return snapshot;
  };
  const result = await ui.execute(null, 'ui.inspect', request(), context, dependencies);
  assert.equal(result.status, 'ready');
  assert.equal(result.windows[0].controls.length, 256);
  assert.ok(result.observationId);
});

test('ambiguous observed button names, stale controls and unqualified profiles never invoke', async t => {
  const stateDir = await scratch(t);
  for (const scenario of [{ duplicate: true, expected: 'ambiguous' }, { stale: true, expected: 'stale' }]) {
    const { calls, dependencies } = adapter(scenario);
    dependencies.stateDir = stateDir;
    const inspected = await ui.execute(null, 'ui.inspect', request(), context, dependencies);
    const control = inspected.windows[0].controls.find(row => row.name === 'Uaktualnij wszystko');
    const selector = scenario.duplicate
      ? { controlName: control.name, controlType: 'Button', containerRef: control.containerRef }
      : { controlRef: control.controlRef };
    const payload = { ...request(), action: 'confirm', observationId: inspected.observationId,
      selectionMode: 'observedControl', ...selector };
    const result = await ui.execute(null, 'ui.respond', payload, context, dependencies);
    assert.equal(result.status, scenario.expected);
    assert.equal(calls.filter(call => call.mode === 'respond').length, 0);
  }
  const { calls, dependencies } = adapter();
  dependencies.stateDir = stateDir;
  dependencies.qualifiedProfiles = {};
  const inspected = await ui.execute(null, 'ui.inspect', request(), context, dependencies);
  const result = await ui.execute(null, 'ui.respond', { ...request(), action: 'confirm',
    observationId: inspected.observationId, profileId: 'update-all-latest' }, context, dependencies);
  assert.equal(result.status, 'blocked');
  assert.equal(calls.filter(call => call.mode === 'respond').length, 0);
});

test('exact observed Unicode button selection needs no locale profile, but known role contradictions block', async t => {
  const stateDir = await scratch(t);
  const { calls, dependencies } = adapter();
  dependencies.stateDir = stateDir;
  dependencies.qualifiedProfiles = {};
  const host = dependencies.runHost;
  dependencies.runHost = async (mode, requestData) => {
    const result = await host(mode, requestData);
    if (result.windows) {
      result.locale = 'x-private';
      const button = result.windows[0].controls.find(control => control.controlType === 'Button' && !control.isPassword);
      button.name = '确认更新';
      if (dependencies.contradictRole) button.semanticRole = 'cancel';
    }
    return result;
  };
  const inspected = await ui.execute(null, 'ui.inspect', request(), context, dependencies);
  assert.equal(inspected.status, 'partial');
  const observed = inspected.windows[0].controls.find(control => control.name === '确认更新');
  const data = { ...request(), action: 'confirm', observationId: inspected.observationId,
    selectionMode: 'observedControl', controlName: observed.name, controlType: 'Button', containerRef: observed.containerRef };
  const chosen = await ui.execute(null, 'ui.respond', data, context, dependencies);
  assert.equal(chosen.status, 'actionSubmitted');
  assert.equal(chosen.matchingMethod, 'callerSelected');
  assert.equal(calls.filter(call => call.mode === 'respond').length, 1);

  dependencies.contradictRole = true;
  const next = await ui.execute(null, 'ui.inspect', { ...request(), requestId: 'request-2',
    lease: { ...lease, id: 'lease-2', requestId: 'request-2' } }, context, dependencies);
  const otherButton = next.windows[0].controls.find(control => control.name === '确认更新');
  const denied = await ui.execute(null, 'ui.respond', { requestId: 'request-2',
    lease: { ...lease, id: 'lease-2', requestId: 'request-2' }, target, intent: 'confirmRequestedUpdate',
    action: 'confirm', observationId: next.observationId, selectionMode: 'observedControl',
    controlName: otherButton.name, controlType: 'Button', containerRef: otherButton.containerRef }, context, dependencies);
  assert.equal(denied.status, 'blocked');
  assert.equal(calls.filter(call => call.mode === 'respond').length, 1);
});

test('unsupported backend is non-mutating and reports UI assistance unavailable', async () => {
  const result = await ui.execute({ capabilities: { backend: 'http' } }, 'ui.inspect', request(), context,
    { now: () => now });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.observationId, null);
  assert.equal(result.operationOutcome, 'notEvaluated');
});

test('nonmodal command property palette is not misclassified as a blocking dialog', async t => {
  const stateDir = await scratch(t);
  const { dependencies } = adapter();
  dependencies.stateDir = stateDir;
  dependencies.probeSdk = async () => ({ status: 'resolved', backend: 'addin', sessionFingerprint: 'session-1',
    processId: 400, identityPinned: true, identity: { ...target, isActive: true },
    activeCommand: { id: 'SelectCommand', isNative: true }, fusionVersion: 'F1' });
  dependencies.runHost = async () => ({ status: 'ready', processStartTicks: 'ticks-1', mainWindowHandle: 100,
    osBuild: 'Windows-1', locale: 'pl-PL', truncated: false,
    windows: [{ handle: 100, className: 'Nu::QTMainWindow', isMain: true, isModal: false,
      controls: [{ controlType: 'Window', className: 'QTPalette', isModal: false,
        automationId: 'QTCommandDialogContentPanelToolPropertyPanelPalette', name: 'Fusion360' }] }],
    unavailableEvidence: [] });
  const result = await ui.execute(null, 'ui.inspect', request(), context, dependencies);
  assert.equal(result.status, 'nothingToDo');
});

test('session binding is stable across CLI transport sessions but changes with Fusion process identity', async () => {
  const { sdkProbe } = ui;
  const client = { capabilities: { backend: 'addin', implementation: 'AutodeskFusionMCP' },
    server: { url: 'http://127.0.0.1:8765/mcp' }, serverInfo: { name: 'autodesk-fusion-mcp', version: '1.4.0' },
    callTool: async () => ({ failed: false, text: 'FMCAD_UI_PROBE ' + JSON.stringify({ status: 'resolved',
      processId: 22, fusionVersion: '2705.1.25', identity: target }) }),
    _openSession: async () => 'new transport session on each CLI invocation' };
  const first = await sdkProbe(client, target);
  const second = await sdkProbe(client, target);
  assert.equal(first.sessionFingerprint, second.sessionFingerprint);
  client.callTool = async () => ({ failed: false, text: 'FMCAD_UI_PROBE ' + JSON.stringify({ status: 'resolved',
    processId: 23, fusionVersion: '2705.1.25', identity: target }) });
  const replaced = await sdkProbe(client, target);
  assert.notEqual(first.sessionFingerprint, replaced.sessionFingerprint);
});

test('unknown action outcome is recorded and not retried', async t => {
  const stateDir = await scratch(t);
  const { calls, dependencies } = adapter({ actionStatus: 'unknown' });
  dependencies.stateDir = stateDir;
  const inspected = await ui.execute(null, 'ui.inspect', request(), context, dependencies);
  const payload = { ...request(), action: 'confirm', observationId: inspected.observationId,
    profileId: 'update-all-latest' };
  const result = await ui.execute(null, 'ui.respond', payload, context, dependencies);
  const repeated = await ui.execute(null, 'ui.respond', payload, context, dependencies);
  assert.equal(result.status, 'unknown');
  assert.equal(result.actionSubmitted, null);
  assert.equal(repeated.replayedReceipt, true);
  assert.equal(calls.filter(call => call.mode === 'respond').length, 1);
});

test('bounded resolver composes one qualified action and replays its receipt without retry', async t => {
  const stateDir = await scratch(t);
  const { calls, dependencies } = adapter();
  dependencies.stateDir = stateDir;
  let dismissed = false;
  dependencies.probeSdk = async () => ({ status: 'resolved', backend: 'addin', sessionFingerprint: 'session-1',
    processId: 400, identityPinned: true, identity: { ...target, isActive: true, isSaved: true },
    activeCommand: { id: dismissed ? 'SelectCommand' : 'UpdateAllLatestCmd', isNative: true }, fusionVersion: 'F1' });
  const noDialog = { status: 'ready', processStartTicks: 'ticks-1', mainWindowHandle: 100,
    osBuild: 'Windows-1', locale: 'pl-PL', truncated: false,
    windows: [{ handle: 100, className: 'FusionWindow', title: 'Fusion', isMain: true,
      isModal: false, controls: [] }], unavailableEvidence: [] };
  dependencies.runHost = async (mode, requestData) => {
    calls.push({ mode, request: requestData });
    if (mode === 'respond') { dismissed = true; return { status: 'actionSubmitted', actionSubmitted: true, dialogClosed: true }; }
    return dismissed ? noDialog : {
      status: 'ready', processStartTicks: 'ticks-1', mainWindowHandle: 100,
      osBuild: 'Windows-1', locale: 'pl-PL', truncated: false,
      windows: [{ handle: 200, className: 'QMessageBox', title: 'Update', isModal: true,
        controls: [
          { automationId: 'QTApplication.Nu::QTMessageBox.titleLabel', name: 'Aktualizuj wszystko do najnowszej wersji', controlType: 'Text', runtimeId: [1, 2, 10], containerKey: 'dialog:1.2' },
          { automationId: 'QTApplication.Nu::QTMessageBox.messageLabel', name: 'Spowoduje to zaktualizowanie wszystkich komponent', controlType: 'Text', runtimeId: [1, 2, 11], containerKey: 'dialog:1.2' },
          { automationId: 'QTApplication.Nu::QTMessageBox.standardActions.qt_msgbox_buttonbox.QPushButton', name: 'Uaktualnij wszystko', controlType: 'Button', runtimeId: [1, 2, 12], containerKey: 'dialog:1.2', enabled: true, invokeAvailable: true },
        ] }], unavailableEvidence: [] };
  };
  const resolveData = { ...request(), allowedProfiles: ['update-all-latest'], maxActions: 2, timeBudgetMs: 5000 };
  const result = await ui.execute(null, 'ui.resolve', resolveData, context, dependencies);
  const repeated = await ui.execute(null, 'ui.resolve', resolveData, context, dependencies);
  assert.equal(result.resolutionStatus, 'resolved');
  assert.equal(result.operationOutcome, 'notEvaluated');
  assert.equal(result.actions.length, 1);
  assert.equal(repeated.replayedReceipt, true);
  assert.equal(calls.filter(call => call.mode === 'respond').length, 1);
});

test('bounded resolver does not repeat a qualified profile when the same dialog remains', async t => {
  const stateDir = await scratch(t);
  const { calls, dependencies } = adapter();
  dependencies.stateDir = stateDir;
  const result = await ui.execute(null, 'ui.resolve', { ...request(),
    allowedProfiles: ['update-all-latest'], maxActions: 3, timeBudgetMs: 5000 }, context, dependencies);
  assert.equal(result.resolutionStatus, 'partial');
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].profileId, 'update-all-latest');
  assert.equal(calls.filter(call => call.mode === 'respond').length, 1);
});

test('native cancellation requires a qualified exact runtime command ID', async t => {
  const stateDir = await scratch(t);
  const { dependencies } = adapter();
  dependencies.stateDir = stateDir;
  dependencies.probeSdk = async () => ({ status: 'resolved', backend: 'addin', sessionFingerprint: 'session-1',
    processId: 400, identityPinned: true, identity: { ...target, isActive: true },
    activeCommand: { id: 'MoveCommand', isNative: true }, fusionVersion: 'F1' });
  const nativeTarget = { ...target, commandId: 'MoveCommand' };
  const nativeLease = { ...lease, target: nativeTarget };
  const cancelRequest = { requestId: lease.requestId, lease: nativeLease, target: nativeTarget,
    intent: 'cancelUncommittedCommand', expectedCommandId: 'MoveCommand' };
  let calls = 0;
  dependencies.qualifiedProfiles = { 'cancel-move': { profileId: 'cancel-move', fusionVersion: 'F1',
    osBuild: 'Windows-1', locale: 'pl-PL', commandIds: ['MoveCommand'] } };
  dependencies.terminateNative = async (identity, probe, profile) => {
    calls++;
    assert.equal(probe.activeCommand.id, 'MoveCommand');
    assert.equal(profile.nativeCommandId, 'MoveCommand');
    return { status: 'actionSubmitted', actionSubmitted: true, nativeCommandId: 'MoveCommand', modelUnchanged: true };
  };
  const inspected = await ui.execute(null, 'ui.inspect', cancelRequest, context, dependencies);
  assert.equal(inspected.status, 'ready');
  const result = await ui.execute(null, 'ui.respond', { ...cancelRequest, action: 'cancel',
    observationId: inspected.observationId, profileId: 'cancel-move' }, context, dependencies);
  assert.equal(result.status, 'actionSubmitted');
  assert.equal(result.nativeCommandId, 'MoveCommand');
  assert.equal(calls, 1);
  dependencies.qualifiedProfiles = {};
  const unqualified = await ui.execute(null, 'ui.inspect', { ...cancelRequest, requestId: 'request-2',
    lease: { ...nativeLease, id: 'lease-2', requestId: 'request-2' } }, context, dependencies);
  assert.notEqual(unqualified.status, 'ready');
});

test('private watcher is armed only after identity/profile preflight and disarms only its owned helper', async t => {
  const stateDir = await scratch(t);
  const { dependencies } = adapter();
  dependencies.stateDir = stateDir;
  dependencies.probeSdk = async () => ({ status: 'resolved', backend: 'addin', sessionFingerprint: 'session-1',
    processId: 400, identityPinned: true, identity: { ...target, isActive: true, isSaved: true },
    activeCommand: { id: 'SelectCommand' }, fusionVersion: 'F1' });
  const order = [];
  dependencies.runHost = async (mode, requestData) => {
    order.push('inspect');
    assert.equal(requestData.timeBudgetMs, 30000);
    return adapter().dependencies.runHost(mode, requestData);
  };
  let stopped = 0;
  dependencies.armHostWatcher = async requestData => {
    order.push('arm');
    assert.equal(requestData.expectedProcessStartTicks, 'ticks-1');
    assert.equal(requestData.expectedMainWindowHandle, 100);
    return { completion: Promise.resolve({ status: 'completed', dialogSeen: false }),
      stop: async () => { stopped++; return { status: 'stopped' }; } };
  };
  const watcher = await ui.armWatcher(null, { requestId: lease.requestId, lease,
    intent: 'confirmRequestedUpdate', profileId: 'update-all-latest', expectedIdentity: target, timeBudgetMs: 5000 }, dependencies);
  assert.equal(watcher.status, 'armed');
  order.push('execute-native-command');
  assert.deepEqual(order, ['inspect', 'arm', 'execute-native-command']);
  const completion = await watcher.complete();
  assert.equal(completion.status, 'completed');
  assert.equal((await watcher.disarm()).status, 'stopped');
  assert.equal(stopped, 1);
  const callsBeforeStatus = order.length;
  const lifecycleStatus = await ui.watcherStatus({ requestId: lease.requestId, lease,
    expectedIdentity: target, intent: 'confirmRequestedUpdate', profileId: 'update-all-latest' }, dependencies);
  assert.equal(lifecycleStatus.status, 'terminal');
  assert.equal(lifecycleStatus.watcherState, 'finished');
  assert.equal(lifecycleStatus.result.status, 'completed');
  assert.equal(order.length, callsBeforeStatus, 'terminal local receipt must not query the host or Fusion');
  const lifecycleFile = path.join(stateDir, `watcher-${watcher.watcherId}.json`);
  const lifecycleRecord = JSON.parse(await fs.readFile(lifecycleFile, 'utf8'));
  assert.equal(lifecycleRecord.state, 'finished');
  assert.equal(typeof lifecycleRecord.leaseHash, 'string');
  assert.equal(JSON.stringify(lifecycleRecord).includes(lease.id), false, 'lifecycle receipt must not persist raw lease credentials');
  dependencies.qualifiedProfiles = { 'update-all-latest': { ...qualification, locale: 'xx-XX' } };
  const unqualified = await ui.armWatcher(null, { requestId: lease.requestId, lease,
    intent: 'confirmRequestedUpdate', profileId: 'update-all-latest', expectedIdentity: target }, dependencies);
  assert.equal(unqualified.status, 'blocked');
  assert.match(unqualified.unavailableEvidence[0], /expected.*xx-XX.*actual.*pl-PL/);
  const wrongIntent = await ui.armWatcher(null, { requestId: lease.requestId, lease,
    intent: 'dismissKnownInfo', profileId: 'update-all-latest', expectedIdentity: target }, dependencies);
  assert.equal(wrongIntent.status, 'blocked');
  assert.equal(stopped, 1);
});

test('automatic watcher serializes the validated action required by the packaged PowerShell guard', async t => {
  const hostSource = await fs.readFile(path.join(__dirname, '../assets/ui_dialog.ps1'), 'utf8');
  assert.match(hostSource, /\$Request\.action -cne \$expectedAction/);
  assert.match(hostSource, /\$Request\.profile\.action -cne \$Request\.action/);
  for (const [profileId, intent] of [['update-all-latest', 'confirmRequestedUpdate'],
    ['existing-target-save', 'confirmRequestedSave']]) {
    const { dependencies } = adapter();
    dependencies.stateDir = await scratch(t);
    dependencies.qualifiedProfiles = { [profileId]: { ...qualification, profileId } };
    dependencies.probeSdk = async () => ({ status: 'resolved', backend: 'addin', sessionFingerprint: 'session-1',
      processId: 400, identityPinned: true, identity: { ...target, isActive: true, isSaved: true },
      activeCommand: { id: 'SelectCommand' }, fusionVersion: 'F1' });
    let serialized;
    dependencies.armHostWatcher = async payload => {
      // Exercise the cross-language JSON shape, not a mock action-success receipt.
      serialized = JSON.parse(Buffer.from(Buffer.from(JSON.stringify(payload)).toString('base64'), 'base64').toString('utf8'));
      return { completion: Promise.resolve({ status: 'unknown', actionSubmitted: null }) };
    };
    const watcher = await ui.armWatcher(null, { requestId: lease.requestId, lease,
      intent, profileId, expectedIdentity: target }, dependencies);
    assert.equal(watcher.status, 'armed');
    assert.equal(serialized.action, 'confirm');
    assert.equal(serialized.profile.action, serialized.action);
    assert.equal(serialized.profile.intent, serialized.intent);
    assert.equal(serialized.lease.requestId, serialized.requestId);
    assert.equal((await watcher.completion).status, 'unknown');
  }
});

test('private watcher status is exact-request host-only and absence remains operation-unknown', async t => {
  const stateDir = await scratch(t);
  const calls = [];
  const dependencies = { stateDir,
    probeSdk: async () => { throw new Error('watcher status must not probe Fusion SDK'); },
    runHost: async (mode, requestData) => {
      calls.push({ mode, requestData });
      return { status: 'notRunning', actionSubmitted: null, operationOutcome: 'unknown',
        unavailableEvidence: ['No exact watcher process is currently running'] };
    } };
  const query = { requestId: lease.requestId, lease, target, expectedIdentity: target,
    intent: 'confirmRequestedUpdate', profileId: 'update-all-latest' };
  const result = await ui.watcherStatus(query, dependencies);
  assert.equal(result.status, 'notRunning');
  assert.equal(result.operationOutcome, 'unknown');
  assert.equal(result.actionSubmitted, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'watch-status');
  assert.equal(calls[0].requestData.requestId, lease.requestId);
  assert.equal(calls[0].requestData.expectedIdentity.fileId, target.fileId);
  assert.equal(Object.hasOwn(calls[0].requestData, 'lease'), false, 'host process status query must not receive raw lease material');
  assert.equal(calls[0].requestData.leaseBinding.idHash,
    crypto.createHash('sha256').update(lease.id).digest('hex'));

  const redactedQuery = { requestId: lease.requestId, target,
    expectedIdentity: target, intent: 'confirmRequestedUpdate', profileId: 'update-all-latest',
    leaseBinding: { requestId: lease.requestId, operationId: lease.operationId,
      idHash: crypto.createHash('sha256').update(lease.id).digest('hex'), target } };
  const redacted = await ui.watcherStatus(redactedQuery, dependencies);
  assert.equal(redacted.status, 'notRunning');
  assert.equal(calls.length, 2);
  assert.equal(Object.hasOwn(calls[1].requestData, 'lease'), false);
  assert.deepEqual(calls[1].requestData.leaseBinding, redactedQuery.leaseBinding);

  const mismatch = await ui.watcherStatus({ ...query,
    lease: { ...lease, target: { ...target, fileId: 'different-file' } } }, dependencies);
  assert.equal(mismatch.status, 'blocked');
  assert.equal(calls.length, 2, 'mismatched status query must not reach the host process probe');

  dependencies.runHost = async (mode, requestData) => {
    calls.push({ mode, requestData });
    return { status: 'ambiguous', actionSubmitted: null, operationOutcome: 'unknown',
      candidates: [{ processId: 4412 }, { processId: 4413 }] };
  };
  const ambiguous = await ui.watcherStatus(query, dependencies);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.operationOutcome, 'unknown');
  assert.equal(ambiguous.actionSubmitted, null);
  assert.equal(calls.filter(call => call.mode === 'watch-status').length, 3);
});

test('watcher waits for host readiness and refuses an early terminal helper', async t => {
  for (const exitsEarly of [false, true]) {
    const { dependencies } = adapter();
    dependencies.stateDir = await scratch(t);
    dependencies.probeSdk = async () => ({ status: 'resolved', backend: 'addin', sessionFingerprint: 'session-1',
      processId: 400, identityPinned: true, identity: { ...target, isActive: true, isSaved: true },
      activeCommand: { id: 'SelectCommand' }, fusionVersion: 'F1' });
    let acknowledge, finish, spawned;
    const started = new Promise(resolve => { spawned = resolve; });
    dependencies.armHostWatcher = async () => {
      const helper = { ready: new Promise(resolve => { acknowledge = resolve; }),
        completion: new Promise(resolve => { finish = resolve; }) };
      spawned();
      return helper;
    };
    let returned = false;
    const arming = ui.armWatcher(null, { requestId: lease.requestId, lease, intent: 'confirmRequestedUpdate',
      profileId: 'update-all-latest', expectedIdentity: target }, dependencies).then(value => { returned = true; return value; });
    await started;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(returned, false, 'spawn alone is not armed');
    if (exitsEarly) finish({ status: 'blocked', actionSubmitted: false });
    else acknowledge({ requestId: lease.requestId });
    const watcher = await arming;
    assert.equal(watcher.status, exitsEarly ? 'blocked' : 'armed');
    if (!exitsEarly) {
      finish({ status: 'nothingToDo', actionSubmitted: false });
      await watcher.completion;
    }
  }
});

test('watcher status survives parent loss without converting an absent helper into a native terminal result', async t => {
  const stateDir = await scratch(t);
  const { dependencies } = adapter();
  dependencies.stateDir = stateDir;
  dependencies.probeSdk = async () => ({ status: 'resolved', backend: 'addin', sessionFingerprint: 'session-1',
    processId: 400, identityPinned: true, identity: { ...target, isActive: true, isSaved: true },
    activeCommand: { id: 'SelectCommand' }, fusionVersion: 'F1' });
  dependencies.armHostWatcher = async () => ({ completion: new Promise(() => {}),
    stop: async () => ({ status: 'stopped', actionSubmitted: false }) });
  const watchRequest = { requestId: lease.requestId, lease, intent: 'confirmRequestedUpdate',
    profileId: 'update-all-latest', expectedIdentity: target };
  const watcher = await ui.armWatcher(null, watchRequest, dependencies);
  assert.equal(watcher.status, 'armed');
  const lifecyclePath = path.join(stateDir, `watcher-${watcher.watcherId}.json`);
  const record = JSON.parse(await fs.readFile(lifecyclePath, 'utf8'));
  record.state = 'running';
  record.hostProcess = { processId: 4412, startTimeTicks: 'ticks-watcher-1' };
  await fs.writeFile(lifecyclePath, JSON.stringify(record));

  const statusCalls = [];
  let hostStatus = 'running';
  dependencies.runHost = async (mode, requestData) => {
    statusCalls.push({ mode, requestData });
    return { status: hostStatus, actionSubmitted: null, operationOutcome: 'unknown',
      unavailableEvidence: hostStatus === 'notRunning' ? ['watcher process exited without result receipt'] : [] };
  };
  const running = await ui.watcherStatus(watchRequest, dependencies);
  assert.equal(running.status, 'running');
  assert.equal(running.operationOutcome, 'unknown');
  assert.equal(statusCalls[0].mode, 'watch-status');
  assert.equal(statusCalls[0].requestData.lifecycleRecord.hostProcess.processId, 4412);

  hostStatus = 'notRunning';
  const gone = await ui.watcherStatus(watchRequest, dependencies);
  assert.equal(gone.status, 'notRunning');
  assert.equal(gone.actionSubmitted, null);
  assert.equal(gone.operationOutcome, 'unknown');
  assert.match(gone.unavailableEvidence[0], /exited without result/);
  assert.equal(await watcher.disarm().then(result => result.status), 'stopped');
});

test('authorized pending-update continuation uses the prearmed identity without SDK and invokes once', async t => {
  const fixture = await pendingContinuationFixture(t);
  const sdkCallsBefore = fixture.probeCalls;
  const result = await ui.resumePendingWatcher(fixture.continuation, fixture.dependencies);
  assert.equal(result.status, 'actionSubmitted');
  assert.equal(result.actionSubmitted, true);
  assert.equal(result.operationOutcome, 'notEvaluated');
  assert.equal(result.postHostInspection.status, 'ready');
  assert.equal(result.postHostInspection.processId, 400);
  assert.equal(result.postHostInspection.processStartTicks, 'ticks-1');
  assert.equal(result.postHostInspection.updateDialogStillMatched, false);
  assert.equal(fixture.probeCalls, sdkCallsBefore, 'continuation must not probe the blocked Fusion SDK');
  assert.equal(fixture.responseCalls, 1);
});

test('pending-update continuation blocks missing evidence, stale process and prior action without a second Invoke', async t => {
  const previousAction = await pendingContinuationFixture(t, { oldActionSubmitted: true });
  const previousResult = await ui.resumePendingWatcher(previousAction.continuation, previousAction.dependencies);
  assert.equal(previousResult.status, 'blocked');
  assert.equal(previousAction.responseCalls, 0);

  const staleProcess = await pendingContinuationFixture(t, { snapshots: [
    pendingUpdateSnapshot({ modal: false }),
    pendingUpdateSnapshot({ modal: true, processStartTicks: 'reused-pid-start' }),
  ] });
  const staleResult = await ui.resumePendingWatcher(staleProcess.continuation, staleProcess.dependencies);
  assert.equal(staleResult.status, 'blocked');
  assert.equal(staleProcess.responseCalls, 0);

  const denied = await pendingContinuationFixture(t);
  const deniedResult = await ui.resumePendingWatcher({ ...denied.continuation,
    renewalAuthorized: false }, denied.dependencies);
  assert.equal(deniedResult.status, 'blocked');
  assert.equal(denied.responseCalls, 0);
});

test('pending-update continuation claim prevents a repeated UI action if modal remains', async t => {
  const snapshots = [pendingUpdateSnapshot({ modal: false }),
    ...Array.from({ length: 8 }, () => pendingUpdateSnapshot({ modal: true }))];
  const fixture = await pendingContinuationFixture(t, { snapshots,
    actionResult: { status: 'actionSubmitted', actionSubmitted: true,
      dialogClosed: false, operationOutcome: 'notEvaluated', unavailableEvidence: [] } });
  const first = await ui.resumePendingWatcher(fixture.continuation, fixture.dependencies);
  assert.equal(first.status, 'actionSubmitted');
  assert.equal(first.postHostInspection.updateDialogStillMatched, true);
  const second = await ui.resumePendingWatcher(fixture.continuation, fixture.dependencies);
  assert.equal(second.status, 'blocked');
  assert.match(second.unavailableEvidence[0], /already claimed/);
  assert.equal(fixture.responseCalls, 1);
});

test('public ui.resolve recovers one prearmed update with a live renewed lease without SDK or rewriting the original receipt', async t => {
  const fixture = await pendingContinuationFixture(t, { snapshots: [
    pendingUpdateSnapshot({ modal: true }), pendingUpdateSnapshot({ modal: true }),
    pendingUpdateSnapshot({ modal: false }),
  ] });
  const watcherFile = (await fs.readdir(fixture.stateDir)).find(name => /^watcher-[a-f0-9]{64}\.json$/.test(name));
  const watcherPath = path.join(fixture.stateDir, watcherFile);
  const originalReceipt = await fs.readFile(watcherPath, 'utf8');
  const currentLease = { id: 'coordinator-renewed-lease', requestId: fixture.oldLease.requestId,
    operationId: fixture.oldLease.operationId, expiresAt: now + 60000, target: { ...target } };
  const data = { requestId: fixture.oldLease.requestId, lease: currentLease, target: { ...target },
    intent: 'confirmRequestedUpdate', allowedProfiles: ['update-all-latest'], maxActions: 1, timeBudgetMs: 5000 };
  const recoveryContext = { ...context, projectId: 'test-project' };
  const probeCallsBeforeRecovery = fixture.probeCalls;
  const first = await ui.execute(null, 'ui.resolve', data, recoveryContext, fixture.dependencies);
  assert.equal(first.resolutionStatus, 'resolved', JSON.stringify(first));
  assert.equal(first.actions.length, 1);
  assert.equal(first.actions[0].actionSubmitted, true);
  assert.equal(first.operationOutcome, 'notEvaluated');
  assert.equal(fixture.probeCalls, probeCallsBeforeRecovery, 'recovery must not call the blocked SDK');
  assert.equal(fixture.responseCalls, 1);
  assert.equal(await fs.readFile(watcherPath, 'utf8'), originalReceipt, 'the original lifecycle receipt is immutable');

  const replay = await ui.execute(null, 'ui.resolve', data, recoveryContext, fixture.dependencies);
  assert.equal(replay.replayedReceipt, true);
  assert.equal(fixture.responseCalls, 1);
  const secondLease = { ...currentLease, id: 'second-renewed-lease' };
  const duplicate = await ui.execute(null, 'ui.resolve', { ...data, lease: secondLease }, recoveryContext,
    fixture.dependencies);
  assert.equal(duplicate.resolutionStatus, 'blocked');
  assert.equal(fixture.responseCalls, 1, 'a different renewed lease cannot consume the same original confirmation twice');
});

test('public ui.resolve renewed recovery rejects expired lease, wrong operation/target and stale host identity', async t => {
  const scenarios = [
    { name: 'expired renewed lease', mutate: data => ({ ...data, lease: { ...data.lease, expiresAt: now - 1 } }),
      expected: 'blocked' },
    { name: 'wrong operation', mutate: data => ({ ...data, lease: { ...data.lease, operationId: 'wrong-operation' } }),
      expected: 'blocked' },
    { name: 'wrong target', mutate: data => ({ ...data, target: { ...data.target, fileId: 'wrong-file' },
      lease: { ...data.lease, target: { ...data.lease.target, fileId: 'wrong-file' } } }), expected: 'blocked' },
    { name: 'reused process identity', stale: { ...pendingUpdateSnapshot({ modal: true }), processId: 999 },
      expected: 'blocked' },
  ];
  for (const scenario of scenarios) {
    const fixture = await pendingContinuationFixture(t, { snapshots: [
      pendingUpdateSnapshot({ modal: true }), scenario.stale ?? pendingUpdateSnapshot({ modal: true }),
    ] });
    const lease = { id: `renew-${scenario.name.replaceAll(' ', '-')}`, requestId: fixture.oldLease.requestId,
      operationId: fixture.oldLease.operationId, expiresAt: now + 60000, target: { ...target } };
    const base = { requestId: fixture.oldLease.requestId, lease, target: { ...target },
      intent: 'confirmRequestedUpdate', allowedProfiles: ['update-all-latest'], maxActions: 1, timeBudgetMs: 5000 };
    const changed = scenario.mutate ? scenario.mutate(base) : base;
    const result = await ui.execute(null, 'ui.resolve', changed, { ...context,
      docFileId: changed.target.fileId, projectId: 'test-project' }, fixture.dependencies);
    assert.equal(result.resolutionStatus, scenario.expected, `${scenario.name}: ${JSON.stringify(result)}`);
    assert.equal(fixture.responseCalls, 0, `${scenario.name} must not invoke a control`);
  }
});

test('read-only watcher status timeout never stops the queried helper process', () => {
  let kills = 0;
  const detached = [];
  const child = { exitCode: null, kill: () => { kills++; }, unref: () => detached.push('child'),
    stdout: { unref: () => detached.push('stdout') }, stderr: { unref: () => detached.push('stderr') } };
  assert.equal(ui.stopTimedOutHostHelper('watch-status', child), false);
  assert.equal(kills, 0);
  ui.detachTimedOutWatcherStatusHelper(child);
  assert.deepEqual(detached, ['child', 'stdout', 'stderr']);
  assert.equal(ui.stopTimedOutHostHelper('watch', child), true);
  assert.equal(kills, 1);
});

test('catalog validation and preview never make an SDK or host call', async () => {
  const data = request();
  validateCad('ui.inspect', data);
  const result = await executeCad(null, 'ui.inspect', data, { doc: target.name,
    docId: target.creationId, docFileId: target.fileId, preview: true }, {});
  assert.equal(result.state, 'input-validated-only');
  assert.equal(result.mutation, false);
});

test('built-in UI help states capability, identity, selector and action-outcome limits', () => {
  const inspectHelp = detail('ui', 'inspect');
  const respondHelp = detail('ui', 'respond');
  const resolveHelp = detail('ui', 'resolve');
  assert.match(inspectHelp, /activeCommand identity alone is not a modal inspection/);
  assert.match(inspectHelp, /observed Polish profile is not universal/);
  assert.match(respondHelp, /Exact-name selection/);
  assert.match(respondHelp, /not CAD PASS/);
  assert.match(resolveHelp, /partial/);
  assert.match(resolveHelp, /not proof that an underlying SDK operation was cancelled/);
});

test('packaged host adapter stays PID/window bounded, redacts passwords and has no raw-input fallback', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'assets', 'ui_dialog.ps1'), 'utf8');
  assert.match(source, /AutomationElement\]::FromHandle/);
  assert.match(source, /AutomationElement\]::RootElement\.FindAll/);
  assert.match(source, /TreeScope\]::Children/);
  assert.match(source, /ProcessIdProperty/);
  assert.match(source, /IsPassword/);
  assert.match(source, /\[redacted\]/);
  assert.match(source, /GetRuntimeId/);
  assert.match(source, /InvokePattern/);
  assert.match(source, /expectedProcessStartTicks/);
  assert.doesNotMatch(source, /SendKeys|mouse_event|keybd_event|SetForegroundWindow|SetFocus\(/i);
});
