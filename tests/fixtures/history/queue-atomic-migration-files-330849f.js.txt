'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { durable, readJson, hash } = require('./queue-instance');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function directory(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
    fail('UNSAFE_MIGRATION_PATH', 'Migration paths must be real directories owned by the current user');
  return dir;
}

function fileHash(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('UNSAFE_MIGRATION_FILE', 'Migration evidence must be a regular file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  try {
    if (fs.fstatSync(fd).ino !== stat.ino) fail('MIGRATION_FILE_CHANGED', 'Evidence changed while opening');
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, length));
    const after = fs.fstatSync(fd);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs)
      fail('MIGRATION_FILE_CHANGED', 'Evidence changed while hashing');
    return { sha256: digest.digest('hex'), size: stat.size };
  } finally { fs.closeSync(fd); }
}

function inventory(root, exclude = () => false) {
  directory(root);
  const entries = [];
  function walk(relative) {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const rel = relative ? relative + '/' + name : name;
      if (exclude(rel)) continue;
      const file = path.join(root, rel), stat = fs.lstatSync(file);
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(rel);
      else entries.push({ path: rel, ...fileHash(file) });
    }
  }
  walk('');
  return { version: 1, sha256: hash(JSON.stringify(entries)), entries };
}

function exclusive(file, value) {
  if (fs.existsSync(file)) {
    const prior = readJson(file, 256 * 1024 * 1024);
    if (!same(prior, value)) fail('MIGRATION_RECEIPT_CONFLICT', 'An immutable migration intent/receipt already differs');
    return prior;
  }
  durable(file, value, true);
  return value;
}

function backupTree(source, destination, exclude = () => false) {
  const before = inventory(source, exclude);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  directory(destination);
  for (const entry of before.entries) {
    const from = path.join(source, entry.path), to = path.join(destination, entry.path);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(to)) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, fs.statSync(from).mode & 0o555);
      const fd = fs.openSync(to, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    if (!same(fileHash(to), { sha256: entry.sha256, size: entry.size }))
      fail('BACKUP_MISMATCH', 'Existing backup differs; no evidence was overwritten');
  }
  if (!same(inventory(source, exclude), before)) fail('BACKUP_SOURCE_CHANGED', 'Source changed during immutable backup');
  const directories = new Set([destination]);
  for (const entry of before.entries) {
    let current = path.dirname(path.join(destination, entry.path));
    while (current.startsWith(destination)) {
      directories.add(current);
      if (current === destination) break;
      current = path.dirname(current);
    }
  }
  for (const current of [...directories].sort((a, b) => b.length - a.length)) {
    const fd = fs.openSync(current, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  return before;
}

function verifyTree(root, manifest) {
  if (!same(inventory(root), manifest)) fail('BACKUP_MISMATCH', 'Backup inventory/digest no longer matches escrow');
}

module.exports = { directory, fileHash, inventory, exclusive, backupTree, verifyTree };
