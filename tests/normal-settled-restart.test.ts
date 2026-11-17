import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
const load = createRequire(__filename);
const restart = load(
  "../src/dist/node-adapters/broker-ipc/normal-restart",
) as typeof import("../packages/node-adapters/src/broker-ipc/normal-restart");
const admission = load(
  "../src/dist/node-adapters/broker-ipc/normal-admission",
) as typeof import("../packages/node-adapters/src/broker-ipc/normal-admission");
const qi = load("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const object = (value: object) => value as Record<string, unknown>;

function fixture(t: { after(fn: () => void): void }, reusedPid = false) {
  const root = fs.mkdtempSync("/tmp/opencode/nr-guards-");
  t.after(() => fs.rmSync(root, { recursive: true }));
  const epoch = {
    root: path.join(root, "epoch"),
    currentInstance: { pid: 100, birth: "old-sdk", version: "test" },
    ownerClientId: "normal-owner-client",
  };
  fs.mkdirSync(epoch.root);
  const old = {
    configHash: "config",
    buildHash: "old-build",
    instance: epoch.currentInstance,
  };
  const owner = {
    pid: 200,
    birth: "old-owner",
    nonce: randomUUID(),
    protocol: 2,
  };
  const binding = {
    brokerNonce: owner.nonce,
    ownerPid: owner.pid,
    ownerBirth: owner.birth,
    buildHash: old.buildHash,
    stage: "startup",
  };
  const jobs = Object.fromEntries(
    Array.from({ length: 155 }, (_, index) => [
      "job-" + index,
      { id: "job-" + index, state: "succeeded", immutable: index },
    ]),
  );
  const state = {
    jobs,
    active: null as unknown,
    paused: false,
    controlGeneration: 0,
    controlRequests: {} as Record<string, unknown>,
  };
  const write = (file: string, value: unknown) =>
    fs.writeFileSync(file, JSON.stringify(value));
  const ref = (file: string) => ({
    path: file,
    sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
  });
  write(path.join(root, "isolated-admission-epoch.json"), epoch);
  write(path.join(epoch.root, "closed.json"), {
    admissionMode: "normal-multidocument",
  });
  const reclaimed = path.join(root, "reclaimed-" + randomUUID() + ".json");
  write(reclaimed, owner);
  write(path.join(root, "broker-reclaimed-head.json"), {
    ownerReference: ref(reclaimed),
  });
  const receipt = path.join(
    root,
    "broker-startup-" + owner.nonce + ".receipt.json",
  );
  write(receipt, {
    ...binding,
    terminal: true,
    outcome: "succeeded",
    instance: old.instance,
  });
  const lifecycle = path.join(
    root,
    "broker-lifecycle-" + owner.nonce + ".json",
  );
  write(lifecycle, {
    owner,
    buildHash: old.buildHash,
    configHash: old.configHash,
    stage: "ready",
    receipt,
    binding,
  });
  const current = {
    pid: reusedPid ? 100 : 300,
    birth: "new-sdk",
    version: "test",
    activeCommand: "SelectCommand",
    documents: [
      {
        id: "new-user-document",
        fileId: null,
        isSaved: false,
        isModified: false,
      },
    ],
  };
  const ports = {
    priorProcessAlive(value: object) {
      return object(value)["birth"] === "new-sdk";
    },
  };
  return {
    root,
    epoch,
    old,
    owner,
    binding,
    state,
    write,
    ref,
    reclaimed,
    lifecycle,
    receipt,
    current,
    ports,
  };
}

function ownerStoppedFixture(t: { after(fn: () => void): void }) {
  const f = fixture(t);
  const stopRequestId = "owner-stop-after-dead-sdk";
  const sourceIdentity = path.join(f.epoch.root, "instance.json");
  f.write(sourceIdentity, f.old);
  const currentEpoch = {
    ...f.epoch,
    ownerClientId: "normal-owner-client",
  };
  f.write(path.join(f.root, "isolated-admission-epoch.json"), currentEpoch);
  f.state.paused = true;
  f.state.controlGeneration = 8;
  f.state.controlRequests[stopRequestId] = { paused: true, generation: 8 };
  const digest = qi.hash(stopRequestId);
  const adminFile = path.join(f.root, `console-admin-${digest}.json`);
  const releaseFile = path.join(f.root, `console-release-${digest}.json`);
  f.write(adminFile, {
    action: "console-stop",
    clientId: currentEpoch.ownerClientId,
    requestId: stopRequestId,
    instanceId: f.owner.nonce,
    expectedGeneration: 7,
    buildHash: f.old.buildHash,
    status: "accepted",
    result: { releaseFile },
  });
  f.write(releaseFile, {
    terminal: true,
    outcome: "released",
    requestId: stopRequestId,
    instanceId: f.owner.nonce,
    buildHash: f.old.buildHash,
  });
  const ports = {
    priorProcessAlive(value: object) {
      return object(value)["birth"] === "new-sdk";
    },
  };
  return { ...f, stopRequestId, sourceIdentity, adminFile, releaseFile, ports };
}

test("runtime upgrade binds live SDK, dead owner and settled source without restart authority", (t) => {
  const f = ownerStoppedFixture(t);
  const ports = {
    priorProcessAlive: (value: object) => object(value)["birth"] === "old-sdk",
  };
  const proof = restart.inspectSettledRuntimeUpgrade(
    f.root,
    f.epoch,
    f.old,
    f.state,
    ports,
    f.stopRequestId,
    f.sourceIdentity,
  );
  assert.ok(proof?.runtimeUpgradeRecord);
  assert.equal(proof.deadPredecessorRecord, undefined);
  assert.doesNotThrow(() =>
    restart.assertSettledNormalRestartPredecessor(proof, f.state, ports),
  );
  assert.throws(
    () =>
      restart.assertSettledNormalRestartPredecessor(proof, f.state, {
        priorProcessAlive: () => false,
      }),
    /not dead|changed/,
  );
  assert.throws(
    () =>
      restart.assertSettledNormalRestartPredecessor(proof, f.state, {
        priorProcessAlive: () => true,
      }),
    /not dead|changed/,
  );
  f.state.controlGeneration++;
  assert.throws(() =>
    restart.assertSettledNormalRestartPredecessor(proof, f.state, ports),
  );
  f.state.controlGeneration--;
  f.state.active = { id: "pending" };
  assert.throws(() =>
    restart.assertSettledNormalRestartPredecessor(proof, f.state, ports),
  );
  f.state.active = null;
  f.write(f.sourceIdentity, { ...f.old, buildHash: "changed" });
  assert.throws(() =>
    restart.assertSettledNormalRestartPredecessor(proof, f.state, ports),
  );
  assert.equal(fs.existsSync(path.join(f.root, "normal-restarts")), false);
});

for (const mode of [
  "unknown",
  "worker-alive",
  "sdk-dead",
  "owner-alive",
  "receipt-changed",
] as const) {
  test(`runtime upgrade rejects ${mode}`, (t) => {
    const f = ownerStoppedFixture(t);
    if (mode === "unknown")
      Object.assign(f.state.jobs["job-0"]!, { state: "unknown" });
    if (mode === "worker-alive") {
      const directory = path.join(f.root, "jobs", "job-0");
      fs.mkdirSync(directory, { recursive: true });
      f.write(path.join(directory, "worker-identity.json"), {
        pid: 400,
        birth: "worker",
      });
    }
    if (mode === "receipt-changed")
      f.write(f.receipt, {
        ...f.binding,
        terminal: true,
        outcome: "succeeded",
        instance: { ...f.old.instance, birth: "foreign" },
      });
    const ports = {
      priorProcessAlive(value: object) {
        const birth = object(value)["birth"];
        return (
          (birth === "old-sdk" && mode !== "sdk-dead") ||
          (birth === "old-owner" && mode === "owner-alive") ||
          (birth === "worker" && mode === "worker-alive")
        );
      },
    };
    if (mode === "unknown")
      assert.equal(
        restart.inspectSettledRuntimeUpgrade(
          f.root,
          f.epoch,
          f.old,
          f.state,
          ports,
          f.stopRequestId,
          f.sourceIdentity,
        ),
        undefined,
      );
    else
      assert.throws(() =>
        restart.inspectSettledRuntimeUpgrade(
          f.root,
          f.epoch,
          f.old,
          f.state,
          ports,
          f.stopRequestId,
          f.sourceIdentity,
        ),
      );
  });
}

test("owner stop proof binds the dead SDK source and revalidates without writing normal-restart authority", (t) => {
  const f = ownerStoppedFixture(t);
  const proof = restart.inspectSettledNormalRestart(
    f.root,
    f.epoch,
    f.old,
    f.state,
    f.ports,
    f.stopRequestId,
    f.sourceIdentity,
  );
  assert.ok(proof?.deadPredecessorRecord);
  assert.equal(
    object(proof.deadPredecessorRecord)["kind"],
    "settled-normal-dead-predecessor-v1",
  );
  assert.doesNotThrow(() =>
    restart.assertSettledNormalRestartPredecessor(proof, f.state, f.ports),
  );
  assert.equal(fs.existsSync(path.join(f.root, "normal-restarts")), false);
});

test("owner stop proof is invalidated by a changed pause generation or source identity", (t) => {
  const f = ownerStoppedFixture(t);
  const proof = restart.inspectSettledNormalRestart(
    f.root,
    f.epoch,
    f.old,
    f.state,
    f.ports,
    f.stopRequestId,
    f.sourceIdentity,
  );
  assert.ok(proof);
  f.state.controlGeneration++;
  assert.throws(() =>
    restart.assertSettledNormalRestartPredecessor(proof, f.state, f.ports),
  );
  f.state.controlGeneration--;
  f.write(f.sourceIdentity, { ...f.old, buildHash: "different-source" });
  assert.throws(() =>
    restart.assertSettledNormalRestartPredecessor(proof, f.state, f.ports),
  );
});

for (const mode of [
  "sdk-alive",
  "pending",
  "unknown",
  "broker-alive",
  "wrong-stop",
  "retained-release",
]) {
  test("owner stop dead-SDK proof refuses unsafe predecessor: " + mode, (t) => {
    const f = ownerStoppedFixture(t);
    if (mode === "pending") f.state.jobs["job-0"]!.state = "queued";
    if (mode === "unknown")
      f.state.jobs["job-0"]!.state = "needs_reconciliation";
    if (mode === "retained-release")
      f.write(f.releaseFile, {
        terminal: true,
        outcome: "retained",
        requestId: f.stopRequestId,
        instanceId: f.owner.nonce,
        buildHash: f.old.buildHash,
      });
    const ports = {
      priorProcessAlive(value: object) {
        const birth = object(value)["birth"];
        return (
          (mode === "sdk-alive" && birth === "old-sdk") ||
          (mode === "broker-alive" && birth === "old-owner") ||
          birth === "new-sdk"
        );
      },
    };
    if (["sdk-alive", "pending", "unknown"].includes(mode)) {
      assert.equal(
        restart.inspectSettledNormalRestart(
          f.root,
          f.epoch,
          f.old,
          f.state,
          ports,
          f.stopRequestId,
          f.sourceIdentity,
        ),
        undefined,
      );
    } else {
      assert.throws(() =>
        restart.inspectSettledNormalRestart(
          f.root,
          f.epoch,
          f.old,
          f.state,
          ports,
          mode === "wrong-stop" ? "other-owner-stop" : f.stopRequestId,
          f.sourceIdentity,
        ),
      );
    }
    assert.equal(fs.existsSync(path.join(f.root, "normal-restarts")), false);
  });
}

test("bounded local restart rejection preserves the actual reclaimed SDK owner", (t) => {
  const f = fixture(t);
  f.write(path.join(f.root, "broker.lock"), f.owner);
  qi.reclaim(f.root);
  const before = fs.readFileSync(
    path.join(f.root, "broker-reclaimed-head.json"),
  );
  const local = {
    pid: 2147483647,
    birth: "dead:local-metadata",
    nonce: randomUUID(),
    protocol: 2,
  };
  f.write(path.join(f.root, "broker.lock"), local);
  f.write(path.join(f.root, `broker-lifecycle-${local.nonce}.json`), {
    owner: local,
    stage: "rejected",
    code: "NORMAL_RESTART_UNPROVEN",
    probeNotSubmitted: true,
    safeToRecover: true,
  });
  qi.reclaim(f.root);
  assert.deepEqual(
    fs.readFileSync(path.join(f.root, "broker-reclaimed-head.json")),
    before,
  );
  assert.ok(
    restart.inspectSettledNormalRestart(
      f.root,
      f.epoch,
      f.old,
      f.state,
      f.ports,
    ),
  );
});

for (const mode of ["different-pid", "reused-pid"]) {
  test(
    "settled normal restart records fresh evidence and preserves 155 jobs: " +
      mode,
    (t) => {
      const f = fixture(t, mode === "reused-pid");
      const jobsBefore = structuredClone(f.state.jobs);
      const pointerBefore = fs.readFileSync(
        path.join(f.root, "isolated-admission-epoch.json"),
      );
      const proof = restart.inspectSettledNormalRestart(
        f.root,
        f.epoch,
        f.old,
        f.state,
        f.ports,
      );
      assert.ok(proof);
      assert.equal(
        admission.epochStartupPinned(
          {
            epoch: f.epoch,
            admissionMode: "normal-multidocument",
            data: f.state,
            assertEpoch() {
              assert.fail("The dead SDK is not a live epoch");
            },
          },
          f.old.buildHash,
          f.old.buildHash,
          true,
        ),
        false,
      );
      const nonce = randomUUID();
      const binding = {
        brokerNonce: nonce,
        ownerPid: 400,
        ownerBirth: "new-owner",
        buildHash: "new-build",
        stage: "startup",
      };
      const receipt = path.join(
        f.root,
        "broker-startup-" + nonce + ".receipt.json",
      );
      f.write(receipt, {
        ...binding,
        terminal: true,
        outcome: "succeeded",
        instance: f.current,
        probeObservation: {
          schema: "fmcad-instance-probe-v1",
          identity: f.current,
        },
      });
      const result = restart.commitSettledNormalRestart(
        proof,
        f.state,
        f.current,
        binding,
        receipt,
        f.ports,
      );
      const identity = {
        configHash: f.old.configHash,
        buildHash: "new-build",
        instance: f.current,
        normalRestart: result,
      };
      assert.deepEqual(
        restart.normalRestartInstance(f.root, f.epoch, identity, f.state),
        f.current,
      );
      assert.deepEqual(f.state.jobs, jobsBefore);
      assert.deepEqual(
        fs.readFileSync(path.join(f.root, "isolated-admission-epoch.json")),
        pointerBefore,
      );
      const withNewJob: { jobs: Record<string, unknown>; active: string } = {
        jobs: { ...f.state.jobs, fresh: { state: "running" } },
        active: "fresh",
      };
      assert.deepEqual(
        restart.normalRestartInstance(f.root, f.epoch, identity, withNewJob),
        f.current,
        "New work does not rewrite or invalidate settled predecessor jobs",
      );
      withNewJob.jobs["job-0"] = { ...f.state.jobs["job-0"], immutable: -1 };
      assert.throws(
        () =>
          restart.normalRestartInstance(f.root, f.epoch, identity, withNewJob),
        /Historical normal jobs changed/,
      );
      fs.appendFileSync(result.path, " ");
      assert.throws(
        () => restart.normalRestartInstance(f.root, f.epoch, identity, f.state),
        /reference changed/,
      );
    },
  );
}

for (const mode of [
  "old-sdk-alive",
  "old-sdk-unknown",
  "pending",
  "unknown",
  "active",
  "worker-alive",
  "owner-alive",
  "wrong-owner",
  "wrong-source",
  "wrong-birth",
  "foreign-pointer",
  "forged-reference",
  "isolated-epoch",
]) {
  test("settled normal restart refuses unsafe admission: " + mode, (t) => {
    const f = fixture(t);
    if (mode === "pending") f.state.jobs["job-0"]!.state = "queued";
    if (mode === "unknown")
      f.state.jobs["job-0"]!.state = "needs_reconciliation";
    if (mode === "active") f.state.active = "job-0";
    if (mode === "worker-alive") {
      const dir = path.join(f.root, "jobs", "job-0");
      fs.mkdirSync(dir, { recursive: true });
      f.write(path.join(dir, "worker-identity.json"), {
        pid: 500,
        birth: "worker",
      });
    }
    const life = JSON.parse(fs.readFileSync(f.lifecycle, "utf8")) as Record<
      string,
      unknown
    >;
    if (mode === "wrong-owner")
      life["owner"] = { ...f.owner, nonce: randomUUID() };
    if (mode === "wrong-source") life["buildHash"] = "foreign";
    if (mode === "wrong-birth")
      life["binding"] = { ...f.binding, ownerBirth: "foreign" };
    f.write(f.lifecycle, life);
    if (mode === "foreign-pointer")
      f.write(path.join(f.root, "isolated-admission-epoch.json"), {
        ...f.epoch,
        currentInstance: { ...f.epoch.currentInstance, birth: "foreign" },
      });
    if (mode === "forged-reference") fs.appendFileSync(f.reclaimed, " ");
    if (mode === "isolated-epoch")
      f.write(path.join(f.epoch.root, "closed.json"), {});
    const ports = {
      priorProcessAlive(value: object) {
        const birth = object(value)["birth"];
        if (mode === "old-sdk-unknown" && birth === "old-sdk") return null;
        return (
          (mode === "old-sdk-alive" && birth === "old-sdk") ||
          (mode === "owner-alive" && birth === "old-owner") ||
          (mode === "worker-alive" && birth === "worker")
        );
      },
    };
    const before = structuredClone(f.state.jobs);
    if (["old-sdk-alive", "pending", "unknown", "active"].includes(mode))
      assert.equal(
        restart.inspectSettledNormalRestart(
          f.root,
          f.epoch,
          f.old,
          f.state,
          ports,
        ),
        undefined,
      );
    else
      assert.throws(() =>
        restart.inspectSettledNormalRestart(
          f.root,
          f.epoch,
          f.old,
          f.state,
          ports,
        ),
      );
    assert.deepEqual(f.state.jobs, before);
    assert.equal(fs.existsSync(path.join(f.root, "normal-restarts")), false);
  });
}

for (const mode of [
  "old-sdk-returned",
  "new-sdk-wrong-birth",
  "new-sdk-busy",
  "modified-user-doc",
  "partial-inventory",
  "nonterminal",
  "failed",
  "wrong-binding",
  "wire-receipt-conflict",
  "foreign-observation-schema",
]) {
  test("settled normal restart refuses changed observation: " + mode, (t) => {
    const f = fixture(t);
    const proof = restart.inspectSettledNormalRestart(
      f.root,
      f.epoch,
      f.old,
      f.state,
      f.ports,
    );
    assert.ok(proof);
    const binding = {
      brokerNonce: randomUUID(),
      ownerPid: 400,
      ownerBirth: "new-owner",
      buildHash: "new-build",
      stage: "startup",
    };
    const receiptFile = path.join(
      f.root,
      "broker-startup-" + binding.brokerNonce + ".receipt.json",
    );
    if (mode === "new-sdk-busy") f.current.activeCommand = "SketchCommand";
    if (mode === "modified-user-doc") f.current.documents[0]!.isModified = true;
    const current: object =
      mode === "partial-inventory"
        ? { ...f.current, documents: undefined }
        : f.current;
    const receipt = {
      ...binding,
      terminal: mode !== "nonterminal",
      outcome: mode === "failed" ? "failed" : "succeeded",
      instance: current,
      probeObservation: {
        schema: "fmcad-instance-probe-v1",
        identity: current,
      },
    };
    if (mode === "wrong-binding") receipt.stage = "foreign";
    if (mode === "foreign-observation-schema")
      receipt.probeObservation.schema = "foreign";
    if (mode === "wire-receipt-conflict")
      receipt.instance = { ...f.current, birth: "foreign" };
    f.write(receiptFile, receipt);
    const ports = {
      priorProcessAlive(value: object) {
        const birth = object(value)["birth"];
        if (mode === "old-sdk-returned" && birth === "old-sdk") return true;
        return birth === "new-sdk" && mode !== "new-sdk-wrong-birth";
      },
    };
    assert.throws(() =>
      restart.commitSettledNormalRestart(
        proof,
        f.state,
        current,
        binding,
        receiptFile,
        ports,
      ),
    );
    assert.equal(fs.existsSync(path.join(f.root, "normal-restarts")), false);
  });
}
