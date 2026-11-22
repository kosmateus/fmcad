import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { QueueDomain } from "../packages/core/src/domain/queue";
import { initialQueueSnapshot } from "../packages/core/src/domain/queue-model";
import type { DocumentObservation } from "../packages/core/src/domain/document-checkpoint";
import {
  quarantineConflicts,
  physicalReleaseInput,
} from "../packages/core/src/domain/queue-quarantine";
import type {
  QueueIsolationTarget,
  QueueQuarantine,
  QueueRequest,
  QueuePhysicalDispatch,
  QueueJob,
} from "../packages/core/src/domain/queue-model";

function exposure(
  jobId: string,
  target: QueueIsolationTarget | null,
): QueueQuarantine {
  return {
    jobId,
    target,
    requestId: "request-" + jobId,
    clientId: "vanished-author",
    jobHash: "a".repeat(64),
    catalogDigest: "b".repeat(64),
    evidenceReference: "fixture:released:" + jobId,
    evidenceDigest: "c".repeat(64),
    binding: {},
  };
}
function request(argv: string[]): QueueRequest {
  return {
    kind: "command",
    clientId: "new-author",
    requestId: "new-operation",
    argv,
    cwd: "/owned-fixture",
    timeoutMs: 1000,
  };
}
function submittedJob(domain: QueueDomain, input: QueueRequest): QueueJob {
  const result = domain.submit(input);
  const id = result["id"];
  assert.ok(typeof id === "string");
  const job = domain.data.jobs[id];
  assert.ok(job);
  return structuredClone(job);
}

test("unlock classification includes all same-document conflicts and global exposure, independently of author", () => {
  const quarantined = {
    z: exposure("z", { creationId: "document-A" }),
    b: exposure("b", { creationId: "document-B" }),
    a: exposure("a", { creationId: "document-A" }),
    g: exposure("g", null),
  };
  const before = JSON.stringify(quarantined);
  const conflicts = quarantineConflicts(
    { quarantined },
    request(["cad", "param", "apply", "--doc-id", "document-A"]),
  );
  assert.deepEqual(
    conflicts.map(({ jobId }) => jobId),
    ["a", "g", "z"],
  );
  assert.equal(JSON.stringify(quarantined), before);
});

test("bounded independent document remains independent but raw or a name cannot claim it", () => {
  const snapshot = {
    quarantined: { a: exposure("a", { creationId: "document-A" }) },
  };
  assert.deepEqual(
    quarantineConflicts(
      snapshot,
      request(["param", "inspect", "--doc-id", "document-B"]),
    ),
    [],
  );
  for (const argv of [
    ["run", "anything.py", "--doc-id", "document-B"],
    ["param", "inspect", "--doc", "document-B"],
  ])
    assert.deepEqual(
      quarantineConflicts(snapshot, request(argv)).map(({ jobId }) => jobId),
      ["a"],
    );
});

test("unproven document and DataFile aliases remain conflicts until identity is verified", () => {
  const snapshot = { quarantined: { a: exposure("a", { fileId: "file-A" }) } };
  assert.equal(
    quarantineConflicts(
      snapshot,
      request([
        "param",
        "inspect",
        "--doc-id",
        "different-looking-creation-id",
      ]),
    ).length,
    1,
  );
  assert.equal(
    quarantineConflicts(
      snapshot,
      request(["param", "inspect", "--doc-file-id", "file-B"]),
    ).length,
    0,
  );
});

function checkpointFixture() {
  let number = 0;
  let now = 100;
  let failWrite = false;
  const snapshot = initialQueueSnapshot();
  // Release-proof authentication is exercised by the existing quarantine suite.
  // This fixture starts at its already-fenced domain boundary.
  snapshot.quarantined = { old: exposure("old", { creationId: "document-A" }) };
  const domain = new QueueDomain({
    snapshot,
    recover: false,
    now: () => now,
    newId: () => "checkpoint-" + ++number,
    hash: (value) => createHash("sha256").update(value).digest("hex"),
    commit: () => {
      if (failWrite) throw new Error("Owned fixture ENOSPC");
    },
  });
  const observation: DocumentObservation = {
    version: 1,
    id: "observation-1",
    requestId: "inspect-1",
    actorClientId: "successor-with-own-identity",
    target: { creationId: "document-A" },
    generation: "generation-current",
    scope: "parameters",
    stateDigest: "d".repeat(64),
    readback: {
      reference: "readback-owned.json",
      sha256: "e".repeat(64),
      probeRequestId: "probe-1",
    },
    blockers: [
      {
        jobId: "old",
        requestId: "request-old",
        originalHash: "a".repeat(64),
        catalogDigest: "b".repeat(64),
        barrierRef: "fixture:released:old",
      },
    ],
    priorCheckpointId: null,
    createdAt: 100,
  };
  const acceptance = {
    observationId: observation.id,
    requestId: "accept-1",
    actorClientId: observation.actorClientId,
    generation: observation.generation,
    observedStateDigest: observation.stateDigest,
  };
  return {
    domain,
    observation,
    acceptance,
    setNow: (value: number) => {
      now = value;
    },
    failWrite: () => {
      failWrite = true;
    },
  };
}

test("successor accepts its own readback without adopting the vanished author's identity or deleting UNKNOWN exposure", () => {
  const { domain, observation, acceptance } = checkpointFixture();
  const old = JSON.stringify(domain.data.quarantined);
  domain.recordDocumentObservation(observation);
  const accepted = domain.acceptDocumentObservation(acceptance);
  assert.equal(accepted.actorClientId, "successor-with-own-identity");
  assert.equal(JSON.stringify(domain.data.quarantined), old);
  assert.deepEqual(domain.acceptDocumentObservation(acceptance), accepted);
});

test("inspection and acceptance cannot reuse the same actor's request identity for different actions", () => {
  const { domain, observation, acceptance } = checkpointFixture();
  domain.recordDocumentObservation(observation);
  assert.throws(
    () =>
      domain.acceptDocumentObservation({
        ...acceptance,
        requestId: observation.requestId,
      }),
    { code: "REQUEST_CONFLICT" },
  );
  domain.acceptDocumentObservation(acceptance);
  assert.throws(
    () =>
      domain.recordDocumentObservation({
        ...observation,
        id: "another-observation",
        requestId: acceptance.requestId,
      }),
    { code: "REQUEST_CONFLICT" },
  );
});

test("accept rejects another observer, stale state, and a new conflict before publishing a head", () => {
  for (const change of ["actor", "state", "blocker", "generation"] as const) {
    const { domain, observation, acceptance } = checkpointFixture();
    domain.recordDocumentObservation(observation);
    if (change === "actor") acceptance.actorClientId = "other-client";
    if (change === "state") acceptance.observedStateDigest = "f".repeat(64);
    if (change === "generation") acceptance.generation = "later-generation";
    if (change === "blocker")
      domain.data.quarantined!["later"] = exposure("later", {
        creationId: "document-A",
      });
    assert.throws(() => domain.acceptDocumentObservation(acceptance), {
      code:
        change === "actor"
          ? "NOT_AUTHORIZED"
          : change === "blocker"
            ? "CHECKPOINT_CHANGED"
            : "DOCUMENT_STATE_CHANGED",
    });
    assert.deepEqual(domain.data.documentCheckpoints!.heads, {});
  }
});

test("two accepts of one observation have one head winner; unrelated document progress does not invalidate it", () => {
  const { domain, observation, acceptance } = checkpointFixture();
  domain.recordDocumentObservation(observation);
  domain.data.quarantined!["independent"] = exposure("independent", {
    creationId: "document-B",
  });
  const accepted = domain.acceptDocumentObservation(acceptance);
  assert.throws(
    () =>
      domain.acceptDocumentObservation({
        ...acceptance,
        requestId: "accept-competing",
      }),
    {
      code: "CHECKPOINT_CHANGED",
    },
  );
  assert.deepEqual(Object.values(domain.data.documentCheckpoints!.heads), [
    accepted.id,
  ]);
});

test("failed durable acceptance publishes no new in-memory head", () => {
  const { domain, observation, acceptance, failWrite } = checkpointFixture();
  domain.recordDocumentObservation(observation);
  failWrite();
  assert.throws(
    () => domain.acceptDocumentObservation(acceptance),
    /Owned fixture ENOSPC/,
  );
  assert.deepEqual(domain.data.documentCheckpoints!.heads, {});
});

test("checkpoint receipt survives domain restoration and rejects changed or disconnected history", () => {
  const { domain, observation, acceptance } = checkpointFixture();
  domain.recordDocumentObservation(observation);
  const receipt = domain.acceptDocumentObservation(acceptance);
  const snapshot = structuredClone(domain.data);
  // The original operation may later obtain an authentic terminal result.
  // Its old exposure need not remain active for the accepted history to survive.
  delete snapshot.quarantined;
  const reopen = (value: typeof snapshot) =>
    new QueueDomain({
      snapshot: value,
      now: () => 200,
      newId: () => "must-not-allocate",
      hash: (text) => createHash("sha256").update(text).digest("hex"),
    });
  assert.deepEqual(
    reopen(snapshot).acceptDocumentObservation(acceptance),
    receipt,
  );
  for (const variant of [
    "digest",
    "head",
    "ancestry",
    "unknown-field",
  ] as const) {
    const changed = structuredClone(snapshot);
    const stored = changed.documentCheckpoints!;
    if (variant === "digest")
      stored.observations[observation.id]!.stateDigest = "f".repeat(64);
    if (variant === "head") stored.heads[receipt.targetKey] = "missing-head";
    if (variant === "ancestry")
      stored.acceptances[receipt.id]!.priorCheckpointId = receipt.id;
    if (variant === "unknown-field")
      Object.assign(stored.observations[observation.id]!, { force: true });
    assert.throws(() => reopen(changed), { code: "CORRUPT_STATE" });
  }
});

function releasedUnknownWithWaiting() {
  let number = 0;
  const hash = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  const domain = new QueueDomain({
    now: () => 100,
    newId: () => "job-" + ++number,
    hash,
  });
  const original = submittedJob(domain, {
    ...request(["param", "apply", "--doc-id", "document-A"]),
    clientId: "original-agent",
    requestId: "original-request",
  });
  domain.next();
  const beforeA = submittedJob(domain, {
    ...request(["param", "apply", "--doc-id", "document-A"]),
    requestId: "waiting-A",
  });
  const beforeB = submittedJob(domain, {
    ...request(["param", "apply", "--doc-id", "document-B"]),
    requestId: "waiting-B",
  });
  const entry: QueuePhysicalDispatch = {
    request: {
      kind: "product",
      jobId: original.id,
      requestId: "original-request",
      requestHash: domain.data.jobs[original.id]!.hash,
      clientId: "original-agent",
      grantGeneration: 0,
      physicalRequestId: "owned-turn",
      documentSelector: { creationId: "document-A" },
    },
    physical: {
      version: 1,
      grantDigest: "a".repeat(64),
      generation: { instance: "instance-1", epoch: "epoch-1" },
      physicalRuntime: {
        pid: 42,
        birth: "birth-42",
        source: "source",
        build: "build",
        version: "version",
      },
      turnId: "owned-turn",
      target: JSON.stringify({ creationId: "document-A" }),
    },
    target: { creationId: "document-A" },
    intentReference: "physical-turn-" + "a".repeat(64) + ".json",
    intentDigest: "b".repeat(64),
  };
  domain.markDispatch(original.id, {}, entry);
  domain.block(original.id, { code: "OWNED_LOST_RESPONSE" });
  const old = domain.data.jobs[original.id]!;
  const evidenceDigest = hash(
    physicalReleaseInput(entry.physical, "dispatch-finally"),
  );
  const evidenceReference = "fmcad-physical-turn:sha256:" + evidenceDigest;
  domain.quarantineUnknown(original.id, {
    jobId: old.id,
    requestId: old.requestId,
    clientId: old.clientId,
    jobHash: old.hash,
    target: entry.target,
    evidenceDigest,
    evidenceReference,
    catalogDigest: hash(JSON.stringify(old.physicalDispatches)),
    binding: {
      jobId: old.id,
      requestId: old.requestId,
      requestHash: old.hash,
      clientId: old.clientId,
      physicalTurns: [
        {
          state: "released",
          binding: entry.physical,
          physicalEvidenceReference: evidenceReference,
          evidenceDigest,
        },
      ],
    },
  });
  return { domain, original, beforeA, beforeB };
}

test("publishing a genuine fenced UNKNOWN refuses queued A without preventing independent B", () => {
  const { domain, original, beforeA, beforeB } = releasedUnknownWithWaiting();
  assert.equal(domain.data.jobs[beforeA.id]!.code, "DOCUMENT_UNLOCK_REQUIRED");
  assert.equal(
    domain.data.jobs[beforeA.id]!.details?.["executionOutcome"],
    "not_started",
  );
  assert.equal(domain.next()?.id, beforeB.id);
  assert.equal(domain.data.jobs[original.id]!.state, "needs_reconciliation");
});

test("new blocked submission is durably refused and its retry cannot execute after the conflict disappears", () => {
  const { domain, original } = releasedUnknownWithWaiting();
  const input = {
    ...request(["param", "apply", "--doc-id", "document-A"]),
    requestId: "new-denied-request",
  };
  const result = domain.submit(input);
  const id = result["id"];
  assert.ok(typeof id === "string");
  const refused = domain.data.jobs[id]!;
  assert.equal(refused.state, "failed");
  assert.equal(refused.code, "DOCUMENT_UNLOCK_REQUIRED");
  assert.equal(refused.details?.["userScriptSubmitted"], false);
  assert.deepEqual(refused.details?.["next"], {
    tool: "fmcad_document_unlock",
    arguments: { action: "status", target: { docId: "document-A" } },
    cliArguments: [
      "queue",
      "document-unlock",
      "--action",
      "status",
      "--doc-id",
      "document-A",
    ],
  });
  domain.resolve(original.id, { state: "succeeded" });
  assert.deepEqual(domain.submit(input), result);
  assert.equal(domain.data.jobs[refused.id]!.dispatch, undefined);
});

function recoveryReadFixture() {
  const f = releasedUnknownWithWaiting();
  assert.equal(f.domain.next()?.id, f.beforeB.id);
  f.domain.finish(f.beforeB.id);
  const input: QueueRequest = {
    ...request(["param", "inspect", "--doc-id", "document-A"]),
    requestId: "new-recovery-inspection",
    payload: {
      version: 1,
      docId: "document-A",
      kind: "cad",
      operation: "param.inspect",
      data: { includeModel: true },
    },
  };
  const marker = f.domain.documentInspectionFence(
    { creationId: "document-A" },
    "current-generation",
  );
  return { ...f, input, marker };
}

test("only the server-authored full inspection can read through its own document quarantine", () => {
  const { domain, input, marker, original } = recoveryReadFixture();
  const ordinary = domain.submit({
    ...input,
    requestId: "ordinary-inspection",
    documentInspection: marker,
  });
  assert.equal(ordinary["code"], "DOCUMENT_UNLOCK_REQUIRED");
  const read = domain.submitDocumentInspection(input, marker);
  const id = read["id"];
  assert.ok(typeof id === "string");
  assert.equal(domain.next()?.id, id);
  domain.markDispatch(id);
  assert.equal(domain.data.jobs[id]!.dispatch?.rpcCount, 1);
  assert.equal(domain.data.jobs[original.id]!.state, "needs_reconciliation");
});

test("the privileged inspection marker cannot admit a mutation or filtered parameter read", () => {
  for (const payload of [
    {
      version: 1,
      kind: "cad",
      operation: "param.apply",
      docId: "document-A",
      data: { includeModel: true },
    },
    {
      version: 1,
      kind: "cad",
      operation: "param.inspect",
      docId: "document-A",
      data: { includeModel: false },
    },
    {
      kind: "cad",
      operation: "param.inspect",
      data: { includeModel: true, names: ["hidden"] },
      version: 1,
      docId: "document-A",
    },
  ]) {
    const { domain, input, marker } = recoveryReadFixture();
    assert.throws(
      () => domain.submitDocumentInspection({ ...input, payload }, marker),
      {
        code: "DOCUMENT_INSPECTION_UNPROVEN",
      },
    );
    assert.equal(domain.next(), null);
  }
});

test("a changed conflict set invalidates an inspection before the actual dispatch boundary", () => {
  const { domain, input, marker } = recoveryReadFixture();
  const read = domain.submitDocumentInspection(input, marker);
  const id = read["id"];
  assert.ok(typeof id === "string");
  assert.equal(domain.next()?.id, id);
  domain.data.quarantined!["new-blocker"] = exposure("new-blocker", {
    creationId: "document-A",
  });
  assert.throws(() => domain.markDispatch(id), {
    code: "DOCUMENT_UNLOCK_REQUIRED",
  });
  assert.equal(domain.data.jobs[id]!.dispatch, undefined);
});

test("creation-only and creation-plus-file aliases compete for one checkpoint head", () => {
  const { domain, observation, acceptance } = checkpointFixture();
  domain.recordDocumentObservation(observation);
  domain.recordDocumentObservation({
    ...observation,
    id: "observation-alias",
    requestId: "inspect-alias",
    target: { creationId: "document-A", fileId: "saved-file-A" },
  });
  domain.acceptDocumentObservation(acceptance);
  assert.throws(
    () =>
      domain.acceptDocumentObservation({
        ...acceptance,
        observationId: "observation-alias",
        requestId: "accept-alias",
      }),
    { code: "CHECKPOINT_CHANGED" },
  );
  assert.equal(Object.keys(domain.data.documentCheckpoints!.heads).length, 1);
});

test("removing the last conflict invalidates a queued inspection instead of bypassing its marker", () => {
  const { domain, input, marker, original } = recoveryReadFixture();
  const read = domain.submitDocumentInspection(input, marker);
  const id = read["id"];
  assert.ok(typeof id === "string");
  domain.resolve(original.id, { state: "succeeded" });
  assert.equal(domain.next(), null);
  assert.equal(domain.data.jobs[id]!.state, "failed");
  assert.equal(domain.data.jobs[id]!.code, "CHECKPOINT_CHANGED");
  assert.equal(domain.data.jobs[id]!.dispatch, undefined);
});

test("a new head does not leave an old inspection queued without a deadline", () => {
  const { domain, input, marker } = recoveryReadFixture();
  const read = domain.submitDocumentInspection(input, marker);
  const id = read["id"];
  assert.ok(typeof id === "string");
  const template = checkpointFixture().observation;
  const blockers = Object.values(domain.data.quarantined!).map((item) => ({
    jobId: item.jobId,
    requestId: item.requestId,
    originalHash: item.jobHash,
    catalogDigest: item.catalogDigest,
    barrierRef: item.evidenceReference,
  }));
  domain.recordDocumentObservation({ ...template, blockers });
  domain.acceptDocumentObservation({
    observationId: template.id,
    requestId: "other-accept",
    actorClientId: template.actorClientId,
    generation: template.generation,
    observedStateDigest: template.stateDigest,
  });
  assert.equal(domain.next(), null);
  assert.equal(domain.data.jobs[id]!.state, "failed");
  assert.equal(domain.data.jobs[id]!.code, "CHECKPOINT_CHANGED");
});

test("a stale inspection cannot record a system read after its final blocker disappears", () => {
  const { domain, input, marker, original } = recoveryReadFixture();
  const read = domain.submitDocumentInspection(input, marker);
  const id = read["id"];
  assert.ok(typeof id === "string");
  assert.equal(domain.next()?.id, id);
  const entry = structuredClone(
    domain.data.jobs[original.id]!.physicalDispatches![0]!,
  );
  domain.resolve(original.id, { state: "succeeded" });
  assert.throws(() => domain.recordPhysicalDispatch(id, entry), {
    code: "DOCUMENT_UNLOCK_REQUIRED",
  });
  assert.throws(() => domain.markDispatch(id), {
    code: "DOCUMENT_UNLOCK_REQUIRED",
  });
  assert.equal(domain.data.jobs[id]!.physicalDispatches, undefined);
});

test("inspection argv and payload must describe the same exact read, not a mutation or another target", () => {
  for (const argv of [
    ["param", "apply", "--doc-id", "document-A"],
    ["param", "inspect", "--doc-id", "different-document"],
  ]) {
    const { domain, input, marker } = recoveryReadFixture();
    assert.throws(
      () => domain.submitDocumentInspection({ ...input, argv }, marker),
      {
        code: "DOCUMENT_INSPECTION_UNPROVEN",
      },
    );
  }
  const { domain, input, marker } = recoveryReadFixture();
  assert.throws(
    () =>
      domain.submitDocumentInspection(
        {
          ...input,
          payload: {
            version: 1,
            kind: "cad",
            operation: "param.inspect",
            docId: "different-document",
            data: { includeModel: true },
          },
        },
        marker,
      ),
    { code: "DOCUMENT_INSPECTION_UNPROVEN" },
  );
  domain.data.quarantined!["raw"] = exposure("raw", null);
  assert.throws(
    () =>
      domain.documentInspectionFence(
        { creationId: "document-A" },
        "generation",
      ),
    {
      code: "UNKNOWN_SCOPE_UNPROVEN",
    },
  );
});

test("a backward clock cannot publish an acceptance that its own restore decoder rejects", () => {
  const { domain, observation, acceptance, setNow } = checkpointFixture();
  domain.recordDocumentObservation(observation);
  setNow(50);
  const result = domain.acceptDocumentObservation(acceptance);
  assert.equal(result.acceptedAt, observation.createdAt);
  const snapshot = structuredClone(domain.data);
  delete snapshot.quarantined;
  const restored = new QueueDomain({
    snapshot,
    now: () => 50,
    newId: () => "unused",
    hash: (value) => createHash("sha256").update(value).digest("hex"),
  });
  assert.deepEqual(restored.acceptDocumentObservation(acceptance), result);
});

test("a file-only selector must resolve its live creation identity before privileged inspection", () => {
  const { domain, input, marker } = recoveryReadFixture();
  const target = { fileId: "saved-file-A" };
  assert.throws(
    () => domain.documentInspectionFence(target, "current-generation"),
    {
      code: "DOCUMENT_TARGET_UNRESOLVED",
    },
  );
  assert.throws(
    () =>
      domain.submitDocumentInspection(
        {
          ...input,
          argv: ["param", "inspect", "--doc-file-id", target.fileId],
          payload: {
            version: 1,
            kind: "cad",
            operation: "param.inspect",
            docFileId: target.fileId,
            data: { includeModel: true },
          },
        },
        { ...marker, target },
      ),
    { code: "DOCUMENT_INSPECTION_UNPROVEN" },
  );
  const resolved = { creationId: "document-A", fileId: target.fileId };
  assert.equal(
    domain.documentInspectionFence(resolved, "current-generation")
      .priorCheckpointId,
    null,
  );
  const { observation } = checkpointFixture();
  domain.recordDocumentObservation({
    ...observation,
    target: resolved,
    blockers: Object.values(domain.data.quarantined!).map((item) => ({
      jobId: item.jobId,
      requestId: item.requestId,
      originalHash: item.jobHash,
      catalogDigest: item.catalogDigest,
      barrierRef: item.evidenceReference,
    })),
  });
  const accepted = domain.acceptDocumentObservation({
    observationId: observation.id,
    requestId: "accept-resolved-file",
    actorClientId: observation.actorClientId,
    generation: observation.generation,
    observedStateDigest: observation.stateDigest,
  });
  assert.equal(
    domain.documentInspectionFence(resolved, "current-generation")
      .priorCheckpointId,
    accepted.id,
  );
});
