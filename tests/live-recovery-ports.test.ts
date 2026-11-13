import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  knownSettlement,
  ownedCleanupSource,
  object,
  parse,
  owned,
  broker,
  result,
  nativeState,
} from "./live-recovery-ports";
import type { Result } from "./live-recovery-ports";

test("retained recovery parsers reject malformed JSON and preserve original identities", () => {
  for (const value of [null, [], "object", 4])
    assert.throws(() => object(value));
  assert.throws(() => parse("{"));
  assert.throws(() => parse("[]"));
  assert.deepEqual(
    owned({ name: "owned", creationId: "creation", previous: null }),
    { name: "owned", creationId: "creation", previous: null },
  );
  assert.deepEqual(
    owned({ name: "owned", creationId: "creation", previous: "original" }),
    { name: "owned", creationId: "creation", previous: "original" },
  );
  for (const invalid of [
    { name: 3, creationId: "id" },
    { name: "owned", creationId: null },
  ])
    assert.throws(() => owned(invalid));
  assert.deepEqual(
    broker({ buildHash: "build", admissionScope: "normal-multidocument" }),
    { buildHash: "build", admissionScope: "normal-multidocument" },
  );
  for (const invalid of [
    { buildHash: null, admissionScope: "normal" },
    { buildHash: "build", admissionScope: 3 },
  ])
    assert.throws(() => broker(invalid));
  const original = {
    job: {
      id: "job",
      requestId: "original",
      clientId: "owner",
      state: "failed",
    },
    stdout: "original stdout",
    execution: { sdkSettled: true, mayHaveMutated: false },
  };
  assert.equal(result(original), original);
  for (const field of ["id", "requestId", "clientId", "state"])
    assert.throws(() =>
      result({ ...original, job: { ...original.job, [field]: undefined } }),
    );
  assert.throws(() => result({ ...original, stdout: null }));
  assert.throws(() => result({ ...original, execution: [] }));
});

test("retained document inventory parser preserves active identity and rejects malformed rows", () => {
  const original = {
    active: "owned",
    documents: [{ id: "owned", name: "fixture", saved: false, modified: true }],
  };
  assert.equal(nativeState(original), original);
  assert.deepEqual(nativeState({ active: null, documents: [] }), {
    active: null,
    documents: [],
  });
  assert.throws(() => nativeState({ ...original, active: 4 }));
  assert.throws(() => nativeState({ ...original, documents: {} }));
  for (const [field, value] of [
    ["id", 3],
    ["name", null],
    ["saved", "false"],
    ["modified", 0],
  ] as const)
    assert.throws(() =>
      nativeState({
        ...original,
        documents: [{ ...original.documents[0], [field]: value }],
      }),
    );
});

test("cleanup evidence rejects missing, nonterminal and unsettled work", () => {
  const evidence = (state: string, sdkSettled: boolean): Result => ({
    job: { id: "original", requestId: "stable", clientId: "owner", state },
    stdout: "",
    execution: { sdkSettled },
  });
  assert.equal(knownSettlement([]), false);
  assert.equal(knownSettlement([undefined]), false);
  for (const state of ["preparing", "running", "needs_reconciliation"])
    assert.equal(knownSettlement([evidence(state, true)]), false);
  assert.equal(knownSettlement([evidence("succeeded", false)]), false);
  const unknownOriginal = {
    job: {
      id: "original",
      requestId: "stable",
      clientId: "owner",
      state: "needs_reconciliation",
    },
    stdout: "",
    stderr: "SDK outcome requires reconciliation",
  };
  assert.equal(knownSettlement([unknownOriginal]), false);
  assert.equal(
    knownSettlement([
      {
        ...unknownOriginal,
        job: { ...unknownOriginal.job, state: "succeeded" },
      },
    ]),
    false,
  );
  for (const malformed of [
    null,
    false,
    {},
    { job: null },
    { job: { state: "succeeded" }, execution: null },
  ])
    assert.equal(knownSettlement([malformed]), false);
  assert.equal(
    knownSettlement([evidence("failed", true), evidence("succeeded", true)]),
    true,
  );
});

test("owned cleanup Python is exact-ID/name/unsaved guarded and handles null restore without Python null", () => {
  for (const restore of [null, 'previous "quoted" document']) {
    const code = ownedCleanupSource(
      { name: "Owned", creationId: "own-new-id" },
      restore,
      "FMCAD_RESULT ",
    );
    const compiled = spawnSync(
      "python3",
      ["-c", "import ast,sys; ast.parse(sys.stdin.read()); print('COMPILED')"],
      { input: code, encoding: "utf8" },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    assert.match(code, /creationId=="own-new-id"/);
    assert.match(code, /d\.name=="Owned" and not d\.isSaved/);
    assert.match(code, /assert d\.close\(False\)/);
    assert.doesNotMatch(code, /==null|\.deleteMe\(|\.save\(/);
  }
});

test("owned close restores the original active document in its own SDK turn and receipt", () => {
  const code = ownedCleanupSource(
    { name: "Owned", creationId: "owned" },
    "original",
    "FMCAD_RESULT ",
  );
  const fake = `import json,types
class Doc:
    def __init__(self,id,name): self.creationId=id; self.name=name; self.isSaved=False
    def close(self,save):
        assert not save
        app.documents.remove(self)
        app.activeDocument=peer
        return True
    def activate(self):
        app.activeDocument=self
        return True
owned_doc=Doc('owned','Owned')
original=Doc('original','Original')
peer=Doc('peer','Peer')
app=types.SimpleNamespace(documents=[owned_doc,original,peer],activeDocument=owned_doc)
adsk=types.SimpleNamespace(core=types.SimpleNamespace(Application=types.SimpleNamespace(get=lambda:app)))
`;
  const result = spawnSync("python3", ["-c", fake + code], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout.trim().slice("FMCAD_RESULT ".length)),
    {
      closed: true,
      creationId: "owned",
      alreadyAbsent: false,
      active: "original",
    },
  );
});
