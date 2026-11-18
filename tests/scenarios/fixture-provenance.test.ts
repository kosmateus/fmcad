import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Document, ScenarioBackend } from "./contracts";
import { marker } from "./programs";
import {
  assertOwnedUnsavedDocument,
  assertPreservedDocumentInventory,
  currentProcessIdentity,
  discoverOwnedUnsavedFixtures,
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
    clientId = "client:" + randomUUID(),
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
