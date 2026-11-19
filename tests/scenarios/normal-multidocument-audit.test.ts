import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import {
  assertNormalFinalInventory,
  normalInventoryExpression,
} from "../live-normal-multidocument";
import type { OwnedUnsavedFixtureProof } from "./fixture-provenance";

const user = {
  id: "user",
  name: "User document",
  fileId: "persistent-user-file",
  saved: true,
  modified: false,
};
const peer = {
  id: "peer",
  name: "Exact owned peer",
  fileId: null,
  saved: false,
  modified: false,
};
const own = { creationId: "own", name: "Own normal document" };
function auditFixture() {
  const proofs = new Map<string, OwnedUnsavedFixtureProof>([
    [
      peer.id,
      {
        document: { creationId: peer.id, name: peer.name },
        state: "closed",
        supplementalClose: {
          requestId: "owner:1",
          clientId: "owner",
          jobId: "peer-close",
          startedAt: 200,
          finishedAt: 300,
          inventoryFence: {
            version: 1,
            before: [
              { ...peer, creationId: peer.id },
              { ...user, creationId: user.id },
            ],
            after: [{ ...user, creationId: user.id }],
          },
        },
      },
    ],
  ]);
  const close = {
    requestId: "normal:0:close",
    clientId: "normal-owner",
    result: {
      job: {
        id: "own-close",
        requestId: "normal:0:close",
        clientId: "normal-owner",
        state: "succeeded",
      },
      execution: { sdkSettled: true },
      stdout: 'FMCAD_RESULT {"creationId":"own","closed":true}',
    },
  };
  const before = { active: user.id, documents: [user, peer] },
    after = { active: user.id, documents: [user] };
  return {
    proofs,
    close,
    before,
    after,
    window: { baselineFinishedAt: 100, restoreStartedAt: 400 },
  };
}

test("normal final audit admits only a canonical peer close inside its observation window", () => {
  const f = auditFixture();
  assertNormalFinalInventory(
    f.before,
    f.after,
    [own],
    [f.close],
    f.proofs,
    f.window,
  );
});

test("normal final audit keeps unchanged inventory valid without any peer proofs", () => {
  const f = auditFixture();
  assertNormalFinalInventory(
    f.before,
    f.before,
    [own],
    [f.close],
    new Map(),
    f.window,
  );
});

test("normal audit admits authenticated current OPEN peers, including a changed baseline peer", () => {
  const f = auditFixture();
  const proofs = new Map<string, OwnedUnsavedFixtureProof>([
    [
      peer.id,
      { document: { creationId: peer.id, name: peer.name }, state: "open" },
    ],
    [
      "new-peer",
      {
        document: { creationId: "new-peer", name: "New canonical peer" },
        state: "open",
      },
    ],
  ]);
  const after = {
    active: user.id,
    documents: [
      user,
      { ...peer, modified: true },
      {
        id: "new-peer",
        name: "New canonical peer",
        saved: false,
        modified: true,
        fileId: null,
      },
    ],
  };
  assertNormalFinalInventory(
    f.before,
    after,
    [own],
    [f.close],
    proofs,
    f.window,
  );
});

test("normal OPEN-peer admission preserves user, active, identity and unsaved guards without unsettled exemptions", () => {
  for (const mutation of [
    "unsettled",
    "foreign-name",
    "saved",
    "file",
    "user",
    "active",
    "missing",
  ] as const) {
    const f = auditFixture();
    const proofs = new Map<string, OwnedUnsavedFixtureProof>([
      [
        peer.id,
        {
          document: { creationId: peer.id, name: peer.name },
          state: mutation === "unsettled" ? "unsettled" : "open",
        },
      ],
    ]);
    const after = {
      active: user.id,
      documents: [{ ...user }, { ...peer, modified: true }],
    };
    if (mutation === "foreign-name") after.documents[1]!.name = "Foreign";
    if (mutation === "saved") after.documents[1]!.saved = true;
    if (mutation === "file") after.documents[1]!.fileId = "unowned-file";
    if (mutation === "user") after.documents[0]!.modified = true;
    if (mutation === "active") after.active = peer.id;
    if (mutation === "missing") after.documents.pop();
    assert.throws(
      () =>
        assertNormalFinalInventory(
          f.before,
          after,
          [own],
          [f.close],
          proofs,
          f.window,
        ),
      mutation,
    );
  }
});

test("normal final audit accepts the actual cad-v1 close trailer without confusing it with a second closure", () => {
  const f = auditFixture();
  f.close.result.stdout +=
    '\nFMCAD_RESULT {"success":true,"helperCallsOnly":[]}\n';
  assertNormalFinalInventory(
    f.before,
    f.after,
    [own],
    [f.close],
    f.proofs,
    f.window,
  );
});

test("normal close rejects a duplicate closure, failed helper, nonempty helper calls or an unknown extra marker", () => {
  for (const trailer of [
    '{"creationId":"own","closed":true}',
    '{"success":false,"helperCallsOnly":[]}',
    '{"success":true,"helperCallsOnly":["foreign.operation"]}',
    '{"unrelated":true}',
  ]) {
    const f = auditFixture();
    f.close.result.stdout += "\nFMCAD_RESULT " + trailer;
    assert.throws(() =>
      assertNormalFinalInventory(
        f.before,
        f.after,
        [own],
        [f.close],
        f.proofs,
        f.window,
      ),
    );
  }
});

test("nongroup snapshots include file identity while group retains its original expression", () => {
  assert.equal(
    normalInventoryExpression(true),
    "sorted([dict(id=d.creationId,name=d.name,saved=d.isSaved,modified=d.isModified) for d in a.documents],key=lambda d:d['id'])",
  );
  assert.match(
    normalInventoryExpression(false),
    /fileId=d.dataFile.id if d.dataFile else None/u,
  );
});

test("missing, unsettled, foreign and timeless peer proofs never excuse disappearance", () => {
  for (const state of [
    "missing",
    "unsettled",
    "foreign",
    "timeless",
  ] as const) {
    const f = auditFixture(),
      proof = f.proofs.get(peer.id)!;
    if (state === "missing") f.proofs.clear();
    if (state === "unsettled")
      f.proofs.set(peer.id, { document: proof.document, state: "unsettled" });
    if (state === "foreign")
      f.proofs.set(peer.id, {
        ...proof,
        document: { creationId: "other", name: peer.name },
      });
    if (state === "timeless")
      f.proofs.set(peer.id, { document: proof.document, state: "closed" });
    assert.throws(
      () =>
        assertNormalFinalInventory(
          f.before,
          f.after,
          [own],
          [f.close],
          f.proofs,
          f.window,
        ),
      state,
    );
  }
});

test("stale, future and reused close jobs fail the final audit", () => {
  for (const changes of [
    { startedAt: 99 },
    { finishedAt: 401 },
    { jobId: "own-close" },
  ]) {
    const f = auditFixture(),
      proof = f.proofs.get(peer.id)!;
    assert.ok(proof.supplementalClose);
    f.proofs.set(peer.id, {
      ...proof,
      supplementalClose: { ...proof.supplementalClose, ...changes },
    });
    assert.throws(() =>
      assertNormalFinalInventory(
        f.before,
        f.after,
        [own],
        [f.close],
        f.proofs,
        f.window,
      ),
    );
  }
});

test("user disappearance and changes to modified, saved, name or file identity always fail", () => {
  for (const documents of [
    [],
    [{ ...user, modified: true }],
    [{ ...user, saved: false }],
    [{ ...user, name: "Renamed" }],
    [{ ...user, fileId: "another-file" }],
  ]) {
    const f = auditFixture();
    assert.throws(() =>
      assertNormalFinalInventory(
        f.before,
        { ...f.after, documents },
        [own],
        [f.close],
        f.proofs,
        f.window,
      ),
    );
  }
});

test("exact own cleanup rejects unknown, foreign, missing and reused receipts or a still-open own document", () => {
  const f = auditFixture();
  for (const close of [
    { ...f.close, result: undefined },
    { ...f.close, clientId: "foreign" },
    {
      ...f.close,
      result: { ...f.close.result, execution: { sdkSettled: false } },
    },
    {
      ...f.close,
      result: {
        ...f.close.result,
        job: { ...f.close.result.job, state: "unknown" },
      },
    },
    {
      ...f.close,
      result: {
        ...f.close.result,
        stdout: 'FMCAD_RESULT {"creationId":"peer","closed":true}',
      },
    },
  ])
    assert.throws(() =>
      assertNormalFinalInventory(
        f.before,
        f.after,
        [own],
        [close],
        f.proofs,
        f.window,
      ),
    );
  assert.throws(() =>
    assertNormalFinalInventory(
      f.before,
      f.after,
      [own],
      [],
      f.proofs,
      f.window,
    ),
  );
  assert.throws(() =>
    assertNormalFinalInventory(
      f.before,
      f.after,
      [own, { ...own, creationId: "own-two" }],
      [f.close, f.close],
      f.proofs,
      f.window,
    ),
  );
  assert.throws(() =>
    assertNormalFinalInventory(
      f.before,
      {
        ...f.after,
        documents: [
          ...f.after.documents,
          { ...user, id: own.creationId, name: own.name },
        ],
      },
      [own],
      [f.close],
      f.proofs,
      f.window,
    ),
  );
});

test("unexpected, duplicate or unpinned rows and active-document drift are not silently ignored", () => {
  const f = auditFixture();
  for (const after of [
    { ...f.after, active: "other" },
    { ...f.after, documents: [user, user] },
    { ...f.after, documents: [user, { ...user, id: "foreign" }] },
    {
      ...f.after,
      documents: [
        {
          id: user.id,
          name: user.name,
          saved: user.saved,
          modified: user.modified,
        },
      ],
    },
  ])
    assert.throws(() =>
      assertNormalFinalInventory(
        f.before,
        after,
        [own],
        [f.close],
        f.proofs,
        f.window,
      ),
    );
});

test("actual normal snapshot source passes pinned production admission with nullable file IDs", async () => {
  const root = path.resolve(__dirname, "../../.."),
    load = createRequire(path.join(root, "package.json"));
  const { createPythonChecker } = load(
    "./packages/node-adapters/dist/python/checker",
  ) as typeof import("../../packages/node-adapters/src/python/checker");
  const { preparePythonArtifact } = load(
    "./packages/node-adapters/dist/python/artifact",
  ) as typeof import("../../packages/node-adapters/src/python/artifact");
  const typingRoot = path.join(root, "dist/runtime/python/typing");
  const checker = createPythonChecker({
    typingRoot,
    definitionsRoot: typingRoot,
    pythonPlatform: "Windows",
  });
  for (const group of [false, true]) {
    const source = `import adsk.core, adsk.fusion, json, time
from typing import cast
DOC_NAME = None
def run(context: str):
    a=adsk.core.Application.get()
    print('FMCAD_RESULT '+json.dumps(dict(active=a.activeDocument.creationId if a.activeDocument else None,
        documents=${normalInventoryExpression(group)})))
run("")
`;
    const artifact = preparePythonArtifact([
      {
        id: group ? "group-baseline" : "normal-baseline",
        filename: "baseline.py",
        role: "user",
        source,
      },
    ]);
    const report = await checker.check({ artifact, context: { kind: "run" } });
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.deepEqual(report.diagnostics, []);
    assert.equal(report.provenance.checkerVersion, "1.40.2");
    assert.equal(
      report.provenance.definitionsHash,
      "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179",
    );
  }
});
