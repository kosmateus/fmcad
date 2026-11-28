import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const load = createRequire(
  path.join(root, "tests", "atomic-runtime-abi.test.js"),
);
const { buildHash, hash, durable } = load(
  "../src/queue-instance",
) as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { preparePythonArtifact } = load(
  "../src/python",
) as typeof import("../packages/node-adapters/src/python/artifact");
const { atomicRuntimeAbiUnits } = load(
  "../src/atomic-workflow-observation",
) as typeof import("../src/composition/library-atomic-workflow-observation");
const {
  buildAtomicRuntimeAbi,
  atomicRuntimeAbiStillCurrent,
  escrowAtomicGeneratorDependencies,
} = load(
  "../src/atomic-runtime-abi",
) as typeof import("../src/atomic-runtime-abi");

test(
  "legacy full-program witness is exact, relocation-stable and refuses original source/receipt drift",
  {},
  (t) => {
    const base = fs.mkdtempSync("/tmp/opencode/atomic-legacy-abi-");
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const originalRoot = path.join(base, "original-runtime");
    fs.cpSync(path.join(root, "dist"), originalRoot, { recursive: true });
    escrowAtomicGeneratorDependencies(originalRoot, base);
    const originalBuildHash = buildHash(originalRoot);
    const job = {
      id: "owned-atomic-job",
      requestId: "owned-request",
      clientId: "original-owner",
      hash: "a".repeat(64),
      request: { buildHash: originalBuildHash },
      dispatch: { rpcCount: 2 },
    };
    const doc = { name: "owned scratch", creationId: "owned-id", fileId: null };
    const identity = {
      commandId: "fmcad_atomic_" + "a".repeat(32),
      runId: "owned-run",
      requestHash: "b".repeat(64),
      sessionNonce: "c".repeat(32),
      backend: "addin",
      documentIdentity: { expected: doc, resolved: doc, assertionsOnly: true },
      resolvedIdentity: doc,
    };
    const context = {
      doc: doc.name,
      docId: doc.creationId,
      docFileId: null,
      component: null,
      projectId: null,
    };
    const statusFile = "runtime/python/fmcad/adapters/fusion/atomic_status.py";
    const prepared = {
      scope: { jobId: job.id },
      jobHash: job.hash,
      originalBuildHash,
      identity,
      expectedContext: context,
      sourceCompatibilityUnits: atomicRuntimeAbiUnits(),
      artifact: preparePythonArtifact([
        {
          id: "atomic-status",
          filename: statusFile,
          source: fs.readFileSync(path.join(root, statusFile), "utf8"),
          role: "runtime",
        },
      ]),
    };
    const oldAtomic = load(path.join(originalRoot, "src/batch-atomic")) as {
      prepareAtomicScript(value: unknown): { script: string };
    };
    const oldApplication = load(
      path.join(originalRoot, "src/dist/core/application/cad/atomic"),
    ) as { atomicRpcArgs(initial: unknown, operation: string): unknown };
    const initial = {
      context,
      commandId: identity.commandId,
      runId: identity.runId,
      requestHash: identity.requestHash,
      sessionNonce: identity.sessionNonce,
      atomic: { backend: "addin" },
      documentIdentity: {
        expected: { fileId: null, creationId: doc.creationId, name: doc.name },
        resolved: null,
        assertionsOnly: true,
      },
    };
    const code =
      oldAtomic.prepareAtomicScript(
        oldApplication.atomicRpcArgs(initial, "atomic_resolve"),
      ).script + '\n\nrun("")\n';
    const dir = path.join(base, "queue"),
      folder = path.join(dir, "jobs", job.id);
    fs.mkdirSync(folder, { recursive: true });
    const records = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ].map((rpcId, index) => {
      const sourceHash =
        index === 0
          ? hash(code)
          : hash("distinct original guarded start source");
      const binding = {
        jobId: job.id,
        rpcId,
        requestHash: hash("request:" + rpcId),
        buildHash: originalBuildHash,
        sourceHash,
      };
      const receipt = path.join(folder, `remote-${rpcId}.json`);
      const record = {
        binding,
        receipt,
        pythonArtifact: {
          sha256: "d".repeat(64),
          artifactHash: "e".repeat(64),
          units: [
            {
              id: "embedded:0",
              filename: "<fmcad-queue>",
              role: "user",
              sha256: sourceHash,
            },
            {
              id: "wire",
              filename: "<fmcad-wire>",
              role: "wrapper",
              sha256: "d".repeat(64),
            },
          ],
        },
      };
      durable(path.join(folder, `rpc-${rpcId}.json`), record, true);
      durable(
        receipt,
        {
          ...binding,
          terminal: true,
          outcome: index === 0 ? "succeeded" : "failed",
        },
        true,
      );
      return record;
    });
    const abi = buildAtomicRuntimeAbi(
      job,
      prepared as unknown as Parameters<typeof buildAtomicRuntimeAbi>[1],
      records,
      { dir, originalRoot },
    );
    assert.equal(abi.proof["kind"], "legacy-full-program-witness-v1");
    const witness = abi.proof["witness"] as {
      sourceHash: string;
      operation: string;
    };
    assert.equal(witness.sourceHash, records[0]!.binding.sourceHash);
    assert.equal(witness.operation, "atomic_resolve");
    assert.deepEqual(
      abi.proof.abiPinnedUnits,
      prepared.sourceCompatibilityUnits,
    );
    assert.equal(
      Object.hasOwn(abi.proof, "passed"),
      false,
      "historical source proof is not checker/native PASS",
    );
    assert.equal(atomicRuntimeAbiStillCurrent(abi), true);
    assert.equal(
      buildAtomicRuntimeAbi(
        job,
        prepared as unknown as Parameters<typeof buildAtomicRuntimeAbi>[1],
        [...records].reverse(),
        { dir, originalRoot },
      ).hash,
      abi.hash,
      "inventory order cannot change the semantic ABI commitment",
    );
    const relocated = path.join(base, "relocated-runtime");
    fs.cpSync(originalRoot, relocated, { recursive: true });
    assert.equal(
      buildAtomicRuntimeAbi(
        job,
        prepared as unknown as Parameters<typeof buildAtomicRuntimeAbi>[1],
        records,
        { dir, originalRoot: relocated },
      ).hash,
      abi.hash,
      "runtime relocation changes only private locators, not the proof/context hash",
    );
    const recordFile = path.join(
      folder,
      `rpc-${records[0]!.binding.rpcId}.json`,
    );
    const originalBytes = fs.readFileSync(recordFile);
    fs.appendFileSync(recordFile, "\n");
    assert.equal(atomicRuntimeAbiStillCurrent(abi), false);
    fs.writeFileSync(recordFile, originalBytes);
    const fresh = buildAtomicRuntimeAbi(
      job,
      prepared as unknown as Parameters<typeof buildAtomicRuntimeAbi>[1],
      records,
      { dir, originalRoot },
    );
    const sourceFile = path.join(originalRoot, "src/batch-atomic.js");
    fs.chmodSync(sourceFile, 0o600);
    fs.appendFileSync(sourceFile, "\n// drift\n");
    assert.equal(atomicRuntimeAbiStillCurrent(fresh), false);
    assert.throws(
      () =>
        buildAtomicRuntimeAbi(
          job,
          prepared as unknown as Parameters<typeof buildAtomicRuntimeAbi>[1],
          records,
          { dir, originalRoot },
        ),
      { code: "BUILD_CHANGED" },
    );
  },
);
