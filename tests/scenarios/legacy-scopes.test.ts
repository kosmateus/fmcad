import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
const load = createRequire(path.resolve(__dirname, "../../../package.json"));
const { runBatch } = load("./tests/run-live.js") as {
  runBatch(
    names: string[],
    routing: string,
    launch: (name: string) => Promise<number>,
    concurrency: number,
  ): Promise<{ suite: string; exitCode: number; status?: string }[]>;
};

test("legacy global-state suites wait for preceding cleanup and exclude later work", async () => {
  const events: string[] = [];
  let active = 0;
  const results = await runBatch(
    ["a", "b", "motion-animation", "c", "camera-probe"],
    "queue",
    async (name) => {
      if (["motion-animation", "camera-probe"].includes(name))
        assert.equal(active, 0);
      active++;
      events.push("start:" + name);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return 0;
      } finally {
        await new Promise<void>((resolve) => setImmediate(resolve));
        events.push("clean:" + name);
        active--;
      }
    },
    10,
  );
  assert.equal(active, 0);
  assert.ok(results.every((r) => r.exitCode === 0));
  assert.ok(
    events.indexOf("start:motion-animation") > events.indexOf("clean:b"),
  );
  assert.ok(
    events.indexOf("start:c") > events.indexOf("clean:motion-animation"),
  );
  assert.ok(events.indexOf("start:camera-probe") > events.indexOf("clean:c"));
});

test("failure of an exclusive child blocks later native work with failing not-run results", async () => {
  const launched: string[] = [];
  const results = await runBatch(
    ["camera-probe", "motion-animation", "a"],
    "queue",
    async (name) => {
      launched.push(name);
      throw new Error("restoration unknown");
    },
    10,
  );
  assert.deepEqual(launched, ["camera-probe"]);
  assert.deepEqual(
    results.map((r) => r.exitCode),
    [1, 1, 1],
  );
  assert.deepEqual(
    results.slice(1).map((r) => r.status),
    ["not-run", "not-run"],
  );
});

test("required profiles account for every retained live suite and separate diagnostics", () => {
  const inventory = load("./tests/live-suite-inventory.json") as {
    entries: { id: string; model: string }[];
  };
  const manifest = load("./tests/live-required-profiles.json") as {
    nativeExecution: string;
    profiles: Record<
      string,
      { required: boolean; cases: { id: string; disposition?: string }[] }
    >;
  };
  const native = manifest.profiles["native-qualification"]!;
  const diagnostics = manifest.profiles["diagnostics"]!;
  const actual = [...native.cases, ...diagnostics.cases].map((row) => row.id);
  assert.deepEqual(
    actual.sort(),
    inventory.entries.map((row) => row.id).sort(),
  );
  assert.equal(new Set(actual).size, actual.length);
  assert.equal(native.required, true);
  assert.equal(diagnostics.required, false);
  assert.equal(manifest.nativeExecution, "deferred-until-offline-complete");
  assert.ok(
    native.cases.every((row) =>
      ["migration-pending", "native-only"].includes(row.disposition!),
    ),
  );
  assert.deepEqual(
    manifest.profiles["required-model"]!.cases.map((row) => row.id),
    [
      "foundation",
      "saved",
      "parameters",
      "documents",
      "cloud",
      "boxes",
      "attributes",
      "sketches",
      "reopen",
      "revisions",
      "rectangles",
      "transactions",
      "camera",
      "poses",
      "animation",
    ],
  );
});
