import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
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

test("added queue help entries resolve offline without starting a client", async () => {
  const { main } = load("../../src/cli") as {
    main(
      argv: string[],
      dependencies: Record<string, unknown>,
    ): Promise<number>;
  };
  for (const command of [
    "transition-backend",
    "authorize-normal-successor",
    "authorize-normal-currentfacts-retry",
    "retire-normal-currentfacts-producer",
    "record-normal-producers-retired",
    "retire-normal-metadata-producer",
  ]) {
    let stdout = "";
    let stderr = "";
    const code = await main(["queue", command, "--help"], {
      stdout: {
        write: (text: string) => {
          stdout += text;
        },
      },
      stderr: {
        write: (text: string) => {
          stderr += text;
        },
      },
      loadConfig: () => assert.fail("help must not load configuration"),
      createFmcad: () => assert.fail("help must not create a client"),
      setExitCode: () => {},
    });
    assert.equal(code, 0, command);
    assert.equal(stderr, "", command);
    assert.ok(stdout.includes(command), command);
    assert.ok(stdout.includes("--confirm-ownership"), command);
  }
});

test("prepared status preserves observation and identity guards after source selection", () => {
  const { buildCadScript } = load("../../src/cad") as {
    buildCadScript(
      operation: string,
      data: Record<string, unknown>,
      context: Record<string, string>,
    ): string;
  };
  const pins = {
    doc: "Synthetic Model",
    docId: "creation-fixture",
    docFileId: "urn:fixture:file",
    projectId: "project-fixture",
  };
  for (const [modified, override, error] of [
    [false, {}, null],
    [true, {}, null],
    [false, { docId: "foreign-creation" }, "doc-id mismatch"],
    [false, { docFileId: "urn:foreign:file" }, "doc-file-id mismatch"],
    [false, { projectId: "foreign-project" }, "expected one match, found 0"],
  ] as const) {
    const script = buildCadScript("status", {}, { ...pins, ...override });
    const child = spawnSync(
      "python3",
      ["-I", "-B", "tests/fixtures/refactor-baseline/status-observation.py"],
      {
        cwd: root,
        input: JSON.stringify({ script, modified }),
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const observation = data.record(JSON.parse(child.stdout));
    assert.equal(observation["activeUnchanged"], true);
    assert.equal(observation["additionalSaves"], 0);
    assert.equal(observation["modified"], modified);
    assert.equal(observation["documentCount"], 2);
    if (error) {
      assert.equal(data.record(observation["error"])["type"], "ValueError");
      assert.ok(
        data.text(data.record(observation["error"])["message"]).includes(error),
      );
      assert.equal(observation["stdout"], "");
      continue;
    }
    assert.equal(observation["error"], null);
    const lines = data.text(observation["stdout"]).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(
      lines[0],
      'FMCAD_PROGRESS {"operation": "status", "document": "Synthetic Model", "state": "started"}',
    );
    assert.ok(lines[1]!.startsWith("FMCAD_RESULT "));
    assert.deepEqual(JSON.parse(lines[1]!.slice("FMCAD_RESULT ".length)), {
      success: true,
      operation: "status",
      document: pins.doc,
      created: [],
      result: {
        document: { name: pins.doc, isModified: modified },
        counts: {
          componentDefinitions: 1,
          occurrences: 0,
          bodyDefinitions: 0,
          sketchDefinitions: 0,
          featureDefinitions: 0,
          parameters: 0,
          timelineItems: 0,
        },
        issues: [],
        observedHealth: "noReportedIssues",
        acceptance: "notEvaluated",
        limitations: [
          "Pure observation; no activation or recompute. Cached health may be stale.",
          "Definition counts are not assembly instance quantities. Snapshot is not full topology or a geometry equivalence proof.",
        ],
      },
    });
  }
});

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
