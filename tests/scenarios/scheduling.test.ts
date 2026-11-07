import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import {
  boundedMap,
  concurrencyLimit,
  defaultConcurrency,
  sourceHash,
} from "./scheduling";

const turn = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
test("bounded scheduling waits for cleanup, retains input order and drains failures", async () => {
  const started: number[] = [],
    finish = new Map<number, () => void>();
  let active = 0,
    peak = 0;
  const running = boundedMap([0, 1, 2, 3], 2, async (value) => {
    started.push(value);
    peak = Math.max(peak, ++active);
    try {
      await new Promise<void>((resolve) => finish.set(value, resolve));
      return value;
    } finally {
      await turn();
      active--;
    }
  });
  assert.deepEqual(started, [0, 1]);
  finish.get(1)?.();
  await turn();
  await turn();
  assert.deepEqual(started, [0, 1, 2]);
  finish.get(2)?.();
  await turn();
  await turn();
  finish.get(3)?.();
  finish.get(0)?.();
  assert.deepEqual(await running, [0, 1, 2, 3]);
  assert.equal(peak, 2);
  assert.equal(active, 0);
  const drained: number[] = [];
  await assert.rejects(
    boundedMap([1, 2, 3], 1, async (value) => {
      try {
        if (value === 1) throw new Error("first failed");
        return value;
      } finally {
        drained.push(value);
      }
    }),
    AggregateError,
  );
  assert.deepEqual(drained, [1, 2, 3]);
});
test("real default is 10; simulator accounts for known resource budgets", () => {
  assert.equal(defaultConcurrency("fusion"), 10);
  assert.equal(defaultConcurrency("simulator", undefined, undefined, 9), 2);
  assert.equal(defaultConcurrency("simulator", undefined, undefined, 1), 1);
  assert.equal(defaultConcurrency("simulator", 512, 200, 9), 2);
  assert.equal(defaultConcurrency("simulator", 8192, 200, 4), 4);
  for (const bad of [0, -1, 1.5, Infinity, NaN])
    assert.throws(() => concurrencyLimit(bad));
});
test("source inventory detects typed tests, Python, nested fixtures, additions and removals", (t) => {
  const parent = path.resolve(".test-artifacts/source-inventory");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "case-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "nested"));
  fs.mkdirSync(path.join(root, ".test-artifacts"));
  for (const name of [
    "live-case.ts",
    "live-case.mts",
    "nested/helper.py",
    "nested/input.json",
  ])
    fs.writeFileSync(path.join(root, name), "initial");
  let previous = sourceHash({ tests: root });
  fs.writeFileSync(path.join(root, "live-case-report.json"), "result");
  fs.writeFileSync(
    path.join(root, ".test-artifacts/generated.py"),
    "generated",
  );
  assert.equal(sourceHash({ tests: root }), previous);
  for (const name of [
    "live-case.ts",
    "live-case.mts",
    "nested/helper.py",
    "nested/input.json",
    "new.cts",
  ]) {
    fs.writeFileSync(path.join(root, name), "changed");
    const next = sourceHash({ tests: root });
    assert.notEqual(next, previous);
    previous = next;
  }
  fs.unlinkSync(path.join(root, "new.cts"));
  assert.notEqual(sourceHash({ tests: root }), previous);
});
