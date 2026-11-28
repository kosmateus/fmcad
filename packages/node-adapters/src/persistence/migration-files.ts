import * as fs from "node:fs";
import path from "node:path";
import * as crypto from "node:crypto";
import { durable, readJson } from "./records";
const hash = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");
export interface FileDigest {
  sha256: string;
  size: number;
}
export interface TreeInventory {
  version: number;
  sha256: string;
  entries: (FileDigest & { path: string })[];
}

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export function directory(dir: string) {
  const stat = fs.lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  )
    fail(
      "UNSAFE_MIGRATION_PATH",
      "Migration paths must be real directories owned by the current user",
    );
  return dir;
}

export function fileHash(file: string): FileDigest {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    fail("UNSAFE_MIGRATION_FILE", "Migration evidence must be a regular file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const digest = crypto.createHash("sha256"),
    buffer = Buffer.alloc(1024 * 1024);
  try {
    if (fs.fstatSync(fd).ino !== stat.ino)
      fail("MIGRATION_FILE_CHANGED", "Evidence changed while opening");
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)))
      digest.update(buffer.subarray(0, length));
    const after = fs.fstatSync(fd);
    if (
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.ctimeMs !== after.ctimeMs
    )
      fail("MIGRATION_FILE_CHANGED", "Evidence changed while hashing");
    return { sha256: digest.digest("hex"), size: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

export function inventory(
  root: string,
  exclude: (relative: string) => boolean = () => false,
): TreeInventory {
  directory(root);
  const entries: TreeInventory["entries"] = [];
  function walk(relative: string): void {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const rel = relative ? relative + "/" + name : name;
      if (exclude(rel)) continue;
      const file = path.join(root, rel),
        stat = fs.lstatSync(file);
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(rel);
      else entries.push({ path: rel, ...fileHash(file) });
    }
  }
  walk("");
  return { version: 1, sha256: hash(JSON.stringify(entries)), entries };
}

export function exclusive(file: string, value: unknown): unknown {
  if (fs.existsSync(file)) {
    const prior = readJson(file, 256 * 1024 * 1024);
    if (!same(prior, value))
      fail(
        "MIGRATION_RECEIPT_CONFLICT",
        "An immutable migration intent/receipt already differs",
      );
    return prior;
  }
  durable(file, value, true);
  return value;
}

export function backupTree(
  source: string,
  destination: string,
  exclude: (relative: string) => boolean = () => false,
): TreeInventory {
  const before = inventory(source, exclude);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  directory(destination);
  for (const entry of before.entries) {
    const from = path.join(source, entry.path),
      to = path.join(destination, entry.path);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(to)) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, fs.statSync(from).mode & 0o555);
      const fd = fs.openSync(to, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    if (!same(fileHash(to), { sha256: entry.sha256, size: entry.size }))
      fail(
        "BACKUP_MISMATCH",
        "Existing backup differs; no evidence was overwritten",
      );
  }
  if (!same(inventory(source, exclude), before))
    fail("BACKUP_SOURCE_CHANGED", "Source changed during immutable backup");
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
    const fd = fs.openSync(current, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  return before;
}

export function verifyTree(root: string, manifest: unknown): void {
  if (!same(inventory(root), manifest))
    fail("BACKUP_MISMATCH", "Backup inventory/digest no longer matches escrow");
}
