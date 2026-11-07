import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
type Pause =
  typeof import("../packages/node-adapters/src/execution/pause-budget");
type Timeout =
  typeof import("../packages/node-adapters/src/execution/request-timeout");
const historical = load("./tests/fixtures/historical-module.cjs") as (
  revision: string,
  source: string,
) => unknown;
const versions: Array<{ name: string; pause: Pause; timeout: Timeout }> = [
  ...[
    ["pre-refactor", "a26222ff617b0e9597b2a91b50474bdca8d0a0ce"],
    ["before extraction", "abbce68c10fd0245d4253aeebb9a6f37bf5ef035"],
  ].map(([name, revision]) => ({
    name: name!,
    pause: historical(revision!, "src/pause-budget.js") as Pause,
    timeout: historical(revision!, "src/request-timeout.js") as Timeout,
  })),
  {
    name: "typed adapters",
    pause: load("./src/pause-budget") as Pause,
    timeout: load("./src/request-timeout") as Timeout,
  },
];

for (const { name, pause, timeout } of versions) {
  test(`${name}: two pauses preserve elapsed time and ignore stale callbacks`, () => {
    let time = 0,
      expired = 0;
    const callbacks: Array<() => void> = [],
      delays: number[] = [],
      cancelled: unknown[] = [];
    const budget = new pause.PauseBudget(
      30000,
      () => {
        expired++;
      },
      {
        now: () => time,
        schedule(callback, delay) {
          callbacks.push(callback);
          delays.push(delay);
          return callbacks.length;
        },
        cancel(timer) {
          cancelled.push(timer);
        },
      },
    );
    time = 8000;
    budget.freeze();
    time += 300000;
    callbacks[0]!();
    assert.equal(expired, 0);
    assert.equal(budget.remaining(), 22000);
    budget.resume();
    time += 2000;
    budget.freeze();
    time += 900000;
    budget.resume();
    callbacks[1]!();
    assert.equal(expired, 0);
    assert.equal(budget.remaining(), 20000);
    time += 20000;
    callbacks[2]!();
    callbacks[2]!();
    assert.equal(expired, 1);
    assert.equal(budget.remaining(), 0);
    budget.close();
    assert.deepEqual(delays, [30000, 22000, 20000]);
    assert.deepEqual(cancelled, [1, 2, 3]);
  });

  test(`${name}: close during pause cannot be revived or expire later`, () => {
    let time = 0,
      expired = 0;
    const callbacks: Array<() => void> = [];
    const budget = new pause.PauseBudget(
      100,
      () => {
        expired++;
      },
      {
        now: () => time,
        schedule(callback) {
          callbacks.push(callback);
          return callbacks.length;
        },
        cancel() {},
      },
    );
    time = 20;
    budget.freeze();
    budget.freeze();
    budget.resume();
    budget.resume();
    time = 30;
    budget.freeze();
    budget.close();
    time = 10000;
    budget.resume();
    callbacks.forEach((callback) => callback());
    assert.equal(budget.remaining(), 70);
    assert.equal(callbacks.length, 2);
    assert.equal(expired, 0);
  });

  test(`${name}: pausing one owner leaves another owner's deadline running`, () => {
    let time = 0;
    const callbacks: Array<() => void> = [],
      expired: string[] = [];
    const create = (id: string) =>
      new pause.PauseBudget(
        30000,
        () => {
          expired.push(id);
        },
        {
          now: () => time,
          schedule(callback) {
            callbacks.push(callback);
            return callbacks.length;
          },
          cancel() {},
        },
      );
    const first = create("A"),
      second = create("B");
    time = 8000;
    first.freeze();
    time = 30000;
    callbacks[1]!();
    assert.deepEqual(expired, ["B"]);
    assert.equal(first.remaining(), 22000);
    assert.equal(second.remaining(), 0);
    time = 300000;
    first.resume();
    callbacks[0]!();
    assert.deepEqual(expired, ["B"]);
    time += 22000;
    callbacks[2]!();
    assert.deepEqual(expired, ["B", "A"]);
    first.close();
    second.close();
  });

  test(`${name}: a full RPC fits at the boundary; the next request is refused before transport`, (t) => {
    let now = 1000;
    t.mock.method(process.hrtime, "bigint", () => BigInt(now) * 1000000n);
    const env = { FMCAD_EXECUTION_DEADLINE_MONOTONIC_MS: "2000" };
    let sends = 0;
    const send = () => {
      const allowance = timeout.requestTimeout({ timeoutMs: 1000 }, env);
      sends++;
      return allowance;
    };
    assert.equal(timeout.monotonicMs(), 1000);
    assert.equal(send(), 1000);
    now++;
    assert.throws(send, { code: "FMCAD_RPC_NOT_SUBMITTED_BUDGET" });
    assert.equal(sends, 1);
    for (const deadline of ["NaN", "Infinity", "-1", "999"])
      assert.throws(
        () =>
          timeout.requestTimeout(
            { timeoutMs: 1000 },
            { FMCAD_EXECUTION_DEADLINE_MONOTONIC_MS: deadline },
          ),
        /not submitted/,
      );
    for (const timeoutMs of [0, -1, NaN, Infinity])
      assert.throws(
        () => timeout.requestTimeout({ timeoutMs }, env),
        /not submitted/,
      );
    assert.throws(() => timeout.requestTimeout({}, env), /not submitted/);
    assert.equal(timeout.requestTimeout({ timeoutMs: 180000 }, {}), 180000);
    assert.equal(timeout.requestTimeout({}, {}), undefined);
  });
}

test("typed timer adapter expires through the real Node timer", async () => {
  const current = versions.at(-1)!;
  let budget: InstanceType<Pause["PauseBudget"]> | undefined;
  await new Promise<void>((resolve) => {
    budget = new current.pause.PauseBudget(1, resolve);
  });
  assert.equal(budget?.remaining(), 0);
  budget?.close();
});
