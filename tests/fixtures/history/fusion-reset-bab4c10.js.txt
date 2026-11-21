'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { QueueClient } = require('./queue-client');
const { QueueState } = require('./queue-state');
const { buildHash, durable, processBirth, readJson } = require('./queue-instance');

const descriptor = {
  usage: 'fusion reset --force',
  desc: 'Force-restart the verified Fusion process and restart the shared broker. Only known unsaved FMCAD test fixtures may be discarded.',
  example: 'fmcad fusion reset --force',
  extra: '--force is required. Active, unknown, saved-and-modified or unrecognized unsaved documents block the reset. The broker is paused during restart, then resumed and tested with a read-only queued request.',
};

const manuals = {
  'fusion reset': {
    sections: [
      { title: 'Return Contract', text: 'Force-stops the exact Fusion PID/birth/executable selected by the broker, starts a replacement process, then restores the shared broker to RUNNING and completes one read-only queue smoke job. A resumed interrupted reset is reported as recoveredInterruptedReset.' },
      { title: 'Data And Queue Safety', text: '--force is explicit permission to discard only recognized unsaved FMCAD test fixtures. Saved clean documents are preserved; unknown unsaved work or saved documents with modifications block reset. Active, queued, leased or unresolved broker work blocks reset. The reset marker refuses new queue submissions until a replacement Fusion identity is verified and the broker is ready.' },
      { title: 'Limits', text: 'Requires Linux/WSL with Windows PowerShell, queue routing and broker auto-start. Fusion startup, broker identity and queue readiness are checked separately; reset does not certify model geometry or physical manufacturing.' },
    ],
    examples: [{ label: 'Force-restart Fusion and its broker', argv: ['fusion', 'reset', '--force'],
      requires: 'Queue is idle and every open document is saved/clean or is a recognized test-owned fixture.',
      output: 'Previous and current Fusion process identities plus broker RUNNING state and a succeeded read-only queue smoke job.' }],
    audit: {
      sources: ['src/fusion-reset.js', 'src/queue-broker.js:reset submission fence and idle stop',
        'src/queue-autostart.js:reset ownership fence', 'src/queue-instance.js:PID/birth identity', 'src/cli.js', 'src/commands.js'],
      tests: ['tests/fusion-reset.test.js', 'tests/console-services.test.js'],
      verified: ['Explicit --force parsing', 'Idle/unknown queue and unsaved-document refusal',
        'Exact Windows PID/birth/path matching', 'Reset marker fences submissions and stale recovery',
        'Replacement broker must complete a queue job before success'],
      gaps: [],
      bugs: [],
    },
  },
};

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixturePatterns = [
  /^FMCAD_CAD_TEST_\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}_\d{3}Z$/,
  /^FMCAD_(?:DEFINITIONS|GEO|EXT|STYLE)_[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}$/i,
];

function parse(argv) {
  if (argv.length !== 1 || argv[0] !== '--force') {
    fail('USAGE', 'Use fmcad fusion reset --force; no reset is attempted without explicit force confirmation.');
  }
  return { force: true };
}

function validateQueue(status) {
  const control = status?.control;
  if (!status || !control || status.active || status.blocked || status.held || status.lease || status.stopping ||
      control.unresolved || control.activeOperations !== 0 || control.phase !== 'RUNNING' || control.gateClosed !== false) {
    fail('QUEUE_BUSY', 'Fusion reset requires a running, idle broker with no active or unresolved execution.');
  }
  const pending = Object.values(status.jobs || {}).filter(job => !terminal.has(job.state));
  if (pending.length) fail('QUEUE_BUSY', 'Fusion reset is refused while any job is queued, started or unresolved.');
}

function isOwnedFixture(name) { return fixturePatterns.some(pattern => pattern.test(name || '')); }

function planDocuments(documents) {
  if (!Array.isArray(documents)) fail('DOCUMENT_INVENTORY_INVALID', 'Fusion did not return a valid document inventory.');
  const closeIds = [];
  const savedIds = [];
  for (const document of documents) {
    if (!document || typeof document.id !== 'string' || typeof document.name !== 'string' ||
        typeof document.saved !== 'boolean' || typeof document.modified !== 'boolean') {
      fail('DOCUMENT_INVENTORY_INVALID', 'Fusion returned an incomplete document identity.');
    }
    if (document.saved) {
      if (document.modified || typeof document.fileId !== 'string' || !document.fileId) {
        fail('UNSAVED_WORK', `Saved document “${document.name}” has unverified or unsaved state; no reset was attempted.`);
      }
      savedIds.push(document.id);
      continue;
    }
    if (isOwnedFixture(document.name)) {
      closeIds.push(document.id);
      continue;
    }
    const blankUntitled = document.name === 'Bez nazwy' && !document.modified &&
      document.bodies === 0 && document.sketches === 0 && document.occurrences === 0 &&
      document.timeline === 0 && document.userParameters === 0;
    if (!blankUntitled) {
      fail('UNSAVED_WORK', `Unrecognized unsaved document “${document.name}”; save or close it before resetting Fusion.`);
    }
  }
  return { closeIds, savedIds };
}

function pythonInventoryCode(expected, closeIds = [], expectedPid = null) {
  const encoded = JSON.stringify(JSON.stringify({ expected, closeIds, expectedPid }));
  return `import adsk.core as _core, json as _json, os as _os
_expected = _json.loads(${encoded})
_app = _core.Application.get()
if _expected['expectedPid'] is not None and _os.getpid() != _expected['expectedPid']:
    raise RuntimeError('Fusion process identity changed after reset preflight; no fixture was closed.')
def _snapshot(_app=_app):
    _rows = []
    for _doc in _app.documents:
        _design = _doc.design
        _root = _design.rootComponent if _design else None
        _rows.append(dict(id=_doc.creationId, name=_doc.name, saved=bool(_doc.isSaved), modified=bool(_doc.isModified),
            fileId=_doc.dataFile.id if _doc.isSaved else None,
            bodies=_root.bRepBodies.count if _root else 0, sketches=_root.sketches.count if _root else 0,
            occurrences=_root.occurrences.count if _root else 0,
            timeline=_design.timeline.count if _design else 0,
            userParameters=_design.userParameters.count if _design else 0))
    return sorted(_rows, key=lambda _row: _row['id'])
_before = _snapshot()
if _expected['expected'] is not None and _before != _expected['expected']:
    raise RuntimeError('Fusion document inventory changed after reset preflight; no fixture was closed.')
_expected_by_id = { _row['id']: _row for _row in (_expected['expected'] or []) }
_closed = []
for _id in _expected['closeIds']:
    _doc = next((_candidate for _candidate in _app.documents if _candidate.creationId == _id), None)
    if _doc is None or _doc.isSaved or _id not in _expected_by_id or _expected_by_id[_id]['saved']:
        raise RuntimeError('A preflight fixture identity no longer matches; no further document was closed.')
    if _doc.close(False) is not True:
        raise RuntimeError('Fusion did not confirm closing an owned test fixture.')
    _closed.append(_id)
_after = _snapshot()
if any(_id in {_row['id'] for _row in _after} for _id in _closed):
    raise RuntimeError('Fusion did not close every selected test fixture.')
_saved_before = { _row['id']: _row['fileId'] for _row in _before if _row['saved'] }
_saved_after = { _row['id']: _row['fileId'] for _row in _after if _row['saved'] }
if _saved_before != _saved_after or any(_row['modified'] for _row in _after if _row['saved']):
    raise RuntimeError('A saved deliverable changed while closing test fixtures.')
print(_json.dumps(dict(pid=_os.getpid(), version=_app.version, closed=_closed, documents=_after)))
`;
}

function psQuote(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }

function powershell(script, exec = execFileSync) {
  return exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
}

function readFusionProcess(pid, exec) {
  if (!Number.isSafeInteger(pid) || pid <= 0) fail('INVALID_PROCESS_IDENTITY', 'Fusion PID is invalid.');
  const output = powershell(`$ErrorActionPreference='Stop'
$all = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'Fusion360.exe'" -ErrorAction SilentlyContinue)
$p = $all | Where-Object { $_.ProcessId -eq ${pid} } | Select-Object -First 1
if ($null -eq $p) { 'absent' } else {
  $g = Get-Process -Id ${pid} -ErrorAction Stop
  [pscustomobject]@{pid=[int]$p.ProcessId; birth=$g.StartTime.ToFileTimeUtc().ToString(); path=$p.ExecutablePath; responding=[bool]$g.Responding; fusionCount=$all.Count} | ConvertTo-Json -Compress
}`, exec);
  if (output === 'absent') return null;
  let value;
  try { value = JSON.parse(output); } catch { fail('PROCESS_IDENTITY_INVALID', 'PowerShell returned invalid Fusion process identity.'); }
  if (!value || value.pid !== pid || typeof value.birth !== 'string' || typeof value.path !== 'string' ||
      typeof value.responding !== 'boolean' || !Number.isSafeInteger(value.fusionCount)) {
    fail('PROCESS_IDENTITY_INVALID', 'PowerShell returned incomplete Fusion process identity.');
  }
  return value;
}

function listFusionProcesses(exec) {
  const output = powershell(`$ErrorActionPreference='Stop'
$all = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'Fusion360.exe'" -ErrorAction SilentlyContinue)
$rows = @($all | ForEach-Object {
  $g = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  if ($g) { [pscustomobject]@{pid=[int]$_.ProcessId; birth=$g.StartTime.ToFileTimeUtc().ToString(); path=$_.ExecutablePath; responding=[bool]$g.Responding; fusionCount=$all.Count} }
})
ConvertTo-Json -InputObject $rows -Compress`, exec);
  let value;
  try { value = JSON.parse(output); } catch { fail('PROCESS_IDENTITY_INVALID', 'PowerShell returned an invalid Fusion process list.'); }
  const values = Array.isArray(value) ? value : [value];
  if (values.some(process => !process || !Number.isSafeInteger(process.pid) || typeof process.birth !== 'string' ||
      typeof process.path !== 'string' || typeof process.responding !== 'boolean')) {
    fail('PROCESS_IDENTITY_INVALID', 'PowerShell returned an incomplete Fusion process list.');
  }
  return values;
}

function validateProcess(instance, process) {
  if (!instance || !process || instance.pid !== process.pid || instance.birth !== process.birth || process.fusionCount !== 1 ||
      !/^.+\\Autodesk\\webdeploy\\production\\[^\\]+\\Fusion360\.exe$/i.test(process.path)) {
    fail('PROCESS_IDENTITY_MISMATCH', 'The live Fusion PID, birth time or executable path does not exactly match the broker identity.');
  }
  return process;
}

async function waitForProcess(pid, birth, { exec, timeoutMs = 15000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const current = readFusionProcess(pid, exec);
    if (!current || current.birth !== birth) return;
    await delay(250);
  }
  fail('FUSION_STOP_TIMEOUT', 'Fusion did not exit after the exact verified process was force-closed.');
}

function stopFusion(process, exec) {
  const script = `$ErrorActionPreference='Stop'
$all = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'Fusion360.exe'" -ErrorAction SilentlyContinue)
if ($all.Count -ne 1 -or $all[0].ProcessId -ne ${process.pid}) { throw 'Fusion process set changed; refusing to stop anything.' }
$p = $all[0]
$g = Get-Process -Id ${process.pid} -ErrorAction Stop
if ($g.StartTime.ToFileTimeUtc().ToString() -ne ${psQuote(process.birth)} -or $p.ExecutablePath -ne ${psQuote(process.path)}) { throw 'Fusion PID/birth/path changed; refusing to stop anything.' }
Stop-Process -Id ${process.pid} -Force -ErrorAction Stop`;
  powershell(script, exec);
}

async function waitForNewFusion(oldProcess, { exec, timeoutMs = 120000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const processes = listFusionProcesses(exec);
    if (processes.length > 1) fail('FUSION_INSTANCE_AMBIGUOUS', 'More than one Fusion process appeared during reset; no process was selected.');
    const process = processes[0];
    if (process && process.birth !== oldProcess.birth && process.path === oldProcess.path && process.responding) return process;
    await delay(500);
  }
  fail('FUSION_START_TIMEOUT', 'The replacement Fusion process did not become responsive before the startup deadline.');
}

function startFusion(executable, exec) {
  powershell(`$ErrorActionPreference='Stop'
$all = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'Fusion360.exe'" -ErrorAction SilentlyContinue)
if ($all.Count -ne 0) { throw 'A Fusion process already exists; refusing to launch another.' }
Start-Process -FilePath ${psQuote(executable)} -ErrorAction Stop | Out-Null`, exec);
}

async function recoverFusion(oldProcess, exec) {
  const processes = listFusionProcesses(exec);
  if (processes.length > 1) fail('FUSION_INSTANCE_AMBIGUOUS', 'More than one Fusion process is present; reset recovery cannot select one.');
  const current = processes[0];
  if (current?.birth === oldProcess.birth && current.path === oldProcess.path) return current;
  if (!current) startFusion(oldProcess.path, exec);
  return waitForNewFusion(oldProcess, { exec });
}

async function queuePython(client, cfg, code, description) {
  const argv = ['call', 'execute_python', JSON.stringify({ code, persistent: false })];
  const job = await client.submit({ requestId: randomUUID(), kind: 'command', argv, cwd: process.cwd(),
    timeoutMs: 120000, backend: cfg.backend,
    inputFiles: [], buildHash: buildHash(), description });
  const result = await client.wait(job.id);
  if (result.job.state !== 'succeeded' || typeof result.stdout !== 'string') {
    fail('RESET_SDK_CHECK_FAILED', `Read-only reset verification job ${job.id} did not succeed; inspect its receipt before retrying.`);
  }
  let envelope;
  try { envelope = JSON.parse(result.stdout); } catch { fail('RESET_SDK_CHECK_FAILED', 'Queued Fusion readback returned malformed output.'); }
  if (envelope.success !== true || typeof envelope.stdout !== 'string') fail('RESET_SDK_CHECK_FAILED', 'Queued Fusion readback did not return a successful script result.');
  try { return { value: JSON.parse(envelope.stdout), job: result.job }; }
  catch { fail('RESET_SDK_CHECK_FAILED', 'Queued Fusion script returned malformed JSON.'); }
}

async function queueReadinessJob(client, cfg) {
  const job = await client.submit({ requestId: randomUUID(), kind: 'command', argv: ['tools'], cwd: process.cwd(),
    timeoutMs: 60000, backend: cfg.backend, inputFiles: [], buildHash: buildHash(),
    description: 'Verify the shared broker accepts and completes a post-reset queue job' });
  const result = await client.wait(job.id);
  if (result.job.state !== 'succeeded') fail('QUEUE_SMOKE_FAILED', `Post-reset queue smoke job ${job.id} did not succeed.`);
  return result.job;
}

async function waitForBrokerStop(client, owner, { timeoutMs = 30000 } = {}) {
  const lockFile = path.join(client.dir, 'broker.lock');
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fs.existsSync(lockFile)) {
      const current = readJson(lockFile);
      if (current.pid !== owner.pid || current.birth !== owner.birth || current.nonce !== owner.nonce) {
        fail('BROKER_OWNERSHIP_CHANGED', 'Broker ownership changed during reset; Fusion was not stopped.');
      }
    } else {
      try {
        if (processBirth(owner.pid) !== owner.birth) return;
      } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return; throw error; }
    }
    await delay(50);
  }
  fail('BROKER_STOP_UNKNOWN', 'The old broker did not prove release; Fusion was not stopped.');
}

async function stopBroker(client, marker, oldStatus) {
  const ownerFile = path.join(client.dir, 'broker.lock');
  const owner = readJson(ownerFile);
  if (!oldStatus.control || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.birth !== 'string' ||
      owner.nonce !== oldStatus.control.instanceId ||
      oldStatus.buildHash !== marker.buildHash) {
    fail('BROKER_OWNERSHIP_CHANGED', 'The live broker identity does not match its durable ownership marker.');
  }
  const pauseControl = { requestId: randomUUID(), instanceId: oldStatus.control.instanceId,
    expectedGeneration: oldStatus.control.generation };
  const paused = await client.call('pause', { control: pauseControl });
  if (paused.instanceId !== oldStatus.control.instanceId || paused.phase !== 'PAUSED' || paused.unresolved ||
      paused.activeOperations !== 0 || paused.gateClosed !== true || paused.requestId !== pauseControl.requestId ||
      paused.generation !== pauseControl.expectedGeneration + 1) {
    fail('BROKER_PAUSE_UNCONFIRMED', 'The broker did not confirm an idle paused state.');
  }
  // Only a confirmed transition from RUNNING belongs to this reset. Preparing
  // a marker, a rejected CAS or finding an existing pause never grants resume.
  marker.resetPause = { requestId: pauseControl.requestId, instanceId: paused.instanceId,
    generation: paused.generation };
  const markerFile = path.join(client.dir, 'fusion-reset.lock');
  if (readJson(markerFile).nonce !== marker.nonce) fail('RESET_OWNERSHIP_CHANGED', 'The reset marker changed before publishing its pause receipt.');
  durable(markerFile, marker);
  const snapshot = await client.call('status');
  if (snapshot.control?.instanceId !== oldStatus.control.instanceId || snapshot.control.phase !== 'PAUSED' ||
      snapshot.control.generation !== paused.generation ||
      snapshot.blocked || snapshot.held || snapshot.lease || snapshot.active || snapshot.stopping) {
    fail('QUEUE_BUSY', 'Queue state changed while preparing the broker handoff.');
  }
  let stopError;
  try {
    const control = { requestId: randomUUID(), instanceId: paused.instanceId,
      expectedGeneration: paused.generation };
    const ack = await client.call('console-stop', { control });
    if (ack?.acknowledged !== true || ack.requestId !== control.requestId || ack.instanceId !== control.instanceId ||
        ack.buildHash !== oldStatus.buildHash) fail('BROKER_STOP_UNCONFIRMED', 'Broker did not confirm its fenced stop request.');
  } catch (error) { stopError = error; }
  try { await waitForBrokerStop(client, owner); }
  catch (error) { if (stopError) error.stopError = stopError.code || stopError.message; throw error; }
}

async function startBroker(client, cfg, marker, oldStatus) {
  await require('./queue-autostart').ensureBroker({ ...cfg, routing: 'queue' }, client.auth, { fusionResetNonce: marker.nonce });
  await client.register({ autoStart: false });
  const status = await client.call('status');
  if (!status.control || oldStatus?.control && status.control.instanceId === oldStatus.control.instanceId || status.control.phase !== 'RUNNING' ||
      status.control.gateClosed !== false || status.control.activeOperations !== 0 || status.control.unresolved || status.blocked || status.held) {
    fail('BROKER_RESTART_INVALID', 'The replacement broker is not a distinct, idle, RUNNING instance.');
  }
  return status;
}

async function resumeBroker(client, status, resetNonce) {
  const control = status.control;
  const requestId = randomUUID();
  const request = { requestId, instanceId: control.instanceId, expectedGeneration: control.generation };
  let result;
  try { result = await client.call('resume', { control: request, ...(resetNonce ? { resetOwnerNonce: resetNonce } : {}) }); }
  catch (error) {
    const observed = await client.call('control-status');
    if (observed.instanceId !== control.instanceId || observed.unresolved || observed.phase !== 'RUNNING') throw error;
    result = observed;
  }
  if (result.instanceId !== control.instanceId || result.unresolved || result.phase !== 'RUNNING' ||
      result.gateClosed !== false || result.activeOperations !== 0) {
    fail('BROKER_NOT_READY', 'The replacement broker did not resume into a clean RUNNING state.');
  }
  return result;
}

async function restoreBroker(client, cfg, marker) {
  if (!marker.resetPause || typeof marker.resetPause !== 'object') {
    // A failed pause CAS did not change the broker. Observe only; in particular,
    // do not start a replacement or resume the winning client's pause.
    return client.call('status');
  }
  if (readJson(path.join(client.dir, 'fusion-reset.lock')).nonce !== marker.nonce) {
    fail('RESET_OWNERSHIP_CHANGED', 'Restoration cannot change the broker after reset ownership changed.');
  }
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    let status;
    try { status = await client.call('status'); }
    catch {
      await require('./queue-autostart').ensureBroker({ ...cfg, routing: 'queue' }, client.auth, { fusionResetNonce: marker.nonce });
      await client.register({ autoStart: false });
      continue;
    }
    if (status.blocked || status.held || status.control?.unresolved) {
      fail('RECONCILIATION_REQUIRED', 'Queue restoration found unresolved work; the reset marker remains in place.');
    }
    if (!status.stopping && status.control?.phase === 'RUNNING') return status;
    if (!status.stopping && status.control?.phase === 'PAUSED' && status.control.activeOperations === 0) {
      if (!ownsResetPause(marker, status.control)) {
        fail('RESET_PAUSE_UNOWNED', 'Restoration cannot resume a pause not confirmed as owned by this reset.');
      }
      await resumeBroker(client, status, marker.nonce);
      continue;
    }
    if (status.stopping || status.control?.phase === 'PAUSING' || status.control?.activeOperations > 0 || status.active) {
      await delay(100);
      continue;
    }
    fail('BROKER_NOT_READY', 'Queue restoration reached an unexpected broker phase.');
  }
  fail('BROKER_NOT_READY', 'Queue did not return to a clean RUNNING state after the aborted reset.');
}

function ownsResetPause(marker, control) {
  const pause = marker.resetPause;
  return !!(pause && typeof pause === 'object' && typeof pause.requestId === 'string' &&
    pause.instanceId === control.instanceId && pause.generation === control.generation);
}

function ownsPersistedResetPause(marker, state) {
  const pause = marker.resetPause;
  const receipt = pause && typeof pause === 'object' && state.controlRequests?.[pause.requestId];
  return !!(receipt?.paused === true && receipt.generation === pause.generation &&
    state.controlGeneration === pause.generation);
}

function removeResetMarker(file, nonce) {
  const current = readJson(file);
  if (current.nonce !== nonce) fail('RESET_OWNERSHIP_CHANGED', 'The Fusion reset ownership marker changed; it was not removed.');
  fs.unlinkSync(file);
}

function validateResetRecovery(marker, state, oldInstance, ownerAlive, brokerPresent, process) {
  if (ownerAlive) fail('FUSION_RESET_IN_PROGRESS', 'The previous reset process is still alive; no recovery was attempted.');
  if (brokerPresent) fail('RESET_RECOVERY_BUSY', 'A broker still owns the queue; inspect its status before reset recovery.');
  if (!marker || marker.protocol !== 1 || !marker.fusion || !Number.isSafeInteger(marker.fusion.pid) ||
      typeof marker.fusion.birth !== 'string' || typeof marker.fusion.path !== 'string' ||
      !oldInstance || oldInstance.pid !== marker.fusion.pid || oldInstance.birth !== marker.fusion.birth) {
    fail('RESET_RECOVERY_INVALID', 'Interrupted reset identity does not match the last broker Fusion identity.');
  }
  const recoveringPause = ['unpausing', 'queue-unpaused'].includes(marker.phase);
  if (!state || !(state.paused === true || recoveringPause && state.paused === false) || state.active !== null ||
      state.blocked || state.controlBlocked || state.localUnknown || state.lease ||
      Object.values(state.jobs || {}).some(job => !terminal.has(job.state))) {
    fail('RESET_RECOVERY_BUSY', 'Interrupted reset recovery requires a paused, quiescent queue with no unresolved or queued jobs.');
  }
  if (state.paused && !ownsPersistedResetPause(marker, state)) {
    fail('RESET_PAUSE_UNOWNED', 'The queue pause has no generation-bound receipt belonging to the interrupted reset.');
  }
  if (!process || process.birth === marker.fusion.birth || !process.responding || process.fusionCount !== 1) {
    fail('FUSION_UNAVAILABLE', 'A single responsive replacement Fusion process is required for reset recovery.');
  }
  validateProcess({ pid: process.pid, birth: process.birth }, process);
  return process;
}

function reclaimDeadResetBroker(dir, state) {
  const file = path.join(dir, 'broker.lock');
  if (!fs.existsSync(file)) return;
  if (!state || state.active !== null || state.blocked || state.controlBlocked || state.localUnknown || state.lease ||
      Object.values(state.jobs || {}).some(job => !terminal.has(job.state))) {
    fail('RESET_RECOVERY_BUSY', 'A stale broker cannot be reclaimed while queue work is active, queued or unresolved.');
  }
  const owner = readJson(file);
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.birth !== 'string' || typeof owner.nonce !== 'string') {
    fail('BROKER_RECLAIM_UNPROVEN', 'The stale broker marker has an invalid process identity.');
  }
  let alive;
  try { alive = processBirth(owner.pid) === owner.birth; }
  catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) alive = false; else throw error; }
  if (alive) fail('BROKER_ALIVE', 'The broker process is still alive; reset recovery will not reclaim its marker.');
  const lifecycle = readJson(path.join(dir, `broker-lifecycle-${owner.nonce}.json`));
  if (lifecycle.owner?.pid !== owner.pid || lifecycle.owner?.birth !== owner.birth || lifecycle.owner?.nonce !== owner.nonce ||
      !['starting', 'ready', 'recovery', 'rejected'].includes(lifecycle.stage)) {
    fail('BROKER_RECLAIM_UNPROVEN', 'The stale broker marker has no matching lifecycle record.');
  }
  require('./queue-broker').reclaim(dir);
  if (fs.existsSync(file)) fail('BROKER_RECLAIM_UNPROVEN', 'The stale broker ownership marker remains after reclamation.');
}

function releaseResetPause(dir, markerFile, marker) {
  if (readJson(markerFile).nonce !== marker.nonce) fail('RESET_OWNERSHIP_CHANGED', 'The reset marker changed before releasing its pause.');
  const state = new QueueState(dir);
  if (state.data.active !== null || state.data.blocked || state.data.controlBlocked || state.data.localUnknown || state.data.lease ||
      Object.values(state.data.jobs).some(job => !terminal.has(job.state))) {
    fail('RESET_RECOVERY_BUSY', 'Reset cannot reopen the queue while any job is queued or unresolved.');
  }
  if (state.data.paused) {
    if (!ownsPersistedResetPause(marker, state.data)) {
      fail('RESET_PAUSE_UNOWNED', 'The queue pause cannot be attributed to this Fusion reset.');
    }
    marker.phase = 'unpausing';
    durable(markerFile, marker);
    state.pause(false, `fusion-reset-resume:${marker.nonce}`);
  } else if (!['unpausing', 'queue-unpaused'].includes(marker.phase)) {
    fail('RESET_PAUSE_UNOWNED', 'The queue was already open; no reset-owned pause could be confirmed.');
  }
  marker.phase = 'queue-unpaused';
  durable(markerFile, marker);
}

async function recoverInterruptedReset(cfg, client, deps, markerFile, staleMarker) {
  const dir = client.dir;
  let ownerAlive;
  try { ownerAlive = processBirth(staleMarker.pid) === staleMarker.birth; }
  catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) ownerAlive = false; else throw error; }
  if (ownerAlive) fail('FUSION_RESET_IN_PROGRESS', 'The previous reset owner is still alive; no recovery was attempted.');
  const brokerFile = path.join(dir, 'broker.lock');
  const oldIdentity = readJson(path.join(dir, 'instance.json')).instance;
  const oldProcess = readFusionProcess(staleMarker.fusion?.pid, deps.execFileSync);
  const oldFusionAlive = !!(oldProcess && oldProcess.birth === staleMarker.fusion?.birth);
  const state = readJson(path.join(dir, 'queue-state.json'), 128 * 1024 * 1024);
  if (oldFusionAlive) fail('RESET_RECOVERY_BUSY', 'The original Fusion process is still alive; recovery will not adopt another instance.');
  const processes = listFusionProcesses(deps.execFileSync);
  if (processes.length !== 1) fail('FUSION_INSTANCE_AMBIGUOUS', 'Reset recovery requires exactly one Fusion360 process.');
  const replacement = processes[0];
  reclaimDeadResetBroker(dir, state);
  const latestState = readJson(path.join(dir, 'queue-state.json'), 128 * 1024 * 1024);
  const verifiedReplacement = validateResetRecovery(staleMarker, latestState, oldIdentity, ownerAlive,
    fs.existsSync(brokerFile), replacement);

  const claimFile = path.join(dir, 'fusion-reset-recovery.lock');
  const claim = { pid: process.pid, birth: processBirth(), nonce: randomUUID(), previousNonce: staleMarker.nonce };
  durable(claimFile, claim, true);
  const marker = { protocol: 1, pid: claim.pid, birth: claim.birth, nonce: claim.nonce,
    buildHash: buildHash(), fusion: staleMarker.fusion, recoveredFrom: staleMarker.nonce,
    resetPause: staleMarker.resetPause, phase: staleMarker.phase || 'prepared', at: staleMarker.at };
  try {
    const current = readJson(markerFile);
    if (current.nonce !== staleMarker.nonce || fs.existsSync(brokerFile)) {
      fail('RESET_OWNERSHIP_CHANGED', 'Reset ownership changed before recovery could claim it.');
    }
    try {
      if (processBirth(current.pid) === current.birth) fail('FUSION_RESET_IN_PROGRESS', 'The previous reset process is still alive.');
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    const latestState = readJson(path.join(dir, 'queue-state.json'), 128 * 1024 * 1024);
    const latestProcesses = listFusionProcesses(deps.execFileSync);
    validateResetRecovery(current, latestState, readJson(path.join(dir, 'instance.json')).instance,
      false, fs.existsSync(brokerFile), latestProcesses.length === 1 ? latestProcesses[0] : null);
    durable(markerFile, marker);
  } finally {
    const currentClaim = readJson(claimFile);
    if (currentClaim.nonce === claim.nonce) fs.unlinkSync(claimFile);
  }

  try {
    releaseResetPause(dir, markerFile, marker);
    const status = await startBroker(client, cfg, marker, null);
    const identity = readJson(path.join(dir, 'instance.json')).instance;
    if (identity?.pid !== verifiedReplacement.pid || identity.birth !== verifiedReplacement.birth || identity.version !== oldIdentity.version) {
      fail('PROCESS_IDENTITY_MISMATCH', 'Replacement broker did not observe the responsive Fusion process.');
    }
    const running = status.control;
    removeResetMarker(markerFile, marker.nonce);
    const smokeJob = await queueReadinessJob(client, cfg);
    const after = await client.call('status');
    if (after.control?.instanceId !== running.instanceId || after.control.phase !== 'RUNNING' || after.control.unresolved || after.blocked || after.held) {
      fail('BROKER_NOT_READY', 'Recovered broker did not accept and complete a queue job.');
    }
    return { reset: true, forced: true, recoveredInterruptedReset: true,
      fusion: { previous: { pid: staleMarker.fusion.pid, birth: staleMarker.fusion.birth },
        current: { pid: verifiedReplacement.pid, birth: verifiedReplacement.birth, version: identity.version } },
      preservedSavedDocuments: oldIdentity.documents.filter(document => document.isSaved && !document.isModified)
        .map(document => ({ id: document.id, fileId: document.fileId })),
      broker: { instanceId: after.control.instanceId, phase: after.control.phase, smokeJobId: smokeJob.id } };
  } finally {
    try {
      const current = readJson(markerFile);
      if (current.nonce === marker.nonce) {
        const running = await client.call('status');
        if (running.control?.phase === 'RUNNING' && !running.control.unresolved && !running.blocked && !running.held) {
          fs.unlinkSync(markerFile);
        }
      }
    } catch { /* Keep the marker if readiness or ownership is uncertain. */ }
  }
}

async function fusionReset(argv, deps = {}) {
  parse(argv);
  const { cfg } = deps.loadConfig({});
  if (cfg.routing !== 'queue' || cfg.queue?.autoStart === false) {
    fail('QUEUE_REQUIRED', 'Fusion reset requires queue routing with broker auto-start enabled so the replacement broker can be verified.');
  }
  const client = new QueueClient(`fusion-reset:${process.pid}:${randomUUID()}`, { cfg });
  const markerFile = path.join(client.dir, 'fusion-reset.lock');
  if (fs.existsSync(markerFile)) {
    const staleMarker = readJson(markerFile);
    let ownerAlive;
    try { ownerAlive = processBirth(staleMarker.pid) === staleMarker.birth; }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) ownerAlive = false; else throw error; }
    if (ownerAlive) fail('FUSION_RESET_IN_PROGRESS', 'Another reset process still owns the broker directory.');
    return recoverInterruptedReset(cfg, client, deps, markerFile, staleMarker);
  }
  await client.register({ autoStart: false });
  const status = await client.call('status');
  validateQueue(status);
  const { createBrokerControl } = require('./dist/core/application/broker-control');
  const { createBrokerControlPort } = require('./dist/node-adapters/broker-ipc/control');
  const port = createBrokerControlPort(client, {
    async reset(fence) {
      const current = await client.call('status');
      if (current.control?.instanceId !== fence.instanceId) fail('INSTANCE_CHANGED', 'Broker changed before the explicit Fusion reset.');
      if (current.control.generation !== fence.expectedGeneration) fail('STATE_CONFLICT', 'Control generation changed before the explicit Fusion reset.');
      validateQueue(current);
      return performReset(cfg, client, deps, current);
    },
  });
  return createBrokerControl(port).execute('reset', { requestId: randomUUID(),
    instanceId: status.control.instanceId, expectedGeneration: status.control.generation });
}

async function performReset(cfg, client, deps, status) {
  const markerFile = path.join(client.dir, 'fusion-reset.lock');

  const initial = await queuePython(client, cfg, `import adsk.core as _core, json as _json, os as _os
_app = _core.Application.get()
_rows = []
for _doc in _app.documents:
    _design = _doc.design
    _root = _design.rootComponent if _design else None
    _rows.append(dict(id=_doc.creationId, name=_doc.name, saved=bool(_doc.isSaved), modified=bool(_doc.isModified),
        fileId=_doc.dataFile.id if _doc.isSaved else None,
        bodies=_root.bRepBodies.count if _root else 0, sketches=_root.sketches.count if _root else 0,
        occurrences=_root.occurrences.count if _root else 0,
        timeline=_design.timeline.count if _design else 0,
        userParameters=_design.userParameters.count if _design else 0))
print(_json.dumps(dict(pid=_os.getpid(), version=_app.version, documents=sorted(_rows, key=lambda _row: _row['id']))))`,
    'Read-only Fusion document inventory before reset');
  let inventory = initial.value;
  if (!inventory || !Number.isSafeInteger(inventory.pid) || typeof inventory.version !== 'string') fail('DOCUMENT_INVENTORY_INVALID', 'Fusion process identity is incomplete.');
  let plan = planDocuments(inventory.documents);
  const closedFixtureIds = [];

  if (plan.closeIds.length) {
    const closed = await queuePython(client, cfg, pythonInventoryCode(inventory.documents, plan.closeIds, inventory.pid),
      'Close only verified unsaved FMCAD test fixtures');
    if (closed.value.pid !== inventory.pid || !Array.isArray(closed.value.closed) ||
        closed.value.closed.length !== plan.closeIds.length || closed.value.closed.some(id => !plan.closeIds.includes(id))) {
      fail('FIXTURE_CLEANUP_UNCONFIRMED', 'Fusion did not confirm closing exactly the approved test fixtures. No process was stopped.');
    }
    closedFixtureIds.push(...closed.value.closed);
    inventory = { pid: closed.value.pid, version: closed.value.version, documents: closed.value.documents };
    plan = planDocuments(inventory.documents);
    if (plan.closeIds.length) fail('FIXTURE_CLEANUP_UNCONFIRMED', 'A test fixture remained open after its close confirmation.');
  }

  status = await client.call('status');
  validateQueue(status);
  const identityRecord = readJson(path.join(client.dir, 'instance.json'));
  if (identityRecord.buildHash !== status.buildHash || identityRecord.instance?.pid !== inventory.pid ||
      identityRecord.instance?.version !== inventory.version) {
    fail('PROCESS_IDENTITY_MISMATCH', 'The live Fusion identity does not match the broker’s current observed instance.');
  }
  const oldProcess = validateProcess(identityRecord.instance, readFusionProcess(inventory.pid, deps.execFileSync));
  const oldStatus = status;
  const marker = { protocol: 1, pid: process.pid, birth: processBirth(), nonce: randomUUID(),
    buildHash: status.buildHash, fusion: { pid: oldProcess.pid, birth: oldProcess.birth, path: oldProcess.path },
    resetPause: null, phase: 'prepared', at: new Date().toISOString() };
  durable(markerFile, marker, true);
  let fusionStopAttempted = false;
  const savedDeliverables = inventory.documents.filter(document => document.saved).map(document => ({ id: document.id, fileId: document.fileId }));
  try {
    await stopBroker(client, marker, oldStatus);

    const now = readFusionProcess(oldProcess.pid, deps.execFileSync);
    validateProcess(identityRecord.instance, now);
    fusionStopAttempted = true;
    stopFusion(oldProcess, deps.execFileSync);
    await waitForProcess(oldProcess.pid, oldProcess.birth, { exec: deps.execFileSync });

    startFusion(oldProcess.path, deps.execFileSync);
    const newProcess = await waitForNewFusion(oldProcess, { exec: deps.execFileSync });

    releaseResetPause(client.dir, markerFile, marker);
    const replacement = await startBroker(client, cfg, marker, oldStatus);
    const newIdentity = readJson(path.join(client.dir, 'instance.json')).instance;
    if (!newIdentity || newIdentity.pid !== newProcess.pid || newIdentity.birth !== newProcess.birth ||
        newIdentity.version !== inventory.version) {
      fail('PROCESS_IDENTITY_MISMATCH', 'The replacement broker did not observe the exact new Fusion PID/birth/version.');
    }
    const running = replacement.control;
    removeResetMarker(markerFile, marker.nonce);

    const smokeJob = await queueReadinessJob(client, cfg);
    const after = await client.call('status');
    if (after.control?.instanceId !== running.instanceId || after.control.phase !== 'RUNNING' || after.control.unresolved || after.blocked || after.held) {
      fail('BROKER_NOT_READY', 'Post-reset broker status is not clean and RUNNING.');
    }
    return { reset: true, forced: true, fusion: { previous: { pid: oldProcess.pid, birth: oldProcess.birth },
      current: { pid: newProcess.pid, birth: newProcess.birth, version: newIdentity.version } },
      closedTestFixtures: closedFixtureIds,
      preservedSavedDocuments: savedDeliverables,
      broker: { instanceId: after.control.instanceId, phase: after.control.phase, smokeJobId: smokeJob.id } };
  } catch (error) {
    // If Fusion was not stopped, restore the queue against the original instance.
    if (!fusionStopAttempted) {
      try {
        await restoreBroker(client, cfg, marker);
        if (fs.existsSync(markerFile)) removeResetMarker(markerFile, marker.nonce);
      } catch (restoreError) {
        error.restoreError = restoreError.message;
      }
    } else if (fusionStopAttempted) {
      // Restore the broker against whichever exact Fusion process survived or started.
      try {
        const recoveredProcess = await recoverFusion(oldProcess, deps.execFileSync);
        if (recoveredProcess.birth !== oldProcess.birth) releaseResetPause(client.dir, markerFile, marker);
        await restoreBroker(client, cfg, marker);
        const restoredIdentity = readJson(path.join(client.dir, 'instance.json')).instance;
        if (restoredIdentity?.pid !== recoveredProcess.pid || restoredIdentity.birth !== recoveredProcess.birth) {
          fail('PROCESS_IDENTITY_MISMATCH', 'Queue restoration did not bind to the surviving/replacement Fusion process.');
        }
        if (fs.existsSync(markerFile)) removeResetMarker(markerFile, marker.nonce);
        error.recoveredFusionPid = recoveredProcess.pid;
      } catch (restoreError) { error.restoreError = restoreError.message; }
    }
    throw error;
  }
}

module.exports = { descriptor, parse, validateQueue, isOwnedFixture, planDocuments, pythonInventoryCode,
  readFusionProcess, validateProcess, validateResetRecovery, releaseResetPause, ownsResetPause,
  ownsPersistedResetPause, stopBroker, restoreBroker, fusionReset, manuals };
