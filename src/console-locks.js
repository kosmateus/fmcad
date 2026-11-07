'use strict';
const path = require('node:path');

function inspectLocks(project, { fs = require('node:fs'), now = Date.now, platform = process.platform } = {}) {
  const result = { status: 'unknown', source: platform === 'linux' ? 'linux-proc-locks' : 'passive-files',
    readAt: now(), reason: 'File existence does not establish lock ownership', entries: [], truncated: false };
  const root = path.join(path.resolve(project), '.beads', 'embeddeddolt');
  function readBounded(file, limit) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const bytes = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > limit) { result.truncated = true; throw new Error('Evidence read limit exceeded'); }
      return bytes.subarray(0, length).toString('utf8');
    } finally { fs.closeSync(fd); }
  }
  function candidate(file) {
    const entry = { path: file, status: 'unknown' };
    result.entries.push(entry);
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      entry.exists = true;
      if (!stat.isFile() || stat.isSymbolicLink()) { entry.reason = 'Not a regular evidence file'; return; }
      const dev = BigInt(stat.dev);
      entry.deviceMajor = String(((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n));
      entry.deviceMinor = String((dev & 0xffn) | ((dev >> 12n) & 0xffffff00n));
      entry.inode = String(stat.ino);
      entry.reason = 'No verified kernel advisory owner';
    } catch (error) {
      entry.exists = error.code === 'ENOENT' ? false : null;
      entry.reason = error.code === 'ENOENT' ? 'Evidence file absent; lock state remains unknown' : 'Evidence file unavailable';
    }
  }
  // Do not traverse symlinks in the standard evidence tree.
  try {
    for (const dir of [path.dirname(root), root]) {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsupported evidence directory');
    }
  } catch { result.reason = 'Standard embedded database directory unavailable'; return result; }
  candidate(path.join(root, '.lock'));
  let directory;
  try {
    directory = fs.opendirSync(root);
    let scanned = 0, databases = 0, item;
    while ((item = directory.readSync())) {
      if (++scanned > 256) { result.truncated = true; break; }
      if (!item.isDirectory() || item.isSymbolicLink()) continue;
      if (++databases > 16) { result.truncated = true; break; }
      const db = path.join(root, item.name);
      try {
        for (const dir of [db, path.join(db, '.dolt'), path.join(db, '.dolt', 'noms')]) {
          const stat = fs.lstatSync(dir);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsupported database directory');
        }
        candidate(path.join(db, '.dolt', 'noms', 'LOCK'));
      } catch { /* Missing or inaccessible database evidence never means unlocked. */ }
    }
  } catch { result.reason = 'Database directory scan unavailable'; }
  finally { if (directory) directory.closeSync(); }
  if (platform !== 'linux') { result.reason = 'Kernel lock evidence is unsupported on this host'; return result; }
  function records(text) {
    return text.split('\n').flatMap(line => {
      const match = line.match(/^\d+:\s+(POSIX|FLOCK|OFDLCK)\s+ADVISORY\s+(READ|WRITE)\s+(\d+)\s+([a-fA-F0-9]+):([a-fA-F0-9]+):(\d+)\s+/);
      if (!match) return [];
      const pid = Number(match[3]);
      if (!Number.isSafeInteger(pid) || pid <= 0) return [];
      return [{ line, kind: match[1], mode: match[2], pid, major: String(BigInt('0x' + match[4])),
        minor: String(BigInt('0x' + match[5])), inode: String(BigInt(match[6])) }];
    });
  }
  function birth(pid, boot) {
    const value = readBounded('/proc/' + pid + '/stat', 16384);
    if (!value.startsWith(pid + ' (') || value.lastIndexOf(')') < 0) throw new Error('Invalid process stat');
    const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (['Z', 'X'].includes(fields[0]) || !/^\d+$/.test(fields[19] || '')) throw new Error('Process identity unavailable');
    return boot + ':' + fields[19];
  }
  try {
    const locks = records(readBounded('/proc/locks', 1024 * 1024));
    const boot = readBounded('/proc/sys/kernel/random/boot_id', 128).trim();
    if (!/^[a-f0-9-]{36}$/i.test(boot)) throw new Error('Boot identity unavailable');
    for (const entry of result.entries) {
      if (!entry.inode) continue;
      const owners = locks.filter(lock => lock.major === entry.deviceMajor && lock.minor === entry.deviceMinor && lock.inode === entry.inode);
      for (const lock of owners) {
        try {
          const first = birth(lock.pid, boot);
          // Re-observe the same kernel row between process birth observations.
          if (!records(readBounded('/proc/locks', 1024 * 1024)).some(row => row.line === lock.line)) continue;
          if (birth(lock.pid, boot) !== first) continue;
          const latest = fs.lstatSync(entry.path, { bigint: true });
          const dev = BigInt(latest.dev);
          const major = String(((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n));
          const minor = String((dev & 0xffn) | ((dev >> 12n) & 0xffffff00n));
          if (!latest.isFile() || latest.isSymbolicLink() || String(latest.ino) !== entry.inode || major !== entry.deviceMajor || minor !== entry.deviceMinor) continue;
          entry.status = 'active';
          entry.reason = 'Kernel advisory lock with a re-observed positive PID and process birth identity';
          entry.owners ||= [];
          entry.owners.push({ pid: lock.pid, birth: first, kind: lock.kind, mode: lock.mode, source: '/proc/locks' });
        } catch { /* Races and permission errors remain unknown. */ }
      }
    }
    if (result.entries.some(entry => entry.status === 'active')) {
      result.status = 'active'; result.reason = 'At least one kernel advisory lock owner was verified at read time';
    } else result.reason = 'No verified matching advisory owner; absence of a match does not establish unlocked state';
  } catch { result.reason = 'Kernel ownership evidence unavailable or exceeds the bounded read limit'; }
  return result;
}
module.exports = { inspectLocks };
