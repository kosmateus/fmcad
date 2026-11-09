import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
const root = resolve(process.cwd());
const load = createRequire(
  resolve(root, "tests/contracts/refactor-baseline.test.ts"),
);
const { capture, compare, command } = load(
  "../../scripts/refactor-baseline.ts",
) as import("../../scripts/refactor-baseline").Harness;
const data = load(
  "../../scripts/refactor-benchmark-data.ts",
) as typeof import("../../scripts/refactor-benchmark-data");
import type { Snapshot } from "../../scripts/refactor-baseline.ts";
import type { Allowance } from "../../scripts/refactor-baseline.ts";
import type {} from "../../scripts/refactor-baseline-benchmark";

const baseline: unknown = JSON.parse(
  readFileSync(
    resolve(root, "tests/fixtures/refactor-baseline/contracts.json"),
    "utf8",
  ),
);
assertSnapshot(baseline);

test("real legacy fake-backend capture matches the frozen baseline", async () => {
  const candidate = await capture(root);
  const checkoutAllowances: unknown = JSON.parse(
    readFileSync(
      resolve(
        root,
        "tests/fixtures/refactor-baseline/checkout-allowances.json",
      ),
      "utf8",
    ),
  );
  assertAllowances(checkoutAllowances);
  const active = checkoutAllowances.filter(
    (allowance) =>
      JSON.stringify(
        candidate.observations.find((x) => x.id === allowance.id)?.[
          allowance.field
        ],
      ) === JSON.stringify(allowance.after),
  );
  const migrationAllowances: unknown = JSON.parse(
    readFileSync(
      resolve(
        root,
        "tests/fixtures/refactor-baseline/migration-allowances.json",
      ),
      "utf8",
    ),
  );
  assertAllowances(migrationAllowances);
  active.push(...migrationAllowances);
  const result = compare(baseline, candidate, active);
  assert.deepEqual(result, {
    status: "pass",
    regressions: [],
    intentional: active.map((x) => `${x.id}.${x.field}: ${x.reason}`),
  });
});

for (const [name, mutate] of [
  [
    "extra SDK call",
    (s: Snapshot) => {
      s.observations.find((x) => x.id === "cad.status")!.sdkCalls++;
    },
  ],
  [
    "unknown to success",
    (s: Snapshot) => {
      const x = s.observations.find((x) => x.id === "observation.unknown")!;
      x.dto = { success: true };
    },
  ],
  [
    "document switch",
    (s: Snapshot) => {
      data.record(s.observations.find((x) => x.id === "cad.prepare")!.dto)[
        "docId"
      ] = "different";
    },
  ],
  [
    "project switch",
    (s: Snapshot) => {
      data.record(s.observations.find((x) => x.id === "cad.prepare")!.dto)[
        "projectId"
      ] = "different";
    },
  ],
  [
    "artifact change",
    (s: Snapshot) => {
      s.observations[0]!.artifacts["status.py"] = "changed";
    },
  ],
  [
    "effect change",
    (s: Snapshot) => {
      s.observations
        .find((x) => x.id === "cad.status")!
        .effects.push({ kind: "retry" });
    },
  ],
  [
    "missing fixture",
    (s: Snapshot) => {
      s.observations.pop();
    },
  ],
] as const)
  test(`comparison detects ${name}`, () => {
    const next = structuredClone(baseline);
    mutate(next);
    assert.equal(compare(baseline, next).status, "fail");
  });

test("broker-only change requires exact documented before/after and cannot waive SDK calls", () => {
  const next = structuredClone(baseline);
  const a = baseline.observations.find((x) => x.id === "mcp.response")!;
  const b = next.observations.find((x) => x.id === a.id)!;
  b.dto = { localCatalog: true };
  const allowances = [
    {
      id: a.id,
      field: "dto" as const,
      before: a.dto,
      after: b.dto,
      reason:
        "Intentional standalone MCP: local catalog replaces upstream proxy, broker-only ADR",
    },
  ];
  assert.equal(compare(baseline, next).status, "fail");
  assert.equal(compare(baseline, next, allowances).status, "pass");
  assert.equal(
    compare(baseline, baseline, allowances).status,
    "fail",
    "stale exceptions must be removed",
  );
  b.sdkCalls++;
  assert.equal(compare(baseline, next, allowances).status, "fail");
});

test("subprocess result distinguishes timeout, failure and success", () => {
  assert.equal(
    command(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], root, 25)
      .status,
    "timeout",
  );
  assert.equal(
    command(process.execPath, ["-e", "process.exit(2)"], root).status,
    "fail",
  );
  assert.equal(command(process.execPath, ["-e", ""], root).status, "pass");
});

test("comparison rejects duplicate fixtures and unsupported format rather than silently dropping data", () => {
  const duplicate = structuredClone(baseline);
  duplicate.observations.push(structuredClone(duplicate.observations[0]!));
  assert.equal(compare(baseline, duplicate).status, "fail");
  const unsupported = { ...structuredClone(baseline), version: 2 };
  // Deliberately invalid external DTO reaches the actual comparator unchanged.
  const result: unknown = Reflect.apply(compare, undefined, [
    baseline,
    unsupported,
  ]);
  assert.equal(data.record(result)["status"], "fail");
});

test("batch fixture actually observes execution, immutable artifacts, replay, and unknown stopping", () => {
  const success = baseline.observations.find(
    (x) => x.id === "batch.execute-replay",
  )!;
  const unknown = baseline.observations.find(
    (x) => x.id === "batch.unknown-no-replay",
  )!;
  assert.equal(success.sdkCalls, 2, "replay must not repeat the two SDK calls");
  assert.equal(
    data.record(data.record(success.dto)["replay"])["replayed"],
    true,
  );
  assert.equal(
    unknown.sdkCalls,
    1,
    "unknown first step prevents second step and replay",
  );
  assert.match(
    data.text(data.record(data.record(unknown.dto)["replay"])["error"]),
    /no automatic retry/,
  );
  assert.ok(
    data.array(JSON.parse(success.artifacts["report-manifest"]!)).length > 2,
  );
});

// Validate the persisted transport shape without filtering or rewriting data.
function assertSnapshot(value: unknown): asserts value is Snapshot {
  const snapshot = data.record(value);
  assert.equal(snapshot["version"], 1);
  for (const value of data.array(snapshot["observations"])) {
    const observation = data.record(value);
    data.text(observation["id"]);
    data.number(observation["sdkCalls"]);
    data.array(observation["effects"]);
    assert.ok(Object.hasOwn(observation, "dto"));
    for (const artifact of Object.values(data.record(observation["artifacts"])))
      data.text(artifact);
  }
}

function assertAllowances(value: unknown): asserts value is Allowance[] {
  for (const item of data.array(value)) {
    const allowance = data.record(item);
    data.text(allowance["id"]);
    data.text(allowance["reason"]);
    assert.ok(
      ["dto", "effects", "artifacts"].includes(data.text(allowance["field"])),
    );
    assert.ok(Object.hasOwn(allowance, "before"));
    assert.ok(Object.hasOwn(allowance, "after"));
  }
}
