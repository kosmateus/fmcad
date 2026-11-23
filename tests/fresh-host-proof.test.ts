import assert from "node:assert/strict";
import test from "node:test";
import {
  createFreshHostProofFactory,
  type FreshHostContext,
} from "../src/fresh-host-proof";
import type {
  NativeRuntimeActivationCompletion,
  NativeRuntimeActivationPublication,
} from "../packages/node-adapters/src/execution/runtime-rebaseline-native";
import type { FreshHostProofPorts } from "../src/fresh-host-proof";

function fixture() {
  const current: FreshHostContext = {
    descriptor: {
      kind: "fmcad-physical-grant",
      version: 1,
      handoffId: "handoff",
      generation: { epoch: "epoch", instance: "instance" },
      brokerOwner: {
        pid: 1,
        birth: "broker-birth",
        nonce: "nonce",
        clientId: "client",
        queueDirectory: "/queue",
      },
      endpointURL: "http://localhost:8765",
      physicalRuntime: {
        pid: 2,
        birth: "fusion-birth",
        version: "version",
        source: "source",
        build: "build",
      },
    },
    brokerBuild: "broker-build",
    brokerConfig: "config",
    requestId: "request",
    purpose: "isolated-stdout-v1",
    engineVersion: 2,
    kernelDigest: "kernel",
    programDigest: "program",
    wireDigest: "wire",
  };
  const publication: NativeRuntimeActivationPublication = {
    store: "/store",
    storeDevice: 1,
    storeInode: 2,
    expectedHead: "head",
    expectedFiles: {},
    activationFile: "/activation",
    activationBytes: "original",
    record: { path: "/record", sha256: "record-sha" },
  };
  const completion: NativeRuntimeActivationCompletion = {
    binding: {
      requestId: "original-request",
      newHead: "new-head",
      publicationDigest: "publication",
      initiatorOperatorId: "operator",
    },
    evidence: [],
    nativeReceipt: {
      kind: "native-runtime-rebaseline-consume-v1",
      reference: { path: "/receipt", sha256: "receipt-sha" },
    },
  };
  let calls = 0;
  let held = true;
  let active = true;
  let nativeError: Error | undefined;
  let duringVerify = () => {};
  let duringActivation = () => {};
  const ports: FreshHostProofPorts = {
    assertBootstrapHeld() {
      assert.ok(held, "BOOTSTRAP_LEASE_REVOKED");
    },
    readCurrent: () => structuredClone(current),
    reader: {
      store: "/store",
      pins: {
        handoffId: "handoff",
        admissionStore: "/store",
        generation: structuredClone(current.descriptor.generation),
        process: { pid: 2, birth: "fusion-birth" },
        source: "source",
        build: "build",
        endpoint: current.descriptor.endpointURL,
      },
      invalidate() {
        active = false;
      },
      async verifyConsumed(p, c) {
        calls++;
        assert.equal(p.activationBytes, "original");
        assert.equal(c.nativeReceipt.reference.path, "/receipt");
        if (nativeError) throw nativeError;
        duringVerify();
        return {
          authenticatedCurrentPins: structuredClone(ports.reader.pins),
          finalize() {},
          abort() {},
        };
      },
      async getVerifiedActivation() {
        duringActivation();
        return active
          ? {
              requestId: "original-request",
              fenceNonce: "fence",
              newHead: "new-head",
              publicationDigest: "publication",
              receiptDigest: "receipt",
            }
          : undefined;
      },
    },
  };
  const factory = createFreshHostProofFactory(
    ports,
    current,
    publication,
    completion,
  );
  return {
    factory,
    ports,
    current,
    publication,
    completion,
    calls: () => calls,
    loseLease: () => (held = false),
    loseGrant: () => (active = false),
    failNative: (error: Error) => (nativeError = error),
    duringVerify: (run: () => void) => (duringVerify = run),
    duringActivation: (run: () => void) => (duringActivation = run),
  };
}

test("authenticated native evidence remains NOT_AUTHORITY; every use rechecks", async () => {
  const f = fixture();
  const assessment = await f.factory.assess();
  assert.equal(assessment.status, "NOT_AUTHORITY");
  assert.ok(Object.isFrozen(assessment));
  assert.deepEqual(assessment.missing, [
    "SUPPORTED_BOOTSTRAP_PURPOSE_PRODUCER",
    "AUTHENTICATED_BOOTSTRAP_CLOSURE",
  ]);
  for (let i = 0; i < 2; i++)
    await assert.rejects(f.factory.requireForDispatch(assessment), {
      code: "BOOTSTRAP_CLOSURE_UNPROVEN",
      notStarted: true,
    });
  assert.equal(f.calls(), 3);
});

test("JSON copies and assessments from another factory cannot be used", async () => {
  const f = fixture();
  const assessment = await f.factory.assess();
  for (const copy of [
    structuredClone(assessment),
    await fixture().factory.assess(),
  ])
    await assert.rejects(f.factory.requireForDispatch(copy), {
      code: "FRESH_HOST_ASSESSMENT_REJECTED",
    });
  assert.equal(f.calls(), 1);
});

test("native verification failure propagates without granting an assessment", async () => {
  const f = fixture();
  const wrongMac = new Error("RUNTIME_CONSUME_MAC_INVALID");
  f.failNative(wrongMac);
  await assert.rejects(f.factory.assess(), (e) => e === wrongMac);
});

test("original publication and receipt inputs are detached from caller mutations", async () => {
  const f = fixture();
  f.publication.activationBytes = "forged";
  f.completion.nativeReceipt.reference.path = "/forged";
  assert.equal((await f.factory.assess()).status, "NOT_AUTHORITY");
});

test("lost current native grant denies assessment and dispatch recheck", async () => {
  const f = fixture();
  const assessment = await f.factory.assess();
  f.loseGrant();
  await assert.rejects(f.factory.requireForDispatch(assessment), {
    code: "FRESH_HOST_NATIVE_ACTIVATION_UNPROVEN",
  });
});

test("explicit revocation invalidates prior assessments permanently", async () => {
  const f = fixture();
  const assessment = await f.factory.assess();
  f.factory.revoke();
  await assert.rejects(f.factory.assess(), { code: "FRESH_HOST_REVOKED" });
  await assert.rejects(f.factory.requireForDispatch(assessment), {
    code: "FRESH_HOST_REVOKED",
  });
});

const mutations: Array<[string, (c: FreshHostContext) => void]> = [
  ["Fusion birth", (c) => (c.descriptor.physicalRuntime.birth += "-changed")],
  ["grant generation", (c) => (c.descriptor.generation.epoch += "-changed")],
  ["broker principal", (c) => (c.descriptor.brokerOwner.nonce += "-changed")],
  ["broker build", (c) => (c.brokerBuild += "-changed")],
  ["config", (c) => (c.brokerConfig += "-changed")],
  ["request", (c) => (c.requestId += "-changed")],
  ["kernel", (c) => (c.kernelDigest += "-changed")],
  ["program", (c) => (c.programDigest += "-changed")],
  ["wire", (c) => (c.wireDigest += "-changed")],
];
for (const [label, mutate] of mutations)
  test(`${label} is rechecked, including across awaits`, async () => {
    for (const phase of ["before", "verify", "activation"]) {
      const f = fixture();
      const assessment = await f.factory.assess();
      if (phase === "before") mutate(f.current);
      if (phase === "verify") f.duringVerify(() => mutate(f.current));
      if (phase === "activation") f.duringActivation(() => mutate(f.current));
      await assert.rejects(f.factory.requireForDispatch(assessment), {
        code: "FRESH_HOST_CONTEXT_CHANGED",
      });
    }
  });

test("bootstrap lease loss across native awaits is fail-closed", async () => {
  for (const phase of ["before", "verify", "activation"]) {
    const f = fixture();
    if (phase === "before") f.loseLease();
    if (phase === "verify") f.duringVerify(f.loseLease);
    if (phase === "activation") f.duringActivation(f.loseLease);
    await assert.rejects(f.factory.assess(), /BOOTSTRAP_LEASE_REVOKED/);
  }
});

test("native current pins cannot be substituted even with a held lease", async () => {
  const f = fixture();
  f.ports.reader.pins.process.birth = "stale";
  await assert.rejects(f.factory.assess(), {
    code: "FRESH_HOST_NATIVE_ACTIVATION_UNPROVEN",
  });
});
