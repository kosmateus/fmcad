import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type * as Adapter from "../src/document-unlock-admission";
import type * as Epoch from "../src/queue-isolated-epoch";
import syntheticClosedScratch from "./fixtures/closed-scratch-artifacts.cjs";
import type { DeadEpochFixture } from "./fixtures/epoch-fixture-types";

const repo = process.cwd();
const load = createRequire(
  path.join(repo, "tests/document-unlock-admission.js"),
);
const { createDocumentUnlockAdmission } = load(
  "../src/document-unlock-admission",
) as typeof Adapter;
const { openIsolatedEpoch } = load(
  "../src/queue-isolated-epoch",
) as typeof Epoch;
const api = load("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
type State = ReturnType<typeof openIsolatedEpoch>;
type Pointer = NonNullable<State["epoch"]>;
interface FixtureInput {
  dir: string;
  pointer: Pointer;
  clientId: string;
  identity?: Parameters<State["installEpoch"]>[1];
  initialization?: Parameters<State["installEpoch"]>[2];
}

function fixture(t: TestContext, fresh = false) {
  const base = fs.mkdtempSync("/tmp/opencode/document-unlock-admission-");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const f: FixtureInput = fresh
    ? (
        load("./fixtures/dead-epoch-successor.cjs") as (
          base: string,
          repo: string,
        ) => DeadEpochFixture
      )(base, repo)
    : (
        load("./fixtures/current-epoch-upgrade.cjs") as (
          base: string,
          repo: string,
        ) => { dir: string; pointer: Pointer; clientId: string }
      )(base, repo);
  if (!fresh) {
    f.pointer.restoreActiveCreationId = null;
    api.durable(path.join(f.dir, "isolated-admission-epoch.json"), f.pointer);
  }
  const state = openIsolatedEpoch(f.dir, { recover: false });
  if (f.initialization && f.identity)
    state.installEpoch(f.pointer, f.identity, f.initialization);
  const clients: Record<string, string> = {
    [f.clientId]: f.pointer.ownerTokenHash,
    newActor: api.hash("independent-actor-token"),
    peer: api.hash("peer-token"),
  };
  let generation = "current-physical-generation";
  let scope: Adapter.UnlockAdmissionContext["scope"] = "ordinary";
  const admission = createDocumentUnlockAdmission(() => ({
    state,
    clients,
    generation,
    scope,
  }));
  const observed = {
    complete: true as const,
    name: f.pointer.document.name,
    creationId: f.pointer.document.creationId,
    fileId: null,
    fingerprint: "current-native-probe-fingerprint",
  };
  function confirm(target = observed) {
    return admission.confirmTarget({ docId: target.creationId }, target);
  }
  function principal(clientId = "newActor") {
    return { clientId, clientTokenHash: clients[clientId]! };
  }
  function grant(clientId = "newActor", document = f.pointer.document) {
    const file = path.join(
      f.pointer.root,
      "access-" + api.hash(clientId + "\0" + clients[clientId]) + ".json",
    );
    api.durable(file, {
      epochId: f.pointer.epochId,
      clientId,
      clientTokenHash: clients[clientId],
      document,
    });
    return file;
  }
  function normal() {
    syntheticClosedScratch(f.dir, f.pointer, repo, "normal-multidocument");
  }
  return {
    ...f,
    state,
    clients,
    admission,
    observed,
    confirm,
    principal,
    grant,
    normal,
    setGeneration: (value: string) => {
      generation = value;
    },
    setScope: (value: typeof scope) => {
      scope = value;
    },
  };
}

test("new actor uses its own current grant, not historical author credentials", (t) => {
  const f = fixture(t);
  const history = fs.readFileSync(path.join(f.dir, "queue-state.json"));
  const epochBefore = JSON.stringify(f.state.data);
  f.grant();
  // The historical author's credential is neither available nor required.
  delete f.clients[f.clientId];
  for (const action of ["status", "inspect", "accept"] as const) {
    const admitted = f.admission.authorize(f.principal(), action, f.confirm());
    admitted.recheck();
    assert.equal(admitted.target.creationId, f.pointer.document.creationId);
    const publicResult = JSON.stringify(admitted);
    assert.ok(!publicResult.includes(f.pointer.ownerTokenHash));
    assert.ok(!publicResult.includes(f.clients["newActor"]!));
    for (const id of f.pointer.quarantinedJobIds)
      assert.ok(!publicResult.includes(id));
  }
  assert.deepEqual(
    fs.readFileSync(path.join(f.dir, "queue-state.json")),
    history,
  );
  assert.equal(JSON.stringify(f.state.data), epochBefore);
});

test("registration is not an isolated document grant", (t) => {
  const f = fixture(t);
  for (const action of ["status", "inspect", "accept"] as const)
    assert.throws(
      () => f.admission.authorize(f.principal(), action, f.confirm()),
      {
        code: "EPOCH_CLIENT_NOT_GRANTED",
      },
    );
});

test("the original owner also needs its current unrotated credential", (t) => {
  const f = fixture(t);
  const owner = f.principal(f.clientId);
  const admitted = f.admission.authorize(owner, "accept", f.confirm());
  f.clients[f.clientId] = api.hash("owner-credential-rotated");
  assert.throws(admitted.recheck, {
    code: "DOCUMENT_UNLOCK_NOT_AUTHENTICATED",
  });
  assert.throws(
    () => f.admission.authorize(f.principal(f.clientId), "accept", f.confirm()),
    { code: "EPOCH_CLIENT_NOT_GRANTED" },
  );
});

test("grant for B and a valid current probe of B never authorize A or another document", (t) => {
  const f = fixture(t);
  f.grant("newActor", { ...f.pointer.document, creationId: "B" });
  assert.throws(
    () => f.admission.authorize(f.principal(), "accept", f.confirm()),
    {
      code: "EPOCH_CLIENT_NOT_GRANTED",
    },
  );
  f.grant();
  const b = f.confirm({ ...f.observed, creationId: "B" });
  assert.throws(() => f.admission.authorize(f.principal(), "accept", b), {
    code: "EPOCH_SCOPE_REQUIRED",
  });
});

test("revocation and credential rotation are checked again at use-time", (t) => {
  const f = fixture(t);
  const file = f.grant();
  const admitted = f.admission.authorize(f.principal(), "accept", f.confirm());
  fs.unlinkSync(file);
  assert.throws(admitted.recheck, { code: "EPOCH_CLIENT_NOT_GRANTED" });
  f.grant();
  admitted.recheck();
  f.clients["newActor"] = api.hash("rotated-token");
  assert.throws(admitted.recheck, {
    code: "DOCUMENT_UNLOCK_NOT_AUTHENTICATED",
  });
});

test("current physical generation and epoch control changes invalidate admission", (t) => {
  const f = fixture(t);
  f.grant();
  const admitted = f.admission.authorize(f.principal(), "inspect", f.confirm());
  f.setGeneration("replacement-generation");
  assert.throws(admitted.recheck, { code: "DOCUMENT_UNLOCK_STALE" });
  f.setGeneration("current-physical-generation");
  admitted.recheck();
  f.state.pause(false, "control-change");
  assert.throws(admitted.recheck, { code: "DOCUMENT_UNLOCK_STALE" });
});

test("replacing the actual epoch cannot retain an old target proof", (t) => {
  const a = fixture(t);
  const b = fixture(t);
  a.grant();
  b.grant();
  let state = a.state;
  const admission = createDocumentUnlockAdmission(() => ({
    state,
    clients: a.clients,
    generation: "same-process",
    scope: "ordinary",
  }));
  const proof = admission.confirmTarget(
    { docId: a.observed.creationId },
    a.observed,
  );
  const admitted = admission.authorize(a.principal(), "accept", proof);
  state = b.state;
  assert.throws(admitted.recheck, { code: "DOCUMENT_UNLOCK_STALE" });
});

test("both target pins must agree with a complete probe; name alone is never identity", (t) => {
  const f = fixture(t);
  const saved = { ...f.observed, fileId: "file-A", version: 3 };
  const exact = f.admission.confirmTarget(
    { docId: saved.creationId, docFileId: "file-A" },
    saved,
  );
  assert.equal(exact.fileId, "file-A");
  for (const selector of [
    {},
    { docId: "B" },
    { docId: saved.creationId, docFileId: "file-B" },
    { docId: "", docFileId: "file-A" },
    { doc: saved.name },
  ])
    assert.throws(() => f.admission.confirmTarget(selector, saved), {
      code: "DOCUMENT_UNLOCK_TARGET_UNPROVEN",
    });
  assert.throws(
    () =>
      f.admission.confirmTarget(
        { docId: saved.creationId },
        JSON.parse(JSON.stringify({ ...saved, complete: false })),
      ),
    { code: "DOCUMENT_UNLOCK_TARGET_UNPROVEN" },
  );
});

test("caller JSON cannot forge proof, actor credentials, or admission source", (t) => {
  const f = fixture(t);
  f.grant();
  const proof = f.confirm();
  assert.throws(
    () =>
      f.admission.authorize(
        f.principal(),
        "accept",
        JSON.parse(JSON.stringify(proof)),
      ),
    { code: "DOCUMENT_UNLOCK_TARGET_UNPROVEN" },
  );
  assert.throws(
    () =>
      f.admission.authorize(
        { clientId: "newActor", clientTokenHash: f.pointer.ownerTokenHash },
        "accept",
        proof,
      ),
    { code: "DOCUMENT_UNLOCK_NOT_AUTHENTICATED" },
  );
  // Caller-supplied operation, argv and readOnly cannot become the fixed policy request.
  assert.throws(
    () =>
      f.admission.authorize(
        f.principal(),
        JSON.parse('"document.status"'),
        proof,
      ),
    { code: "INVALID_REQUEST" },
  );
});

test("normal multidocument keeps ordinary policy without per-document approval", (t) => {
  const f = fixture(t);
  f.normal();
  for (const creationId of ["A", "B"]) {
    const proof = f.confirm({ ...f.observed, creationId });
    const admitted = f.admission.authorize(f.principal(), "accept", proof);
    admitted.recheck();
    assert.equal(admitted.target.creationId, creationId);
  }
});

test("ordinary queue without a recovery epoch needs no added per-document grant", (t) => {
  const directory = fs.mkdtempSync("/tmp/opencode/document-unlock-normal-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = openIsolatedEpoch(directory, { recover: false });
  const principal = {
    clientId: "fresh-actor",
    clientTokenHash: api.hash("fresh"),
  };
  const admission = createDocumentUnlockAdmission(() => ({
    state,
    clients: { [principal.clientId]: principal.clientTokenHash },
    generation: "ordinary-current-generation",
    scope: "ordinary",
  }));
  const target = admission.confirmTarget(
    { docId: "A", docFileId: "file-A" },
    {
      complete: true,
      name: "Actual document A",
      creationId: "A",
      fileId: "file-A",
      fingerprint: "current-state-A",
    },
  );
  admission.authorize(principal, "inspect", target).recheck();
  admission.authorize(principal, "accept", target).recheck();
});

test("scoped frozen metadata runtime cannot inspect or accept and is rechecked", (t) => {
  const f = fixture(t);
  f.normal();
  const admitted = f.admission.authorize(f.principal(), "accept", f.confirm());
  f.setScope("frozen-metadata");
  assert.throws(admitted.recheck, { code: "DOCUMENT_UNLOCK_FROZEN_SCOPE" });
  for (const action of ["status", "inspect", "accept"] as const)
    assert.throws(
      () => f.admission.authorize(f.principal(), action, f.confirm()),
      {
        code: "DOCUMENT_UNLOCK_FROZEN_SCOPE",
      },
    );
});

test("bounded native read capability is not a general modeling capability", (t) => {
  const f = fixture(t, true);
  const { grantNativeFixture } = load(
    "../src/queue-native-fixture-grant",
  ) as typeof import("../src/queue-native-fixture-grant");
  grantNativeFixture(
    {
      dir: f.dir,
      state: f.state,
      buildHash: api.buildHash(),
      clients: () => f.clients,
      assertControl() {},
      fence() {},
    },
    {
      action: "grant-native-fixture",
      epochId: f.pointer.epochId,
      grantClientId: "newActor",
      fixtureId: "regional-geometry-v1",
      requestId: "grant-read-capable-fixture",
    },
    f.clientId,
  );
  f.admission.authorize(f.principal(), "inspect", f.confirm()).recheck();
  assert.throws(
    () => f.admission.authorize(f.principal(), "accept", f.confirm()),
    {
      code: "EPOCH_SCOPE_REQUIRED",
    },
  );
});

test("source-pinned fixed-run-only grant cannot become document unlocking", (t) => {
  const f = fixture(t, true);
  const { grantNativeFixture } = load(
    "../src/queue-native-fixture-grant",
  ) as typeof import("../src/queue-native-fixture-grant");
  grantNativeFixture(
    {
      dir: f.dir,
      state: f.state,
      buildHash: api.buildHash(),
      clients: () => f.clients,
      assertControl() {},
      fence() {},
    },
    {
      action: "grant-native-fixture",
      epochId: f.pointer.epochId,
      grantClientId: "newActor",
      fixtureId: "containment-program-v1",
      requestId: "grant-fixed-fixture",
    },
    f.clientId,
  );
  for (const action of ["inspect", "accept"] as const)
    assert.throws(
      () => f.admission.authorize(f.principal(), action, f.confirm()),
      {
        code: "NATIVE_FIXTURE_SCOPE_REQUIRED",
      },
    );
});
