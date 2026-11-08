import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type {
  EpochPointer,
  SuccessionAuthority,
} from "../src/queue-epoch-lineage";
import type { ProcessIdentity } from "../src/queue-instance-liveness";
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const historical = load("./tests/fixtures/historical-module.cjs") as <T>(
  revision: string,
  source: string,
) => T;
const lineage = load(
  "./src/queue-epoch-lineage",
) as typeof import("../src/queue-epoch-lineage");
const liveness = load(
  "./src/queue-instance-liveness",
) as typeof import("../src/queue-instance-liveness");
const oldLineage = historical<typeof lineage>(
  "bed43003745b67d4d6795e600fc40af85fb1daa1",
  "src/queue-epoch-lineage.js",
);
const oldLiveness = historical<typeof liveness>(
  "bed43003745b67d4d6795e600fc40af85fb1daa1",
  "src/queue-instance-liveness.js",
);
const hash = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
function fixture(
  t: { after(fn: () => void): void },
  implementation: typeof lineage,
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-evidence-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  function write(file: string, value: unknown) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  }
  const epochId = randomUUID(),
    epochRoot = path.join(directory, "admission-epochs", epochId);
  const rootState = path.join(directory, "queue-state.json"),
    rootIdentity = path.join(directory, "instance.json");
  write(rootState, { jobs: { historical: { state: "needs_reconciliation" } } });
  write(rootIdentity, { buildHash: "a".repeat(64) });
  write(path.join(epochRoot, "queue-state.json"), {
    jobs: { prior: { state: "running" } },
  });
  write(path.join(epochRoot, "instance.json"), { buildHash: "b".repeat(64) });
  const qualification = path.join(
    directory,
    "isolated-scratch-qualification",
    "result.json",
  );
  write(qualification, { status: "complete", synthetic: true });
  const pointer: EpochPointer = {
    root: epochRoot,
    epochId,
    ownerClientId: "owner",
    ownerTokenHash: "a".repeat(64),
    historicalSnapshotHash: hash(fs.readFileSync(rootState)),
    historicalIdentityHash: hash(fs.readFileSync(rootIdentity)),
    document: { fileId: null },
    currentInstance: { pid: 100, birth: "previous" },
    qualificationReceipt: implementation.reference(qualification),
    qualificationEvidence: [],
  };
  write(path.join(directory, "isolated-admission-epoch.json"), pointer);
  const requestId = "new-owned-epoch",
    audit = path.join(directory, "epoch-successions", hash(requestId));
  fs.mkdirSync(audit, { recursive: true, mode: 0o700 });
  const snapshot = implementation.predecessorSnapshot(directory, audit, true);
  const qualifiedFile = path.join(audit, "installed-qualification.json");
  const qualified = {
    passed: true,
    productionAdmission: true,
    liveSdkRequestsSent: 0,
    sourceCommit: "c".repeat(40),
    buildHash: "d".repeat(64),
    deadEpochSuccessorReadQualified: true,
    deadEpochSuccessorRestoreQualified: true,
  };
  write(qualifiedFile, qualified);
  const authority: SuccessionAuthority = {
    version: 1,
    kind: "owner-authenticated-dead-epoch-successor",
    requestId,
    clientId: pointer.ownerClientId,
    ownerTokenHash: pointer.ownerTokenHash,
    sourceCommit: qualified.sourceCommit,
    buildHash: qualified.buildHash,
    previousBuildHash: "b".repeat(64),
    previousBrokerTerminated: true,
    previousProcessTerminated: true,
    permission: "one-proven-new-document-only",
    historicalOutcome: "unknown",
    predecessor: snapshot,
    qualification: implementation.reference(qualifiedFile),
  };
  const authorityFile = path.join(audit, "authority.json");
  write(authorityFile, authority);
  const reference = () => implementation.reference(authorityFile);
  const storeAuthority = () => {
    write(authorityFile, authority);
    return reference();
  };
  const publishQualification = () => {
    write(qualifiedFile, qualified);
    authority.qualification = implementation.reference(qualifiedFile);
    return storeAuthority();
  };
  return {
    directory,
    epochRoot,
    rootState,
    rootIdentity,
    audit,
    pointer,
    authority,
    authorityFile,
    qualified,
    qualifiedFile,
    snapshot,
    write,
    reference,
    storeAuthority,
    publishQualification,
  };
}
for (const [name, implementation] of [
  ["retained", oldLineage],
  ["typed", lineage],
] as const) {
  test(`${name}: owned lineage retains original unknown/running state and exact archived bytes`, (t) => {
    const f = fixture(t, implementation),
      files = [
        f.rootState,
        f.rootIdentity,
        f.snapshot.state.path,
        f.snapshot.identity.path,
        f.snapshot.pointer.path,
      ];
    const before = files.map((file) => fs.readFileSync(file));
    const previous = implementation.successionAuthority(
      f.directory,
      f.reference(),
    );
    assert.deepEqual(previous.state, { jobs: { prior: { state: "running" } } });
    assert.equal(previous.authority.historicalOutcome, "unknown");
    const next: EpochPointer = {
      ...f.pointer,
      epochId: randomUUID(),
      succession: f.reference(),
      qualificationReceipt: {
        path: path.join(
          f.audit,
          "isolated-scratch-qualification",
          "result.json",
        ),
        sha256: "e".repeat(64),
      },
    };
    assert.equal(implementation.epochLineage(f.directory, next).length, 1);
    assert.equal(
      implementation.epochControlDirectory(f.directory, next),
      f.audit,
    );
    assert.deepEqual(
      files.map((file) => fs.readFileSync(file)),
      before,
    );
    assert.deepEqual(
      implementation.predecessorSnapshot(f.directory, f.audit, true),
      f.snapshot,
    );
  });
  for (const field of [
    "clientId",
    "ownerTokenHash",
    "sourceCommit",
    "previousBuildHash",
    "permission",
    "historicalOutcome",
  ] as const) {
    test(`${name}: owner authority refuses changed ${field}`, (t) => {
      const f = fixture(t, implementation);
      f.authority[field] = "foreign";
      const entry = f.storeAuthority();
      assert.throws(
        () => implementation.successionAuthority(f.directory, entry),
        { code: "EPOCH_LINEAGE_INVALID" },
      );
    });
  }
  for (const field of [
    "passed",
    "productionAdmission",
    "deadEpochSuccessorReadQualified",
    "deadEpochSuccessorRestoreQualified",
  ] as const) {
    test(`${name}: installed qualification requires ${field}`, (t) => {
      const f = fixture(t, implementation);
      f.qualified[field] = false;
      const entry = f.publishQualification();
      assert.throws(
        () => implementation.successionAuthority(f.directory, entry),
        { code: "EPOCH_LINEAGE_INVALID" },
      );
    });
  }
  test(`${name}: qualification must not send SDK work`, (t) => {
    const f = fixture(t, implementation);
    f.qualified.liveSdkRequestsSent = 1;
    assert.throws(
      () =>
        implementation.successionAuthority(
          f.directory,
          f.publishQualification(),
        ),
      { code: "EPOCH_LINEAGE_INVALID" },
    );
  });
  test(`${name}: changed or foreign retired evidence cannot release old work`, (t) => {
    const f = fixture(t, implementation);
    f.write(f.snapshot.state.path, { jobs: { prior: { state: "succeeded" } } });
    assert.throws(
      () => implementation.successionAuthority(f.directory, f.reference()),
      { code: "EPOCH_LINEAGE_INVALID" },
    );
    const expected = fs.readFileSync(f.snapshot.pointer.path);
    f.pointer.ownerClientId = "foreign";
    f.write(path.join(f.directory, "isolated-admission-epoch.json"), f.pointer);
    assert.throws(
      () => implementation.predecessorSnapshot(f.directory, f.audit, true),
      { code: "EPOCH_LINEAGE_INVALID" },
    );
    assert.deepEqual(fs.readFileSync(f.snapshot.pointer.path), expected);
  });
  test(`${name}: changed grants and cyclic history are refused`, (t) => {
    const f = fixture(t, implementation);
    const cycle: EpochPointer = {
      ...f.pointer,
      succession: f.reference(),
      qualificationReceipt: {
        path: path.join(
          f.audit,
          "isolated-scratch-qualification",
          "result.json",
        ),
        sha256: "e".repeat(64),
      },
    };
    assert.throws(() => implementation.epochLineage(f.directory, cycle), {
      code: "EPOCH_LINEAGE_INVALID",
    });
    f.write(path.join(f.epochRoot, "access-" + "f".repeat(64) + ".json"), {
      clientId: "foreign",
    });
    assert.throws(
      () => implementation.successionAuthority(f.directory, f.reference()),
      { code: "EPOCH_LINEAGE_INVALID" },
    );
  });
  test(`${name}: a failed qualified record cannot become passed between hash and JSON read`, (t) => {
    const f = fixture(t, implementation);
    f.qualified.passed = false;
    const entry = f.publishQualification();
    const originalOpen = fs.openSync;
    let reads = 0;
    // Deterministic external-file replacement at the old second-open window.
    // Production filesystem, hashing and descriptor-path guards remain real.
    t.mock.method(
      fs,
      "openSync",
      (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        const readOnly =
          typeof flags === "number" &&
          (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0;
        if (file === f.qualifiedFile && readOnly && ++reads === 2)
          f.write(f.qualifiedFile, { ...f.qualified, passed: true });
        return originalOpen(file, flags, mode);
      },
    );
    if (name === "retained") {
      assert.doesNotThrow(() =>
        implementation.successionAuthority(f.directory, entry),
      );
      assert.equal(reads, 2);
    } else {
      assert.throws(
        () => implementation.successionAuthority(f.directory, entry),
        { code: "EPOCH_LINEAGE_INVALID" },
      );
      assert.equal(
        reads,
        1,
        "Decode the same bytes whose hash was authenticated",
      );
    }
  });
  test(`${name}: returned identity is the authenticated identity even if a later read would differ`, (t) => {
    const f = fixture(t, implementation),
      entry = f.reference();
    const originalOpen = fs.openSync;
    let reads = 0;
    t.mock.method(
      fs,
      "openSync",
      (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        const readOnly =
          typeof flags === "number" &&
          (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0;
        if (file === f.snapshot.identity.path && readOnly && ++reads === 3)
          f.write(f.snapshot.identity.path, { buildHash: "foreign" });
        return originalOpen(file, flags, mode);
      },
    );
    const result = implementation.successionAuthority(f.directory, entry);
    assert.equal(
      result.identity["buildHash"],
      name === "retained" ? "foreign" : "b".repeat(64),
    );
    assert.equal(reads, name === "retained" ? 3 : 1);
  });
  test(`${name}: an authority cannot authenticate a request under a different request's journal`, (t) => {
    const f = fixture(t, implementation);
    const replacement = { ...f.authority, requestId: "different-request" };
    const entry = {
      path: f.authorityFile,
      sha256: hash(JSON.stringify(replacement)),
    };
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    let firstDescriptor: number | undefined;
    let reads = 0;
    t.mock.method(
      fs,
      "openSync",
      (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        const readOnly =
          typeof flags === "number" &&
          (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0;
        const fd = originalOpen(file, flags, mode);
        if (file === f.authorityFile && readOnly && ++reads === 1)
          firstDescriptor = fd;
        return fd;
      },
    );
    t.mock.method(fs, "closeSync", (fd: number) => {
      originalClose(fd);
      if (fd === firstDescriptor) {
        firstDescriptor = undefined;
        f.write(f.authorityFile, replacement);
      }
    });
    if (name === "retained") {
      const result = implementation.successionAuthority(f.directory, entry);
      assert.equal(result.authority.requestId, replacement.requestId);
      assert.equal(result.audit, f.audit);
      assert.equal(reads, 3);
    } else {
      assert.throws(
        () => implementation.successionAuthority(f.directory, entry),
        { code: "EPOCH_LINEAGE_INVALID" },
      );
      assert.equal(reads, 1);
    }
  });
}
const original: ProcessIdentity = {
  pid: 123,
  birth: "original",
  version: "fixture",
};
const selected: ProcessIdentity = {
  pid: 456,
  birth: "selected",
  version: "fixture",
};
for (const [name, implementation] of [
  ["retained", oldLiveness],
  ["typed", liveness],
] as const) {
  for (const expected of ["live", "terminated"] as const)
    for (const observed of [true, false, null]) {
      test(`${name}: ${expected} requires exact process liveness ${String(observed)}`, () => {
        if (observed === (expected === "live")) {
          const result = implementation.requireInstanceProcess(
            original,
            expected,
            () => observed,
          );
          assert.deepEqual(
            { ...result, observedAt: "time" },
            { ...original, live: observed, observedAt: "time" },
          );
          assert.match(result.observedAt, /^\d{4}-.*Z$/);
        } else
          assert.throws(
            () =>
              implementation.requireInstanceProcess(
                original,
                expected,
                () => observed,
              ),
            {
              code:
                observed === null
                  ? "INSTANCE_LIVENESS_UNAVAILABLE"
                  : "INSTANCE_CHANGED",
            },
          );
      });
    }
  for (const purpose of [
    "atomic-recovery-process-loss-audit-upgrade-v1",
    "isolated-scratch-epoch-upgrade-v1",
    "atomic-audit-facts-recovery-upgrade-v1",
  ]) {
    test(`${name}: ${purpose} proves old death and distinct current life without a model outcome`, () => {
      const upgrade = { purpose, currentInstance: selected };
      const result = implementation.requireRecoveryProcesses(
        original,
        upgrade,
        (value) => value.birth === selected.birth,
      );
      assert.equal(result.historical.live, false);
      assert.equal(result.current?.live, true);
      assert.equal(result.historicalOutcome, "unknown");
      assert.equal(result.endpointVerified, false);
      assert.throws(
        () =>
          implementation.requireRecoveryProcesses(
            original,
            { ...upgrade, currentInstance: original },
            () => false,
          ),
        { code: "INSTANCE_CHANGED" },
      );
    });
  }
  test(`${name}: process tuples drop incidental metadata and observations do not authorize a later state`, () => {
    const extended = { ...original, extra: true };
    assert.deepEqual(implementation.processTuple(extended), original);
    let live = true;
    const historical = implementation.requireInstanceProcess(
      original,
      "live",
      () => live,
    );
    live = false;
    assert.throws(
      () => implementation.requireRecoveryProcesses(original, null, () => live),
      { code: "INSTANCE_CHANGED" },
    );
    assert.equal(historical.live, true);
  });
}
