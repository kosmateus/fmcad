import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type {
  Inspection,
  Approval,
  Checked,
} from "../src/composition/queue-epoch-successor-types";
import type { RecoveryAuditPorts } from "../packages/node-adapters/src/execution/recovery-audit";
type Api = typeof import("../src/composition/queue-epoch-successor");
type ControlApi =
  typeof import("../src/composition/queue-epoch-successor-control");
const root = path.resolve(__dirname, "../..");
const runtimeRequire = createRequire(
  path.join(root, "src/queue-epoch-successor.js"),
);
const history = path.join(root, "tests/fixtures/history");
const manifest = JSON.parse(
  fs.readFileSync(path.join(history, "manifest.json"), "utf8"),
) as { sourcePath: string; file: string; sha256: string }[];
function loadModule<T>(
  name: string,
  legacy: boolean,
  overrides: Record<string, unknown>,
): T {
  const file = path.join(
    root,
    "src",
    legacy ? name + ".js" : "dist/composition/" + name + ".js",
  );
  const entry = manifest.find((e) => e.sourcePath === "src/" + name + ".js")!;
  const frozen = fs.readFileSync(path.join(history, entry.file), "utf8");
  assert.equal(createHash("sha256").update(frozen).digest("hex"), entry.sha256);
  const source = legacy ? frozen : fs.readFileSync(file, "utf8");
  const routed = (id: string): unknown =>
    id === "node:module"
      ? { createRequire: () => routed }
      : id in overrides
        ? overrides[id]
        : runtimeRequire(id);
  const module: { exports: unknown } = { exports: {} };
  const fn = vm.runInThisContext(
    "(function(exports,require,module,__filename,__dirname){\n" +
      source +
      "\n})",
    { filename: file },
  ) as (...args: unknown[]) => void;
  fn(module.exports, routed, module, file, path.dirname(file));
  return module.exports as T;
}
function approvalFixture(): { value: Inspection; approval: Approval } {
  const owner = { pid: 11, birth: "old", nonce: "n", protocol: 2 };
  const snapshot = {
    pointer: { path: "p", sha256: "p" },
    state: { path: "s", sha256: "s" },
    rootState: { path: "r", sha256: "r" },
    rootIdentity: { path: "i", sha256: "i" },
    identity: { path: "old", sha256: "old" },
    epochId: "epoch",
    grants: [],
    qualification: [],
  };
  const approval: Approval = {
    version: 1,
    purpose: "dead-isolated-epoch-successor-v1",
    requestId: "request",
    clientId: "owner",
    predecessorEpochId: "epoch",
    previousBuildHash: "old-build",
    pointerHash: "p",
    previousOwner: owner,
    stateHash: "s",
    rootStateHash: "r",
    rootIdentityHash: "i",
    candidateRoot: "runtime",
    buildHash: "new-build",
    sourceCommit: "a".repeat(40),
    expectedProcess: { pid: 22, birth: "new" },
    qualification: { path: "qualified", sha256: "hash" },
  };
  const value: Inspection = {
    root: "root",
    runtime: "runtime",
    audit: "audit",
    requestId: "request",
    approvalRef: { path: "approval", sha256: "h" },
    approval,
    clientId: "owner",
    ownerTokenHash: "token",
    registeredTokenHash: "token",
    pointer: {
      root: "epoch-root",
      epochId: "epoch",
      ownerClientId: "owner",
      ownerTokenHash: "token",
      historicalSnapshotHash: "r",
      historicalIdentityHash: "i",
      document: { fileId: null, creationId: "doc" },
      currentInstance: owner,
      originalInstance: owner,
      qualificationReceipt: { path: "q", sha256: "q" },
      qualificationEvidence: [],
      quarantinedJobIds: ["target", "observer"],
    },
    identity: { buildHash: "old-build", configHash: "cfg" },
    previousOwner: owner,
    snapshot,
    rootIdentity: { configHash: "cfg" },
    codeHash: "new-build",
    configHash: "cfg",
    qualification: {
      passed: true,
      productionAdmission: true,
      liveSdkRequestsSent: 0,
      sourceCommit: approval.sourceCommit,
      buildHash: approval.buildHash,
      publicDirectAccessRefused: true,
      deadEpochSuccessorReadQualified: true,
      deadEpochSuccessorRestoreQualified: true,
    },
    previousBrokerAlive: false,
    previousProcessAlive: false,
    originalProcessAlive: false,
    expectedProcessAlive: true,
    previousLifecycle: {
      owner,
      buildHash: "old-build",
      configHash: "cfg",
      stage: "ready",
    },
    pending: false,
  };
  return { value, approval };
}
for (const legacy of [true, false]) {
  test(`${legacy ? "historical" : "typed"} successor approval retains every admission fence`, () => {
    const api = loadModule<Api>("queue-epoch-successor", legacy, {});
    const fixture = approvalFixture();
    assert.doesNotThrow(() =>
      api.assertSuccessorApproval(fixture.value, fixture.approval),
    );
    const mutations: ((v: Inspection) => void)[] = [
      (v) => {
        v.clientId = "foreign";
      },
      (v) => {
        v.registeredTokenHash = "revoked";
      },
      (v) => {
        v.previousBrokerAlive = true;
      },
      (v) => {
        v.previousProcessAlive = null;
      },
      (v) => {
        v.originalProcessAlive = true;
      },
      (v) => {
        v.expectedProcessAlive = null;
      },
      (v) => {
        v.pending = true;
      },
      (v) => {
        v.snapshot.state.sha256 = "changed";
      },
      (v) => {
        v.previousLifecycle.stage = "starting";
      },
      (v) => {
        v.qualification.passed = false;
      },
      (v) => {
        v.qualification.liveSdkRequestsSent = 1;
      },
      (v) => {
        delete v.qualification.deadEpochSuccessorReadQualified;
      },
      (v) => {
        delete v.qualification.deadEpochSuccessorRestoreQualified;
      },
    ];
    for (const mutate of mutations) {
      const v = structuredClone(fixture.value);
      mutate(v);
      assert.throws(() => api.assertSuccessorApproval(v, fixture.approval));
    }
  });
  test(`${legacy ? "historical" : "typed"} successor current facts retain exact owner, request, receipt and cleanup fences`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-paired-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fixture = approvalFixture();
    const audit = path.join(dir, "audit");
    fs.mkdirSync(audit);
    const qualification = path.join(dir, "qualification");
    fs.mkdirSync(qualification);
    const identity = {
      commandId: "fmcad_atomic_" + "a".repeat(32),
      resolvedIdentity: { creationId: "doc" },
    };
    fs.writeFileSync(
      path.join(qualification, "intent.json"),
      JSON.stringify({ identity }),
    );
    const checked = {
      audit,
      pointer: {
        ...fixture.value.pointer,
        qualificationReceipt: {
          path: path.join(qualification, "result.json"),
          sha256: "q",
        },
      },
      authority: {
        clientId: "owner",
        ownerTokenHash: "token",
        requestId: "request",
        kind: "owner-authenticated-dead-epoch-successor",
        expectedProcess: { pid: 22, birth: "new" },
        sourceCommit: "a".repeat(40),
      },
    } as Checked;
    let ports: RecoveryAuditPorts | undefined;
    let fences = 0;
    let scratch:
      | {
          auditPorts: {
            inspect(message: {
              requestId: string;
              control: unknown;
            }): Promise<unknown>;
          };
        }
      | undefined;
    const api = loadModule<ControlApi>(
      "queue-epoch-successor-control",
      legacy,
      {
        "./queue-instance": {
          readJson: (f: string) => JSON.parse(fs.readFileSync(f, "utf8")),
          idle: () => true,
        },
        "./queue-epoch-lineage": {
          reference: () => assert.fail("no evidence publication authorized"),
          epochLineage: () => [],
        },
        "./queue-epoch-successor": {
          assertCurrentPredecessor: () => {
            fences++;
            return checked;
          },
        },
        "./queue-atomic-recovery-audit": {
          createRecoveryAudit: (p: RecoveryAuditPorts) => {
            ports = p;
            return { handle: () => assert.fail("no SDK request authorized") };
          },
        },
        "./queue-scratch-control": {
          createScratchControl: (p: typeof scratch) => {
            scratch = p;
            return {
              create: () => assert.fail("no scratch creation authorized"),
            };
          },
        },
      },
    );
    const controller = api.createSuccessorControl({
      dir,
      authority: { path: "authority", sha256: "h" },
      clients: () => ({ owner: "token" }),
      ports: {},
      fenceRuntime: () => {
        fences++;
      },
      assertControl: () => {
        fences++;
      },
    } as unknown as Parameters<ControlApi["createSuccessorControl"]>[0]);
    assert.equal(controller.metadata().currentFactsAvailable, false);
    assert.equal(controller.metadata().historicalOutcome, "unknown");
    assert.equal(controller.ownsCreation("request:create"), true);
    assert.equal(controller.ownsCreation("other:create"), false);
    assert.ok(ports);
    ports.assertOwner("target", "observer", "owner");
    assert.throws(() => ports!.assertOwner("target", "observer", "foreign"), {
      code: "NOT_OWNER",
    });
    assert.throws(() => ports!.assertOwner("other", "observer", "owner"), {
      code: "NOT_OWNER",
    });
    await assert.rejects(ports.inspect({ requestId: "other" }, "owner"), {
      code: "INVALID_REQUEST",
    });
    const observed = await ports.inspect(
      { requestId: "request:observe", control: {} },
      "owner",
    );
    assert.deepEqual(observed.instance, checked.authority.expectedProcess);
    assert.ok(fences >= 3);
    assert.ok(scratch);
    await assert.rejects(
      scratch.auditPorts.inspect({ requestId: "request:create", control: {} }),
      { code: "EPOCH_AUDIT_REQUIRED" },
    );
    const receipt = path.join(dir, "receipt.json");
    const binding = { jobId: "exact", sourceHash: "same-source" };
    const physical = {
      ...binding,
      terminal: true,
      outcome: "succeeded",
      instance: { pid: 22, birth: "new", version: "v1" },
    };
    fs.writeFileSync(receipt, JSON.stringify(physical));
    assert.equal(
      ports.remoteReceipt({ receipt, binding, instance: physical.instance })
        .outcome,
      "succeeded",
    );
    for (const change of [
      { terminal: false },
      { outcome: "unknown" },
      { sourceHash: "foreign" },
      { instance: { pid: 23, birth: "new", version: "v1" } },
      { instance: { pid: 22, birth: "new", version: "v2" } },
    ]) {
      fs.writeFileSync(receipt, JSON.stringify({ ...physical, ...change }));
      assert.throws(
        () =>
          ports!.remoteReceipt({
            receipt,
            binding,
            instance: physical.instance,
          }),
        { code: "EPOCH_SUCCESSOR_RECEIPT_MISMATCH" },
      );
    }
  });
}

for (const legacy of [true, false]) {
  test(`${legacy ? "historical" : "typed"} existing successor journal preserves pending no-replay and exact owner authority`, async (t) => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "successor-intent-paired-"),
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const digest = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    const requestId = "original-request";
    const audit = path.join(dir, "epoch-successions", digest(requestId));
    fs.mkdirSync(audit, { recursive: true });
    const approval = path.join(dir, "approval.json");
    fs.writeFileSync(approval, "{}");
    const ref = { path: approval, sha256: digest("{}") };
    fs.writeFileSync(
      path.join(dir, "clients.json"),
      JSON.stringify({ owner: digest("token") }),
    );
    const intent = {
      clientId: "owner",
      ownerTokenHash: digest("token"),
      approval: ref,
      nonce: "retained",
    };
    fs.writeFileSync(path.join(audit, "intent.json"), JSON.stringify(intent));
    const api = loadModule<Api>("queue-epoch-successor", legacy, {
      "node:child_process": {
        spawn: () => assert.fail("pending original must never spawn"),
      },
      "./queue-instance": {
        hash: digest,
        readJson: (file: string) => JSON.parse(fs.readFileSync(file, "utf8")),
      },
      "./queue-epoch-lineage": {
        reference: (file: string) => ({
          path: file,
          sha256: digest(fs.readFileSync(file, "utf8")),
        }),
      },
    });
    const client = { dir, auth: { clientId: "owner", clientToken: "token" } };
    const options = { approval, requestId, preflight: true };
    assert.deepEqual(await api.bootstrapSuccessor(client, {}, options), {
      state: "pending",
      requestId,
      noReplay: true,
      sdkRequestsSent: 0,
    });
    await assert.rejects(
      api.bootstrapSuccessor(
        { ...client, auth: { clientId: "owner", clientToken: "foreign" } },
        {},
        options,
      ),
      { code: "NOT_OWNER" },
    );
    fs.writeFileSync(approval, '{"changed":true}');
    await assert.rejects(api.bootstrapSuccessor(client, {}, options), {
      code: "NOT_OWNER",
    });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(audit, "intent.json"), "utf8")),
      intent,
    );
    assert.deepEqual(fs.readdirSync(audit), ["intent.json"]);
  });
}
