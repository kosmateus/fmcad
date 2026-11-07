import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ConsoleRow } from "@fmcad/core";

interface Anchor {
  offset: number;
  hash: string;
}
export interface LogCursor {
  size: number;
  epoch: number;
  anchor: Anchor | undefined;
}
export function createLogReader<C>(
  parseLog: (text: string, cfg: C) => ConsoleRow,
) {
  return function readLogs(
    project: string,
    cfg: C,
    limit = 2000,
    byteLimit = 256 * 1024,
    tracker = new Map<string, LogCursor>(),
  ) {
    if (![limit, byteLimit].every((n) => Number.isSafeInteger(n) && n > 0))
      throw new Error("Invalid log read limit");
    limit = Math.min(limit, 20000);
    byteLimit = Math.min(byteLimit, 4 * 1024 * 1024);
    const archives: string[] = [];
    let archiveCount = 0;
    try {
      const directory = fs.opendirSync(path.join(project, ".cad/logs"));
      try {
        let entry;
        while ((entry = directory.readSync())) {
          if (
            !entry.isFile() ||
            !/^fmcad-\d{4}-\d{2}-\d{2}_\d{2}\.log$/.test(entry.name)
          )
            continue;
          archiveCount++;
          archives.push(".cad/logs/" + entry.name);
          archives.sort().reverse();
          if (archives.length > 7) archives.pop();
        }
      } finally {
        directory.closeSync();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const candidates = [".cad/logs/fmcad.log", ...archives];
    const chunks: ConsoleRow[][] = [],
      sources: string[] = [],
      seen = new Set<string>();
    let remaining = byteLimit,
      rowsRead = 0,
      truncated = archiveCount > archives.length,
      resynced = false;
    for (let candidate = 0; candidate < candidates.length; candidate++) {
      const relative = candidates[candidate]!;
      const file = path.join(project, relative);
      let fd;
      try {
        fd = fs.openSync(
          file,
          fs.constants.O_RDONLY |
            fs.constants.O_NOFOLLOW |
            fs.constants.O_NONBLOCK,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (candidate === 0 && !archives.length) candidates.push("fmcad.log");
        continue;
      }
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile())
          throw new Error("Log source must be a regular file");
        const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs || 0}`;
        seen.add(identity);
        const previous = tracker.get(identity);
        let epoch = previous?.epoch || 0;
        let reset = !!previous && stat.size < previous.size;
        const start = Math.max(0, stat.size - remaining),
          bytes = Buffer.alloc(Math.min(remaining, stat.size));
        const count = fs.readSync(fd, bytes, 0, bytes.length, start);
        remaining -= count;
        sources.push(relative);
        truncated ||= start > 0;
        let offset = 0;
        if (start) {
          const newline = bytes.indexOf(10);
          offset = newline < 0 ? count : newline + 1;
        }
        const rows: (ConsoleRow & { offset: number })[] = [];
        let next = 0,
          anchor: Anchor | undefined,
          anchorSeen = false,
          parsed = 0;
        while (offset < count) {
          const end = bytes.indexOf(10, offset);
          if (end < 0) break;
          const rawBytes = bytes.subarray(offset, end),
            position = start + offset;
          const fingerprint = createHash("sha256")
            .update(rawBytes)
            .digest("hex");
          if (previous?.anchor?.offset === position) {
            anchorSeen = true;
            reset ||= previous.anchor.hash !== fingerprint;
          }
          anchor = { offset: position, hash: fingerprint };
          const row = {
            ...parseLog(rawBytes.toString("utf8"), cfg),
            offset: position,
            sourceFile: relative,
          };
          if (rows.length < limit) rows.push(row);
          else {
            rows[next] = row;
            next = (next + 1) % limit;
          }
          parsed++;
          offset = end + 1;
        }
        if (
          previous?.anchor &&
          previous.anchor.offset >= start &&
          previous.anchor.offset < start + count &&
          !anchorSeen
        )
          reset = true;
        if (reset) {
          epoch++;
          resynced = true;
        }
        tracker.set(identity, { size: stat.size, epoch, anchor });
        const ordered =
          rows.length === limit
            ? rows.slice(next).concat(rows.slice(0, next))
            : rows;
        chunks.push(
          ordered.map(({ offset: position, ...row }) => ({
            ...row,
            id: `${identity}:${epoch}:${position}`,
          })),
        );
        rowsRead += parsed;
        truncated ||= parsed > limit;
        if (rowsRead >= limit || remaining === 0) {
          truncated ||= candidate < candidates.length - 1;
          break;
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    for (const key of tracker.keys()) if (!seen.has(key)) tracker.delete(key);
    const logs = [
      ...new Map(
        chunks
          .reverse()
          .flat()
          .map((row) => [row.id, row]),
      ).values(),
    ];
    return {
      logs: sources.length ? logs.slice(-limit) : null,
      source: sources[0] || null,
      sources,
      truncated: truncated || logs.length > limit,
      resynced,
      bytesRead: byteLimit - remaining,
    };
  };
}
