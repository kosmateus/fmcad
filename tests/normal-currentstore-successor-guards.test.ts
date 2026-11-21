import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";

const load = createRequire(__filename);
const normal = load(
  "../src/dist/composition/queue-normal-cold-successor",
) as typeof import("../src/composition/queue-normal-cold-successor");
const { QueueState } = load(
  "../src/queue-state",
) as typeof import("../src/queue-state");
const { canonical } = load(
  "../src/dist/core/domain/queue",
) as typeof import("../packages/core/src/domain/queue");

type Reference = { path: string; sha256: string };
type ProcessPin = { pid: number; birth: string };
type NormalColdPorts =
  import("../src/composition/queue-normal-cold-successor").NormalColdPorts;
type NormalModule =
  typeof import("../src/composition/queue-normal-cold-successor");
type QueueStateClass = typeof import("../src/queue-state").QueueState;
type Canonical = typeof import("../packages/core/src/domain/queue").canonical;
type TestApproval = {
  requestId: string;
  clientId: string;
  previousBuildHash: string;
  expectedProcess: ProcessPin;
  normalCurrentStore: {
    kind: string;
    jobAuthorization: Reference;
    deathProof: Reference;
    producerRetirement: Reference;
  };
};
type Fixture = {
  p: {
    sourceCommit: string;
    buildHash: string;
    epochId: string;
    epochClientId: string;
    jobId: string;
    jobClientId: string;
    jobRequestId: string;
    creationId: string;
    documentName: string;
    sdk: ProcessPin;
    metadata: ProcessPin;
    worker: ProcessPin;
    configHash: string;
  };
  worker: ProcessPin;
  dir: string;
  epoch: string;
  jobDir: string;
  jobClient: { dir: string; auth: { clientId: string; clientToken: string } };
  epochClient: { dir: string; auth: { clientId: string; clientToken: string } };
  pointer: Record<string, unknown>;
  requestId: string;
  requestFile: string;
  workerIdentity: string;
  rpcFile: string;
  closedFile: string;
  targetFile: string;
  rootState: string;
  epochState: string;
  authorization: Reference;
  retirement: Reference;
  expectedProcess: ProcessPin;
  approval: TestApproval;
  targetReference: Reference;
  ports: NormalColdPorts;
  sdkCalls: ProcessPin[];
  producerCalls: ProcessPin[];
  captureHistory(): Array<[string, Buffer | string]>;
  requestMetadata(): Record<string, number | boolean>;
  withRequestAccessGuard(operation: () => unknown): {
    value: unknown;
    attempts: string[];
  };
  updateTarget(changes: Record<string, unknown>): Reference;
  mutateJobRequest(changes: Record<string, unknown>): Reference;
  addUnresolvedJob(): unknown;
};
type FixtureContext = { after(callback: () => void): void };
type FixtureModule = {
  createFixture(
    normal: NormalModule,
    QueueState: QueueStateClass,
    canonical: Canonical,
    testContext: FixtureContext,
    options?: {
      omitWorkerIdentity?: boolean;
      workerStartWithoutIdentity?: boolean;
    },
  ): Fixture;
  hash(value: string | Uint8Array): string;
  reference(file: string): Reference;
};
const fixtures = load(
  "../../tests/fixtures/normal-currentstore-successor-guards.cjs",
) as FixtureModule;

function fixture(
  t: FixtureContext,
  options?: Parameters<FixtureModule["createFixture"]>[4],
): Fixture {
  return fixtures.createFixture(normal, QueueState, canonical, t, options);
}

function inspect(
  f: Fixture,
  approval: TestApproval = f.approval,
  pointer: Record<string, unknown> = f.pointer,
  ports: NormalColdPorts = f.ports,
) {
  return normal.inspectNormalCurrentStore(
    f.dir,
    approval as unknown as import("../src/composition/queue-epoch-successor-types").Approval,
    pointer as unknown as import("../src/composition/queue-epoch-successor-types").Pointer,
    ports,
  );
}

test("normal cold profile exposes only its fixed kind and source/build pins", () => {
  assert.deepEqual(normal.normalColdProfile, {
    kind: "normal-currentstore-v1",
    sourceCommit: "4bae34f9970b1a3179528a1dd06e2d0e5a3f702d",
    buildHash:
      "6b0c57e05541950a885527f09cde9b36ae0219c658a2cf2911af81728e26458a",
  });
  assert.equal(Object.isFrozen(normal.normalColdProfile), true);
});

const invalidTargetCases: Array<
  [string, (f: Fixture) => Record<string, unknown>]
> = [
  ["source override", () => ({ sourceCommit: randomUUID() })],
  ["build override", () => ({ buildHash: randomUUID() })],
  [
    "duplicate epoch and job owner",
    (f) => ({ epochClientId: f.p.jobClientId }),
  ],
  ["malformed request hash", () => ({ requestHash: "not-a-sha256" })],
  [
    "SDK birth from a non-Windows namespace",
    (f) => ({ sdk: { ...f.p.sdk, birth: `synthetic:${randomUUID()}` } }),
  ],
  ["malformed configuration hash", () => ({ configHash: "f".repeat(63) })],
  [
    "configuration hash from another predecessor",
    () => ({ configHash: randomBytes(32).toString("hex") }),
  ],
];

for (const [name, changes] of invalidTargetCases) {
  test(`authorization refuses target schema drift: ${name}`, (t) => {
    const f = fixture(t);
    const target = f.updateTarget(changes(f));
    assert.throws(() =>
      normal.authorizeNormalCurrentStore(
        f.jobClient,
        `normal-cold:${randomUUID()}`,
        target,
      ),
    );
  });
}

const mismatchedJobRequests: Array<
  [string, (f: Fixture) => Record<string, unknown>]
> = [
  ["client owner", () => ({ clientId: `normal-other-owner:${randomUUID()}` })],
  ["request id", () => ({ requestId: randomUUID() })],
  [
    "duplicate document selector",
    (f) => ({
      argv: [
        "run",
        "/synthetic/extra.py",
        "--doc-id",
        f.p.creationId,
        "--doc",
        f.p.documentName,
        "--helpers",
        "cad-v1",
        "--doc-id",
        randomUUID(),
      ],
    }),
  ],
];

for (const [name, changes] of mismatchedJobRequests) {
  test(`authorization refuses a job request with mismatched ${name}`, (t) => {
    const f = fixture(t);
    const target = f.mutateJobRequest(changes(f));
    const before = f.captureHistory();
    assert.throws(() =>
      normal.authorizeNormalCurrentStore(
        f.jobClient,
        `normal-cold:${randomUUID()}`,
        target,
      ),
    );
    assert.deepEqual(f.captureHistory(), before);
  });
}

test("job and epoch owners cannot act as confused deputies", (t) => {
  const f = fixture(t);
  const before = f.captureHistory();
  const wrongTokenClient = {
    dir: f.dir,
    auth: {
      clientId: f.p.jobClientId,
      clientToken: `synthetic-wrong-token:${randomUUID()}`,
    },
  };

  assert.throws(() =>
    normal.authorizeNormalCurrentStore(
      wrongTokenClient,
      `normal-cold:${randomUUID()}`,
      f.targetReference,
    ),
  );
  assert.throws(() =>
    normal.authorizeNormalCurrentStore(
      f.epochClient,
      `normal-cold:${randomUUID()}`,
      f.targetReference,
    ),
  );
  assert.throws(() =>
    normal.authorizeNormalCurrentStore(
      f.jobClient,
      f.p.jobRequestId,
      f.targetReference,
    ),
  );
  assert.deepEqual(f.captureHistory(), before);
});

test("a copied authorization grant cannot be retargeted to a new request", (t) => {
  const f = fixture(t);
  const newRequestId = `normal-cold:${randomUUID()}`;
  const copiedGrant = path.join(
    f.dir,
    "normal-cold-successions",
    fixtures.hash(newRequestId),
    "job-owner-authorization.json",
  );
  fs.mkdirSync(path.dirname(copiedGrant), { recursive: true });
  fs.copyFileSync(f.authorization.path, copiedGrant);
  const approval = {
    ...f.approval,
    requestId: newRequestId,
    normalCurrentStore: {
      ...f.approval.normalCurrentStore,
      jobAuthorization: fixtures.reference(copiedGrant),
    },
  };

  assert.throws(() => inspect(f, approval));
});

test("normal-currentstore approvals refuse atomic and foreign epoch discriminators", (t) => {
  const f = fixture(t);
  const atomicApproval: TestApproval = {
    ...f.approval,
    normalCurrentStore: {
      ...f.approval.normalCurrentStore,
      kind: "atomic-epoch-successor-v1",
    },
  };
  const foreignPointer = { ...f.pointer, epochId: randomUUID() };

  assert.throws(() => inspect(f, atomicApproval));
  assert.throws(() => inspect(f, f.approval, foreignPointer));
});

test("a changed normal closed proof is not accepted as the original epoch grant", (t) => {
  const f = fixture(t);
  const closed = JSON.parse(fs.readFileSync(f.closedFile, "utf8")) as {
    historicalOutcome: string;
  };
  closed.historicalOutcome = "succeeded";
  fs.writeFileSync(f.closedFile, JSON.stringify(closed));

  assert.throws(() => inspect(f));
});

test("a second unresolved job refuses authorization without rewriting history", (t) => {
  const f = fixture(t);
  f.addUnresolvedJob();
  const before = f.captureHistory();

  assert.throws(() =>
    normal.authorizeNormalCurrentStore(
      f.jobClient,
      `normal-cold:${randomUUID()}`,
      f.targetReference,
    ),
  );
  assert.deepEqual(f.captureHistory(), before);
});

test("a started producer without its worker identity cannot be retired", (t) => {
  assert.throws(() =>
    fixture(t, {
      omitWorkerIdentity: true,
      workerStartWithoutIdentity: true,
    }),
  );
});

test("a symlink from retained job records cannot escape the synthetic root", (t) => {
  const f = fixture(t);
  const outside = fs.mkdtempSync("/tmp/opencode/normal-currentstore-escape-");
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const retained = path.join(f.jobDir, "worker-result.json");
  const external = path.join(outside, "worker-result.json");
  fs.copyFileSync(retained, external);
  const externalBytes = fs.readFileSync(external);
  fs.unlinkSync(retained);
  fs.symlinkSync(external, retained);

  assert.throws(() =>
    normal.authorizeNormalCurrentStore(
      f.jobClient,
      `normal-cold:${randomUUID()}`,
      f.targetReference,
    ),
  );
  assert.deepEqual(fs.readFileSync(external), externalBytes);
});

test("OS observation ports receive exact synthetic process pins and strict birth ordering", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.sdkCalls[0], {
    pid: f.p.sdk.pid,
    birth: f.p.sdk.birth,
  });
  assert.deepEqual(f.producerCalls.slice(0, 2), [f.p.metadata, f.worker]);

  assert.doesNotThrow(() => inspect(f));
  assert.deepEqual(f.sdkCalls.slice(-2), [
    { pid: f.p.sdk.pid, birth: f.p.sdk.birth },
    f.expectedProcess,
  ]);

  const retiredAt = Date.parse(
    (
      JSON.parse(fs.readFileSync(f.retirement.path, "utf8")) as {
        observedAtUtc: string;
      }
    ).observedAtUtc,
  );
  const filetimeEpoch = 116444736000000000n;
  const equalBirth = (BigInt(retiredAt) * 10000n + filetimeEpoch).toString();
  const equalBoundary: TestApproval = {
    ...f.approval,
    expectedProcess: { ...f.expectedProcess, birth: equalBirth },
  };
  assert.throws(() => inspect(f, equalBoundary));

  const mismatchedOldProcess: NormalColdPorts = {
    ...f.ports,
    sdkProcess(process) {
      const observation = f.ports.sdkProcess(process);
      return process.pid === f.p.sdk.pid
        ? { ...observation, pid: process.pid + 1 }
        : observation;
    },
  };
  assert.throws(() =>
    normal.recordNormalProducerRetirement(
      f.epochClient,
      f.requestId,
      f.authorization,
      mismatchedOldProcess,
    ),
  );
});

test("authorization and inspection preserve history without accessing request.json", (t) => {
  const f = fixture(t);
  const initialHistory = f.captureHistory();
  const requestMetadata = f.requestMetadata();
  const guardedAuthorization = f.withRequestAccessGuard(() => {
    assert.throws(() =>
      normal.authorizeNormalCurrentStore(
        f.jobClient,
        `normal-cold:${randomUUID()}`,
        { path: f.requestFile, sha256: "0".repeat(64) },
      ),
    );
    return normal.authorizeNormalCurrentStore(
      f.jobClient,
      `normal-cold:${randomUUID()}`,
      f.targetReference,
    );
  });

  assert.ok(guardedAuthorization.value);
  assert.deepEqual(guardedAuthorization.attempts, []);
  const authorizationPath = (guardedAuthorization.value as Reference).path;
  assert.deepEqual(
    f
      .captureHistory()
      .filter(([relative]) => path.join(f.dir, relative) !== authorizationPath),
    initialHistory,
  );

  const inspectionHistory = f.captureHistory();
  const guarded = f.withRequestAccessGuard(() => inspect(f));

  assert.ok(guarded.value);
  assert.deepEqual(guarded.attempts, []);
  assert.deepEqual(f.captureHistory(), inspectionHistory);
  assert.deepEqual(f.requestMetadata(), requestMetadata);
});
