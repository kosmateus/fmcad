'use strict';

// Live integration-test helpers. These invoke the real fmcad CLI against a
// exact saved fixture from ScenarioSession and its durable owned handoff.
// Every selected case retains its original assertions; an unset FMCAD_TEST_DOC
// skips native registration, and an unowned shared name is refused before mutation.

const { spawnSync } = require('../helpers/live-broker');
const { ownedLease } = require('../../dist/tests/scenarios/legacy-handoff');
const path = require('node:path');

const ENV = 'FMCAD_TEST_DOC';
const ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'fmcad.js');
// --timeout is the MCP transport timeout flag (see tests/live-*.js); the
// spawnSync timeout is a little higher so a transport hang is reported as such.
const TRANSPORT_TIMEOUT_MS = 60000;
const SPAWN_TIMEOUT_MS = 75000;
const MAX_BUFFER = 32 * 1024 * 1024;

function hasDoc() {
  return Boolean(process.env[ENV] && String(process.env[ENV]).trim());
}

function getDoc() {
  const lease = ownedLease();
  if (!lease) throw new Error('Native integration requires an owned ScenarioSession handoff; a shared FMCAD_TEST_DOC name is not an ownership receipt.');
  return lease.document.name;
}

// Run the CLI synchronously and return raw stdout; throw on spawn failure or
// non-zero exit, always including the captured output.
function runRaw(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  if (result.error) throw new Error(`fmcad failed to spawn: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`fmcad ${args.join(' ')} exited ${result.status}\n` +
      `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
  }
  return result.stdout;
}

// Run a CAD command and parse the JSON result envelope
// { success, operation, document, result, created, ...lifted }. Appends --json
// and the transport --timeout; the caller supplies the command words and flags.
function fmcad(args) {
  const stdout = runRaw([...args, '--json', '--timeout', String(TRANSPORT_TIMEOUT_MS)]);
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new Error(`fmcad ${args.join(' ')} produced unparseable output\n--- stdout ---\n${stdout}`);
  }
}

// Run a local engineering method (mass/fluid/hydraulic) with no --doc and no
// MCP transport --timeout (both are rejected by local methods, which exit via
// the engineering-local path before global flag parsing). Returns the parsed
// envelope; does NOT throw on a nonzero exit so fail/blocked/unknown partial
// results can be asserted directly.
function local(args) {
  const result = spawnSync(process.execPath, [BIN, ...args, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  if (result.error) throw new Error(`fmcad failed to spawn: ${result.error.message}`);
  try {
    return JSON.parse(result.stdout);
  } catch (cause) {
    throw new Error(`fmcad ${args.join(' ')} produced unparseable output\n` +
      `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
  }
}

// Use the original creation receipt, never a basename or version-name guess.
function docName() {
  return getDoc();
}

// Reset the test document for the next scenario. On a saved cloud document this
// is the full in-place clear(); on an untitled/unsaved document there is no cloud
// DataFile.id so `document clear` refuses, and this is a no-op: each live test
// then relies on its own relative baseline (atomic aborts revert their own
// mutations, committed mutations accumulate and are reported as scratch).
function resetDoc() {
  const name = docName();
  const status = fmcad(['document', 'status', '--doc', name]);
  if (!status.result || !status.result.fileId) return null;
  return clear();
}

// Clean the test document. Resolves the exact open name and the cloud DataFile.id
// (document clear refuses any mismatch), clears, and asserts a cleared/all-zero
// result so the next test starts from a known-empty document.
function clear() {
  const name = docName();
  const status = fmcad(['document', 'status', '--doc', name]);
  const fileId = status.result && status.result.fileId;
  const lease = ownedLease();
  if (!lease || status.result.creationId !== lease.document.creationId || fileId !== lease.document.file.fileId ||
      status.result.projectId !== lease.document.file.projectId || status.result.folderId !== lease.document.file.folderId) {
    throw new Error("Observed document/file identity differs from the owned fixture; no clear submitted");
  }
  if (!fileId) {
    throw new Error(`document status returned no fileId for ${name}: ${JSON.stringify(status)}`);
  }
  const result = fmcad(['document', 'clear', '--doc', name,
    '--doc-file-id', fileId, '--file-id', fileId, '--confirm', 'true']);
  const body = result.result || {};
  if (result.success !== true || body.status !== 'cleared') {
    throw new Error(`document clear did not report cleared: ${JSON.stringify(result)}`);
  }
  const nonzero = Object.entries(body.after || {}).filter(([, count]) => count !== 0);
  if (nonzero.length) {
    throw new Error(`document clear left nonzero counts: ${JSON.stringify(body.after)}`);
  }
  return result;
}

// Run a native CAD command and return the parsed envelope WITHOUT throwing on a
// nonzero exit, so honest `blocked`/`fail`/`unknown` results can be asserted.
// Appends --json and the transport --timeout like fmcad(); callers supply the
// command words and flags (for local engineering methods use local() instead).
function cad(args) {
  const result = spawnSync(process.execPath,
    [BIN, ...args, '--json', '--timeout', String(TRANSPORT_TIMEOUT_MS)], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  if (result.error) throw new Error(`fmcad failed to spawn: ${result.error.message}`);
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    // Refused inputs / hard errors print a diagnostic instead of a JSON envelope.
  }
  return { code: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

// Guard for live tests: call at the top of a test with `if (skipLive(t)) return;`
// so the offline suite skips instead of failing or accidentally mutating Fusion.
function skipLive(t) {
  if (hasDoc()) {
    const lease = ownedLease();
    if (!lease || t.name !== lease.testCase) throw new Error("Legacy case does not match its owned handoff");
    return false;
  }
  t.skip(`${ENV} not set`);
  return true;
}

module.exports = { getDoc, hasDoc, docName, fmcad, cad, local, clear, resetDoc, skipLive };
