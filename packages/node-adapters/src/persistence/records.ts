import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExecutionSnapshotStore } from "../../../core/src/ports/execution-store";

export function failure(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function syncDirectory(directory: string, io = fs): void {
  const fd = io.openSync(directory, "r");
  try {
    io.fsyncSync(fd);
  } finally {
    io.closeSync(fd);
  }
}

/** No replacement for exclusive journals/receipts; atomic replacement for snapshots. */
export function durableBytes(
  file: string,
  bytes: string | Uint8Array,
  exclusive = false,
  io = fs,
): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let created = false;
  let primary: (Error & { cleanupErrors?: unknown[] }) | undefined;
  try {
    const fd = io.openSync(temporary, "wx", 0o600);
    created = true;
    try {
      io.writeFileSync(fd, bytes);
      io.fsyncSync(fd);
    } finally {
      io.closeSync(fd);
    }
    if (exclusive) io.linkSync(temporary, file);
    else io.renameSync(temporary, file);
    syncDirectory(path.dirname(file), io);
  } catch (error) {
    primary = error as Error;
    throw error;
  } finally {
    if (created) {
      try {
        io.unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          if (!primary) throw error;
          (primary.cleanupErrors ??= []).push(error);
        }
      }
    }
  }
}

export function durable(
  file: string,
  value: unknown,
  exclusive = false,
  io = fs,
): void {
  durableBytes(file, JSON.stringify(value), exclusive, io);
}

export function readBytes(
  file: string,
  maxBytes: number,
  io = fs,
  expectedPath?: string,
  allowGrowth = false,
): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    failure("INVALID_LIMIT", "Read limit must be a positive safe integer");
  const fd = io.openSync(
    file,
    io.constants.O_RDONLY | io.constants.O_NOFOLLOW | io.constants.O_NONBLOCK,
  );
  try {
    // Linux is the supported broker host. Verify the opened inode's path too:
    // component checks alone can race a parent-directory symlink substitution.
    if (expectedPath && process.platform === "linux") {
      let openedPath: string;
      try {
        openedPath = io.realpathSync(`/proc/self/fd/${fd}`);
      } catch (cause) {
        // The file was opened. Missing verification evidence is not a missing
        // artifact and must never be converted to null by an owning store.
        throw Object.assign(
          new Error("Cannot verify opened artifact path", { cause }),
          { code: "STORAGE_UNAVAILABLE" },
        );
      }
      if (openedPath !== expectedPath)
        failure(
          "INVALID_ARTIFACT",
          "Opened artifact escaped its verified directory",
        );
    }
    const stat = io.fstatSync(fd);
    if (!stat.isFile())
      failure("CORRUPT_STATE", "Record must be a regular file");
    if (stat.size > maxBytes)
      failure("CORRUPT_STATE", "Record exceeds supported read limit");
    // A bounded read also limits concurrent growth after fstat.
    const bytes = Buffer.alloc(
      Math.min(stat.size + (allowGrowth ? 0 : 1), maxBytes + 1),
    );
    let length = 0;
    while (length < bytes.length) {
      const count = io.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maxBytes || length !== stat.size)
      failure("CORRUPT_STATE", "Record changed while reading");
    return bytes.subarray(0, length);
  } finally {
    io.closeSync(fd);
  }
}

export function readJson(
  file: string,
  maxBytes = 16 * 1024 * 1024,
  io = fs,
): unknown {
  return JSON.parse(readBytes(file, maxBytes, io).toString("utf8")) as unknown;
}

/** A pending marker survives an ambiguous rename/fsync. Recovery is explicit. */
export function createSnapshotStore(
  directory: string,
  io = fs,
): ExecutionSnapshotStore {
  directory = path.resolve(directory);
  const created = io.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (io.lstatSync(directory).isSymbolicLink())
    failure("CORRUPT_STATE", "Queue directory must not be a symlink");
  io.chmodSync(directory, 0o700);
  if (created) {
    for (let current = directory; ; current = path.dirname(current)) {
      syncDirectory(path.dirname(current), io);
      if (current === created || current === path.dirname(current)) break;
    }
  }
  const file = path.join(directory, "queue-state.json");
  const pending = path.join(directory, "queue-state.pending.json");
  const hasPending = (): boolean => {
    try {
      io.lstatSync(pending);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  let fault = false;
  return {
    restore() {
      if (hasPending())
        failure(
          "STORAGE_UNAVAILABLE",
          "Unresolved snapshot durability fault; inspect pending journal before recovery",
        );
      try {
        return readBytes(file, 128 * 1024 * 1024, io).toString("utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        failure(
          "CORRUPT_STATE",
          `Cannot restore queue snapshot: ${(error as Error).message}`,
        );
      }
    },
    commit(serialized) {
      if (fault || hasPending())
        failure(
          "STORAGE_UNAVAILABLE",
          "Snapshot store requires explicit recovery",
        );
      try {
        durable(
          pending,
          { version: 1, snapshot: "queue-state.json", recoveryRequired: true },
          true,
          io,
        );
        durableBytes(file, serialized, false, io);
        io.unlinkSync(pending);
        syncDirectory(directory, io);
      } catch (error) {
        fault = true;
        // If removal of the pending marker was itself uncertain, restore it.
        // Do not overwrite any journal that may already contain recovery evidence.
        try {
          if (!hasPending())
            durable(
              pending,
              {
                version: 1,
                snapshot: "queue-state.json",
                recoveryRequired: true,
              },
              true,
              io,
            );
        } catch {
          /* The original I/O failure remains authoritative; never report success. */
        }
        failure(
          "STORAGE_UNAVAILABLE",
          `Durability is uncertain; reopen and reconcile: ${(error as Error).message}`,
        );
      }
    },
  };
}
