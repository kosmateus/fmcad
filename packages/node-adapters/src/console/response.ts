import path from "node:path";
import fs from "node:fs/promises";
import { TextDecoder } from "node:util";
import { readSource } from "./bounded-read";
import type { ConsoleRow, ConsoleSnapshot } from "@fmcad/core";

interface ResponseJob extends ConsoleRow {
  request?: { cwd?: string };
}
export interface ResponseOutput {
  name: string;
  path: string;
  text?: string;
  json?: boolean;
  lines?: { text: string; tone: string }[][];
  error?: string;
}
interface ResponsePolicy {
  taskError(
    row: ConsoleRow,
    snapshot: ConsoleSnapshot,
    retained?: ConsoleRow | null,
  ): string | null;
  jsonLines(text: string): { text: string; tone: string }[][];
}
export interface ResponseReadOptions {
  dir: string;
  redact(text: string): string;
  responsePath(dir: string, job: ConsoleRow, name: string): string;
}
export function createResponseReader(policy: ResponsePolicy) {
  return async function openResponse(
    row: ConsoleRow,
    snapshot: ConsoleSnapshot,
    options: ResponseReadOptions,
  ) {
    const result: { outputs: ResponseOutput[]; error: string | null } = {
      outputs: [],
      error: null,
    };
    try {
      const invalid = policy.taskError(row || {}, snapshot);
      if (invalid) throw new Error(invalid);
      const decode = (bytes: Buffer) =>
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const saved = JSON.parse(
        decode(
          await readSource(
            path.join(options.dir, "queue-state.json"),
            64 * 1024 * 1024,
          ),
        ),
      ) as { jobs?: Record<string, ResponseJob> };
      const job = row.id ? saved.jobs?.[row.id] : undefined;
      const missing = policy.taskError(row, snapshot, job || null);
      if (missing || !job)
        throw new Error(missing || "TASK_NO_LONGER_RETAINED");
      if (
        typeof job.request?.cwd !== "string" ||
        !job.request.cwd ||
        !snapshot.project
      )
        throw new Error("TASK_PROJECT_MISMATCH");
      const project = await fs.realpath(snapshot.project),
        cwd = await fs.realpath(job.request.cwd);
      const relative = path.relative(project, cwd);
      if (
        relative === ".." ||
        relative.startsWith(".." + path.sep) ||
        path.isAbsolute(relative)
      )
        throw new Error("TASK_PROJECT_MISMATCH");
      for (const name of ["stdout.txt", "rpc-result.json", "stderr.txt"]) {
        const file = options.responsePath(options.dir, job, name);
        try {
          let text = options.redact(
            decode(await readSource(file, 1024 * 1024)),
          );
          if (!text.trim()) continue;
          let json = false;
          try {
            text = JSON.stringify(JSON.parse(text), null, 2);
            json = true;
          } catch {
            /* Preserve non-JSON output as text. */
          }
          result.outputs.push({
            name,
            path: file,
            text,
            json,
            lines: json
              ? policy.jsonLines(text)
              : text.split("\n").map((text) => [{ text, tone: "text" }]),
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            result.outputs.push({
              name,
              path: file,
              error:
                error instanceof Error ? error.message : "Response unavailable",
            });
        }
      }
      if (!result.outputs.length) result.error = "NO_RETAINED_RESPONSE";
    } catch (error) {
      result.error =
        error instanceof Error ? error.message : "Response unavailable";
    }
    return result;
  };
}
