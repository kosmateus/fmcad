const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pythonLiteral } = require('./python');
const { redactDiagnostic } = require('./diagnostics');

const INTENTS = new Set(['confirmRequestedUpdate', 'confirmRequestedSave',
  'cancelUncommittedCommand', 'dismissKnownInfo']);
const ACTION_FOR_INTENT = { confirmRequestedUpdate: 'confirm', confirmRequestedSave: 'confirm',
  cancelUncommittedCommand: 'cancel', dismissKnownInfo: 'dismiss' };
const OBSERVATION_TTL_MS = 30000;
const MAX_HOST_OUTPUT_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 512 * 1024;

// Source-derived candidates are not universal qualifications. The records below
// are exact same-author native qualifications for one build/OS/locale only.
const PROFILES = Object.freeze({
  'update-all-latest': Object.freeze({ intent: 'confirmRequestedUpdate', action: 'confirm',
    commandId: 'UpdateAllLatestCmd',
    titleAutomationId: 'QTApplication.Nu::QTMessageBox.titleLabel',
    messageAutomationId: 'QTApplication.Nu::QTMessageBox.messageLabel',
    buttonAutomationId: 'QTApplication.Nu::QTMessageBox.standardActions.qt_msgbox_buttonbox.QPushButton',
    localized: { pl: { title: 'Aktualizuj wszystko do najnowszej wersji',
      message: 'Spowoduje to zaktualizowanie wszystkich komponent', button: 'Uaktualnij wszystko' } } }),
  'existing-target-save': Object.freeze({ intent: 'confirmRequestedSave', action: 'confirm',
    dialogClass: 'Nu::QTPLM360LabelDescriptionDialog',
    buttonAutomationId: 'QTApplication.Nu::QTPLM360LabelDescriptionDialog.QPushButton',
    localized: { pl: { button: 'OK' } }, existingTargetOnly: true }),
  'known-version-error': Object.freeze({ intent: 'dismissKnownInfo', action: 'dismiss',
    titleAutomationId: 'QTApplication.Nu::QTMessageBox.titleLabel',
    messageAutomationId: 'QTApplication.Nu::QTMessageBox.messageLabel',
    buttonAutomationId: 'QTApplication.Nu::QTMessageBox.standardActions.qt_msgbox_buttonbox.QPushButton',
    localized: { pl: { message: 'innej wersji', button: 'OK' } }, preservesUnderlyingFailure: true }),
});
const NATIVE_CANCEL_PROFILE_IDS = Object.freeze(['cancel-move', 'cancel-offset']);
const QUALIFIED_PROFILES = Object.freeze({
  'update-all-latest': Object.freeze({ profileId: 'update-all-latest', fusionVersion: '2705.1.25',
    osBuild: '10.0.26200.0', locale: 'pl-PL' }),
  'existing-target-save': Object.freeze({ profileId: 'existing-target-save', fusionVersion: '2705.1.25',
    osBuild: '10.0.26200.0', locale: 'pl-PL' }),
  'cancel-move': Object.freeze({ profileId: 'cancel-move', fusionVersion: '2705.1.25',
    osBuild: '10.0.26200.0', locale: 'pl-PL', commandIds: ['FusionMoveCommand'] }),
  'cancel-offset': Object.freeze({ profileId: 'cancel-offset', fusionVersion: '2705.1.25',
    osBuild: '10.0.26200.0', locale: 'pl-PL', commandIds: ['FusionOffsetFacesCommand'] }),
});

const INPUTS = {
  'ui.inspect': ['requestId', 'lease', 'target', 'intent', 'maxControls'],
  'ui.respond': ['requestId', 'lease', 'target', 'intent', 'action', 'observationId', 'selectionMode',
    'profileId', 'controlRef', 'controlName', 'controlType', 'containerRef', 'observedAutomationId', 'expectedCommandId'],
  'ui.resolve': ['requestId', 'lease', 'target', 'intent', 'allowedProfiles', 'maxActions', 'timeBudgetMs', 'expectedCommandId'],
};
const operations = Object.keys(INPUTS);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digestText = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const text = value => typeof value === 'string' ? value.slice(0, 1024) : '';
const uuid = () => crypto.randomUUID();

function validate(operation, data) {
  if (!Object.hasOwn(INPUTS, operation)) return;
  if (!object(data)) throw new Error(`${operation} data must be an object`);
  for (const key of Object.keys(data)) if (!INPUTS[operation].includes(key)) throw new Error(`Unknown ${operation} input: ${key}`);
  if (typeof data.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.requestId)) {
    throw new Error('requestId must contain 1..128 letters, digits, underscores or hyphens');
  }
  if (!object(data.lease) || Object.keys(data.lease).some(key => !['id', 'requestId', 'operationId', 'expiresAt', 'target'].includes(key)) ||
      typeof data.lease.id !== 'string' || !data.lease.id.trim() || data.lease.id.length > 512 ||
      data.lease.requestId !== data.requestId || typeof data.lease.operationId !== 'string' || !data.lease.operationId.trim() ||
      !Number.isSafeInteger(data.lease.expiresAt) || !object(data.lease.target)) {
    throw new Error('lease must bind id, requestId, operationId, expiry and target identity');
  }
  if (!object(data.target) || Object.keys(data.target).some(key => !['name', 'creationId', 'fileId', 'commandId'].includes(key)) ||
      typeof data.target.name !== 'string' || !data.target.name.trim()) {
    throw new Error('target must contain the exact requested document name and optional identity pins');
  }
  for (const field of ['creationId', 'fileId', 'commandId']) {
    if (data.target[field] !== undefined && (typeof data.target[field] !== 'string' || !data.target[field].trim())) {
      throw new Error(`target.${field} must be a nonempty exact value`);
    }
  }
  if (Object.keys(data.lease.target).some(key => !['name', 'creationId', 'fileId', 'commandId'].includes(key)) ||
      data.lease.target.name !== data.target.name ||
      data.lease.target.creationId !== data.target.creationId ||
      data.lease.target.fileId !== data.target.fileId ||
      data.lease.target.commandId !== data.target.commandId) {
    throw new Error('lease target must exactly match the UI request target');
  }
  if (data.intent !== undefined && !INTENTS.has(data.intent)) throw new Error('Unknown UI intent');
  if (operation !== 'ui.inspect' && !INTENTS.has(data.intent)) throw new Error(`${operation} requires an authorized UI intent`);
  if (data.expectedCommandId !== undefined && (typeof data.expectedCommandId !== 'string' || !data.expectedCommandId.trim())) {
    throw new Error('expectedCommandId must be a nonempty exact command ID');
  }
  if (operation === 'ui.inspect' && data.maxControls !== undefined &&
      (!Number.isSafeInteger(data.maxControls) || data.maxControls < 1 || data.maxControls > 512)) {
    throw new Error('maxControls must be an integer in 1..512');
  }
  if (operation === 'ui.respond') {
    if (typeof data.observationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(data.observationId)) throw new Error('observationId must be a UUID');
    if (data.action !== ACTION_FOR_INTENT[data.intent]) throw new Error('action contradicts the authorized intent');
    const mode = data.selectionMode ?? 'profile';
    if (!['profile', 'observedControl'].includes(mode)) throw new Error('selectionMode must be profile or observedControl');
    if (mode === 'profile' && typeof data.profileId !== 'string') throw new Error('profileId is required in profile mode');
    const hasRef = typeof data.controlRef === 'string';
    const hasName = typeof data.controlName === 'string';
    if (mode === 'observedControl') {
      if (hasRef === hasName) throw new Error('observedControl requires exactly one of controlRef or exact controlName');
      if (hasName && (data.controlType !== 'Button' || typeof data.containerRef !== 'string')) {
        throw new Error('controlName selection requires the exact observed Button type and containerRef');
      }
      if (hasRef && ['controlName', 'controlType', 'containerRef'].some(key => Object.hasOwn(data, key))) {
        throw new Error('controlRef and name-selector fields are mutually exclusive');
      }
    } else if (['controlRef', 'controlName', 'controlType', 'containerRef', 'observedAutomationId'].some(key => Object.hasOwn(data, key))) {
      throw new Error('observed-control selectors require selectionMode observedControl');
    }
  }
  if (operation === 'ui.resolve') {
    if (data.allowedProfiles !== undefined && (!Array.isArray(data.allowedProfiles) || data.allowedProfiles.length > 16 ||
        data.allowedProfiles.some(value => typeof value !== 'string' || !value))) throw new Error('allowedProfiles must contain at most 16 profile IDs');
    if (data.maxActions !== undefined && (!Number.isSafeInteger(data.maxActions) || data.maxActions < 1 || data.maxActions > 10)) {
      throw new Error('maxActions must be an integer in 1..10');
    }
    if (data.timeBudgetMs !== undefined && (!Number.isSafeInteger(data.timeBudgetMs) || data.timeBudgetMs < 1 || data.timeBudgetMs > 120000)) {
      throw new Error('timeBudgetMs must be an integer in 1..120000');
    }
  }
}

function leaseIsLive(lease, now = Date.now()) {
  return object(lease) && Number.isSafeInteger(lease.expiresAt) && lease.expiresAt > now &&
    typeof lease.id === 'string' && typeof lease.requestId === 'string' && typeof lease.operationId === 'string';
}

function targetIdentity(data, context) {
  const target = data.target;
  if (target.name !== context.doc) throw new Error('target.name must exactly match --doc');
  const creationId = target.creationId ?? context.docId ?? null;
  const fileId = target.fileId ?? context.docFileId ?? null;
  if (context.docId && creationId !== context.docId) throw new Error('target.creationId conflicts with --doc-id');
  if (context.docFileId && fileId !== context.docFileId) throw new Error('target.fileId conflicts with --doc-file-id');
  const commandId = data.expectedCommandId ?? target.commandId ?? null;
  if (target.commandId && data.expectedCommandId && target.commandId !== data.expectedCommandId) {
    throw new Error('target.commandId conflicts with expectedCommandId');
  }
  return { name: target.name, creationId, fileId, commandId, identityPinned: !!(creationId || fileId) };
}

function buildProbe(identity) {
  const request = { name: identity.name, creationId: identity.creationId, fileId: identity.fileId };
  return `import adsk.core, json, os
_FMCAD_UI_TARGET: dict[str, str | None] = ${pythonLiteral(request)}

def run(_context: str) -> None:
    app = adsk.core.Application.get()
    docs = [app.documents.item(i) for i in range(app.documents.count)]
    rows: list[dict[str, object]] = []
    failures: list[str] = []
    for doc in docs:
        try:
            data_file = doc.dataFile
            rows.append({'name': doc.name, 'creationId': doc.creationId,
                'fileId': data_file.id if data_file else None, 'isSaved': bool(doc.isSaved),
                'isModified': bool(doc.isModified), 'isActive': doc == app.activeDocument})
        except Exception as exc:
            failures.append(type(exc).__name__)
    active: str = app.userInterface.activeCommand
    command: dict[str, object] | None = None
    if active:
        try:
            definition = app.userInterface.commandDefinitions.itemById(active)
            command = {'id': active, 'isNative': bool(definition.isNative) if definition else None,
                       'name': definition.name if definition else None}
        except Exception as exc:
            failures.append('commandDefinition:' + type(exc).__name__)
    if failures:
        status = 'unavailable'
        selected = None
    payload: dict[str, object] = {'documents': rows, 'unavailableEvidence': failures,
               'processId': os.getpid(), 'activeCommand': command,
               'fusionVersion': getattr(app, 'version', None)}
    print('FMCAD_UI_PROBE ' + json.dumps(payload, ensure_ascii=False))
`;
}

function resolveProbeDocuments(probe, identity) {
  const rows = Array.isArray(probe.documents) ? probe.documents.filter(object) : [];
  const failures = Array.isArray(probe.unavailableEvidence) ? probe.unavailableEvidence : [];
  const matches = rows.filter(row => row.name === identity.name &&
    (!identity.creationId || row.creationId === identity.creationId) &&
    (!identity.fileId || row.fileId === identity.fileId));
  const active = matches.filter(row => row.isActive === true);
  let selected = null, candidates = matches, status;
  if (failures.length) status = 'unavailable';
  else if (active.length === 1) { selected = active[0]; candidates = active; status = 'resolved'; }
  else if (active.length > 1 || matches.length > 1) status = 'ambiguous';
  else if (matches.length === 1) { selected = matches[0]; status = 'resolved'; }
  else {
    const byFile = identity.fileId ? rows.filter(row => row.fileId === identity.fileId) : [];
    candidates = byFile.length ? byFile : rows.filter(row => row.name === identity.name);
    status = candidates.length > 1 ? 'ambiguous' : 'unavailable';
  }
  return { status, expected: identity, candidates, unavailableEvidence: failures,
    processId: probe.processId, activeCommand: probe.activeCommand,
    fusionVersion: probe.fusionVersion, ...(selected ? { identity: selected,
      identityPinned: !!(identity.creationId || identity.fileId) } : {}) };
}

function parseMarked(textValue, marker) {
  const line = String(textValue || '').split(/\r?\n/).find(value => value.startsWith(marker));
  if (!line) throw new Error(`Missing ${marker.trim()} response`);
  return JSON.parse(line.slice(marker.length));
}

async function withRpcTimeout(client, timeoutMs, action) {
  const previous = client?.server?.timeoutMs;
  if (client?.server && previous !== undefined) client.server.timeoutMs = Math.min(previous, timeoutMs);
  try { return await action(); }
  finally { if (client?.server && previous !== undefined) client.server.timeoutMs = previous; }
}

async function sdkProbe(client, identity, dependencies = {}) {
  if (dependencies.probeSdk) return dependencies.probeSdk(identity);
  if (!client?.capabilities || client.capabilities.backend !== 'addin') {
    return { status: 'unsupported', unavailableEvidence: ['The Windows UIA bridge is only available through the same-host addin backend.'] };
  }
  try {
    const out = await withRpcTimeout(client, 5000, () => client.callTool({ featureType: 'script',
      object: { script: buildProbe(identity), readOnly: true } }));
    if (out.failed) throw new Error(out.text || 'UI identity probe failed');
    const result = resolveProbeDocuments(parseMarked(out.text, 'FMCAD_UI_PROBE '), identity);
    const endpoint = (() => { try { return new URL(client.server.url).origin; } catch (_) { return null; } })();
    const sessionFingerprint = digest({ backend: 'addin', endpoint,
      server: client.serverInfo ?? { name: client.capabilities.implementation },
      processId: result.processId, fusionVersion: result.fusionVersion });
    return { ...result, backend: 'addin', sessionFingerprint };
  } catch (error) {
    return { status: 'unknown', unavailableEvidence: [redactDiagnostic(error.message, client.server)] };
  }
}

function powershellExecutable(dependencies = {}) {
  if (dependencies.powershellPath) return dependencies.powershellPath;
  if (process.platform === 'win32' || (process.platform === 'linux' && process.env.WSL_DISTRO_NAME)) return 'powershell.exe';
  return null;
}

function windowsPath(value) {
  const platform = require('./dist/config-platform');
  return platform.toWindowsPath(path.resolve(value), platform.detectPlatform());
}

function stopTimedOutHostHelper(mode, child) {
  if (mode === 'watch-status' || child.exitCode !== null) return false;
  child.kill();
  return true;
}

function detachTimedOutWatcherStatusHelper(child) {
  child.unref?.();
  child.stdout?.unref?.();
  child.stderr?.unref?.();
}

function startHostHelper(mode, request, dependencies = {}) {
  if (dependencies.runHost) {
    const completion = Promise.resolve().then(() => dependencies.runHost(mode, request));
    return { completion, stop: async () => completion };
  }
  const executable = powershellExecutable(dependencies);
  if (!executable) return { completion: Promise.resolve({ status: 'unsupported',
    unavailableEvidence: ['No Windows Fusion UIAutomation host is available; no fallback is attempted.'] }), stop: async () => null };
  const script = windowsPath(dependencies.helperPath || path.join(require('./dist/config-platform').resolveRuntimePaths({ anchor: __filename }).assets, 'ui_dialog.ps1'));
  const wire = JSON.stringify(request);
  // Windows CreateProcess limits the entire command line to 32767 characters.
  // Leave room for executable/script paths and fixed switches before spawning.
  if (Buffer.byteLength(wire) > 16 * 1024 || script.length + executable.length > 4096) {
    return { completion: Promise.resolve({ status: 'blocked', actionSubmitted: false,
      operationOutcome: 'notEvaluated', unavailableEvidence: ['UIA request exceeds the bounded Windows argv size.'] }), stop: async () => null };
  }
  const timeout = request.timeBudgetMs ?? 10000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 120000) {
    return { completion: Promise.resolve({ status: 'blocked', actionSubmitted: false,
      unavailableEvidence: ['UIA helper requires a finite positive deadline up to 120000 ms.'] }), stop: async () => null };
  }
  const encoded = Buffer.from(wire, 'utf8').toString('base64');
  let child;
  try {
    child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Mode', mode, '-RequestBase64', encoded], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return { completion: Promise.resolve({ status: 'unsupported', unavailableEvidence: [redactDiagnostic(error.message)] }),
      stop: async () => null };
  }
  let acknowledgeReady;
  const ready = new Promise(resolve => { acknowledgeReady = resolve; });
  const completion = new Promise(resolve => {
    let stdout = '', stderr = '', expired = false, oversized = false, settled = false;
    const limit = MAX_HOST_OUTPUT_BYTES;
    const timer = setTimeout(() => {
      expired = true;
      if (mode === 'watch-status') {
        settled = true;
        detachTimedOutWatcherStatusHelper(child);
        resolve({ status: 'unknown', actionSubmitted: null, operationOutcome: 'unknown',
          unavailableEvidence: ['read-only watcher status host query timed out; no process was stopped'] });
      } else stopTimedOutHostHelper(mode, child);
    }, timeout);
    child.stdout.on('data', chunk => {
      if (settled || oversized) return;
      stdout += chunk.toString('utf8');
      if (mode === 'watch' && stdout.includes('FMCAD_UI_WATCHER_READY ')) {
        try {
          const receipt = parseMarked(stdout, 'FMCAD_UI_WATCHER_READY ');
          if (receipt.requestId === request.requestId && receipt.lifecycleId === request.lifecycleId) acknowledgeReady(receipt);
        } catch (_) { /* Wait for the complete readiness line. */ }
      }
      if (Buffer.byteLength(stdout) > limit) { oversized = true; if (child.exitCode === null) child.kill(); }
    });
    child.stderr.on('data', chunk => {
      if (settled || oversized) return;
      stderr += chunk.toString('utf8');
      if (Buffer.byteLength(stderr) > limit) { oversized = true; if (child.exitCode === null) child.kill(); }
    });
    child.on('error', error => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ status: 'unsupported', unavailableEvidence: [redactDiagnostic(error.message)] });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (expired) { resolve({ status: 'unknown', actionSubmitted: null,
        operationOutcome: 'unknown', unavailableEvidence: ['The owned UIA helper timed out; Fusion was not cancelled and no action replay is attempted.'] }); return; }
      if (oversized) { resolve({ status: 'blocked', unavailableEvidence: ['UIA response exceeded its bounded size.'] }); return; }
      try {
        const result = parseMarked(stdout, mode === 'watch-status' ? 'FMCAD_UI_WATCHER_STATUS ' : 'FMCAD_UI_RESULT ');
        if (code !== 0 && result.status === 'ready') result.status = 'blocked';
        if (stderr.trim()) result.helperDiagnostic = redactDiagnostic(stderr.trim());
        resolve(result);
      } catch (error) {
        resolve({ status: code === 0 ? 'unavailable' : 'blocked',
          unavailableEvidence: [redactDiagnostic(error.message), ...(stderr.trim() ? [redactDiagnostic(stderr.trim())] : [])] });
      }
    });
  });
  return { child, completion, ready, stop: async () => {
    if (child.exitCode === null) child.kill();
    return completion;
  } };
}

function hostUiCall(mode, request, dependencies = {}) {
  return startHostHelper(mode, request, dependencies).completion;
}

async function inspectHostSnapshot(request, dependencies = {}) {
  return decorateSnapshot(await hostUiCall('inspect', request, dependencies));
}

function decorateSnapshot(snapshot) {
  if (!object(snapshot) || !Array.isArray(snapshot.windows)) return { status: 'unavailable', windows: [], truncated: true };
  const truncated = snapshot.truncated === true || snapshot.windows.length > 16 ||
    snapshot.windows.some(window => (window.controls ?? []).length > 256);
  const windows = snapshot.windows.slice(0, 16).map(window => {
    const handle = Number(window.handle ?? 0);
    const rootKey = String(window.rootContainerKey ?? `root:${handle}`);
    const containerRefs = new Map([[rootKey, uuid()]]);
    const controls = (window.controls ?? []).slice(0, 256).map(control => {
      const containerKey = String(control.containerKey ?? rootKey);
      if (!containerRefs.has(containerKey)) containerRefs.set(containerKey, uuid());
      const containerRef = containerRefs.get(containerKey);
      const value = { windowHandle: handle, containerKey,
        runtimeId: Array.isArray(control.runtimeId) ? control.runtimeId.map(String) : [],
        parentPath: Array.isArray(control.parentPath) ? control.parentPath.map(text).slice(0, 12) : [],
        automationId: text(control.automationId), name: control.isPassword ? '[redacted]' : text(control.name),
        controlType: text(control.controlType), className: text(control.className),
        enabled: control.enabled === true, offscreen: control.offscreen === true,
        isPassword: control.isPassword === true, invokeAvailable: control.invokeAvailable === true,
        isModal: control.isModal === true,
        semanticRole: ['confirm', 'cancel', 'dismiss'].includes(control.semanticRole) ? control.semanticRole : null };
      return { ...value, fingerprint: digest(value), containerRef, controlRef: uuid() };
    });
    return { handle, className: text(window.className), title: text(window.title), isMain: window.isMain === true,
      isModal: window.isModal === true, ownerHandle: Number(window.ownerHandle ?? 0),
      containerRef: containerRefs.get(rootKey), containerRefs: [...containerRefs.values()], controls };
  });
  return { ...snapshot, windows, truncated, controlCount: windows.reduce((sum, window) => sum + window.controls.length, 0) };
}

function profileCandidates(snapshot, probe, intent, qualificationRecords = {}) {
  const found = [];
  for (const [profileId, profile] of Object.entries(PROFILES)) {
    if (intent && profile.intent !== intent) continue;
    if (profile.commandId && probe.activeCommand?.id !== profile.commandId) continue;
    for (const window of snapshot.windows ?? []) {
      const grouped = new Map();
      for (const control of window.controls ?? []) {
        const key = control.containerRef ?? window.containerRef;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(control);
      }
      for (const [containerRef, controls] of grouped) {
      const has = (automationId, controlType) => controls.filter(control => control.automationId === automationId &&
        (!controlType || control.controlType === controlType));
      if (profile.titleAutomationId && has(profile.titleAutomationId, 'Text').length !== 1) continue;
      if (profile.messageAutomationId && has(profile.messageAutomationId, 'Text').length !== 1) continue;
      if (profile.dialogClass && !String(window.className).includes(profile.dialogClass) &&
          !controls.some(control => String(control.className).includes(profile.dialogClass) ||
            control.parentPath?.some(part => part.includes(profile.dialogClass)))) continue;
      const buttons = has(profile.buttonAutomationId, 'Button').filter(control =>
        control.enabled && !control.offscreen && control.invokeAvailable);
      const localized = profile.localized?.[(snapshot.locale || '').split('-')[0]];
      if (localized?.title && !has(profile.titleAutomationId, 'Text').some(control => control.name === localized.title)) continue;
      if (localized?.message && !has(profile.messageAutomationId, 'Text').some(control => control.name.includes(localized.message))) continue;
      if (profile.existingTargetOnly && (!probe.identity?.isSaved || !probe.identity?.fileId)) continue;
      const localizedButtons = localized ? buttons.filter(control => control.name === localized.button) : [];
      const invariantButtons = buttons.filter(control => control.semanticRole === profile.action);
      const selected = invariantButtons.length === 1 ? invariantButtons : localizedButtons;
      for (const control of selected) {
        const qualification = qualificationRecords[profileId];
        const qualified = !!qualification && qualification.fusionVersion === probe.fusionVersion &&
          qualification.osBuild === snapshot.osBuild && qualification.locale === snapshot.locale &&
          qualification.profileId === profileId;
        found.push({ profileId, intent: profile.intent, action: profile.action,
          matchingMethod: invariantButtons.length === 1 ? 'invariantIds' : 'localizedProfile',
          languageIndependent: invariantButtons.length === 1, actualLocale: snapshot.locale ?? null,
          qualified, qualification: qualified ? qualification : null,
          windowHandle: window.handle, containerRef, controlRef: control.controlRef,
          controlName: control.name, controlType: control.controlType, automationId: control.automationId,
          fingerprint: control.fingerprint, preservesUnderlyingFailure: profile.preservesUnderlyingFailure === true,
          requiredCommandId: profile.commandId ?? null, nativeCommandId: null });
      }
      }
    }
  }
  // Native cancellation candidates require an explicit qualified runtime command-ID mapping.
  if (intent === 'cancelUncommittedCommand' && probe.activeCommand?.isNative === true) {
    for (const profileId of NATIVE_CANCEL_PROFILE_IDS) {
      const qualification = qualificationRecords[profileId];
      if (!qualification || qualification.fusionVersion !== probe.fusionVersion ||
          qualification.osBuild !== snapshot.osBuild || qualification.locale !== snapshot.locale ||
          !Array.isArray(qualification.commandIds) || !qualification.commandIds.includes(probe.activeCommand.id)) continue;
      found.push({ profileId, intent, action: 'cancel', qualified: true, qualification,
        matchingMethod: 'nativeCommand', languageIndependent: true,
        nativeCommandId: probe.activeCommand.id, commandIds: qualification.commandIds,
        controlRef: null, windowHandle: null });
    }
  }
  return found;
}

function stateDirectory(dependencies = {}) {
  return dependencies.stateDir || process.env.FMCAD_UI_STATE_DIR || path.join(require('./dist/config-platform').resolveRuntimePaths({ anchor: __filename }).state, 'ui');
}

async function ensureStateDirectory(dependencies = {}) {
  const directory = stateDirectory(dependencies);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UI receipt path must be a real owned directory');
  await fs.chmod(directory, 0o700).catch(() => {});
  return directory;
}

async function writeExclusive(file, value) {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw new Error('UI receipt exceeds its bounded size');
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(encoded); await handle.sync(); }
  finally { await handle.close(); }
}

const observationPath = (directory, id) => path.join(directory, `observation-${id}.json`);
const receiptPath = (directory, id) => path.join(directory, `action-${id}.json`);

function watcherLifecycleBinding(request) {
  const leaseBinding = request.leaseBinding ?? { requestId: request.lease.requestId,
    operationId: request.lease.operationId, idHash: digestText(request.lease.id), target: request.lease.target };
  const leaseHash = request.lease ? digest(request.lease) : null;
  const target = { name: request.expectedIdentity.name,
    creationId: request.expectedIdentity.creationId ?? null,
    fileId: request.expectedIdentity.fileId ?? null,
    commandId: request.expectedIdentity.commandId ?? null };
  const lifecycleId = digest([request.requestId, leaseBinding.idHash, target, request.intent, request.profileId]);
  return { lifecycleId, requestId: request.requestId, leaseHash,
    leaseIdHash: leaseBinding.idHash, operationId: leaseBinding.operationId, target,
    intent: request.intent, profileId: request.profileId };
}

function watcherLifecyclePath(directory, lifecycleId) {
  return path.join(directory, `watcher-${lifecycleId}.json`);
}

async function writeWatcherLifecycle(directory, binding, create, patch = {}) {
  const file = watcherLifecyclePath(directory, binding.lifecycleId);
  let current;
  try { current = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (create && current) return { status: 'exists', record: current, file };
  if (!create && !current) return { status: 'missing', file };
  if (current && (current.lifecycleId !== binding.lifecycleId || current.requestId !== binding.requestId ||
      current.leaseHash !== binding.leaseHash || current.leaseIdHash !== binding.leaseIdHash || current.intent !== binding.intent ||
      (current.operationId && current.operationId !== binding.operationId) ||
      current.profileId !== binding.profileId || JSON.stringify(current.target) !== JSON.stringify(binding.target))) {
    return { status: 'identityMismatch', file };
  }
  if (current?.state === 'finished') return { status: 'finished', record: current, file };
  const now = Date.now();
  const next = create ? { schemaVersion: 1, ...binding, state: 'starting', startedAt: now,
    updatedAt: now, fusionProcess: patch.fusionProcess ?? null, hostProcess: null, result: null,
    continuationOf: patch.continuationOf ?? null, renewalAuthorized: patch.renewalAuthorized === true,
    originalLeaseIdHash: patch.originalLeaseIdHash ?? null } :
    { ...current, ...patch, updatedAt: now };
  const transitions = { starting: ['running', 'finished', 'unknown'], running: ['finished', 'unknown'],
    unknown: [], finished: [] };
  if (!create && patch.state && patch.state !== current.state &&
      !transitions[current.state]?.includes(patch.state)) return { status: 'invalidTransition', record: current, file };
  if (!create && current.state === 'finished') return { status: 'finished', record: current, file };
  if (create) {
    await writeExclusive(file, next);
    return { status: 'created', record: next, file };
  }
  const temp = `${file}.${process.pid}.${uuid()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(next)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600).catch(() => {});
  return { status: 'updated', record: next, file };
}

async function saveObservation(record, dependencies = {}) {
  const directory = await ensureStateDirectory(dependencies);
  const observationId = uuid();
  const createdAt = (dependencies.now ?? Date.now)();
  const expiresAt = createdAt + OBSERVATION_TTL_MS;
  await writeExclusive(observationPath(directory, observationId), { ...record, observationId, createdAt, expiresAt });
  return { observationId, expiresAt };
}

async function getObservation(id, dependencies = {}) {
  const directory = await ensureStateDirectory(dependencies);
  const receipt = receiptPath(directory, id);
  try {
    const prior = JSON.parse(await fs.readFile(receipt, 'utf8'));
    return { status: prior.state === 'complete' ? 'used' : 'unknown', directory, result: prior.result };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    const record = JSON.parse(await fs.readFile(observationPath(directory, id), 'utf8'));
    if (record.observationId !== id || (dependencies.now ?? Date.now)() >= record.expiresAt) {
      await fs.unlink(observationPath(directory, id)).catch(() => {});
      return { status: 'expired', directory };
    }
    return { status: 'fresh', directory, record };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', directory };
    throw error;
  }
}

async function claimObservation(id, loaded, requestId) {
  const record = { observationId: id, requestId, state: 'in_progress', claimedAt: Date.now() };
  await writeExclusive(receiptPath(loaded.directory, id), record);
  await fs.unlink(observationPath(loaded.directory, id)).catch(() => {});
  return record;
}

async function finishObservation(id, loaded, claim, result) {
  const final = { ...claim, state: result.status === 'unknown' ? 'unknown' : 'complete', result,
    finishedAt: Date.now() };
  await fs.writeFile(receiptPath(loaded.directory, id), JSON.stringify(final), { mode: 0o600 });
  return final;
}

async function internalInspect(client, data, context, dependencies = {}) {
  const expected = targetIdentity(data, context);
  const probe = await sdkProbe(client, expected, dependencies);
  let boundContext = null;
  let host = { status: 'unsupported', unavailableEvidence: ['UIA adapter has not run'] };
  if (Number.isSafeInteger(probe.processId)) {
    host = await hostUiCall('inspect', { requestId: data.requestId, lease: data.lease,
      expectedIdentity: { name: expected.name, creationId: expected.creationId, fileId: expected.fileId },
      processId: probe.processId, expectedCommandId: expected.commandId,
      timeBudgetMs: Math.min(data.timeBudgetMs ?? 10000, 30000), maxControls: data.maxControls ?? 256 }, dependencies);
  } else if (probe.status !== 'resolved') {
    boundContext = await findPrearmedWatcherContext(stateDirectory(dependencies), data, expected);
    if (boundContext.status === 'resolved') {
      const prior = boundContext.record.fusionProcess;
      host = await hostUiCall('inspect', { requestId: data.requestId, lease: data.lease,
        expectedIdentity: { name: expected.name, creationId: expected.creationId, fileId: expected.fileId },
        processId: prior.processId, expectedProcessStartTicks: prior.processStartTicks,
        expectedMainWindowHandle: prior.mainWindowHandle, timeBudgetMs: 10000,
        maxControls: data.maxControls ?? 256 }, dependencies);
      const mainWindows = (host.windows ?? []).filter(window => window.isMain === true &&
        window.handle === prior.mainWindowHandle && window.title.includes(expected.name));
      if (host.status === 'ready' && host.processId === prior.processId &&
          host.processStartTicks === prior.processStartTicks &&
          host.mainWindowHandle === prior.mainWindowHandle && host.truncated !== true &&
          host.osBuild === prior.osBuild && host.locale === prior.locale &&
          mainWindows.length === 1) {
        boundContext = { ...boundContext, status: 'hostBound', mainWindow: mainWindows[0] };
      } else {
        host = { ...host, status: host.status === 'ready' ? 'identity_mismatch' : host.status,
          unavailableEvidence: [...(host.unavailableEvidence ?? []),
            'fresh host process/start/window does not corroborate the unique prearmed target context'] };
        boundContext = { ...boundContext, status: 'hostMismatch' };
      }
    }
  }
  const snapshot = decorateSnapshot(host);
  const identity = probe.identity;
  const verified = probe.status === 'resolved' && probe.identityPinned === true &&
    probe.backend === 'addin' && typeof probe.sessionFingerprint === 'string' &&
    (!expected.creationId || identity?.creationId === expected.creationId) &&
    (!expected.fileId || identity?.fileId === expected.fileId) && identity?.isActive === true &&
    (!expected.commandId || probe.activeCommand?.id === expected.commandId);
  const profileProbe = boundContext?.status === 'hostBound' ? {
    ...probe, identity: { name: expected.name, creationId: expected.creationId, fileId: expected.fileId,
      isSaved: !!expected.fileId }, activeCommand: null,
    fusionVersion: boundContext.record.fusionProcess.fusionVersion,
  } : probe;
  const profiles = profileCandidates(snapshot, profileProbe, data.intent ?? null, dependencies.qualifiedProfiles ?? QUALIFIED_PROFILES);
  const complete = snapshot.status === 'ready' && snapshot.truncated !== true && snapshot.windows.length > 0;
  let token = null;
  if (verified && complete) {
    token = await saveObservation({ requestId: data.requestId, leaseHash: digest(data.lease),
      intent: data.intent ?? null,
      target: { name: identity.name, creationId: identity.creationId, fileId: identity.fileId },
      processId: probe.processId, processStartTicks: snapshot.processStartTicks,
      backend: probe.backend, sessionFingerprint: probe.sessionFingerprint,
      mainWindowHandle: snapshot.mainWindowHandle, activeCommand: probe.activeCommand,
      fusionVersion: probe.fusionVersion, osBuild: snapshot.osBuild, locale: snapshot.locale,
      windows: snapshot.windows, truncated: snapshot.truncated }, dependencies);
  }
  const hostBound = boundContext?.status === 'hostBound';
  const status = hostBound ? 'partial' : probe.status !== 'resolved' ? probe.status : !verified ? 'partial' :
    snapshot.status === 'unsupported' ? 'unsupported' : snapshot.status === 'ambiguous' ? 'ambiguous' :
      profiles.some(profile => profile.qualified) ? 'ready' : profiles.length ? 'partial' :
        snapshot.windows.some(window => window.isModal || window.controls.some(control => control.isModal ||
          (control.controlType === 'Window' && /QMessageBox|QDialog|QTPLM360LabelDescriptionDialog/i.test(control.className)))) ||
        !['', 'SelectCommand', null].includes(probe.activeCommand?.id) ? 'partial' : 'nothingToDo';
  return { success: ['ready', 'partial', 'nothingToDo'].includes(status), operation: 'ui.inspect', status,
    requestId: data.requestId, observationId: token?.observationId ?? null,
    expiresAt: token?.expiresAt ?? null, identityVerified: verified,
    ...(hostBound ? { identityEvidence: 'prearmedWatcherBoundHost', sdkIdentityAvailable: false,
      prearmedWatcherId: boundContext.record.lifecycleId } : {}),
    target: identity ?? (hostBound ? { name: expected.name, creationId: expected.creationId,
      fileId: expected.fileId, commandId: expected.commandId } : { name: expected.name, creationId: null, fileId: null }),
    process: { pid: hostBound ? boundContext.record.fusionProcess.processId : probe.processId ?? null,
      processStartTicks: snapshot.processStartTicks ?? null,
      fusionVersion: hostBound ? boundContext.record.fusionProcess.fusionVersion : probe.fusionVersion ?? null,
      osBuild: snapshot.osBuild ?? null, locale: snapshot.locale ?? null },
    activeCommand: probe.activeCommand ?? null, windows: snapshot.windows ?? [],
    profiles: profiles.map(({ fingerprint, windowHandle, ...profile }) => profile),
    candidateRefs: profiles.filter(profile => !profile.qualified).map(profile => profile.controlRef).filter(Boolean),
    matchingMethods: [...new Set(profiles.map(profile => profile.matchingMethod))], truncated: snapshot.truncated === true,
    unavailableEvidence: [...(probe.unavailableEvidence ?? []), ...(snapshot.unavailableEvidence ?? []),
      ...(boundContext && boundContext.status !== 'hostBound' ? (boundContext.unavailableEvidence ??
        ['prearmed watcher context did not match this request']) : [])],
    operationOutcome: 'notEvaluated' };
}

async function recoverPrearmedConfirmation(client, data, context, expectedIdentity, dependencies = {}) {
  if (data.intent !== 'confirmRequestedUpdate') return null;
  const deny = message => ({ success: false, operation: 'ui.resolve', requestId: data.requestId,
    resolutionStatus: 'blocked', actions: [], remainingUI: [], operationOutcome: 'notEvaluated',
    unavailableEvidence: [message] });
  const directory = stateDirectory(dependencies);
  const recovery = await findRenewableWatcherContext(directory, data, expectedIdentity, data.allowedProfiles);
  if (recovery.status === 'notFound') return null;
  if (recovery.status !== 'resolved') return deny(...(recovery.unavailableEvidence ?? ['prearmed request provenance is unavailable']));
  if (!expectedIdentity.identityPinned || !expectedIdentity.fileId ||
      typeof context.projectId !== 'string' || !context.projectId.trim()) {
    return deny('renewed confirmation requires pinned document identity and the exact --project-id context');
  }
  const original = recovery.record;
  if (original.profileId !== 'update-all-latest' ||
      data.allowedProfiles?.length && (data.allowedProfiles.length !== 1 || data.allowedProfiles[0] !== original.profileId)) {
    return deny('renewed resolution must authorize the exact original update-all-latest profile');
  }
  const qualification = (dependencies.qualifiedProfiles ?? QUALIFIED_PROFILES)[original.profileId];
  if (!qualification || original.fusionProcess.fusionVersion !== qualification.fusionVersion) {
    return deny('original prearmed Fusion build is not qualified for this confirmation profile');
  }
  const originalBinding = { requestId: original.requestId, operationId: original.operationId,
    idHash: original.leaseIdHash, target: original.target };
  const oldStatus = await watcherStatus({ requestId: data.requestId, leaseBinding: originalBinding,
    expectedIdentity, intent: data.intent, profileId: original.profileId, checkHostProcess: true }, dependencies);
  if (oldStatus.status !== 'terminal' || oldStatus.watcherState !== 'finished' ||
      oldStatus.hostProcessStatus !== 'notRunning' || oldStatus.watcherResult?.actionSubmitted === true ||
      original.result?.actionSubmitted === true) {
    return deny('original watcher is not proven finished and absent with no submitted action');
  }

  const previous = original.fusionProcess;
  const snapshot = await inspectHostSnapshot({ requestId: data.requestId, lease: data.lease,
    expectedIdentity, processId: previous.processId,
    expectedProcessStartTicks: previous.processStartTicks,
    expectedMainWindowHandle: previous.mainWindowHandle, timeBudgetMs: 10000, maxControls: data.maxControls ?? 256 }, dependencies);
  if (snapshot.status !== 'ready' || snapshot.truncated || snapshot.processId !== previous.processId ||
      snapshot.processStartTicks !== previous.processStartTicks ||
      snapshot.mainWindowHandle !== previous.mainWindowHandle || snapshot.osBuild !== previous.osBuild ||
      snapshot.locale !== previous.locale || snapshot.osBuild !== qualification.osBuild ||
      snapshot.locale !== qualification.locale) {
    return deny('fresh host process/start/window/build/locale does not match the original prearmed context');
  }
  const mainWindows = snapshot.windows.filter(window => window.isMain && window.handle === previous.mainWindowHandle);
  if (mainWindows.length !== 1 || !mainWindows[0].title.includes(expectedIdentity.name)) {
    return deny('fresh main window does not corroborate the exact prearmed target context');
  }
  const modal = mainWindows[0].controls.some(control => control.isModal ||
    (control.controlType === 'Window' && /QMessageBox|QDialog/i.test(control.className)));
  if (!modal) return deny('the expected native modal is not present in the freshly inspected target window');
  const syntheticProbe = { fusionVersion: previous.fusionVersion,
    activeCommand: { id: PROFILES[original.profileId].commandId },
    identity: { name: expectedIdentity.name, creationId: expectedIdentity.creationId,
      fileId: expectedIdentity.fileId, isSaved: true, isActive: true } };
  const candidates = profileCandidates(snapshot, syntheticProbe, data.intent,
    dependencies.qualifiedProfiles ?? QUALIFIED_PROFILES).filter(profile =>
    profile.profileId === original.profileId && profile.qualified &&
    profile.windowHandle === previous.mainWindowHandle);
  if (candidates.length !== 1) return deny(candidates.length ?
    'fresh native confirmation profile is ambiguous; no action submitted' :
    'fresh native modal does not match the exact qualified prearmed confirmation profile');
  const selected = candidates[0];
  const control = mainWindows[0].controls.find(item => item.controlRef === selected.controlRef &&
    item.containerRef === selected.containerRef && item.controlType === 'Button' &&
    item.enabled && !item.offscreen && item.invokeAvailable);
  if (!control) return deny('fresh qualified confirmation control is no longer eligible');
  const now = (dependencies.now ?? Date.now)();
  if (!leaseIsLive(data.lease, now) || data.lease.operationId !== original.operationId ||
      data.lease.requestId !== original.requestId) return deny('renewed coordinator lease expired or changed before action');
  const claimPath = continuationClaimPath(directory, original.lifecycleId);
  try {
    await writeExclusive(claimPath, { requestId: original.requestId, operationId: original.operationId,
      originalLifecycleId: original.lifecycleId, renewedLeaseHash: digest(data.lease),
      target: original.target, claimedAt: now });
  } catch (error) {
    if (error.code === 'EEXIST') return deny('the original prearmed confirmation already has a one-time recovery claim');
    throw error;
  }
  if (!leaseIsLive(data.lease, (dependencies.now ?? Date.now)())) return deny('renewed coordinator lease expired immediately before action');
  const action = await hostUiCall('respond', { requestId: data.requestId, lease: data.lease,
    expectedIdentity, intent: data.intent, action: 'confirm', processId: previous.processId,
    expectedProcessStartTicks: previous.processStartTicks,
    expectedMainWindowHandle: previous.mainWindowHandle, windowHandle: control.windowHandle,
    control: { windowHandle: control.windowHandle, runtimeId: control.runtimeId,
      parentPath: control.parentPath, containerKey: control.containerKey,
      automationId: control.automationId, name: control.name,
      controlType: control.controlType, className: control.className },
    profile: { profileId: selected.profileId, intent: selected.intent, action: selected.action,
      titleAutomationId: PROFILES[selected.profileId].titleAutomationId,
      messageAutomationId: PROFILES[selected.profileId].messageAutomationId,
      buttonAutomationId: PROFILES[selected.profileId].buttonAutomationId,
      dialogClass: PROFILES[selected.profileId].dialogClass ?? null }, timeBudgetMs: 10000 }, dependencies);
  const post = await inspectHostSnapshot({ requestId: data.requestId, lease: data.lease,
    expectedIdentity, processId: previous.processId,
    expectedProcessStartTicks: previous.processStartTicks,
    expectedMainWindowHandle: previous.mainWindowHandle, timeBudgetMs: 5000, maxControls: data.maxControls ?? 256 }, dependencies);
  const stillMatched = post.status === 'ready' && !post.truncated && profileCandidates(post, syntheticProbe,
    data.intent, dependencies.qualifiedProfiles ?? QUALIFIED_PROFILES).some(profile =>
    profile.profileId === original.profileId && profile.qualified);
  const result = { success: action.status === 'actionSubmitted', operation: 'ui.resolve', requestId: data.requestId,
    resolutionStatus: action.status === 'actionSubmitted' && !stillMatched ? 'resolved' :
      action.status === 'unknown' ? 'unknown' : action.status === 'actionSubmitted' ? 'partial' : 'blocked',
    actions: [{ profileId: selected.profileId, status: action.status,
      actionSubmitted: action.actionSubmitted ?? null, dialogClosed: action.dialogClosed ?? null,
      matchingMethod: selected.matchingMethod }], remainingUI: post.windows ?? [],
    operationOutcome: 'notEvaluated', originalLifecycleId: original.lifecycleId,
    hostBoundEvidence: { processId: snapshot.processId, processStartTicks: snapshot.processStartTicks,
      mainWindowHandle: snapshot.mainWindowHandle, osBuild: snapshot.osBuild, locale: snapshot.locale },
    unavailableEvidence: action.unavailableEvidence ?? post.unavailableEvidence ?? [] };
  return result;
}

async function inspect(client, data, context, dependencies = {}) {
  if (!leaseIsLive(data.lease, (dependencies.now ?? Date.now)()) || data.lease.requestId !== data.requestId) {
    return { success: false, operation: 'ui.inspect', status: 'blocked', requestId: data.requestId,
      identityVerified: false, unavailableEvidence: ['coordinator lease is expired or not bound to this requestId'] };
  }
  return internalInspect(client, data, context, dependencies);
}

function exactControl(record, data) {
  const controls = record.windows.flatMap(window => window.controls);
  if (data.controlRef) {
    const matches = controls.filter(control => control.controlRef === data.controlRef);
    return { status: matches.length === 1 ? 'selected' : matches.length > 1 ? 'ambiguous' : 'notFound',
      candidates: matches, control: matches.length === 1 ? matches[0] : null };
  }
  const scopedControls = record.windows.flatMap(window => window.controls).filter(control => control.containerRef === data.containerRef);
  if (!scopedControls.length) return { status: 'notFound', candidates: [] };
  const matches = scopedControls.filter(control => control.controlType === 'Button' &&
    control.name === data.controlName && (data.observedAutomationId === undefined || control.automationId === data.observedAutomationId));
  return { status: matches.length === 1 ? 'selected' : matches.length ? 'ambiguous' : 'notFound',
    candidates: matches, control: matches.length === 1 ? matches[0] : null };
}

function structuralDialogs(snapshot, probe, intent) {
  const matches = [];
  for (const [profileId, profile] of Object.entries(PROFILES)) {
    if (profile.intent !== intent || (profile.commandId && probe.activeCommand?.id !== profile.commandId) ||
        (profile.existingTargetOnly && (!probe.identity?.isSaved || !probe.identity?.fileId))) continue;
    for (const window of snapshot.windows ?? []) {
      const groups = new Map();
      for (const control of window.controls ?? []) {
        const key = control.containerRef ?? window.containerRef;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(control);
      }
      for (const [containerRef, controls] of groups) {
        const hasUnique = id => !id || controls.filter(control => control.automationId === id).length === 1;
        if (!hasUnique(profile.titleAutomationId) || !hasUnique(profile.messageAutomationId) ||
            (profile.dialogClass && !String(window.className).includes(profile.dialogClass) &&
             !controls.some(control => String(control.className).includes(profile.dialogClass) ||
               control.parentPath?.some(part => part.includes(profile.dialogClass)))) ||
            !controls.some(control => control.automationId === profile.buttonAutomationId && control.controlType === 'Button')) continue;
        matches.push({ profileId, intent: profile.intent, action: profile.action, windowHandle: window.handle,
          containerRef, preservesUnderlyingFailure: profile.preservesUnderlyingFailure === true,
          matchingMethod: 'callerSelected', languageIndependent: false, qualified: false });
      }
    }
  }
  return matches;
}

function bindLease(record, data, expected) {
  return record.requestId === data.requestId && record.leaseHash === digest(data.lease) &&
    record.intent === data.intent && record.target?.name === expected.name &&
    record.target?.creationId === expected.creationId && record.target?.fileId === expected.fileId;
}

async function actionViaHost(client, data, expected, probe, record, selected, dependencies) {
  if (selected.profile.nativeCommandId) {
    const result = await terminateNativeCommand(client, expected, probe, selected.profile, dependencies);
    return result;
  }
  return hostUiCall('respond', { requestId: data.requestId, lease: data.lease, expectedIdentity: expected,
    action: data.action,
    intent: data.intent, processId: probe.processId, expectedProcessStartTicks: record.processStartTicks,
    expectedMainWindowHandle: record.mainWindowHandle, windowHandle: selected.control.windowHandle,
    control: { windowHandle: selected.control.windowHandle, runtimeId: selected.control.runtimeId,
      parentPath: selected.control.parentPath, containerKey: selected.control.containerKey,
      automationId: selected.control.automationId, name: selected.control.name,
      controlType: selected.control.controlType, className: selected.control.className },
    profile: { profileId: selected.profile.profileId, intent: selected.profile.intent, action: selected.profile.action,
      titleAutomationId: PROFILES[selected.profile.profileId]?.titleAutomationId ?? null,
      messageAutomationId: PROFILES[selected.profile.profileId]?.messageAutomationId ?? null,
      buttonAutomationId: PROFILES[selected.profile.profileId]?.buttonAutomationId ?? null,
      dialogClass: PROFILES[selected.profile.profileId]?.dialogClass ?? null },
    timeBudgetMs: 15000 }, dependencies);
}

async function respond(client, data, context, dependencies = {}) {
  if (!leaseIsLive(data.lease, (dependencies.now ?? Date.now)()) || data.lease.requestId !== data.requestId) {
    return { success: false, operation: 'ui.respond', status: 'blocked', requestId: data.requestId,
      observationId: data.observationId, actionSubmitted: false, operationOutcome: 'notEvaluated',
      unavailableEvidence: ['coordinator lease is expired or not bound to this requestId'] };
  }
  const loaded = await getObservation(data.observationId, dependencies);
  if (loaded.status === 'used') return loaded.result ? { ...loaded.result, replayedReceipt: true } :
    { success: false, operation: 'ui.respond', status: 'unknown', requestId: data.requestId,
      observationId: data.observationId, actionSubmitted: null, operationOutcome: 'notEvaluated' };
  if (loaded.status === 'unknown') return loaded.result ? { ...loaded.result, replayedReceipt: true } :
    { success: false, operation: 'ui.respond', status: 'unknown', requestId: data.requestId,
      observationId: data.observationId, actionSubmitted: null, operationOutcome: 'notEvaluated' };
  if (loaded.status !== 'fresh') return { success: false, operation: 'ui.respond', status: 'stale',
    requestId: data.requestId, observationId: data.observationId, actionSubmitted: false,
    operationOutcome: 'notEvaluated', unavailableEvidence: ['observation missing or expired'] };
  const expected = targetIdentity(data, context);
  const record = loaded.record;
  if (!bindLease(record, data, expected)) return { success: false, operation: 'ui.respond', status: 'blocked',
    requestId: data.requestId, actionSubmitted: false, operationOutcome: 'notEvaluated',
    unavailableEvidence: ['request, lease, intent or exact target does not match observation'] };
  if (!expected.identityPinned || !record.target.creationId && !record.target.fileId) return { success: false,
    operation: 'ui.respond', status: 'blocked', requestId: data.requestId, actionSubmitted: false,
    operationOutcome: 'notEvaluated', unavailableEvidence: ['exact creationId/fileId pin required before response'] };
  const probe = await sdkProbe(client, expected, dependencies);
  if (probe.status !== 'resolved' || !probe.identityPinned || probe.identity?.isActive !== true ||
      probe.backend !== record.backend || probe.sessionFingerprint !== record.sessionFingerprint ||
      probe.processId !== record.processId || probe.identity?.creationId !== record.target.creationId ||
      probe.identity?.fileId !== record.target.fileId ||
      (expected.commandId && probe.activeCommand?.id !== expected.commandId)) return { success: false,
    operation: 'ui.respond', status: 'stale', requestId: data.requestId, actionSubmitted: false,
    operationOutcome: 'notEvaluated', unavailableEvidence: probe.unavailableEvidence ?? ['document/process binding changed'] };
  const host = decorateSnapshot(await hostUiCall('inspect', { requestId: data.requestId, lease: data.lease,
    expectedIdentity: expected, processId: probe.processId, expectedProcessStartTicks: record.processStartTicks,
    expectedMainWindowHandle: record.mainWindowHandle, timeBudgetMs: 5000, maxControls: 256 }, dependencies));
  if (host.status !== 'ready' || host.truncated || host.processStartTicks !== record.processStartTicks ||
      host.mainWindowHandle !== record.mainWindowHandle) return { success: false, operation: 'ui.respond', status: 'stale',
    requestId: data.requestId, actionSubmitted: false, operationOutcome: 'notEvaluated',
    unavailableEvidence: host.unavailableEvidence ?? ['process/window changed or current UI tree is incomplete'] };
  const qualifications = dependencies.qualifiedProfiles ?? QUALIFIED_PROFILES;
  let selected;
  if ((data.selectionMode ?? 'profile') === 'observedControl') {
    const chosen = exactControl(record, data);
    if (chosen.status !== 'selected') return { success: false, operation: 'ui.respond', status: chosen.status,
      requestId: data.requestId, candidateRefs: chosen.candidates.map(control => control.controlRef),
      actionSubmitted: false, operationOutcome: 'notEvaluated' };
    const fresh = host.windows.flatMap(window => window.controls).filter(control =>
      control.fingerprint === chosen.control.fingerprint && control.windowHandle === chosen.control.windowHandle &&
      control.enabled && !control.offscreen && control.controlType === 'Button' && control.invokeAvailable);
    if (fresh.length !== 1) return { success: false, operation: 'ui.respond', status: fresh.length ? 'ambiguous' : 'stale',
      requestId: data.requestId, candidateRefs: fresh.map(control => control.controlRef),
      actionSubmitted: false, operationOutcome: 'notEvaluated' };
    const allowedProfiles = structuralDialogs(host, probe, data.intent)
      .filter(profile => profile.windowHandle === fresh[0].windowHandle && profile.containerRef === fresh[0].containerRef);
    if (allowedProfiles.length !== 1) return { success: false, operation: 'ui.respond', status: 'blocked',
      requestId: data.requestId, candidateRefs: [chosen.control.controlRef], actionSubmitted: false,
      operationOutcome: 'notEvaluated', unavailableEvidence: ['selected control is not within one recognized dialog structure'] };
    if (fresh[0].semanticRole && fresh[0].semanticRole !== data.action) return { success: false,
      operation: 'ui.respond', status: 'blocked', requestId: data.requestId,
      candidateRefs: [chosen.control.controlRef], actionSubmitted: false, operationOutcome: 'notEvaluated',
      unavailableEvidence: ['selected control exposes a semantic role that contradicts the requested action'] };
    selected = { control: fresh[0], profile: allowedProfiles[0] };
  } else {
    const matches = profileCandidates(host, probe, data.intent, qualifications).filter(profile => profile.profileId === data.profileId);
    if (matches.length !== 1) return { success: false, operation: 'ui.respond', status: matches.length ? 'ambiguous' : 'notFound',
      requestId: data.requestId, candidateRefs: matches.map(profile => profile.controlRef).filter(Boolean),
      actionSubmitted: false, operationOutcome: 'notEvaluated' };
    selected = { control: host.windows.flatMap(window => window.controls)
      .find(control => control.fingerprint === matches[0].fingerprint), profile: matches[0] };
    if (!matches[0].qualified) return { success: false, operation: 'ui.respond', status: 'blocked',
      requestId: data.requestId, profileId: data.profileId, actionSubmitted: false,
      operationOutcome: 'notEvaluated', unavailableEvidence: ['profile lacks an exact native build/OS/locale qualification record'] };
    if (data.action !== matches[0].action) return { success: false, operation: 'ui.respond', status: 'blocked',
      requestId: data.requestId, profileId: data.profileId, actionSubmitted: false,
      operationOutcome: 'notEvaluated', unavailableEvidence: ['profile action contradicts intent'] };
  }
  if (!leaseIsLive(data.lease, (dependencies.now ?? Date.now)())) return { success: false,
    operation: 'ui.respond', status: 'blocked', requestId: data.requestId,
    observationId: data.observationId, actionSubmitted: false, operationOutcome: 'notEvaluated',
    unavailableEvidence: ['coordinator lease expired immediately before action'] };
  const claim = { observationId: data.observationId, requestId: data.requestId, state: 'in_progress', claimedAt: Date.now() };
  try { await writeExclusive(receiptPath(loaded.directory, data.observationId), claim); }
  catch (error) {
    if (error.code === 'EEXIST') return { success: false, operation: 'ui.respond', status: 'unknown',
      requestId: data.requestId, observationId: data.observationId, actionSubmitted: null,
      operationOutcome: 'notEvaluated', unavailableEvidence: ['observation token already consumed or in progress'] };
    throw error;
  }
  await fs.unlink(observationPath(loaded.directory, data.observationId)).catch(() => {});
  let response;
  try { response = await actionViaHost(client, data, expected, probe, record, selected, dependencies); }
  catch (error) { response = { status: 'unknown', actionSubmitted: null, unavailableEvidence: [redactDiagnostic(error.message)] }; }
  const result = { success: response.status === 'actionSubmitted', operation: 'ui.respond', status: response.status,
    requestId: data.requestId, observationId: data.observationId, profileId: selected.profile.profileId,
    matchingMethod: data.selectionMode === 'observedControl' ? 'callerSelected' : selected.profile.matchingMethod,
    actionSubmitted: response.actionSubmitted ?? null, dialogClosed: response.dialogClosed ?? null,
    nativeCommandId: response.nativeCommandId ?? selected.profile.nativeCommandId ?? null,
    activeCommand: response.activeCommand ?? null, idle: response.idle ?? null,
    terminationReason: response.terminationReason ?? null,
    terminationObservationAvailable: response.terminationObservationAvailable ?? null,
    modelUnchanged: response.modelUnchanged ?? null,
    operationOutcome: 'notEvaluated',
    underlyingFailureRetained: selected.profile.preservesUnderlyingFailure === true,
    unavailableEvidence: response.unavailableEvidence ?? [] };
  const receipt = { ...claim, state: response.status === 'unknown' ? 'unknown' : 'complete',
    finishedAt: Date.now(), result };
  await fs.writeFile(receiptPath(loaded.directory, data.observationId), JSON.stringify(receipt), { mode: 0o600 });
  return result;
}

async function resolve(client, data, context, dependencies = {}) {
  if (!leaseIsLive(data.lease, (dependencies.now ?? Date.now)()) || data.lease.requestId !== data.requestId) {
    return { success: false, operation: 'ui.resolve', requestId: data.requestId,
      resolutionStatus: 'blocked', actions: [], remainingUI: [], operationOutcome: 'notEvaluated',
      unavailableEvidence: ['coordinator lease is expired or not bound to this requestId'] };
  }
  const directory = await ensureStateDirectory(dependencies);
  const journalPath = path.join(directory, `resolve-${digest([data.requestId, data.lease])}.json`);
  try {
    const existing = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    return existing.result ? { ...existing.result, replayedReceipt: true } : { success: false,
      operation: 'ui.resolve', resolutionStatus: 'unknown', requestId: data.requestId,
      actions: existing.actions ?? [], remainingUI: [], operationOutcome: 'notEvaluated' };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const maxActions = data.maxActions ?? 3;
  const deadline = (dependencies.now ?? Date.now)() + (data.timeBudgetMs ?? 15000);
  const journal = { requestId: data.requestId, leaseHash: digest(data.lease), state: 'running', actions: [], startedAt: Date.now() };
  await writeExclusive(journalPath, journal);
  const recovery = await recoverPrearmedConfirmation(client, data, context, targetIdentity(data, context), dependencies);
  if (recovery) {
    journal.state = recovery.resolutionStatus === 'unknown' ? 'unknown' : 'complete';
    journal.completedAt = Date.now(); journal.result = recovery;
    await fs.writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 });
    return recovery;
  }
  let resolutionStatus = 'partial', remainingUI = [], candidates = [], unavailableEvidence = [];
  for (let index = 0; index < maxActions; index++) {
    if ((dependencies.now ?? Date.now)() >= deadline) { resolutionStatus = 'partial'; break; }
    if (!leaseIsLive(data.lease, (dependencies.now ?? Date.now)())) {
      resolutionStatus = 'blocked'; unavailableEvidence = ['coordinator lease expired before the next action']; break;
    }
    const snapshot = await inspect(client, data, context, dependencies);
    remainingUI = snapshot.windows ?? [];
    unavailableEvidence = snapshot.unavailableEvidence ?? [];
    if (snapshot.status === 'nothingToDo') {
      resolutionStatus = journal.actions.length ? 'resolved' : 'nothingToDo'; break;
    }
    if (!snapshot.observationId || !snapshot.identityVerified) { resolutionStatus = snapshot.status === 'unsupported' ? 'blocked' : 'unknown'; break; }
    const matches = (snapshot.profiles ?? [])
      .filter(profile => profile.qualified && (!data.allowedProfiles || data.allowedProfiles.includes(profile.profileId)));
    if (matches.length !== 1) {
      resolutionStatus = 'blocked';
      candidates = (snapshot.profiles ?? []).map(profile => ({ profileId: profile.profileId,
        controlRef: profile.controlRef ?? null, qualified: profile.qualified }));
      break;
    }
    if (journal.actions.some(action => action.profileId === matches[0].profileId)) {
      resolutionStatus = 'partial';
      candidates = [{ profileId: matches[0].profileId, controlRef: matches[0].controlRef ?? null,
        qualified: matches[0].qualified }];
      break;
    }
    const action = await respond(client, { requestId: data.requestId, lease: data.lease, target: data.target,
      intent: data.intent, action: ACTION_FOR_INTENT[data.intent], observationId: snapshot.observationId,
      selectionMode: 'profile', profileId: matches[0].profileId, expectedCommandId: data.expectedCommandId }, context, dependencies);
    journal.actions.push({ profileId: action.profileId, status: action.status,
      actionSubmitted: action.actionSubmitted, dialogClosed: action.dialogClosed });
    if (action.status === 'unknown') { resolutionStatus = 'unknown'; break; }
    const after = await inspect(client, data, context, dependencies);
    remainingUI = after.windows ?? [];
    if (after.status === 'nothingToDo') { resolutionStatus = 'resolved'; break; }
    resolutionStatus = index === maxActions - 1 ? 'partial' : 'partial';
  }
  const result = { success: ['resolved', 'nothingToDo'].includes(resolutionStatus), operation: 'ui.resolve',
    requestId: data.requestId, resolutionStatus, actions: journal.actions, candidates, remainingUI,
    unavailableEvidence, operationOutcome: 'notEvaluated' };
  journal.state = resolutionStatus === 'unknown' ? 'unknown' : 'complete';
  journal.completedAt = Date.now(); journal.result = result;
  await fs.writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 });
  return result;
}

async function terminateNativeCommand(client, identity, probe, profile, dependencies = {}) {
  if (!profile.qualified || !profile.nativeCommandId || !Array.isArray(profile.commandIds) ||
      !profile.commandIds.includes(profile.nativeCommandId)) {
    return { status: 'blocked', actionSubmitted: false,
      unavailableEvidence: ['native command cancellation profile is not qualified'] };
  }
  if (dependencies.terminateNative) return dependencies.terminateNative(identity, probe, profile);
  if (client?.capabilities?.backend !== 'addin' || typeof client.executeUiGuardedScript !== 'function') {
    return { status: 'unsupported', actionSubmitted: false,
      unavailableEvidence: ['dedicated guarded addin UI command route is unavailable'] };
  }
  const out = await client.executeUiGuardedScript(terminationScript(identity, profile.nativeCommandId));
  return parseMarked(out.text, 'FMCAD_UI_ACTION ');
}

function terminationScript(identity, commandId) {
  const data = { name: identity.name, creationId: identity.creationId, fileId: identity.fileId };
  return `import adsk.core, adsk.fusion, json, math, time
_TARGET = ${pythonValue(data)}
_COMMAND = ${pythonValue(commandId)}

def _identity(doc):
    file = doc.dataFile
    return {'name': doc.name, 'creationId': doc.creationId, 'fileId': file.id if file else None}

def _capture(doc):
    design = adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))
    root = design.rootComponent
    manager = adsk.fusion.TemporaryBRepManager.get()
    bodies, copies = [], []
    components = [root]
    components.extend(component for component in design.allComponents if component != root)
    for component_index, component in enumerate(components):
        for body_index, body in enumerate(component.bRepBodies):
            box = body.boundingBox
            key = (component_index, component.name, body_index, body.name)
            bodies.append((key, float(body.volume), box.minPoint.x, box.minPoint.y, box.minPoint.z,
                box.maxPoint.x, box.maxPoint.y, box.maxPoint.z,
                getattr(getattr(body, 'material', None), 'name', None),
                getattr(getattr(body, 'appearance', None), 'name', None)))
            copies.append((key, manager.copy(body)))
    occurrences = [(occ.fullPathName, list(occ.transform2.asArray())) for occ in root.allOccurrences]
    timeline = []
    for index in range(design.timeline.count):
        item = design.timeline.item(index)
        timeline.append((item.name, int(item.healthState), bool(item.isSuppressed)))
    return ({'timelineCount': design.timeline.count, 'markerPosition': design.timeline.markerPosition,
            'timeline': timeline, 'bodies': bodies, 'occurrences': occurrences}, copies, manager)

def _unchanged(before, before_copies, after, after_copies, manager):
    if before['timelineCount'] != after['timelineCount'] or before['markerPosition'] != after['markerPosition']:
        return False, {'reason': 'timeline changed'}
    if before['timeline'] != after['timeline'] or before['occurrences'] != after['occurrences']:
        return False, {'reason': 'timeline health or occurrence poses changed'}
    if before['bodies'] != after['bodies'] or len(before_copies) != len(after_copies):
        return False, {'reason': 'body inventory or measured properties changed'}
    maximum_difference = 0.0
    for (before_key, before_body), (after_key, after_body) in zip(before_copies, after_copies):
        if before_key != after_key:
            return False, {'reason': 'body ownership identity changed'}
        left, right = manager.copy(before_body), manager.copy(after_body)
        if not manager.booleanOperation(left, right, adsk.fusion.BooleanTypes.DifferenceBooleanType):
            return None, {'reason': 'before-minus-after CSG measurement unavailable'}
        diff_one = float(left.volume)
        left, right = manager.copy(after_body), manager.copy(before_body)
        if not manager.booleanOperation(left, right, adsk.fusion.BooleanTypes.DifferenceBooleanType):
            return None, {'reason': 'after-minus-before CSG measurement unavailable'}
        diff_two = float(left.volume)
        maximum_difference = max(maximum_difference, diff_one, diff_two)
        if diff_one > 1e-9 or diff_two > 1e-9:
            return False, {'reason': 'bidirectional CSG difference exceeded tolerance',
                           'maximumDifferenceCm3': maximum_difference}
    return True, {'maximumBidirectionalDifferenceCm3': maximum_difference, 'toleranceCm3': 1e-9}

def run(_context: str):
    app = adsk.core.Application.get()
    docs = [doc for doc in app.documents if doc.name == _TARGET['name'] and
        (not _TARGET.get('creationId') or doc.creationId == _TARGET['creationId']) and
        (not _TARGET.get('fileId') or (doc.dataFile and doc.dataFile.id == _TARGET['fileId']))]
    if len(docs) != 1 or docs[0] != app.activeDocument:
        print('FMCAD_UI_ACTION ' + json.dumps({'status':'blocked','actionSubmitted':False,
            'unavailableEvidence':['unique pinned active document not verified']})); return
    doc = docs[0]
    ui = app.userInterface
    before, before_copies, manager = _capture(doc)
    active = ui.activeCommand
    definition = ui.commandDefinitions.itemById(active) if active else None
    if active != _COMMAND or definition is None or not definition.isNative or not definition.isValid:
        print('FMCAD_UI_ACTION ' + json.dumps({'status':'blocked','actionSubmitted':False,
            'unavailableEvidence':['active native command identity/lifetime mismatch']})); return
    termination_reasons = []
    observer = None
    observer_added = False
    termination_event = getattr(ui, 'commandTerminated', None)
    if termination_event is not None:
        try:
            class _FmcadTerminationObserver(adsk.core.ApplicationCommandEventHandler):
                def notify(self, args):
                    try:
                        if args.commandId == _COMMAND:
                            termination_reasons.append(int(args.terminationReason))
                    except Exception:
                        pass
            observer = _FmcadTerminationObserver()
            observer_added = bool(termination_event.add(observer))
        except Exception:
            observer = None
    try:
        returned = ui.terminateActiveCommand()
    except Exception as exc:
        returned = None
        termination_error = type(exc).__name__
    else:
        termination_error = None
    finally:
        if observer_added:
            try: termination_event.remove(observer)
            except Exception: pass
    deadline = time.monotonic() + 2000 / 1000.0
    while ui.activeCommand not in ('', 'SelectCommand') and time.monotonic() < deadline:
        adsk.doEvents(); time.sleep(0.05)
    after, after_copies, manager = _capture(doc)
    unchanged, measurement = _unchanged(before, before_copies, after, after_copies, manager)
    idle = ui.activeCommand in ('', 'SelectCommand')
    reason = termination_reasons[0] if len(termination_reasons) == 1 else None
    verified = bool(returned) and idle and reason == 2 and unchanged is True
    status = 'actionSubmitted' if verified else 'blocked' if returned is False else 'unknown'
    evidence = []
    if not observer_added: evidence.append('request-owned command termination reason observer unavailable')
    if len(termination_reasons) != 1: evidence.append('expected exactly one matching commandTerminated reason event')
    if reason != 2: evidence.append('native termination reason was not CancelledTerminationReason (2)')
    if not idle: evidence.append('active native command did not return to SelectCommand')
    if unchanged is not True: evidence.append('scratch model baseline was not proven unchanged')
    if termination_error: evidence.append('terminateActiveCommand raised ' + termination_error)
    print('FMCAD_UI_ACTION ' + json.dumps({'status':status,'actionSubmitted':None if returned is None else bool(returned),
        'terminateReturned':returned,'nativeCommandId':_COMMAND,'activeCommand':ui.activeCommand,
        'idle':idle,'modelUnchanged':unchanged,'modelMeasurement':measurement,
        'operationOutcome':'notEvaluated','terminationReason':reason,
        'terminationObservationAvailable':observer_added,'unavailableEvidence':evidence}))
`;
}

function watcherStatusInputValid(request) {
  if (!object(request) || typeof request.requestId !== 'string' || !request.requestId ||
      !object(request.expectedIdentity) ||
      (request.checkHostProcess !== undefined && typeof request.checkHostProcess !== 'boolean') ||
      !INTENTS.has(request.intent) || !PROFILES[request.profileId] ||
      PROFILES[request.profileId].intent !== request.intent) return false;
  if (request.lease && (!object(request.lease) || request.lease.requestId !== request.requestId ||
      typeof request.lease.id !== 'string' || !request.lease.id ||
      typeof request.lease.operationId !== 'string' || !request.lease.operationId ||
      !object(request.lease.target))) return false;
  const leaseBinding = request.lease ? { requestId: request.lease.requestId,
    operationId: request.lease.operationId, idHash: digestText(request.lease.id), target: request.lease.target } :
    request.leaseBinding;
  if (!object(leaseBinding) || leaseBinding.requestId !== request.requestId ||
      typeof leaseBinding.operationId !== 'string' || !leaseBinding.operationId ||
      typeof leaseBinding.idHash !== 'string' || !/^[0-9a-f]{64}$/i.test(leaseBinding.idHash) ||
      !object(leaseBinding.target)) return false;
  for (const field of ['name', 'creationId', 'fileId', 'commandId']) {
    if ((leaseBinding.target[field] ?? null) !== (request.expectedIdentity[field] ?? null)) return false;
  }
  return !!(request.expectedIdentity.creationId || request.expectedIdentity.fileId);
}

function watcherLifecycleMatches(record, binding) {
  return object(record) && record.schemaVersion === 1 && record.lifecycleId === binding.lifecycleId &&
    record.requestId === binding.requestId && record.leaseIdHash === binding.leaseIdHash &&
    (!binding.leaseHash || record.leaseHash === binding.leaseHash) &&
    (!record.operationId || record.operationId === binding.operationId) &&
    record.intent === binding.intent && record.profileId === binding.profileId &&
    JSON.stringify(record.target) === JSON.stringify(binding.target);
}

async function findPrearmedWatcherContext(directory, request, expectedIdentity) {
  let directoryInfo;
  try { directoryInfo = await fs.lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return { status: 'notFound' }; throw error; }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return { status: 'blocked' };
  const names = (await fs.readdir(directory)).filter(name => /^watcher-[a-f0-9]{64}\.json$/i.test(name));
  if (names.length > 128) return { status: 'ambiguous', unavailableEvidence: ['watcher lifecycle lookup exceeded its bounded record count'] };
  const matches = [];
  const sameRequest = [];
  let incomplete = false;
  for (const name of names) {
    const file = path.join(directory, name);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) { incomplete = true; continue; }
      const record = JSON.parse(await fs.readFile(file, 'utf8'));
      if (record.requestId !== request.requestId || record.operationId !== request.lease.operationId) continue;
      sameRequest.push({ record, file });
      if (record.continuationOf || record.intent !== request.intent || !PROFILES[record.profileId] ||
          PROFILES[record.profileId].intent !== request.intent) continue;
      const target = record.target;
      if (target?.name !== expectedIdentity.name || target?.creationId !== expectedIdentity.creationId ||
          target?.fileId !== expectedIdentity.fileId ||
          (target?.commandId ?? null) !== (expectedIdentity.commandId ?? null)) continue;
      if (record.leaseHash !== digest(request.lease) ||
          record.leaseIdHash !== digestText(request.lease.id)) continue;
      matches.push({ record, file });
    } catch (error) {
      if (error.code !== 'ENOENT') incomplete = true;
    }
  }
  if (sameRequest.some(({ record }) => record.intent !== request.intent || record.continuationOf ||
      record.leaseHash !== digest(request.lease) || record.leaseIdHash !== digestText(request.lease.id) ||
      JSON.stringify(record.target) !== JSON.stringify({ name: expectedIdentity.name,
        creationId: expectedIdentity.creationId ?? null, fileId: expectedIdentity.fileId ?? null,
        commandId: expectedIdentity.commandId ?? null }))) {
    return { status: 'identityMismatch', unavailableEvidence: ['durable watcher request, lease, intent or target binding differs'] };
  }
  if (matches.length > 1) return { status: 'ambiguous', unavailableEvidence: ['multiple exact prearmed watcher records match this request'] };
  if (!matches.length) return { status: incomplete ? 'unknown' : 'notFound',
    unavailableEvidence: incomplete ? ['a watcher lifecycle record was unreadable; provenance is incomplete'] :
      ['no exact prearmed watcher lifecycle record matches this request, operation, lease and target'] };
  const { record, file } = matches[0];
  if (record.state !== 'finished' || record.result?.status !== 'unknown' || record.result?.actionSubmitted === true ||
      !record.fusionProcess?.processId || !record.fusionProcess?.processStartTicks ||
      !record.fusionProcess?.mainWindowHandle || !record.fusionProcess?.fusionVersion) {
    return { status: 'notReusable', record, file,
      unavailableEvidence: ['exact prearmed record is not a terminal no-action watcher context'] };
  }
  const claimPath = path.join(directory, `continuation-${record.lifecycleId}.json`);
  try { await fs.lstat(claimPath); return { status: 'consumed', record, file,
    unavailableEvidence: ['the one-time continuation claim already exists'] }; }
  catch (error) { if (error.code !== 'ENOENT') return { status: 'unknown', record, file,
    unavailableEvidence: [redactDiagnostic(error.message)] }; }
  return { status: 'resolved', record, file, unavailableEvidence: [] };
}

async function findRenewableWatcherContext(directory, request, expectedIdentity, profileIds) {
  let directoryInfo;
  try { directoryInfo = await fs.lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return { status: 'notFound' }; throw error; }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return { status: 'blocked' };
  const names = (await fs.readdir(directory)).filter(name => /^watcher-[a-f0-9]{64}\.json$/i.test(name));
  if (names.length > 128) return { status: 'ambiguous', unavailableEvidence: ['watcher lifecycle lookup exceeded its bounded record count'] };
  const candidates = [];
  let incomplete = false;
  const target = { name: expectedIdentity.name, creationId: expectedIdentity.creationId ?? null,
    fileId: expectedIdentity.fileId ?? null, commandId: expectedIdentity.commandId ?? null };
  for (const name of names) {
    const file = path.join(directory, name);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) { incomplete = true; continue; }
      const record = JSON.parse(await fs.readFile(file, 'utf8'));
      if (record.requestId !== request.requestId) continue;
      if (record.operationId !== request.lease.operationId || !Object.hasOwn(record, 'operationId')) {
        return { status: 'identityMismatch', unavailableEvidence: ['durable watcher operationId differs from the renewed coordinator lease'] };
      }
      if (record.intent !== request.intent || JSON.stringify(record.target) !== JSON.stringify(target)) {
        return { status: 'identityMismatch', unavailableEvidence: ['durable watcher intent or target differs from the renewed request'] };
      }
      if (!PROFILES[record.profileId] || PROFILES[record.profileId].intent !== request.intent ||
          (profileIds?.length && !profileIds.includes(record.profileId))) continue;
      candidates.push({ record, file });
    } catch (error) { if (error.code !== 'ENOENT') incomplete = true; }
  }
  if (candidates.length > 1) return { status: 'ambiguous',
    unavailableEvidence: ['multiple durable prearmed watcher records match this request, operation, target and profile'] };
  if (!candidates.length) return { status: incomplete ? 'unknown' : 'notFound',
    unavailableEvidence: incomplete ? ['a watcher lifecycle record was unreadable; provenance is incomplete'] :
      ['no durable prearmed watcher record matches this request, operation, target and allowed profile'] };
  const { record, file } = candidates[0];
  if (record.schemaVersion !== 1 || !record.operationId || record.continuationOf ||
      record.state !== 'finished' || record.result?.status !== 'unknown' ||
      record.result?.actionSubmitted === true || !record.fusionProcess?.processId ||
      !record.fusionProcess?.processStartTicks || !record.fusionProcess?.mainWindowHandle ||
      !record.fusionProcess?.fusionVersion || !record.fusionProcess?.osBuild || !record.fusionProcess?.locale) {
    return { status: 'notReusable', record, file,
      unavailableEvidence: ['original watcher is not a terminal no-action record with complete pinned host identity'] };
  }
  const claimPath = continuationClaimPath(directory, record.lifecycleId);
  try { await fs.lstat(claimPath); return { status: 'consumed', record, file,
    unavailableEvidence: ['the one-time renewed confirmation claim already exists'] }; }
  catch (error) { if (error.code !== 'ENOENT') return { status: 'unknown', record, file,
    unavailableEvidence: [redactDiagnostic(error.message)] }; }
  return { status: 'resolved', record, file, unavailableEvidence: [] };
}

const continuationClaimPath = (directory, lifecycleId) => path.join(directory, `continuation-${lifecycleId}.json`);

async function watcherStatus(request, dependencies = {}) {
  if (!watcherStatusInputValid(request)) return { success: false, operation: 'ui.watcherStatus',
    status: 'blocked', requestId: request?.requestId ?? null,
    unavailableEvidence: ['status query requires the exact original watcher request/lease/target/profile binding'] };
  const directory = stateDirectory(dependencies);
  const binding = watcherLifecycleBinding(request);
  const lifecycleFile = watcherLifecyclePath(directory, binding.lifecycleId);
  let lifecycle = null;
  try {
    const directoryInfo = await fs.lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return { success: false,
      operation: 'ui.watcherStatus', status: 'blocked', requestId: request.requestId,
      unavailableEvidence: ['watcher state path is not a real private directory'] };
    lifecycle = JSON.parse(await fs.readFile(lifecycleFile, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') return { success: false, operation: 'ui.watcherStatus',
    status: 'unknown', requestId: request.requestId, unavailableEvidence: [redactDiagnostic(error.message)] }; }
  if (lifecycle && !watcherLifecycleMatches(lifecycle, binding)) return { success: false,
    operation: 'ui.watcherStatus', status: 'blocked', requestId: request.requestId,
    unavailableEvidence: ['private watcher receipt exists but exact request/lease/target binding differs'] };
  if (lifecycle?.state === 'finished' && request.checkHostProcess !== true) return { success: true, operation: 'ui.watcherStatus',
    status: 'terminal', requestId: request.requestId, watcherId: binding.lifecycleId,
    watcherState: 'finished', actionSubmitted: lifecycle.result?.actionSubmitted ?? null,
    dialogClosed: lifecycle.result?.dialogClosed ?? null,
    operationOutcome: lifecycle.result?.operationOutcome ?? 'notEvaluated', result: lifecycle.result,
    hostProcess: lifecycle.hostProcess ?? null, unavailableEvidence: [] };
  const leaseBinding = request.lease ? { requestId: request.lease.requestId,
    operationId: request.lease.operationId, idHash: digestText(request.lease.id), target: request.lease.target } :
    request.leaseBinding;
  const hostRequest = { requestId: request.requestId, expectedIdentity: request.expectedIdentity,
    intent: request.intent, profileId: request.profileId, lifecycleId: binding.lifecycleId,
    lifecycleFile: windowsPath(lifecycleFile), leaseHash: lifecycle?.leaseHash ?? binding.leaseHash ?? null,
    leaseBinding, checkHostProcess: request.checkHostProcess === true,
    lifecycleRecord: lifecycle, profile: { profileId: request.profileId, ...PROFILES[request.profileId] },
    timeBudgetMs: Math.min(request.timeBudgetMs ?? 30000, 30000) };
  const result = await hostUiCall('watch-status', hostRequest, dependencies);
  return { ...result, success: ['running', 'notRunning', 'terminal'].includes(result.status),
    operation: 'ui.watcherStatus', requestId: request.requestId, watcherId: binding.lifecycleId,
    watcherState: lifecycle?.state ?? result.watcherState ?? 'noReceipt',
    watcherResult: result.watcherResult ?? lifecycle?.result ?? null,
    operationOutcome: result.operationOutcome ?? 'unknown' };
}

async function resumePendingWatcher(request, dependencies = {}) {
  const deny = reason => ({ success: false, status: 'blocked', requestId: request?.requestId ?? null,
    actionSubmitted: false, operationOutcome: 'notEvaluated', unavailableEvidence: [reason] });
  if (!object(request) || request.renewalAuthorized !== true ||
      typeof request.requestId !== 'string' || !request.requestId ||
      typeof request.operationId !== 'string' || !request.operationId ||
      !object(request.expectedIdentity) || !object(request.originalLeaseBinding) ||
      request.originalLeaseBinding.requestId !== request.requestId ||
      request.originalLeaseBinding.operationId !== request.operationId ||
      typeof request.originalLeaseBinding.idHash !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(request.originalLeaseBinding.idHash) ||
      !object(request.originalLeaseBinding.target) ||
      !INTENTS.has(request.intent) || request.intent !== 'confirmRequestedUpdate' ||
      request.profileId !== 'update-all-latest' ||
      request.nativeCommandId !== PROFILES['update-all-latest'].commandId ||
      typeof request.projectId !== 'string' || !request.projectId ||
      !object(request.root) || request.root.projectId !== request.projectId ||
      request.root.fileId !== request.expectedIdentity.fileId ||
      !Number.isSafeInteger(request.originalLeaseExpiresAt) ||
      request.originalLeaseExpiresAt > (dependencies.now ?? Date.now)()) {
    return deny('pending continuation lacks the exact expired original request, target, command and explicit renewal authorization');
  }
  for (const field of ['name', 'creationId', 'fileId', 'commandId']) {
    if ((request.originalLeaseBinding.target[field] ?? null) !== (request.expectedIdentity[field] ?? null)) {
      return deny('original lifecycle target differs from the renewed confirmation target');
    }
  }

  const originalRequest = { requestId: request.requestId,
    leaseBinding: request.originalLeaseBinding, expectedIdentity: request.expectedIdentity,
    intent: request.intent, profileId: request.profileId };
  const originalBinding = watcherLifecycleBinding(originalRequest);
  const directory = stateDirectory(dependencies);
  let original;
  try { original = JSON.parse(await fs.readFile(watcherLifecyclePath(directory, originalBinding.lifecycleId), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return deny('no durable prearmed watcher identity exists for this pending request');
    return { ...deny('durable watcher receipt could not be read'), unavailableEvidence: [redactDiagnostic(error.message)] };
  }
  if (!watcherLifecycleMatches(original, originalBinding) ||
      (original.operationId && original.operationId !== request.operationId) ||
      original.state !== 'finished' || original.result?.status !== 'unknown' ||
      original.result?.actionSubmitted === true || !original.fusionProcess?.processId ||
      !original.fusionProcess?.processStartTicks || !original.fusionProcess?.mainWindowHandle) {
    return deny('durable prearmed watcher receipt is not the unique unsettled no-action record for this request');
  }
  const qualifications = dependencies.qualifiedProfiles ?? QUALIFIED_PROFILES;
  const qualification = qualifications[request.profileId];
  if (!qualification || original.fusionProcess.fusionVersion !== qualification.fusionVersion) {
    return deny('prearmed Fusion build does not match the qualified update profile');
  }

  const oldStatus = await watcherStatus({ ...originalRequest, checkHostProcess: true }, dependencies);
  if (oldStatus.status !== 'terminal' || oldStatus.watcherState !== 'finished' ||
      oldStatus.hostProcessStatus !== 'notRunning' || oldStatus.watcherResult?.actionSubmitted === true) {
    return deny('prior request-owned watcher is not proven terminal and absent; no continuation action was submitted');
  }

  const previousProcess = original.fusionProcess;
  const snapshot = await inspectHostSnapshot({ requestId: request.requestId,
    lease: { id: 'host-inspect-' + uuid(), requestId: request.requestId,
      operationId: request.operationId, expiresAt: (dependencies.now ?? Date.now)() + 30000,
      target: request.expectedIdentity },
    expectedIdentity: request.expectedIdentity, processId: previousProcess.processId,
    expectedProcessStartTicks: previousProcess.processStartTicks,
    expectedMainWindowHandle: previousProcess.mainWindowHandle, timeBudgetMs: 15000, maxControls: 256 }, dependencies);
  if (snapshot.status !== 'ready' || snapshot.truncated ||
      snapshot.processId !== previousProcess.processId ||
      snapshot.processStartTicks !== previousProcess.processStartTicks ||
      snapshot.mainWindowHandle !== previousProcess.mainWindowHandle ||
      snapshot.osBuild !== previousProcess.osBuild || snapshot.locale !== previousProcess.locale ||
      snapshot.osBuild !== qualification.osBuild || snapshot.locale !== qualification.locale) {
    return { ...deny('current host process/start/window/build/locale does not match the prearmed request'),
      hostEvidence: { status: snapshot.status, processId: snapshot.processId,
        processStartTicks: snapshot.processStartTicks, mainWindowHandle: snapshot.mainWindowHandle,
        osBuild: snapshot.osBuild, locale: snapshot.locale, truncated: snapshot.truncated } };
  }
  const mainWindows = snapshot.windows.filter(window => window.isMain && window.handle === previousProcess.mainWindowHandle);
  if (mainWindows.length !== 1 || !mainWindows[0].title.includes(request.expectedIdentity.name)) {
    return deny('prearmed target window is not corroborated by one current pinned main window');
  }
  const modalDescendants = mainWindows[0].controls.filter(control => control.isModal ||
    (control.controlType === 'Window' && /QMessageBox|QDialog/i.test(control.className)));
  if (!modalDescendants.length) return deny('no current native modal is present in the prearmed process/window');

  const syntheticProbe = { fusionVersion: previousProcess.fusionVersion,
    activeCommand: { id: request.nativeCommandId, isNative: true },
    identity: { name: request.expectedIdentity.name, creationId: request.expectedIdentity.creationId,
      fileId: request.expectedIdentity.fileId, isSaved: true, isActive: true } };
  const candidates = profileCandidates(snapshot, syntheticProbe, request.intent, qualifications)
    .filter(candidate => candidate.profileId === request.profileId && candidate.qualified === true &&
      candidate.windowHandle === previousProcess.mainWindowHandle);
  if (candidates.length !== 1) return { ...deny(candidates.length ?
    'current update modal/profile is ambiguous; no Invoke attempted' :
    'current modal does not match the qualified original update profile; no Invoke attempted'),
    candidateProfiles: candidates.map(candidate => ({ profileId: candidate.profileId,
      qualified: candidate.qualified, matchingMethod: candidate.matchingMethod })) };
  const selected = candidates[0];
  const window = snapshot.windows.find(item => item.handle === selected.windowHandle);
  const control = window?.controls.find(item => item.controlRef === selected.controlRef &&
    item.containerRef === selected.containerRef && item.controlType === 'Button' &&
    item.enabled && !item.offscreen && item.invokeAvailable);
  if (!control) return deny('fresh qualified confirmation control disappeared before continuation');

  const now = (dependencies.now ?? Date.now)();
  const renewedLease = { id: 'ui-renew-' + uuid(), requestId: request.requestId,
    operationId: request.operationId, expiresAt: now + 30000,
    target: { name: request.expectedIdentity.name, creationId: request.expectedIdentity.creationId,
      fileId: request.expectedIdentity.fileId } };
  if (!leaseIsLive(renewedLease, now) || renewedLease.requestId !== request.requestId ||
      renewedLease.operationId !== request.operationId || original.state !== 'finished' ||
      digestText(renewedLease.id) === originalBinding.leaseIdHash) {
    return deny('request-bound continuation lease could not be created for the original pending confirmation');
  }
  const continuationRequest = { requestId: request.requestId, lease: renewedLease,
    expectedIdentity: request.expectedIdentity, intent: request.intent, profileId: request.profileId };
  const continuationBinding = watcherLifecycleBinding(continuationRequest);
  const claimPath = path.join(directory, `continuation-${originalBinding.lifecycleId}.json`);
  try { await writeExclusive(claimPath, { requestId: request.requestId,
    originalLifecycleId: originalBinding.lifecycleId, originalLeaseIdHash: originalBinding.leaseIdHash,
    continuationLifecycleId: continuationBinding.lifecycleId, continuationLeaseIdHash: continuationBinding.leaseIdHash,
    operationId: request.operationId, target: originalBinding.target, claimedAt: now }); }
  catch (error) {
    if (error.code === 'EEXIST') return deny('one-time pending confirmation continuation was already claimed; no second action');
    throw error;
  }
  const created = await writeWatcherLifecycle(directory, continuationBinding, true, {
    operationId: request.operationId, fusionProcess: previousProcess,
    continuationOf: originalBinding.lifecycleId, renewalAuthorized: true,
    originalLeaseIdHash: originalBinding.leaseIdHash, nativeCommandId: request.nativeCommandId });
  if (created.status !== 'created') return deny('continuation lifecycle receipt already exists; no action was submitted');

  const controlData = { windowHandle: control.windowHandle, runtimeId: control.runtimeId,
    parentPath: control.parentPath, containerKey: control.containerKey,
    automationId: control.automationId, name: control.name,
    controlType: control.controlType, className: control.className };
  const hostRequest = { requestId: request.requestId, lease: renewedLease,
    expectedIdentity: request.expectedIdentity, intent: request.intent, action: 'confirm',
    processId: previousProcess.processId, expectedProcessStartTicks: previousProcess.processStartTicks,
    expectedMainWindowHandle: previousProcess.mainWindowHandle, windowHandle: control.windowHandle,
    control: controlData, lifecycleId: continuationBinding.lifecycleId,
    lifecycleFile: windowsPath(created.file), leaseHash: continuationBinding.leaseHash,
    profile: { profileId: selected.profileId, intent: selected.intent, action: selected.action,
      titleAutomationId: PROFILES[selected.profileId].titleAutomationId,
      messageAutomationId: PROFILES[selected.profileId].messageAutomationId,
      buttonAutomationId: PROFILES[selected.profileId].buttonAutomationId,
      dialogClass: PROFILES[selected.profileId].dialogClass ?? null },
    timeBudgetMs: 15000 };
  const action = await hostUiCall('respond', hostRequest, dependencies);
  await writeWatcherLifecycle(directory, continuationBinding, false, { state: 'finished', result: action });
  const postSnapshot = await inspectHostSnapshot({ requestId: request.requestId, lease: renewedLease,
    expectedIdentity: request.expectedIdentity, processId: previousProcess.processId,
    expectedProcessStartTicks: previousProcess.processStartTicks,
    expectedMainWindowHandle: previousProcess.mainWindowHandle, timeBudgetMs: 10000, maxControls: 256 }, dependencies);
  const postMatches = postSnapshot.status === 'ready' && !postSnapshot.truncated ?
    profileCandidates(postSnapshot, syntheticProbe, request.intent, qualifications)
      .filter(candidate => candidate.profileId === request.profileId && candidate.qualified === true) : [];
  return { success: action.status === 'actionSubmitted', status: action.status,
    requestId: request.requestId, intent: request.intent, profileId: request.profileId,
    actionSubmitted: action.actionSubmitted ?? null, dialogClosed: action.dialogClosed ?? null,
    operationOutcome: 'notEvaluated', nativeCommandId: request.nativeCommandId,
    renewedLeaseIdHash: continuationBinding.leaseIdHash,
    lifecycleId: continuationBinding.lifecycleId, originalLifecycleId: originalBinding.lifecycleId,
    postHostInspection: { status: postSnapshot.status, truncated: postSnapshot.truncated === true,
      processId: postSnapshot.processId, processStartTicks: postSnapshot.processStartTicks,
      mainWindowHandle: postSnapshot.mainWindowHandle,
      updateDialogStillMatched: postMatches.length > 0, unavailableEvidence: postSnapshot.unavailableEvidence ?? [] },
    unavailableEvidence: action.unavailableEvidence ?? [] };
}

async function armWatcher(client, request, dependencies = {}) {
  if (!leaseIsLive(request.lease, (dependencies.now ?? Date.now)()) ||
      request.lease.requestId !== request.requestId) return { status: 'blocked',
    unavailableEvidence: ['watcher lease is expired or not bound to this requestId'] };
  const qualifications = dependencies.qualifiedProfiles ?? QUALIFIED_PROFILES;
  const qualification = qualifications[request.profileId];
  if (!qualification || !request.lease || !request.requestId || !INTENTS.has(request.intent) ||
      !(request.expectedIdentity?.creationId || request.expectedIdentity?.fileId)) {
    return { status: 'blocked', unavailableEvidence: ['watcher requires a qualified profile, lease, request and exact document identity'] };
  }
  if (!PROFILES[request.profileId]) return { status: 'unsupported',
    unavailableEvidence: ['the private UIA watcher supports qualified modal profiles only'] };
  const profile = PROFILES[request.profileId];
  const leaseTarget = request.lease.target;
  if (profile.intent !== request.intent || !object(leaseTarget) ||
      leaseTarget.name !== request.expectedIdentity.name ||
      leaseTarget.creationId !== request.expectedIdentity.creationId ||
      leaseTarget.fileId !== request.expectedIdentity.fileId ||
      leaseTarget.commandId !== request.expectedIdentity.commandId) {
    return { status: 'blocked', unavailableEvidence: ['watcher intent or lease target does not exactly match the qualified profile and pinned document'] };
  }
  const expected = request.expectedIdentity;
  const probe = await sdkProbe(client, expected, dependencies);
  if (probe.status !== 'resolved' || !probe.identityPinned || probe.identity?.isActive !== true ||
      probe.backend !== 'addin' || !probe.sessionFingerprint ||
      probe.identity?.creationId !== expected.creationId || probe.identity?.fileId !== expected.fileId) {
    return { status: 'blocked', unavailableEvidence: probe.unavailableEvidence ?? ['watcher process/session/document binding is not verified'] };
  }
  if (profile.existingTargetOnly && (!probe.identity?.isSaved || !probe.identity?.fileId)) return { status: 'blocked',
    unavailableEvidence: ['save-confirmation watcher requires an already saved existing target; no save-as/new-target path is allowed'] };
  if (!['', 'SelectCommand', null].includes(probe.activeCommand?.id)) return { status: 'blocked',
    unavailableEvidence: ['watcher must be armed before the request-owned native command starts; an unrelated active command is present'] };
  const initialHost = decorateSnapshot(await hostUiCall('inspect', { requestId: request.requestId, lease: request.lease,
    expectedIdentity: expected, processId: probe.processId, timeBudgetMs: 30000, maxControls: 256 }, dependencies));
  if (initialHost.status !== 'ready' || initialHost.truncated ||
      qualification.fusionVersion !== probe.fusionVersion || qualification.osBuild !== initialHost.osBuild ||
      qualification.locale !== initialHost.locale || qualification.profileId !== request.profileId) {
    return { status: 'blocked', unavailableEvidence: ['watcher profile is not qualified for this exact process build/OS/locale: ' +
      JSON.stringify({ status: initialHost.status, truncated: initialHost.truncated === true,
        expected: { fusionVersion: qualification.fusionVersion, osBuild: qualification.osBuild,
          locale: qualification.locale, profileId: qualification.profileId },
        actual: { fusionVersion: probe.fusionVersion, osBuild: initialHost.osBuild,
          locale: initialHost.locale, profileId: request.profileId } })] };
  }
  const directory = await ensureStateDirectory(dependencies);
  const lifecycle = watcherLifecycleBinding(request);
  const started = await writeWatcherLifecycle(directory, lifecycle, true, { fusionProcess: {
    processId: probe.processId, processStartTicks: initialHost.processStartTicks,
    mainWindowHandle: initialHost.mainWindowHandle, fusionVersion: probe.fusionVersion,
    osBuild: initialHost.osBuild, locale: initialHost.locale } });
  if (started.status !== 'created') return { status: 'unknown', requestId: request.requestId,
    watcherId: lifecycle.lifecycleId, unavailableEvidence: ['a watcher lifecycle record already exists; no second helper was started'] };
  const completionFile = path.join(directory, `watch-${lifecycle.lifecycleId}.done`);
  const hostRequest = { ...request, action: profile.action, expectedIdentity: expected, processId: probe.processId,
    expectedProcessStartTicks: initialHost.processStartTicks,
    expectedMainWindowHandle: initialHost.mainWindowHandle,
    lifecycleId: lifecycle.lifecycleId, leaseHash: lifecycle.leaseHash,
    lifecycleFile: windowsPath(started.file),
    profile: { profileId: request.profileId, ...profile },
    qualification, completionFile: windowsPath(completionFile),
    timeBudgetMs: Math.min(request.timeBudgetMs ?? 30000, 120000) };
  const helper = dependencies.armHostWatcher
    ? await dependencies.armHostWatcher(hostRequest, qualification)
    : startHostHelper('watch', hostRequest, dependencies);
  if (helper.status && !helper.completion) {
    await writeWatcherLifecycle(directory, lifecycle, false, { state: 'finished', result: helper });
    return helper;
  }
  const completion = Promise.resolve(helper.completion).then(async result => {
    await writeWatcherLifecycle(directory, lifecycle, false, { state: 'finished', result });
    return result;
  }, async error => {
    const result = { status: 'unknown', actionSubmitted: null,
      unavailableEvidence: [redactDiagnostic(error.message)] };
    await writeWatcherLifecycle(directory, lifecycle, false, { state: 'finished', result });
    return result;
  });
  if (helper.ready) {
    const readiness = await Promise.race([
      helper.ready.then(receipt => ({ ready: true, receipt })),
      completion.then(result => ({ ready: false, result }))
    ]);
    if (!readiness.ready) return { ...readiness.result, status: readiness.result.status === 'unknown' ? 'unknown' : 'blocked',
      unavailableEvidence: [...(readiness.result.unavailableEvidence ?? []), 'watcher exited before host readiness acknowledgment; native command not submitted'] };
  }
  return { status: 'armed', requestId: request.requestId, watcherId: lifecycle.lifecycleId,
    completion, 
    complete: async () => {
      await fs.writeFile(completionFile, String(Date.now()), { mode: 0o600 });
      return completion;
    },
    disarm: async () => {
      const result = typeof helper.stop === 'function' ? await helper.stop() :
        typeof helper.disarm === 'function' ? await helper.disarm() : null;
      await fs.unlink(completionFile).catch(() => {});
      if (result) await writeWatcherLifecycle(directory, lifecycle, false, { state: 'finished', result });
      return result;
    } };
}

async function execute(client, operation, data, context, dependencies = {}) {
  if (operation === 'ui.inspect') return inspect(client, data, context, dependencies);
  if (operation === 'ui.respond') return respond(client, data, context, dependencies);
  if (operation === 'ui.resolve') return resolve(client, data, context, dependencies);
  throw new Error('Unknown UI operation: ' + operation);
}

module.exports = { operations, execute, validate, sdkProbe, profileCandidates, armWatcher, resumePendingWatcher, terminateNativeCommand,
  inspectHostSnapshot, resolveProbeDocuments, watcherStatus, stopTimedOutHostHelper,
  detachTimedOutWatcherStatusHelper, profiles: PROFILES, stateDirectory };
