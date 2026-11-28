import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

interface Identity {
  commandId: string;
  runId: string;
  requestHash: string;
  backend: string;
  sessionNonce: string;
  documentIdentity: {
    expected: { name: string; creationId: string; fileId: string | null };
    resolved: { name: string; creationId: string; fileId: string | null };
    assertionsOnly: boolean;
  };
  resolvedIdentity: { name: string; creationId: string; fileId: string | null };
}
const repository = process.cwd();
const load = createRequire(
  path.join(repository, "tests", "atomic-observation-binding.test.js"),
);

const { preparePythonArtifact } = load(
  "../src/python",
) as typeof import("../packages/node-adapters/src/python/artifact");
const { hash: rawUtf8Hash } = load("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const {
  atomicObservationIdentityHash,
  assertAtomicObservationIdentity,
  assertAtomicObservationWire,
} = load(
  "../src/atomic-observation-binding",
) as typeof import("../src/atomic-observation-binding");

function identity(): Identity {
  return {
    commandId: "fmcad_atomic_" + "a".repeat(32),
    runId: "owned-run",
    requestHash: "b".repeat(64),
    backend: "addin",
    sessionNonce: "c".repeat(32),
    documentIdentity: {
      expected: {
        name: "owned scratch",
        creationId: "scratch-id",
        fileId: null,
      },
      resolved: {
        name: "owned scratch",
        creationId: "scratch-id",
        fileId: null,
      },
      assertionsOnly: true,
    },
    resolvedIdentity: {
      name: "owned scratch",
      creationId: "scratch-id",
      fileId: null,
    },
  };
}
function reordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reordered);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reordered(item)]),
  );
}

test("semantic identity survives nested JSON key ordering but never normalizes final wire bytes", () => {
  assert.equal(
    atomicObservationIdentityHash,
    (
      load(
        "../src/dist/core/application/cad/json",
      ) as typeof import("../packages/core/src/application/cad/json")
    ).hash,
    "wire and ABI proof use the very same canonical implementation, not matching test strings",
  );
  const original = identity(),
    alternate = reordered(original);
  assert.notEqual(JSON.stringify(original), JSON.stringify(alternate));
  const pinned = atomicObservationIdentityHash(original);
  const declared = atomicObservationIdentityHash(alternate);
  assert.equal(declared, pinned);
  assertAtomicObservationIdentity(alternate, declared, pinned);
  assert.notEqual(
    rawUtf8Hash(JSON.stringify(original)),
    rawUtf8Hash(JSON.stringify(alternate)),
    "transport/source byte hashing is deliberately a different contract",
  );
  const artifact = preparePythonArtifact([
    {
      id: "wire",
      filename: "<binding-fixture>",
      role: "wrapper",
      source:
        "value: int = 1\ndef run(context: str) -> None:\n    print(value, context)\n",
    },
  ]);
  let sent = 0;
  const admit = (
    subject: unknown,
    hash: string,
    code: string,
    prepared = artifact,
  ) => {
    assertAtomicObservationIdentity(subject, hash, pinned);
    assertAtomicObservationWire(code, prepared);
    sent++;
  };
  admit(alternate, declared, artifact.script);
  assert.equal(sent, 1);
  assert.throws(() => admit(alternate, declared, artifact.script + "\n"), {
    code: "WORKFLOW_ARTIFACT_CHANGED",
  });
  assert.equal(
    sent,
    1,
    "unchanged semantic identity never authorizes altered actual wire bytes",
  );
});

test("forged identity cannot be admitted even when the attacker rehashes the forged object consistently", () => {
  const original = identity(),
    pinned = atomicObservationIdentityHash(original);
  let sent = 0;
  const mutations: Array<(value: Identity) => void> = [
    (value) => {
      value.sessionNonce = "d".repeat(32);
    },
    (value) => {
      value.documentIdentity.expected.creationId = "foreign-scratch";
    },
    (value) => {
      value.documentIdentity.resolved.fileId = "foreign-file";
    },
    (value) => {
      value.resolvedIdentity.name = "foreign-name";
    },
  ];
  for (const mutate of mutations) {
    const forged = structuredClone(original);
    mutate(forged);
    const declared = atomicObservationIdentityHash(forged);
    assert.notEqual(declared, pinned);
    assert.throws(
      () => {
        assertAtomicObservationIdentity(forged, declared, pinned);
        sent++;
      },
      { code: "WORKFLOW_IDENTITY_MISMATCH" },
    );
  }
  assert.equal(
    sent,
    0,
    "the independent receipt/proof identity, not a caller-provided new hash, owns admission",
  );
});

test("wire artifact byte/manifest tampering remains a local refusal before the sender", () => {
  const artifact = preparePythonArtifact([
    {
      id: "wire",
      filename: "<binding-fixture>",
      role: "wrapper",
      source: "value: int = 1\n",
    },
  ]);
  const forged = { ...artifact, bytes: [...artifact.bytes] };
  forged.bytes[0] = forged.bytes[0]! ^ 1;
  let sent = 0;
  assert.throws(
    () => {
      assertAtomicObservationWire(artifact.script, forged);
      sent++;
    },
    { code: "WORKFLOW_ARTIFACT_CHANGED" },
  );
  assert.equal(sent, 0);
});

test("typed atomic observer constructor preserves retained final bytes, RPC IDs and ABI bindings", (t) => {
  t.after((load("./fixtures/fake-wsl-platform.cjs") as () => () => void)());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-wire-parity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = (
    load("./fixtures/historical-module.cjs") as (
      revision: string,
      file: string,
    ) => typeof import("../src/queue-atomic-wire")
  )("330849f22302bcf0ee955cd1945ddb2040eff8c7", "src/queue-atomic-wire.js");
  const current = load(
    "../src/queue-atomic-wire",
  ) as typeof import("../src/queue-atomic-wire");
  const subject = identity();
  const proof = {
    version: 1,
    identityHash: atomicObservationIdentityHash(subject),
  };
  const abi = { proof, hash: atomicObservationIdentityHash(proof) };
  const artifact = preparePythonArtifact(
    [
      {
        id: "observer",
        filename: "observer.py",
        role: "runtime",
        source: "def run(context: str) -> None:\n    print(context)\n",
      },
    ],
    { context: { atomicRuntimeAbiHash: abi.hash } },
  );
  for (const includeId of [false, true]) {
    const input = {
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        ...(includeId ? { id: 2 } : {}),
        params: {
          name: "execute_python",
          arguments: {
            code: artifact.script + '\nrun("")\n',
            persistent: false,
          },
        },
      },
      rpcId: "rpc-A",
      observerJobId: "observer-A",
      targetJobId: "target-A",
      codeHash: "build-A",
      identity: subject,
      instance: { pid: 123, birth: "boot:123", version: "2706" },
      receipt: path.join(dir, "receipt.json"),
      dispatchTimeoutMs: 30000,
      originArtifact: artifact,
      atomicRuntimeAbi: abi,
    };
    const untouched = structuredClone(input);
    assert.deepEqual(
      current.prepareAtomicObservationWire(input),
      old.prepareAtomicObservationWire(input),
    );
    assert.deepEqual(input, untouched);
    assert.throws(
      () =>
        current.prepareAtomicObservationWire({
          ...input,
          atomicRuntimeAbi: { ...abi, hash: "foreign" },
        }),
      { code: "BUILD_CHANGED" },
    );
  }
});
