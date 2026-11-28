import * as fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";

export function concurrencyLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("concurrency must be a positive safe integer");
  return value;
}

/** Includes setup and cleanup: the slot is released only when launch settles. */
export async function boundedMap<T, R>(
  values: readonly T[],
  limit: number,
  launch: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  concurrencyLimit(limit);
  const results: R[] = new Array<R>(values.length);
  let next = 0;
  const errors: unknown[] = [];
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next++;
      const value = values[index];
      // The bounds above, rather than the value, prove presence (T may be undefined).
      try {
        results[index] = await launch(value as T, index);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, worker),
  );
  if (errors.length)
    throw new AggregateError(
      errors,
      "Scheduled tasks failed after all cleanup settled",
    );
  return results;
}

/** Conservative until measured per-worker RSS is available; host free memory is not a container budget. */
export function defaultConcurrency(
  backend: "fusion" | "simulator",
  memoryBudgetBytes?: number,
  measuredWorkerBytes?: number,
  cpus = availableParallelism(),
): number {
  if (backend === "fusion") return 10;
  const cpuBudget = Math.max(1, Math.floor(cpus));
  if (memoryBudgetBytes === undefined || measuredWorkerBytes === undefined)
    return Math.min(2, cpuBudget);
  if (
    !Number.isFinite(memoryBudgetBytes) ||
    memoryBudgetBytes <= 0 ||
    !Number.isFinite(measuredWorkerBytes) ||
    measuredWorkerBytes <= 0
  )
    throw new Error("Measured memory budgets must be positive and finite");
  return Math.max(
    1,
    Math.min(cpuBudget, Math.floor(memoryBudgetBytes / measuredWorkerBytes)),
  );
}

const extensions = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".cts",
  ".mts",
  ".py",
  ".pyi",
  ".json",
]);
const ignoredDirectories = new Set([
  "node_modules",
  "dist",
  ".git",
  ".test-artifacts",
  "__pycache__",
]);

/** Deterministic source inventory: typed cases, Python, fixture data, and nested helpers. */
export function sourceHash(roots: Readonly<Record<string, string>>): string {
  const files: { name: string; file: string }[] = [];
  function walk(root: string, prefix: string, relative = ""): void {
    for (const entry of fs.readdirSync(path.join(root, relative), {
      withFileTypes: true,
    })) {
      const local = path.join(relative, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Source inventory refuses symlinks: " + local);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) walk(root, prefix, local);
      } else if (
        extensions.has(path.extname(entry.name)) &&
        !(relative === "" && /(?:-report|-probe)\.json$/.test(entry.name))
      ) {
        files.push({
          name: prefix + "/" + local.split(path.sep).join("/"),
          file: path.join(root, local),
        });
      }
    }
  }
  for (const [prefix, root] of Object.entries(roots)) walk(root, prefix);
  const hash = createHash("sha256");
  for (const entry of files.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  ))
    hash
      .update(entry.name + "\0")
      .update(fs.readFileSync(entry.file))
      .update("\0");
  return hash.digest("hex");
}

export interface ScopedTask<T> {
  readonly exclusive: boolean;
  run(): Promise<T>;
  blocked(reason: string): T;
}
/** Coordinator barrier: every earlier cleanup finishes before exclusive state is touched. */
export async function scopedMap<T>(
  tasks: readonly ScopedTask<T>[],
  limit: number,
  outcome: (result: T) => "passed" | "settled-failure" | "unsettled",
): Promise<T[]> {
  concurrencyLimit(limit);
  const results: T[] = [];
  let blocked: string | undefined;
  let index = 0;
  while (index < tasks.length) {
    if (blocked) {
      for (const task of tasks.slice(index))
        results.push(task.blocked(blocked));
      break;
    }
    const task = tasks[index]!;
    if (task.exclusive) {
      const result = await task.run();
      results.push(result);
      if (outcome(result) !== "passed")
        blocked =
          "An exclusive scenario did not establish successful restoration and cleanup";
      index++;
      continue;
    }
    let end = index + 1;
    while (end < tasks.length && !tasks[end]!.exclusive) end++;
    const batch = await boundedMap(tasks.slice(index, end), limit, (item) =>
      item.run(),
    );
    results.push(...batch);
    if (batch.some((result) => outcome(result) === "unsettled"))
      blocked =
        "An earlier scenario has unsettled cleanup; exclusive/global work is blocked";
    index = end;
  }
  return results;
}
