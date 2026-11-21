import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  validateAtomicHistory,
  type AtomicReport,
} from "../../../core/src/application/cad/atomic";
import { hash as canonicalHash } from "../../../core/src/application/cad/json";
import { failure as fail } from "./records";
const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const same = (left: unknown, right: unknown): boolean =>
  canonicalHash(left) === canonicalHash(right);
const errorCode = (value: unknown): unknown =>
  value !== null && typeof value === "object" && "code" in value
    ? value.code
    : undefined;
const maxReportFiles = 128;
const maxReportFileBytes = 16 * 1024 * 1024;
const maxReportHistoryBytes = 32 * 1024 * 1024;
export interface AtomicFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  sha256: string;
}
export interface AtomicReportSnapshot {
  dir: string;
  directory: { dev: number; ino: number };
  lock: AtomicFileIdentity | null;
  files: (AtomicFileIdentity & { name: string })[];
  fingerprint: string;
}
export interface AtomicValidatedReportSnapshot extends AtomicReportSnapshot {
  report: AtomicReport;
}
function reportFiles(root: string) {
  const names = fs
    .readdirSync(root)
    .filter((name) => /^\d{8}\.json$/.test(name))
    .sort();
  if (
    !names.length ||
    names.some(
      (name, index) => name !== `${String(index).padStart(8, "0")}.json`,
    )
  ) {
    fail(
      "WORKFLOW_RECEIPT_INCOMPLETE",
      "Atomic report history is missing or noncontiguous",
    );
  }
  if (names.length > maxReportFiles)
    fail(
      "WORKFLOW_RECEIPT_TOO_LARGE",
      "Atomic report history exceeds the bounded observation limit",
    );
  let totalBytes = 0;
  return names.map((name) => {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > maxReportFileBytes
    ) {
      fail(
        "WORKFLOW_RECEIPT_UNSAFE",
        "Atomic report contains a non-regular or oversized journal entry",
      );
    }
    totalBytes += stat.size;
    if (totalBytes > maxReportHistoryBytes)
      fail(
        "WORKFLOW_RECEIPT_TOO_LARGE",
        "Atomic report history exceeds the bounded observation limit",
      );
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    let bytes;
    try {
      const opened = fs.fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== stat.dev ||
        opened.ino !== stat.ino ||
        opened.size !== stat.size
      )
        fail(
          "WORKFLOW_REPORT_CHANGED",
          "Atomic report entry changed while it was being read",
        );
      bytes = fs.readFileSync(fd);
      const after = fs.lstatSync(file);
      if (
        after.isSymbolicLink() ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size
      )
        fail(
          "WORKFLOW_REPORT_CHANGED",
          "Atomic report entry changed while it was being read",
        );
    } finally {
      fs.closeSync(fd);
    }
    return {
      name,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: digest(bytes),
      bytes,
    };
  });
}

export async function snapshotReport(
  reportPath: string,
): Promise<AtomicValidatedReportSnapshot> {
  if (!path.isAbsolute(reportPath) || path.resolve(reportPath) !== reportPath) {
    fail(
      "WORKFLOW_REPORT_PATH",
      "Atomic report path must be canonical and absolute",
    );
  }
  let dirStat, real;
  try {
    dirStat = await fsp.lstat(reportPath);
    real = await fsp.realpath(reportPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      fail("WORKFLOW_REPORT_MISSING", "Atomic report directory is unavailable");
    throw error;
  }
  if (
    !dirStat.isDirectory() ||
    dirStat.isSymbolicLink() ||
    real !== reportPath
  ) {
    fail(
      "WORKFLOW_REPORT_PATH",
      "Atomic report directory must be a real, non-symlink directory",
    );
  }
  const lockPath = path.join(reportPath, "run.lock");
  let lock: AtomicFileIdentity | null = null;
  try {
    const stat = await fsp.lstat(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink())
      fail("WORKFLOW_LOCK_UNSAFE", "Atomic writer lock is not a regular file");
    lock = {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: digest(await fsp.readFile(lockPath)),
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") lock = null;
    else throw error;
  }
  const files = reportFiles(reportPath);
  const verifiedDir = await fsp.lstat(reportPath);
  if (
    !verifiedDir.isDirectory() ||
    verifiedDir.isSymbolicLink() ||
    verifiedDir.dev !== dirStat.dev ||
    verifiedDir.ino !== dirStat.ino
  )
    fail(
      "WORKFLOW_REPORT_CHANGED",
      "Atomic report directory changed while its history was being read",
    );
  const records = files.map((entry) =>
    JSON.parse(entry.bytes.toString("utf8")),
  );
  let report;
  try {
    report = validateAtomicHistory(records);
  } catch (error) {
    fail(
      "WORKFLOW_RECEIPT_INVALID",
      `Atomic report identity/history is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    dir: reportPath,
    directory: { dev: dirStat.dev, ino: dirStat.ino },
    lock,
    files: files.map((entry) => ({
      name: entry.name,
      dev: entry.dev,
      ino: entry.ino,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      sha256: entry.sha256,
    })),
    report,
    fingerprint: digest(
      files
        .map((file) => `${file.name}:${file.sha256}:${file.size}`)
        .join("\n"),
    ),
  };
}

export function snapshotStillCurrent(snapshot: AtomicReportSnapshot): boolean {
  try {
    const directory = fs.lstatSync(snapshot.dir);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.dev !== snapshot.directory.dev ||
      directory.ino !== snapshot.directory.ino ||
      fs.realpathSync(snapshot.dir) !== snapshot.dir
    )
      return false;
    const lockPath = path.join(snapshot.dir, "run.lock");
    let lock;
    try {
      lock = fs.lstatSync(lockPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT" || snapshot.lock !== null) return false;
    }
    if (
      lock &&
      (!snapshot.lock ||
        !lock.isFile() ||
        lock.isSymbolicLink() ||
        lock.dev !== snapshot.lock.dev ||
        lock.ino !== snapshot.lock.ino ||
        lock.size !== snapshot.lock.size ||
        lock.mtimeMs !== snapshot.lock.mtimeMs ||
        digest(fs.readFileSync(lockPath)) !== snapshot.lock.sha256)
    )
      return false;
    const names = fs
      .readdirSync(snapshot.dir)
      .filter((name) => /^\d{8}\.json$/.test(name))
      .sort();
    if (
      !same(
        names,
        snapshot.files.map((file) => file.name),
      )
    )
      return false;
    return snapshot.files.every((expected) => {
      const file = path.join(snapshot.dir, expected.name);
      const stat = fs.lstatSync(file);
      return (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.dev === expected.dev &&
        stat.ino === expected.ino &&
        stat.size === expected.size &&
        stat.mtimeMs === expected.mtimeMs &&
        digest(fs.readFileSync(file)) === expected.sha256
      );
    });
  } catch {
    return false;
  }
}
