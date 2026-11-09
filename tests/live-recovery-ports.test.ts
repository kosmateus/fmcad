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
      { input: code, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    assert.match(code, /creationId=="own-new-id"/);
    assert.match(code, /d\.name=="Owned" and not d\.isSaved/);
    assert.match(code, /assert d\.close\(False\)/);
    assert.doesNotMatch(code, /==null|\.deleteMe\(|\.save\(/);
  }
});
