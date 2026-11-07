import fs from "node:fs";
import path from "node:path";
import type { ConsoleRow } from "@fmcad/core";

interface TaskEventPolicy<C> {
  parseLog(text: string, cfg: C): ConsoleRow;
  time(value: unknown): number;
  matches(row: ConsoleRow, task: ConsoleRow): boolean;
}
export interface TaskEventRead {
  taskId: string | undefined;
  logs: ConsoleRow[];
  sources: string[];
  bytesRead: number;
  limited: boolean;
  error: string | null;
}
export function createTaskEventAdapter<C>({
  parseLog,
  time,
  matches,
}: TaskEventPolicy<C>) {
  function readTaskEvents(
    project: string,
    task: ConsoleRow,
    cfg: C,
  ): TaskEventRead {
    const result: TaskEventRead = {
      taskId: task.id,
      logs: [],
      sources: [],
      bytesRead: 0,
      limited: false,
      error: null,
    };
    try {
      const times = [task.submittedAt, task.startedAt, task.finishedAt]
        .map(time)
        .filter(Number.isFinite);
      const first = Math.floor(Math.min(...times) / 3600000),
        last = Math.floor(Math.max(...times) / 3600000);
      const directory = path.join(project, ".cad/logs");
      let names: string[] = [];
      try {
        names = fs
          .readdirSync(directory)
          .filter((name) => /^fmcad-\d{4}-\d{2}-\d{2}_\d{2}\.log$/.test(name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      names = names
        .filter((name) => {
          const hour =
            Date.parse(
              name.slice(6, 16) + "T" + name.slice(17, 19) + ":00:00Z",
            ) / 3600000;
          return !times.length || (hour >= first && hour <= last);
        })
        .sort();
      result.limited = !times.length || names.length > 24;
      const files = [
        ".cad/logs/fmcad.log",
        ...names.slice(-24).map((name) => ".cad/logs/" + name),
        "fmcad.log",
      ];
      let remaining = 4 * 1024 * 1024;
      for (const relative of files) {
        if (!remaining) {
          result.limited = true;
          break;
        }
        let fd;
        try {
          fd = fs.openSync(
            path.join(project, relative),
            fs.constants.O_RDONLY |
              fs.constants.O_NOFOLLOW |
              fs.constants.O_NONBLOCK,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        try {
          const stat = fs.fstatSync(fd);
          if (!stat.isFile())
            throw new Error("Log source must be a regular file");
          const bytes = Buffer.alloc(
            Math.min(stat.size, remaining, 1024 * 1024),
          );
          const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
          remaining -= count;
          result.bytesRead += count;
          result.limited ||= count < stat.size;
          result.sources.push(relative);
          const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs || 0}`;
          let offset = 0;
          while (offset < count) {
            const end = bytes.indexOf(10, offset);
            if (end < 0) break;
            const row = parseLog(
              bytes.subarray(offset, end).toString("utf8"),
              cfg,
            );
            if (matches(row, task)) {
              // Match the tail reader's identity for unchanged files, avoiding duplicates.
              result.logs.push({
                ...row,
                id: `${identity}:0:${offset}`,
                sourceFile: relative,
              });
              if (result.logs.length > 200) {
                result.logs.shift();
                result.limited = true;
              }
            }
            offset = end + 1;
          }
        } finally {
          fs.closeSync(fd);
        }
      }
      if (!result.sources.length)
        result.error = "No retained log files for this task";
    } catch (error) {
      result.error =
        error instanceof Error ? error.message : "Task log read failed";
    }
    result.logs.sort(
      (a, b) => (time(a.timestamp) || 0) - (time(b.timestamp) || 0),
    );
    return result;
  }
  function createTaskEventReader(project: string, cfg: C) {
    const cache = new Map<string, { at: number; result: TaskEventRead }>();
    return (task: ConsoleRow) => {
      const key = JSON.stringify([
        task.id,
        task.requestId,
        task.state,
        task.submittedAt,
        task.startedAt,
        task.finishedAt,
      ]);
      const previous = cache.get(key),
        now = Date.now();
      if (previous && now - previous.at < (task.finishedAt ? 30000 : 2000))
        return previous.result;
      const result = readTaskEvents(project, task, cfg);
      cache.delete(key);
      cache.set(key, { at: now, result });
      if (cache.size > 32) cache.delete(cache.keys().next().value!);
      return result;
    };
  }
  return { readTaskEvents, createTaskEventReader };
}
