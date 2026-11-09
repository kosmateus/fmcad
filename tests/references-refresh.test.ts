import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  ReferenceApi,
  FixtureSnapshot,
  FixtureEdge,
  FixtureDocument,
  StepPayload,
} from "./references-test-support";
const load = createRequire(
  path.join(process.cwd(), "tests/references-refresh.test.ts"),
);
test.after(load("./fixtures/fake-wsl-platform.cjs")());
const refresh = load("../src/references-refresh") as ReferenceApi;
const { hash } = load("../src/engineering-common") as {
  hash(value: unknown): string;
};
const { executeReferencesAction } = load("../src/cad") as {
  executeReferencesAction(
    client: unknown,
    action: string,
    data: unknown,
    context?: unknown,
  ): Promise<{ status: string; notStarted: boolean; error: string }>;
};

const root = { projectId: "project-1", fileId: "root-file", version: 1 };
const request = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> & { policy?: string } => ({
  schemaVersion: 1,
  phase: "plan",
  root,
  policy: "latest",
  requestId: "request-1",
  reportPath: "/tmp/references-refresh-test",
  ...overrides,
});
const doc = (
  fileId: string,
  extra: Record<string, unknown> = {},
): FixtureDocument => ({
  fileId,
  projectId: "project-1",
  version: 1,
  latestVersion: 1,
  available: true,
  modified: false,
  isComplete: true,
  readOnly: false,
  timelineAtEnd: true,
  pendingSnapshot: false,
  health: { healthy: true, status: "pass" },
  ...extra,
});
const edge = (
  ownerFileId: string,
  sourceFileId: string,
  extra: Record<string, unknown> = {},
): FixtureEdge => ({
  edgeId: `${ownerFileId}->${sourceFileId}`,
  kind: "linked",
  ownerFileId,
  ownerProjectId: "project-1",
  ownerContext: { component: "root" },
  sourceFileId,
  sourceProjectId: "project-1",
  baselineVersion: 1,
  latestVersion: 2,
  versionSource: "document_reference",
  selfReference: false,
  status: "outdated",
  ...extra,
});
const snapshot = (
  files: string[],
  edges: FixtureEdge[],
  extra: Record<string, unknown> = {},
): FixtureSnapshot => ({
  schemaVersion: 1,
  documents: files.map((file) => doc(file)),
  edges,
  graphComplete: true,
  ...extra,
});
const legacySdkFallbackPlan = (plan: ReturnType<ReferenceApi["makePlan"]>) => ({
  ...plan,
  updates: plan.updates.map((update) =>
    update.reason === "mixedOwnedDeriveAndLinkedReferences"
      ? {
          ...update,
          method: "document.updateAllReferences",
          fallback: "UpdateAllLatestCmd",
        }
      : update,
  ),
});

test("validates exact pinned roots, phase-specific confirmation, and bounded request inputs", () => {
  assert.throws(
    () => refresh.validate({ ...request(), root: { ...root, fileId: "" } }),
    /root/,
  );
  assert.throws(
    () => refresh.validate({ ...request(), phase: "apply" }),
    /confirm:true/,
  );
  assert.throws(
    () => refresh.validate({ ...request(), maxUpdates: 3, maxFiles: 2 }),
    /maxUpdates/,
  );
  assert.throws(
    () => refresh.validate({ ...request(), timeBudgetMs: 0 }),
    /timeBudgetMs/,
  );
  assert.throws(
    () => refresh.validate({ ...request(), allowedProjectIds: ["other"] }),
    /include the pinned root/,
  );
  assert.throws(
    () => refresh.validate({ ...request(), nativeFallback: "retry" }),
    /nativeFallback/,
  );
});

test("invalid returned graph shape reports the captured result keys as a known read-only failure", () => {
  let error;
  try {
    refresh.makePlan(
      { status: "failed", reason: "auditUnavailable" },
      refresh.validate(request()),
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.equal(
    (error as Error & { fmcadReadOnlyFailure?: unknown }).fmcadReadOnlyFailure,
    "references.refresh graph result shape",
  );
  assert.match((error as Error).message, /object keys=reason,status/);
});

test("traverses a diamond dependency graph once and orders shared leaf before both parents", () => {
  const data = snapshot(
    ["root-file", "left", "right", "shared"],
    [
      edge("root-file", "left"),
      edge("root-file", "right"),
      edge("left", "shared"),
      edge("right", "shared"),
    ],
  );
  const plan = refresh.makePlan(data, refresh.validate(request()));
  assert.equal(plan.order.filter((fileId) => fileId === "shared").length, 1);
  assert.ok(plan.order.indexOf("shared") < plan.order.indexOf("left"));
  assert.ok(plan.order.indexOf("shared") < plan.order.indexOf("right"));
  assert.ok(plan.order.indexOf("left") < plan.order.indexOf("root-file"));
  assert.ok(plan.order.indexOf("right") < plan.order.indexOf("root-file"));
});

test("keeps self references outside the dependency DAG and retains their edge evidence", () => {
  const self = edge("root-file", "root-file", {
    edgeId: "self-history",
    selfReference: true,
    baselineVersion: 1,
    latestVersion: 2,
    kind: "linked",
  });
  const plan = refresh.makePlan(
    snapshot(["root-file"], [self]),
    refresh.validate(request()),
  );
  assert.deepEqual(plan.order, ["root-file"]);
  assert.equal(plan.cycles.length, 0);
  assert.equal(plan.edges[0]!.status, "pinned");
  assert.equal(plan.edges[0]!.selfReference, true);
});

test("reports real cross-file cycles without mistaking historical self edges for cycles", () => {
  const cycle = snapshot(
    ["root-file", "child"],
    [edge("root-file", "child"), edge("child", "root-file")],
  );
  const plan = refresh.makePlan(cycle, refresh.validate(request()));
  assert.ok(plan.cycles.length > 0);
  assert.ok(plan.blocked.some((item) => item["reason"] === "referenceCycle"));
});

test("preserve pins the declared binding; latest snapshots the plan-time source version", () => {
  const input = snapshot(
    ["root-file", "child"],
    [edge("root-file", "child", { baselineVersion: 3, latestVersion: 4 })],
  );
  const preserve = refresh.makePlan(
    input,
    refresh.validate(request({ policy: "preserve" })),
  );
  assert.equal(preserve.edges[0]!.targetVersion, 3);
  assert.equal(preserve.edges[0]!.targetVersionSource, "preservedBaseline");
  assert.equal(preserve.edges[0]!.status, "pinned");
  assert.equal(
    preserve.updates.some((item) => item.fileId === "root-file"),
    false,
  );
  const latest = refresh.makePlan(
    input,
    refresh.validate(request({ policy: "latest" })),
  );
  assert.equal(latest.edges[0]!.targetVersion, 4);
  assert.equal(latest.edges[0]!.targetVersionSource, "planLatest");
  assert.equal(
    latest.updates.some((item) => item.fileId === "root-file"),
    true,
  );
});

test("per-edge pins are retained and older observed state is never implicitly rewound", () => {
  const sample = snapshot(
    ["root-file", "child"],
    [
      edge("root-file", "child", {
        edgeId: "edge-current",
        baselineVersion: 3,
        latestVersion: 4,
      }),
    ],
  );
  const pinned = refresh.makePlan(
    sample,
    refresh.validate(
      request({
        policy: "latest",
        pins: [{ edgeId: "edge-current", sourceFileId: "child", version: 3 }],
      }),
    ),
  );
  assert.equal(pinned.edges[0]!.status, "pinned");
  assert.equal(pinned.edges[0]!.targetVersion, 3);
  const rewind = refresh.makePlan(
    snapshot(
      ["root-file", "child"],
      [
        edge("root-file", "child", {
          edgeId: "edge-current",
          baselineVersion: 4,
          latestVersion: 4,
        }),
      ],
    ),
    refresh.validate(
      request({
        pins: [{ edgeId: "edge-current", sourceFileId: "child", version: 3 }],
      }),
    ),
  );
  assert.ok(
    rewind.blocked.some(
      (item) => item["reason"] === "edgeConflictOrOutOfScope",
    ),
  );
  assert.equal(rewind.updates.length, 0);
});

test("version getter failure remains unresolved instead of becoming current/latest", () => {
  const data = snapshot(
    ["root-file", "child"],
    [
      edge("root-file", "child", {
        baselineVersion: null,
        versionSource: "unresolved",
        getterError: "InternalValidationError : doc",
      }),
    ],
  );
  const plan = refresh.makePlan(data, refresh.validate(request()));
  assert.equal(plan.edges[0]!.status, "unresolved");
  assert.equal(plan.allIntendedReferencesCurrent, null);
  assert.equal(plan.allReferencesLatest, null);
  assert.ok(
    plan.blocked.some((row) => row["reason"] === "unresolvedReferenceVersion"),
  );
});

test("blocked step preflight retains its precise document-context evidence", () => {
  const plan = {
    documents: [{ fileId: "root", projectId: "project", version: 1 }],
    edges: [],
  };
  const snapshot = {
    status: "blocked",
    reason: "documentContextUnavailable",
    error: "exact context resolution failed",
    identity: { fileId: "root" },
  };
  assert.deepEqual(refresh.staleBeforeStep(plan, snapshot, "root"), {
    reason: "documentUnavailable",
    preflight: {
      status: "blocked",
      reason: "documentContextUnavailable",
      error: "exact context resolution failed",
      identity: { fileId: "root" },
    },
  });
});

test("uses only proved forward references; absent child document is unresolved", () => {
  const data = snapshot(["root-file"], [edge("root-file", "unreachable-file")]);
  assert.throws(
    () =>
      refresh.makePlan(
        data,
        refresh.validate(request({ scopeFileId: "unreachable-file" })),
      ),
    /reachable/,
  );
  const plan = refresh.makePlan(data, refresh.validate(request()));
  assert.equal(plan.edges[0]!.status, "unresolved");
  assert.equal(plan.graphComplete, true); // the graph collection says complete; the unresolved edge remains explicit
  assert.ok(
    plan.blocked.some((row) => row["reason"] === "unresolvedReferenceVersion"),
  );
});

test("uses the shipped native snapshot history health when no synthetic health alias exists", () => {
  const data = snapshot(["root-file"], [], {
    documents: [
      doc("root-file", {
        health: undefined,
        history: { healthy: true, status: "pass", repairRequired: false },
        repairRequired: false,
        consumedBodiesVerified: true,
        historySnapshotSupported: true,
      }),
    ],
  });
  const plan = refresh.makePlan(
    data,
    refresh.validate(request({ policy: "preserve" })),
  );
  assert.equal(plan.documents[0]!.blockedReason, undefined);
  assert.equal(
    plan.skipped.some((row) => row.fileId === "root-file"),
    true,
  );
});

test("fresh graph/preflight snapshots read their native history health field", () => {
  const baseline = refresh.makePlan(
    snapshot(["root-file"], [edge("root-file", "child")]),
    refresh.validate(request({ policy: "preserve" })),
  );
  const current = {
    ...doc("root-file", {
      health: undefined,
      history: { healthy: true, status: "pass", repairRequired: false },
    }),
    latestVersion: 1,
  };
  const fresh = {
    documents: [current],
    edges: [
      edge("root-file", "child", {
        baselineVersion: 1,
        status: "current",
      }),
    ],
  };
  assert.equal(refresh.staleBeforeStep(baseline, fresh, "root-file"), null);
  assert.deepEqual(
    refresh.planFreshness(baseline, { ...fresh, graphComplete: true }),
    [],
  );
});

test("latest plans block current-version stale DerivedParameter values rather than treating Update All as repair", () => {
  const native = snapshot(
    ["root-file", "child"],
    [
      edge("root-file", "child", {
        edgeId: "linked",
        kind: "linked",
        baselineVersion: 3,
        latestVersion: 3,
        status: "current",
      }),
      edge("root-file", "child", {
        edgeId: "derive",
        kind: "derive",
        baselineVersion: 3,
        latestVersion: 3,
        status: "current",
        sourceParameters: [
          {
            name: "IW710_Driver",
            expression: "20 mm",
            internal_value: 2,
            internal_unit: "cm",
            isFavorite: true,
          },
        ],
        derivedParameters: [
          {
            name: "IW710_Driver_Ref",
            expression: "10 mm",
            internal_value: 1,
            internal_unit: "cm",
          },
        ],
      }),
    ],
    {
      documents: [
        doc("root-file", { parameters: [] }),
        doc("child", {
          version: 3,
          latestVersion: 3,
          parameters: [
            {
              name: "IW710_Driver",
              expression: "20 mm",
              internal_value: 2,
              internal_unit: "cm",
            },
          ],
        }),
      ],
    },
  );
  const binding = {
    edgeId: "derive",
    sourceParameter: "IW710_Driver",
    nativeDerivedParameter: "IW710_Driver_Ref",
  };
  const plan = refresh.makePlan(
    native,
    refresh.validate(
      request({
        policy: "latest",
        root: { projectId: "project-1", fileId: "root-file", version: 1 },
        nativeFallback: "qualifiedOnce",
        parameterBindings: [binding],
      }),
    ),
  );
  const derive = plan.edges.find((row) => row.edgeId === "derive")!;
  assert.equal(derive.baselineVersion, derive.targetVersion);
  assert.equal(derive.bindingValuesMatch, false);
  assert.equal(derive.bindingValueMismatch, true);
  assert.equal(derive.status, "blocked");
  assert.equal(derive.blockedReason, "currentVersionBindingMismatch");
  assert.equal(plan.updates.length, 0);
  assert.equal(
    plan.blocked.find((row) => row["fileId"] === "root-file")!["reason"],
    "repairRequired",
  );
  assert.equal(plan.allIntendedReferencesCurrent, false);
  assert.equal(plan.allReferencesLatest, true);
});

test("preserve accepts the exact historical pinned dependency without accepting an old root or latest target", () => {
  const native = snapshot(
    ["root-file", "child"],
    [
      edge("root-file", "child", {
        baselineVersion: 1,
        latestVersion: 2,
      }),
    ],
    {
      documents: [
        doc("root-file"),
        doc("child", { version: 1, latestVersion: 2 }),
      ],
    },
  );
  const preserve = refresh.makePlan(
    native,
    refresh.validate(request({ policy: "preserve" })),
  );
  assert.equal(preserve.blocked.length, 0);
  assert.equal(preserve.updates.length, 0);
  assert.equal(preserve.allIntendedReferencesCurrent, true);
  assert.equal(preserve.allReferencesLatest, false);
  const latest = refresh.makePlan(
    native,
    refresh.validate(request({ policy: "latest" })),
  );
  assert.equal(
    latest.blocked.find((row) => row["fileId"] === "child")!["reason"],
    "olderRevisionOpen",
  );
  const oldRoot = refresh.makePlan(
    {
      ...native,
      documents: [doc("root-file", { latestVersion: 2 }), native.documents[1]],
    },
    refresh.validate(request({ policy: "preserve" })),
  );
  assert.equal(
    oldRoot.blocked.find((row) => row["fileId"] === "root-file")!["reason"],
    "olderRevisionOpen",
  );
});

test("stale Derive preflight accepts only version-proved source buffer changes with unchanged consumer evidence", () => {
  const native = snapshot(
    ["root-file", "child"],
    [
      edge("root-file", "child", {
        edgeId: "derive",
        kind: "derive",
        sourceParameterFileId: "child",
        sourceParameterVersion: 2,
        sourceDocumentModified: false,
        sourceParameters: [
          {
            name: "driver",
            expression: "15 mm",
            internal_value: 1.5,
            internal_unit: "cm",
          },
        ],
        derivedParameters: [
          {
            name: "driver_Ref",
            expression: "10 mm",
            internal_value: 1,
            internal_unit: "cm",
          },
        ],
      }),
    ],
  );
  native.documents[0]!.parameters = [
    {
      name: "alias",
      expression: "driver_Ref",
      internal_value: 1,
      internal_unit: "cm",
    },
  ];
  const plan = refresh.makePlan(
    native,
    refresh.validate(
      request({
        parameterBindings: [
          {
            edgeId: "derive",
            sourceParameter: "driver",
            nativeDerivedParameter: "driver_Ref",
            consumerAlias: "alias",
          },
        ],
      }),
    ),
  );
  const fresh = structuredClone(native);
  fresh.edges[0]!["sourceParameterVersion"] = 1;
  fresh.edges[0]!["sourceParameters"]![0] = {
    name: "driver",
    expression: "10 mm",
    internal_value: 1,
    internal_unit: "cm",
  };
  assert.equal(refresh.staleBeforeStep(plan, fresh, "root-file"), null);
  assert.deepEqual(refresh.planFreshness(plan, fresh), []);
  for (const alter of [
    (s: FixtureSnapshot) => delete s.edges[0]!["sourceParameterVersion"],
    (s: FixtureSnapshot) => (s.edges[0]!["sourceParameterVersion"] = 2),
    (s: FixtureSnapshot) => (s.edges[0]!["sourceDocumentModified"] = true),
    (s: FixtureSnapshot) =>
      (s.edges[0]!["derivedParameters"]![0]!.expression = "1 cm"),
    (s: FixtureSnapshot) =>
      (s.documents[0]!.parameters![0]!.internal_value = 3),
    (s: FixtureSnapshot) =>
      (s.edges[0]!["sourceParameters"]![0]!.internal_unit = "rad"),
  ]) {
    const changed = structuredClone(fresh);
    alter(changed);
    assert.equal(
      refresh.staleBeforeStep(plan, changed, "root-file"),
      "derivedBindingEvidenceDrift",
    );
  }
});

test("a documentReferences echo of an owned Derive is not a structural mixed-parent UI route", () => {
  const native = snapshot(
    ["root-file", "child"],
    [
      edge("root-file", "child", {
        edgeId: "echo",
        kind: "linked",
        isOccurrenceReference: false,
      }),
      edge("root-file", "child", {
        edgeId: "derive",
        kind: "derive",
        sourceParameters: [
          { name: "driver", internal_value: 1, internal_unit: "cm" },
        ],
        derivedParameters: [
          { name: "driver_Ref", internal_value: 1, internal_unit: "cm" },
        ],
      }),
    ],
  );
  const plan = refresh.makePlan(
    native,
    refresh.validate(
      request({
        policy: "latest",
        nativeFallback: "qualifiedOnce",
        parameterBindings: [
          {
            edgeId: "derive",
            sourceParameter: "driver",
            nativeDerivedParameter: "driver_Ref",
          },
        ],
      }),
    ),
  );
  assert.equal(plan.updates[0]!.method, "document.updateAllReferences");
  assert.equal(plan.updates[0]!.fallback, null);
});

test("a current DerivedReference without explicit parameter mapping is not promoted to binding PASS", () => {
  const native = snapshot(
    ["root-file", "child"],
    [
      edge("root-file", "child", {
        edgeId: "derive",
        kind: "derive",
        baselineVersion: 1,
        latestVersion: 1,
        status: "current",
        sourceParameters: [
          { name: "driver", internal_value: 1, internal_unit: "cm" },
        ],
        derivedParameters: [
          { name: "driver_Ref", internal_value: 1, internal_unit: "cm" },
        ],
      }),
    ],
  );
  const plan = refresh.makePlan(
    native,
    refresh.validate(request({ policy: "latest" })),
  );
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.allIntendedReferencesCurrent, null);
  assert.equal(plan.allReferencesLatest, true);
});

test("blocks mixed-parent mass update when a pin or self-reference could advance", () => {
  const mixed = snapshot(
    ["root-file", "child"],
    [
      edge("root-file", "child", {
        edgeId: "linked",
        kind: "linked",
        baselineVersion: 1,
        latestVersion: 2,
      }),
      edge("root-file", "child", {
        edgeId: "derive",
        kind: "derive",
        baselineVersion: 1,
        latestVersion: 2,
      }),
      edge("root-file", "root-file", {
        edgeId: "self",
        selfReference: true,
        baselineVersion: 1,
        latestVersion: 2,
      }),
    ],
  );
  const plan = refresh.makePlan(
    mixed,
    refresh.validate(request({ nativeFallback: "qualifiedOnce" })),
  );
  assert.ok(
    plan.blocked.some(
      (row) =>
        row["reason"] === "mixedParentCouldAdvancePinnedOrOutOfScopeEdge",
    ),
  );
  assert.equal(
    plan.updates.some((row) => row.fileId === "root-file"),
    false,
  );
});

test("plans direct native method only for qualified mixed parent; never policy stays SDK-only", () => {
  const mixed = snapshot(
    ["root-file", "child"],
    [
      edge("root-file", "child", {
        edgeId: "linked",
        kind: "linked",
        baselineVersion: 1,
        latestVersion: 2,
      }),
      edge("root-file", "child", {
        edgeId: "derive",
        kind: "derive",
        baselineVersion: 1,
        latestVersion: 2,
      }),
    ],
  );
  const plan = refresh.makePlan(
    mixed,
    refresh.validate(request({ nativeFallback: "qualifiedOnce" })),
  );
  const update = plan.updates.find((row) => row.fileId === "root-file")!;
  assert.equal(update.method, "UpdateAllLatestCmd");
  assert.equal(update.fallback, null);
  const never = refresh.makePlan(
    mixed,
    refresh.validate(request({ nativeFallback: "never" })),
  );
  assert.equal(
    never.updates.find((row) => row.fileId === "root-file")!.method,
    "document.updateAllReferences",
  );
  assert.equal(
    never.updates.find((row) => row.fileId === "root-file")!.fallback,
    null,
  );
  const ordinary = refresh.makePlan(
    snapshot(
      ["root-file", "child"],
      [
        edge("root-file", "child", {
          edgeId: "ordinary",
          kind: "linked",
          baselineVersion: 1,
          latestVersion: 2,
        }),
      ],
    ),
    refresh.validate(request({ nativeFallback: "qualifiedOnce" })),
  );
  assert.equal(
    ordinary.updates[0]!.method,
    "DocumentReference.getLatestVersion",
  );
  assert.notEqual("UpdateAllLatestCmd", "GetLatestCmd");
  assert.notEqual("UpdateAllLatestCmd", "GetAllLatestCmd");
});

test("broken feature history is repairRequired rather than equal-cache-geometry PASS", () => {
  const data = snapshot(["root-file", "child"], [edge("root-file", "child")], {
    documents: [
      doc("root-file", {
        health: { healthy: false, status: "fail", repairRequired: true },
      }),
      doc("child"),
    ],
  });
  const plan = refresh.makePlan(data, refresh.validate(request()));
  assert.ok(
    plan.blocked.some(
      (row) =>
        row["fileId"] === "root-file" && row["reason"] === "repairRequired",
    ),
  );
  assert.equal(plan.updates.length, 0);
});

test("unknown copied feature context and metadata coverage remain explicit diagnostics", () => {
  const data = snapshot(["root-file", "child"], [edge("root-file", "child")], {
    documents: [
      doc("root-file", {
        repairRequired: true,
        consumedBodiesVerified: false,
        metadataCoverage: {
          component: "complete",
          body: "complete",
          occurrence: "unknown",
        },
      }),
      doc("child"),
    ],
  });
  const plan = refresh.makePlan(data, refresh.validate(request()));
  assert.equal(plan.documents[0]!.metadataCoverage!.occurrence, "unknown");
  assert.ok(plan.blocked.some((row) => row["reason"] === "repairRequired"));
});

test("immutable plans are write-once and checksum-verified", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fmcad-refs-plan-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const plan = refresh.makePlan(
    snapshot(["root-file"], []),
    refresh.validate(request()),
  );
  const first = await refresh.writePlan(rootDir, plan);
  const read = await refresh.readPlan(rootDir, first);
  assert.equal(first, hash(read));
  assert.deepEqual(read.root, root);
  assert.equal(await refresh.writePlan(rootDir, plan), first);
  await fs.writeFile(
    path.join(rootDir, "plans", `${first}.json`),
    JSON.stringify({ ...read, policy: "corrupted" }),
  );
  await assert.rejects(() => refresh.readPlan(rootDir, first), /checksum/);
});

test("direct-native immutable plan rejects a changed root before any SDK step", async (t) => {
  const reportPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-refs-native-plan-identity-"),
  );
  t.after(() => fs.rm(reportPath, { recursive: true, force: true }));
  const binding = {
    edgeId: "derive-direct-identity",
    sourceParameter: "sourceLength",
    nativeDerivedParameter: "derivedLength",
  };
  const graph = snapshot(
    ["root-file", "parameter-source", "linked-source"],
    [
      edge("root-file", "parameter-source", {
        edgeId: binding.edgeId,
        kind: "derive",
        baselineVersion: 1,
        latestVersion: 2,
        sourceParameters: [
          {
            name: "sourceLength",
            internal_value: 0.2,
            internal_unit: "cm",
            isFavorite: true,
          },
        ],
        derivedParameters: [
          { name: "derivedLength", internal_value: 0.2, internal_unit: "cm" },
        ],
      }),
      edge("root-file", "linked-source", {
        edgeId: "linked-direct-identity",
        kind: "linked",
        baselineVersion: 1,
        latestVersion: 2,
      }),
    ],
  );
  const plan = refresh.makePlan(
    graph,
    refresh.validate(
      request({
        phase: "plan",
        requestId: "plan-direct-identity",
        nativeFallback: "qualifiedOnce",
        parameterBindings: [binding],
      }),
    ),
  );
  assert.equal(plan.updates[0]!.method, "UpdateAllLatestCmd");
  const planId = await refresh.writePlan(reportPath, plan);
  const applyData = request({
    phase: "apply",
    requestId: "apply-direct-identity",
    reportPath,
    planId,
    root: { projectId: "project-1", fileId: "different-root", version: 1 },
    confirm: true,
    nativeFallback: "qualifiedOnce",
    lifecycle: "openOwned",
    durability: "cloud",
    parameterBindings: [binding],
  });
  delete applyData.policy;
  let calls = 0;
  await assert.rejects(
    refresh.execute(
      null,
      applyData,
      {},
      {
        step: async () => {
          calls++;
          throw new Error("must not execute");
        },
      },
    ),
    /apply root\/scope differs from the immutable plan/,
  );
  assert.equal(calls, 0);
});

test("audit and plan persistence reuse request-bound immutable receipts; inspect performs no SDK steps", async (t) => {
  const reportPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-refs-report-"),
  );
  t.after(() => fs.rm(reportPath, { recursive: true, force: true }));
  const input = refresh.validate(
    request({ phase: "audit", reportPath, requestId: "audit-1" }),
  );
  const readGraph = async () => snapshot(["root-file"], []);
  const audit = await refresh.execute(
    null,
    input,
    {},
    {
      step: async (action: string) => {
        assert.equal(action, "graph");
        return readGraph();
      },
    },
  );
  assert.equal(audit.invocationStatus, "complete");
  const inspected = await refresh.execute(
    null,
    refresh.validate({ ...input, phase: "inspect" }),
    {},
    {
      step: async () => {
        throw new Error("inspect must not call Fusion");
      },
    },
  );
  assert.equal(inspected.latestReceipt.requestId, "audit-1");
});

test("settled budget stop does not start another document and returns a resumable partial", async (t) => {
  const reportPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-refs-budget-"),
  );
  t.after(() => fs.rm(reportPath, { recursive: true, force: true }));
  let clock = 0;
  const graph = snapshot(
    ["root-file", "child", "leaf"],
    [edge("root-file", "child"), edge("child", "leaf")],
  );
  const applyRequest = request({
    phase: "apply",
    requestId: "budget-1",
    reportPath,
    planId: "d".repeat(64),
    confirm: true,
    durability: "cloud",
    lifecycle: "openOwned",
    timeBudgetMs: 10,
  });
  delete applyRequest.policy;
  const input = refresh.validate(applyRequest);
  const plan = refresh.makePlan(
    graph,
    refresh.validate(request({ phase: "plan", requestId: "plan-1" })),
  );
  const calls: string[] = [];
  const result = await refresh.apply(null, input, plan, {
    now: () => clock,
    step: async (action: string) => {
      calls.push(action);
      if (action === "graph") return graph;
      if (action === "preflight") {
        clock += 20;
        return graph;
      }
      throw new Error("forward mutation should not begin after budget");
    },
  });
  assert.equal(result.invocationStatus, "partial");
  assert.equal(result.continuation!.reason, "budgetExhausted");
  assert.equal(result.inProgress, null);
  assert.equal(calls.filter((call) => call === "sdkUpdate").length, 0);
});

function checkPass() {
  return {
    intendedReferencesCurrent: true,
    bindingsPass: true,
    healthPass: true,
    scopePass: true,
    metadataPass: true,
    localParametersPreserved: true,
    consumedBodiesVerified: true,
    getterState: "resolved",
    metadataCoverage: { component: "complete" },
  };
}

test("settled linked update saves once and reports its resulting version receipt", async (t) => {
  const reportPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-refs-apply-"),
  );
  t.after(() => fs.rm(reportPath, { recursive: true, force: true }));
  const inputData = request({
    phase: "apply",
    requestId: "apply-linked-1",
    reportPath,
    planId: "a".repeat(64),
    confirm: true,
    lifecycle: "openOwned",
    durability: "cloud",
  });
  delete inputData.policy;
  const input = refresh.validate(inputData);
  const planInput = refresh.validate(
    request({ phase: "plan", requestId: "plan-linked-1" }),
  );
  const beforeGraph = snapshot(
    ["root-file", "child"],
    [edge("root-file", "child")],
  );
  const plan = refresh.makePlan(beforeGraph, planInput);
  const events: string[] = [];
  const finalGraph = snapshot(
    ["root-file", "child"],
    [
      edge("root-file", "child", {
        baselineVersion: 2,
        latestVersion: 2,
        status: "current",
      }),
    ],
  );
  const result = await refresh.apply(null, input, plan, {
    step: async (action, payload) => {
      events.push(action);
      if (action === "preflight")
        return {
          document: doc("root-file", {
            latestVersion: 1,
            modified: false,
            dirty: false,
            metadataComplete: true,
            isComplete: true,
            readOnly: false,
            timelineAtEnd: true,
            pendingSnapshot: false,
            health: { healthy: true, status: "pass" },
          }),
          edges: beforeGraph.edges,
          openedByRequest: true,
          identity: { creationId: "owned-root" },
        };
      if (action === "sdkUpdate") {
        assert.equal(
          payload.method,
          plan.updates.find((row) => row.fileId === "root-file")!.method,
        );
        return {
          status: "complete",
          modified: true,
          checks: checkPass(),
          identity: { creationId: "owned-root" },
          openedByRequest: true,
        };
      }
      if (action === "save")
        return {
          status: "complete",
          resultingVersion: 2,
          parameters: [],
          metadataCoverage: { component: "complete" },
        };
      if (action === "graph") {
        assert.equal(
          payload.root.version,
          2,
          "final observation must use the confirmed saved root, not its baseline",
        );
        assert.equal(payload.policy, plan.policy);
        return finalGraph;
      }
      throw new Error("unexpected step " + action);
    },
  });
  assert.deepEqual(events, ["preflight", "sdkUpdate", "save", "graph"]);
  assert.equal(result.invocationStatus, "complete");
  assert.equal(result.success, true);
  assert.equal(result.allIntendedReferencesCurrent, true);
  assert.equal(result.allReferencesLatest, true);
  assert.deepEqual(
    result.completed.map((row) => row["resultingVersion"]),
    [2],
  );
  const reported = result.documents.find((row) => row.fileId === "root-file")!;
  assert.equal(reported.resultingVersion, 2);
  assert.equal(reported.saveStatus, "complete");
  assert.equal(reported.status, "complete");
  assert.equal(
    plan.documents.find((row) => row.fileId === "root-file")!.resultingVersion,
    null,
    "runtime document state must not mutate the immutable plan",
  );
});

test("unknown SDK update is never escalated, saved, cold-closed or replayed", async (t) => {
  const reportPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-refs-unknown-"),
  );
  t.after(() => fs.rm(reportPath, { recursive: true, force: true }));
  const mixed = snapshot(
    ["root-file", "child"],
    [
      edge("root-file", "child", {
        edgeId: "linked",
        kind: "linked",
        baselineVersion: 1,
        latestVersion: 2,
      }),
      edge("root-file", "child", {
        edgeId: "derive",
        kind: "derive",
        baselineVersion: 1,
        latestVersion: 2,
        sourceParameters: [
          { name: "sourceLength", internal_value: 0.2, internal_unit: "cm" },
        ],
        derivedParameters: [
          { name: "derivedLength", internal_value: 0.2, internal_unit: "cm" },
        ],
      }),
    ],
  );
  const binding = {
    edgeId: "derive",
    sourceParameter: "sourceLength",
    nativeDerivedParameter: "derivedLength",
  };
  const plan = legacySdkFallbackPlan(
    refresh.makePlan(
      mixed,
      refresh.validate(
        request({
          phase: "plan",
          requestId: "plan-mixed-unknown",
          nativeFallback: "qualifiedOnce",
          parameterBindings: [binding],
        }),
      ),
    ),
  );
  const data = request({
    phase: "apply",
    requestId: "apply-mixed-unknown",
    reportPath,
    planId: "b".repeat(64),
    confirm: true,
    nativeFallback: "qualifiedOnce",
    lifecycle: "openOwned",
    durability: "cloud",
    parameterBindings: [binding],
    uiLeases: {
      "root-file": {
        target: { name: "Root", fileId: "root-file" },
        lease: {
          id: "lease",
          requestId: "apply-mixed-unknown",
          operationId: "authorized",
          expiresAt: Date.now() + 60000,
          target: { name: "Root", fileId: "root-file" },
        },
      },
    },
  });
  delete data.policy;
  const input = refresh.validate(data);
  const events: string[] = [];
  const result = await refresh.apply(null, input, plan, {
    step: async (action: string) => {
      events.push(action);
      if (action === "preflight")
        return {
          document: doc("root-file", {
            latestVersion: 1,
            modified: false,
            dirty: false,
            metadataComplete: true,
            isComplete: true,
            readOnly: false,
            timelineAtEnd: true,
            pendingSnapshot: false,
            health: { healthy: true, status: "pass" },
          }),
          edges: mixed.edges,
          openedByRequest: true,
          identity: { creationId: "owned-root" },
        };
      if (action === "sdkUpdate")
        return { status: "unknown", outcome: "unknown", modified: true };
      throw new Error("unknown call must stop all next actions");
    },
    armWatcher: async () => {
      events.push("armWatcher");
      throw new Error("must not arm for unknown SDK outcome");
    },
  });
  assert.equal(result.invocationStatus, "unknown");
  assert.deepEqual(events, ["preflight", "sdkUpdate"]);
});

test("an explicit host RPC not-submitted receipt is settled blocked, never retried or escalated", async (t) => {
  const reportPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-refs-not-submitted-"),
  );
  t.after(() => fs.rm(reportPath, { recursive: true, force: true }));
  const mixed = snapshot(
    ["root-file", "child"],
    [
      edge("root-file", "child", {
        edgeId: "linked",
        kind: "linked",
        baselineVersion: 1,
        latestVersion: 2,
      }),
      edge("root-file", "child", {
        edgeId: "derive",
        kind: "derive",
        baselineVersion: 1,
        latestVersion: 2,
        sourceParameters: [
          { name: "sourceLength", internal_value: 0.2, internal_unit: "cm" },
        ],
        derivedParameters: [
          { name: "derivedLength", internal_value: 0.2, internal_unit: "cm" },
        ],
      }),
    ],
  );
  const binding = {
    edgeId: "derive",
    sourceParameter: "sourceLength",
    nativeDerivedParameter: "derivedLength",
  };
  const plan = legacySdkFallbackPlan(
    refresh.makePlan(
      mixed,
      refresh.validate(
        request({
          phase: "plan",
          requestId: "plan-not-submitted",
          nativeFallback: "qualifiedOnce",
          parameterBindings: [binding],
        }),
      ),
    ),
  );
  const applyRequestId = "apply-not-submitted";
  const data = request({
    phase: "apply",
    requestId: applyRequestId,
    reportPath,
    planId: "d".repeat(64),
    confirm: true,
    nativeFallback: "qualifiedOnce",
    lifecycle: "openOwned",
    durability: "cloud",
    parameterBindings: [binding],
    uiLeases: {
      "root-file": {
        target: { name: "Root", fileId: "root-file" },
        lease: {
          id: "lease",
          requestId: applyRequestId,
          operationId: "authorized",
          expiresAt: Date.now() + 60000,
          target: { name: "Root", fileId: "root-file" },
        },
      },
    },
  });
  delete data.policy;
  const input = refresh.validate(data);
  const events: string[] = [];
  const result = await refresh.apply(null, input, plan, {
    step: async (action: string) => {
      events.push(action);
      if (action === "preflight")
        return {
          document: doc("root-file", {
            latestVersion: 1,
            modified: false,
            dirty: false,
            metadataComplete: true,
            isComplete: true,
            readOnly: false,
            timelineAtEnd: true,
            pendingSnapshot: false,
            health: { healthy: true, status: "pass" },
          }),
          edges: mixed.edges,
          openedByRequest: true,
          identity: { creationId: "owned-root" },
        };
      if (action === "sdkUpdate")
        return {
          status: "notStarted",
          notStarted: true,
          error: "RPC not submitted: insufficient fmcad_execute budget",
        };
      if (action === "graph") return mixed;
      throw new Error(
        "known not-submitted SDK call must stop before save/UI/native steps",
      );
    },
    armWatcher: async () => {
      events.push("armWatcher");
      throw new Error("must not arm without an SDK submit");
    },
  });
  assert.equal(result.invocationStatus, "blocked");
  assert.equal(result.blocked[0]!.reason, "requestNotSubmitted");
  assert.equal(result.inProgress, null);
  assert.deepEqual(events, ["preflight", "sdkUpdate", "graph"]);
});

test("the shipped Fusion adapter preserves explicit no-submit receipts as known notStarted", async () => {
  const result = await executeReferencesAction(
    {
      callTool: async () => ({
        failed: true,
        text: "RPC not submitted: insufficient fmcad_execute budget for its full timeout",
      }),
    },
    "sdkUpdate",
    {},
    {},
  );
  assert.equal(result["status"], "notStarted");
  assert.equal(result["notStarted"], true);
  assert.match(result["error"], /RPC not submitted/);
  const thrown = await executeReferencesAction(
    {
      callTool: async () => {
        throw new Error(
          "RPC not submitted: insufficient fmcad_execute budget for its full timeout",
        );
      },
    },
    "sdkUpdate",
    {},
    {},
  );
  assert.equal(thrown["status"], "notStarted");
  assert.equal(thrown["notStarted"], true);
});

test("native update RPC uses its reserved deadline budget and restores the client timeout", async () => {
  const client = {
    server: { timeoutMs: 120000 },
    callTool: async (requestData: { object: { script: string } }) => {
      assert.equal(client.server.timeoutMs, 31000);
      assert.doesNotMatch(requestData.object.script, /nativeRpcTimeoutMs/);
      return { failed: false, text: 'FMCAD_RESULT {"status":"knownStale"}' };
    },
  };
  const result = await executeReferencesAction(
    client,
    "nativeUpdate",
    {
      fileId: "root-file",
      nativeRpcTimeoutMs: 31000,
    },
    { lifecycle: "openOwned" },
  );
  assert.equal(result["status"], "knownStale");
  assert.equal(client.server.timeoutMs, 120000);

  const failing = {
    server: { timeoutMs: 120000 },
    callTool: async () => {
      assert.equal(failing.server.timeoutMs, 31000);
      throw new Error("native RPC transport failure");
    },
  };
  await assert.rejects(
    executeReferencesAction(
      failing,
      "nativeUpdate",
      {
        fileId: "root-file",
        nativeRpcTimeoutMs: 31000,
      },
      { lifecycle: "openOwned" },
    ),
    /native RPC transport failure/,
  );
  assert.equal(failing.server.timeoutMs, 120000);
});

test("qualified native fallback arms .11 before its one native command and verifies poststate before save", async (t) => {
  const reportPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-refs-native-"),
  );
  t.after(() => fs.rm(reportPath, { recursive: true, force: true }));
  refresh.validate(
    request({
      phase: "plan",
      requestId: "plan-mixed-native",
      nativeFallback: "qualifiedOnce",
    }),
  );
  const derivedEdge = edge("root-file", "child", {
    edgeId: "derive",
    kind: "derive",
    baselineVersion: 1,
    latestVersion: 2,
    sourceParameters: [
      {
        name: "sourceLength",
        internal_value: 0.2,
        internal_unit: "cm",
        isFavorite: true,
      },
    ],
    derivedParameters: [
      { name: "derivedLength", internal_value: 0.2, internal_unit: "cm" },
    ],
  });
  const linkedEdge = edge("root-file", "child", {
    edgeId: "linked",
    kind: "linked",
    baselineVersion: 1,
    latestVersion: 2,
  });
  const mixed = snapshot(["root-file", "child"], [linkedEdge, derivedEdge], {
    documents: [
      doc("root-file", {
        name: "Root",
        parameters: [
          {
            name: "heightAlias",
            expression: "derivedLength",
            dependsOn: ["derivedLength"],
          },
        ],
      }),
      doc("child", {
        parameters: [
          { name: "sourceLength", internal_value: 0.2, internal_unit: "cm" },
        ],
      }),
    ],
  });
  const binding = {
    edgeId: "derive",
    sourceParameter: "sourceLength",
    consumerAlias: "heightAlias",
  };
  const plan = legacySdkFallbackPlan(
    refresh.makePlan(
      mixed,
      refresh.validate(
        request({
          phase: "plan",
          requestId: "plan-mixed-native",
          nativeFallback: "qualifiedOnce",
          parameterBindings: [binding],
        }),
      ),
    ),
  );
  const data = request({
    phase: "apply",
    requestId: "apply-mixed-native",
    reportPath,
    planId: "c".repeat(64),
    confirm: true,
    nativeFallback: "qualifiedOnce",
    lifecycle: "openOwned",
    durability: "cloud",
    parameterBindings: [binding],
    uiLeases: {
      "root-file": {
        target: { name: "Root", fileId: "root-file" },
        lease: {
          id: "lease",
          requestId: "apply-mixed-native",
          operationId: "authorized",
          expiresAt: Date.now() + 60000,
          target: { name: "Root", fileId: "root-file" },
        },
      },
    },
  });
  delete data.policy;
  const input = refresh.validate(data);
  const events: string[] = [];
  let nativePayload: StepPayload | undefined;
  let watcherRequest: Record<string, unknown> | undefined;
  let now = 1000;
  const watcherArmElapsedMs = 4000;
  const finalGraph = snapshot(
    ["root-file", "child"],
    [
      { ...linkedEdge, baselineVersion: 2, latestVersion: 2 },
      { ...derivedEdge, baselineVersion: 2, latestVersion: 2 },
    ],
    { documents: mixed.documents },
  );
  const result = await refresh.apply(null, input, plan, {
    now: () => now,
    step: async (action, data) => {
      events.push(action);
      if (action === "preflight")
        return {
          document: doc("root-file", {
            name: "Root",
            latestVersion: 1,
            parameters: [
              {
                name: "heightAlias",
                expression: "derivedLength",
                dependsOn: ["derivedLength"],
              },
            ],
            modified: false,
            dirty: false,
            metadataComplete: true,
            isComplete: true,
            readOnly: false,
            timelineAtEnd: true,
            pendingSnapshot: false,
            health: { healthy: true, status: "pass" },
          }),
          edges: mixed.edges,
          openedByRequest: true,
          identity: { creationId: "owned-root" },
        };
      if (action === "sdkUpdate")
        return {
          status: "knownStale",
          modified: true,
          checks: { intendedReferencesCurrent: false },
        };
      if (action === "nativeUpdate") {
        nativePayload = data;
        return {
          status: "complete",
          operationOutcome: "pass",
          checks: checkPass(),
          modified: true,
        };
      }
      if (action === "save")
        return {
          status: "complete",
          resultingVersion: 2,
          parameters: [],
          metadataCoverage: { component: "complete" },
        };
      if (action === "graph") return finalGraph;
      throw new Error("unexpected step " + action);
    },
    inspectUi: async (_client, requestData) => {
      events.push("ui.inspect");
      assert.equal(requestData["intent"], "confirmRequestedUpdate");
      return {
        status: "nothingToDo",
        identityVerified: true,
        activeCommand: { id: "SelectCommand" },
        process: { fusionVersion: "F", osBuild: "W", locale: "pl-PL" },
      };
    },
    armWatcher: async (_client, requestData) => {
      events.push("armWatcher");
      watcherRequest = requestData;
      assert.equal(requestData["profileId"], "update-all-latest");
      now += watcherArmElapsedMs;
      return {
        status: "armed",
        complete: async () => {
          events.push("watcher.complete");
          return { status: "actionSubmitted", actionSubmitted: true };
        },
        disarm: async () => events.push("disarm"),
      };
    },
  });
  assert.deepEqual(events, [
    "preflight",
    "sdkUpdate",
    "ui.inspect",
    "armWatcher",
    "nativeUpdate",
    "watcher.complete",
    "disarm",
    "save",
    "graph",
  ]);
  assert.ok(
    nativePayload!.timeBudgetMs > 0 &&
      nativePayload!.timeBudgetMs < input.timeBudgetMs,
  );
  assert.equal(
    nativePayload!.nativeRpcTimeoutMs,
    nativePayload!.timeBudgetMs + 1000,
  );
  assert.ok(
    nativePayload!.nativeRpcTimeoutMs <
      (watcherRequest!["timeBudgetMs"] as number),
  );
  assert.ok(
    (watcherRequest!["timeBudgetMs"] as number) -
      nativePayload!.nativeRpcTimeoutMs >=
      5000,
  );
  assert.ok(
    nativePayload!.nativeRpcTimeoutMs + 5000 <=
      (watcherRequest!["timeBudgetMs"] as number) - watcherArmElapsedMs,
  );
  assert.ok((watcherRequest!["timeBudgetMs"] as number) <= 120000);
  assert.equal(result.invocationStatus, "complete");
  assert.equal(result.completed[0]!["method"], "UpdateAllLatestCmd");
  assert.equal(
    result.lifecycleEffects.some((row) => row.type === "nativeUi"),
    true,
  );
});

test("structurally qualified mixed plan calls native once directly and never calls SDK update", async (t) => {
  const reportPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-refs-native-direct-"),
  );
  t.after(() => fs.rm(reportPath, { recursive: true, force: true }));
  const planRequest = refresh.validate(
    request({
      phase: "plan",
      requestId: "plan-native-direct",
      nativeFallback: "qualifiedOnce",
      parameterBindings: [
        {
          edgeId: "derive-direct",
          sourceParameter: "sourceLength",
          nativeDerivedParameter: "derivedLength",
        },
      ],
    }),
  );
  const derivedEdge = edge("root-file", "parameter-source", {
    edgeId: "derive-direct",
    kind: "derive",
    baselineVersion: 1,
    latestVersion: 2,
    sourceParameters: [
      {
        name: "sourceLength",
        internal_value: 0.2,
        internal_unit: "cm",
        isFavorite: true,
      },
    ],
    derivedParameters: [
      { name: "derivedLength", internal_value: 0.2, internal_unit: "cm" },
    ],
  });
  const linkedEdge = edge("root-file", "linked-source", {
    edgeId: "linked-direct",
    kind: "linked",
    baselineVersion: 1,
    latestVersion: 2,
  });
  const mixed = snapshot(
    ["root-file", "parameter-source", "linked-source"],
    [linkedEdge, derivedEdge],
    {
      documents: [
        doc("root-file", {
          name: "Root",
          parameters: [
            {
              name: "heightAlias",
              expression: "derivedLength",
              dependsOn: ["derivedLength"],
            },
          ],
        }),
        doc("parameter-source", {
          parameters: [
            { name: "sourceLength", internal_value: 0.2, internal_unit: "cm" },
          ],
        }),
        doc("linked-source"),
      ],
    },
  );
  const plan = refresh.makePlan(mixed, planRequest);
  const update = plan.updates.find((row) => row.fileId === "root-file")!;
  assert.equal(update.method, "UpdateAllLatestCmd");
  assert.equal(update.fallback, null);
  const requestId = "apply-native-direct";
  const data = request({
    phase: "apply",
    requestId,
    reportPath,
    planId: "a".repeat(64),
    confirm: true,
    nativeFallback: "qualifiedOnce",
    lifecycle: "openOwned",
    durability: "cloud",
    parameterBindings: [
      {
        edgeId: "derive-direct",
        sourceParameter: "sourceLength",
        nativeDerivedParameter: "derivedLength",
      },
    ],
    uiLeases: {
      "root-file": {
        target: { name: "Root", creationId: "owned-root", fileId: "root-file" },
        lease: {
          id: "lease-direct",
          requestId,
          operationId: "native-direct",
          expiresAt: Date.now() + 60000,
          target: {
            name: "Root",
            creationId: "owned-root",
            fileId: "root-file",
          },
        },
      },
    },
  });
  delete data.policy;
  const input = refresh.validate(data);
  const finalGraph = snapshot(
    ["root-file", "parameter-source", "linked-source"],
    [
      { ...linkedEdge, baselineVersion: 2, latestVersion: 2 },
      { ...derivedEdge, baselineVersion: 2, latestVersion: 2 },
    ],
    { documents: mixed.documents },
  );
  const events: string[] = [];
  let nativeCalls = 0;
  let sdkCalls = 0;
  let nativePayload: StepPayload | undefined;
  const result = await refresh.apply(null, input, plan, {
    initialSnapshot: mixed,
    step: async (action, payload) => {
      events.push(action);
      if (action === "preflight")
        return {
          document: doc("root-file", {
            name: "Root",
            latestVersion: 1,
            modified: false,
            metadataComplete: true,
            isComplete: true,
            readOnly: false,
            timelineAtEnd: true,
            pendingSnapshot: false,
            health: { healthy: true, status: "pass" },
          }),
          edges: mixed.edges,
          openedByRequest: false,
          identity: { creationId: "owned-root" },
        };
      if (action === "sdkUpdate") {
        sdkCalls++;
        throw new Error("direct native plan must bypass SDK update");
      }
      if (action === "nativeUpdate") {
        nativeCalls++;
        nativePayload = payload;
        return {
          status: "complete",
          outcome: "settled",
          operationOutcome: "pass",
          actionSubmitted: true,
          checks: checkPass(),
          modified: true,
          after: { edges: finalGraph.edges },
        };
      }
      if (action === "save")
        return {
          status: "complete",
          resultingVersion: 2,
          parameters: [],
          metadataCoverage: { component: "complete" },
        };
      if (action === "graph") return finalGraph;
      throw new Error("unexpected direct-native action " + action);
    },
    inspectUi: async (_client, requestData) => {
      events.push("ui.inspect");
      assert.equal(requestData["intent"], "confirmRequestedUpdate");
      return {
        status: "nothingToDo",
        identityVerified: true,
        activeCommand: { id: "SelectCommand" },
        process: { fusionVersion: "F", osBuild: "W", locale: "en-US" },
      };
    },
    armWatcher: async (_client, requestData) => {
      events.push("armWatcher");
      assert.equal(requestData["profileId"], "update-all-latest");
      return {
        status: "armed",
        complete: async () => {
          events.push("watcher.complete");
          return { status: "actionSubmitted", actionSubmitted: true };
        },
        disarm: async () => events.push("watcher.disarm"),
      };
    },
  });
  assert.deepEqual(events, [
    "preflight",
    "ui.inspect",
    "armWatcher",
    "nativeUpdate",
    "watcher.complete",
    "watcher.disarm",
    "save",
    "graph",
  ]);
  assert.equal(sdkCalls, 0);
  assert.equal(nativeCalls, 1);
  assert.equal(nativePayload!.method, "UpdateAllLatestCmd");
  assert.equal(nativePayload!.plannedMethod, "UpdateAllLatestCmd");
  assert.equal(nativePayload!.nativeRoute, "directPlanned");
  assert.equal(nativePayload!.ownedCreationId, "owned-root");
  assert.equal(nativePayload!.openedByRequest, false);
  assert.equal(Object.hasOwn(nativePayload!, "priorSdkResult"), false);
  assert.equal(result.invocationStatus, "complete");
  assert.equal(result.completed[0]!["method"], "UpdateAllLatestCmd");
});

test("direct native route does not submit when the remaining deadline cannot reserve watcher completion", async (t) => {
  const reportPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-refs-native-budget-"),
  );
  t.after(() => fs.rm(reportPath, { recursive: true, force: true }));
  const derivedEdge = edge("root-file", "child", {
    edgeId: "derive-budget",
    kind: "derive",
    baselineVersion: 1,
    latestVersion: 2,
    sourceParameters: [
      {
        name: "sourceLength",
        internal_value: 0.2,
        internal_unit: "cm",
        isFavorite: true,
      },
    ],
    derivedParameters: [
      { name: "derivedLength", internal_value: 0.2, internal_unit: "cm" },
    ],
  });
  const linkedEdge = edge("root-file", "child", {
    edgeId: "linked-budget",
    kind: "linked",
    baselineVersion: 1,
    latestVersion: 2,
  });
  const graph = snapshot(["root-file", "child"], [linkedEdge, derivedEdge], {
    documents: [doc("root-file", { name: "Root" }), doc("child")],
  });
  const binding = {
    edgeId: "derive-budget",
    sourceParameter: "sourceLength",
    nativeDerivedParameter: "derivedLength",
  };
  const planInput = refresh.validate(
    request({
      phase: "plan",
      requestId: "plan-native-budget",
      nativeFallback: "qualifiedOnce",
      parameterBindings: [binding],
    }),
  );
  const plan = refresh.makePlan(graph, planInput);
  assert.equal(
    plan.updates.find((row) => row.fileId === "root-file")?.method,
    "UpdateAllLatestCmd",
  )!;
  assert.equal(
    plan.updates.find((row) => row.fileId === "root-file")?.fallback,
    null,
  )!;
  const data = request({
    phase: "apply",
    requestId: "apply-native-budget",
    reportPath,
    planId: "f".repeat(64),
    confirm: true,
    nativeFallback: "qualifiedOnce",
    lifecycle: "openOwned",
    durability: "cloud",
    timeBudgetMs: 60000,
    parameterBindings: [binding],
    uiLeases: {
      "root-file": {
        target: { name: "Root", fileId: "root-file" },
        lease: {
          id: "lease",
          requestId: "apply-native-budget",
          operationId: "authorized",
          expiresAt: Date.now() + 60000,
          target: { name: "Root", fileId: "root-file" },
        },
      },
    },
  });
  delete data.policy;
  const input = refresh.validate(data);
  let now = 0;
  const events: string[] = [];
  const result = await refresh.apply(null, input, plan, {
    now: () => now,
    initialSnapshot: graph,
    step: async (action: string) => {
      events.push(action);
      if (action === "preflight")
        return {
          document: doc("root-file", {
            name: "Root",
            latestVersion: 1,
            modified: false,
            metadataComplete: true,
            isComplete: true,
            readOnly: false,
            timelineAtEnd: true,
            pendingSnapshot: false,
            health: { healthy: true, status: "pass" },
          }),
          edges: graph.edges,
          openedByRequest: true,
          identity: { creationId: "owned-root" },
        };
      if (action === "graph") return graph;
      throw new Error(
        "direct route must not call SDK update or native command without reserved watcher budget: " +
          action,
      );
    },
    inspectUi: async () => {
      events.push("ui.inspect");
      return {
        status: "nothingToDo",
        identityVerified: true,
        activeCommand: { id: "SelectCommand" },
      };
    },
    armWatcher: async () => {
      events.push("armWatcher");
      now = 59000;
      return {
        status: "armed",
        complete: async () => ({
          status: "nothingToDo",
          actionSubmitted: false,
        }),
        disarm: async () => events.push("watcher.disarm"),
      };
    },
  });
  assert.equal(result.invocationStatus, "partial");
  assert.equal(result.inProgress!["nativeCommandNotSubmitted"], true);
  assert.equal(result.continuation!.reason, "budgetExhausted");
  assert.equal(result.budgetExceeded, false);
  assert.deepEqual(events, [
    "preflight",
    "ui.inspect",
    "armWatcher",
    "watcher.disarm",
  ]);
});

test("native preflight budget exhaustion is partial and never saved or retried", async (t) => {
  const reportPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-refs-native-preflight-budget-"),
  );
  t.after(() => fs.rm(reportPath, { recursive: true, force: true }));
  const derivedEdge = edge("root-file", "child", {
    edgeId: "derive-budget-not-started",
    kind: "derive",
    baselineVersion: 1,
    latestVersion: 2,
    sourceParameters: [
      {
        name: "sourceLength",
        internal_value: 0.2,
        internal_unit: "cm",
        isFavorite: true,
      },
    ],
    derivedParameters: [
      { name: "derivedLength", internal_value: 0.2, internal_unit: "cm" },
    ],
  });
  const linkedEdge = edge("root-file", "child", {
    edgeId: "linked-budget-not-started",
    kind: "linked",
    baselineVersion: 1,
    latestVersion: 2,
  });
  const graph = snapshot(["root-file", "child"], [linkedEdge, derivedEdge], {
    documents: [doc("root-file", { name: "Root" }), doc("child")],
  });
  const binding = {
    edgeId: "derive-budget-not-started",
    sourceParameter: "sourceLength",
    nativeDerivedParameter: "derivedLength",
  };
  const planInput = refresh.validate(
    request({
      phase: "plan",
      requestId: "plan-native-preflight-budget",
      nativeFallback: "qualifiedOnce",
      parameterBindings: [binding],
    }),
  );
  const plan = refresh.makePlan(graph, planInput);
  const requestId = "apply-native-preflight-budget";
  const data = request({
    phase: "apply",
    requestId,
    reportPath,
    planId: "e".repeat(64),
    confirm: true,
    nativeFallback: "qualifiedOnce",
    lifecycle: "openOwned",
    durability: "cloud",
    timeBudgetMs: 60000,
    parameterBindings: [binding],
    uiLeases: {
      "root-file": {
        target: { name: "Root", fileId: "root-file" },
        lease: {
          id: "lease",
          requestId,
          operationId: "authorized",
          expiresAt: Date.now() + 60000,
          target: { name: "Root", fileId: "root-file" },
        },
      },
    },
  });
  delete data.policy;
  const input = refresh.validate(data);
  const events: string[] = [];
  const result = await refresh.apply(null, input, plan, {
    initialSnapshot: graph,
    step: async (action: string) => {
      events.push(action);
      if (action === "preflight")
        return {
          document: doc("root-file", {
            name: "Root",
            modified: false,
            metadataComplete: true,
            isComplete: true,
            readOnly: false,
            timelineAtEnd: true,
            pendingSnapshot: false,
            health: { healthy: true, status: "pass" },
          }),
          edges: graph.edges,
          openedByRequest: true,
          identity: { creationId: "owned-root" },
        };
      if (action === "nativeUpdate")
        return {
          status: "blocked",
          notStarted: true,
          actionSubmitted: false,
          reason: "nativeUpdateBudgetInsufficientBeforeCommand",
        };
      throw new Error(
        "budget-exhausted native preflight must not proceed to " + action,
      );
    },
    inspectUi: async () => ({
      status: "nothingToDo",
      identityVerified: true,
      activeCommand: { id: "SelectCommand" },
    }),
    armWatcher: async () => {
      events.push("armWatcher");
      return {
        status: "armed",
        complete: async () => ({
          status: "nothingToDo",
          actionSubmitted: false,
        }),
        disarm: async () => events.push("watcher.disarm"),
      };
    },
  });
  assert.equal(result.invocationStatus, "partial");
  assert.equal(result.inProgress!["nativeCommandNotSubmitted"], true);
  assert.equal(
    result.inProgress!["reason"],
    "nativeUpdateBudgetInsufficientBeforeCommand",
  );
  assert.equal(result.continuation!.reason, "budgetExhausted");
  assert.deepEqual(events, [
    "preflight",
    "armWatcher",
    "nativeUpdate",
    "watcher.disarm",
  ]);
});

test("cold openOwned does not reject an exact pre-existing clean owned consumer", async (t) => {
  const reportPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-refs-cold-owned-"),
  );
  t.after(() => fs.rm(reportPath, { recursive: true, force: true }));
  const link = edge("root-file", "child", {
    edgeId: "cold-owned-link",
    kind: "linked",
    baselineVersion: 1,
    latestVersion: 2,
  });
  const graph = snapshot(["root-file", "child"], [link], {
    documents: [doc("root-file", { name: "OwnedRoot" }), doc("child")],
  });
  const planInput = refresh.validate(
    request({
      phase: "plan",
      requestId: "plan-cold-owned",
      nativeFallback: "never",
      lifecycle: "openOwned",
      durability: "cold",
    }),
  );
  const plan = refresh.makePlan(graph, planInput);
  const data = request({
    phase: "apply",
    requestId: "apply-cold-owned",
    reportPath,
    planId: "d".repeat(64),
    confirm: true,
    lifecycle: "openOwned",
    durability: "cold",
    nativeFallback: "never",
    timeBudgetMs: 60000,
  });
  delete data.policy;
  const events: string[] = [];
  const result = await refresh.apply(null, refresh.validate(data), plan, {
    initialSnapshot: {
      ...graph,
      documents: graph.documents.map((row) => ({
        ...row,
        openedByRequest: false,
      })),
    },
    step: async (action: string) => {
      events.push(action);
      if (action === "preflight")
        return {
          document: doc("root-file", {
            name: "OwnedRoot",
            modified: false,
            metadataComplete: true,
            isComplete: true,
            readOnly: false,
            timelineAtEnd: true,
            pendingSnapshot: false,
            health: { healthy: true, status: "pass" },
          }),
          edges: graph.edges,
          openedByRequest: false,
          identity: { creationId: "owned-root-editor" },
        };
      if (action === "sdkUpdate")
        return { status: "blocked", reason: "controlled no-submit stop" };
      if (action === "graph") return graph;
      throw new Error("controlled stop should not reach " + action);
    },
  });
  assert.deepEqual(events, ["preflight", "sdkUpdate", "graph"]);
  assert.equal(
    result.blocked.some(
      (row) => row.reason === "coldLifecycleOwnershipUnavailable",
    ),
    false,
  );
  assert.equal(
    result.documents.find((row) => row.fileId === "root-file")!.status,
    "blocked",
  );
});

test("a repeated apply request returns its journal receipt without any new Fusion step", async (t) => {
  const reportPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-refs-replay-"),
  );
  t.after(() => fs.rm(reportPath, { recursive: true, force: true }));
  const plan = refresh.makePlan(
    snapshot(["root-file"], []),
    refresh.validate(
      request({
        phase: "plan",
        requestId: "plan-replay",
        lifecycle: "openOwned",
        durability: "cloud",
      }),
    ),
  );
  const planId = await refresh.writePlan(reportPath, plan);
  const data = request({
    phase: "apply",
    requestId: "apply-replay",
    reportPath,
    planId,
    confirm: true,
    lifecycle: "openOwned",
    durability: "cloud",
  });
  delete data.policy;
  let calls = 0;
  const first = await refresh.execute(
    null,
    data,
    {},
    {
      step: async (action: string) => {
        calls++;
        if (action === "graph") return snapshot(["root-file"], []);
        throw new Error("no update is planned");
      },
    },
  );
  assert.equal(first.invocationStatus, "complete");
  const firstCalls = calls;
  assert.ok(firstCalls > 0);
  const replay = await refresh.execute(
    null,
    data,
    {},
    {
      step: async () => {
        throw new Error("repeated request must not contact Fusion");
      },
    },
  );
  assert.equal(replay.replayedReceipt, true);
  assert.equal(replay.invocationStatus, "complete");
  assert.equal(calls, firstCalls); // replay performs no additional Fusion step
});

test("unknown native command leaves the owned .11 watcher armed for reconciliation", async (t) => {
  const reportPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-refs-native-unknown-"),
  );
  t.after(() => fs.rm(reportPath, { recursive: true, force: true }));
  const derivedEdge = edge("root-file", "child", {
    edgeId: "derive",
    kind: "derive",
    baselineVersion: 1,
    latestVersion: 2,
    sourceParameters: [
      { name: "sourceLength", internal_value: 0.2, internal_unit: "cm" },
    ],
    derivedParameters: [
      { name: "derivedLength", internal_value: 0.2, internal_unit: "cm" },
    ],
  });
  const linkedEdge = edge("root-file", "child", {
    edgeId: "linked",
    kind: "linked",
    baselineVersion: 1,
    latestVersion: 2,
  });
  const graph = snapshot(["root-file", "child"], [linkedEdge, derivedEdge], {
    documents: [doc("root-file", { name: "Root" }), doc("child")],
  });
  const binding = {
    edgeId: "derive",
    sourceParameter: "sourceLength",
    nativeDerivedParameter: "derivedLength",
  };
  const plan = refresh.makePlan(
    graph,
    refresh.validate(
      request({
        phase: "plan",
        requestId: "plan-unknown-ui",
        nativeFallback: "qualifiedOnce",
        parameterBindings: [binding],
      }),
    ),
  );
  assert.equal(
    plan.updates.find((row) => row.fileId === "root-file")?.method,
    "UpdateAllLatestCmd",
  )!;
  assert.equal(
    plan.updates.find((row) => row.fileId === "root-file")?.fallback,
    null,
  )!;
  const data = request({
    phase: "apply",
    requestId: "apply-unknown-ui",
    reportPath,
    planId: "e".repeat(64),
    confirm: true,
    nativeFallback: "qualifiedOnce",
    lifecycle: "openOwned",
    durability: "cloud",
    parameterBindings: [binding],
    uiLeases: {
      "root-file": {
        target: { name: "Root", fileId: "root-file" },
        lease: {
          id: "lease",
          requestId: "apply-unknown-ui",
          operationId: "authorized",
          expiresAt: Date.now() + 60000,
          target: { name: "Root", fileId: "root-file" },
        },
      },
    },
  });
  delete data.policy;
  const input = refresh.validate(data);
  const events: string[] = [];
  const result = await refresh.apply(null, input, plan, {
    step: async (action: string) => {
      events.push(action);
      if (action === "preflight")
        return {
          document: doc("root-file", {
            name: "Root",
            latestVersion: 1,
            modified: false,
            dirty: false,
            metadataComplete: true,
            isComplete: true,
            readOnly: false,
            timelineAtEnd: true,
            pendingSnapshot: false,
            health: { healthy: true, status: "pass" },
          }),
          edges: graph.edges,
          openedByRequest: true,
          identity: { creationId: "owned-root" },
        };
      if (action === "nativeUpdate")
        throw new Error("simulated ambiguous native submission");
      throw new Error("no further action allowed");
    },
    inspectUi: async () => ({
      status: "nothingToDo",
      identityVerified: true,
      activeCommand: { id: "SelectCommand" },
      process: { fusionVersion: "F", osBuild: "W", locale: "pl-PL" },
    }),
    armWatcher: async () => {
      events.push("armWatcher");
      return {
        status: "armed",
        complete: async () => {
          events.push("watcher.complete");
          return { status: "actionSubmitted", actionSubmitted: true };
        },
        disarm: async () => {
          events.push("watcher.disarm");
        },
      };
    },
  });
  assert.equal(result.invocationStatus, "unknown");
  assert.equal(events.includes("sdkUpdate"), false);
  assert.equal(events.includes("armWatcher"), true);
  assert.equal(events.includes("watcher.disarm"), false);
  assert.equal(events.includes("save"), false);
});

const referenceHistory = load("./fixtures/file-workflows/load.cjs") as (
  label: string,
  file: string,
) => ReferenceApi;
const referenceVersions: [string, ReferenceApi][] = [
  ["pre-refactor", referenceHistory("baseline", "src/references-refresh.js")],
  [
    "before extraction",
    referenceHistory("before", "src/references-refresh.js"),
  ],
  ["typed planning", refresh],
];
function referenceObservation(fn: () => unknown) {
  try {
    return { value: fn() };
  } catch (error) {
    return {
      error: (error as Error).message,
      readOnlyFailure: (error as Error & { fmcadReadOnlyFailure?: unknown })
        .fmcadReadOnlyFailure,
    };
  }
}
test("typed reference validation retains exact normalized requests and deterministic refusals", () => {
  for (const data of [
    request(),
    request({ policy: "preserve" }),
    request({ phase: "apply", confirm: true, planId: "a".repeat(64) }),
    null,
    request({ root: { ...root, version: 0 } }),
    request({ allowedProjectIds: ["foreign"] }),
    request({ maxUpdates: 5, maxFiles: 2 }),
    request({ pins: [{ edgeId: "e", sourceFileId: "s", version: 0 }] }),
    request({ parameterBindings: [{ edgeId: "e", sourceParameter: "p" }] }),
    request({ uiLeases: { foreign: {} } }),
    request({ phase: "inspect" }),
    request({ phase: "apply", confirm: false }),
  ]) {
    const results = referenceVersions.map(([, api]) =>
      referenceObservation(() => api.validate(structuredClone(data))),
    );
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(results[2], results[0]);
  }
});
test("typed reference plans retain complete graph pins, blockers, ordering and snapshot effects", () => {
  const graphs = [
    snapshot(["root-file", "child"], [edge("root-file", "child")]),
    snapshot(
      ["root-file", "left", "right", "shared"],
      [
        edge("root-file", "left"),
        edge("root-file", "right"),
        edge("left", "shared"),
        edge("right", "shared"),
      ],
    ),
    snapshot(
      ["root-file", "child"],
      [edge("root-file", "child"), edge("child", "root-file")],
    ),
    snapshot(
      ["root-file"],
      [edge("root-file", "root-file", { selfReference: true })],
    ),
    snapshot(
      ["root-file", "child"],
      [edge("root-file", "child"), edge("root-file", "child")],
    ),
    snapshot(["root-file"], [edge("root-file", "missing")]),
    snapshot(
      ["root-file", "child"],
      [edge("root-file", "child", { sourceProjectId: "foreign" })],
    ),
  ];
  for (const graph of graphs)
    for (const options of [
      {},
      { policy: "preserve" },
      { maxFiles: 1 },
      { nativeFallback: "qualifiedOnce" },
    ]) {
      const results = referenceVersions.map(([, api]) =>
        referenceObservation(() => {
          const copy = structuredClone(graph),
            input = api.validate(request(options));
          const plan = api.makePlan(copy, input);
          return { plan, snapshotAfter: copy };
        }),
      );
      assert.deepEqual(results[1], results[0]);
      assert.deepEqual(results[2], results[0]);
    }
});
test("typed reference freshness refuses changed identities, versions, health and edge evidence identically", () => {
  const graph = snapshot(["root-file", "child"], [edge("root-file", "child")]);
  const mutations = [
    () => {},
    (g: FixtureSnapshot) => {
      g.documents[0]!.version = 2;
    },
    (g: FixtureSnapshot) => {
      g.documents[0]!.projectId = "foreign";
    },
    (g: FixtureSnapshot) => {
      g.documents[0]!.latestVersion = 4;
    },
    (g: FixtureSnapshot) => {
      g.documents[0]!.modified = true;
    },
    (g: FixtureSnapshot) => {
      g.documents[0]!.readOnly = true;
    },
    (g: FixtureSnapshot) => {
      g.documents[0]!.health!.healthy = false;
    },
    (g: FixtureSnapshot) => {
      g.edges[0]!["sourceFileId"] = "foreign";
    },
    (g: FixtureSnapshot) => {
      g.edges[0]!["latestVersion"] = 7;
    },
    (g: FixtureSnapshot) => {
      g.edges.length = 0;
    },
    (g: FixtureSnapshot) => {
      g.documents.length = 0;
    },
  ];
  for (const mutate of mutations) {
    const results = referenceVersions.map(([, api]) => {
      const plan = api.makePlan(
          structuredClone(graph),
          api.validate(request()),
        ),
        fresh = structuredClone(graph);
      mutate(fresh);
      return {
        freshness: api.planFreshness(plan, fresh),
        step: api.staleBeforeStep(plan, fresh, "root-file"),
      };
    });
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(results[2], results[0]);
  }
});

test("reference apply keeps historical mutation counts and reopens receipts for settled and uncertain outcomes", async (t) => {
  for (const outcome of [
    "complete",
    "unknown-update",
    "failed-save",
    "processing-save",
  ]) {
    const observations = [];
    for (const [label, api] of referenceVersions) {
      const reportPath = await fs.mkdtemp(
        path.join(os.tmpdir(), "refs-paired-lifecycle-"),
      );
      t.after(() => fs.rm(reportPath, { recursive: true, force: true }));
      const graph = snapshot(
        ["root-file", "child"],
        [edge("root-file", "child")],
      );
      const plan = api.makePlan(
        structuredClone(graph),
        api.validate(
          request({
            requestId: "original-plan",
            reportPath,
            lifecycle: "openOwned",
            durability: "cloud",
          }),
        ),
      );
      const original = structuredClone(plan),
        planId = await api.writePlan(reportPath, plan);
      const inputData = request({
        phase: "apply",
        requestId: "owned-apply",
        reportPath,
        planId,
        scopeFileId: root.fileId,
        confirm: true,
        lifecycle: "openOwned",
        durability: "cloud",
      });
      const input = api.validate(inputData),
        calls: string[] = [];
      const deps = {
        now: () => 100,
        step: async (action: string) => {
          calls.push(action);
          if (action === "preflight")
            return {
              document: doc("root-file"),
              edges: graph.edges,
              openedByRequest: true,
              identity: { creationId: "owned-root" },
            };
          if (action === "sdkUpdate")
            return outcome === "unknown-update"
              ? { status: "unknown", outcome: "unknown", modified: true }
              : {
                  status: "complete",
                  modified: true,
                  checks: checkPass(),
                  identity: { creationId: "owned-root" },
                  openedByRequest: true,
                };
          if (action === "save") {
            if (outcome === "failed-save")
              return { status: "failed", error: "injected save refusal" };
            if (outcome === "processing-save")
              return { status: "pending", resultingVersion: 2 };
            return {
              status: "complete",
              resultingVersion: 2,
              parameters: [],
              metadataCoverage: { component: "complete" },
            };
          }
          if (action === "graph")
            return snapshot(
              ["root-file", "child"],
              [
                edge("root-file", "child", {
                  baselineVersion: 2,
                  latestVersion: 2,
                  status: "current",
                }),
              ],
            );
          throw new Error(
            "Unexpected mutation after " + outcome + ": " + action,
          );
        },
      };
      const result = await api.apply(null, input, plan, deps);
      assert.deepEqual(
        plan,
        original,
        label + ": apply must not mutate the immutable plan",
      );
      assert.deepEqual(await api.readPlan(reportPath, planId), original);
      const beforeReopen = [...calls];
      const replayed = await api.execute(null, input, {}, deps);
      assert.equal(replayed.invocationStatus, result.invocationStatus);
      assert.deepEqual(
        calls,
        beforeReopen,
        label + ": receipt replay must not submit again",
      );
      const inspected = await api.execute(
        null,
        { ...input, phase: "inspect" },
        {},
        {
          step: async () => {
            throw new Error("receipt reopen must not call Fusion");
          },
        },
      );
      assert.equal(
        inspected.latestReceipt.result.invocationStatus,
        result.invocationStatus,
      );
      assert.deepEqual(calls, beforeReopen);
      assert.equal(calls.filter((a) => a === "sdkUpdate").length, 1);
      assert.equal(
        calls.filter((a) => a === "save").length,
        outcome === "unknown-update" ? 0 : 1,
      );
      observations.push({
        calls,
        status: result.invocationStatus,
        success: result.success,
        completed: result.completed,
        failed: result.failed,
        unknown: result.unknown,
        documents: result.documents.map((d) => ({
          fileId: d.fileId,
          version: d.resultingVersion,
          status: d.status,
          saveStatus: d.saveStatus,
        })),
      });
    }
    assert.deepEqual(observations[1], observations[0], outcome);
    assert.deepEqual(observations[2], observations[0], outcome);
  }
});

test(
  "production checker admits the public reference action wrapper against pinned Python interfaces",
  { timeout: 180000 },
  async () => {
    const { prepareCadBundle } =
      load("../packages/node-adapters/dist/python/bundle") as typeof import("../packages/node-adapters/src/python/bundle");
    const { createPythonChecker } =
      load("../packages/node-adapters/dist/python/checker") as typeof import("../packages/node-adapters/src/python/checker");
    const project = process.cwd(),
      typingRoot = path.join(project, "dist/runtime/python/typing");
    const artifact = prepareCadBundle(
      project,
      '\n\n_FMCAD_REFERENCE_REQUEST: JsonObject = {"action": "graph", "data": {}}\ndef run(_context: str) -> None:\n    import json\n    _request = _FMCAD_REFERENCE_REQUEST\n    _result = _references_refresh_internal(_request["action"], _request["data"])\n    print("FMCAD_RESULT " + json.dumps(_cad_json(_result), allow_nan=False))\n',
    );
    const checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      pythonPlatform: "Windows",
    });
    const report = await checker.check({
      artifact,
      context: { kind: "bundle" },
    });
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(report.provenance.checker, "basedpyright");
  },
);
