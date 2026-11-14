import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const load = createRequire(__filename);
const evidence = load(
  "../src/dist/node-adapters/execution/epoch-operator-evidence",
) as typeof import("../packages/node-adapters/src/execution/epoch-operator-evidence");
const reference = { path: "/private/evidence", sha256: "a".repeat(64) };
const document = { fileId: null, creationId: "owned" };
function approval() {
  return {
    version: 1,
    purpose: "quiescent-settled-isolated-epoch-upgrade-v1",
    epochId: "epoch",
    clientId: "owner",
    document,
    currentInstance: { pid: 3, birth: "boot:current" },
    previousBuildHash: "previous",
    pointerHash: "pointer",
    buildHash: "next",
    requestId: "handoff",
    candidateRoot: "/candidate",
    installRoot: "/installed",
    sourceCommit: "c".repeat(40),
    granteeClientId: "modeler",
    adapterSha256: "d".repeat(64),
    qualification: reference,
    previousQualifiedRuntime: "/previous",
    ledgerReferences: [reference],
    stateOptions: { idleMs: 60000, leaseMs: 600000 },
    originalExtra: { preserved: true },
  };
}
function snapshot() {
  return {
    state: {
      jobs: {
        job: { id: "job", state: "succeeded", details: { sdkSettled: true } },
      },
      paused: true,
      controlGeneration: 2,
      contextEpoch: 1,
    },
    pointer: {
      kind: "isolated-fresh-scratch-epoch",
      epochId: "epoch",
      ownerClientId: "owner",
      ownerTokenHash: "owner-hash",
      document,
      currentInstance: { pid: 3, birth: "boot:current" },
      originalInstance: { pid: 4, birth: "boot:old" },
      historicalSnapshotHash: "history",
      historicalIdentityHash: "identity",
      root: "/private/epoch",
      qualificationEvidence: [reference],
      qualificationReceipt: reference,
    },
    identity: {
      buildHash: "previous",
      instance: { pid: 3, birth: "boot:current" },
    },
    owner: { pid: 1, birth: "boot:broker", nonce: "owner-nonce" },
    control: {
      activeOperations: 0,
      activeIds: [],
      instanceId: "owner-nonce",
      buildHash: "previous",
      generation: 2,
      contextEpoch: 1,
      gateClosed: true,
    },
    ownerTokenHash: "owner-hash",
    pointerHash: "pointer",
    rootStateHash: "history",
    rootIdentityHash: "identity",
    grantsHash: "grants",
    evidenceHash: "evidence",
    selectedLive: true,
    historicalDead: true,
    brokerLive: true,
    originalExtra: { preserved: true },
  };
}
test("operator boundaries retain the exact approved records without manufacturing authority", () => {
  const a = approval(),
    s = snapshot();
  assert.equal(evidence.operatorApproval(a), a);
  assert.equal(evidence.operatorSnapshot(s), s);
  assert.equal(evidence.operatorPointer(s.pointer), s.pointer);
  assert.equal(evidence.operatorState(s.state), s.state);
  assert.equal(evidence.operatorStage("paused", s), s);
  assert.equal(evidence.operatorStage("initial", s), s);
  assert.deepEqual(
    evidence.operatorStage("identity", {
      previous: s.identity,
      current: s.identity,
    }),
    { previous: s.identity, current: s.identity },
  );
  assert.deepEqual(
    evidence.operatorIntent({
      version: 1,
      nonce: "intent",
      approval: a,
      ownerTokenHash: "token",
    }).approval,
    a,
  );
  assert.deepEqual(
    evidence.operatorEscrow({
      evidence: [reference],
      originalRootState: reference,
      originalRootIdentity: reference,
      previousQualifiedRuntime: "/previous",
    }).evidence,
    [reference],
  );
});
test("operator boundaries reject malformed records before they enter typed handoff ports", () => {
  for (const change of [
    (value: Record<string, unknown>) => {
      evidence.operatorObject(value["state"])["jobs"] = [];
    },
    (value: Record<string, unknown>) => {
      evidence.operatorObject(value["owner"])["pid"] = "1";
    },
    (value: Record<string, unknown>) => {
      evidence.operatorObject(value["control"])["activeIds"] = "none";
    },
    (value: Record<string, unknown>) => {
      evidence.operatorObject(value["pointer"])["qualificationReceipt"] = {
        path: 1,
        sha256: "hash",
      };
    },
    (value: Record<string, unknown>) => {
      value["selectedLive"] = null;
    },
  ]) {
    const value = structuredClone(snapshot());
    change(value);
    assert.throws(() => evidence.operatorStage("initial", value), {
      code: "EPOCH_UPGRADE_EVIDENCE_INVALID",
    });
  }
  const invalid = {
    ...approval(),
    stateOptions: { idleMs: "60000", leaseMs: 600000 },
  };
  assert.throws(() => evidence.operatorApproval(invalid), {
    code: "EPOCH_UPGRADE_EVIDENCE_INVALID",
  });
  assert.throws(() => evidence.operatorClients({ owner: 123 }));
  assert.throws(() => evidence.operatorGrant({ clientId: "owner" }));
  assert.throws(() =>
    evidence.operatorProcess({ pid: -1, birth: "boot:tick" }),
  );
  assert.throws(() =>
    evidence.operatorStage("identity", { previous: {}, current: {} }),
  );
});
