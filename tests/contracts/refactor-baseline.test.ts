const test = require("node:test") as typeof import("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { readFileSync } = require("node:fs") as typeof import("node:fs");
const { resolve } = require("node:path") as typeof import("node:path");
const { capture, compare, command } =
  require("../../scripts/refactor-baseline.ts") as import("../../scripts/refactor-baseline").Harness;
import type { Snapshot } from "../../scripts/refactor-baseline.ts";
import type { Allowance } from "../../scripts/refactor-baseline.ts";
import type {} from "../../scripts/refactor-baseline-benchmark";

const root = resolve(__dirname, "../..");
const baseline: Snapshot = JSON.parse(
  readFileSync(
    resolve(root, "tests/fixtures/refactor-baseline/contracts.json"),
    "utf8",
  ),
);

test("real legacy fake-backend capture matches the frozen baseline", async () => {
  const candidate = await capture(root);
  const checkoutAllowances: Allowance[] = JSON.parse(
    readFileSync(
      resolve(
        root,
        "tests/fixtures/refactor-baseline/checkout-allowances.json",
      ),
      "utf8",
    ),
  );
  const active = checkoutAllowances.filter(
    (allowance) =>
      JSON.stringify(
        candidate.observations.find((x) => x.id === allowance.id)?.[
          allowance.field
        ],
      ) === JSON.stringify(allowance.after),
  );
  active.push(
    ...JSON.parse(
      readFileSync(
        resolve(
          root,
          "tests/fixtures/refactor-baseline/migration-allowances.json",
        ),
        "utf8",
      ),
    ),
  );
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
      (s.observations.find((x) => x.id === "cad.prepare")!.dto as any).docId =
        "different";
    },
  ],
  [
    "project switch",
    (s: Snapshot) => {
      (
        s.observations.find((x) => x.id === "cad.prepare")!.dto as any
      ).projectId = "different";
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
  const unsupported = structuredClone(baseline);
  (unsupported as any).version = 2;
  assert.equal(compare(baseline, unsupported).status, "fail");
});

test("batch fixture actually observes execution, immutable artifacts, replay, and unknown stopping", () => {
  const success = baseline.observations.find(
    (x) => x.id === "batch.execute-replay",
  )!;
  const unknown = baseline.observations.find(
    (x) => x.id === "batch.unknown-no-replay",
  )!;
  assert.equal(success.sdkCalls, 2, "replay must not repeat the two SDK calls");
  assert.equal((success.dto as any).replay.replayed, true);
  assert.equal(
    unknown.sdkCalls,
    1,
    "unknown first step prevents second step and replay",
  );
  assert.match((unknown.dto as any).replay.error, /no automatic retry/);
  assert.ok(JSON.parse(success.artifacts["report-manifest"]!).length > 2);
});
