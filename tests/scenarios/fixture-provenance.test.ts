import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Document, ScenarioBackend } from "./contracts";
import { marker } from "./programs";
import { runScenarios } from "./runner";
import {
  assertFencedClosedDocumentInventory,
  assertFencedDocumentInventory,
  assertOwnedUnsavedDocument,
  assertPreservedDocumentInventory,
  assertReceiptBoundDocumentInventory,
  currentProcessIdentity,
  discoverOwnedUnsavedFixtures,
  discoverOwnedUnsavedFixtureProofs,
  originalActiveDocument,
} from "./fixture-provenance";

const backend: Pick<
  ScenarioBackend,
  "identity" | "mode" | "qualification" | "protocol"
> = {
  identity: "provenance-test:v1",
  mode: "simulator",
  qualification: "broker",
  protocol: "mcp",
};

function reportFixture(t: { after(fn: () => void): void }) {
  const parent = path.join(process.cwd(), ".test-artifacts");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "fixture-provenance-")),
    runId = randomUUID(),
    scenarioId = "peer-owner",
    clientId = "scenario:" + runId + ":" + scenarioId,
    directory = path.join(root, runId, scenarioId),
    runRoot = path.dirname(directory),
    indexFile = path.join(runRoot, "index.json"),
    reportFile = path.join(directory, "report.json"),
    creationId = randomUUID(),
    requestId = clientId + ":0",
    document: Document = { creationId, name: "Owned unsaved fixture" },
    identity = {
      ...document,
      requestId,
      clientId,
      activeCreationId: creationId,
    },
    report = {
      owner: { runId, scenarioId, clientId },
      directory,
      mode: backend.mode,
      qualification: backend.qualification,
      protocol: backend.protocol,
      backendIdentity: backend.identity,
      scope: "exclusive-instance",
      status: "running",
      cleanup: "pending",
      requests: [
        {
          requestId,
          phase: "create",
          intent: { kind: "script" },
          result: {
            requestId,
            state: "succeeded",
            sdkSettled: true,
            mayHaveMutated: true,
            stdout: marker + JSON.stringify(identity),
            brokerReceipt: {
              requestId,
              clientId,
              jobId: randomUUID(),
              state: "succeeded",
            },
          },
        },
      ],
      document,
    };
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    indexFile,
    JSON.stringify({
      runId,
      mode: backend.mode,
      qualification: backend.qualification,
      protocol: backend.protocol,
      backendIdentity: backend.identity,
      processIdentity: currentProcessIdentity(),
      before: { documents: [] },
      scenarioIds: [scenarioId],
      status: "running",
    }),
    { mode: 0o600 },
  );
  fs.writeFileSync(reportFile, JSON.stringify(report), { mode: 0o600 });
  fs.writeFileSync(
    path.join(directory, "creation.json"),
    JSON.stringify(identity),
    { mode: 0o600 },
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, runRoot, indexFile, reportFile, document, report, identity };
}

function terminalFixture(t: { after(fn: () => void): void }) {
  const f = reportFixture(t);
  const create = f.report.requests[0]!;
  const requestId = f.report.owner.clientId + ":1";
  const jobId = randomUUID();
  Object.assign(create.result.brokerReceipt, {
    operationResult: {
      version: 1,
      requestId: create.requestId,
      jobId: create.result.brokerReceipt.jobId,
      acceptance: "accepted",
      executionOutcome: "succeeded",
      mayHaveMutated: true,
    },
  });
  f.report.requests.push({
    requestId,
    phase: "cad-batch-reference",
    intent: { kind: "cad" },
    result: {
      requestId,
      state: "failed",
      sdkSettled: true,
      mayHaveMutated: false,
      stdout: "",
      brokerReceipt: Object.assign(
        {
          requestId,
          clientId: f.report.owner.clientId,
          jobId,
          state: "failed",
        },
        {
          operationResult: {
            version: 1,
            requestId,
            jobId,
            acceptance: "accepted",
            executionOutcome: "not_started",
            mayHaveMutated: false,
          },
        },
      ),
    },
  });
  Object.assign(f.report, {
    status: "failed",
    cleanup: "deferred",
    cleanupHold: { requestId, reason: "Retain the original failed fixture" },
  });
  fs.writeFileSync(f.reportFile, JSON.stringify(f.report));
  return f;
}

test("terminal settled peer retains inventory provenance without granting cleanup", (t) => {
  const f = terminalFixture(t);
  const proofs = discoverOwnedUnsavedFixtureProofs(f.root, backend);
  assert.equal(proofs.get(f.document.creationId)?.state, "retained");
  assertReceiptBoundDocumentInventory(
    [],
    [{ ...f.document, saved: false, fileId: null, modified: false }],
    proofs,
    "A settled failed peer remains an exact visible identity",
  );
  assert.throws(() =>
    assertReceiptBoundDocumentInventory(
      [],
      [],
      proofs,
      "Retained never means closed",
    ),
  );
  assert.throws(
    () =>
      assertFencedDocumentInventory(
        [{ ...f.document, saved: false, fileId: null, modified: false }],
        [{ ...f.document, saved: false, fileId: null, modified: false }],
        f.document,
        [],
        proofs,
        "Retained is not a live own target",
      ),
    /Owned target lacks live open provenance/u,
  );
});

test("retained provenance does not assert that settled failed work was nonmutating", (t) => {
  const f = terminalFixture(t);
  const row = f.report.requests.at(-1)!;
  row.result.mayHaveMutated = true;
  Object.assign(row.result.brokerReceipt, {
    operationResult: {
      version: 1,
      requestId: row.requestId,
      jobId: row.result.brokerReceipt.jobId,
      acceptance: "accepted",
      executionOutcome: "failed",
      mayHaveMutated: true,
    },
  });
  fs.writeFileSync(f.reportFile, JSON.stringify(f.report));
  const proofs = discoverOwnedUnsavedFixtureProofs(f.root, backend);
  assert.equal(proofs.get(f.document.creationId)?.state, "retained");
  const target = { creationId: randomUUID(), name: "Other owned target" };
  const peer = { ...f.document, saved: false, fileId: null, modified: false };
  const own = { ...target, saved: false, fileId: null, modified: false };
  assert.throws(() =>
    assertFencedDocumentInventory(
      [peer, own],
      [{ ...peer, modified: true }, own],
      target,
      [],
      proofs,
      "A retained peer may not change inside another owner's SDK turn",
    ),
  );
});

for (const failure of [
  "missing",
  "foreign",
  "unknown",
  "pending",
  "job",
  "outcome",
  "mutation",
  "save",
  "cleanup",
  "legacy",
  "gap",
  "missing-operation",
  "hold",
] as const) {
  test(`terminal peer does not gain retained provenance with ${failure} evidence`, (t) => {
    const f = terminalFixture(t);
    const row = f.report.requests.at(-1)!;
    const receipt = row.result.brokerReceipt;
    const value = JSON.parse(JSON.stringify(f.report)) as Record<
      string,
      unknown
    >;
    if (failure === "foreign") receipt.clientId = "foreign";
    if (failure === "unknown") row.result.state = "unknown";
    if (failure === "pending") row.result.sdkSettled = false;
    if (failure === "job")
      Object.assign(receipt, { operationResult: { jobId: "foreign" } });
    if (failure === "outcome")
      Object.assign(receipt, {
        operationResult: { executionOutcome: "unknown" },
      });
    if (failure === "mutation")
      Object.assign(receipt, { operationResult: { mayHaveMutated: true } });
    if (failure === "save") row.phase = "save";
    if (failure === "cleanup") row.phase = "cleanup";
    if (failure === "legacy") row.intent.kind = "legacy-cli";
    if (failure === "missing-operation")
      Object.assign(receipt, { operationResult: undefined });
    if (failure === "hold")
      Object.assign(f.report, {
        cleanupHold: { requestId: "foreign", reason: "unbound hold" },
      });
    // Serialize the deliberately invalid evidence without changing production types.
    if (failure === "missing") {
      const requests = value["requests"] as Record<string, unknown>[];
      delete (requests.at(-1)!["result"] as Record<string, unknown>)[
        "brokerReceipt"
      ];
      fs.writeFileSync(f.reportFile, JSON.stringify(value));
    } else if (failure === "gap") {
      fs.writeFileSync(
        f.reportFile,
        JSON.stringify(f.report).replaceAll(
          f.report.owner.clientId + ":1",
          f.report.owner.clientId + ":2",
        ),
      );
    } else fs.writeFileSync(f.reportFile, JSON.stringify(f.report));
    assert.notEqual(
      discoverOwnedUnsavedFixtureProofs(f.root, backend).get(
        f.document.creationId,
      )?.state,
      "retained",
    );
  });
}

for (const failure of [
  "no-binding",
  "no-resolution",
  "forged-resolution",
  "foreign-request",
  "not-last",
  "different-hold",
] as const) {
  test(`readonly legacy creator qualification refuses ${failure} rather than allowing a request prefix`, (t) => {
    const f = reportFixture(t);
    const requestId =
      f.report.owner.clientId + ":legacy:76143149-87b4-4285-8b1d-70dda390da6c";
    const create = f.report.requests[0]!;
    const legacy = {
      ...create,
      phase: "legacy-cli",
      requestId,
      result: {
        ...create.result,
        requestId,
        brokerReceipt: {
          ...create.result.brokerReceipt,
          requestId,
          jobId: randomUUID(),
        },
      },
    };
    f.report.requests.push(legacy);
    Object.assign(f.report, {
      cleanup: "deferred",
      cleanupHold: {
        requestId,
        reason:
          "Native import child retained an uncertain outcome; inspect original requests",
      },
    });
    if (failure !== "no-binding")
      fs.writeFileSync(
        path.join(
          path.dirname(f.reportFile),
          "cleanup-legacy-readonly-binding.json",
        ),
        JSON.stringify({ version: 1, owner: f.report.owner }),
      );
    if (failure === "forged-resolution")
      fs.writeFileSync(
        path.join(path.dirname(f.reportFile), "cleanup-hold-resolution.json"),
        JSON.stringify({
          runtime: { buildHash: "a".repeat(64), instanceId: "forged-runtime" },
          holdKind: "settled-legacy-doc-list",
        }),
      );
    if (failure === "foreign-request")
      legacy.requestId = "foreign:" + requestId;
    if (failure === "not-last")
      f.report.requests.push({
        ...create,
        phase: "observe-after-legacy",
        requestId: f.report.owner.clientId + ":3",
      });
    if (failure === "different-hold")
      Object.assign(f.report, {
        cleanupHold: {
          requestId: create.requestId,
          reason:
            "Native import child retained an uncertain outcome; inspect original requests",
        },
      });
    fs.writeFileSync(f.reportFile, JSON.stringify(f.report));
    const before = fs.readFileSync(f.reportFile);
    assert.equal(
      discoverOwnedUnsavedFixtureProofs(f.root, backend).has(
        f.document.creationId,
      ),
      false,
    );
    assert.deepEqual(fs.readFileSync(f.reportFile), before);
  });
}

test("an unsettled held peer remains in the coordinator baseline", async (t) => {
  const fixture = reportFixture(t);
  Object.assign(fixture.report, {
    cleanup: "deferred",
    cleanupHold: { requestId: fixture.identity.requestId, reason: "held" },
  });
  fs.writeFileSync(fixture.reportFile, JSON.stringify(fixture.report));
  const user = {
      creationId: "user-sentinel",
      name: "User design",
      saved: false,
      modified: false,
      fileId: null,
    },
    documents = [
      {
        ...fixture.document,
        saved: false,
        modified: false,
        fileId: null,
      },
      user,
    ],
    liveBackend: ScenarioBackend = {
      ...backend,
      capabilities: new Set(),
      fusionPath: (filename) => filename,
      execute: async (request) => ({
        requestId: request.requestId,
        state: "succeeded",
        sdkSettled: true,
        mayHaveMutated: false,
        stdout: marker + JSON.stringify({ active: null, documents }) + "\n",
      }),
    },
    existingRuns = new Set(fs.readdirSync(fixture.root));

  const reports = await runScenarios(
    liveBackend,
    [
      {
        id: "readonly-audit",
        requires: [],
        scope: "exclusive-instance",
        lifecycle: "read-only",
        async run() {},
      },
    ],
    fixture.root,
    1,
  );

  assert.equal(reports[0]?.status, "passed", reports[0]?.error);
  const runId = fs
    .readdirSync(fixture.root)
    .find((entry) => !existingRuns.has(entry));
  assert.ok(runId);
  const index = JSON.parse(
    fs.readFileSync(path.join(fixture.root, runId, "index.json"), "utf8"),
  ) as { before: { documents: Array<{ creationId: string }> } };
  assert.ok(
    index.before.documents.some(
      (document) => document.creationId === fixture.document.creationId,
    ),
  );
});

test("final read-only audit admits a newly visible held peer but ignores never-observed history", async (t) => {
  const fixture = reportFixture(t);
  Object.assign(fixture.report, {
    cleanup: "deferred",
    cleanupHold: { requestId: fixture.identity.requestId, reason: "held" },
  });
  fs.writeFileSync(fixture.reportFile, JSON.stringify(fixture.report));
  const user = {
      creationId: "user-sentinel",
      name: "User design",
      saved: false,
      modified: false,
      fileId: null,
    },
    peer = { ...fixture.document, saved: false, modified: false, fileId: null };
  for (const visible of [false, true]) {
    let snapshots = 0;
    const reports = await runScenarios(
      {
        ...backend,
        capabilities: new Set(),
        fusionPath: (filename) => filename,
        execute: async (request) => ({
          requestId: request.requestId,
          state: "succeeded",
          sdkSettled: true,
          mayHaveMutated: false,
          stdout:
            marker +
            JSON.stringify({
              active: null,
              documents: ++snapshots > 1 && visible ? [user, peer] : [user],
            }),
        }),
      },
      [
        {
          id: "readonly-peer-audit",
          requires: [],
          scope: "exclusive-instance",
          lifecycle: "read-only",
          async run() {},
        },
      ],
      fixture.root,
      1,
    );
    assert.equal(reports[0]?.status, "passed", reports[0]?.error);
    assert.equal(snapshots, 2);
  }
});

test("owned unsaved cleanup preserves the same-turn foreign inventory", (t) => {
  const fixture = reportFixture(t),
    user = {
      creationId: "user-sentinel",
      name: "User design",
      saved: false,
      modified: false,
      fileId: null,
    },
    before = [
      {
        ...fixture.document,
        saved: false,
        modified: true,
        fileId: null,
      },
      user,
    ],
    after = [user];

  assert.doesNotThrow(() =>
    assertFencedClosedDocumentInventory(
      before,
      after,
      fixture.document,
      "foreign inventory changed",
    ),
  );
  assert.throws(
    () =>
      assertFencedClosedDocumentInventory(
        before,
        [{ ...user, modified: true }],
        fixture.document,
        "foreign inventory changed",
      ),
    /foreign inventory changed/u,
  );
});

test("only a live owner with its exact settled creation receipt authorizes a peer fixture", (t) => {
  const fixture = reportFixture(t),
    owned = discoverOwnedUnsavedFixtures(fixture.root, backend);
  assert.deepEqual(owned.get(fixture.document.creationId), fixture.document);
  assert.doesNotThrow(() =>
    assertPreservedDocumentInventory(
      [],
      [
        {
          ...fixture.document,
          saved: false,
          modified: true,
          fileId: null,
        },
      ],
      owned,
      "unexpected fixture",
    ),
  );
});

test("an exact pending cleanup intent authorizes only a peer still in inventory", (t) => {
  const fixture = reportFixture(t),
    requestId = fixture.identity.clientId + ":1",
    requests = fixture.report["requests"] as Record<string, unknown>[];
  requests.push({
    requestId,
    phase: "cleanup",
    intent: { kind: "script" },
  });
  fs.writeFileSync(fixture.reportFile, JSON.stringify(fixture.report));
  const proofs = discoverOwnedUnsavedFixtureProofs(fixture.root, backend),
    current = [
      {
        ...fixture.document,
        saved: false,
        modified: false,
        fileId: null,
      },
    ];
  assert.equal(proofs.get(fixture.document.creationId)?.state, "open");
  assert.doesNotThrow(() =>
    assertReceiptBoundDocumentInventory(
      [],
      current,
      proofs,
      "pending peer cleanup lost its fixture",
    ),
  );
  assert.throws(
    () =>
      assertReceiptBoundDocumentInventory(
        [],
        [],
        proofs,
        "pending peer cleanup lost its fixture",
      ),
    /live receipt-proven fixture is missing/u,
  );
});

for (const status of ["passed", "failed"] as const) {
  test(`a ${status} scenario remains owned while its live runner cleans it up`, (t) => {
    const fixture = reportFixture(t);
    fixture.report["status"] = status;
    fs.writeFileSync(fixture.reportFile, JSON.stringify(fixture.report));
    assert.deepEqual(
      discoverOwnedUnsavedFixtures(fixture.root, backend).get(
        fixture.document.creationId,
      ),
      fixture.document,
    );
  });
}

for (const corruption of [
  "unknown",
  "mismatched-receipt",
  "mismatched-request",
  "missing-job",
  "request-prefix",
  "duplicate-request",
  "creation-identity",
  "stale-process",
  "dead-process",
  "cleanup-hold",
  "owner",
  "runtime",
  "config",
] as const) {
  test(`${corruption} owner evidence cannot authorize a new document`, (t) => {
    const fixture = reportFixture(t),
      requests = fixture.report["requests"] as {
        requestId: string;
        result: Record<string, unknown>;
      }[];
    if (corruption === "unknown") requests[0]!.result["state"] = "unknown";
    else if (corruption === "mismatched-receipt") {
      const receipt = requests[0]!.result["brokerReceipt"] as Record<
        string,
        unknown
      >;
      requests[0]!.result["brokerReceipt"] = {
        ...receipt,
        clientId: "another-client",
      };
    } else if (corruption === "mismatched-request") {
      const receipt = requests[0]!.result["brokerReceipt"] as Record<
        string,
        unknown
      >;
      requests[0]!.result["brokerReceipt"] = {
        ...receipt,
        requestId: "another-request",
      };
    } else if (corruption === "missing-job") {
      const receipt = requests[0]!.result["brokerReceipt"] as Record<
        string,
        unknown
      >;
      delete receipt["jobId"];
    } else if (corruption === "request-prefix") {
      requests[0]!.requestId += ":unexpected";
    } else if (corruption === "duplicate-request") {
      requests.push(Object.assign({}, requests[0]!, { phase: "observe" }));
    } else if (corruption === "creation-identity") {
      const result = requests[0]!.result,
        output = JSON.parse(
          (result["stdout"] as string).slice(marker.length),
        ) as Record<string, unknown>;
      output["creationId"] = randomUUID();
      result["stdout"] = marker + JSON.stringify(output);
    } else if (corruption === "stale-process") {
      const index = JSON.parse(
        fs.readFileSync(fixture.indexFile, "utf8"),
      ) as Record<string, unknown>;
      index["processIdentity"] = {
        pid: process.pid,
        birth: "not-the-current-process:0",
      };
      fs.writeFileSync(fixture.indexFile, JSON.stringify(index));
    } else if (corruption === "dead-process") {
      const index = JSON.parse(
        fs.readFileSync(fixture.indexFile, "utf8"),
      ) as Record<string, unknown>;
      index["processIdentity"] = {
        pid: 2_147_483_647,
        birth: "dead-process:0",
      };
      fs.writeFileSync(fixture.indexFile, JSON.stringify(index));
    } else if (corruption === "cleanup-hold") {
      (fixture.report as Record<string, unknown>)["cleanupHold"] = {
        requestId: (fixture.report["requests"] as { requestId: string }[])[0]!
          .requestId,
        reason: "Do not infer ownership while cleanup is held",
      };
    } else if (corruption === "owner") {
      (fixture.report["owner"] as Record<string, unknown>)["scenarioId"] =
        "another-owner";
    } else if (corruption === "runtime") {
      const identity = "provenance-test:another-runtime";
      (fixture.report as Record<string, unknown>)["backendIdentity"] = identity;
      const index = JSON.parse(
        fs.readFileSync(fixture.indexFile, "utf8"),
      ) as Record<string, unknown>;
      index["backendIdentity"] = identity;
      fs.writeFileSync(fixture.indexFile, JSON.stringify(index));
    } else {
      (fixture.report as Record<string, unknown>)["protocol"] = "addin";
      const index = JSON.parse(
        fs.readFileSync(fixture.indexFile, "utf8"),
      ) as Record<string, unknown>;
      index["protocol"] = "addin";
      fs.writeFileSync(fixture.indexFile, JSON.stringify(index));
    }
    fs.writeFileSync(fixture.reportFile, JSON.stringify(fixture.report));
    const owned = discoverOwnedUnsavedFixtures(fixture.root, backend);
    assert.equal(owned.has(fixture.document.creationId), false);
    assert.throws(
      () =>
        assertPreservedDocumentInventory(
          [],
          [
            {
              ...fixture.document,
              saved: false,
              modified: false,
              fileId: null,
            },
          ],
          owned,
          "unowned document appeared",
        ),
      /unowned document appeared/u,
    );
  });
}

test("a different campaign artifact root cannot authorize a fixture", (t) => {
  const fixture = reportFixture(t),
    unrelatedRoot = fs.mkdtempSync(
      path.join(path.dirname(fixture.root), "unrelated-scenario-root-"),
    );
  t.after(() => fs.rmSync(unrelatedRoot, { recursive: true, force: true }));
  const owned = discoverOwnedUnsavedFixtures(unrelatedRoot, backend);
  assert.equal(owned.has(fixture.document.creationId), false);
  assert.throws(
    () =>
      assertPreservedDocumentInventory(
        [],
        [
          {
            ...fixture.document,
            saved: false,
            modified: false,
            fileId: null,
          },
        ],
        owned,
        "unproven fixture appeared",
      ),
    /unproven fixture appeared/u,
  );
});

test("a peer's baseline disappearance is allowed only with its exact live proof", (t) => {
  const fixture = reportFixture(t),
    owned = discoverOwnedUnsavedFixtures(fixture.root, backend),
    user = {
      creationId: "user-sentinel",
      name: "User design",
      saved: false,
      modified: false,
      fileId: null,
    },
    baseline = [
      user,
      { ...fixture.document, saved: false, modified: false, fileId: null },
    ];
  assert.doesNotThrow(() =>
    assertPreservedDocumentInventory(
      baseline,
      [user],
      owned,
      "a proven peer fixture closed during the run",
    ),
  );

  const requests = fixture.report["requests"] as {
    result: Record<string, unknown>;
  }[];
  requests[0]!.result["state"] = "unknown";
  fs.writeFileSync(fixture.reportFile, JSON.stringify(fixture.report));
  const unproven = discoverOwnedUnsavedFixtures(fixture.root, backend);
  assert.equal(unproven.has(fixture.document.creationId), false);
  assert.throws(
    () =>
      assertPreservedDocumentInventory(
        baseline,
        [user],
        unproven,
        "unproven peer disappeared from baseline",
      ),
    /unproven peer disappeared from baseline/u,
  );
});

test("a proven peer fixture never exempts a changed baseline document", (t) => {
  const fixture = reportFixture(t),
    owned = discoverOwnedUnsavedFixtures(fixture.root, backend);
  assert.throws(
    () =>
      assertPreservedDocumentInventory(
        [
          {
            creationId: "user-document",
            name: "User document",
            saved: false,
            modified: false,
            fileId: null,
          },
        ],
        [
          {
            creationId: "user-document",
            name: "User document",
            saved: false,
            modified: true,
            fileId: null,
          },
          {
            ...fixture.document,
            saved: false,
            modified: false,
            fileId: null,
          },
        ],
        owned,
        "baseline changed",
      ),
    /baseline changed/u,
  );
});

test("a proven fixture's current identity and unsaved state remain exact", (t) => {
  const fixture = reportFixture(t),
    owned = discoverOwnedUnsavedFixtures(fixture.root, backend);
  assert.throws(
    () =>
      assertPreservedDocumentInventory(
        [],
        [
          {
            ...fixture.document,
            name: "Renamed foreign document",
            saved: false,
            modified: false,
            fileId: null,
          },
        ],
        owned,
        "baseline changed",
      ),
    /Owned fixture name changed/u,
  );
  assert.throws(
    () =>
      assertPreservedDocumentInventory(
        [],
        [
          {
            ...fixture.document,
            saved: true,
            modified: false,
            fileId: "cloud-file",
          },
        ],
        owned,
        "baseline changed",
      ),
    /unexpectedly saved/u,
  );
});

test("same-turn inventory fence permits a receipt-proven peer but rejects its mutation", () => {
  const target = { creationId: "owned-target", name: "Owned target" },
    peer = { creationId: "receipt-proven-peer", name: "Peer fixture" },
    user = {
      creationId: "baseline-user",
      name: "User design",
      saved: true,
      modified: false,
      fileId: "user-cloud-file",
    },
    row = (document: Document, modified = false) => ({
      ...document,
      saved: false,
      modified,
      fileId: null,
    }),
    before = [user, row(target), row(peer)],
    peers = new Map([
      [peer.creationId, { document: peer, state: "open" as const }],
    ]);
  assert.doesNotThrow(() =>
    assertFencedDocumentInventory(
      before,
      [user, row(target, true), row(peer)],
      target,
      [user],
      peers,
      "foreign same-turn mutation",
    ),
  );
  assert.throws(
    () =>
      assertFencedDocumentInventory(
        before,
        [user, row(target), row(peer, true)],
        target,
        [user],
        peers,
        "foreign same-turn mutation",
      ),
    /foreign same-turn mutation/u,
  );
});

test("fenced inventory rejects unproven documents and baseline file-provenance drift", () => {
  const target = { creationId: "owned-target", name: "Owned target" },
    user = {
      creationId: "baseline-user",
      name: "User design",
      saved: true,
      modified: false,
      fileId: "user-cloud-file",
    },
    row = (document: Document) => ({
      ...document,
      saved: false,
      modified: false,
      fileId: null,
    }),
    baseline = [user],
    targetRow = row(target),
    unknown = row({ creationId: "unproven", name: "Unproven fixture" });
  assert.throws(
    () =>
      assertFencedDocumentInventory(
        [user, targetRow, unknown],
        [user, targetRow, unknown],
        target,
        baseline,
        new Map(),
        "Unproven non-baseline document",
      ),
    /Unproven non-baseline document/u,
  );
  assert.throws(
    () =>
      assertReceiptBoundDocumentInventory(
        baseline,
        [{ ...user, fileId: "different-cloud-file" }],
        new Map(),
        "baseline file provenance changed",
      ),
    /baseline file provenance changed/u,
  );
});

test("a peer may disappear only after its exact settled close receipt", (t) => {
  const fixture = reportFixture(t),
    requestId = fixture.identity.clientId + ":1",
    jobId = randomUUID(),
    requests = fixture.report["requests"] as Record<string, unknown>[];
  requests.push({
    requestId,
    phase: "cleanup",
    intent: { kind: "script" },
    result: {
      requestId,
      state: "succeeded",
      sdkSettled: true,
      mayHaveMutated: true,
      stdout:
        marker +
        JSON.stringify({
          creationId: fixture.document.creationId,
          closed: true,
        }),
      brokerReceipt: {
        requestId,
        clientId: fixture.identity.clientId,
        jobId,
        state: "succeeded",
      },
    },
  });
  fixture.report["cleanup"] = "complete";
  fs.writeFileSync(fixture.reportFile, JSON.stringify(fixture.report));
  const proofs = discoverOwnedUnsavedFixtureProofs(fixture.root, backend);
  assert.equal(proofs.get(fixture.document.creationId)?.state, "closed");
  const baseline = [
      {
        creationId: "baseline-user",
        name: "User design",
        saved: false,
        modified: false,
        fileId: null,
      },
    ],
    current = baseline;
  assert.doesNotThrow(() =>
    assertReceiptBoundDocumentInventory(
      [
        ...baseline,
        { ...fixture.document, saved: false, modified: false, fileId: null },
      ],
      current,
      proofs,
      "peer disappeared without its exact cleanup receipt",
    ),
  );

  const close = requests[1]!["result"] as Record<string, unknown>,
    closeReceipt = close["brokerReceipt"] as Record<string, unknown>;
  close["brokerReceipt"] = { ...closeReceipt, clientId: "another-client" };
  fs.writeFileSync(fixture.reportFile, JSON.stringify(fixture.report));
  const unverified = discoverOwnedUnsavedFixtureProofs(fixture.root, backend);
  assert.equal(unverified.get(fixture.document.creationId)?.state, "unsettled");
  assert.throws(
    () =>
      assertReceiptBoundDocumentInventory(
        [
          ...baseline,
          { ...fixture.document, saved: false, modified: false, fileId: null },
        ],
        current,
        unverified,
        "peer disappeared without its exact cleanup receipt",
      ),
    /exact cleanup receipt/u,
  );
});

test("an unresolved held fixture is protected as baseline, never admitted as a peer", (t) => {
  const fixture = reportFixture(t),
    index = JSON.parse(fs.readFileSync(fixture.indexFile, "utf8")) as Record<
      string,
      unknown
    >,
    requests = fixture.report["requests"] as Record<string, unknown>[],
    failedRequestId = fixture.identity.clientId + ":4",
    user = {
      creationId: "user-sentinel",
      name: "User design",
      saved: false,
      modified: false,
      fileId: null,
    },
    held = {
      ...fixture.document,
      saved: false,
      modified: false,
      fileId: null,
    },
    baseline = [user, held];
  requests.push({
    requestId: failedRequestId,
    phase: "cad-attribute-4-shape.box",
    intent: { kind: "cad-fenced", operation: "shape.box" },
    result: {
      requestId: failedRequestId,
      state: "failed",
      sdkSettled: true,
      mayHaveMutated: false,
      error: "PYTHON_CHECK_REJECTED before SDK submission",
      brokerReceipt: {
        requestId: failedRequestId,
        clientId: fixture.identity.clientId,
        jobId: randomUUID(),
        state: "failed",
      },
    },
  });
  fixture.report["status"] = "failed";
  fixture.report["cleanup"] = "deferred";
  (fixture.report as Record<string, unknown>)["cleanupHold"] = {
    requestId: failedRequestId,
    reason: "A local static check failed before SDK submission",
  };
  index["status"] = "failed";
  index["processIdentity"] = {
    pid: 2_147_483_647,
    birth: "dead-held-producer:0",
  };
  fs.writeFileSync(fixture.indexFile, JSON.stringify(index));
  fs.writeFileSync(fixture.reportFile, JSON.stringify(fixture.report));

  const proofs = discoverOwnedUnsavedFixtureProofs(fixture.root, backend);
  assert.equal(proofs.get(fixture.document.creationId)?.state, "unsettled");
  assert.equal(
    discoverOwnedUnsavedFixtures(fixture.root, backend).has(
      fixture.document.creationId,
    ),
    false,
  );
  assert.doesNotThrow(() =>
    assertReceiptBoundDocumentInventory(
      baseline,
      baseline,
      proofs,
      "held baseline changed",
    ),
  );
  assert.throws(
    () =>
      assertReceiptBoundDocumentInventory(
        baseline,
        [user, { ...held, modified: true }],
        proofs,
        "held baseline changed",
      ),
    /held baseline changed/u,
  );
  assert.throws(
    () =>
      assertReceiptBoundDocumentInventory(
        baseline,
        [user],
        proofs,
        "held baseline disappeared without settled cleanup proof",
      ),
    /held baseline disappeared without settled cleanup proof/u,
  );
  assert.throws(
    () =>
      assertReceiptBoundDocumentInventory(
        [user],
        [user, held],
        proofs,
        "unsettled non-baseline fixture is not admitted by default",
      ),
    /unsettled non-baseline fixture is not admitted by default/u,
  );
  assert.doesNotThrow(() =>
    assertReceiptBoundDocumentInventory(
      [user],
      [user, held],
      proofs,
      "visible creation-proven peer",
      true,
    ),
  );
  assert.doesNotThrow(() =>
    assertReceiptBoundDocumentInventory(
      [user],
      [user],
      proofs,
      "historical fixture was never observed by this run",
      true,
    ),
  );
  assert.throws(
    () =>
      assertReceiptBoundDocumentInventory(
        [user],
        [user],
        proofs,
        "visible peer disappeared without its exact close receipt",
        true,
        new Set([held.creationId]),
      ),
    /observed fixture disappeared without its exact close receipt/u,
  );
  assert.throws(
    () =>
      assertReceiptBoundDocumentInventory(
        [user],
        [user],
        new Map(),
        "observed peer lost its provenance",
        true,
        new Set([held.creationId]),
      ),
    /observed fixture disappeared without its exact close receipt/u,
  );
  assert.throws(
    () =>
      assertReceiptBoundDocumentInventory(
        [user],
        [user, held],
        new Map(),
        "unproven peer appeared",
        true,
      ),
    /unproven peer appeared/u,
  );
  assert.throws(
    () =>
      assertReceiptBoundDocumentInventory(
        baseline,
        [user, { ...held, modified: true }],
        proofs,
        "unsettled baseline fixture changed",
        true,
      ),
    /unsettled baseline fixture changed/u,
  );
});

test("live thread guard selects the exact owned identity, not a same-named document", () => {
  const owned = { creationId: "owned-id", name: "Thread fixture" };
  const inventory = [
    {
      creationId: "user-id",
      name: owned.name,
      saved: true,
      fileId: "user-file",
      active: false,
    },
    {
      ...owned,
      saved: false,
      fileId: null,
      active: true,
    },
  ];

  assert.doesNotThrow(() => assertOwnedUnsavedDocument(inventory, owned, true));
  assert.throws(
    () => assertOwnedUnsavedDocument([inventory[0]!], owned, true),
    /Exact fixture identity is missing or duplicated/u,
  );
});

test("post-create audit tolerates another process activating a document", () => {
  const owned = { creationId: "owned-id", name: "Thread fixture" };
  const inventory = [
    {
      ...owned,
      saved: false,
      fileId: null,
      active: false,
    },
  ];

  assert.doesNotThrow(() =>
    assertOwnedUnsavedDocument(inventory, owned, false),
  );
  assert.throws(
    () => assertOwnedUnsavedDocument(inventory, owned, true),
    /Fixture is not active/u,
  );
});

test("thread cleanup restores only the exact non-peer active baseline document", () => {
  const user = { creationId: "user-id", name: "User design" },
    peer = { creationId: "peer-id", name: "Peer fixture" },
    fixtures = new Map([[peer.creationId, peer]]);

  assert.deepEqual(
    originalActiveDocument(user.creationId, [user, peer], fixtures),
    user,
  );
  assert.equal(
    originalActiveDocument(peer.creationId, [user, peer], fixtures),
    undefined,
  );
  assert.throws(
    () => originalActiveDocument("missing-id", [user], fixtures),
    /Original active document is not part of the verified baseline/u,
  );
});
