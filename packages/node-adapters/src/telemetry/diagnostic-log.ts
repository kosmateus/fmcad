import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { redactDiagnostic } from "@fmcad/core";

export interface DiagnosticLogOptions {
  readonly directory?: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly maxPending?: number;
  readonly maxAgeMs?: number;
  readonly now?: () => number;
  readonly io?: typeof fs;
  readonly isAlive?: (pid: number) => boolean;
}

/** Disposable diagnostics only. Never use this writer for outcomes or receipts. */
export function createDiagnosticLog(
  service: string,
  options: DiagnosticLogOptions = {},
) {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(service))
    throw new Error("Invalid diagnostic service");
  const io = options.io ?? fs;
  const now = options.now ?? Date.now;
  const directory =
    options.directory ??
    join(tmpdir(), `fmcad-diagnostics-${process.getuid?.() ?? "user"}`);
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const maxFiles = options.maxFiles ?? 4;
  const maxPending = options.maxPending ?? 128;
  const maxAgeMs = options.maxAgeMs ?? 7 * 86400_000;
  if (
    ![maxBytes, maxFiles, maxPending, maxAgeMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    maxBytes < 128 ||
    maxFiles > 100 ||
    maxPending > 1024
  )
    throw new Error("Invalid diagnostic limits");
  const isAlive =
    options.isAlive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    });
  type OwnedFile = { path: string; dev: number; ino: number; bytes: number };
  const owned: OwnedFile[] = [];
  let current: OwnedFile | undefined;
  let pending = 0,
    dropped = 0,
    errors = 0,
    closed = false;
  let work = Promise.resolve();
  function safe(stat: fs.Stats): boolean {
    return (
      stat.isFile() &&
      stat.nlink === 1 &&
      (!process.getuid || stat.uid === process.getuid())
    );
  }
  function remove(file: OwnedFile): void {
    try {
      const stat = io.lstatSync(file.path);
      if (safe(stat) && stat.dev === file.dev && stat.ino === file.ino)
        io.unlinkSync(file.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  function prepare(): void {
    io.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = io.lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Unsafe diagnostic directory");
    io.chmodSync(directory, 0o700);
  }
  function cleanup(): void {
    const candidates: Array<OwnedFile & { at: number }> = [];
    const dir = io.opendirSync(directory);
    try {
      let entry: fs.Dirent | null;
      let count = 0;
      while ((entry = dir.readSync())) {
        // Do not perform an unbounded directory scan on the observation path.
        if (++count > 256) break;
        const match = entry.name.match(
          new RegExp(`^${service}-(\\d+)-(\\d+)-[a-f0-9-]{36}\\.log$`),
        );
        if (!match || !entry.isFile()) continue;
        const pid = Number(match[2]),
          at = Number(match[1]);
        if (
          !Number.isSafeInteger(pid) ||
          pid < 1 ||
          !Number.isSafeInteger(at) ||
          isAlive(pid)
        )
          continue;
        const file = join(directory, entry.name);
        const stat = io.lstatSync(file);
        if (safe(stat))
          candidates.push({
            path: file,
            dev: stat.dev,
            ino: stat.ino,
            bytes: stat.size,
            at,
          });
      }
    } finally {
      dir.closeSync();
    }
    candidates.sort((a, b) => b.at - a.at);
    for (const [index, file] of candidates.entries())
      if (index >= maxFiles || now() - file.at > maxAgeMs) remove(file);
  }
  function append(text: string): void {
    prepare();
    const bytes = Buffer.from(
      redactDiagnostic(text).slice(0, maxBytes),
      "utf8",
    ).subarray(0, maxBytes - 1);
    const record = Buffer.concat([bytes, Buffer.from("\n")]);
    if (
      !current ||
      current.bytes + record.length > maxBytes ||
      !io.existsSync(current.path)
    ) {
      cleanup();
      const file = join(
        directory,
        `${service}-${now()}-${process.pid}-${randomUUID()}.log`,
      );
      const fd = io.openSync(
        file,
        io.constants.O_CREAT |
          io.constants.O_EXCL |
          io.constants.O_WRONLY |
          io.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stat = io.fstatSync(fd);
        current = { path: file, dev: stat.dev, ino: stat.ino, bytes: 0 };
        owned.push(current);
      } finally {
        io.closeSync(fd);
      }
      while (owned.length > maxFiles) remove(owned.shift()!);
    }
    const fd = io.openSync(
      current.path,
      io.constants.O_APPEND |
        io.constants.O_WRONLY |
        io.constants.O_NOFOLLOW |
        io.constants.O_NONBLOCK,
    );
    try {
      const stat = io.fstatSync(fd);
      if (
        !safe(stat) ||
        stat.dev !== current.dev ||
        stat.ino !== current.ino ||
        stat.size + record.length > maxBytes
      )
        throw new Error("Diagnostic file identity changed");
      io.writeFileSync(fd, record);
      current.bytes = stat.size + record.length;
    } finally {
      io.closeSync(fd);
    }
  }
  return {
    directory,
    write(text: string): boolean {
      if (closed || pending >= maxPending) {
        dropped++;
        return false;
      }
      // Bound retained input before queueing. Redaction still precedes disk IO.
      const bounded = text.slice(0, Math.min(maxBytes, 8192));
      pending++;
      work = work
        .then(() => append(bounded))
        .catch(() => {
          errors++;
        })
        .finally(() => {
          pending--;
        });
      return true;
    },
    stats: () => ({ pending, dropped, errors }),
    async close(): Promise<void> {
      closed = true;
      await work;
    },
    async flush(): Promise<void> {
      await work;
    },
  };
}
