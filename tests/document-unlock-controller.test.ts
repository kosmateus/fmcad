import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type * as Controller from "../src/document-unlock-controller";
import type * as Admission from "../src/document-unlock-admission";
import type * as Epoch from "../src/queue-isolated-epoch";

const root = process.cwd();
const load = createRequire(
  path.join(root, "tests/document-unlock-controller.js"),
);
const { createDocumentUnlockController } = load(
  "../src/document-unlock-controller",
) as typeof Controller;
const { createDocumentUnlockAdmission } = load(
  "../src/document-unlock-admission",
) as typeof Admission;
const { openIsolatedEpoch } = load(
  "../src/queue-isolated-epoch",
) as typeof Epoch;
const actor = { clientId: "successor", clientTokenHash: "a".repeat(64) };
const target = { docId: "creation-A" };
const inspect = { action: "inspect" as const, target, requestId: "inspect-A" };

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync("/tmp/opencode/unlock-controller-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const domain = openIsolatedEpoch(directory, { recover: false });
  const clients: Record<string, string> = {
    [actor.clientId]: actor.clientTokenHash,
  };
  let generation = "physical-generation-A";
  let probes = 0;
  let reads = 0;
  let verifications = 0;
  const observed: Admission.CurrentUnlockTarget = {
    complete: true,
    name: "Owned target",
    creationId: "creation-A",
    fileId: null,
    fingerprint: "b".repeat(64),
  };
  const admission = createDocumentUnlockAdmission(() => ({
    state: domain,
    clients,
    generation,
    scope: "ordinary",
  }));
  const ports: Controller.DocumentUnlockControllerPorts = {
    domain,
    admission,
    generation: () => generation,
    async probeIdentity() {
      probes++;
      return observed;
    },
    async inspect() {
      reads++;
      return {
        id: "observation-A",
        stateDigest: "c".repeat(64),
        createdAt: 100,
        readback: {
          reference: "jobs/read-A/readback.json",
          sha256: "d".repeat(64),
          probeRequestId: "private-probe-A",
        },
      };
    },
    verifyObservation(value, current) {
      verifications++;
      assert.equal(value.target.creationId, current.creationId);
      assert.equal(value.readback.sha256, "d".repeat(64));
    },
    verifyStoredObservation(value) {
      verifications++;
      assert.equal(value.actorClientId, actor.clientId);
      assert.equal(value.readback.sha256, "d".repeat(64));
    },
    resolution(_actor, selector, observation) {
      const accepted =
        Object.keys(domain.data.documentCheckpoints?.heads ?? {}).length > 0;
      return {
        target: { ...selector, docId: selector.docId ?? "creation-A" },
        state: accepted
          ? "checkpoint_current"
          : observation
            ? "inspection_required"
            : "clear",
        executionFence: "released",
        ...(observation
          ? {
              currentObservation: {
                observationId: observation.id,
                coverage: [
                  "document_identity",
                  "document_version",
                  "parameter_readback",
                ] as const,
              },
            }
          : {}),
      };
    },
  };
  return {
    directory,
    domain,
    clients,
    ports,
    observed,
    controller: createDocumentUnlockController(ports),
    counts: () => ({ probes, reads, verifications }),
    setGeneration(value: string) {
      generation = value;
    },
  };
}

test("metadata status does not probe CAD or create an observation", async (t) => {
  const f = fixture(t);
  const result = await f.controller.handle({ action: "status", target }, actor);
  assert.equal((result as { state: string }).state, "clear");
  assert.deepEqual(f.counts(), { probes: 0, reads: 0, verifications: 0 });
  assert.equal(f.domain.data.documentCheckpoints, undefined);
});

test("the current actor inspects, verifies its stored source and accepts without settling jobs", async (t) => {
  const f = fixture(t);
  const first = (await f.controller.handle(inspect, actor)) as {
    observation: { observationId: string };
  };
  assert.equal(first.observation.observationId, "observation-A");
  const accepted = (await f.controller.handle(
    {
      action: "accept",
      target,
      requestId: "accept-A",
      observationId: "observation-A",
    },
    actor,
  )) as { state: string };
  assert.equal(accepted.state, "checkpoint_current");
  assert.deepEqual(f.counts(), { probes: 2, reads: 1, verifications: 2 });
  assert.equal(
    Object.keys(f.domain.data.documentCheckpoints!.acceptances).length,
    1,
  );
  assert.equal(Object.keys(f.domain.data.jobs).length, 0);
});

test("a revoked actor during identity lookup cannot dispatch the full read or see private errors", async (t) => {
  const f = fixture(t);
  f.ports.probeIdentity = async () => {
    delete f.clients[actor.clientId];
    return f.observed;
  };
  const result = await f.controller.handle(inspect, actor);
  assert.equal(
    (result as { error: { code: string } }).error.code,
    "NOT_AUTHORIZED",
  );
  assert.equal(f.counts().reads, 0);
  assert.equal(f.domain.data.documentCheckpoints, undefined);
});

test("acceptance cannot inspect or disclose another actor's observation", async (t) => {
  const f = fixture(t);
  const result = await f.controller.handle(
    {
      action: "accept",
      target,
      requestId: "accept-foreign",
      observationId: "private-foreign-observation",
    },
    actor,
  );
  assert.equal(
    (result as { error: { code: string } }).error.code,
    "NOT_AUTHORIZED",
  );
  assert.equal(
    JSON.stringify(result).includes("private-foreign-observation"),
    false,
  );
  assert.equal(f.counts().probes, 0);
});

test("concurrent identical inspections share one read, while the same ID with other arguments conflicts", async (t) => {
  const f = fixture(t);
  const original = f.ports.inspect;
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.ports.inspect = async (...args) => {
    entered();
    await blocked;
    return original(...args);
  };
  const first = f.controller.handle(inspect, actor);
  await ready;
  const duplicate = f.controller.handle(inspect, actor);
  const conflict = await f.controller.handle(
    {
      ...inspect,
      target: { docId: "creation-B" },
    },
    actor,
  );
  assert.equal(
    (conflict as { error: { code: string } }).error.code,
    "REQUEST_CONFLICT",
  );
  release();
  assert.deepEqual(await first, await duplicate);
  assert.equal(f.counts().reads, 1);
  await f.controller.handle(inspect, actor);
  assert.equal(f.counts().reads, 1);
});

test("source-verifier refusal does not publish an observation or forward raw diagnostics", async (t) => {
  const f = fixture(t);
  f.ports.verifyObservation = () => {
    throw new Error("SECRET-SENTINEL raw source path");
  };
  const result = await f.controller.handle(inspect, actor);
  assert.equal(JSON.stringify(result).includes("SECRET-SENTINEL"), false);
  assert.equal(f.domain.data.documentCheckpoints, undefined);
});

test("a new generation requires a new inspection before acceptance", async (t) => {
  const f = fixture(t);
  await f.controller.handle(inspect, actor);
  f.setGeneration("physical-generation-B");
  const result = await f.controller.handle(
    {
      action: "accept",
      target,
      requestId: "accept-stale",
      observationId: "observation-A",
    },
    actor,
  );
  assert.equal(
    (result as { error: { code: string } }).error.code,
    "DOCUMENT_STATE_CHANGED",
  );
  assert.equal(
    Object.keys(f.domain.data.documentCheckpoints!.acceptances).length,
    0,
  );
});

test("pending source verification must finish before an observation is published", async (t) => {
  const f = fixture(t);
  let entered!: () => void;
  let reject!: (error: Error) => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const verification = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  f.ports.verifyObservation = () => {
    entered();
    return verification;
  };
  const running = f.controller.handle(inspect, actor);
  await ready;
  assert.equal(f.domain.data.documentCheckpoints, undefined);
  reject(
    Object.assign(new Error("private verifier refused"), {
      code: "DOCUMENT_STATE_CHANGED",
    }),
  );
  const result = await running;
  assert.equal(
    (result as { error: { code: string } }).error.code,
    "DOCUMENT_STATE_CHANGED",
  );
  assert.equal(f.domain.data.documentCheckpoints, undefined);
});

test("acceptance waits for verification and rechecks authorization after it", async (t) => {
  const f = fixture(t);
  await f.controller.handle(inspect, actor);
  let entered!: () => void;
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const verification = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.ports.verifyObservation = () => {
    entered();
    return verification;
  };
  const running = f.controller.handle(
    {
      action: "accept",
      target,
      requestId: "accept-after-await",
      observationId: "observation-A",
    },
    actor,
  );
  await ready;
  assert.equal(
    Object.keys(f.domain.data.documentCheckpoints!.acceptances).length,
    0,
  );
  delete f.clients[actor.clientId];
  finish();
  const result = await running;
  assert.equal(
    (result as { error: { code: string } }).error.code,
    "NOT_AUTHORIZED",
  );
  assert.equal(
    Object.keys(f.domain.data.documentCheckpoints!.acceptances).length,
    0,
  );
});

test("known unfenced local, control and SDK work refuses before the first identity probe", async (t) => {
  for (const field of ["blocked", "localUnknown", "controlBlocked"] as const) {
    const f = fixture(t);
    f.domain.data[field] = { id: "old-unfenced", reason: "unknown", at: 1 };
    const result = await f.controller.handle(inspect, actor);
    assert.equal(
      (result as { error: { code: string } }).error.code,
      "SDK_QUIESCENCE_UNPROVEN",
    );
    assert.equal(f.counts().probes, 0);
    assert.equal(f.counts().reads, 0);
  }
});

test("exact request intent remains bound after completion and reopening the controller and queue", async (t) => {
  const f = fixture(t);
  f.ports.probeIdentity = async () => ({ ...f.observed, fileId: "file-A" });
  await f.controller.handle(inspect, actor);
  const reopened = openIsolatedEpoch(f.directory, { recover: true });
  assert.ok(reopened.data.documentUnlockIntents);
  const controller = createDocumentUnlockController({
    ...f.ports,
    domain: reopened,
  });
  const result = await controller.handle(
    {
      ...inspect,
      target: { docId: "creation-A", docFileId: "file-A" },
    },
    actor,
  );
  assert.equal(
    (result as { error: { code: string } }).error.code,
    "REQUEST_CONFLICT",
  );
  assert.equal(f.counts().reads, 1);
});

test("global raw quarantine without runtime retirement proof refuses before identity lookup", async (t) => {
  const f = fixture(t);
  f.domain.data.quarantined = {
    old: {
      jobId: "old",
      requestId: "old-request",
      clientId: "old-actor",
      target: null,
      jobHash: "e".repeat(64),
      catalogDigest: "f".repeat(64),
      evidenceReference: "owned-fixture:released",
      evidenceDigest: "a".repeat(64),
      binding: {},
    },
  };
  const result = await f.controller.handle(inspect, actor);
  assert.equal(
    (result as { error: { code: string } }).error.code,
    "UNKNOWN_SCOPE_UNPROVEN",
  );
  assert.equal(f.counts().probes, 0);
  assert.equal(f.counts().reads, 0);
});
