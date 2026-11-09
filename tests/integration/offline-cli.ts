import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

export type Fields = Record<string, unknown>;
export function record(value: unknown): Fields {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected CLI result object",
  );
  return value as Fields;
}
export function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "Expected CLI result list");
  return value;
}
export function text(value: unknown): string {
  assert.equal(typeof value, "string", "Expected CLI result text");
  return value as string;
}
export function number(value: unknown): number {
  assert.equal(typeof value, "number", "Expected CLI result number");
  return value as number;
}
export function at(value: unknown, ...keys: (string | number)[]): unknown {
  for (const key of keys)
    value = typeof key === "number" ? list(value)[key] : record(value)[key];
  return value;
}

/** Same CLI/timeout/nonzero semantics as the retained live helper, without document hooks. */
export function fmcad(args: string[]): Fields {
  const root = path.resolve(__dirname, "../../..");
  const result = spawnSync(
    process.execPath,
    [path.join(root, "bin/fmcad.js"), ...args, "--json", "--timeout", "60000"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 75000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error)
    throw new Error(`fmcad failed to spawn: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(
      `fmcad ${args.join(" ")} exited ${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `fmcad ${args.join(" ")} produced unparseable output\n--- stdout ---\n${result.stdout}`,
    );
  }
  return record(value);
}

/** Local analytic methods preserve blocked/unknown JSON even with a nonzero exit. */
export function local(args: string[]): Fields {
  const root = path.resolve(__dirname, "../../..");
  const result = spawnSync(
    process.execPath,
    [path.join(root, "bin/fmcad.js"), ...args, "--json"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 75000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error)
    throw new Error(`fmcad failed to spawn: ${result.error.message}`);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `fmcad ${args.join(" ")} produced unparseable output\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
  return record(value);
}

export function cad(args: string[]) {
  const root = path.resolve(__dirname, "../../..");
  const result = spawnSync(
    process.execPath,
    [path.join(root, "bin/fmcad.js"), ...args, "--json", "--timeout", "60000"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 75000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error)
    throw new Error(`fmcad failed to spawn: ${result.error.message}`);
  let json: unknown = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    /* Preserve raw diagnostics for non-JSON refusal. */
  }
  return {
    code: result.status,
    signal: result.signal,
    json,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
