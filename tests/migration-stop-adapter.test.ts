import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import ts from "typescript";
interface StopModule {
  stopOwner(owner: unknown, audit: string, python?: string): unknown;
  stopOwnerPreflight(python?: string): unknown;
}
const root = process.cwd();
const file = "queue-atomic-migration-stop-330849f.js.txt";
const bytes = fs.readFileSync(path.join(root, "tests/fixtures/history", file));
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(root, "tests/fixtures/history/manifest.json"),
    "utf8",
  ),
) as Array<{ file: string; sha256: string }>;
assert.equal(
  createHash("sha256").update(bytes).digest("hex"),
  manifest.find((entry) => entry.file === file)?.sha256,
);
const typed = ts.transpileModule(
  fs.readFileSync(
    path.join(root, "packages/node-adapters/src/execution/migration-stop.ts"),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
    },
  },
).outputText;
function fixture(source: string, result: unknown) {
  const calls: unknown[] = [],
    modulePort = { exports: {} };
  vm.runInNewContext(source, {
    module: modulePort,
    exports: modulePort.exports,
    require(id: string) {
      if (id === "node:child_process")
        return {
          execFileSync(...args: unknown[]) {
            calls.push(args);
            return JSON.stringify(result);
          },
        };
      if (id.endsWith("/contracts"))
        return {
          record: (value: unknown) =>
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value),
        };
      throw new Error("Unexpected stop adapter dependency " + id);
    },
  });
  return { api: modulePort.exports as StopModule, calls };
}
test("typed pidfd adapter submits exact predecessor Python bytes, input and deadlines", () => {
  for (const preflight of [false, true]) {
    const result = preflight
      ? { pidfd: true, signal: "SIGTERM", maxAttemptsPerExecution: 2 }
      : { originalDead: true, signalsSent: 2 };
    const before = fixture(bytes.toString("utf8"), result),
      after = fixture(typed, result);
    for (const f of [before, after]) {
      const actual = preflight
        ? f.api.stopOwnerPreflight("selected-python")
        : f.api.stopOwner(
            { pid: 17, birth: "boot:tick", nonce: "owner" },
            "/private/audit",
            "selected-python",
          );
      assert.deepEqual(JSON.parse(JSON.stringify(actual)) as unknown, result);
    }
    assert.deepEqual(
      JSON.parse(JSON.stringify(after.calls)) as unknown,
      JSON.parse(JSON.stringify(before.calls)) as unknown,
    );
  }
});
test("typed pidfd adapter refuses invalid termination evidence after exactly one helper invocation", () => {
  for (const result of [
    { originalDead: false, signalsSent: 2 },
    { originalDead: true, signalsSent: 3 },
    { originalDead: true, signalsSent: -1 },
    null,
  ]) {
    const f = fixture(typed, result);
    assert.throws(() =>
      f.api.stopOwner({ pid: 17, birth: "boot:tick" }, "/private/audit"),
    );
    assert.equal(f.calls.length, 1);
  }
});
