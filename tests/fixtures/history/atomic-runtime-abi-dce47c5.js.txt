'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hash, readJson, buildHash, priorProcessAlive } = require('./queue-instance');
const { queueDirectory } = require('./queue-connection');
const { resolveRuntimePaths } = require('./dist/config-platform');
const { readBytes } = require('./dist/node-adapters/persistence/records');
const { validateAtomicRuntimeSourceCompatibility } = require('./atomic-workflow-observation');
const canonicalHash = value => require('./dist/core/application/cad/json').hash(value);
const { atomicObservationIdentityHash } = require('./atomic-observation-binding');
const same = (a, b) => canonicalHash(a) === canonicalHash(b);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const optional = file => { try { return readJson(file, 128 * 1024 * 1024); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

function generatorDependency(runtimeRoot) {
  const pkg = readJson(path.join(runtimeRoot, 'package.json'));
  const file = require.resolve('jsonc-parser/package.json', { paths: [runtimeRoot] });
  const actual = readJson(file);
  if (actual.name !== 'jsonc-parser' || actual.version !== '3.3.1' ||
      pkg.dependencies?.['jsonc-parser'] && pkg.dependencies['jsonc-parser'] !== actual.version)
    fail('BUILD_CHANGED', 'Generator JSON dependency differs from the explicitly qualified adapter version');
  const root = path.dirname(file);
  return { root, sha256: require('./queue-atomic-migration-files').inventory(root).sha256 };
}

function escrowAtomicGeneratorDependencies(runtimeRoot, audit) {
  const pkg = readJson(path.join(runtimeRoot, 'package.json'));
  const file = require.resolve('jsonc-parser/package.json');
  // Standalone runtime sentinels need not declare npm dependencies. This is an
  // explicit adapter dependency, not an invented historical manifest claim.
  const version = readJson(file).version;
  if (version !== '3.3.1' || pkg.dependencies?.['jsonc-parser'] && pkg.dependencies['jsonc-parser'] !== version)
    fail('BUILD_CHANGED', 'Available generator dependency differs from the qualified adapter version');
  return { 'jsonc-parser': require('./queue-atomic-migration-files').backupTree(path.dirname(file), path.join(audit, 'node_modules/jsonc-parser')) };
}

function snapshot(file) {
  const before = fs.lstatSync(file);
  const bytes = readBytes(file, 16 * 1024 * 1024, fs, file);
  const after = fs.lstatSync(file);
  if (!after.isFile() || after.isSymbolicLink() || before.ino !== after.ino || before.dev !== after.dev ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    fail('RECEIPT_MISMATCH', 'Original source receipt changed during ABI inspection');
  return { path: file, dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, sha256: hash(bytes) };
}

function originalRuntimeRoot(job, explicit) {
  const expected = job.request.buildHash;
  const matches = root => {
    try { return path.isAbsolute(root) && fs.realpathSync(root) === root && buildHash(root) === expected; }
    catch { return false; }
  };
  if (explicit) {
    if (!matches(explicit)) fail('BUILD_CHANGED', 'Explicit original runtime does not match the sealed original build');
    return explicit;
  }
  const current = resolveRuntimePaths({ anchor: __filename }).installation;
  if (matches(current)) return current;
  const dir = queueDirectory(), owner = optional(path.join(dir, 'broker.lock'));
  if (owner && priorProcessAlive(owner) === true) {
    const command = fs.readFileSync(`/proc/${owner.pid}/cmdline`, 'utf8').split('\0');
    for (const entry of command.filter(value => /\/src\/queue-(autostart|atomic-migration)-worker\.js$/.test(value))) {
      const root = path.dirname(path.dirname(entry));
      if (matches(root)) return root;
    }
  }
  const migrations = path.join(dir, 'atomic-migrations');
  if (fs.existsSync(migrations)) for (const name of fs.readdirSync(migrations).filter(value => /^[a-f0-9]{64}$/.test(value)).sort()) {
    const audit = path.join(migrations, name), intent = optional(path.join(audit, 'intent.json'));
    if (intent?.binding?.jobId !== job.id || intent.binding.clientId !== job.clientId ||
        intent.ownerTokenHash !== job.request.ownerToken) continue;
    const paused = optional(path.join(audit, 'paused.json'));
    const backup = optional(path.join(audit, 'backup.json'));
    if (paused?.state?.jobs?.[job.id]?.hash !== job.hash || backup?.audit !== audit || backup.manifest !== 'backup-manifest.json') continue;
    const manifest = path.join(audit, backup.manifest);
    if (require('./queue-atomic-migration-files').fileHash(manifest).sha256 !== backup.sha256)
      fail('BACKUP_MISMATCH', 'Original runtime escrow manifest changed');
    const root = path.join(audit, 'runtime-backup');
    if (matches(root)) return root;
  }
  fail('ORIGINAL_RUNTIME_UNAVAILABLE', 'No sealed original runtime is available for the legacy full-program source witness');
}

function buildAtomicRuntimeAbi(job, prepared, records, { dir = queueDirectory(), originalRoot } = {}) {
  if (!Array.isArray(records) || records.length !== job.dispatch?.rpcCount || !records.length ||
      prepared.scope.jobId !== job.id || prepared.jobHash !== job.hash || prepared.originalBuildHash !== job.request.buildHash)
    fail('RECEIPT_UNAVAILABLE', 'Complete original RPC inventory and exact owned atomic job are required for ABI proof');
  const entries = [], snapshots = [];
  for (const record of [...records].sort((a, b) => String(a.binding?.rpcId) < String(b.binding?.rpcId) ? -1 :
    String(a.binding?.rpcId) > String(b.binding?.rpcId) ? 1 : 0)) {
    const binding = record.binding;
    if (!binding || binding.jobId !== job.id || binding.buildHash !== prepared.originalBuildHash ||
        !/^[a-f0-9-]{36}$/.test(binding.rpcId || '') || !/^[a-f0-9]{64}$/.test(binding.sourceHash || ''))
      fail('RECEIPT_MISMATCH', 'ABI source witness is not bound to the original job/build/RPC');
    const file = path.join(dir, 'jobs', job.id, `rpc-${binding.rpcId}.json`);
    const saved = readJson(file);
    if (!same(saved.binding, binding)) fail('RECEIPT_MISMATCH', 'Original ABI journal binding changed');
    const receipt = readJson(record.receipt);
    if (receipt.terminal !== true || !['succeeded', 'failed'].includes(receipt.outcome) ||
        !['jobId', 'rpcId', 'requestHash', 'buildHash', 'sourceHash'].every(key => receipt[key] === binding[key]))
      fail('RECEIPT_MISMATCH', 'ABI provenance requires original bound terminal transport receipts');
    snapshots.push(snapshot(file), snapshot(record.receipt));
    entries.push({ record, receipt, units: record.pythonArtifact?.units || [] });
  }
  const header = { version: 1, jobId: job.id, requestId: job.requestId, jobHash: job.hash,
    originalBuildHash: prepared.originalBuildHash, identityHash: atomicObservationIdentityHash(prepared.identity) };
  const pinned = new Set(prepared.sourceCompatibilityUnits.map(unit => unit.filename));
  const present = entries.flatMap(entry => entry.units).filter(unit => pinned.has(unit.filename));
  let proof, runtimeRoot = null, dependencies = [];
  if (new Set(present.map(unit => unit.filename)).size === pinned.size) {
    validateAtomicRuntimeSourceCompatibility(prepared, entries.map(entry => entry.units));
    proof = { ...header, kind: 'original-unit-manifest-v1', abiPinnedUnits: prepared.sourceCompatibilityUnits,
      sourceReceipts: entries.map(({ record }) => ({ rpcId: record.binding.rpcId, sourceHash: record.binding.sourceHash })) };
  } else {
    if (present.length || entries.some(({ record, units }) => units.length !== 2 ||
        units.filter(unit => unit.role === 'user' && unit.filename === '<fmcad-queue>' && unit.sha256 === record.binding.sourceHash).length !== 1 ||
        units.filter(unit => unit.role === 'wrapper' && unit.filename === '<fmcad-wire>' && unit.sha256 === record.pythonArtifact?.sha256).length !== 1))
      fail('BUILD_CHANGED', 'Missing/partial original ABI units are not a recognized legacy receipt format');
    runtimeRoot = originalRuntimeRoot(job, originalRoot);
    dependencies = [generatorDependency(runtimeRoot)];
    // Pure original code generation only: never runBatch, execute, client, SDK,
    // model read/write, report publication or replay. v1 resolve has no random UI guard.
    const oldAtomic = require(path.join(runtimeRoot, 'src/batch-atomic'));
    const oldApplication = require(path.join(runtimeRoot, 'src/dist/core/application/cad/atomic'));
    const context = prepared.expectedContext;
    const initial = { context, commandId: prepared.identity.commandId, runId: prepared.identity.runId,
      requestHash: prepared.identity.requestHash, sessionNonce: prepared.identity.sessionNonce,
      atomic: { backend: 'addin' }, documentIdentity: {
        expected: { fileId: context.docFileId, creationId: context.docId, name: context.doc },
        resolved: null, assertionsOnly: true,
      } };
    const artifact = oldAtomic.prepareAtomicScript(oldApplication.atomicRpcArgs(initial, 'atomic_resolve'));
    const sourceHash = hash(artifact.script + '\n\nrun("")\n');
    const witnesses = entries.filter(entry => entry.receipt.outcome === 'succeeded' && entry.record.binding.sourceHash === sourceHash);
    if (witnesses.length !== 1 || buildHash(runtimeRoot) !== prepared.originalBuildHash)
      fail('BUILD_CHANGED', 'Legacy ABI lacks a unique byte-exact successful original full-program witness');
    const derived = artifact.units.filter(unit => pinned.has(unit.filename))
      .map(({ id, filename, sha256 }) => ({ id, filename, sha256 }));
    validateAtomicRuntimeSourceCompatibility(prepared, [derived]);
    const oldCanonical = require(path.join(runtimeRoot, 'src/python')).cadBundleUnits(runtimeRoot)
      .filter(unit => pinned.has(unit.filename)).map(unit => ({ id: unit.id, filename: unit.filename, sha256: hash(unit.source) }));
    if (!same(oldCanonical, derived)) fail('BUILD_CHANGED', 'Reconstructed original namespace does not match sealed original ABI sources');
    const witness = witnesses[0].record;
    proof = { ...header, kind: 'legacy-full-program-witness-v1', abiPinnedUnits: derived,
      witness: { operation: 'atomic_resolve', rpcId: witness.binding.rpcId, sourceHash,
        generatorBuildHash: prepared.originalBuildHash, reconstructedBuilderArtifactHash: artifact.artifactHash,
        originalReceiptArtifactHash: witness.pythonArtifact.artifactHash },
      sourceReceipts: entries.map(({ record }) => ({ rpcId: record.binding.rpcId, sourceHash: record.binding.sourceHash })) };
  }
  return { proof, hash: canonicalHash(proof), evidence: { runtimeRoot, originalBuildHash: prepared.originalBuildHash, snapshots, dependencies } };
}

function atomicRuntimeAbiStillCurrent(abi) {
  try {
    if (!abi || canonicalHash(abi.proof) !== abi.hash) return false;
    if (abi.evidence.runtimeRoot && buildHash(abi.evidence.runtimeRoot) !== abi.evidence.originalBuildHash) return false;
    if ((abi.evidence.dependencies || []).some(value => require('./queue-atomic-migration-files').inventory(value.root).sha256 !== value.sha256)) return false;
    return abi.evidence.snapshots.every(value => same(snapshot(value.path), value));
  } catch { return false; }
}

module.exports = { buildAtomicRuntimeAbi, atomicRuntimeAbiStillCurrent, escrowAtomicGeneratorDependencies };
