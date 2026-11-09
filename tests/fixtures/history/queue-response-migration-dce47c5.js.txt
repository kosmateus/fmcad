'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readJson } = require('./queue-instance');
const { resultDirectory, projectDirectory, regularDirectory } = require('./queue-response-files');
const { durableBytes, readBytes } = require('./dist/node-adapters/persistence/records');
function digest(file) {
  const bytes = readBytes(file, 128 * 1024 * 1024);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function migrateProjectResponses({ dir, project, apply = false }) {
  const stopped = () => { if (fs.existsSync(path.join(dir, 'broker.lock'))) throw new Error('Stop the broker before migrating response files'); };
  stopped(); project = fs.realpathSync(project);
  const state = readJson(path.join(dir, 'queue-state.json'), 128 * 1024 * 1024);
  const result = { project, applied: apply, files: [], skippedNonterminal: 0 };
  for (const job of Object.values(state.jobs || {})) {
    if (typeof job.request?.cwd !== 'string') continue;
    let cwd;
    try { cwd = fs.realpathSync(job.request.cwd); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const relative = path.relative(project, cwd);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
    if (projectDirectory(cwd) !== project) continue;
    if (!['succeeded', 'failed', 'cancelled', 'expired', 'completed'].includes(job.state)) { result.skippedNonterminal++; continue; }
    for (const name of ['stdout.txt', 'stderr.txt', 'rpc-result.json']) {
      const source = path.join(dir, 'jobs', job.id, name);
      if (!fs.existsSync(source)) continue;
      regularDirectory(dir, ['jobs', job.id]);
      const before = digest(source), directory = resultDirectory(job, apply), target = path.join(directory, name);
      if (fs.existsSync(target) && digest(target).sha256 !== before.sha256) throw new Error('Conflicting project response: ' + target);
      if (apply) {
        stopped();
        if (!fs.existsSync(target)) {
          durableBytes(target, readBytes(source, 128 * 1024 * 1024), true);
        }
        syncDirectory(directory); stopped();
        if (digest(source).sha256 !== before.sha256 || digest(target).sha256 !== before.sha256) throw new Error('Response changed during migration');
        fs.unlinkSync(source); syncDirectory(path.dirname(source));
      }
      result.files.push({ jobId: job.id, name, source, target, ...before });
    }
  }
  return result;
}
module.exports = { migrateProjectResponses };
